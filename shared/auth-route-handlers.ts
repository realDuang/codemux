import type { IncomingMessage, ServerResponse } from "http";
import { sendJson, parseBody, extractBearerToken, getClientIp, isLocalhost } from "./http-utils";
import type { DeviceInfo, PendingRequest } from "./device-store-types";
import { SHARED_SETTINGS_KEYS, isSharedSettingsKey, isValidSharedSettingValue } from "./settings-keys";

// =============================================================================
// Shared auth route handlers for auth-api-server and production-server.
//
// Both servers implement identical auth/device/admin routes. This module
// extracts the shared logic so each server delegates here instead of
// duplicating ~300 lines of route handling.
// =============================================================================

// -----------------------------------------------------------------------------
// Minimal interface — only the DeviceStore methods used by auth routes
// -----------------------------------------------------------------------------

interface AuthDeviceStore {
  getAccessCode(): string;
  verifyToken(token: string): { valid: boolean; deviceId?: string };
  getDevice(id: string): DeviceInfo | undefined;
  listDevices(): DeviceInfo[];
  addDevice(device: DeviceInfo): void;
  removeDevice(id: string): boolean;
  updateDevice(id: string, updates: Partial<DeviceInfo>): void;
  generateDeviceId(): string;
  generateToken(deviceId: string): string;
  createPendingRequest(device: { name: string; platform: string; browser: string }, ip: string): PendingRequest;
  getPendingRequest(id: string): PendingRequest | undefined;
  listPendingRequests(): PendingRequest[];
  approveRequest(requestId: string): PendingRequest | undefined;
  denyRequest(requestId: string): PendingRequest | undefined;
  revokeAllExcept(deviceId: string): number;
}

/**
 * Options to customize local-auth behavior per server environment.
 */
interface LocalAuthOptions {
  /** Default device name for localhost auto-auth (e.g. "Local Browser" or "Local Machine") */
  defaultDeviceName: string;
  /** Default platform when not provided (e.g. "web" or process.platform) */
  defaultPlatform: string;
  /** Default browser when not provided */
  defaultBrowser: string;
  /** Whether to include the device object in the local-auth response */
  includeDeviceInResponse: boolean;
}

// -----------------------------------------------------------------------------
// Main auth route dispatcher
// Returns true if the route was handled, false otherwise.
// -----------------------------------------------------------------------------

export async function handleAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  store: AuthDeviceStore,
  localAuthOptions: LocalAuthOptions,
): Promise<boolean> {
  // --- Auth routes ---
  if (pathname === "/api/auth/validate" && req.method === "GET") {
    return handleValidateToken(req, res, store);
  }
  if (pathname === "/api/auth/request-access" && req.method === "POST") {
    return handleRequestAccess(req, res, store);
  }
  if (pathname === "/api/auth/check-status" && req.method === "GET") {
    return handleCheckStatus(res, url, store);
  }
  if (pathname === "/api/auth/logout" && req.method === "POST") {
    return handleLogout(req, res, store);
  }
  if (pathname === "/api/auth/local-auth" && req.method === "POST") {
    return handleLocalAuth(req, res, store, localAuthOptions);
  }
  if (pathname === "/api/auth/code" && req.method === "GET") {
    if (!requireAuth(req, res, store)) return true;
    sendJson(res, { code: store.getAccessCode() });
    return true;
  }

  // --- Admin routes ---
  if (pathname === "/api/admin/pending-requests" && req.method === "GET") {
    if (!requireAuth(req, res, store)) return true;
    sendJson(res, { requests: store.listPendingRequests() });
    return true;
  }
  if (pathname === "/api/admin/approve" && req.method === "POST") {
    if (!requireAuth(req, res, store)) return true;
    return handleApproveRequest(req, res, store);
  }
  if (pathname === "/api/admin/deny" && req.method === "POST") {
    if (!requireAuth(req, res, store)) return true;
    return handleDenyRequest(req, res, store);
  }

  // --- Device routes ---
  if (pathname === "/api/devices" && req.method === "GET") {
    return handleListDevices(req, res, store);
  }
  if (pathname === "/api/devices/revoke-others" && req.method === "POST") {
    return handleRevokeOthers(req, res, store);
  }

  // Parameterized device routes
  const revokeMatch = pathname.match(/^\/api\/devices\/([a-f0-9]+)$/);
  if (revokeMatch && req.method === "DELETE") {
    return handleRevokeDevice(req, res, revokeMatch[1], store);
  }

  const renameMatch = pathname.match(/^\/api\/devices\/([a-f0-9]+)\/rename$/);
  if (renameMatch && req.method === "PUT") {
    return handleRenameDevice(req, res, renameMatch[1], store);
  }

  return false;
}

// -----------------------------------------------------------------------------
// Log API route dispatcher (localhost-only)
// Returns true if the route was handled, false otherwise.
// -----------------------------------------------------------------------------

