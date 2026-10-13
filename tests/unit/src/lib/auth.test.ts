import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isElectron: vi.fn<() => boolean>(),
  validateToken: vi.fn(),
}));

vi.mock("../../../../src/lib/platform", () => ({ isElectron: mocks.isElectron }));
vi.mock("../../../../src/lib/electron-api", () => ({ authAPI: { validateToken: mocks.validateToken } }));
vi.mock("../../../../src/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { Auth } from "../../../../src/lib/auth";

describe("Auth.checkDeviceToken", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isElectron.mockReturnValue(false);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal("fetch", fetchMock);
    Auth.saveToken("device-token");
    Auth.saveDeviceId("approved-device");
  });

  afterEach(() => vi.unstubAllGlobals());

  function validationResponse(status: number, body: unknown = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  it("returns false without making a validation request when there is no token", async () => {
    Auth.clearAuth();
    expect(await Auth.checkDeviceToken()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the saved browser token and refreshes the device ID after successful validation", async () => {
    fetchMock.mockResolvedValueOnce(validationResponse(200, { valid: true, deviceId: "confirmed-device" }));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/validate", { headers: { Authorization: "Bearer device-token" } });
    expect(Auth.getToken()).toBe("device-token");
    expect(Auth.getDeviceId()).toBe("confirmed-device");
  });

  it.each([
    [401, { error: "Unauthorized" }],
    [200, { valid: false }],
  ])("clears device approval only after confirmed rejection (%i)", async (status, body) => {
    fetchMock.mockResolvedValueOnce(validationResponse(status as number, body));
    expect(await Auth.checkDeviceToken()).toBe(false);
    expect(Auth.getToken()).toBeNull();
    expect(Auth.getDeviceId()).toBeNull();
  });

  it.each([403, 429, 500, 502, 503])("preserves device approval when validation is unavailable (%i)", async status => {
    fetchMock.mockResolvedValueOnce(validationResponse(status, { valid: false, error: "Access unavailable" }));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(Auth.getToken()).toBe("device-token");
    expect(Auth.getDeviceId()).toBe("approved-device");
  });

  it("validates the same approved device after remote access is enabled again", async () => {
    fetchMock.mockResolvedValueOnce(validationResponse(403, { error: "Remote access disabled" }));
    fetchMock.mockResolvedValueOnce(validationResponse(200, { valid: true, deviceId: "approved-device" }));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(fetchMock.mock.calls.map(([, init]) => init?.headers)).toEqual([
      { Authorization: "Bearer device-token" },
      { Authorization: "Bearer device-token" },
    ]);
    expect(Auth.getDeviceId()).toBe("approved-device");
  });

  it("preserves device approval when the network fails", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(Auth.getToken()).toBe("device-token");
    expect(Auth.getDeviceId()).toBe("approved-device");
  });

  it("preserves device approval when a successful response does not establish validity", async () => {
    fetchMock.mockResolvedValueOnce(validationResponse(200));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(Auth.getToken()).toBe("device-token");
    expect(Auth.getDeviceId()).toBe("approved-device");
  });

  it("preserves device approval when a server response is unreadable", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>Unavailable</html>", { status: 200 }));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(Auth.getToken()).toBe("device-token");
    expect(Auth.getDeviceId()).toBe("approved-device");
  });

  it("clears a device explicitly revoked through Electron IPC", async () => {
    mocks.isElectron.mockReturnValue(true);
    mocks.validateToken.mockResolvedValueOnce({ valid: false });
    expect(await Auth.checkDeviceToken()).toBe(false);
    expect(mocks.validateToken).toHaveBeenCalledWith("device-token");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Auth.getToken()).toBeNull();
    expect(Auth.getDeviceId()).toBeNull();
  });
});
