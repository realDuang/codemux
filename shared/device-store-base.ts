import fs from "fs";
import crypto from "crypto";
import { generateJWT, verifyJWT } from "./jwt";
import type { DeviceInfo, PendingRequest, DeviceStoreData } from "./device-store-types";

// Re-export types for convenience
export type { DeviceInfo, PendingRequest, DeviceStoreData };

// =============================================================================
// Constants (standardized across all environments)
// =============================================================================

/** Pending requests expire after 5 minutes */
const REQUEST_EXPIRY_MS = 5 * 60 * 1000;

/** Resolved requests are cleaned up after 24 hours */
const RESOLVED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Non-host devices inactive for 14 days are automatically removed */
const DEVICE_INACTIVE_MS = 14 * 24 * 60 * 60 * 1000;

// =============================================================================
// DeviceStoreBase — abstract base class
// =============================================================================

/**
 * Base class for DeviceStore implementations.
 *
 * Subclasses must implement:
 * - `getFilePath()`: Return the absolute path to the .devices.json file
 *
 * Initialization strategy:
 * - Call `loadData()` from the subclass constructor (eager) or an `init()` method (lazy).
 * - Call `getData()` internally to access the loaded data (throws if not loaded).
 */
export abstract class DeviceStoreBase {
  protected data: DeviceStoreData | null = null;

  /** Timestamp of last inactive-device cleanup run (throttle guard). */
  private lastCleanupAt = 0;

  /** Minimum interval between inactive-device cleanup runs (1 hour). */
  private static CLEANUP_THROTTLE_MS = 60 * 60 * 1000;

  /** Subclass provides the absolute path to the devices JSON file. */
  protected abstract getFilePath(): string;

  // ---------------------------------------------------------------------------
  // Initialization & Persistence
  // ---------------------------------------------------------------------------

  /** Load data from disk into memory. Call from subclass constructor or init(). */
  protected loadData(): void {
    this.data = this.loadFromDisk();
  }

  /** Reload data from disk (for syncing with other processes in dev mode). */
  reload(): void {
    if (!this.data) return; // not yet initialized
    this.loadData();
  }

  /** Get loaded data or throw if not initialized. */
  protected getData(): DeviceStoreData {
    if (!this.data) {
      throw new Error("DeviceStore not initialized. Call init() or construct properly.");
    }
    return this.data;
  }

  private loadFromDisk(): DeviceStoreData {
    const filePath = this.getFilePath();

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        return {
          devices: parsed.devices || {},
          pendingRequests: parsed.pendingRequests || {},
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
      jwtSecret: this.generateSecret(),
    };
    this.save(data);
    return data;
  }

  private generateSecret(): string {
    return crypto.randomBytes(64).toString("hex");
  }

