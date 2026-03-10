import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";
import os from "os";
import type { IncomingMessage } from "http";
import { tunnelManager } from "./scripts/tunnel-manager";
import { deviceStore } from "./scripts/device-store";
import type { DeviceInfo } from "./shared/device-store-types";
import { sendJson, parseBody, extractBearerToken, getClientIp, isLocalhost } from "./shared/http-utils";

// ============================================================================
// Helper Functions
// ============================================================================

const virtualInterfacePatterns = [
  /^docker/i, /^br-/i, /^veth/i, /^vEthernet/i,
  /^vmnet/i, /^VMware/i, /^VirtualBox/i, /^vboxnet/i,
  /^Hyper-V/i, /^Default Switch/i, /^WSL/i,
  /^tun/i, /^tap/i, /^singbox/i, /^sing-box/i, /^clash/i, /^utun/i,
  /^tailscale/i, /^ZeroTier/i, /^zt/i,
  /^wg/i, /^wireguard/i, /^ham/i, /^Hamachi/i, /^npcap/i, /^lo/i,
];

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
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

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url || "", `http://localhost:5174`);
}

// ============================================================================
// Vite Config
// ============================================================================

export default defineConfig({
  plugins: [
    tailwindcss(),
    solid(),
    {
      name: "standalone-auth-api",
      configureServer(server) {
        // Handle CORS preflight
        server.middlewares.use((req, res, next) => {
          if (req.method === "OPTIONS") {
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
            res.statusCode = 204;
            res.end();
            return;
          }
          next();
        });

        // ====================================================================
        // Auth: Validate token
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

          const device = deviceStore.getDevice(result.deviceId);
          sendJson(res, { valid: true, deviceId: result.deviceId, device });
        });

        // ====================================================================
        // Auth: Verify code and login
        // POST /api/auth/verify
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/api/auth/verify" || req.method !== "POST") {
            next();
            return;
          }

          try {
            const body = await parseBody(req);
            const { code, device: deviceInfo } = body;

            const validCode = deviceStore.getAccessCode();
            if (code !== validCode) {
              sendJson(res, { success: false, error: "Invalid code" }, 401);
              return;
            }

            // Code is valid, create device and generate token
            const deviceId = deviceStore.generateDeviceId();
            const token = deviceStore.generateToken(deviceId);
            const clientIp = getClientIp(req);

            const device: DeviceInfo = {
              id: deviceId,
              name: deviceInfo?.name || "Unknown Device",
              platform: deviceInfo?.platform || "Unknown",
              browser: deviceInfo?.browser || "Unknown",
              createdAt: Date.now(),
              lastSeenAt: Date.now(),
              ip: clientIp,
            };

            deviceStore.addDevice(device);

            sendJson(res, { success: true, token, deviceId });
          } catch (err) {
            sendJson(res, { success: false, error: "Bad request" }, 400);
          }
        });

        // ====================================================================
        // Auth: Request access (create pending request for approval)
        // POST /api/auth/request-access
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/api/auth/request-access" || req.method !== "POST") {
            next();
            return;
          }

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
        });

        // ====================================================================
        // Auth: Check access status (poll for approval)
        // GET /api/auth/check-status?requestId=xxx
        // ====================================================================
        server.middlewares.use((req, res, next) => {
          const url = parseUrl(req);
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
        // Auth: Local auth (auto-authenticate for localhost)
        // POST /api/auth/local-auth
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/api/auth/local-auth" || req.method !== "POST") {
            next();
            return;
          }

          const clientIp = getClientIp(req);
          if (!isLocalhost(clientIp)) {
            sendJson(res, { success: false, error: "Local auth only available from localhost" }, 403);
            return;
          }

          try {
            const body = await parseBody(req);
            const deviceInfo = body.device || {};

            // Localhost access - auto authenticate
            const deviceId = deviceStore.generateDeviceId();
            const token = deviceStore.generateToken(deviceId);

            const device: DeviceInfo = {
              id: deviceId,
              name: deviceInfo.name || "Localhost",
              platform: deviceInfo.platform || "Unknown",
              browser: deviceInfo.browser || "Unknown",
              createdAt: Date.now(),
              lastSeenAt: Date.now(),
              ip: clientIp,
              isHost: true,
            };

            deviceStore.addDevice(device);

            sendJson(res, { success: true, token, deviceId });
          } catch {
            sendJson(res, { success: false, error: "Bad request" }, 400);
          }
        });

        // ====================================================================
        // Auth: Get access code (for display, requires auth)
        // GET /api/auth/code
        // ====================================================================
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/api/auth/code" || req.method !== "GET") {
            next();
            return;
          }

          const token = extractBearerToken(req);
          if (!token || !deviceStore.verifyToken(token).valid) {
            sendJson(res, { error: "Unauthorized" }, 401);
            return;
          }

          const code = deviceStore.getAccessCode();
          sendJson(res, { code });
        });

        // ====================================================================
        // Auth: Logout
        // POST /api/auth/logout
        // ====================================================================
        server.middlewares.use((req, res, next) => {
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

          deviceStore.removeDevice(result.deviceId);
          sendJson(res, { success: true });
        });

        // ====================================================================
        // Admin: Get pending requests (for approval UI)
        // GET /api/admin/pending-requests
        // ====================================================================
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/api/admin/pending-requests" || req.method !== "GET") {
            next();
            return;
          }

          const requests = deviceStore.listPendingRequests();
          sendJson(res, { requests });
        });

        // ====================================================================
        // Admin: Approve request
        // POST /api/admin/approve
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/api/admin/approve" || req.method !== "POST") {
            next();
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
          } catch {
            sendJson(res, { error: "Bad request" }, 400);
          }
        });

        // ====================================================================
        // Admin: Deny request
        // POST /api/admin/deny
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/api/admin/deny" || req.method !== "POST") {
            next();
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
          } catch {
            sendJson(res, { error: "Bad request" }, 400);
          }
        });

        // ====================================================================
        // Devices: List all devices
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
        // Devices: Revoke or rename a specific device
        // DELETE /api/devices/:id
        // PUT /api/devices/:id/rename
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          const url = parseUrl(req);
          const pathname = url.pathname;

          // Match /api/devices/:id (DELETE)
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

          // Match /api/devices/:id/rename (PUT)
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

          next();
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
      "/ws": {
        target: "http://localhost:4200",
        ws: true,
      },
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
