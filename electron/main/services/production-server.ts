import http from "http";
import fs from "fs";
import path from "path";
import { app } from "electron";
import { deviceStore } from "./device-store";
import { prodServerLog, getLogFilePath, getFileLogLevel, setFileLogLevel, loadSettings, saveSettings } from "./logger";
import { sendJson, getClientIp, isLocalhost, getLocalIp } from "../../../shared/http-utils";
import { handleAuthRoutes, handleLogRoutes, handleSettingsRoutes } from "../../../shared/auth-route-handlers";
import { handleChannelRoutes } from "../../../shared/channel-route-handlers";
import { WEB_PORT, OPENCODE_PORT, WEBHOOK_PORT } from "../../../shared/ports";

// ============================================================================
// Production HTTP Server
// Serves static files and proxies API requests when running in packaged mode.
// This is required for Cloudflare Tunnel to work - it needs an HTTP server.
// ============================================================================

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * Proxy a request to OpenCode server
 */
function proxyToOpenCode(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetPath: string
): void {
  let body: Buffer[] = [];
  
  req.on("data", (chunk) => body.push(chunk));
  req.on("end", () => {
    const bodyBuffer = Buffer.concat(body);
    
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: OPENCODE_PORT,
      path: targetPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${OPENCODE_PORT}`,
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      // Copy status and headers
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      prodServerLog.error("Proxy to OpenCode failed:", err.message);
      sendJson(res, { error: "OpenCode service unavailable", details: err.message }, 503);
    });

    if (bodyBuffer.length > 0) {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();
  });

  req.on("error", (err) => {
    prodServerLog.error("Request error:", err);
    sendJson(res, { error: "Request failed" }, 500);
  });
}

/**
 * Proxy a request to the shared WebhookServer (for channel webhooks)
 */
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024; // 1 MB

function proxyToWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetPath: string
): void {
  let body: Buffer[] = [];
  let totalLength = 0;

  req.on("data", (chunk: Buffer) => {
    totalLength += chunk.length;
    if (totalLength > MAX_WEBHOOK_BODY_BYTES) {
      req.destroy();
      sendJson(res, { error: "Payload too large" }, 413);
      return;
    }
    body.push(chunk);
  });
  req.on("end", () => {
    if (totalLength > MAX_WEBHOOK_BODY_BYTES) return;
    const bodyBuffer = Buffer.concat(body);

    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: WEBHOOK_PORT,
      path: targetPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${WEBHOOK_PORT}`,
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      prodServerLog.error("Proxy to webhook failed:", err.message);
      sendJson(res, { error: "Webhook service unavailable", details: err.message }, 503);
    });

    if (bodyBuffer.length > 0) {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();
  });

  req.on("error", (err) => {
    prodServerLog.error("Request error:", err);
    sendJson(res, { error: "Request failed" }, 500);
  });
}

class ProductionServer {
  private server: http.Server | null = null;
  private port: number = WEB_PORT;
  private staticRoot: string = "";
  private channelManager: Parameters<typeof handleChannelRoutes>[4] | null = null;

  setChannelManager(channelManager: Parameters<typeof handleChannelRoutes>[4]): void {
    this.channelManager = channelManager;
  }

