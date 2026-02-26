import http from "http";
import { deviceStore } from "./device-store";
import { authLog } from "./logger";

// ============================================================================
// Internal Auth API Server
// This server handles all device/auth related API requests.
// In development, Vite proxies requests here. In production, Electron handles
// everything via IPC, so this server is only used in development.
// ============================================================================

const AUTH_API_PORT = 4097; // Internal port, not exposed externally
const MAX_BODY_SIZE = 1024 * 1024; // 1MB limit to prevent memory exhaustion

interface RequestBody {
  [key: string]: any;
}

function parseBody(req: http.IncomingMessage): Promise<RequestBody> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
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

function sendJson(res: http.ServerResponse, data: any, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(data));
}

function extractBearerToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

class AuthApiServer {
  private server: http.Server | null = null;

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        // Handle CORS preflight
        if (req.method === "OPTIONS") {
          sendJson(res, {});
          return;
        }

        const url = new URL(req.url || "", `http://localhost:${AUTH_API_PORT}`);
        const pathname = url.pathname;

        try {
          await this.handleRequest(req, res, pathname, url);
        } catch (err) {
          authLog.error("Error:", err);
          sendJson(res, { error: "Internal server error" }, 500);
        }
      });

      this.server.listen(AUTH_API_PORT, "127.0.0.1", () => {
        resolve();
      });

      this.server.on("error", (err) => {
        authLog.error("Server error:", err);
        reject(err);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  getPort(): number {
    return AUTH_API_PORT;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    url: URL
  ) {
    // ========================================================================
    // Token Validation
    // GET /api/auth/validate
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
    // Request Access (create pending request)
    // POST /api/auth/request-access
    // ========================================================================
    if (pathname === "/api/auth/request-access" && req.method === "POST") {
      try {
        const { code, device } = await parseBody(req);

        // Verify access code
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
    // Check Access Status (poll for approval)
    // GET /api/auth/check-status?requestId=xxx
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
    // Logout
    // POST /api/auth/logout
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
    // Get Pending Requests (for approval UI)
    // GET /api/admin/pending-requests
    // ========================================================================
    if (pathname === "/api/admin/pending-requests" && req.method === "GET") {
      const requests = deviceStore.listPendingRequests();
      sendJson(res, { requests });
      return;
    }

    // ========================================================================
    // Approve Request
    // POST /api/admin/approve
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
    // Deny Request
    // POST /api/admin/deny
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
    // List Devices
    // GET /api/devices
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
    // Revoke Device
    // DELETE /api/devices/:id
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
    // Rename Device
    // PUT /api/devices/:id/rename
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
    // Revoke All Other Devices
    // POST /api/devices/revoke-others
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

    // ========================================================================
    // Get Access Code
    // GET /api/auth/code
    // ========================================================================
    if (pathname === "/api/auth/code" && req.method === "GET") {
      const code = deviceStore.getAccessCode();
      sendJson(res, { code });
      return;
    }

    // Not found
    sendJson(res, { error: "Not found" }, 404);
  }
}

export const authApiServer = new AuthApiServer();
