import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceStoreBase } from "../../../shared/device-store-base";
import type { DeviceInfo } from "../../../shared/device-store-types";
import { HostManagementController, HOST_MANAGEMENT_METHODS, type HostManagementDependencies } from "../../../shared/host-management";
import { createSettingsStore } from "../../../shared/settings-store";
import type { RemoteAccessStatus } from "../../../shared/remote-access";

vi.mock("electron", () => { throw new Error("Host management cannot load Electron"); });
vi.mock("../../../electron/main/channels/channel-manager", () => { throw new Error("Host management cannot create a channel manager"); });
vi.mock("../../../electron/main/channels/weixin-ilink/weixin-ilink-qr-flow", () => { throw new Error("Host management cannot initialize QR transport"); });

class TestDeviceStore extends DeviceStoreBase {
  constructor(private readonly filePath: string) {
    super();
    this.loadData();
  }

  protected getFilePath(): string { return this.filePath; }
}

let directory: string;
let deviceStore: TestDeviceStore;
let dependencies: HostManagementDependencies;
let controller: HostManagementController;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "codemux-host-management-"));
  deviceStore = new TestDeviceStore(path.join(directory, "devices.json"));
  const settings = createSettingsStore({ getFilePath: () => path.join(directory, "settings.json") });
  const status: RemoteAccessStatus = {
    mode: "off", customAccessUrl: "", url: "", tunnel: { status: "stopped", url: "" },
    tunnelConfig: {}, cloudflareAvailable: true,
  };
  dependencies = {
    getSystemInfo: () => ({
      platform: "linux", arch: "arm64", version: "1.2.3", userDataPath: directory,
      homePath: "/home/codemux", isPackaged: false,
    }),
    getNetworkInterfaces: () => ({}),
    getGatewayUrl: () => "ws://127.0.0.1:8233/ws",
    deviceStore,
    tunnelManager: { getInfo: () => status.tunnel },
    remoteAccessManager: {
      getStatus: vi.fn(() => status),
      update: vi.fn(async patch => ({ ...status, ...patch })),
    },
    productionServer: { getPort: vi.fn(() => 8233), isRunning: vi.fn(() => false) },
    logging: { getPath: () => path.join(directory, "app.log"), getLevel: () => "warn", setLevel: vi.fn() },
    settings: { load: settings.loadSettings, save: settings.saveSettings },
    channelManager: {
      listChannels: vi.fn(() => []), getConfig: vi.fn(), getStatus: vi.fn(),
      updateConfig: vi.fn(async () => {}), startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}), logoutChannel: vi.fn(async () => {}),
    },
    ilink: {
      getQrCode: vi.fn(async baseUrl => ({ qrcode: "qr-id", qrcodeImgContent: "data:image/png;base64,test", baseUrl: baseUrl ?? "https://ilink.example" })),
      pollQrStatus: vi.fn(async () => ({ status: "confirmed", botToken: "test-token", accountId: "test-account" })),
    },
    isStartupReady: vi.fn(() => true),
  };
  controller = new HostManagementController(dependencies);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("HostManagementController", () => {
  describe("invoke", () => {
    it("creates a durable local identity and returns the unchanged token validation shape", async () => {
      const result = await controller.invoke("auth:localAuth") as { success: boolean; token: string; deviceId: string; device: DeviceInfo };
      expect(result).toMatchObject({ success: true, device: { name: "Local Machine", platform: "linux", browser: "Electron", ip: "localhost", isHost: true } });
      expect(result.device.createdAt).toBeTypeOf("number");
      expect(await controller.invoke("auth:validateToken", [result.token])).toEqual({ valid: true, deviceId: result.deviceId });
      const reopened = new TestDeviceStore(path.join(directory, "devices.json"));
      expect(reopened.verifyToken(result.token)).toEqual({ valid: true, deviceId: result.deviceId });
      expect(await controller.invoke("devices:getCurrentDeviceId")).toBe(result.deviceId);
    });

    it("retains explicit local device labels and forwards update and revoke return values", async () => {
      const result = await controller.invoke("auth:localAuth", [{ name: "My host", platform: "custom" }]) as { token: string; deviceId: string; device: DeviceInfo };
      expect(result.device).toMatchObject({ name: "My host", platform: "custom", browser: "Electron" });
      expect(await controller.invoke("devices:rename", [result.deviceId, "Renamed"])).toBe(true);
      expect(await controller.invoke("devices:update", [result.deviceId, { ip: "127.0.0.1" }])).toEqual({ success: true });
      expect(await controller.invoke("devices:get", [result.deviceId])).toMatchObject({ name: "Renamed", ip: "127.0.0.1" });
      expect(await controller.invoke("devices:revoke", [result.deviceId])).toBe(true);
      expect(await controller.invoke("devices:revoke", [result.deviceId])).toBe(false);
      expect(await controller.invoke("devices:get", [result.deviceId])).toBeUndefined();
      expect(await controller.invoke("devices:getCurrentDeviceId")).toBeNull();
      expect(await controller.invoke("auth:validateToken", [result.token])).toEqual({ valid: false });
    });

    it("approves and denies existing requests using boolean responses and the same device store", async () => {
      const approved = deviceStore.createPendingRequest({ name: "Phone", platform: "iOS", browser: "Safari" }, "192.0.2.1");
      const denied = deviceStore.createPendingRequest({ name: "Other", platform: "Android", browser: "Chrome" }, "192.0.2.2");
      expect(await controller.invoke("auth:getPendingRequests")).toHaveLength(2);
      expect(await controller.invoke("auth:approveRequest", [approved.id])).toBe(true);
      expect(await controller.invoke("auth:approveRequest", [approved.id])).toBe(false);
      expect(await controller.invoke("auth:denyRequest", [denied.id])).toBe(true);
      expect(await controller.invoke("auth:denyRequest", ["missing"])).toBe(false);
      expect(await controller.invoke("auth:getPendingRequests")).toEqual([]);
      expect(await controller.invoke("devices:list")).toMatchObject([{ name: "Phone", browser: "Safari" }]);
      expect(await controller.invoke("auth:getAccessCode")).toBe(deviceStore.getAccessCode());
    });

    it("revokes other devices and preserves the count response", async () => {
      const first = await controller.invoke("auth:localAuth") as { deviceId: string };
      await controller.invoke("auth:localAuth");
      expect(await controller.invoke("devices:revokeOthers", [first.deviceId])).toEqual({ success: true, revokedCount: 1 });
      expect(await controller.invoke("devices:revokeOthers", [first.deviceId])).toEqual({ success: true, revokedCount: 0 });
    });

    it("uses the host's gateway URL independently of packaging and separates HTTP availability from startup readiness", async () => {
      expect(await controller.invoke("system:getInfo")).toMatchObject({ platform: "linux", isPackaged: false });
      expect(await controller.invoke("gateway:getPort")).toBe("ws://127.0.0.1:8233/ws");
      expect(await controller.invoke("server:getPort")).toBe(8233);
      expect(await controller.invoke("server:isRunning")).toBe(false);
      expect(await controller.invoke("startup:isReady")).toBe(true);
    });

    it("preserves interface priority and reads the current host interfaces on each call", async () => {
      dependencies.getNetworkInterfaces = () => ({
        utun0: [{ internal: false, family: "IPv4", address: "100.64.0.1" }],
        eth0: [{ internal: false, family: "IPv4", address: "192.0.2.3" }],
      });
      expect(await controller.invoke("system:getLocalIp")).toBe("192.0.2.3");
      dependencies.getNetworkInterfaces = () => ({});
      expect(await controller.invoke("system:getLocalIp")).toBe("localhost");
    });

    it("returns local channel secrets unchanged and passes explicit credential clearing to the channel manager", async () => {
      const config = { type: "feishu", name: "Feishu", enabled: true, options: { appSecret: "test-secret", gatewayUrl: "ws://localhost/ws" } };
      vi.mocked(dependencies.channelManager.getConfig).mockReturnValue(config);
      expect(await controller.invoke("channel:getConfig", ["feishu"])).toBe(config);
      const patch = { options: { appSecret: "" } };
      expect(await controller.invoke("channel:updateConfig", ["feishu", patch])).toEqual({ success: true });
      expect(dependencies.channelManager.updateConfig).toHaveBeenCalledWith("feishu", patch);
      expect(await controller.invoke("channel:getStatus", ["missing"])).toBeUndefined();
    });

    it("waits for channel lifecycle completion and propagates failures", async () => {
      let complete: () => void = () => {};
      vi.mocked(dependencies.channelManager.startChannel).mockReturnValue(new Promise<void>(resolve => { complete = resolve; }));
      const observed = vi.fn();
      const result = controller.invoke("channel:start", ["feishu"]).then(observed);
      await Promise.resolve();
      expect(observed).not.toHaveBeenCalled();
      complete();
      await result;
      expect(observed).toHaveBeenCalledWith({ success: true });
      vi.mocked(dependencies.channelManager.stopChannel).mockRejectedValueOnce(new Error("Stop failed"));
      await expect(controller.invoke("channel:stop", ["feishu"])).rejects.toThrow("Stop failed");
    });

    it("preserves QR helper arguments, token results, and fixed iLink logout selection", async () => {
      const baseUrl = "https://ilink.example";
      expect(await controller.invoke("channel:weixin-ilink:get-qrcode", [baseUrl])).toMatchObject({ qrcode: "qr-id", baseUrl });
      expect(dependencies.ilink.getQrCode).toHaveBeenCalledWith(baseUrl);
      expect(await controller.invoke("channel:weixin-ilink:poll-qrcode-status", ["qr-id", baseUrl])).toEqual({ status: "confirmed", botToken: "test-token", accountId: "test-account" });
      expect(dependencies.ilink.pollQrStatus).toHaveBeenCalledWith("qr-id", baseUrl);
      expect(await controller.invoke("channel:weixin-ilink:logout")).toEqual({ success: true });
      expect(dependencies.channelManager.logoutChannel).toHaveBeenCalledWith("weixin-ilink");
    });

    it("routes legacy tunnel start through remote access and preserves an empty hostname reset", async () => {
      const tunnel = { status: "running" as const, url: "https://test.example" };
      vi.mocked(dependencies.remoteAccessManager.update).mockResolvedValue({ ...dependencies.remoteAccessManager.getStatus(), mode: "cloudflare", tunnel });
      expect(await controller.invoke("tunnel:start", [9999, {}])).toBe(tunnel);
      expect(dependencies.remoteAccessManager.update).toHaveBeenCalledWith({ mode: "cloudflare", tunnelConfig: {} });
      vi.mocked(dependencies.remoteAccessManager.update).mockClear();
      expect(await controller.invoke("tunnel:stop")).toBeUndefined();
      expect(dependencies.remoteAccessManager.update).not.toHaveBeenCalled();
    });

    it.each(["remoteAccessMode", "customAccessUrl", "tunnelConfig"])("rejects reserved %s settings without changing the settings file", async key => {
      dependencies.settings.save({ theme: "dark" });
      const filePath = path.join(directory, "settings.json");
      const before = fs.readFileSync(filePath, "utf-8");
      await expect(controller.invoke("settings:save", [{ theme: "light", [key]: "" }])).rejects.toThrow("Use remote access controls");
      expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
      expect(dependencies.remoteAccessManager.update).not.toHaveBeenCalled();
    });

    it.each(["system:openPath", "system:openExternal", "update:quitAndInstall", "constructor", "toString", "unknown"])("rejects non-management method %s", async method => {
      expect(HOST_MANAGEMENT_METHODS).not.toContain(method);
      await expect(controller.invoke(method)).rejects.toThrow("Unknown host management method");
    });
  });

  describe("loadSettings", () => {
    it("reads synchronously for preload and preserves the existing one-level settings merge", async () => {
      dependencies.settings.save({ theme: "dark", engineModels: { first: { modelID: "old" }, second: { modelID: "kept" } } });
      expect(controller.loadSettings()).toMatchObject({ theme: "dark" });
      expect(controller.loadSettings()).not.toBeInstanceOf(Promise);
      expect(await controller.invoke("settings:save", [{ engineModels: { first: { modelID: "new" } } }])).toEqual({ success: true });
      expect(await controller.invoke("settings:load")).toEqual({ theme: "dark", engineModels: { first: { modelID: "new" }, second: { modelID: "kept" } } });
      expect(controller.loadSettings()).toEqual(await controller.invoke("settings:load"));
    });
  });
});
