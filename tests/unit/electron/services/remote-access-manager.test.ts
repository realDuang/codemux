import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_PORT } from "../../../../shared/ports";
import type { RemoteAccessTunnelConfig, RemoteAccessTunnelInfo } from "../../../../shared/remote-access";

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn<() => Record<string, unknown>>(),
  saveSettings: vi.fn<(patch: Record<string, unknown>) => Promise<void>>(),
  error: vi.fn(),
  tunnel: {
    start: vi.fn<(port: number, config?: RemoteAccessTunnelConfig) => Promise<RemoteAccessTunnelInfo>>(),
    stop: vi.fn<() => Promise<void>>(),
    getInfo: vi.fn<() => RemoteAccessTunnelInfo>(),
    setOnUnexpectedExit: vi.fn<(callback: () => void) => void>(),
  },
}));

vi.mock("../../../../electron/main/services/logger", () => ({
  loadSettings: mocks.loadSettings,
  saveSettings: mocks.saveSettings,
  mainLog: { error: mocks.error },
}));

vi.mock("../../../../electron/main/services/tunnel-manager", () => ({
  tunnelManager: mocks.tunnel,
}));

const CUSTOM_URL = "https://custom.example.com";
const CLOUDFLARE_URL = "https://codemux.example.com";
let settings: Record<string, unknown>;
let tunnelInfo: RemoteAccessTunnelInfo;

