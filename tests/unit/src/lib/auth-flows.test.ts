import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isElectron: vi.fn<() => boolean>(),
  authAPI: {
    validateToken: vi.fn(), localAuth: vi.fn(), getAccessCode: vi.fn(),
    getPendingRequests: vi.fn(), approveRequest: vi.fn(), denyRequest: vi.fn(),
  },
  devicesAPI: {
    list: vi.fn(), getCurrentDeviceId: vi.fn(), revoke: vi.fn(),
    rename: vi.fn(), revokeOthers: vi.fn(),
  },
}));

vi.mock("../../../../src/lib/platform", () => ({ isElectron: mocks.isElectron }));
vi.mock("../../../../src/lib/electron-api", () => ({ authAPI: mocks.authAPI, devicesAPI: mocks.devicesAPI }));
vi.mock("../../../../src/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../../../../src/stores/session", () => ({ clearWebInputDrafts: vi.fn() }));

let auth: typeof import("../../../../src/lib/auth").Auth;
let request: ReturnType<typeof vi.fn<typeof fetch>>;
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/605.1.15";
const device = { name: "iPhone", platform: "iOS", browser: "Safari" };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.isElectron.mockReturnValue(false);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("navigator", { userAgent: iphone });
  request = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", request);
  auth = (await import("../../../../src/lib/auth")).Auth;
});

afterEach(() => vi.unstubAllGlobals());

describe("Auth.collectDeviceInfo", () => {
  it.each([
    [iphone, device],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UP1A) Chrome/125.0", { name: "Pixel 8", platform: "Android", browser: "Chrome" }],
    ["Mozilla/5.0 (Windows NT 10.0) Chrome/125.0 Edg/125.0", { name: "Windows PC", platform: "Windows", browser: "Edge" }],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/18.0 Safari/605.1", { name: "Mac", platform: "macOS", browser: "Safari" }],
    ["Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0", { name: "Linux PC", platform: "Linux", browser: "Firefox" }],
    ["Mozilla/5.0 (X11; CrOS x86_64) Chrome/125.0", { name: "Chromebook", platform: "ChromeOS", browser: "Chrome" }],
    ["unknown-client", { name: "Unknown Device", platform: "Unknown", browser: "Unknown" }],
  ])("identifies approval metadata for %s", (userAgent, expected) => {
    vi.stubGlobal("navigator", { userAgent });
    expect(auth.collectDeviceInfo()).toEqual(expected);
  });
});

describe("Auth.localAuth", () => {
  it("persists only a complete successful browser approval", async () => {
    request.mockResolvedValueOnce(response({ success: true, token: "local-token", deviceId: "local-device" }));
    expect(await auth.localAuth()).toEqual({ success: true });
    expect(request).toHaveBeenCalledWith("/api/auth/local-auth", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device }),
    });
    expect(auth.getAuthHeaders()).toEqual({ Authorization: "Bearer local-token" });
    expect(auth.getDeviceId()).toBe("local-device");
  });

  it.each([
    [{ success: true, token: "partial-token" }, 200, "Local auth failed"],
    [{ success: false, error: "Remote access denied" }, 403, "Remote access denied"],
  ])("keeps prior credentials on an incomplete or rejected approval", async (body, status, error) => {
    auth.saveToken("prior-token");
    request.mockResolvedValueOnce(response(body, status));
    expect(await auth.localAuth()).toEqual({ success: false, error });
    expect(auth.getToken()).toBe("prior-token");
  });

  it("reports network failure without establishing authentication", async () => {
    request.mockRejectedValueOnce(new TypeError("offline"));
    expect(await auth.localAuth()).toEqual({ success: false, error: "Network error" });
    expect(auth.isAuthenticated()).toBe(false);
  });

  it("uses the Electron bridge and requires the same complete approval", async () => {
    mocks.isElectron.mockReturnValue(true);
    mocks.authAPI.localAuth.mockResolvedValueOnce({ success: true, token: "ipc-token", deviceId: "ipc-device" });
    expect(await auth.localAuth()).toEqual({ success: true });
    expect(mocks.authAPI.localAuth).toHaveBeenCalledWith(device);
    expect(auth.getDeviceId()).toBe("ipc-device");
    mocks.authAPI.localAuth.mockResolvedValueOnce({ success: false, error: "Host unavailable" });
    expect(await auth.localAuth()).toEqual({ success: false, error: "Host unavailable" });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("Auth.requestAccess", () => {
  it("requests approval without treating a pending request as a login", async () => {
    request.mockResolvedValueOnce(response({ success: true, requestId: "request-1" }));
    expect(await auth.requestAccess("123456")).toEqual({ success: true, requestId: "request-1" });
    expect(request).toHaveBeenCalledWith("/api/auth/request-access", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "123456", device }),
    });
    expect(auth.isAuthenticated()).toBe(false);
  });

  it("reports rejected and unavailable approval requests", async () => {
    request.mockResolvedValueOnce(response({ success: false, error: "Invalid code" }, 401));
    expect(await auth.requestAccess("000000")).toEqual({ success: false, error: "Invalid code" });
    request.mockRejectedValueOnce(new TypeError("offline"));
    expect(await auth.requestAccess("123456")).toEqual({ success: false, error: "Network error" });
    expect(auth.getAuthHeaders()).toEqual({});
  });
});

