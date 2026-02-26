import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { app } from "electron";
import { deviceStore } from "./device-store";
import { prodServerLog } from "./logger";

// ============================================================================
// Production HTTP Server
// Serves static files and proxies API requests when running in packaged mode.
// This is required for Cloudflare Tunnel to work - it needs an HTTP server.
// ============================================================================

const DEFAULT_PORT = 5173;
const OPENCODE_PORT = 4096;

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

function sendJson(res: http.ServerResponse, data: any, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-opencode-directory",
  });
  res.end(JSON.stringify(data));
}

function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function extractBearerToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
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
 * Parse JSON body from request
 */
function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    const MAX_SIZE = 1024 * 1024; // 1MB
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

class ProductionServer {
  private server: http.Server | null = null;
  private port: number = DEFAULT_PORT;
  private staticRoot: string = "";

  getPort(): number {
    return this.port;
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  getServer(): http.Server | null {
    return this.server;
  }

  async start(port: number = DEFAULT_PORT): Promise<number> {
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
    // Auth API Routes
    // ========================================================================
    if (pathname.startsWith("/api/auth/") || pathname.startsWith("/api/admin/") || pathname.startsWith("/api/devices")) {
      await this.handleAuthApi(req, res, pathname, url);
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
      const clientIp = getClientIp(req);
      const normalizedIp = clientIp.replace(/^::ffff:/, "");
      const isLocal = normalizedIp === "127.0.0.1" || normalizedIp === "::1" || normalizedIp === "localhost";
      sendJson(res, { isLocal });
      return;
    }

    // ========================================================================
    // Tunnel API Routes (handled via IPC in Electron, but provide HTTP fallback)
    // ========================================================================
    if (pathname.startsWith("/api/tunnel")) {
      // Tunnel APIs are primarily handled via IPC
      // This is a fallback for any HTTP-based access
      sendJson(res, { error: "Tunnel APIs should be accessed via Electron IPC" }, 400);
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

  private async handleAuthApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    url: URL
  ): Promise<void> {
    // ========================================================================
    // GET /api/auth/code - Get access code
    // ========================================================================
    if (pathname === "/api/auth/code" && req.method === "GET") {
      const code = deviceStore.getAccessCode();
      sendJson(res, { code });
      return;
    }

    // ========================================================================
    // GET /api/auth/validate - Validate token
    // ========================================================================
    if (pathname === "/api/auth/validate" && req.method === "GET") {
      const token = extractBearerToken(req);
      if (!token) {
        sendJson(res, { error: "No token provided" }, 401);
        return;
      }

      const result = deviceStore.verifyToken(token);
      if (!result.valid || !result.deviceId) {
        sendJson(res, { error: "Invalid or expired token" }, 401);
        return;
      }

      const device = deviceStore.getDevice(result.deviceId);
      sendJson(res, { valid: true, deviceId: result.deviceId, device });
      return;
    }

    // ========================================================================
    // POST /api/auth/request-access - Request access
    // ========================================================================
    if (pathname === "/api/auth/request-access" && req.method === "POST") {
      try {
        const { code, device } = await parseBody(req);
        const validCode = deviceStore.getAccessCode();
        
        if (code !== validCode) {
          sendJson(res, { success: false, error: "Invalid code" }, 401);
          return;
        }

        const clientIp = getClientIp(req);
        const pendingRequest = deviceStore.createPendingRequest(
          {
            name: device?.name || "Unknown Device",
            platform: device?.platform || "Unknown",
            browser: device?.browser || "Unknown",
          },
          clientIp
        );

        sendJson(res, { success: true, requestId: pendingRequest.id });
      } catch {
        sendJson(res, { success: false, error: "Bad request" }, 400);
      }
      return;
    }

    // ========================================================================
    // GET /api/auth/check-status - Check access status
    // ========================================================================
    if (pathname === "/api/auth/check-status" && req.method === "GET") {
      const requestId = url.searchParams.get("requestId");
      if (!requestId) {
        sendJson(res, { status: "not_found" });
        return;
      }

      const request = deviceStore.getPendingRequest(requestId);
      if (!request) {
        sendJson(res, { status: "not_found" });
        return;
      }

      if (request.status === "approved") {
        sendJson(res, {
          status: "approved",
          token: request.token,
          deviceId: request.deviceId,
        });
      } else {
        sendJson(res, { status: request.status });
      }
      return;
    }

    // ========================================================================
    // POST /api/auth/logout - Logout
    // ========================================================================
    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const token = extractBearerToken(req);
      if (!token) {
        sendJson(res, { error: "No token provided" }, 401);
        return;
      }

      const result = deviceStore.verifyToken(token);
      if (!result.valid || !result.deviceId) {
        sendJson(res, { error: "Invalid token" }, 401);
        return;
      }

      deviceStore.removeDevice(result.deviceId);
      sendJson(res, { success: true });
      return;
    }

    // ========================================================================
    // GET /api/admin/pending-requests - Get pending requests
    // ========================================================================
    if (pathname === "/api/admin/pending-requests" && req.method === "GET") {
      const requests = deviceStore.listPendingRequests();
      sendJson(res, { requests });
      return;
    }

    // ========================================================================
    // POST /api/admin/approve - Approve request
    // ========================================================================
    if (pathname === "/api/admin/approve" && req.method === "POST") {
      try {
        const { requestId } = await parseBody(req);
        if (!requestId) {
          sendJson(res, { error: "requestId is required" }, 400);
          return;
        }

        const approved = deviceStore.approveRequest(requestId);
        if (approved) {
          sendJson(res, { success: true, device: deviceStore.getDevice(approved.deviceId!) });
        } else {
          sendJson(res, { error: "Request not found or already processed" }, 404);
        }
      } catch {
        sendJson(res, { error: "Bad request" }, 400);
      }
      return;
    }

    // ========================================================================
    // POST /api/admin/deny - Deny request
    // ========================================================================
    if (pathname === "/api/admin/deny" && req.method === "POST") {
      try {
        const { requestId } = await parseBody(req);
        if (!requestId) {
          sendJson(res, { error: "requestId is required" }, 400);
          return;
        }

        const denied = deviceStore.denyRequest(requestId);
        if (denied) {
          sendJson(res, { success: true });
        } else {
          sendJson(res, { error: "Request not found or already processed" }, 404);
        }
      } catch {
        sendJson(res, { error: "Bad request" }, 400);
      }
      return;
    }

    // ========================================================================
    // GET /api/devices - List devices
    // ========================================================================
    if (pathname === "/api/devices" && req.method === "GET") {
      const token = extractBearerToken(req);
      if (!token) {
        sendJson(res, { error: "Unauthorized" }, 401);
        return;
      }

      const result = deviceStore.verifyToken(token);
      if (!result.valid || !result.deviceId) {
        sendJson(res, { error: "Invalid token" }, 401);
        return;
      }

      const devices = deviceStore.listDevices();
      sendJson(res, { devices, currentDeviceId: result.deviceId });
      return;
    }

    // ========================================================================
    // DELETE /api/devices/:id - Revoke device
    // ========================================================================
    const revokeMatch = pathname.match(/^\/api\/devices\/([a-f0-9]+)$/);
    if (revokeMatch && req.method === "DELETE") {
      const targetDeviceId = revokeMatch[1];
      const token = extractBearerToken(req);
      if (!token) {
        sendJson(res, { error: "Unauthorized" }, 401);
        return;
      }

      const result = deviceStore.verifyToken(token);
      if (!result.valid || !result.deviceId) {
        sendJson(res, { error: "Invalid token" }, 401);
        return;
      }

      if (targetDeviceId === result.deviceId) {
        sendJson(res, { error: "Cannot revoke current device. Use logout instead." }, 400);
        return;
      }

      const success = deviceStore.removeDevice(targetDeviceId);
      if (success) {
        sendJson(res, { success: true });
      } else {
        sendJson(res, { error: "Device not found" }, 404);
      }
      return;
    }

    // ========================================================================
    // PUT /api/devices/:id/rename - Rename device
    // ========================================================================
    const renameMatch = pathname.match(/^\/api\/devices\/([a-f0-9]+)\/rename$/);
    if (renameMatch && req.method === "PUT") {
      const targetDeviceId = renameMatch[1];
      const token = extractBearerToken(req);
      if (!token) {
        sendJson(res, { error: "Unauthorized" }, 401);
        return;
      }

      const result = deviceStore.verifyToken(token);
      if (!result.valid) {
        sendJson(res, { error: "Invalid token" }, 401);
        return;
      }

      try {
        const { name } = await parseBody(req);
        if (!name || typeof name !== "string" || name.trim().length === 0) {
          sendJson(res, { error: "Name is required" }, 400);
          return;
        }

        const device = deviceStore.getDevice(targetDeviceId);
        if (!device) {
          sendJson(res, { error: "Device not found" }, 404);
          return;
        }

        deviceStore.updateDevice(targetDeviceId, { name: name.trim() });
        sendJson(res, { success: true, device: deviceStore.getDevice(targetDeviceId) });
      } catch {
        sendJson(res, { error: "Bad request" }, 400);
      }
      return;
    }

    // ========================================================================
    // POST /api/devices/revoke-others - Revoke all other devices
    // ========================================================================
    if (pathname === "/api/devices/revoke-others" && req.method === "POST") {
      const token = extractBearerToken(req);
      if (!token) {
        sendJson(res, { error: "Unauthorized" }, 401);
        return;
      }

      const result = deviceStore.verifyToken(token);
      if (!result.valid || !result.deviceId) {
        sendJson(res, { error: "Invalid token" }, 401);
        return;
      }

      const count = deviceStore.revokeAllExcept(result.deviceId);
      sendJson(res, { success: true, revokedCount: count });
      return;
    }

    // Not found
    sendJson(res, { error: "Not found" }, 404);
  }
}

export const productionServer = new ProductionServer();

// --- LAN IP helpers ---

const virtualInterfacePatterns = [
  /^docker/i, /^br-/i, /^veth/i, /^vEthernet/i,
  /^vmnet/i, /^VMware/i, /^VirtualBox/i, /^vboxnet/i,
  /^Hyper-V/i, /^Default Switch/i, /^WSL/i,
  /^tun/i, /^tap/i, /^singbox/i, /^sing-box/i, /^clash/i, /^utun/i,
  /^tailscale/i, /^ZeroTier/i, /^zt/i,
  /^wg/i, /^wireguard/i, /^ham/i, /^Hamachi/i, /^npcap/i, /^lo/i,
];

function getLocalIp(osModule: typeof import("os")): string {
  const interfaces = osModule.networkInterfaces();
  let fallback: string | null = null;

  for (const name of Object.keys(interfaces)) {
    const nets = interfaces[name];
    if (!nets) continue;
    const virtual = virtualInterfacePatterns.some((p) => p.test(name));
    for (const net of nets) {
      if (net.internal || net.family !== "IPv4") continue;
      if (!virtual) return net.address;
      if (!fallback) fallback = net.address;
    }
  }
  return fallback ?? "localhost";
}
