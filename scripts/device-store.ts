import fs from "fs";
import path from "path";
import crypto from "crypto";

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
  /** Whether this device is the local host (localhost access) */
  isHost?: boolean;
}

/**
 * Pending access request from a remote device
 * Lifecycle: pending -> approved/denied -> (expires after 2 minutes if no action)
 */
export interface PendingRequest {
  /** Unique request ID */
  id: string;
  /** Device fingerprint info */
  device: {
    name: string;
    platform: string;
    browser: string;
  };
  /** Client IP address */
  ip: string;
  /** Request status */
  status: "pending" | "approved" | "denied" | "expired";
  /** Timestamp when request was created */
  createdAt: number;
  /** Timestamp when request was resolved (approved/denied) */
  resolvedAt?: number;
  /** If approved, the generated device ID */
  deviceId?: string;
  /** If approved, the generated token */
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
// Simple JWT Implementation (no external dependency)
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

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return { valid: false };

    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}

// ============================================================================
// Device Store
// ============================================================================

const DEVICES_FILE = path.join(process.cwd(), ".devices.json");

class DeviceStore {
  private data: DeviceStoreData;
  private revokedSet: Set<string>;

  constructor() {
    this.data = this.load();
    this.revokedSet = new Set(this.data.revokedTokens);
  }

