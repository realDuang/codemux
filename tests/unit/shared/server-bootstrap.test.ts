import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostControlServerOptions } from "../../../shared/host-control-server";
import type { ServerRuntimeRole } from "../../../server/runtime-role";

const state = vi.hoisted(() => {
  const role: ServerRuntimeRole = { kind: "standalone", webMode: "static" };
  const release = vi.fn(async () => {});
  const closeControl = vi.fn(async () => {});
  const host = {
    runtime: {
      initialize: vi.fn(),
      start: vi.fn(async () => {}),
      completeStartup: vi.fn(async () => {}),
    },
    productionServer: {
      getServer: vi.fn(() => ({ listening: true })),
      getPort: vi.fn(() => 8233),
    },
    gatewayServer: { getPort: vi.fn<() => number | undefined>(() => 8233) },
    management: { invoke: vi.fn() },
    getStatus: vi.fn(() => ({ pid: 456, phase: "starting", ready: false, dataPath: "/data", webPort: null, gatewayUrl: null })),
    stop: vi.fn(async () => {}),
  };
  return {
    role,
    host,
    release,
    closeControl,
    parentGone: false,
    disconnect: undefined as (() => void) | undefined,
    controlOptions: undefined as HostControlServerOptions | undefined,
    acquire: vi.fn(async () => ({ dataPath: "/canonical/data", release })),
    createHost: vi.fn(() => host),
    control: vi.fn(async (_options: HostControlServerOptions) => ({ close: closeControl })),
    authListening: vi.fn(() => true),
    sendDesktop: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    terminateChildren: vi.fn(),
  };
});

vi.mock("#runtime-host", () => ({ runtimeHost: { paths: { userDataPath: "/data" } } }));
vi.mock("../../../shared/runtime-lock", () => ({ acquireRuntimeLock: state.acquire }));
vi.mock("../../../server/service-host", () => ({ createServiceHost: state.createHost }));
vi.mock("../../../shared/host-control-server", () => ({ startHostControlServer: state.control }));
vi.mock("../../../electron/main/services/logger", () => ({ mainLog: state.log }));
vi.mock("../../../shared/terminate-owned-children", () => ({ terminateOwnedChildren: state.terminateChildren }));
vi.mock("../../../electron/main/services/auth-api-server", () => ({ authApiServer: { isRunning: state.authListening } }));
vi.mock("../../../shared/ports", () => ({ WEB_PORT: 8233, GATEWAY_PORT: 4200 }));
vi.mock("../../../server/runtime-role", () => ({
  get serverRuntimeRole() { return state.role; },
  sendDesktopMessage: state.sendDesktop,
  watchRuntimeParent: (_role: ServerRuntimeRole, stop: () => void) => {
    state.disconnect = stop;
    if (state.parentGone) stop();
    return () => {};
  },
}));

import { startServer } from "../../../server/bootstrap";

function useDesktop(): void {
  state.role = { kind: "desktop", webMode: "dev-proxy", desktopParentPid: 123, usesSharedDevDeviceStore: false };
  state.host.gatewayServer.getPort.mockReturnValue(4200);
}

