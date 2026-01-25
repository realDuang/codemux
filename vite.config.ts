import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import fs from "fs";
import path from "path";
import os from "os";
import type { IncomingMessage, ServerResponse } from "http";
import { tunnelManager } from "./scripts/tunnel-manager";
import { deviceStore, type DeviceInfo } from "./scripts/device-store";
import { worktreeService } from "./scripts/worktree-service";

// ============================================================================
// Helper Functions
// ============================================================================

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
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

function sendJson(res: ServerResponse, data: any, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

function getLocalIp(): string {
  let localIp = "localhost";
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const nets = interfaces[name];
    if (!nets) continue;
    for (const net of nets) {
      if (net.family === "IPv4" && !net.internal) {
        localIp = net.address;
        break;
      }
    }
    if (localIp !== "localhost") break;
  }
  return localIp;
}

function isLocalhost(ip: string): boolean {
  // Normalize IPv6-mapped IPv4 addresses (e.g., ::ffff:127.0.0.1 -> 127.0.0.1)
  const normalizedIp = ip.replace(/^::ffff:/, "");
  return (
    normalizedIp === "127.0.0.1" ||
    normalizedIp === "::1" ||
    normalizedIp === "localhost"
  );
}

// ============================================================================
// Vite Config
// ============================================================================

