// ============================================================================
// Mock Auth Store
// In-memory auth state for E2E testing of remote authentication flows.
// No Electron dependencies, no JWT — simple token strings.
// ============================================================================

export interface PendingRequest {
  id: string;
  device: { name: string; platform: string; browser: string };
  ip: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: number;
  resolvedAt?: number;
  deviceId?: string;
  token?: string;
}

export interface MockDevice {
  id: string;
  name: string;
  platform: string;
  browser: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string;
}

export class MockAuthStore {
  private accessCode = "123456";
  private pendingRequests = new Map<string, PendingRequest>();
  private devices = new Map<string, MockDevice>();
  private tokens = new Map<string, string>(); // token -> deviceId
  private isLocal = true;
  private requestCounter = 0;
  private deviceCounter = 0;

  // --- Control methods (called from test setup / test control endpoints) ---

  setIsLocal(value: boolean): void {
    this.isLocal = value;
  }

  getIsLocal(): boolean {
    return this.isLocal;
  }

  getAccessCode(): string {
    return this.accessCode;
  }

  reset(): void {
    this.pendingRequests.clear();
    this.devices.clear();
    this.tokens.clear();
    this.isLocal = true;
    this.requestCounter = 0;
    this.deviceCounter = 0;
  }

  // --- Auth flow methods ---

  verifyAccessCode(code: string): boolean {
    return code === this.accessCode;
  }

  createPendingRequest(
    device: { name: string; platform: string; browser: string },
    ip: string,
  ): PendingRequest {
    const id = `req-${++this.requestCounter}`;
    const request: PendingRequest = {
      id,
      device,
      ip,
      status: "pending",
      createdAt: Date.now(),
    };
    this.pendingRequests.set(id, request);
    return request;
  }

  getPendingRequest(id: string): PendingRequest | undefined {
    return this.pendingRequests.get(id);
  }

  approveRequest(requestId: string): PendingRequest | undefined {
    const req = this.pendingRequests.get(requestId);
    if (!req || req.status !== "pending") return undefined;

    const deviceId = `device-${++this.deviceCounter}`;
    const token = `test-remote-token-${deviceId}`;

    req.status = "approved";
    req.resolvedAt = Date.now();
    req.deviceId = deviceId;
    req.token = token;

    this.tokens.set(token, deviceId);
    this.devices.set(deviceId, {
      id: deviceId,
      name: req.device.name,
      platform: req.device.platform,
      browser: req.device.browser,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      ip: req.ip,
    });

    return req;
  }

  denyRequest(requestId: string): PendingRequest | undefined {
    const req = this.pendingRequests.get(requestId);
    if (!req || req.status !== "pending") return undefined;
    req.status = "denied";
    req.resolvedAt = Date.now();
    return req;
  }

  verifyToken(token: string): { valid: boolean; deviceId?: string } {
    const deviceId = this.tokens.get(token);
    if (!deviceId) return { valid: false };
    return { valid: true, deviceId };
  }

  listPendingRequests(): PendingRequest[] {
    return [...this.pendingRequests.values()].filter(
      (r) => r.status === "pending",
    );
  }
}