describe("Auth.checkAccessStatus", () => {
  it("keeps credentials unchanged until approval supplies both token and device ID", async () => {
    auth.saveToken("prior-token");
    request.mockResolvedValueOnce(response({ status: "pending" }));
    request.mockResolvedValueOnce(response({ status: "approved", token: "partial-token" }));
    await auth.checkAccessStatus("request-1");
    await auth.checkAccessStatus("request-1");
    expect(auth.getToken()).toBe("prior-token");
    request.mockResolvedValueOnce(response({ status: "approved", token: "approved-token", deviceId: "phone" }));
    expect(await auth.checkAccessStatus("request-1")).toMatchObject({ status: "approved" });
    expect(auth.getToken()).toBe("approved-token");
    expect(auth.getDeviceId()).toBe("phone");
    expect(request).toHaveBeenLastCalledWith("/api/auth/check-status?requestId=request-1");
  });

  it("returns not_found on transport failure without clearing existing approval", async () => {
    auth.saveToken("prior-token");
    request.mockRejectedValueOnce(new TypeError("offline"));
    expect(await auth.checkAccessStatus("request-1")).toEqual({ status: "not_found" });
    expect(auth.getToken()).toBe("prior-token");
  });
});

const queries = [
    { name: "getDevices", run: () => auth.getDevices(), url: "/api/devices", body: { devices: [{ id: "phone" }], currentDeviceId: "phone" }, fallback: null },
    { name: "getAccessCode", run: () => auth.getAccessCode(), url: "/api/auth/code", body: { code: "123456" }, expected: "123456", fallback: null },
    { name: "getPendingRequests", run: () => auth.getPendingRequests(), url: "/api/admin/pending-requests", body: { requests: [{ id: "r1" }] }, expected: [{ id: "r1" }], fallback: [] },
  ];

for (const { name, run, url, body, expected, fallback } of queries) {
  describe(`Auth.${name}`, () => {
  it("reads using the approved device token", async () => {
    auth.saveToken("device-token");
    request.mockResolvedValueOnce(response(body));
    expect(await run()).toEqual(expected ?? body);
    expect(request).toHaveBeenCalledWith(url, { headers: { Authorization: "Bearer device-token" } });
  });

  it("handles unavailable requests without revoking the device", async () => {
    expect(await run()).toEqual(fallback);
    expect(request).not.toHaveBeenCalled();
    auth.saveToken("device-token");
    request.mockResolvedValueOnce(response({}, 503));
    expect(await run()).toEqual(fallback);
    request.mockRejectedValueOnce(new TypeError("offline"));
    expect(await run()).toEqual(fallback);
    expect(auth.getToken()).toBe("device-token");
  });

  });
}

const mutations = [
    { name: "revokeDevice", run: () => auth.revokeDevice("phone"), url: "/api/devices/phone", method: "DELETE", body: undefined },
    { name: "renameDevice", run: () => auth.renameDevice("phone", "My phone"), url: "/api/devices/phone/rename", method: "PUT", body: { name: "My phone" } },
    { name: "approveRequest", run: () => auth.approveRequest("r1"), url: "/api/admin/approve", method: "POST", body: { requestId: "r1" } },
    { name: "denyRequest", run: () => auth.denyRequest("r1"), url: "/api/admin/deny", method: "POST", body: { requestId: "r1" } },
  ];