  private load(): DeviceStoreData {
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
    const toSave = data || this.data;
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(toSave, null, 2));
  }

  // -------------------------------------------------------------------------
  // Device Management
  // -------------------------------------------------------------------------

  generateDeviceId(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  addDevice(device: DeviceInfo): void {
    this.data.devices[device.id] = device;
    this.save();
  }

  getDevice(deviceId: string): DeviceInfo | undefined {
    return this.data.devices[deviceId];
  }

  updateDevice(deviceId: string, updates: Partial<DeviceInfo>): void {
    if (this.data.devices[deviceId]) {
      this.data.devices[deviceId] = { ...this.data.devices[deviceId], ...updates };
      this.save();
    }
  }

  updateLastSeen(deviceId: string, ip: string): void {
    if (this.data.devices[deviceId]) {
      this.data.devices[deviceId].lastSeenAt = Date.now();
      this.data.devices[deviceId].ip = ip;
      this.save();
    }
  }

  listDevices(): DeviceInfo[] {
    return Object.values(this.data.devices).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  removeDevice(deviceId: string): boolean {
    if (this.data.devices[deviceId]) {
      delete this.data.devices[deviceId];
      this.save();
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Token Management
  // -------------------------------------------------------------------------

  generateToken(deviceId: string): string {
    return generateJWT({ deviceId }, this.data.jwtSecret, 365);
  }

  verifyToken(token: string): { valid: boolean; deviceId?: string } {
    // Check if token is revoked
    if (this.revokedSet.has(token)) {
      return { valid: false };
    }

    const result = verifyJWT(token, this.data.jwtSecret);
    if (!result.valid || !result.payload) {
      return { valid: false };
    }

    // Check if device still exists
    const device = this.data.devices[result.payload.deviceId];
    if (!device) {
      return { valid: false };
    }

    return { valid: true, deviceId: result.payload.deviceId };
  }

  /**
   * Verify token without checking if device exists.
   * Used for sync-state API where we only need to verify the JWT signature.
   * This allows tokens from removed devices to still sync state.
   */
  verifyTokenLoose(token: string): { valid: boolean; deviceId?: string } {
    // Check if token is revoked
    if (this.revokedSet.has(token)) {
      return { valid: false };
    }

    const result = verifyJWT(token, this.data.jwtSecret);
    if (!result.valid || !result.payload) {
      return { valid: false };
    }

    // Return valid even if device doesn't exist - we only verify JWT signature
    return { valid: true, deviceId: result.payload.deviceId };
  }

  revokeToken(token: string): void {
    if (!this.revokedSet.has(token)) {
      this.revokedSet.add(token);
      this.data.revokedTokens.push(token);
      this.save();
    }
  }

  revokeDevice(deviceId: string): boolean {
    const removed = this.removeDevice(deviceId);
    // Note: We can't easily revoke all tokens for a device without storing them
    // But removing the device will cause token verification to fail
    return removed;
  }

  revokeAllExcept(keepDeviceId: string): number {
    const deviceIds = Object.keys(this.data.devices);
    let count = 0;
    for (const id of deviceIds) {
      if (id !== keepDeviceId) {
        this.removeDevice(id);
        count++;
      }
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Pending Request Management
  // -------------------------------------------------------------------------

  private static REQUEST_EXPIRY_MS = 2 * 60 * 1000; // 2 minutes

  generateRequestId(): string {
    return crypto.randomBytes(8).toString("hex");
  }

  createPendingRequest(device: { name: string; platform: string; browser: string }, ip: string): PendingRequest {
    this.cleanupExpiredRequests();

    const request: PendingRequest = {
      id: this.generateRequestId(),
      device,
      ip,
      status: "pending",
      createdAt: Date.now(),
    };

    this.data.pendingRequests[request.id] = request;
    this.save();
    return request;
  }

  getPendingRequest(requestId: string): PendingRequest | undefined {
    const request = this.data.pendingRequests[requestId];
    if (!request) return undefined;

    if (this.isRequestExpired(request)) {
      this.expireRequest(requestId);
      return this.data.pendingRequests[requestId];
    }

    return request;
  }

  listPendingRequests(): PendingRequest[] {
    this.cleanupExpiredRequests();
    return Object.values(this.data.pendingRequests)
      .filter(r => r.status === "pending")
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  approveRequest(requestId: string): PendingRequest | undefined {
    const request = this.data.pendingRequests[requestId];
    if (!request || request.status !== "pending") return undefined;

    if (this.isRequestExpired(request)) {
      this.expireRequest(requestId);
      return undefined;
    }

    const deviceId = this.generateDeviceId();
    const token = generateJWT({ deviceId }, this.data.jwtSecret, 365);

    const deviceInfo: DeviceInfo = {
      id: deviceId,
      name: request.device.name,
      platform: request.device.platform,
      browser: request.device.browser,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      ip: request.ip,
      isHost: false,
    };

    this.addDevice(deviceInfo);

    request.status = "approved";
    request.resolvedAt = Date.now();
    request.deviceId = deviceId;
    request.token = token;

    this.save();
    return request;
  }

  denyRequest(requestId: string): PendingRequest | undefined {
    const request = this.data.pendingRequests[requestId];
    if (!request || request.status !== "pending") return undefined;

    request.status = "denied";
    request.resolvedAt = Date.now();

    this.save();
    return request;
  }

  private isRequestExpired(request: PendingRequest): boolean {
    if (request.status !== "pending") return false;
    return Date.now() - request.createdAt > DeviceStore.REQUEST_EXPIRY_MS;
  }

  private expireRequest(requestId: string): void {
    const request = this.data.pendingRequests[requestId];
    if (request && request.status === "pending") {
      request.status = "expired";
      request.resolvedAt = Date.now();
      this.save();
    }
  }

  private cleanupExpiredRequests(): void {
    let changed = false;
    for (const [id, request] of Object.entries(this.data.pendingRequests)) {
      if (this.isRequestExpired(request)) {
        request.status = "expired";
        request.resolvedAt = Date.now();
        changed = true;
      }
    }

    const oldCount = Object.keys(this.data.pendingRequests).length;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // Keep resolved requests for 24 hours
    for (const [id, request] of Object.entries(this.data.pendingRequests)) {
      if (request.status !== "pending" && request.resolvedAt && request.resolvedAt < cutoff) {
        delete this.data.pendingRequests[id];
        changed = true;
      }
    }

    if (changed) {
      this.save();
    }
  }

  deleteRequest(requestId: string): boolean {
    if (this.data.pendingRequests[requestId]) {
      delete this.data.pendingRequests[requestId];
      this.save();
      return true;
    }
    return false;
  }
}

export const deviceStore = new DeviceStore();