describe("startServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.role = { kind: "standalone", webMode: "static" };
    state.parentGone = false;
    state.disconnect = undefined;
    state.controlOptions = undefined;
    state.host.productionServer.getServer.mockReturnValue({ listening: true });
    state.host.productionServer.getPort.mockReturnValue(8233);
    state.host.gatewayServer.getPort.mockReturnValue(8233);
    state.authListening.mockReturnValue(true);
    state.host.runtime.completeStartup.mockResolvedValue();
    state.host.stop.mockResolvedValue();
    state.closeControl.mockResolvedValue();
    state.acquire.mockResolvedValue({ dataPath: "/canonical/data", release: state.release });
    state.control.mockImplementation(async options => {
      state.controlOptions = options;
      return { close: state.closeControl };
    });
    vi.spyOn(process, "once").mockReturnValue(process);
    vi.spyOn(process, "on").mockReturnValue(process);
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
    if (process.send) vi.spyOn(process, "send").mockReturnValue(true);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts a standalone static host without a desktop owner in private status", async () => {
    await startServer();
    expect(state.createHost).toHaveBeenCalledWith("static");
    expect(state.host.runtime.completeStartup).toHaveBeenCalledOnce();
    expect(state.controlOptions?.getStatus()).toMatchObject({ dataPath: "/canonical/data" });
    expect(state.controlOptions?.getStatus()).not.toHaveProperty("desktopParentPid");
    expect(state.controlOptions?.getStatus()).not.toHaveProperty("developmentParentPid");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"type":"codemux.ready"'));
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("starts a standalone development host with its launcher in private status", async () => {
    state.role = { kind: "standalone", webMode: "dev-proxy", developmentParentPid: 321 };
    state.host.gatewayServer.getPort.mockReturnValue(4200);
    await startServer();
    expect(state.createHost).toHaveBeenCalledWith("dev-proxy");
    expect(state.controlOptions?.getStatus()).toMatchObject({ dataPath: "/canonical/data", developmentParentPid: 321 });
    expect(state.controlOptions?.getStatus()).not.toHaveProperty("desktopParentPid");
    expect(state.host.productionServer.getServer).not.toHaveBeenCalled();
    expect(state.host.runtime.completeStartup).toHaveBeenCalledOnce();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("exposes desktop control and backend listening before waiting for full engine/channel readiness", async () => {
    useDesktop();
    let complete!: () => void;
    state.host.runtime.completeStartup.mockReturnValue(new Promise<void>(resolve => { complete = resolve; }));
    const startup = startServer();
    await vi.waitFor(() => expect(state.host.runtime.completeStartup).toHaveBeenCalledOnce());
    expect(state.createHost).toHaveBeenCalledWith("dev-proxy");
    expect(state.controlOptions?.getStatus()).toMatchObject({ dataPath: "/canonical/data", desktopParentPid: 123 });
    expect(state.sendDesktop.mock.calls.map(([, message]) => message.type)).toEqual(["codemux.control", "codemux.listening"]);
    expect(state.host.productionServer.getServer).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();

    complete();
    await startup;
    expect(state.sendDesktop).toHaveBeenLastCalledWith(state.role, {
      type: "codemux.ready", pid: process.pid, port: 8233, dataPath: "/canonical/data",
    });
  });

  it.each(["auth", "gateway"])("rejects a dev-proxy host without an actual %s listener", async endpoint => {
    useDesktop();
    if (endpoint === "auth") state.authListening.mockReturnValue(false);
    else state.host.gatewayServer.getPort.mockReturnValue(undefined);
    await startServer();
    expect(state.host.runtime.completeStartup).not.toHaveBeenCalled();
    expect(state.sendDesktop.mock.calls.map(([, message]) => message.type)).toEqual(["codemux.control"]);
    expect(state.closeControl).toHaveBeenCalledOnce();
    expect(state.host.stop).toHaveBeenCalledOnce();
    expect(state.release).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it.each(["http", "gateway"])("rejects a static host without its shared %s listener", async endpoint => {
    if (endpoint === "http") state.host.productionServer.getServer.mockReturnValue({ listening: false });
    else state.host.gatewayServer.getPort.mockReturnValue(4200);
    await startServer();
    expect(state.host.runtime.completeStartup).not.toHaveBeenCalled();
    expect(state.host.stop).toHaveBeenCalledOnce();
    expect(state.release).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it.each(["desktop", "development"])("stops and releases ownership when the %s parent disappears during startup", async parent => {
    useDesktop();
    if (parent === "development") state.role = { kind: "standalone", webMode: "dev-proxy", developmentParentPid: 321 };
    let complete!: () => void;
    state.host.runtime.completeStartup.mockReturnValue(new Promise<void>(resolve => { complete = resolve; }));
    const startup = startServer();
    await vi.waitFor(() => expect(state.host.runtime.completeStartup).toHaveBeenCalledOnce());
    state.disconnect?.();
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
    complete();
    await startup;
    expect(state.host.stop).toHaveBeenCalledOnce();
    expect(state.release).toHaveBeenCalledOnce();
    expect(state.sendDesktop.mock.calls.map(([, message]) => message.type)).not.toContain("codemux.ready");
  });

  it("releases a newly acquired lock without starting services if the parent is already gone", async () => {
    useDesktop();
    state.parentGone = true;
    await startServer();
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
    expect(state.createHost).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledOnce();
  });

  it("waits for pending lock acquisition before releasing ownership on early SIGTERM", async () => {
    let acquire!: (value: { dataPath: string; release: typeof state.release }) => void;
    state.acquire.mockReturnValue(new Promise(resolve => { acquire = resolve; }));
    const startup = startServer();
    const signalHandler = vi.mocked(process.once).mock.calls.find(([event]) => event === "SIGTERM")?.[1] as (() => void) | undefined;
    expect(signalHandler).toBeDefined();
    signalHandler?.();
    await Promise.resolve();
    expect(state.release).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();

    acquire({ dataPath: "/canonical/data", release: state.release });
    await startup;
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
    expect(state.createHost).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledOnce();
  });

  it("terminates children and exits without publishing ownership when core cleanup fails", async () => {
    useDesktop();
    state.host.gatewayServer.getPort.mockReturnValue(undefined);
    state.host.stop.mockRejectedValue(new Error("WebSocket server was not running"));
    await startServer();
    expect(state.terminateChildren).toHaveBeenCalledOnce();
    expect(state.release).not.toHaveBeenCalled();
    expect(state.terminateChildren.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("releases ownership after successful core cleanup when only control metadata cleanup fails", async () => {
    useDesktop();
    state.host.gatewayServer.getPort.mockReturnValue(undefined);
    state.closeControl.mockRejectedValue(new Error("Control metadata cleanup failed"));
    await startServer();
    expect(state.host.stop).toHaveBeenCalledOnce();
    expect(state.release).toHaveBeenCalledOnce();
    expect(state.host.stop.mock.invocationCallOrder[0]).toBeLessThan(state.release.mock.invocationCallOrder[0]);
    expect(state.terminateChildren).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
