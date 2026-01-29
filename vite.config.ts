import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";
import os from "os";
import fs from "fs";
import pathModule from "path";
import crypto from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { tunnelManager } from "./scripts/tunnel-manager";

// ============================================================================
// Types
// ============================================================================

interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  browser: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string;
  isHost?: boolean;
}

interface PendingRequest {
  id: string;
  device: {
    name: string;
    platform: string;
    browser: string;
  };
  ip: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: number;
  resolvedAt?: number;
  deviceId?: string;
  token?: string;
}

interface DeviceStoreData {
  devices: Record<string, DeviceInfo>;
  pendingRequests: Record<string, PendingRequest>;
  revokedTokens: string[];
  jwtSecret: string;
}

interface TokenPayload {
  deviceId: string;
  iat: number;
  exp: number;
}

// ============================================================================
// Simple JWT Implementation
// ============================================================================

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function base64UrlDecode(str: string): string {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64").toString("utf-8");
}

function createHmacSignature(data: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

function generateJWT(payload: object, secret: string, expiresInDays: number = 365): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);

  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInDays * 24 * 60 * 60,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
  const signature = createHmacSignature(`${headerB64}.${payloadB64}`, secret);

  return `${headerB64}.${payloadB64}.${signature}`;
}

function verifyJWT(token: string, secret: string): { valid: boolean; payload?: TokenPayload } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false };

    const [headerB64, payloadB64, signature] = parts;
    const expectedSignature = createHmacSignature(`${headerB64}.${payloadB64}`, secret);

    if (signature !== expectedSignature) return { valid: false };

    const payload = JSON.parse(base64UrlDecode(payloadB64)) as TokenPayload;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return { valid: false };

    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}

// ============================================================================
// Device Store (File-based, shared with Electron dev mode)
// ============================================================================

class DeviceStore {
  private data: DeviceStoreData | null = null;
  private revokedSet: Set<string> = new Set();

  constructor() {
    this.data = this.load();
    this.revokedSet = new Set(this.data.revokedTokens);
  }

  private getDevicesFilePath(): string {
    // Use .devices.json in current working directory (same as Electron dev mode)
    return pathModule.join(process.cwd(), ".devices.json");
  }

  private load(): DeviceStoreData {
    const DEVICES_FILE = this.getDevicesFilePath();

    if (fs.existsSync(DEVICES_FILE)) {
      try {
        const raw = fs.readFileSync(DEVICES_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        return {
          devices: parsed.devices || {},
          pendingRequests: parsed.pendingRequests || {},
          revokedTokens: parsed.revokedTokens || [],
          jwtSecret: parsed.jwtSecret || this.generateSecret(),
        };
      } catch {
        return this.createEmpty();
      }
    }
    return this.createEmpty();
  }

  private createEmpty(): DeviceStoreData {
    const data: DeviceStoreData = {
      devices: {},
      pendingRequests: {},
      revokedTokens: [],
      jwtSecret: this.generateSecret(),
    };
    this.save(data);
    return data;
  }

  private generateSecret(): string {
    return crypto.randomBytes(64).toString("hex");
  }

  private save(data?: DeviceStoreData): void {
    const toSave = data || this.data!;
    const DEVICES_FILE = this.getDevicesFilePath();
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(toSave, null, 2));
  }

  reload(): void {
    this.data = this.load();
    this.revokedSet = new Set(this.data.revokedTokens);
  }