  getPort(): number {
    return this.port;
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  getServer(): http.Server | null {
    return this.server;
  }

  async start(port: number = WEB_PORT): Promise<number> {
    if (this.server) {
      return this.port;
    }

    this.port = port;
    
    // Static files are in out/renderer relative to app path
    this.staticRoot = path.join(app.getAppPath(), "out", "renderer");
    prodServerLog.info("Static root:", this.staticRoot);

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          prodServerLog.error("Request handler error:", err);
          sendJson(res, { error: "Internal server error" }, 500);
        });
      });

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          prodServerLog.info(`Port ${this.port} in use, trying ${this.port + 1}`);
          this.port++;
          this.server?.listen(this.port, "0.0.0.0");
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, "0.0.0.0", () => {
        prodServerLog.info(`Started on http://0.0.0.0:${this.port}`);
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server?.close(() => {
          this.server = null;
          resolve();
        });
      });
    }
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(req.url || "/", `http://localhost:${this.port}`);
    const pathname = url.pathname;

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-opencode-directory",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    // ========================================================================
    // API Routes: Proxy /opencode-api/* to OpenCode server
    // ========================================================================
    if (pathname.startsWith("/opencode-api")) {
      const targetPath = pathname.replace(/^\/opencode-api/, "") + url.search;
      proxyToOpenCode(req, res, targetPath || "/");
      return;
    }

    // ========================================================================
    // Auth + Device + Admin API Routes (shared handler)
    // ========================================================================
    if (pathname.startsWith("/api/auth/") || pathname.startsWith("/api/admin/") || pathname.startsWith("/api/devices")) {
      const handled = await handleAuthRoutes(req, res, pathname, url, deviceStore, {
        defaultDeviceName: "Local Machine",
        defaultPlatform: process.platform,
        defaultBrowser: "Browser",
        includeDeviceInResponse: true,
      });
      if (handled) return;
      // Fall through to 404 if no auth route matched
      sendJson(res, { error: "Not found" }, 404);
      return;
    }

    if (pathname === "/api/channels" || pathname.startsWith("/api/channels/")) {
      if (!this.channelManager) {
        sendJson(res, { error: "Channel manager unavailable" }, 503);
        return;
      }
      const handled = await handleChannelRoutes(req, res, pathname, deviceStore, this.channelManager);
      if (handled) return;
      sendJson(res, { error: "Not found" }, 404);
      return;
    }

    if (pathname === "/api/settings/default-engine") {
      const handled = await handleSettingsRoutes(req, res, pathname, deviceStore, {
        getDefaultEngine: () => getDefaultEngineFromSettings(),
        saveDefaultEngine: (defaultEngine) => saveSettings({ defaultEngine }),
      });
      if (handled) return;
      sendJson(res, { error: "Not found" }, 404);
      return;
    }

    // ========================================================================
    // Settings API Routes (auth-required)
    // ========================================================================
    if (pathname.startsWith("/api/settings/")) {
      const handled = await handleSettingsRoutes(req, res, pathname, deviceStore, {
        loadSettings,
        saveSettings,
      });
      if (handled) return;
      sendJson(res, { error: "Not found" }, 404);
      return;
    }

    // ========================================================================
    // System API Routes
    // ========================================================================
    if (pathname === "/api/system/info" && req.method === "GET") {
      const os = await import("os");
      const localIp = getLocalIp(os);
      sendJson(res, { localIp, port: this.port });
      return;
    }

    if (pathname === "/api/system/capabilities" && req.method === "GET") {
      const serverMode = process.env.CODEMUX_SERVER_MODE === "1";
      const clientIp = getClientIp(req);
      const isLocal = isLocalhost(clientIp);
      sendJson(res, {
        serverMode,
        canAddProject: serverMode || isLocal,
      });
      return;
    }

    if (pathname === "/api/system/is-local" && req.method === "GET") {
      const clientIp = getClientIp(req);
      sendJson(res, { isLocal: isLocalhost(clientIp) });
      return;
    }

    // Log API routes (localhost only, shared handler)
    const logHandled = await handleLogRoutes(req, res, pathname, {
      getLogFilePath,
      getFileLogLevel,
      setFileLogLevel,
    });
    if (logHandled) return;

    // ========================================================================
    // Tunnel API Routes (handled via IPC in Electron, but provide HTTP fallback)
    // ========================================================================
    if (pathname.startsWith("/api/tunnel")) {
      sendJson(res, { error: "Tunnel APIs should be accessed via Electron IPC" }, 400);
      return;
    }

    // ========================================================================
    // Webhook Routes: Proxy /api/messages and /webhook/* to WebhookServer
    // ========================================================================
    if (pathname === "/api/messages" || pathname.startsWith("/webhook/")) {
      proxyToWebhook(req, res, pathname + url.search);
      return;
    }

    // ========================================================================
    // Static File Serving
    // ========================================================================
    await this.serveStaticFile(req, res, pathname);
  }

  private async serveStaticFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string
  ): Promise<void> {
    // Normalize path and prevent directory traversal
    let filePath = path.join(this.staticRoot, pathname);
    
    // Security: ensure we're still within static root
    if (!filePath.startsWith(this.staticRoot)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      const stat = await fs.promises.stat(filePath);
      
      if (stat.isDirectory()) {
        // Try index.html for directories
        filePath = path.join(filePath, "index.html");
      }
    } catch {
      // File not found - serve index.html for SPA routing
      filePath = path.join(this.staticRoot, "index.html");
    }

    try {
      const content = await fs.promises.readFile(filePath);
      const mimeType = getMimeType(filePath);
      
      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": content.length,
        "Cache-Control": filePath.endsWith(".html") ? "no-cache" : "public, max-age=31536000",
      });
      res.end(content);
    } catch (err) {
      prodServerLog.error("Failed to serve file:", filePath, err);
      res.writeHead(404);
      res.end("Not Found");
    }
  }
}

export const productionServer = new ProductionServer();
