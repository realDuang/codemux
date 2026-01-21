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
}

interface DeviceStoreData {
  devices: Record<string, DeviceInfo>;
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
}

export const deviceStore = new DeviceStore();