function emitUnexpectedExit(): void {
  tunnelInfo = { status: "stopped", url: "" };
  expect(mocks.tunnel.setOnUnexpectedExit).toHaveBeenCalledOnce();
  mocks.tunnel.setOnUnexpectedExit.mock.calls[0][0]();
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  settings = {};
  tunnelInfo = { status: "stopped", url: "" };
  mocks.loadSettings.mockImplementation(() => settings);
  mocks.saveSettings.mockImplementation(async (patch) => {
    settings = { ...settings, ...patch };
  });
  mocks.tunnel.getInfo.mockImplementation(() => tunnelInfo);
  mocks.tunnel.start.mockImplementation(async () => {
    tunnelInfo = { status: "running", url: CLOUDFLARE_URL };
    return tunnelInfo;
  });
  mocks.tunnel.stop.mockImplementation(async () => {
    tunnelInfo = { status: "stopped", url: "" };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("remoteAccessManager", () => {
  it("restores the saved tunnel configuration using the configured web port", async () => {
    settings = { remoteAccessMode: "cloudflare", tunnelConfig: { hostname: "codemux.example.com" } };
    const { remoteAccessManager } = await import("../../../../electron/main/services/remote-access-manager");

    expect(mocks.tunnel.start).not.toHaveBeenCalled();
    await remoteAccessManager.initialize();

    expect(mocks.tunnel.start).toHaveBeenCalledWith(WEB_PORT, { hostname: "codemux.example.com" });
    expect(remoteAccessManager.getStatus()).toMatchObject({ mode: "cloudflare", url: CLOUDFLARE_URL });
    expect(settings.remoteAccessMode).toBe("cloudflare");
  });

  it("persists off after an unexpected Cloudflare exit while retaining the saved custom URL", async () => {
    settings = { remoteAccessMode: "cloudflare", customAccessUrl: CUSTOM_URL };
    const { remoteAccessManager } = await import("../../../../electron/main/services/remote-access-manager");
    await remoteAccessManager.initialize();
    mocks.saveSettings.mockClear();
    mocks.tunnel.stop.mockClear();

    emitUnexpectedExit();

    await vi.waitFor(() => expect(settings.remoteAccessMode).toBe("off"));
    expect(remoteAccessManager.getStatus()).toMatchObject({
      mode: "off", url: "", customAccessUrl: CUSTOM_URL, tunnel: { status: "stopped" },
    });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      remoteAccessMode: "off", customAccessUrl: CUSTOM_URL, tunnelConfig: { hostname: "" },
    });
    expect(mocks.tunnel.stop).toHaveBeenCalledOnce();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it.each(["off", "custom"] as const)("preserves %s mode when a stale tunnel exit arrives", async (mode) => {
    settings = { remoteAccessMode: mode, customAccessUrl: CUSTOM_URL };
    const { remoteAccessManager } = await import("../../../../electron/main/services/remote-access-manager");
    const update = vi.spyOn(remoteAccessManager, "update");

    emitUnexpectedExit();

    expect(update).not.toHaveBeenCalled();
    expect(remoteAccessManager.getStatus()).toMatchObject({
      mode, customAccessUrl: CUSTOM_URL, url: mode === "custom" ? CUSTOM_URL : "",
    });
    expect(settings).toEqual({ remoteAccessMode: mode, customAccessUrl: CUSTOM_URL });
    expect(mocks.saveSettings).not.toHaveBeenCalled();
    expect(mocks.tunnel.stop).not.toHaveBeenCalled();
  });

  it("logs a persistence failure from an unexpected exit and keeps remote access off", async () => {
    settings = { remoteAccessMode: "cloudflare" };
    const { remoteAccessManager } = await import("../../../../electron/main/services/remote-access-manager");
    await remoteAccessManager.initialize();
    const error = new Error("Settings disk is full");
    mocks.saveSettings.mockRejectedValueOnce(error);

    emitUnexpectedExit();

    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledWith(
      "Failed to persist remote access shutdown:", error,
    ));
    expect(remoteAccessManager.getStatus()).toMatchObject({ mode: "off", url: "", tunnel: { status: "stopped" } });
    expect(settings.remoteAccessMode).toBe("off");
  });
});

describe("setRemoteAccessPort", () => {
  it("uses the current runtime port for initialization and subsequent tunnel starts", async () => {
    settings = { remoteAccessMode: "cloudflare" };
    const { remoteAccessManager, setRemoteAccessPort } = await import("../../../../electron/main/services/remote-access-manager");

    setRemoteAccessPort(18233);
    await remoteAccessManager.initialize();
    expect(mocks.tunnel.start).toHaveBeenNthCalledWith(1, 18233, { hostname: "" });

    await remoteAccessManager.update({ mode: "off" });
    setRemoteAccessPort(28233);
    await remoteAccessManager.update({ mode: "cloudflare" });

    expect(mocks.tunnel.start).toHaveBeenNthCalledWith(2, 28233, { hostname: "" });
    expect(remoteAccessManager.getStatus().mode).toBe("cloudflare");
  });
});

describe("stopRemoteAccessTunnel", () => {
  it("waits for tunnel shutdown without changing the saved remote access preference", async () => {
    settings = { remoteAccessMode: "cloudflare" };
    const { remoteAccessManager, stopRemoteAccessTunnel } = await import("../../../../electron/main/services/remote-access-manager");
    await remoteAccessManager.initialize();
    mocks.saveSettings.mockClear();
    mocks.tunnel.stop.mockClear();
    let finishStop!: () => void;
    const stopped = new Promise<void>((resolve) => { finishStop = resolve; });
    mocks.tunnel.stop.mockImplementationOnce(async () => {
      await stopped;
      tunnelInfo = { status: "stopped", url: "" };
    });
    const onStopped = vi.fn();

    const stopping = stopRemoteAccessTunnel().then(onStopped);
    await Promise.resolve();
    expect(mocks.tunnel.stop).toHaveBeenCalledOnce();
    expect(onStopped).not.toHaveBeenCalled();

    finishStop();
    await stopping;

    expect(onStopped).toHaveBeenCalledOnce();
    expect(remoteAccessManager.getStatus().tunnel.status).toBe("stopped");
    expect(settings.remoteAccessMode).toBe("cloudflare");
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it("propagates a tunnel shutdown failure to its caller", async () => {
    const { stopRemoteAccessTunnel } = await import("../../../../electron/main/services/remote-access-manager");
    const error = new Error("Cloudflare Tunnel did not stop.");
    mocks.tunnel.stop.mockRejectedValueOnce(error);

    await expect(stopRemoteAccessTunnel()).rejects.toBe(error);

    expect(mocks.tunnel.stop).toHaveBeenCalledOnce();
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });
});
