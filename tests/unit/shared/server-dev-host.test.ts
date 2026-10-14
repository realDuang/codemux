import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callHost, readHostControlMetadata } from "../../../shared/host-control-client";
import type { LocalServerState } from "../../../shared/local-server-types";
import { acquireRuntimeLock } from "../../../shared/runtime-lock";

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  createServer: vi.fn(),
  constructor: vi.fn(),
  start: vi.fn(),
  restart: vi.fn(),
  shutdown: vi.fn(),
  invoke: vi.fn(),
  state: { phase: "stopped", ownership: null, pid: null, error: null } as LocalServerState,
}));
vi.mock("vite", () => ({ build: mocks.build, createServer: mocks.createServer }));
vi.mock("../../../electron/main/local-server-supervisor", () => ({
  LocalServerSupervisor: class {
    constructor(options: unknown) { mocks.constructor(options); }
    getState() { return mocks.state; }
    start = mocks.start;
    restart = mocks.restart;
    shutdown = mocks.shutdown;
    invoke = mocks.invoke;
  },
}));

import { createDevRuntimeEnvironment, ServerDevHost } from "../../../scripts/server-dev-host";

let root: string;
let stateDir: string;
let host: ServerDevHost;
let watcher: EventEmitter & { close: ReturnType<typeof vi.fn> };
let webClose: ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function completedBuild() {
  watcher.emit("event", { code: "BUNDLE_END", result: { close: vi.fn().mockResolvedValue(undefined) } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codemux-dev-host-"));
  stateDir = path.join(root, "state");
  watcher = Object.assign(new EventEmitter(), { close: vi.fn().mockResolvedValue(undefined) });
  webClose = vi.fn().mockResolvedValue(undefined);
  mocks.createServer.mockResolvedValue({ listen: vi.fn().mockResolvedValue(undefined), close: webClose, httpServer: { address: () => ({ port: 8233 }) } });
  mocks.build.mockResolvedValue(watcher);
  mocks.state = { phase: "stopped", ownership: null, pid: null, error: null };
  mocks.start.mockImplementation(async () => mocks.state = { phase: "ready", ownership: "owned", pid: 123, error: null });
  mocks.restart.mockImplementation(async () => mocks.state = { ...mocks.state, pid: (mocks.state.pid ?? 123) + 1 });
  mocks.shutdown.mockImplementation(async () => { mocks.state = { phase: "stopped", ownership: null, pid: null, error: null }; });
  host = new ServerDevHost({ repoPath: root, stateDir, nodePath: "/explicit/node", env: { CODEMUX_DATA_DIR: path.join(root, "data") } });
});

afterEach(async () => {
  await host.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
});

describe("createDevRuntimeEnvironment", () => {
  it("preserves legacy and isolated paths while consuming inherited desktop flags", () => {
    const source = { CODEMUX_DATA_DIR: "/existing/data", CODEMUX_DEV_ISOLATED: "1", CODEMUX_PORT_OFFSET: "200", ELECTRON_RUN_AS_NODE: "1", CODEMUX_DESKTOP_HOST: "1" };
    expect(createDevRuntimeEnvironment(source, "/state")).toEqual({
      CODEMUX_DATA_DIR: "/existing/data", CODEMUX_DEV_ISOLATED: "1", CODEMUX_PORT_OFFSET: "200",
      CODEMUX_LEGACY_DEV: "1", CODEMUX_SERVER_MODE: "1", CODEMUX_DISABLE_COPILOT_DBUS: "1",
      CODEMUX_RUNTIME_WEB_MODE: "dev-proxy", CODEMUX_DEV_PARENT_PID: String(process.pid), CODEMUX_SERVER_STATE_DIR: "/state",
    });
    expect(source.ELECTRON_RUN_AS_NODE).toBe("1");
  });
});

describe("ServerDevHost", () => {
  it("waits for a completed build and uses explicit Node with the existing ownership supervisor", async () => {
    await host.start();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.constructor).toHaveBeenCalledWith(expect.objectContaining({ execPath: "/explicit/node", stopTimeoutMs: 35_000, env: expect.objectContaining({ CODEMUX_LEGACY_DEV: "1" }) }));
    expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({ build: { watch: {}, emptyOutDir: false } }));
    completedBuild();
    await vi.waitFor(() => expect(host.getStatus().ready).toBe(true));
    expect((await fs.readFile(path.join(stateDir, "local-url"), "utf8")).trim()).toBe("http://localhost:8233");
  });

  it("restarts only after successful source rebuilds and retains the runtime after build errors", async () => {
    await host.start();
    completedBuild();
    await vi.waitFor(() => expect(host.getStatus().ready).toBe(true));
    watcher.emit("event", { code: "ERROR", error: new Error("invalid source") });
    expect(host.getStatus()).toMatchObject({ ready: true, runtimePid: 123, error: "invalid source" });
    expect(mocks.restart).not.toHaveBeenCalled();
    completedBuild();
    await vi.waitFor(() => expect(host.getStatus()).toMatchObject({ ready: true, runtimePid: 124, error: null }));
    expect(mocks.restart).toHaveBeenCalledOnce();
  });

  it("leaves an independently owned runtime untouched and refuses development operations", async () => {
    mocks.start.mockImplementation(async () => mocks.state = { phase: "ready", ownership: "external", pid: 456, error: null });
    await host.start();
    completedBuild();
    await vi.waitFor(() => expect(host.getStatus().error).toContain("Another launcher"));
    expect(mocks.restart).not.toHaveBeenCalled();
    await expect(callHost(stateDir, "remoteAccess:update", [{ mode: "cloudflare" }])).rejects.toThrow("not owned");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("cancels pending startup before closing a build and ignores its late completion", async () => {
    await host.start();
    const pending = deferred<void>();
    watcher.close.mockReturnValue(pending.promise);
    const closing = host.close();
    expect(mocks.shutdown).toHaveBeenCalledOnce();
    completedBuild();
    pending.resolve();
    await closing;
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(webClose).toHaveBeenCalledOnce();
    expect(await readHostControlMetadata(stateDir)).toBeNull();
  });

  it("does not resurrect a queued runtime restart after stop", async () => {
    await host.start();
    completedBuild();
    await vi.waitFor(() => expect(host.getStatus().ready).toBe(true));
    const restarting = deferred<LocalServerState>();
    mocks.restart.mockReturnValue(restarting.promise);
    completedBuild();
    await vi.waitFor(() => expect(mocks.restart).toHaveBeenCalledOnce());
    completedBuild();
    const closing = host.close();
    restarting.resolve({ phase: "stopped", ownership: null, pid: null, error: null });
    await closing;
    expect(mocks.restart).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("closes a Vite server that finishes creating after stop begins", async () => {
    const creating = deferred<Awaited<ReturnType<typeof mocks.createServer>>>();
    const web = { listen: vi.fn(), close: webClose, httpServer: { address: () => ({ port: 8233 }) } };
    mocks.createServer.mockReturnValue(creating.promise);
    const starting = host.start();
    await vi.waitFor(() => expect(mocks.createServer).toHaveBeenCalledOnce());
    const closing = host.close();
    creating.resolve(web);
    await Promise.all([starting, closing]);
    expect(web.listen).not.toHaveBeenCalled();
    expect(webClose).toHaveBeenCalledOnce();
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("keeps the development control surface limited to owned runtime management", async () => {
    await host.start();
    completedBuild();
    await vi.waitFor(() => expect(host.getStatus().ready).toBe(true));
    await expect(callHost(stateDir, "settings:save", [{ theme: "dark" }])).rejects.toThrow("Unsupported");
    mocks.invoke.mockResolvedValue({ status: "running", url: "https://example.test" });
    await expect(callHost(stateDir, "tunnel:getStatus")).resolves.toEqual({ status: "running", url: "https://example.test" });
    expect(mocks.invoke).toHaveBeenCalledWith("tunnel:getStatus", []);
  });

  it("does not remove another development host's state after losing the startup lease", async () => {
    await host.start();
    await fs.writeFile(path.join(stateDir, "dev.pid"), "existing owner\n");
    const metadata = await readHostControlMetadata(stateDir);
    const contender = new ServerDevHost({ repoPath: root, stateDir, nodePath: "/explicit/node", env: { CODEMUX_DATA_DIR: path.join(root, "data") } });
    await expect(contender.start()).rejects.toThrow("already in use");
    expect(await fs.readFile(path.join(stateDir, "dev.pid"), "utf8")).toBe("existing owner\n");
    expect(await readHostControlMetadata(stateDir)).toEqual(metadata);
  });

  it.each(["watcher", "runtime"])("closes the remaining resources and releases ownership after %s cleanup fails", async failure => {
    await host.start();
    if (failure === "watcher") watcher.close.mockRejectedValue(new Error("cleanup failed"));
    else mocks.shutdown.mockRejectedValue(new Error("cleanup failed"));
    await expect(host.close()).rejects.toThrow("cleanup failed");
    expect(webClose).toHaveBeenCalledOnce();
    expect(watcher.close).toHaveBeenCalledOnce();
    expect(mocks.shutdown).toHaveBeenCalledOnce();
    expect(await readHostControlMetadata(stateDir)).toBeNull();
    const replacementLease = await acquireRuntimeLock(stateDir);
    await replacementLease.release();
  });
});
