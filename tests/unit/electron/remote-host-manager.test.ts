import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  windows: [] as any[], tunnels: [] as any[],
  fetch: vi.fn(), openExternal: vi.fn(),
  authPrepare: vi.fn(), authorization: vi.fn(), authClose: vi.fn(),
  start: vi.fn(), stop: vi.fn(), handlers: new Map<string, (...args: any[]) => unknown>(),
}));

vi.mock("electron", () => ({
  BrowserWindow: class extends EventEmitter {
    destroyed = false;
    show = vi.fn();
    focus = vi.fn();
    loadURL = vi.fn(async () => {});
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(), mainFrame: {},
      session: { fetch: mocks.fetch, setPermissionRequestHandler: vi.fn(), webRequest: { onBeforeSendHeaders: vi.fn() } },
    });
    constructor(readonly options: unknown) { super(); mocks.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  },
  shell: { openExternal: mocks.openExternal },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => unknown) => mocks.handlers.set(name, handler) },
}));
vi.mock("../../../shared/dev-tunnel-client-auth", () => ({
  DevTunnelClientAuth: class {
    prepare = mocks.authPrepare;
    authorization = mocks.authorization;
    close = mocks.authClose;
  },
}));
vi.mock("../../../electron/main/services/ssh-connection", () => ({
  SshConnection: class {
    start = mocks.start;
    stop = mocks.stop;
    constructor(readonly options: any) { mocks.tunnels.push(this); }
  },
}));

import { RemoteHostStore } from "../../../electron/main/services/remote-host-store";
import { RemoteHostManager, remoteHostPartition, remoteHostWindowOptions } from "../../../electron/main/remote-host-manager";
import { registerRemoteHostIpc } from "../../../electron/main/remote-host-ipc";

