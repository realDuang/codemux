/**
 * Unit tests for electron/main/ipc-handlers.ts
 *
 * Strategy: mock all Electron and service dependencies, call registerIpcHandlers(),
 * then extract each registered callback and invoke it directly to cover every branch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RemoteAccessStatus, RemoteAccessUpdate } from "../../../shared/remote-access";

// ─── Hoisted mocks (must be created before any imports) ──────────────────────

const mockHandle = vi.hoisted(() => vi.fn());
const mockIpcOn = vi.hoisted(() => vi.fn());

const mockShellOpenExternal = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockShellOpenPath = vi.hoisted(() => vi.fn().mockResolvedValue(""));
const mockShowOpenDialog = vi.hoisted(() => vi.fn());
const mockStatSync = vi.hoisted(() => vi.fn());
const mockNetworkInterfaces = vi.hoisted(() => vi.fn(() => ({})));

const mockApp = vi.hoisted(() => ({
  getVersion: vi.fn(() => "1.2.3"),
  getPath: vi.fn((key: string) => `/mock/${key}`),
  isPackaged: false,
}));

const mockBrowserWindow = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => []),
  getFocusedWindow: vi.fn(() => null),
}));

const mockDeviceStore = vi.hoisted(() => ({
  generateDeviceId: vi.fn(() => "device-001"),
  generateToken: vi.fn(() => "tok-abc"),
  addDevice: vi.fn(),
  verifyToken: vi.fn(() => true),
  getAccessCode: vi.fn(() => "999888"),
  listPendingRequests: vi.fn(() => []),
  approveRequest: vi.fn(),
  denyRequest: vi.fn(),
  listDevices: vi.fn(() => []),
  getDevice: vi.fn(() => ({ id: "device-001" })),
  updateDevice: vi.fn(),
  removeDevice: vi.fn(() => true),
  revokeAllExcept: vi.fn(() => 2),
}));

const mockTunnelManager = vi.hoisted(() => ({
  getInfo: vi.fn(() => ({ status: "stopped", url: "" })),
}));

const mockRemoteAccessStatus = vi.hoisted((): RemoteAccessStatus => ({
  mode: "off",
  customAccessUrl: "",
  url: "",
  tunnel: { status: "stopped", url: "" },
  tunnelConfig: {},
  cloudflareAvailable: true,
}));

const mockRemoteAccessManager = vi.hoisted(() => ({
  getStatus: vi.fn((): RemoteAccessStatus => mockRemoteAccessStatus),
  update: vi.fn(async (_patch: RemoteAccessUpdate): Promise<RemoteAccessStatus> => mockRemoteAccessStatus),
}));

const mockProductionServer = vi.hoisted(() => ({
  isRunning: vi.fn(() => false),
  getPort: vi.fn(() => 9000),
}));

const mockUpdateManager = vi.hoisted(() => ({
  checkForUpdates: vi.fn().mockResolvedValue({}),
  quitAndInstall: vi.fn(),
  getState: vi.fn(() => ({ status: "idle" })),
  setAutoCheck: vi.fn(),
  isAutoCheckEnabled: vi.fn(() => true),
}));

const mockTrayManager = vi.hoisted(() => ({
  isLaunchAtLoginEnabled: vi.fn(() => false),
  setLaunchAtLogin: vi.fn(),
}));

const mockGetLogFilePath = vi.hoisted(() => vi.fn(() => "/mock/app.log"));
const mockGetFileLogLevel = vi.hoisted(() => vi.fn(() => "info"));
const mockSetFileLogLevel = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn(() => ({})));
const mockSaveSettings = vi.hoisted(() => vi.fn());

const mockIsStartupReady = vi.hoisted(() => vi.fn(() => true));
const mockChannelManager = vi.hoisted(() => ({
  listChannels: vi.fn(() => []),
  getConfig: vi.fn(() => ({ enabled: false })),
  updateConfig: vi.fn().mockResolvedValue(undefined),
  startChannel: vi.fn().mockResolvedValue(undefined),
  stopChannel: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn(() => ({ running: false })),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("electron", () => ({
  ipcMain: { handle: mockHandle, on: mockIpcOn },
  dialog: { showOpenDialog: mockShowOpenDialog },
  shell: { openExternal: mockShellOpenExternal, openPath: mockShellOpenPath },
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
}));

vi.mock("fs", () => ({
  default: { statSync: mockStatSync },
  statSync: mockStatSync,
}));

vi.mock("os", () => ({
  default: { networkInterfaces: mockNetworkInterfaces },
  networkInterfaces: mockNetworkInterfaces,
}));

vi.mock("../../../electron/main/services/device-store", () => ({
  deviceStore: mockDeviceStore,
}));

vi.mock("../../../electron/main/services/tunnel-manager", () => ({
  tunnelManager: mockTunnelManager,
}));

vi.mock("../../../electron/main/services/remote-access-manager", () => ({
  remoteAccessManager: mockRemoteAccessManager,
}));

vi.mock("../../../electron/main/services/production-server", () => ({
  productionServer: mockProductionServer,
}));

vi.mock("../../../electron/main/services/update-manager", () => ({
  updateManager: mockUpdateManager,
}));

vi.mock("../../../electron/main/services/tray-manager", () => ({
  trayManager: mockTrayManager,
}));

vi.mock("../../../electron/main/services/logger", () => ({
  getLogFilePath: mockGetLogFilePath,
  getFileLogLevel: mockGetFileLogLevel,
  setFileLogLevel: mockSetFileLogLevel,
  loadSettings: mockLoadSettings,
  saveSettings: mockSaveSettings,
}));

vi.mock("../../../electron/main/app-main", () => ({
  isStartupReady: mockIsStartupReady,
  channelManager: mockChannelManager,
}));

// ─── Import under test (AFTER all vi.mock calls) ──────────────────────────────

import { registerIpcHandlers } from "../../../electron/main/ipc-handlers";

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** A minimal fake IPC event object */
const fakeEvent = {} as any;

