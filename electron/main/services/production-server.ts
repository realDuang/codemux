import http from "http";
import fs from "fs";
import path from "path";
import { app } from "electron";
import { deviceStore } from "./device-store";
import { prodServerLog, getLogFilePath, getFileLogLevel, setFileLogLevel, loadSettings, saveSettings } from "./logger";
import { sendJson, requireAuth, isLocalRequest, getLocalIp } from "../../../shared/http-utils";
import { handleAuthRoutes, handleLogRoutes, handleSettingsRoutes } from "../../../shared/auth-route-handlers";
import { handleChannelRoutes, type ChannelManagerRoutes } from "../../../shared/channel-route-handlers";
import { WEB_PORT, WEBHOOK_PORT } from "../../../shared/ports";
import { proxyToOpenCode } from "./opencode-proxy";
import { remoteAccessManager } from "./remote-access-manager";
import { handleRemoteAccessRoutes } from "./remote-access-routes";
import { encodeStaticContent } from "../../../shared/http-compression";

// ============================================================================
// Production HTTP Server
// Serves static files and proxies API requests when running in packaged mode.
// This is required for Cloudflare Tunnel to work - it needs an HTTP server.
// ============================================================================

const CHANNEL_SERVICE_UNAVAILABLE_ERROR = "Channel service temporarily unavailable";

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
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

const WEB_ROUTES = new Set(["/", "/login", "/remote", "/settings", "/devices", "/chat"]);

function isWithinDirectory(directory: string, filePath: string): boolean {
  const relativePath = path.relative(directory, filePath);
  return relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function getStaticCacheControl(pathname: string): string {
  // Only Vite's content-hashed assets are immutable. The app entry, manifest,
  // service worker, and unversioned public files must revalidate on each visit.
  if ([".html", ".webmanifest"].includes(path.extname(pathname))) return "no-cache";
  const isHashedAsset = /^\/assets\/.+-[\w-]{8}\.[^/]+$/.test(pathname);
  const isWorkboxRuntime = /^\/workbox-[a-f0-9]{8}\.js$/.test(pathname);
  return isHashedAsset || isWorkboxRuntime ? "public, max-age=31536000, immutable" : "no-cache";
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
  private channelManager: ChannelManagerRoutes | null = null;

  /** Inject the ChannelManager so /api/channels/* routes work from web clients. */
  setChannelManager(channelManager: ChannelManagerRoutes): void {
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
    
    // Web has an independent build; Electron continues to load out/renderer.
    this.staticRoot = path.join(app.getAppPath(), "out", "web");
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

    if (await handleRemoteAccessRoutes(req, res, pathname)) return;
    if (!remoteAccessManager.isRequestAllowed(req)) {
      sendJson(res, { error: "Remote access is disabled for this entry point." }, 403);
      return;
    }

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
      if (!requireAuth(req, res, deviceStore)) return;
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

    // ========================================================================
    // Settings API Routes (auth-required)
    // ========================================================================
    if (pathname.startsWith("/api/settings/")) {
      const handled = await handleSettingsRoutes(req, res, pathname, deviceStore, {
        loadSettings,
        saveSettings,
        getRemoteAccessStatus: () => remoteAccessManager.getStatus(),
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


    if (pathname === "/api/system/is-local" && req.method === "GET") {
      sendJson(res, { isLocal: isLocalRequest(req) });
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
    // Channel API Routes (auth-required) — required for web/remote clients
    // that can't use Electron IPC.
    // ========================================================================
    if (pathname === "/api/channels" || pathname.startsWith("/api/channels/")) {
      if (!this.channelManager) {
        if (!requireAuth(req, res, deviceStore)) return;
        prodServerLog.warn("ChannelManager not configured; unable to handle channel route:", pathname);
        sendJson(
          res,
          { error: CHANNEL_SERVICE_UNAVAILABLE_ERROR },
          503,
        );
        return;
      }
      const handled = await handleChannelRoutes(
        req,
        res,
        pathname,
        deviceStore,
        this.channelManager,
      );
      if (handled) return;
      sendJson(res, { error: "Not found" }, 404);
      return;
    }

    // ========================================================================
    // Static File Serving
    // ========================================================================
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      sendJson(res, { error: "Not found" }, 404);
      return;
    }
    await this.serveStaticFile(req, res, pathname);
  }

  private async serveStaticFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string
  ): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }

    if (decodedPath.includes("\0") || decodedPath.includes("\\")) {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }

    let filePath = path.resolve(this.staticRoot, `.${decodedPath}`);
    if (!isWithinDirectory(this.staticRoot, filePath)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const acceptsHtml = req.headers.accept?.split(",").some(value => value.trim().split(";")[0] === "text/html");
    const isWebNavigation = acceptsHtml && WEB_ROUTES.has(decodedPath.replace(/\/$/, "") || "/");

    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
    } catch {
      if (isWebNavigation) {
        filePath = path.join(this.staticRoot, "index.html");
      } else {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
    }

    try {
      // Follow symlinks only after confirming their target stays in the build.
      const [realRoot, realFilePath] = await Promise.all([
        fs.promises.realpath(this.staticRoot),
        fs.promises.realpath(filePath),
      ]);
      if (!isWithinDirectory(realRoot, realFilePath)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const content = await fs.promises.readFile(realFilePath);
      const mimeType = getMimeType(filePath);
      const encoded = await encodeStaticContent(content, mimeType, req.headers["accept-encoding"]);

      if (!encoded.acceptable) {
        res.writeHead(406, { "Vary": "Accept-Encoding" });
        res.end("Not Acceptable");
        return;
      }

      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": encoded.body.length,
        ...(encoded.vary ? { "Vary": "Accept-Encoding" } : {}),
        ...(encoded.encoding ? { "Content-Encoding": encoded.encoding } : {}),
        "Cache-Control": getStaticCacheControl(`/${path.relative(this.staticRoot, filePath).split(path.sep).join("/")}`),
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : encoded.body);
    } catch (err) {
      prodServerLog.error("Failed to serve file:", filePath, err);
      res.writeHead(404);
      res.end("Not Found");
    }
  }
}

export const productionServer = new ProductionServer();