let directory: string;
let store: RemoteHostStore;
let manager: RemoteHostManager;
const direct = { name: "Remote workstation", connection: { type: "direct" as const, host: "workstation.example", port: 443, useTls: true } };
beforeEach(() => {
  mocks.windows.length = 0;
  mocks.tunnels.length = 0;
  mocks.handlers.clear();
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ mode: "custom" }) });
  mocks.openExternal.mockResolvedValue(undefined);
  mocks.authPrepare.mockResolvedValue(true);
  mocks.authorization.mockResolvedValue("tunnel test-credential");
  mocks.authClose.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue({ url: "http://127.0.0.1:19333", localPort: 19333 });
  mocks.stop.mockResolvedValue(undefined);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "codemux-remote-host-test-"));
  store = new RemoteHostStore(directory);
  manager = new RemoteHostManager(store, vi.fn());
});
afterEach(async () => {
  await manager.close();
  vi.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("remoteHostWindowOptions", () => {
  it("isolates remote content from native APIs and other host credentials", () => {
    const first = store.save(direct);
    const second = store.save({ ...direct, name: "Another host" });
    const options = remoteHostWindowOptions(first);
    expect(options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
    expect(options.webPreferences).not.toHaveProperty("preload");
    expect(remoteHostPartition(first)).not.toBe(remoteHostPartition(second));
    expect(remoteHostPartition(first)).toBe(remoteHostPartition({ ...first, name: "Renamed" }));
    expect(remoteHostPartition(first)).not.toBe(remoteHostPartition({ ...first, connection: { ...direct.connection, host: "different.example" } }));
  });
});

describe("RemoteHostManager", () => {
  it("authenticates private Dev Tunnels with the CLI account without an embedded login window", async () => {
    const host = await manager.save({ connection: { type: "direct", host: "codemux-test-8233.jpe1.devtunnels.ms", port: 443, useTls: true } });
    mocks.fetch.mockRejectedValueOnce(new Error("Redirect requires login"));
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ mode: "devtunnel" }) });
    await manager.connect(host.id);
    expect(mocks.windows).toHaveLength(1);
    const [app] = mocks.windows;
    expect(mocks.authPrepare).toHaveBeenCalledWith("https://codemux-test-8233.jpe1.devtunnels.ms");
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(app.show).toHaveBeenCalled();
    const preventDefault = vi.fn();
    app.webContents.emit("will-redirect", { preventDefault }, "https://login.microsoftonline.com/");
    expect(preventDefault).toHaveBeenCalled();
    expect(manager.list()[0].status).toBe("connected");
    const headers = app.webContents.session.webRequest.onBeforeSendHeaders;
    const handler = headers.mock.calls[0][0];
    for (const protocol of ["https", "wss"]) {
      const callback = vi.fn();
      handler({ url: `${protocol}://codemux-test-8233.jpe1.devtunnels.ms/api`, requestHeaders: { Authorization: "Bearer codemux-token" } }, callback);
      await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({
        requestHeaders: { Authorization: "Bearer codemux-token", "X-Tunnel-Authorization": "tunnel test-credential" },
      }));
    }
    for (const url of ["https://login.microsoftonline.com/", "https://other-8233.jpe1.devtunnels.ms/", "http://codemux-test-8233.jpe1.devtunnels.ms/",
      "https://codemux-test-8233.jpe1.devtunnels.ms:8443/", "https://user@codemux-test-8233.jpe1.devtunnels.ms/"]) {
      const callback = vi.fn();
      handler({ url, requestHeaders: { "x-tunnel-authorization": "inherited", Accept: "text/html" } }, callback);
      expect(callback).toHaveBeenCalledWith({ requestHeaders: { Accept: "text/html" } });
    }
    await manager.disconnect(host.id);
    expect(headers).toHaveBeenLastCalledWith(null);
    expect(mocks.authClose).toHaveBeenCalledOnce();
  });

  it("cancels pending account authentication without opening a browser or resurrecting the connection", async () => {
    const host = await manager.save({ connection: { type: "direct", host: "codemux-test-8233.jpe1.devtunnels.ms", port: 443, useTls: true } });
    mocks.fetch.mockRejectedValue(new Error("Login required"));
    let finish!: (prepared: boolean) => void;
    mocks.authPrepare.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const connecting = manager.connect(host.id);
    const cancelled = expect(connecting).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(mocks.authPrepare).toHaveBeenCalled());
    await manager.disconnect(host.id);
    finish(true);
    await cancelled;
    expect(mocks.authClose).toHaveBeenCalledOnce();
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.windows.every(window => window.isDestroyed())).toBe(true);
    expect(manager.list()[0].status).toBe("disconnected");
  });

  it("hands unmatched private links to the system browser without claiming a desktop connection", async () => {
    const host = await manager.save({ connection: { type: "direct", host: "other-8233.jpe1.devtunnels.ms", port: 443, useTls: true } });
    mocks.fetch.mockRejectedValue(new Error("Login required"));
    mocks.authPrepare.mockResolvedValue(false);
    await manager.connect(host.id);
    expect(mocks.openExternal).toHaveBeenCalledWith("https://other-8233.jpe1.devtunnels.ms/?connect=1");
    expect(mocks.windows).toHaveLength(1);
    expect(mocks.windows[0].show).not.toHaveBeenCalled();
    expect(mocks.windows[0].isDestroyed()).toBe(true);
    expect(manager.list()[0].status).toBe("external");
    await manager.connect(host.id);
    expect(mocks.openExternal).toHaveBeenCalledTimes(2);
  });

  it("reports external browser launch failure and does not fall back to embedded login", async () => {
    const host = await manager.save({ connection: { type: "direct", host: "other-8233.jpe1.devtunnels.ms", port: 443, useTls: true } });
    mocks.fetch.mockRejectedValue(new Error("Login required"));
    mocks.authPrepare.mockResolvedValue(false);
    mocks.openExternal.mockRejectedValueOnce(new Error("Browser launch failed"));
    await expect(manager.connect(host.id)).rejects.toThrow("Browser launch failed");
    expect(manager.list()[0].status).toBe("error");
    expect(mocks.windows).toHaveLength(1);
    expect(mocks.windows[0].isDestroyed()).toBe(true);
  });

  it("keeps anonymous tunnel connections in the desktop without requesting credentials", async () => {
    const host = await manager.save({ connection: { type: "direct", host: "public-8233.jpe1.devtunnels.ms", port: 443, useTls: true } });
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ mode: "devtunnel" }) });
    await manager.connect(host.id);
    expect(mocks.authPrepare).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(manager.list()[0].status).toBe("connected");
  });

  it("fails closed on credential refresh and allows reconnecting with a fresh account session", async () => {
    const host = await manager.save({ connection: { type: "direct", host: "codemux-test-8233.jpe1.devtunnels.ms", port: 443, useTls: true } });
    mocks.fetch.mockRejectedValueOnce(new Error("Login required"));
    await manager.connect(host.id);
    const [app] = mocks.windows;
    const handler = app.webContents.session.webRequest.onBeforeSendHeaders.mock.calls[0][0];
    mocks.authorization.mockRejectedValueOnce(new Error("sensitive raw CLI failure"));
    const callback = vi.fn();
    handler({ url: "wss://codemux-test-8233.jpe1.devtunnels.ms/ws", requestHeaders: {} }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ cancel: true }));
    expect(app.isDestroyed()).toBe(true);
    expect(manager.list()[0]).toMatchObject({ status: "error", error: expect.stringContaining("Reconnect") });
    expect(JSON.stringify(manager.list())).not.toContain("sensitive");
    mocks.fetch.mockRejectedValueOnce(new Error("Login required"));
    await manager.connect(host.id);
    expect(mocks.windows).toHaveLength(2);
    expect(manager.list()[0].status).toBe("connected");
  });

  it("opens the complete remote Web origin and reuses its existing window", async () => {
    const host = await manager.save(direct);
    await Promise.all([manager.connect(host.id), manager.connect(host.id)]);
    expect(mocks.windows).toHaveLength(1);
    expect(mocks.windows[0].loadURL).toHaveBeenCalledWith("https://workstation.example/?connect=1");
    expect(manager.list()[0].status).toBe("connected");
    await manager.connect(host.id);
    expect(mocks.windows).toHaveLength(1);
    expect(mocks.windows[0].focus).toHaveBeenCalledOnce();
    await manager.disconnect(host.id);
    expect(mocks.windows[0].isDestroyed()).toBe(true);
    expect(manager.list()[0].status).toBe("disconnected");
  });

  it("rejects disabled direct access and non-CodeMux endpoints before showing a window", async () => {
    const host = await manager.save(direct);
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ mode: "off" }) });
    await expect(manager.connect(host.id)).rejects.toThrow("Enable direct access");
    expect(mocks.windows[0].show).not.toHaveBeenCalled();
    expect(mocks.windows[0].isDestroyed()).toBe(true);
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ unrelated: true }) });
    await expect(manager.connect(host.id)).rejects.toThrow("CodeMux server");
    expect(manager.list()[0].status).toBe("error");
  });

  it("blocks navigation outside the selected host and never opens unsafe protocols", async () => {
    const host = await manager.save(direct);
    await manager.connect(host.id);
    const contents = mocks.windows[0].webContents;
    const preventDefault = vi.fn();
    contents.emit("will-navigate", { preventDefault }, "https://workstation.example/chat");
    expect(preventDefault).not.toHaveBeenCalled();
    contents.emit("will-navigate", { preventDefault }, "file:///etc/passwd");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.openExternal).not.toHaveBeenCalled();
    contents.emit("will-redirect", { preventDefault }, "https://unrelated.example/");
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it("preserves the SSH browser origin on reconnect and releases the owned tunnel on close", async () => {
    vi.useFakeTimers();
    const host = await manager.save({ name: "SSH host", connection: { type: "ssh", address: "ssh://build-host", remotePort: 8233 } });
    await manager.connect(host.id);
    expect(store.get(host.id)?.localPort).toBe(19333);
    expect(mocks.windows[0].loadURL).toHaveBeenCalledWith("http://127.0.0.1:19333/?connect=1");
    mocks.tunnels[0].options.onClose("Disconnected");
    expect(manager.list()[0].status).toBe("error");
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.tunnels[1].options.preferredLocalPort).toBe(19333);
    expect(manager.list()[0].status).toBe("connected");
    mocks.windows[0].destroy();
    await Promise.resolve();
    expect(mocks.stop).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.tunnels).toHaveLength(2);
  });

  it("does not resurrect a cancelled SSH attempt", async () => {
    let finish!: (value: { url: string; localPort: number }) => void;
    mocks.start.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const host = await manager.save({ connection: { type: "ssh", address: "build-host", remotePort: 8233 } });
    const connecting = manager.connect(host.id);
    await manager.disconnect(host.id);
    finish({ url: "http://127.0.0.1:19333", localPort: 19333 });
    await expect(connecting).rejects.toThrow("cancelled");
    expect(mocks.windows).toHaveLength(0);
    expect(manager.list()[0].status).toBe("disconnected");
  });

  it.each(["disconnect", "remove", "close"] as const)("does not restart SSH after %s while its old process is stopping", async action => {
    vi.useFakeTimers();
    const host = await manager.save({ connection: { type: "ssh", address: "build-host", remotePort: 8233 } });
    await manager.connect(host.id);
    let finishStop!: () => void;
    mocks.stop.mockReturnValue(new Promise<void>(resolve => { finishStop = resolve; }));
    mocks.tunnels[0].options.onClose("Disconnected");
    await vi.advanceTimersByTimeAsync(1000);
    const closing = action === "close" ? manager.close() : manager[action](host.id);
    finishStop();
    await closing;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.tunnels).toHaveLength(1);
    expect(mocks.windows[0].isDestroyed()).toBe(true);
    expect(manager.list().every(item => item.status === "disconnected")).toBe(true);
  });

  it("accepts saved hosts again when an installer returns control to the desktop", async () => {
    const host = await manager.save(direct);
    await manager.connect(host.id);
    await manager.close();
    await expect(manager.connect(host.id)).rejects.toThrow("shutting down");
    manager.resume();
    await manager.connect(host.id);
    expect(manager.list()[0].status).toBe("connected");
  });
});