/**
 * Retrieve the async handler registered via ipcMain.handle(channel, handler).
 * Throws if the channel was never registered.
 */
function getHandler(channel: string): (...args: any[]) => any {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No ipcMain.handle for channel: "${channel}"`);
  return call[1];
}

/**
 * Retrieve the synchronous handler registered via ipcMain.on(channel, handler).
 */
function getOnHandler(channel: string): (...args: any[]) => any {
  const call = mockIpcOn.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No ipcMain.on for channel: "${channel}"`);
  return call[1];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("registerIpcHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApp.isPackaged = false;
    mockProductionServer.isRunning.mockReturnValue(false);
    mockRemoteAccessManager.getStatus.mockReturnValue(mockRemoteAccessStatus);
    mockRemoteAccessManager.update.mockResolvedValue(mockRemoteAccessStatus);
    registerIpcHandlers();
  });

  // ===========================================================================
  // System
  // ===========================================================================

  describe("system:getInfo", () => {
    it("returns platform, arch, version, paths and isPackaged", async () => {
      const result = await getHandler("system:getInfo")(fakeEvent);
      expect(result.platform).toBe(process.platform);
      expect(result.arch).toBe(process.arch);
      expect(result.version).toBe("1.2.3");
      expect(result.userDataPath).toBe("/mock/userData");
      expect(result.homePath).toBe("/mock/home");
      expect(result.isPackaged).toBe(false);
    });
  });

  describe("system:getLocalIp", () => {
    it("returns 'localhost' when no interfaces are available", async () => {
      mockNetworkInterfaces.mockReturnValue({});
      const result = await getHandler("system:getLocalIp")(fakeEvent);
      expect(result).toBe("localhost");
    });

    it("returns first non-virtual IPv4 address", async () => {
      mockNetworkInterfaces.mockReturnValue({
        eth0: [{ internal: false, family: "IPv4", address: "192.168.1.100" }],
      });
      const result = await getHandler("system:getLocalIp")(fakeEvent);
      expect(result).toBe("192.168.1.100");
    });

    it("skips internal interfaces", async () => {
      mockNetworkInterfaces.mockReturnValue({
        lo: [{ internal: true, family: "IPv4", address: "127.0.0.1" }],
        eth0: [{ internal: false, family: "IPv4", address: "10.0.0.1" }],
      });
      const result = await getHandler("system:getLocalIp")(fakeEvent);
      expect(result).toBe("10.0.0.1");
    });

    it("skips IPv6 addresses and uses IPv4", async () => {
      mockNetworkInterfaces.mockReturnValue({
        eth0: [
          { internal: false, family: "IPv6", address: "fe80::1" },
          { internal: false, family: "IPv4", address: "192.168.1.50" },
        ],
      });
      const result = await getHandler("system:getLocalIp")(fakeEvent);
      expect(result).toBe("192.168.1.50");
    });

    it("uses virtual interface address as fallback when no real interface exists", async () => {
      mockNetworkInterfaces.mockReturnValue({
        docker0: [{ internal: false, family: "IPv4", address: "172.17.0.1" }],
      });
      const result = await getHandler("system:getLocalIp")(fakeEvent);
      expect(result).toBe("172.17.0.1");
    });

    it("returns 'localhost' when only virtual IPv6 interfaces exist", async () => {
      mockNetworkInterfaces.mockReturnValue({
        docker0: [{ internal: false, family: "IPv6", address: "fe80::2" }],
      });
      const result = await getHandler("system:getLocalIp")(fakeEvent);
      expect(result).toBe("localhost");
    });

    it("skips entries whose nets list is undefined", async () => {
      mockNetworkInterfaces.mockReturnValue({
        missing: undefined,
        eth0: [{ internal: false, family: "IPv4", address: "10.10.10.10" }],
      });
      const result = await getHandler("system:getLocalIp")(fakeEvent);
      expect(result).toBe("10.10.10.10");
    });

    it("prefers real interface over virtual fallback", async () => {
      mockNetworkInterfaces.mockReturnValue({
        docker0: [{ internal: false, family: "IPv4", address: "172.17.0.1" }],
        eth0: [{ internal: false, family: "IPv4", address: "192.168.1.1" }],
      });
      const result = await getHandler("system:getLocalIp")(fakeEvent);
      expect(result).toBe("192.168.1.1");
    });

    it("treats tailscale, wg, tun, utun as virtual", async () => {
      for (const [ifname, addr] of [
        ["tailscale0", "100.64.0.1"],
        ["wg0", "10.6.0.1"],
        ["tun0", "10.8.0.1"],
        ["utun1", "10.9.0.1"],
        ["veth0abc", "172.19.0.2"],
        ["br-abc123", "172.18.0.1"],
      ] as const) {
        mockNetworkInterfaces.mockReturnValue({
          [ifname]: [{ internal: false, family: "IPv4", address: addr }],
        });
        const result = await getHandler("system:getLocalIp")(fakeEvent);
        // Virtual interface used as fallback — should still be returned
        expect(result).toBe(addr);
      }
    });

    it("does not use second virtual address as fallback if first was already set", async () => {
      mockNetworkInterfaces.mockReturnValue({
        docker0: [{ internal: false, family: "IPv4", address: "172.17.0.1" }],
        vmnet1: [{ internal: false, family: "IPv4", address: "192.168.100.1" }],
      });
      const result = await getHandler("system:getLocalIp")(fakeEvent);
      // First virtual address becomes fallback; the second is not stored
      expect(result).toBe("172.17.0.1");
    });
  });

  describe("system:openExternal", () => {
    it("opens http:// URLs via shell.openExternal", async () => {
      await getHandler("system:openExternal")(fakeEvent, "http://example.com");
      expect(mockShellOpenExternal).toHaveBeenCalledWith("http://example.com");
    });

    it("opens https:// URLs via shell.openExternal", async () => {
      await getHandler("system:openExternal")(fakeEvent, "https://example.com/path");
      expect(mockShellOpenExternal).toHaveBeenCalledWith("https://example.com/path");
    });

    it("throws 'Invalid URL' for non-http/https protocols like file://", async () => {
      await expect(
        getHandler("system:openExternal")(fakeEvent, "file:///etc/passwd"),
      ).rejects.toThrow("Invalid URL");
    });

    it("throws 'Invalid URL' for completely invalid URL strings", async () => {
      await expect(
        getHandler("system:openExternal")(fakeEvent, "not-a-url"),
      ).rejects.toThrow("Invalid URL");
    });

    it("throws 'Invalid URL' for ftp:// protocol", async () => {
      await expect(
        getHandler("system:openExternal")(fakeEvent, "ftp://files.example.com"),
      ).rejects.toThrow("Invalid URL");
    });
  });

  describe("system:selectDirectory", () => {
    it("returns null when the dialog is canceled", async () => {
      mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
      const result = await getHandler("system:selectDirectory")(fakeEvent);
      expect(result).toBeNull();
    });

    it("returns the selected directory path when not canceled", async () => {
      mockShowOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ["/selected/directory"],
      });
      const result = await getHandler("system:selectDirectory")(fakeEvent);
      expect(result).toBe("/selected/directory");
    });
  });

  describe("system:openPath", () => {
    it("opens the path when it is a directory", async () => {
      mockStatSync.mockReturnValue({ isDirectory: () => true });
      mockShellOpenPath.mockResolvedValue("");
      const result = await getHandler("system:openPath")(fakeEvent, "/some/dir");
      expect(mockShellOpenPath).toHaveBeenCalledWith("/some/dir");
      expect(result).toBe("");
    });

    it("throws when path is not a directory", async () => {
      mockStatSync.mockReturnValue({ isDirectory: () => false });
      await expect(
        getHandler("system:openPath")(fakeEvent, "/some/file.txt"),
      ).rejects.toThrow("Path is not a directory");
    });
  });

  // ===========================================================================
  // Authentication
  // ===========================================================================

  describe("auth:localAuth", () => {
    it("uses name and platform from deviceInfo when provided", async () => {
      const result = await getHandler("auth:localAuth")(fakeEvent, {
        name: "My Laptop",
        platform: "darwin",
      });
      expect(mockDeviceStore.addDevice).toHaveBeenCalledWith(
        expect.objectContaining({ name: "My Laptop", platform: "darwin" }),
      );
      expect(result.success).toBe(true);
      expect(result.token).toBe("tok-abc");
    });

    it("defaults name to 'Local Machine' when deviceInfo.name is missing", async () => {
      await getHandler("auth:localAuth")(fakeEvent, {});
      expect(mockDeviceStore.addDevice).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Local Machine" }),
      );
    });

    it("defaults platform to process.platform when deviceInfo.platform is missing", async () => {
      await getHandler("auth:localAuth")(fakeEvent, {});
      expect(mockDeviceStore.addDevice).toHaveBeenCalledWith(
        expect.objectContaining({ platform: process.platform }),
      );
    });

    it("handles null deviceInfo — uses all defaults", async () => {
      const result = await getHandler("auth:localAuth")(fakeEvent, null);
      expect(result.success).toBe(true);
      expect(mockDeviceStore.addDevice).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Local Machine", platform: process.platform }),
      );
    });

    it("sets isHost to true and browser to 'Electron'", async () => {
      await getHandler("auth:localAuth")(fakeEvent, null);
      expect(mockDeviceStore.addDevice).toHaveBeenCalledWith(
        expect.objectContaining({ isHost: true, browser: "Electron" }),
      );
    });
  });

  describe("auth:validateToken", () => {
    it("delegates to deviceStore.verifyToken", async () => {
      mockDeviceStore.verifyToken.mockReturnValue(true);
      const result = await getHandler("auth:validateToken")(fakeEvent, "some-token");
      expect(mockDeviceStore.verifyToken).toHaveBeenCalledWith("some-token");
      expect(result).toBe(true);
    });
  });

  describe("auth:getAccessCode", () => {
    it("returns the access code from deviceStore", async () => {
      const result = await getHandler("auth:getAccessCode")(fakeEvent);
      expect(result).toBe("999888");
    });
  });

  describe("auth:getPendingRequests", () => {
    it("returns list of pending requests", async () => {
      mockDeviceStore.listPendingRequests.mockReturnValue([{ id: "r1" }]);
      const result = await getHandler("auth:getPendingRequests")(fakeEvent);
      expect(result).toEqual([{ id: "r1" }]);
    });
  });

  describe("auth:approveRequest", () => {
    it("returns true when approveRequest returns a value", async () => {
      mockDeviceStore.approveRequest.mockReturnValue({ id: "req-1" });
      const result = await getHandler("auth:approveRequest")(fakeEvent, "req-1");
      expect(result).toBe(true);
    });

    it("returns false when approveRequest returns undefined", async () => {
      mockDeviceStore.approveRequest.mockReturnValue(undefined);
      const result = await getHandler("auth:approveRequest")(fakeEvent, "missing");
      expect(result).toBe(false);
    });
  });

  describe("auth:denyRequest", () => {
    it("returns true when denyRequest returns a value", async () => {
      mockDeviceStore.denyRequest.mockReturnValue({ id: "req-1" });
      const result = await getHandler("auth:denyRequest")(fakeEvent, "req-1");
      expect(result).toBe(true);
    });

    it("returns false when denyRequest returns undefined", async () => {
      mockDeviceStore.denyRequest.mockReturnValue(undefined);
      const result = await getHandler("auth:denyRequest")(fakeEvent, "missing");
      expect(result).toBe(false);
    });
  });

  // ===========================================================================
  // Device Management
  // ===========================================================================

  describe("devices:list", () => {
    it("returns all devices from deviceStore", async () => {
      mockDeviceStore.listDevices.mockReturnValue([{ id: "d-1" }]);
      const result = await getHandler("devices:list")(fakeEvent);
      expect(result).toEqual([{ id: "d-1" }]);
    });
  });

  describe("devices:get", () => {
    it("returns a specific device by id", async () => {
      const result = await getHandler("devices:get")(fakeEvent, "device-001");
      expect(mockDeviceStore.getDevice).toHaveBeenCalledWith("device-001");
      expect(result).toEqual({ id: "device-001" });
    });
  });

  describe("devices:update", () => {
    it("calls updateDevice and returns success", async () => {
      const result = await getHandler("devices:update")(fakeEvent, "d-1", { name: "New" });
      expect(mockDeviceStore.updateDevice).toHaveBeenCalledWith("d-1", { name: "New" });
      expect(result).toEqual({ success: true });
    });
  });

  describe("devices:revoke", () => {
    it("calls removeDevice and returns its result", async () => {
      const result = await getHandler("devices:revoke")(fakeEvent, "d-1");
      expect(mockDeviceStore.removeDevice).toHaveBeenCalledWith("d-1");
      expect(result).toBe(true);
    });
  });

  describe("devices:rename", () => {
    it("calls updateDevice with new name and returns true", async () => {
      const result = await getHandler("devices:rename")(fakeEvent, "d-1", "Renamed");
      expect(mockDeviceStore.updateDevice).toHaveBeenCalledWith("d-1", { name: "Renamed" });
      expect(result).toBe(true);
    });
  });

  describe("devices:getCurrentDeviceId", () => {
    it("returns the host device id when a host device exists", async () => {
      mockDeviceStore.listDevices.mockReturnValue([
        { id: "d-1", isHost: false },
        { id: "d-2", isHost: true },
      ]);
      const result = await getHandler("devices:getCurrentDeviceId")(fakeEvent);
      expect(result).toBe("d-2");
    });

    it("returns null when no host device exists", async () => {
      mockDeviceStore.listDevices.mockReturnValue([{ id: "d-1", isHost: false }]);
      const result = await getHandler("devices:getCurrentDeviceId")(fakeEvent);
      expect(result).toBeNull();
    });

    it("returns null when devices list is empty", async () => {
      mockDeviceStore.listDevices.mockReturnValue([]);
      const result = await getHandler("devices:getCurrentDeviceId")(fakeEvent);
      expect(result).toBeNull();
    });
  });

  describe("devices:revokeOthers", () => {
    it("revokes all except current and returns count", async () => {
      const result = await getHandler("devices:revokeOthers")(fakeEvent, "d-current");
      expect(mockDeviceStore.revokeAllExcept).toHaveBeenCalledWith("d-current");
      expect(result).toEqual({ success: true, revokedCount: 2 });
    });
  });

  // ===========================================================================
  // Tunnel Management
  // ===========================================================================

  describe("tunnel:start", () => {
    it("activates Cloudflare through the authoritative manager and returns its tunnel status", async () => {
      const tunnel = { status: "running" as const, url: "https://codemux.example" };
      mockRemoteAccessManager.update.mockResolvedValueOnce({ ...mockRemoteAccessStatus, mode: "cloudflare", url: tunnel.url, tunnel });
      const result = await getHandler("tunnel:start")(fakeEvent, 3000);
      expect(mockRemoteAccessManager.update).toHaveBeenCalledWith({ mode: "cloudflare" });
      expect(mockLoadSettings).not.toHaveBeenCalled();
      expect(result).toEqual(tunnel);
    });

    it("passes explicit hostname configuration with the mode change", async () => {
      await getHandler("tunnel:start")(fakeEvent, 3000, { hostname: "custom.host.com" });
      expect(mockRemoteAccessManager.update).toHaveBeenCalledWith({ mode: "cloudflare", tunnelConfig: { hostname: "custom.host.com" } });
    });

    it("preserves an explicit empty configuration to reset a saved hostname", async () => {
      await getHandler("tunnel:start")(fakeEvent, 3000, {});
      expect(mockRemoteAccessManager.update).toHaveBeenCalledWith({ mode: "cloudflare", tunnelConfig: {} });
    });

    it("propagates a failed transition without reporting a successful tunnel", async () => {
      mockRemoteAccessManager.update.mockRejectedValueOnce(new Error("Tunnel failed to start"));
      await expect(getHandler("tunnel:start")(fakeEvent, 3000)).rejects.toThrow("Tunnel failed to start");
    });
  });

  describe("tunnel:stop", () => {
    it("disables the active Cloudflare mode through the manager", async () => {
      mockRemoteAccessManager.getStatus.mockReturnValueOnce({ ...mockRemoteAccessStatus, mode: "cloudflare" });
      await getHandler("tunnel:stop")(fakeEvent);
      expect(mockRemoteAccessManager.update).toHaveBeenCalledWith({ mode: "off" });
    });

    it.each(["off", "custom"] as const)("preserves the %s access mode when a legacy stop is requested", async mode => {
      mockRemoteAccessManager.getStatus.mockReturnValueOnce({ ...mockRemoteAccessStatus, mode });
      await getHandler("tunnel:stop")(fakeEvent);
      expect(mockRemoteAccessManager.update).not.toHaveBeenCalled();
    });
  });

  describe("tunnel:getStatus", () => {
    it("returns tunnel info from tunnelManager", async () => {
      mockTunnelManager.getInfo.mockReturnValue({ status: "running", url: "https://x.io" });
      const result = await getHandler("tunnel:getStatus")(fakeEvent);
      expect(result).toEqual({ status: "running", url: "https://x.io" });
    });
  });

  describe("remoteAccess:getStatus", () => {
    it("returns the authoritative access status", async () => {
      const status = { ...mockRemoteAccessStatus, mode: "custom" as const, customAccessUrl: "http://192.168.31.123:18233", url: "http://192.168.31.123:18233" };
      mockRemoteAccessManager.getStatus.mockReturnValueOnce(status);
      expect(await getHandler("remoteAccess:getStatus")(fakeEvent)).toEqual(status);
    });
  });

  describe("remoteAccess:update", () => {
    it("applies an access patch through the manager and returns the resulting status", async () => {
      const patch = { mode: "custom" as const, customAccessUrl: "http://192.168.31.123:18233" };
      const status = { ...mockRemoteAccessStatus, ...patch, url: patch.customAccessUrl };
      mockRemoteAccessManager.update.mockResolvedValueOnce(status);
      expect(await getHandler("remoteAccess:update")(fakeEvent, patch)).toEqual(status);
      expect(mockRemoteAccessManager.update).toHaveBeenCalledWith(patch);
      expect(mockSaveSettings).not.toHaveBeenCalled();
    });

    it("propagates rejected patches without a settings write", async () => {
      mockRemoteAccessManager.update.mockRejectedValueOnce(new Error("Invalid access URL"));
      await expect(getHandler("remoteAccess:update")(fakeEvent, { mode: "custom", customAccessUrl: "invalid" })).rejects.toThrow("Invalid access URL");
      expect(mockSaveSettings).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Production Server
  // ===========================================================================

  describe("server:getPort", () => {
    it("returns the production server port", async () => {
      mockProductionServer.getPort.mockReturnValue(8233);
      const result = await getHandler("server:getPort")(fakeEvent);
      expect(result).toBe(8233);
    });
  });

  describe("server:isRunning", () => {
    it("returns true when production server is running", async () => {
      mockProductionServer.isRunning.mockReturnValue(true);
      const result = await getHandler("server:isRunning")(fakeEvent);
      expect(result).toBe(true);
    });

    it("returns false when production server is not running", async () => {
      mockProductionServer.isRunning.mockReturnValue(false);
      const result = await getHandler("server:isRunning")(fakeEvent);
      expect(result).toBe(false);
    });
  });

  // ===========================================================================
  // Gateway
  // ===========================================================================

  describe("gateway:getPort", () => {
    it("returns dev gateway ws URL when NOT packaged", async () => {
      mockApp.isPackaged = false;
      const result = await getHandler("gateway:getPort")(fakeEvent);
      expect(result).toBe("ws://127.0.0.1:4200");
    });

    it("returns production ws URL when packaged AND production server running", async () => {
      mockApp.isPackaged = true;
      mockProductionServer.isRunning.mockReturnValue(true);
      mockProductionServer.getPort.mockReturnValue(9000);
      const result = await getHandler("gateway:getPort")(fakeEvent);
      expect(result).toBe("ws://127.0.0.1:9000/ws");
    });

    it("returns dev gateway ws URL when packaged but production server NOT running", async () => {
      mockApp.isPackaged = true;
      mockProductionServer.isRunning.mockReturnValue(false);
      const result = await getHandler("gateway:getPort")(fakeEvent);
      expect(result).toBe("ws://127.0.0.1:4200");
    });
  });

  // ===========================================================================
  // Logging
  // ===========================================================================

  describe("log:getPath", () => {
    it("returns the log file path", async () => {
      const result = await getHandler("log:getPath")(fakeEvent);
      expect(result).toBe("/mock/app.log");
    });
  });

  describe("log:getLevel", () => {
    it("returns the current file log level", async () => {
      mockGetFileLogLevel.mockReturnValue("debug");
      const result = await getHandler("log:getLevel")(fakeEvent);
      expect(result).toBe("debug");
    });
  });

  describe("log:setLevel", () => {
    it("calls setFileLogLevel with the given level and returns success", async () => {
      const result = await getHandler("log:setLevel")(fakeEvent, "warn");
      expect(mockSetFileLogLevel).toHaveBeenCalledWith("warn");
      expect(result).toEqual({ success: true });
    });
  });

  // ===========================================================================
  // Channels
  // ===========================================================================

  describe("channel:list", () => {
    it("returns channel list from channelManager", async () => {
      mockChannelManager.listChannels.mockReturnValue([{ type: "feishu" }]);
      const result = await getHandler("channel:list")(fakeEvent);
      expect(result).toEqual([{ type: "feishu" }]);
    });
  });

  describe("channel:getConfig", () => {
    it("returns config for the given channel type", async () => {
      mockChannelManager.getConfig.mockReturnValue({ enabled: true });
      const result = await getHandler("channel:getConfig")(fakeEvent, "feishu");
      expect(mockChannelManager.getConfig).toHaveBeenCalledWith("feishu");
      expect(result).toEqual({ enabled: true });
    });
  });

  describe("channel:updateConfig", () => {
    it("calls updateConfig and returns success", async () => {
      const result = await getHandler("channel:updateConfig")(fakeEvent, "feishu", { token: "abc" });
      expect(mockChannelManager.updateConfig).toHaveBeenCalledWith("feishu", { token: "abc" });
      expect(result).toEqual({ success: true });
    });
  });

  describe("channel:start", () => {
    it("starts the channel and returns success", async () => {
      const result = await getHandler("channel:start")(fakeEvent, "feishu");
      expect(mockChannelManager.startChannel).toHaveBeenCalledWith("feishu");
      expect(result).toEqual({ success: true });
    });
  });

  describe("channel:stop", () => {
    it("stops the channel and returns success", async () => {
      const result = await getHandler("channel:stop")(fakeEvent, "telegram");
      expect(mockChannelManager.stopChannel).toHaveBeenCalledWith("telegram");
      expect(result).toEqual({ success: true });
    });
  });

  describe("channel:getStatus", () => {
    it("returns channel status from channelManager", async () => {
      mockChannelManager.getStatus.mockReturnValue({ running: true });
      const result = await getHandler("channel:getStatus")(fakeEvent, "feishu");
      expect(mockChannelManager.getStatus).toHaveBeenCalledWith("feishu");
      expect(result).toEqual({ running: true });
    });
  });

  // ===========================================================================
  // Settings
  // ===========================================================================

  describe("settings:loadSync", () => {
    it("sets event.returnValue to the loaded settings", () => {
      const settings = { theme: "dark", language: "en" };
      mockLoadSettings.mockReturnValue(settings);
      const syncEvent = { returnValue: undefined as any };
      getOnHandler("settings:loadSync")(syncEvent);
      expect(syncEvent.returnValue).toEqual(settings);
    });
  });

  describe("settings:load", () => {
    it("returns settings via async handler", async () => {
      mockLoadSettings.mockReturnValue({ fontSize: 14 });
      const result = await getHandler("settings:load")(fakeEvent);
      expect(result).toEqual({ fontSize: 14 });
    });
  });

  describe("settings:save", () => {
    it("saves settings patch and returns success", async () => {
      const result = await getHandler("settings:save")(fakeEvent, { theme: "light" });
      expect(mockSaveSettings).toHaveBeenCalledWith({ theme: "light" });
      expect(result).toEqual({ success: true });
    });

    it.each([
      { remoteAccessMode: "custom" },
      { customAccessUrl: "http://192.168.31.123:18233" },
      { tunnelConfig: { hostname: "custom.host.com" } },
      { theme: "dark", remoteAccessMode: "off" },
    ])("rejects connection settings outside the access controls: %j", async patch => {
      await expect(getHandler("settings:save")(fakeEvent, patch)).rejects.toThrow("Use remote access controls to change connection settings.");
      expect(mockSaveSettings).not.toHaveBeenCalled();
      expect(mockRemoteAccessManager.update).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Auto Update
  // ===========================================================================

  describe("update:checkForUpdates", () => {
    it("delegates to updateManager.checkForUpdates", async () => {
      mockUpdateManager.checkForUpdates.mockResolvedValue({ updateAvailable: true });
      const result = await getHandler("update:checkForUpdates")(fakeEvent);
      expect(result).toEqual({ updateAvailable: true });
    });
  });

  describe("update:quitAndInstall", () => {
    it("calls updateManager.quitAndInstall", async () => {
      await getHandler("update:quitAndInstall")(fakeEvent);
      expect(mockUpdateManager.quitAndInstall).toHaveBeenCalled();
    });
  });

  describe("update:getStatus", () => {
    it("returns the update manager state", async () => {
      mockUpdateManager.getState.mockReturnValue({ status: "downloaded" });
      const result = await getHandler("update:getStatus")(fakeEvent);
      expect(result).toEqual({ status: "downloaded" });
    });
  });

  describe("update:setAutoCheck", () => {
    it("enables auto-check and returns success", async () => {
      const result = await getHandler("update:setAutoCheck")(fakeEvent, true);
      expect(mockUpdateManager.setAutoCheck).toHaveBeenCalledWith(true);
      expect(result).toEqual({ success: true });
    });

    it("disables auto-check and returns success", async () => {
      const result = await getHandler("update:setAutoCheck")(fakeEvent, false);
      expect(mockUpdateManager.setAutoCheck).toHaveBeenCalledWith(false);
      expect(result).toEqual({ success: true });
    });
  });

  describe("update:isAutoCheckEnabled", () => {
    it("returns true when auto-check is enabled", async () => {
      mockUpdateManager.isAutoCheckEnabled.mockReturnValue(true);
      const result = await getHandler("update:isAutoCheckEnabled")(fakeEvent);
      expect(result).toBe(true);
    });

    it("returns false when auto-check is disabled", async () => {
      mockUpdateManager.isAutoCheckEnabled.mockReturnValue(false);
      const result = await getHandler("update:isAutoCheckEnabled")(fakeEvent);
      expect(result).toBe(false);
    });
  });

  // ===========================================================================
  // Launch at Login
  // ===========================================================================

  describe("autostart:isEnabled", () => {
    it("returns true when launch at login is enabled", async () => {
      mockTrayManager.isLaunchAtLoginEnabled.mockReturnValue(true);
      const result = await getHandler("autostart:isEnabled")(fakeEvent);
      expect(result).toBe(true);
    });

    it("returns false when launch at login is disabled", async () => {
      mockTrayManager.isLaunchAtLoginEnabled.mockReturnValue(false);
      const result = await getHandler("autostart:isEnabled")(fakeEvent);
      expect(result).toBe(false);
    });
  });

  describe("autostart:setEnabled", () => {
    it("enables launch at login and returns success", async () => {
      const result = await getHandler("autostart:setEnabled")(fakeEvent, true);
      expect(mockTrayManager.setLaunchAtLogin).toHaveBeenCalledWith(true);
      expect(result).toEqual({ success: true });
    });

    it("disables launch at login and returns success", async () => {
      const result = await getHandler("autostart:setEnabled")(fakeEvent, false);
      expect(mockTrayManager.setLaunchAtLogin).toHaveBeenCalledWith(false);
      expect(result).toEqual({ success: true });
    });
  });

  // ===========================================================================
  // Titlebar overlay (win32-specific)
  // ===========================================================================

  describe("update-title-bar-overlay", () => {
    let originalPlatform: string;

    beforeEach(() => {
      originalPlatform = process.platform;
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    });

    it("does nothing on non-win32 platforms (e.g. darwin)", async () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      const mockWin = { setTitleBarOverlay: vi.fn() };
      mockBrowserWindow.getFocusedWindow.mockReturnValue(mockWin);

      await getHandler("update-title-bar-overlay")(fakeEvent, { color: "#fff", symbolColor: "#000" });

      expect(mockWin.setTitleBarOverlay).not.toHaveBeenCalled();
    });

    it("sets title bar overlay using focused window on win32", async () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const mockWin = { setTitleBarOverlay: vi.fn() };
      mockBrowserWindow.getFocusedWindow.mockReturnValue(mockWin);

      await getHandler("update-title-bar-overlay")(fakeEvent, { color: "#1a1a1a", symbolColor: "#ffffff" });

      expect(mockWin.setTitleBarOverlay).toHaveBeenCalledWith({
        color: "#1a1a1a",
        symbolColor: "#ffffff",
        height: 40,
      });
    });

    it("falls back to getAllWindows()[0] when no focused window on win32", async () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const mockWin = { setTitleBarOverlay: vi.fn() };
      mockBrowserWindow.getFocusedWindow.mockReturnValue(null);
      mockBrowserWindow.getAllWindows.mockReturnValue([mockWin]);

      await getHandler("update-title-bar-overlay")(fakeEvent, { color: "#aaa", symbolColor: "#bbb" });

      expect(mockWin.setTitleBarOverlay).toHaveBeenCalled();
    });

    it("does nothing when no windows exist at all on win32", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      mockBrowserWindow.getFocusedWindow.mockReturnValue(null);
      mockBrowserWindow.getAllWindows.mockReturnValue([]);

      expect(() =>
        getHandler("update-title-bar-overlay")(fakeEvent, { color: "#fff", symbolColor: "#000" }),
      ).not.toThrow();
    });

    it("silently swallows errors thrown by setTitleBarOverlay on win32", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const mockWin = {
        setTitleBarOverlay: vi.fn(() => {
          throw new Error("setTitleBarOverlay not supported");
        }),
      };
      mockBrowserWindow.getFocusedWindow.mockReturnValue(mockWin);

      expect(() =>
        getHandler("update-title-bar-overlay")(fakeEvent, { color: "#fff", symbolColor: "#000" }),
      ).not.toThrow();
    });
  });

  // ===========================================================================
  // Startup
  // ===========================================================================

  describe("startup:isReady", () => {
    it("returns true when startup is complete", async () => {
      mockIsStartupReady.mockReturnValue(true);
      const result = await getHandler("startup:isReady")(fakeEvent);
      expect(result).toBe(true);
    });

    it("returns false when startup is still pending", async () => {
      mockIsStartupReady.mockReturnValue(false);
      const result = await getHandler("startup:isReady")(fakeEvent);
      expect(result).toBe(false);
    });
  });
});
