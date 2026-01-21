import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import fs from "fs";
import path from "path";
import os from "os";
import type { IncomingMessage, ServerResponse } from "http";
import { tunnelManager } from "./scripts/tunnel-manager";
import { deviceStore, type DeviceInfo } from "./scripts/device-store";

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
        // Auth: Verify code and issue device token
        // POST /api/auth/verify
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/api/auth/verify" || req.method !== "POST") {
            next();
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
              const clientIp = getClientIp(req);

              const deviceInfo: DeviceInfo = {
                id: deviceId,
                name: device?.name || "Unknown Device",
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