  protected save(data?: DeviceStoreData): void {
    const toSave = data || this.getData();
    const filePath = this.getFilePath();
    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), { mode: 0o600 });
  }

  // ---------------------------------------------------------------------------
  // Hook for subclasses that need pre-read refresh (e.g. scripts/ dev mode)
  // ---------------------------------------------------------------------------

  /**
   * Called before read operations. Override in subclass to reload from disk
   * if needed (e.g., to sync with another process writing the same file).
   * Default: no-op.
   */
  protected beforeRead(): void {
    // no-op by default
  }

  // ---------------------------------------------------------------------------
  // Device Management
  // ---------------------------------------------------------------------------

  generateDeviceId(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  addDevice(device: DeviceInfo): void {
    this.beforeRead();
    const data = this.getData();
    data.devices[device.id] = device;
    this.save();
  }

  getDevice(deviceId: string): DeviceInfo | undefined {
    this.beforeRead();
    return this.getData().devices[deviceId];
  }

  updateDevice(deviceId: string, updates: Partial<DeviceInfo>): void {
    this.beforeRead();
    const data = this.getData();
    if (data.devices[deviceId]) {
      data.devices[deviceId] = { ...data.devices[deviceId], ...updates };
      this.save();
    }
  }

  updateLastSeen(deviceId: string, ip: string): void {
    this.beforeRead();
    const data = this.getData();
    if (data.devices[deviceId]) {
      data.devices[deviceId].lastSeenAt = Date.now();
      data.devices[deviceId].ip = ip;
      this.cleanupInactiveDevicesThrottled();
      this.save();
    }
  }

  /** Returns devices sorted by lastSeenAt descending (most recently active first). */
  listDevices(): DeviceInfo[] {
    this.beforeRead();
    this.cleanupInactiveDevices();
    return Object.values(this.getData().devices).sort(
      (a, b) => b.lastSeenAt - a.lastSeenAt,
    );
  }

  removeDevice(deviceId: string): boolean {
    this.beforeRead();
    const data = this.getData();
    if (data.devices[deviceId]) {
      delete data.devices[deviceId];
      this.save();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Token Management
  // ---------------------------------------------------------------------------

  generateToken(deviceId: string): string {
    this.beforeRead();
    return generateJWT({ deviceId }, this.getData().jwtSecret, 365);
  }

  verifyToken(token: string): { valid: boolean; deviceId?: string } {
    this.beforeRead();

    const data = this.getData();
    const result = verifyJWT(token, data.jwtSecret);
    if (!result.valid || !result.payload) {
      return { valid: false };
    }

    const device = data.devices[result.payload.deviceId];
    if (!device) {
      return { valid: false };
    }

    // Reject inactive non-host devices without deleting them.
    // Actual cleanup happens lazily via updateLastSeen / listDevices.
    const cutoff = Date.now() - DEVICE_INACTIVE_MS;
    if (!device.isHost && device.lastSeenAt < cutoff) {
      return { valid: false };
    }

    return { valid: true, deviceId: result.payload.deviceId };
  }

  /**
   * Revoke a device by removing it.
   * All tokens for this device will fail verification because the device no longer exists.
   */
  revokeDevice(deviceId: string): boolean {
    return this.removeDevice(deviceId);
  }

  /** Revoke all devices except the specified one. Returns number of devices removed. */
  revokeAllExcept(keepDeviceId: string): number {
    this.beforeRead();
    const data = this.getData();
    const deviceIds = Object.keys(data.devices);
    let count = 0;
    for (const id of deviceIds) {
      if (id !== keepDeviceId) {
        delete data.devices[id];
        count++;
      }
    }
    if (count > 0) {
      this.save();
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Pending Request Management
  // ---------------------------------------------------------------------------

  generateRequestId(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  createPendingRequest(
    device: { name: string; platform: string; browser: string },
    ip: string,
  ): PendingRequest {
    this.beforeRead();
    this.cleanupExpiredRequests();

    const request: PendingRequest = {
      id: this.generateRequestId(),
      device,
      ip,
      status: "pending",
      createdAt: Date.now(),
    };

    this.getData().pendingRequests[request.id] = request;
    this.save();
    return request;
  }

  getPendingRequest(requestId: string): PendingRequest | undefined {
    this.beforeRead();
    const data = this.getData();
    const request = data.pendingRequests[requestId];
    if (!request) return undefined;

    if (this.isRequestExpired(request)) {
      this.expireRequest(requestId);
      return data.pendingRequests[requestId];
    }

    return request;
  }

  listPendingRequests(): PendingRequest[] {
    this.beforeRead();
    this.cleanupExpiredRequests();
    return Object.values(this.getData().pendingRequests)
      .filter((r) => r.status === "pending")
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  approveRequest(requestId: string): PendingRequest | undefined {
    // Reload from disk so we see changes made by other processes (e.g. server-auth.ts).
    this.beforeRead();
    const data = this.getData();
    const request = data.pendingRequests[requestId];
    if (!request || request.status !== "pending") return undefined;

    if (this.isRequestExpired(request)) {
      this.expireRequest(requestId);
      return undefined;
    }

    const deviceId = this.generateDeviceId();
    const token = generateJWT({ deviceId }, data.jwtSecret, 365);

    const deviceInfo: DeviceInfo = {
      id: deviceId,
      name: request.device.name,
      platform: request.device.platform,
      browser: request.device.browser,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      ip: request.ip,
    };

    // Reload again right before writing to minimise the race window with
    // concurrent processes (e.g. Electron main + server-auth CLI).
    this.beforeRead();
    const freshData = this.getData();

    // Re-verify the request is still pending after the second reload.
    const freshRequest = freshData.pendingRequests[requestId];
    if (!freshRequest || freshRequest.status !== "pending") return undefined;

    freshData.devices[deviceInfo.id] = deviceInfo;

    freshRequest.status = "approved";
    freshRequest.resolvedAt = Date.now();
    freshRequest.deviceId = deviceId;
    freshRequest.token = token;

    this.save();
    return freshRequest;
  }

  denyRequest(requestId: string): PendingRequest | undefined {
    // Reload again right before writing to minimise the race window.
    this.beforeRead();
    const data = this.getData();
    const request = data.pendingRequests[requestId];
    if (!request || request.status !== "pending") return undefined;

    request.status = "denied";
    request.resolvedAt = Date.now();

    // Second reload + merge to reduce chance of overwriting concurrent changes.
    this.beforeRead();
    const freshData = this.getData();
    const freshRequest = freshData.pendingRequests[requestId];
    if (!freshRequest || freshRequest.status !== "pending") {
      // Another process already handled this request.
      return freshRequest ?? undefined;
    }

    freshRequest.status = "denied";
    freshRequest.resolvedAt = Date.now();

    this.save();
    return freshRequest;
  }

  // ---------------------------------------------------------------------------
  // Access Code
  // ---------------------------------------------------------------------------

  /**
   * Generate a stable 6-digit access code derived from the JWT secret.
   */
  getAccessCode(): string {
    this.beforeRead();
    const data = this.getData();
    const hash = crypto
      .createHash("sha256")
      .update(data.jwtSecret)
      .digest("hex");
    const num = parseInt(hash.substring(0, 12), 16) % 1000000;
    return num.toString().padStart(6, "0");
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private isRequestExpired(request: PendingRequest): boolean {
    if (request.status !== "pending") return false;
    return Date.now() - request.createdAt > REQUEST_EXPIRY_MS;
  }

  private expireRequest(requestId: string): void {
    const data = this.getData();
    const request = data.pendingRequests[requestId];
    if (request && request.status === "pending") {
      request.status = "expired";
      request.resolvedAt = Date.now();
      this.save();
    }
  }

  protected cleanupExpiredRequests(): void {
    const data = this.getData();
    let changed = false;

    // Expire pending requests that have timed out
    for (const request of Object.values(data.pendingRequests)) {
      if (this.isRequestExpired(request)) {
        request.status = "expired";
        request.resolvedAt = Date.now();
        changed = true;
      }
    }

    // Remove resolved requests older than 24 hours
    const cutoff = Date.now() - RESOLVED_RETENTION_MS;
    for (const [id, request] of Object.entries(data.pendingRequests)) {
      if (
        request.status !== "pending" &&
        request.resolvedAt &&
        request.resolvedAt < cutoff
      ) {
        delete data.pendingRequests[id];
        changed = true;
      }
    }

    if (changed) {
      this.save();
    }

    // Also clean up inactive devices
    this.cleanupInactiveDevices();
  }

  /**
   * Throttled wrapper: only runs cleanupInactiveDevices if at least
   * CLEANUP_THROTTLE_MS has elapsed since the last run.
   */
  private cleanupInactiveDevicesThrottled(): void {
    const now = Date.now();
    if (now - this.lastCleanupAt < DeviceStoreBase.CLEANUP_THROTTLE_MS) return;
    this.lastCleanupAt = now;
    this.cleanupInactiveDevices();
  }

  /**
   * Remove non-host devices that have been inactive for longer than DEVICE_INACTIVE_MS.
   * Host devices (isHost: true) are never auto-removed.
   *
   * Re-reads the store before saving to reduce the lost-update window in dev mode,
   * where the file may be shared with another process.
   */
  protected cleanupInactiveDevices(): void {
    const data = this.getData();
    const cutoff = Date.now() - DEVICE_INACTIVE_MS;

    const inactiveIds: string[] = [];
    for (const [id, device] of Object.entries(data.devices)) {
      if (!device.isHost && device.lastSeenAt < cutoff) {
        inactiveIds.push(id);
      }
    }

    if (inactiveIds.length === 0) {
      return;
    }

    // Reload before saving to avoid overwriting concurrent changes in dev mode.
    this.beforeRead();
    const freshData = this.getData();
    let changed = false;

    for (const id of inactiveIds) {
      const device = freshData.devices[id];
      if (device && !device.isHost && device.lastSeenAt < cutoff) {
        delete freshData.devices[id];
        changed = true;
      }
    }

    if (changed) {
      this.save();
    }
  }
}