export async function handleLogRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  logFns: {
    getLogFilePath: () => string;
    getFileLogLevel: () => string;
    setFileLogLevel: (level: string) => void;
  },
): Promise<boolean> {
  if (pathname === "/api/system/log/path" && req.method === "GET") {
    if (!requireLocalhost(req, res)) return true;
    sendJson(res, { path: logFns.getLogFilePath() });
    return true;
  }

  if (pathname === "/api/system/log/level" && req.method === "GET") {
    if (!requireLocalhost(req, res)) return true;
    sendJson(res, { level: logFns.getFileLogLevel() });
    return true;
  }

  if (pathname === "/api/system/log/level" && req.method === "POST") {
    if (!requireLocalhost(req, res)) return true;
    try {
      const body = await parseBody(req);
      if (!body.level || typeof body.level !== "string") {
        sendJson(res, { error: "level is required" }, 400);
        return true;
      }
      logFns.setFileLogLevel(body.level);
      sendJson(res, { success: true });
    } catch {
      sendJson(res, { error: "Bad request" }, 400);
    }
    return true;
  }

  return false;
}

// -----------------------------------------------------------------------------
// Settings route dispatcher (auth-required).
// Returns filtered host settings so web clients can bootstrap on page load.
// Accepts PATCH to write shared settings back to the host.
// -----------------------------------------------------------------------------

function filterSharedSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const key of SHARED_SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      filtered[key] = settings[key];
    }
  }
  return filtered;
}

export async function handleSettingsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  store: AuthDeviceStore,
  settingsFns: {
    loadSettings: () => Record<string, unknown>;
    saveSettings?: (patch: Record<string, unknown>) => void;
  },
): Promise<boolean> {
  if (pathname !== "/api/settings/shared") return false;

  if (req.method === "GET") {
    if (!requireAuth(req, res, store)) return true;
    const settings = settingsFns.loadSettings();
    sendJson(res, { settings: filterSharedSettings(settings) });
    return true;
  }

  if (req.method === "PATCH") {
    if (!requireAuth(req, res, store)) return true;
    if (!settingsFns.saveSettings) {
      sendJson(res, { error: "Write not supported" }, 501);
      return true;
    }
    const body = await parseBody(req);
    if (!body || typeof body !== "object") {
      sendJson(res, { error: "Invalid body" }, 400);
      return true;
    }
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (!isSharedSettingsKey(key)) {
        sendJson(res, { error: `Key "${key}" is not a shared setting` }, 400);
        return true;
      }
      if (!isValidSharedSettingValue(key, value)) {
        sendJson(res, { error: `Invalid value for "${key}"` }, 400);
        return true;
      }
      patch[key] = value;
    }
    if (Object.keys(patch).length === 0) {
      sendJson(res, { error: "Empty patch" }, 400);
      return true;
    }
    settingsFns.saveSettings(patch);
    sendJson(res, { success: true });
    return true;
  }

  return false;
}

// -----------------------------------------------------------------------------
// Helper: enforce localhost access, send 403 if not local.
// Returns true if the request IS from localhost, false if blocked.
// -----------------------------------------------------------------------------