  generateDeviceId(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  addDevice(device: DeviceInfo): void {
    this.data!.devices[device.id] = device;
    this.save();
  }

  getDevice(deviceId: string): DeviceInfo | undefined {
    return this.data!.devices[deviceId];
  }

  updateDevice(deviceId: string, updates: Partial<DeviceInfo>): void {
    if (this.data!.devices[deviceId]) {
      this.data!.devices[deviceId] = { ...this.data!.devices[deviceId], ...updates };
      this.save();
    }
  }

  updateLastSeen(deviceId: string, ip: string): void {
    if (this.data!.devices[deviceId]) {
      this.data!.devices[deviceId].lastSeenAt = Date.now();
      this.data!.devices[deviceId].ip = ip;
      this.save();
    }
  }

  removeDevice(deviceId: string): boolean {
    if (this.data!.devices[deviceId]) {
      delete this.data!.devices[deviceId];
      this.save();
      return true;
    }
    return false;
  }

  revokeAllExcept(keepDeviceId: string): number {
    const deviceIds = Object.keys(this.data!.devices);
    let count = 0;
    for (const id of deviceIds) {
      if (id !== keepDeviceId) {
        delete this.data!.devices[id];
        count++;
      }
    }
    if (count > 0) {
      this.save();
    }
    return count;
  }

  generateToken(deviceId: string): string {
    return generateJWT({ deviceId }, this.data!.jwtSecret, 365);
  }

  verifyToken(token: string): { valid: boolean; deviceId?: string } {
    if (this.revokedSet.has(token)) {
      return { valid: false };
    }

    const result = verifyJWT(token, this.data!.jwtSecret);
    if (!result.valid || !result.payload) {
      return { valid: false };
    }

    const device = this.data!.devices[result.payload.deviceId];
    if (!device) {
      return { valid: false };
    }

    return { valid: true, deviceId: result.payload.deviceId };
  }

  listDevices(): DeviceInfo[] {
    return Object.values(this.data!.devices);
  }

  getAccessCode(): string {
    // Use hash of secret to generate 6-digit numeric code
    const hash = crypto.createHash("sha256").update(this.data!.jwtSecret).digest("hex");
    const num = parseInt(hash.substring(0, 12), 16) % 1000000;
    return num.toString().padStart(6, "0");
  }

  // =========================================================================
  // Pending Request Methods
  // =========================================================================

  listPendingRequests(): PendingRequest[] {
    const now = Date.now();
    const validRequests: PendingRequest[] = [];

    for (const req of Object.values(this.data!.pendingRequests)) {
      if (req.status === "pending" && now - req.createdAt < 5 * 60 * 1000) {
        validRequests.push(req);
      }
    }

    return validRequests;
  }

  createPendingRequest(device: { name: string; platform: string; browser: string }, ip: string): PendingRequest {
    const id = crypto.randomBytes(16).toString("hex");

    const request: PendingRequest = {
      id,
      device,
      ip,
      status: "pending",
      createdAt: Date.now(),
    };

    this.data!.pendingRequests[id] = request;
    this.save();

    return request;
  }

  getPendingRequest(requestId: string): PendingRequest | undefined {
    return this.data!.pendingRequests[requestId];
  }

  approveRequest(requestId: string): PendingRequest | undefined {
    const request = this.data!.pendingRequests[requestId];

    if (!request || request.status !== "pending") {
      return undefined;
    }

    const deviceId = this.generateDeviceId();
    const token = generateJWT({ deviceId }, this.data!.jwtSecret, 365);

    const device: DeviceInfo = {
      id: deviceId,
      name: request.device.name,
      platform: request.device.platform,
      browser: request.device.browser,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      ip: request.ip,
    };

    this.data!.devices[device.id] = device;

    request.status = "approved";
    request.resolvedAt = Date.now();
    request.deviceId = deviceId;
    request.token = token;

    this.save();

    return request;
  }

  denyRequest(requestId: string): PendingRequest | undefined {
    const request = this.data!.pendingRequests[requestId];

    if (!request || request.status !== "pending") {
      return undefined;
    }

    request.status = "denied";
    request.resolvedAt = Date.now();

    this.save();

    return request;
  }
}

// Initialize device store
const deviceStore = new DeviceStore();

// ============================================================================
// Helper Functions
// ============================================================================

function sendJson(res: ServerResponse, data: any, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.end(JSON.stringify(data));
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

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function isLocalhost(ip: string): boolean {
  const normalizedIp = ip.replace(/^::ffff:/, "");
  return (
    normalizedIp === "127.0.0.1" ||
    normalizedIp === "::1" ||
    normalizedIp === "localhost"
  );
}

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

function parseBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB limit
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk.toString();
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