describe("registerRemoteHostIpc", () => {
  it("restricts discovery and login to the main desktop frame with an explicit boolean login choice", async () => {
    const mainFrame = {};
    const contents = { mainFrame };
    const discover = vi.spyOn(manager, "discoverDevTunnels").mockResolvedValue({ status: "ready", tunnels: [] });
    const cancel = vi.spyOn(manager, "cancelDevTunnelDiscovery").mockResolvedValue();
    registerRemoteHostIpc(manager, () => ({ webContents: contents, isDestroyed: () => false }) as any);
    const caller = { sender: contents, senderFrame: mainFrame };
    const discovery = mocks.handlers.get("remoteHosts:discoverDevTunnels")!;
    const cancellation = mocks.handlers.get("remoteHosts:cancelDevTunnelDiscovery")!;
    for (const invalid of [{ sender: {}, senderFrame: mainFrame }, { sender: contents, senderFrame: {} }]) {
      expect(() => discovery(invalid, true)).toThrow("local desktop");
      expect(() => cancellation(invalid)).toThrow("local desktop");
    }
    for (const invalid of [undefined, "true", 1, {}]) expect(() => discovery(caller, invalid)).toThrow("Invalid login choice");
    expect(discover).not.toHaveBeenCalled();
    await discovery(caller, false);
    await discovery(caller, true);
    await cancellation(caller);
    expect(discover.mock.calls).toEqual([[false], [true]]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects remote renderers and subframes before invoking host management", () => {
    const mainFrame = {};
    const contents = { mainFrame };
    const win = { webContents: contents, isDestroyed: () => false };
    registerRemoteHostIpc(manager, () => win as any);
    const list = mocks.handlers.get("remoteHosts:list")!;
    expect(() => list({ sender: {}, senderFrame: mainFrame })).toThrow("local desktop");
    expect(() => list({ sender: contents, senderFrame: {} })).toThrow("local desktop");
    expect(list({ sender: contents, senderFrame: mainFrame })).toEqual([]);
  });

  it("dispatches trusted host operations and rejects invalid IDs before changing a connection", async () => {
    const mainFrame = {};
    const contents = { mainFrame };
    const win = { webContents: contents, isDestroyed: () => false };
    registerRemoteHostIpc(manager, () => win as any);
    const caller = { sender: contents, senderFrame: mainFrame };
    const call = (method: string, ...args: unknown[]) => mocks.handlers.get(`remoteHosts:${method}`)!(caller, ...args);
    const saved = await call("save", direct) as { id: string };
    for (const method of ["connect", "disconnect", "remove"]) {
      for (const id of [null, {}, "", "x".repeat(129)]) expect(() => call(method, id)).toThrow("Invalid host ID");
      expect(() => mocks.handlers.get(`remoteHosts:${method}`)!({ sender: {}, senderFrame: mainFrame }, saved.id)).toThrow("local desktop");
    }
    expect(() => call("save", direct, {})).toThrow("Invalid host ID");
    const renamed = await call("save", { ...direct, name: "Updated" }, saved.id) as { id: string; name: string };
    expect(renamed).toMatchObject({ id: saved.id, name: "Updated" });
    await call("connect", saved.id);
    expect(manager.list()[0].status).toBe("connected");
    await call("disconnect", saved.id);
    expect(manager.list()[0].status).toBe("disconnected");
    await call("remove", saved.id);
    expect(call("list")).toEqual([]);
  });
});