function requireLocalhost(req: IncomingMessage, res: ServerResponse): boolean {
  const clientIp = getClientIp(req);
  if (!isLocalhost(clientIp)) {
    sendJson(res, { error: "Local access only" }, 403);
    return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Helper: extract and verify bearer token, send 401 if invalid.
// Returns { deviceId } on success, null on failure (response already sent).
// -----------------------------------------------------------------------------

function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthDeviceStore,
): { deviceId: string } | null {
  const token = extractBearerToken(req);
  if (!token) {
    sendJson(res, { error: "Unauthorized" }, 401);
    return null;
  }
  const result = store.verifyToken(token);
  if (!result.valid || !result.deviceId) {
    sendJson(res, { error: "Invalid token" }, 401);
    return null;
  }
  return { deviceId: result.deviceId };
}

// -----------------------------------------------------------------------------
// Individual route handlers
// -----------------------------------------------------------------------------

function handleValidateToken(
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthDeviceStore,
): true {
  const token = extractBearerToken(req);
  if (!token) {
    sendJson(res, { error: "No token provided" }, 401);
    return true;
  }

  const result = store.verifyToken(token);
  if (!result.valid || !result.deviceId) {
    sendJson(res, { error: "Invalid or expired token" }, 401);
    return true;
  }

  const device = store.getDevice(result.deviceId);
  sendJson(res, { valid: true, deviceId: result.deviceId, device });
  return true;
}

async function handleRequestAccess(
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthDeviceStore,
): Promise<true> {
  try {
    const body = await parseBody(req);
    const code = body.code;
    const device = body.device as any;

    const validCode = store.getAccessCode();
    if (code !== validCode) {
      sendJson(res, { success: false, error: "Invalid code" }, 401);
      return true;
    }

    const clientIp = getClientIp(req);
    const pendingRequest = store.createPendingRequest(
      {
        name: device?.name || "Unknown Device",
        platform: device?.platform || "Unknown",
        browser: device?.browser || "Unknown",
      },
      clientIp,
    );

    sendJson(res, { success: true, requestId: pendingRequest.id });
  } catch {
    sendJson(res, { success: false, error: "Bad request" }, 400);
  }
  return true;
}

function handleCheckStatus(
  res: ServerResponse,
  url: URL,
  store: AuthDeviceStore,
): true {
  const requestId = url.searchParams.get("requestId");
  if (!requestId) {
    sendJson(res, { status: "not_found" });
    return true;
  }

  const request = store.getPendingRequest(requestId);
  if (!request) {
    sendJson(res, { status: "not_found" });
    return true;
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
  return true;
}

function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthDeviceStore,
): true {
  const token = extractBearerToken(req);
  if (!token) {
    sendJson(res, { error: "No token provided" }, 401);
    return true;
  }

  const result = store.verifyToken(token);
  if (!result.valid || !result.deviceId) {
    sendJson(res, { error: "Invalid token" }, 401);
    return true;
  }

  store.removeDevice(result.deviceId);
  sendJson(res, { success: true });
  return true;
}

async function handleLocalAuth(
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthDeviceStore,
  options: LocalAuthOptions,
): Promise<true> {
  if (!requireLocalhost(req, res)) return true;

  try {
    const body = await parseBody(req);
    const deviceInfo = body.device as any || {};
    const deviceId = store.generateDeviceId();
    const token = store.generateToken(deviceId);

    const device = {
      id: deviceId,
      name: deviceInfo.name || options.defaultDeviceName,
      platform: deviceInfo.platform || options.defaultPlatform,
      browser: deviceInfo.browser || options.defaultBrowser,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      ip: "localhost",
      isHost: true,
    };

    store.addDevice(device);

    if (options.includeDeviceInResponse) {
      sendJson(res, { success: true, token, deviceId, device });
    } else {
      sendJson(res, { success: true, token, deviceId });
    }
  } catch {
    sendJson(res, { success: false, error: "Bad request" }, 400);
  }
  return true;
}

async function handleApproveRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthDeviceStore,
): Promise<true> {
  try {
    const body = await parseBody(req);
    const requestId = body.requestId as string;
    if (!requestId) {
      sendJson(res, { error: "requestId is required" }, 400);
      return true;
    }

    const approved = store.approveRequest(requestId);
    if (approved) {
      sendJson(res, { success: true, device: store.getDevice(approved.deviceId!) });
    } else {
      sendJson(res, { error: "Request not found or already processed" }, 404);
    }
  } catch {
    sendJson(res, { error: "Bad request" }, 400);
  }
  return true;
}

async function handleDenyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthDeviceStore,
): Promise<true> {
  try {
    const body = await parseBody(req);
    const requestId = body.requestId as string;
    if (!requestId) {
      sendJson(res, { error: "requestId is required" }, 400);
      return true;
    }

    const denied = store.denyRequest(requestId);
    if (denied) {
      sendJson(res, { success: true });
    } else {
      sendJson(res, { error: "Request not found or already processed" }, 404);
    }
  } catch {
    sendJson(res, { error: "Bad request" }, 400);
  }
  return true;
}

function handleListDevices(
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthDeviceStore,
): true {
  const auth = requireAuth(req, res, store);
  if (!auth) return true;

  const devices = store.listDevices();
  sendJson(res, { devices, currentDeviceId: auth.deviceId });
  return true;
}

function handleRevokeDevice(
  req: IncomingMessage,
  res: ServerResponse,
  targetDeviceId: string,
  store: AuthDeviceStore,
): true {
  const auth = requireAuth(req, res, store);
  if (!auth) return true;

  if (targetDeviceId === auth.deviceId) {
    sendJson(res, { error: "Cannot revoke current device. Use logout instead." }, 400);
    return true;
  }

  const success = store.removeDevice(targetDeviceId);
  if (success) {
    sendJson(res, { success: true });
  } else {
    sendJson(res, { error: "Device not found" }, 404);
  }
  return true;
}

async function handleRenameDevice(
  req: IncomingMessage,
  res: ServerResponse,
  targetDeviceId: string,
  store: AuthDeviceStore,
): Promise<true> {
  const token = extractBearerToken(req);
  if (!token) {
    sendJson(res, { error: "Unauthorized" }, 401);
    return true;
  }

  const result = store.verifyToken(token);
  if (!result.valid) {
    sendJson(res, { error: "Invalid token" }, 401);
    return true;
  }

  try {
    const body = await parseBody(req);
    const name = body.name;
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      sendJson(res, { error: "Name is required" }, 400);
      return true;
    }

    const device = store.getDevice(targetDeviceId);
    if (!device) {
      sendJson(res, { error: "Device not found" }, 404);
      return true;
    }

    store.updateDevice(targetDeviceId, { name: name.trim() });
    sendJson(res, { success: true, device: store.getDevice(targetDeviceId) });
  } catch {
    sendJson(res, { error: "Bad request" }, 400);
  }
  return true;
}

function handleRevokeOthers(
  req: IncomingMessage,
  res: ServerResponse,
  store: AuthDeviceStore,
): true {
  const auth = requireAuth(req, res, store);
  if (!auth) return true;

  const count = store.revokeAllExcept(auth.deviceId);
  sendJson(res, { success: true, revokedCount: count });
  return true;
}
