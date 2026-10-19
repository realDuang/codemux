import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  windows: [] as any[], tunnels: [] as any[],
  fetch: vi.fn(), openExternal: vi.fn(),
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
      session: { fetch: mocks.fetch, setPermissionRequestHandler: vi.fn() },
    });
    constructor(readonly options: unknown) { super(); mocks.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  },
  shell: { openExternal: mocks.openExternal },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => unknown) => mocks.handlers.set(name, handler) },
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
});
