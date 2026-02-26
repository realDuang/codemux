/**
 * Vite API Middleware Plugin
 * Provides HTTP API endpoints for both regular Vite dev server and Electron dev mode
 */

import fs from "fs";
import path from "path";
import os from "os";
import type { IncomingMessage, ServerResponse } from "http";
import type { Plugin, ViteDevServer } from "vite";

// ============================================================================
// Types
// ============================================================================

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  browser: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string;
  isHost?: boolean;
}

export interface TunnelInfo {
  url: string;
  status: "starting" | "running" | "stopped" | "error";
  startTime?: number;
  error?: string;
}

// ============================================================================
// Device Store Interface (shared between scripts/device-store and electron/main/services/device-store)
// ============================================================================

interface DeviceStoreInterface {
  generateDeviceId(): string;
  generateToken(deviceId: string): string;
  verifyToken(token: string): { valid: boolean; deviceId?: string };
  addDevice(device: DeviceInfo): void;
  getDevice(deviceId: string): DeviceInfo | undefined;
  listDevices(): DeviceInfo[];
  updateDevice(deviceId: string, updates: Partial<DeviceInfo>): void;
  updateLastSeen(deviceId: string, ip: string): void;
  removeDevice?(deviceId: string): void;
  revokeToken?(token: string): void;
  revokeDevice?(deviceId: string): boolean;
  revokeAllExcept?(deviceId: string): number;
  createPendingRequest?(device: { name: string; platform: string; browser: string }, ip: string): any;
  getPendingRequest?(requestId: string): any;
  listPendingRequests?(): any[];
  approveRequest?(requestId: string): any;
  denyRequest?(requestId: string): any;
  getAccessCode?(): string;
}

interface TunnelManagerInterface {
  start(port: number): Promise<TunnelInfo>;
  stop(): Promise<void>;
  getInfo(): TunnelInfo;
}

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

function isLocalhost(ip: string): boolean {
  const normalizedIp = ip.replace(/^::ffff:/, "");
  return (
    normalizedIp === "127.0.0.1" ||
    normalizedIp === "::1" ||
    normalizedIp === "localhost"
  );
}

// ============================================================================
// Plugin Factory
// ============================================================================

export interface ApiMiddlewareOptions {
  deviceStore: DeviceStoreInterface;
  tunnelManager?: TunnelManagerInterface;
  defaultPort?: number;
}

export function createApiMiddlewarePlugin(options: ApiMiddlewareOptions): Plugin {
  const { deviceStore, tunnelManager, defaultPort = 5173 } = options;

  return {
    name: "api-middleware",
    configureServer(server: ViteDevServer) {
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

        const clientIp = getClientIp(req);
        deviceStore.updateLastSeen(result.deviceId, clientIp);

        const device = deviceStore.getDevice(result.deviceId);
        sendJson(res, { valid: true, deviceId: result.deviceId, device });
      });

      // ====================================================================
      // Auth: Get access code
      // GET /api/auth/code
      // ====================================================================
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/api/auth/code" || req.method !== "GET") {
          next();
          return;
        }

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

        // Use deviceStore.getAccessCode if available, otherwise read from file
        if (deviceStore.getAccessCode) {
          const code = deviceStore.getAccessCode();
          sendJson(res, { code });
        } else {
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
      // Auth: Request access (remote device)
      // POST /api/auth/request-access
      // ====================================================================
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/auth/request-access" || req.method !== "POST") {
          next();
          return;
        }

        try {
          const { code, device } = await parseBody(req);

          // Verify code
          let validCode: string | null = null;
          if (deviceStore.getAccessCode) {
            validCode = deviceStore.getAccessCode();
          } else {
            const authCodePath = path.join(process.cwd(), ".auth-code");
            if (fs.existsSync(authCodePath)) {
              validCode = fs.readFileSync(authCodePath, "utf-8").trim();
            }
          }

          if (!validCode) {
            sendJson(res, { success: false, error: "Auth code not found" }, 500);
            return;
          }

          if (code !== validCode) {
            sendJson(res, { success: false, error: "Invalid code" }, 401);
            return;
          }

          const clientIp = getClientIp(req);

          if (deviceStore.createPendingRequest) {
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
          } else {
            sendJson(res, { success: false, error: "Pending requests not supported" }, 501);
          }
        } catch (err) {
          sendJson(res, { success: false, error: "Bad request" }, 400);
        }
      });

      // ====================================================================
      // Auth: Check access request status
      // GET /api/auth/check-status?requestId=xxx
      // ====================================================================
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url || "", `http://${req.headers.host}`);
        if (url.pathname !== "/api/auth/check-status" || req.method !== "GET") {
          next();
          return;
        }

        const requestId = url.searchParams.get("requestId");
        if (!requestId || !deviceStore.getPendingRequest) {
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
      // Admin: Get pending access requests
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

        const requests = deviceStore.listPendingRequests?.() || [];
        sendJson(res, { requests });
      });

      // ====================================================================
      // Admin: Approve/Deny access request
      // POST /api/admin/approve, POST /api/admin/deny
      // ====================================================================
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/admin/approve" && req.url !== "/api/admin/deny") {
          next();
          return;
        }
        if (req.method !== "POST") {
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

          if (req.url === "/api/admin/approve") {
            const approved = deviceStore.approveRequest?.(requestId);
            if (approved) {
              sendJson(res, { success: true, device: deviceStore.getDevice(approved.deviceId!) });
            } else {
              sendJson(res, { error: "Request not found or already processed" }, 404);
            }
          } else {
            const denied = deviceStore.denyRequest?.(requestId);
            if (denied) {
              sendJson(res, { success: true });
            } else {
              sendJson(res, { error: "Request not found or already processed" }, 404);
            }
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
          port: defaultPort,
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
      if (tunnelManager) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/api/tunnel")) {
            next();
            return;
          }

          try {
            if (req.url === "/api/tunnel/start" && req.method === "POST") {
              const info = await tunnelManager.start(defaultPort);
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
      }
    },
  };
}