for (const { name, run, url, method, body } of mutations) {
  describe(`Auth.${name}`, () => {
  it("confirms the mutation and preserves credentials on failures", async () => {
    expect(await run()).toBe(false);
    expect(request).not.toHaveBeenCalled();
    auth.saveToken("device-token");
    request.mockResolvedValueOnce(response({ success: true }));
    expect(await run()).toBe(true);
    expect(request).toHaveBeenLastCalledWith(url, {
      method,
      headers: { Authorization: "Bearer device-token", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    request.mockResolvedValueOnce(response({}, 403));
    expect(await run()).toBe(false);
    request.mockRejectedValueOnce(new TypeError("offline"));
    expect(await run()).toBe(false);
    expect(auth.getToken()).toBe("device-token");
  });
  });
}

describe("Auth.revokeOtherDevices", () => {
  it("returns the confirmed count and handles unavailable browser requests", async () => {
    expect(await auth.revokeOtherDevices()).toEqual({ success: false });
    expect(request).not.toHaveBeenCalled();
    auth.saveToken("device-token");
    request.mockResolvedValueOnce(response({ revokedCount: 2 }));
    expect(await auth.revokeOtherDevices()).toEqual({ success: true, revokedCount: 2 });
    expect(request).toHaveBeenCalledWith("/api/devices/revoke-others", { method: "POST", headers: { Authorization: "Bearer device-token" } });
    request.mockResolvedValueOnce(response({}, 503));
    expect(await auth.revokeOtherDevices()).toEqual({ success: false });
    request.mockRejectedValueOnce(new TypeError("offline"));
    expect(await auth.revokeOtherDevices()).toEqual({ success: false });
    expect(auth.getToken()).toBe("device-token");
  });
});

describe("Auth.getDevices", () => {
  it("reads the native device list and normalizes a missing current ID", async () => {
    mocks.isElectron.mockReturnValue(true);
    const devices = [{ id: "desktop" }];
    mocks.devicesAPI.list.mockResolvedValue(devices);
    mocks.devicesAPI.getCurrentDeviceId.mockResolvedValue("desktop");
    expect(await auth.getDevices()).toEqual({ devices, currentDeviceId: "desktop" });
    mocks.devicesAPI.getCurrentDeviceId.mockResolvedValue(null);
    expect(await auth.getDevices()).toEqual({ devices, currentDeviceId: "" });
    expect(request).not.toHaveBeenCalled();
  });
});

const nativeCalls = [
  { name: "revokeDevice", run: () => auth.revokeDevice("phone"), bridge: mocks.devicesAPI.revoke, args: ["phone"], result: true },
  { name: "renameDevice", run: () => auth.renameDevice("phone", "Phone"), bridge: mocks.devicesAPI.rename, args: ["phone", "Phone"], result: true },
  { name: "getAccessCode", run: () => auth.getAccessCode(), bridge: mocks.authAPI.getAccessCode, args: [], result: "123456" },
  { name: "getPendingRequests", run: () => auth.getPendingRequests(), bridge: mocks.authAPI.getPendingRequests, args: [], result: [{ id: "r1" }] },
  { name: "approveRequest", run: () => auth.approveRequest("r1"), bridge: mocks.authAPI.approveRequest, args: ["r1"], result: true },
  { name: "denyRequest", run: () => auth.denyRequest("r1"), bridge: mocks.authAPI.denyRequest, args: ["r1"], result: true },
];
for (const { name, run, bridge, args, result } of nativeCalls) {
  describe(`Auth.${name}`, () => {
    it("delegates the native operation with the correct arguments", async () => {
      mocks.isElectron.mockReturnValue(true);
      bridge.mockResolvedValue(result);
      expect(await run()).toEqual(result);
      expect(bridge).toHaveBeenCalledWith(...args);
      expect(request).not.toHaveBeenCalled();
    });
  });
}

describe("Auth.revokeOtherDevices", () => {
  it("requires a current native device and preserves its identity", async () => {
    mocks.isElectron.mockReturnValue(true);
    expect(await auth.revokeOtherDevices()).toEqual({ success: false });
    expect(mocks.devicesAPI.revokeOthers).not.toHaveBeenCalled();
    auth.saveDeviceId("desktop");
    mocks.devicesAPI.revokeOthers.mockResolvedValue({ success: true, revokedCount: 1 });
    expect(await auth.revokeOtherDevices()).toEqual({ success: true, revokedCount: 1 });
    expect(mocks.devicesAPI.revokeOthers).toHaveBeenCalledWith("desktop");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("Auth.isLocalAccess", () => {
  it("caches a confirmed browser classification", async () => {
    request.mockResolvedValueOnce(response({ isLocal: true }));
    expect(await auth.isLocalAccess()).toBe(true);
    expect(await auth.isLocalAccess()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/api/system/is-local");
  });

  it("does not cache transport failures and requires an explicit true value", async () => {
    request.mockRejectedValueOnce(new TypeError("offline"));
    expect(await auth.isLocalAccess()).toBe(false);
    request.mockResolvedValueOnce(response({}, 503));
    expect(await auth.isLocalAccess()).toBe(false);
    request.mockResolvedValueOnce(response({ isLocal: "true" }));
    expect(await auth.isLocalAccess()).toBe(false);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("identifies Electron locally without HTTP", async () => {
    mocks.isElectron.mockReturnValue(true);
    expect(await auth.isLocalAccess()).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});