export default defineConfig({
  plugins: [
    solid(),
    {
      name: "custom-api-middleware",
      configureServer(server) {
        // ====================================================================
        // Auth: Verify code and issue device token (LOCALHOST ONLY)
        // POST /api/auth/verify
        // Remote users must use /api/auth/request-access + approval flow
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/api/auth/verify" || req.method !== "POST") {
            next();
            return;
          }

          const clientIp = getClientIp(req);
          if (!isLocalhost(clientIp)) {
            sendJson(res, { error: "Use request-access endpoint for remote devices" }, 403);
            return;
          }

          try {
            const { code, device } = await parseBody(req);
            const authCodePath = path.join(process.cwd(), ".auth-code");

            if (!fs.existsSync(authCodePath)) {
              sendJson(res, { error: "Auth code not found" }, 500);
              return;
            }

            const validCode = fs.readFileSync(authCodePath, "utf-8").trim();

            if (code === validCode) {
              // Create new device
              const deviceId = deviceStore.generateDeviceId();
              const token = deviceStore.generateToken(deviceId);

              const deviceInfo: DeviceInfo = {
                id: deviceId,
                name: device?.name || "Unknown Device",
                platform: device?.platform || "Unknown",
                browser: device?.browser || "Unknown",
                createdAt: Date.now(),
                lastSeenAt: Date.now(),
                ip: clientIp,
                isHost: true,
              };

              deviceStore.addDevice(deviceInfo);

              sendJson(res, {
                success: true,
                token,
                deviceId,
                device: deviceInfo,
              });
            } else {
              sendJson(res, { error: "Invalid code" }, 401);
            }
          } catch (err) {
            sendJson(res, { error: "Bad request" }, 400);
          }
        });

        // ====================================================================
        // Auth: Validate device token
        // GET /api/auth/validate
        // ====================================================================
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/api/auth/validate" || req.method !== "GET") {
            next();
            return;
          }

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

          // Update last seen
          const clientIp = getClientIp(req);
          deviceStore.updateLastSeen(result.deviceId, clientIp);

          const device = deviceStore.getDevice(result.deviceId);
          sendJson(res, { valid: true, deviceId: result.deviceId, device });
        });

        // ====================================================================
        // Auth: Logout current device
        // POST /api/auth/logout
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/api/auth/logout" || req.method !== "POST") {
            next();
            return;
          }

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

          deviceStore.revokeToken(token);
          deviceStore.removeDevice(result.deviceId);
          sendJson(res, { success: true });
        });

        // ====================================================================
        // Auth: Get access code (for display in RemoteAccess page)
        // GET /api/auth/code
        // ====================================================================
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/api/auth/code" || req.method !== "GET") {
            next();
            return;
          }

          // This endpoint requires authentication
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
            const authCodePath = path.join(process.cwd(), ".auth-code");
            if (fs.existsSync(authCodePath)) {
              const code = fs.readFileSync(authCodePath, "utf-8").trim();
              sendJson(res, { code });
            } else {
              sendJson(res, { error: "Code not found" }, 404);
            }
          } catch {
            sendJson(res, { error: "Server error" }, 500);
          }
        });

        // ====================================================================
        // Auth: Local auto-authentication (localhost only)
        // POST /api/auth/local-auth
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/api/auth/local-auth" || req.method !== "POST") {
            next();
            return;
          }

          const clientIp = getClientIp(req);
          if (!isLocalhost(clientIp)) {
            sendJson(res, { error: "Local access only" }, 403);
            return;
          }

          try {
            const { device } = await parseBody(req);

            // Create local device with special naming
            const deviceId = deviceStore.generateDeviceId();
            const token = deviceStore.generateToken(deviceId);

            const deviceInfo: DeviceInfo = {
              id: deviceId,
              name: device?.name || "Local Machine",
              platform: device?.platform || "Unknown",
              browser: device?.browser || "Unknown",
              createdAt: Date.now(),
              lastSeenAt: Date.now(),
              ip: clientIp,
            };

            deviceStore.addDevice(deviceInfo);

            sendJson(res, {
              success: true,
              token,
              deviceId,
              device: deviceInfo,
            });
          } catch (err) {
            sendJson(res, { error: "Bad request" }, 400);
          }
        });

        // ====================================================================
        // Auth: Request access (remote device submits approval request)
        // POST /api/auth/request-access
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/api/auth/request-access" || req.method !== "POST") {
            next();
            return;
          }

          try {
            const { code, device } = await parseBody(req);
            const authCodePath = path.join(process.cwd(), ".auth-code");

            if (!fs.existsSync(authCodePath)) {
              sendJson(res, { success: false, error: "Auth code not found" }, 500);
              return;
            }

            const validCode = fs.readFileSync(authCodePath, "utf-8").trim();

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

            sendJson(res, {
              success: true,
              requestId: pendingRequest.id,
            });
          } catch (err) {
            sendJson(res, { success: false, error: "Bad request" }, 400);
          }
        });

        // ====================================================================
        // Auth: Check access request status (remote device polls)
        // GET /api/auth/check-status?requestId=xxx
        // ====================================================================
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url || "", `http://${req.headers.host}`);
          if (url.pathname !== "/api/auth/check-status" || req.method !== "GET") {
            next();
            return;
          }

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
        });

        // ====================================================================
        // Admin: Get pending access requests (host only)
        // GET /api/admin/pending-requests
        // ====================================================================
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/api/admin/pending-requests" || req.method !== "GET") {
            next();
            return;
          }

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

          const clientIp = getClientIp(req);
          if (!isLocalhost(clientIp)) {
            sendJson(res, { error: "Host access only" }, 403);
            return;
          }

          const requests = deviceStore.listPendingRequests();
          sendJson(res, { requests });
        });

        // ====================================================================
        // Admin: Approve access request (host only)
        // POST /api/admin/approve
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/api/admin/approve" || req.method !== "POST") {
            next();
            return;
          }

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

          const clientIp = getClientIp(req);
          if (!isLocalhost(clientIp)) {
            sendJson(res, { error: "Host access only" }, 403);
            return;
          }

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
          } catch (err) {
            sendJson(res, { error: "Bad request" }, 400);
          }
        });

        // ====================================================================
        // Admin: Deny access request (host only)
        // POST /api/admin/deny
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/api/admin/deny" || req.method !== "POST") {
            next();
            return;
          }

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

          const clientIp = getClientIp(req);
          if (!isLocalhost(clientIp)) {
            sendJson(res, { error: "Host access only" }, 403);
            return;
          }

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
          } catch (err) {
            sendJson(res, { error: "Bad request" }, 400);
          }
        });

        // ====================================================================
        // Devices: List all authorized devices
        // GET /api/devices
        // ====================================================================
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/api/devices" || req.method !== "GET") {
            next();
            return;
          }

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
        });

        // ====================================================================
        // Devices: Revoke a device
        // DELETE /api/devices/:id
        // ====================================================================
        server.middlewares.use((req, res, next) => {
          const match = req.url?.match(/^\/api\/devices\/([a-f0-9]+)$/);
          if (!match || req.method !== "DELETE") {
            next();
            return;
          }

          const targetDeviceId = match[1];
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

          // Prevent revoking current device from this endpoint
          if (targetDeviceId === result.deviceId) {
            sendJson(res, { error: "Cannot revoke current device. Use logout instead." }, 400);
            return;
          }

          const success = deviceStore.revokeDevice(targetDeviceId);
          if (success) {
            sendJson(res, { success: true });
          } else {
            sendJson(res, { error: "Device not found" }, 404);
          }
        });

        // ====================================================================
        // Devices: Rename a device
        // PUT /api/devices/:id/rename
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          const match = req.url?.match(/^\/api\/devices\/([a-f0-9]+)\/rename$/);
          if (!match || req.method !== "PUT") {
            next();
            return;
          }

          const targetDeviceId = match[1];
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
        });

        // ====================================================================
        // Devices: Revoke all other devices
        // POST /api/devices/revoke-others
        // ====================================================================
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/api/devices/revoke-others" || req.method !== "POST") {
            next();
            return;
          }

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
        });

        // ====================================================================
        // System: Get system info
        // GET /api/system/info
        // ====================================================================
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/api/system/info" || req.method !== "GET") {
            next();
            return;
          }

          sendJson(res, {
            localIp: getLocalIp(),
            port: 5174,
          });
        });

        // ====================================================================
        // System: Check if request is from localhost
        // GET /api/system/is-local
        // ====================================================================
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/api/system/is-local" || req.method !== "GET") {
            next();
            return;
          }

          const clientIp = getClientIp(req);
          const isLocal = isLocalhost(clientIp);
          sendJson(res, { isLocal });
        });

        // ====================================================================
        // Tunnel Management APIs
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/api/tunnel")) {
            next();
            return;
          }

          try {
            if (req.url === "/api/tunnel/start" && req.method === "POST") {
              const info = await tunnelManager.start(5174);
              sendJson(res, info);
              return;
            }

            if (req.url === "/api/tunnel/stop" && req.method === "POST") {
              await tunnelManager.stop();
              sendJson(res, { success: true });
              return;
            }

            if (req.url === "/api/tunnel/status" && req.method === "GET") {
              const info = tunnelManager.getInfo();
              sendJson(res, info);
              return;
            }

            sendJson(res, { error: "Not found" }, 404);
          } catch (error: any) {
            console.error("[API Error]", error);
            sendJson(res, { error: error.message }, 500);
          }
        });

        // ====================================================================
        // Worktree Management APIs
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/api/worktree")) {
            next();
            return;
          }

          const token = extractBearerToken(req);
          if (!token) {
            sendJson(res, { error: "Unauthorized" }, 401);
            return;
          }

          const authResult = deviceStore.verifyToken(token);
          if (!authResult.valid) {
            sendJson(res, { error: "Invalid token" }, 401);
            return;
          }

          try {
            if (req.url === "/api/worktree/create" && req.method === "POST") {
              const { projectPath, branchName, sessionId } = await parseBody(req);
              if (!projectPath || !branchName || !sessionId) {
                sendJson(res, { error: "projectPath, branchName, and sessionId are required" }, 400);
                return;
              }
              const info = await worktreeService.create({ projectPath, branchName, sessionId });
              sendJson(res, info);
              return;
            }

            if (req.url === "/api/worktree/merge" && req.method === "POST") {
              const { worktreePath, projectPath, squash, commitMessage } = await parseBody(req);
              if (!worktreePath || !projectPath) {
                sendJson(res, { error: "worktreePath and projectPath are required" }, 400);
                return;
              }
              const result = await worktreeService.merge({ worktreePath, projectPath, squash, commitMessage });
              sendJson(res, result);
              return;
            }

            if (req.url === "/api/worktree/push" && req.method === "POST") {
              const { worktreePath, newBranchName } = await parseBody(req);
              if (!worktreePath) {
                sendJson(res, { error: "worktreePath is required" }, 400);
                return;
              }
              const result = await worktreeService.push({ worktreePath, newBranchName });
              sendJson(res, result);
              return;
            }

            if (req.url === "/api/worktree/abandon" && req.method === "POST") {
              const { worktreePath, projectPath } = await parseBody(req);
              if (!worktreePath || !projectPath) {
                sendJson(res, { error: "worktreePath and projectPath are required" }, 400);
                return;
              }
              const result = await worktreeService.abandon(worktreePath, projectPath);
              sendJson(res, result);
              return;
            }

            if (req.url === "/api/worktree/list" && req.method === "POST") {
              const { projectPath } = await parseBody(req);
              if (!projectPath) {
                sendJson(res, { error: "projectPath is required" }, 400);
                return;
              }
              const list = await worktreeService.list(projectPath);
              sendJson(res, { worktrees: list });
              return;
            }

            if (req.url === "/api/worktree/info" && req.method === "POST") {
              const { worktreePath } = await parseBody(req);
              if (!worktreePath) {
                sendJson(res, { error: "worktreePath is required" }, 400);
                return;
              }
              const info = await worktreeService.getInfo(worktreePath);
              sendJson(res, info || { error: "Worktree not found" });
              return;
            }

            if (req.url === "/api/worktree/cleanup" && req.method === "POST") {
              const { projectPath } = await parseBody(req);
              if (!projectPath) {
                sendJson(res, { error: "projectPath is required" }, 400);
                return;
              }
              const result = await worktreeService.cleanup(projectPath);
              sendJson(res, result);
              return;
            }

            sendJson(res, { error: "Not found" }, 404);
          } catch (error: any) {
            console.error("[Worktree API Error]", error);
            sendJson(res, { error: error.message }, 500);
          }
        });
      },
    },
  ],
  server: {
    port: 5174,
    host: true,
    allowedHosts: [
      "localhost",
      ".trycloudflare.com",
    ],
    proxy: {
      "/opencode-api": {
        target: "http://localhost:4096",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/opencode-api/, ""),
      },
      "/opencode-api/global/event": {
        target: "http://localhost:4096",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/opencode-api/, ""),
        timeout: 0,
      },
    },
  },
});
