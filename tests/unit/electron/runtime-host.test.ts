import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const { mockApp, mockPaths, mockNotification, mockIsSupported, mockShow } = vi.hoisted(() => {
  const mockPaths: Record<string, string> = {};
  const mockApp = {
    isPackaged: false,
    getPath: vi.fn((name: string) => mockPaths[name]),
    getAppPath: vi.fn(() => "/mock/app"),
    setPath: vi.fn(),
  };
  const mockShow = vi.fn();
  const mockIsSupported = vi.fn(() => true);
  const mockNotification = Object.assign(
    vi.fn(function () { return { show: mockShow }; }),
    { isSupported: mockIsSupported },
  );
  return { mockApp, mockPaths, mockNotification, mockIsSupported, mockShow };
});

vi.mock("electron", () => ({ app: mockApp, Notification: mockNotification }));

describe("runtimeHost", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("CODEMUX_DEV_ISOLATED", undefined);
    vi.stubEnv("CODEMUX_DESKTOP_SHELL", undefined);
    mockApp.isPackaged = false;
    mockPaths.userData = "/mock/userData";
    mockPaths.logs = "/mock/logs";
    mockApp.getAppPath.mockReturnValue("/mock/app");
    mockIsSupported.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not read Electron paths before host initialization", async () => {
    await import("../../../electron/main/runtime-host");

    expect(mockApp.getPath).not.toHaveBeenCalled();
    expect(mockApp.getAppPath).not.toHaveBeenCalled();
    expect(mockApp.setPath).not.toHaveBeenCalled();
    expect(mockIsSupported).not.toHaveBeenCalled();
  });

  it("reads the current Electron paths after host initialization changes them", async () => {
    const { runtimeHost } = await import("../../../electron/main/runtime-host");

    expect(runtimeHost.paths.userDataPath).toBe("/mock/userData");
    expect(runtimeHost.paths.logsPath).toBe("/mock/logs");
    expect(runtimeHost.appPath).toBe("/mock/app");
    expect(runtimeHost.resourcesPath).toBe(process.resourcesPath);

    mockPaths.userData = "/isolated/userData";
    mockPaths.logs = "/isolated/logs";
    mockApp.getAppPath.mockReturnValue("/packaged/app.asar");

    expect(runtimeHost.paths.userDataPath).toBe("/isolated/userData");
    expect(runtimeHost.paths.logsPath).toBe("/isolated/logs");
    expect(runtimeHost.appPath).toBe("/packaged/app.asar");
  });

  it("selects asynchronous settings and a separate log file only for the desktop shell", async () => {
    const { runtimeHost } = await import("../../../electron/main/runtime-host");
    const { desktopSettings } = await import("../../../electron/main/desktop-settings");

    expect(runtimeHost.settings).toBeUndefined();
    expect(runtimeHost.logFileName).toBeUndefined();
    vi.stubEnv("CODEMUX_DESKTOP_SHELL", "1");
    expect(runtimeHost.settings).toBe(desktopSettings);
    expect(runtimeHost.logFileName).toBe("desktop.log");
    vi.stubEnv("CODEMUX_DESKTOP_SHELL", "0");
    expect(runtimeHost.settings).toBeUndefined();
    expect(runtimeHost.logFileName).toBeUndefined();
    expect(mockApp.getPath).not.toHaveBeenCalled();
  });

  it.each([
    { packaged: false, isolation: undefined, isolated: false, shared: true },
    { packaged: false, isolation: "0", isolated: false, shared: true },
    { packaged: false, isolation: "true", isolated: false, shared: true },
    { packaged: false, isolation: "1", isolated: true, shared: false },
    { packaged: true, isolation: undefined, isolated: false, shared: false },
    { packaged: true, isolation: "1", isolated: false, shared: false },
  ])("preserves host policy for packaged=$packaged and isolation=$isolation", async ({ packaged, isolation, isolated, shared }) => {
    const { runtimeHost } = await import("../../../electron/main/runtime-host");
    mockApp.isPackaged = packaged;
    vi.stubEnv("CODEMUX_DEV_ISOLATED", isolation);

    expect(runtimeHost.isPackaged).toBe(packaged);
    expect(runtimeHost.isDevIsolated).toBe(isolated);
    expect(runtimeHost.usesSharedDevDeviceStore).toBe(shared);
    expect(runtimeHost.useLibraryDefaultLogPath).toBe(shared);
    expect(runtimeHost.paths.devicesPath).toBe(shared ? path.join(process.cwd(), ".devices.json") : undefined);
  });

  describe("notify", () => {
    it("shows a supported native notification with the supplied content", async () => {
      const { runtimeHost } = await import("../../../electron/main/runtime-host");

      runtimeHost.notify("Access requested", "A device is waiting for approval.");

      expect(mockIsSupported).toHaveBeenCalledOnce();
      expect(mockNotification).toHaveBeenCalledWith({ title: "Access requested", body: "A device is waiting for approval." });
      expect(mockShow).toHaveBeenCalledOnce();
    });

    it("does not construct a notification when the host does not support it", async () => {
      const { runtimeHost } = await import("../../../electron/main/runtime-host");
      mockIsSupported.mockReturnValue(false);

      runtimeHost.notify("Title", "Body");

      expect(mockIsSupported).toHaveBeenCalledOnce();
      expect(mockNotification).not.toHaveBeenCalled();
      expect(mockShow).not.toHaveBeenCalled();
    });

    it.each(["support", "construction", "show"] as const)("propagates native %s errors to the caller", async (stage) => {
      const { runtimeHost } = await import("../../../electron/main/runtime-host");
      const error = new Error(`Notification ${stage} failed`);
      function fail(): never { throw error; }
      if (stage === "support") mockIsSupported.mockImplementationOnce(fail);
      if (stage === "construction") mockNotification.mockImplementationOnce(fail);
      if (stage === "show") mockShow.mockImplementationOnce(fail);

      expect(() => runtimeHost.notify("Title", "Body")).toThrow(error);
    });
  });
});
