import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostControlError, type HostControlMetadata, type HostRuntimeStatus } from "../../../shared/host-control-types";
import { LocalServerSupervisor, type LocalServerSupervisorOptions } from "../../../electron/main/local-server-supervisor";

const mocks = vi.hoisted(() => ({ fork: vi.fn(), read: vi.fn(), call: vi.fn(), check: vi.fn(), terminate: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: mocks.fork }));
vi.mock("../../../shared/host-control-client", () => ({ readHostControlMetadata: mocks.read, callHost: mocks.call }));
vi.mock("proper-lockfile", () => ({ check: mocks.check }));
vi.mock("../../../shared/terminate-owned-children", () => ({ terminateOwnedProcessTree: mocks.terminate }));

class FakeChild extends EventEmitter {
  pid = 41_234;
  connected = true;
  disconnect = vi.fn(() => {
    this.connected = false;
    currentMetadata = null;
    currentLocked = false;
    this.emit("exit", 0, null);
  });
  kill = vi.fn(() => {
    currentMetadata = null;
    currentLocked = false;
    this.emit("exit", 0, null);
    return true;
  });
}

let currentMetadata: HostControlMetadata | null;
let currentStatus: HostRuntimeStatus;
let currentLocked: boolean;
let child: FakeChild;
let livePids: Set<number>;
let supervisors: LocalServerSupervisor[];
let killSpy: ReturnType<typeof vi.spyOn>;

function metadata(pid = 41_234): HostControlMetadata {
  return { version: 1, instanceId: "11111111-1111-1111-1111-111111111111", pid, port: 12345,
    dataPath: "/test/data", ownerCredential: "b".repeat(64) };
}

function setOwner(pid = 41_234, phase: HostRuntimeStatus["phase"] = "ready"): void {
  currentMetadata = metadata(pid);
  currentLocked = true;
  livePids.add(pid);
  currentStatus = { pid, phase, ready: phase === "ready", dataPath: "/test/data", webPort: 8233, gatewayUrl: "ws://127.0.0.1:8233/ws" };
}

function supervisor(options: Partial<LocalServerSupervisorOptions> = {}): LocalServerSupervisor {
  const instance = new LocalServerSupervisor({
    dataPath: "/test/data", cwd: "/test/cwd", entryPath: "/test/server.cjs", execPath: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: "1" }, startupTimeoutMs: 200, stopTimeoutMs: 40, pollIntervalMs: 2, ...options,
  });
  supervisors.push(instance);
  return instance;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  supervisors = [];
  currentMetadata = null;
  currentLocked = false;
  child = new FakeChild();
  livePids = new Set([process.pid]);
  killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
    if (!livePids.has(pid)) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    return true;
  }) as typeof process.kill);
  mocks.read.mockImplementation(async () => currentMetadata ? { ...currentMetadata } : null);
  mocks.check.mockImplementation(async () => currentLocked);
  mocks.call.mockImplementation(async (_dataPath: string, method: string, _args: unknown[], options: { expectedInstanceId?: string }) => {
    if (!currentMetadata) throw new HostControlError("NOT_RUNNING", "No running host");
    if (options?.expectedInstanceId && options.expectedInstanceId !== currentMetadata.instanceId) {
      throw new HostControlError("INSTANCE_CHANGED", "Local owner changed");
    }
    if (method === "host:status") return { ...currentStatus };
    if (method === "host:stop") {
      const owned = currentMetadata.pid === child.pid;
      currentMetadata = null;
      currentLocked = false;
      if (owned) child.emit("exit", 0, null);
      return { stopping: true };
    }
    return { locale: "en" };
  });
  mocks.fork.mockImplementation(() => {
    queueMicrotask(() => setOwner(child.pid));
    return child as unknown as ChildProcess;
  });
});

afterEach(async () => {
  currentMetadata = null;
  currentLocked = false;
  child.kill.mockImplementation(() => { child.emit("exit", 0, null); return true; });
  child.disconnect.mockImplementation(() => { child.connected = false; child.emit("exit", 0, null); });
  await Promise.allSettled(supervisors.map(instance => instance.shutdown()));
  vi.restoreAllMocks();
});

describe("LocalServerSupervisor", () => {
  it("joins repeated starts, flushes settings before forking, and publishes only desktop-safe state", async () => {
    const flush = deferred();
    const beforeStart = vi.fn(() => flush.promise);
    const instance = supervisor({ beforeStart });
    const observed: unknown[] = [];
    const unsubscribe = instance.subscribe(state => { observed.push(state); state.pid = -1; });
    const start = instance.start();
    expect(instance.start()).toBe(start);
    await vi.waitFor(() => expect(beforeStart).toHaveBeenCalledOnce());
    expect(mocks.fork).not.toHaveBeenCalled();
    flush.resolve();
    await expect(start).resolves.toEqual({ phase: "ready", ownership: "owned", pid: child.pid, error: null });
    expect(instance.getState().pid).toBe(child.pid);
    expect(JSON.stringify(observed)).not.toContain("ownerCredential");
    expect(JSON.stringify(observed)).not.toContain("bbbbbbbb");
    unsubscribe();
    await instance.start();
    expect(mocks.fork).toHaveBeenCalledOnce();
  });

  it("uses argument-safe fork without a shell or inherited Electron debug arguments", async () => {
    const entryPath = "/test/space ; $(touch nope)/server.cjs";
    const cwd = "/test/work & tree";
    const instance = supervisor({ entryPath, cwd, env: { ELECTRON_RUN_AS_NODE: "1", CODEMUX_DATA_DIR: "/data/a b;$(nope)" } });
    await instance.start();
    expect(mocks.fork).toHaveBeenCalledWith(entryPath, [], {
      cwd, env: { ELECTRON_RUN_AS_NODE: "1", CODEMUX_DATA_DIR: "/data/a b;$(nope)" }, execPath: process.execPath,
      execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true,
      detached: process.platform !== "win32",
    });
  });

  it("dispatches notifications only from its owned child and pins management calls to the same host", async () => {
    const onNotification = vi.fn();
    const instance = supervisor({ onNotification });
    await expect(instance.invoke("settings:load")).rejects.toThrow("not ready");
    await instance.start();
    child.emit("message", { type: "codemux.notify", title: "Request", body: "Approval needed", ownerCredential: "secret" });
    child.emit("message", { type: "codemux.notify", title: 1, body: "Ignored" });
    child.emit("message", { type: "codemux.ready", title: "Ignored", body: "Ignored" });
    expect(onNotification).toHaveBeenCalledExactlyOnceWith({ title: "Request", body: "Approval needed" });
    await expect(instance.invoke("settings:load", [])).resolves.toEqual({ locale: "en" });
    expect(mocks.call).toHaveBeenLastCalledWith("/test/data", "settings:load", [], { expectedInstanceId: metadata().instanceId });
    await expect(instance.invoke("host:stop")).rejects.toThrow("stop operation");
    await instance.stop();
    child.emit("message", { type: "codemux.notify", title: "Late", body: "Ignored" });
    expect(onNotification).toHaveBeenCalledOnce();
  });

  it("attaches to an existing host without flushing or forking and leaves it running on app quit", async () => {
    setOwner(23_456);
    const beforeStart = vi.fn();
    const instance = supervisor({ beforeStart });
    await expect(instance.start()).resolves.toMatchObject({ phase: "ready", ownership: "external", pid: 23_456 });
    expect(beforeStart).not.toHaveBeenCalled();
    expect(mocks.fork).not.toHaveBeenCalled();
    await instance.shutdown();
    expect(mocks.call.mock.calls.map(call => call[1])).not.toContain("host:stop");
    expect(currentMetadata?.pid).toBe(23_456);
    expect(mocks.terminate).not.toHaveBeenCalled();
  });

  it.each(["ready", "starting"] as const)("rejects restarting an external %s host before sending stop or spawning a replacement", async (phase) => {
    setOwner(23_456, phase);
    const instance = supervisor();
    const starting = instance.start();
    await vi.waitFor(() => expect(instance.getState().ownership).toBe("external"));
    const state = instance.getState();
    await expect(instance.restart()).rejects.toThrow("original launcher");
    expect(instance.getState()).toEqual(state);
    expect(mocks.call.mock.calls.map(call => call[1])).not.toContain("host:stop");
    expect(mocks.fork).not.toHaveBeenCalled();
    expect(currentMetadata?.pid).toBe(23_456);
    currentStatus.phase = "ready";
    currentStatus.ready = true;
    await starting;
  });

  it("leaves an externally managed host untouched when it is discovered during a restart race", async () => {
    setOwner(23_456);
    const instance = supervisor();
    let restarting: Promise<unknown> | undefined;
    instance.subscribe(state => {
      if (state.phase === "starting" && state.ownership === null && !restarting) {
        // Queue the restart after startup has begun ownership discovery.
        restarting = Promise.resolve().then(() => instance.restart()).catch(error => error);
      }
    });
    await instance.start();
    await restarting;
    expect(mocks.call.mock.calls.map(call => call[1])).not.toContain("host:stop");
    expect(mocks.fork).not.toHaveBeenCalled();
    expect(currentMetadata?.pid).toBe(23_456);
  });

  it("allows an explicit external stop and waits for discovery and the writer lock to disappear", async () => {
    setOwner(23_456);
    const instance = supervisor();
    await instance.start();
    const original = mocks.call.getMockImplementation()!;
    mocks.call.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "host:stop") { currentMetadata = null; return { stopping: true }; }
      return original(...args);
    });
    const stopping = instance.stop();
    await vi.waitFor(() => expect(instance.getState().phase).toBe("stopping"));
    expect(instance.stop()).toBe(stopping);
    currentLocked = false;
    await expect(stopping).resolves.toMatchObject({ phase: "stopped", ownership: null, pid: null });
    expect(child.kill).not.toHaveBeenCalled();
    expect(mocks.terminate).not.toHaveBeenCalled();
  });

  it("waits for an existing starting host to settle before reporting ready", async () => {
    setOwner(23_456, "starting");
    const instance = supervisor();
    const starting = instance.start();
    await vi.waitFor(() => expect(instance.getState().ownership).toBe("external"));
    expect(instance.getState().phase).toBe("starting");
    currentStatus.phase = "ready";
    currentStatus.ready = true;
    await expect(starting).resolves.toMatchObject({ phase: "ready", ownership: "external" });
    expect(mocks.fork).not.toHaveBeenCalled();
  });

  it("does not fork while an owner has a lock but has not published discovery", async () => {
    currentLocked = true;
    const instance = supervisor();
    const starting = instance.start();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(mocks.fork).not.toHaveBeenCalled();
    setOwner(23_456);
    await expect(starting).resolves.toMatchObject({ phase: "ready", ownership: "external" });
    expect(mocks.fork).not.toHaveBeenCalled();
  });

  it("fails closed for unavailable discovery while the data directory remains locked", async () => {
    currentMetadata = metadata(23_456);
    currentLocked = true;
    mocks.call.mockRejectedValue(new HostControlError("UNAVAILABLE", "Unavailable"));
    const instance = supervisor({ startupTimeoutMs: 15 });
    await expect(instance.start()).rejects.toThrow("Timed out");
    expect(instance.getState().phase).toBe("error");
    expect(mocks.fork).not.toHaveBeenCalled();
    expect(mocks.terminate).not.toHaveBeenCalled();
  });

  it("does not replace an unavailable live owner even when its lock is absent", async () => {
    setOwner(23_456);
    currentLocked = false;
    mocks.call.mockRejectedValue(new HostControlError("UNAVAILABLE", "Unavailable"));
    const instance = supervisor({ startupTimeoutMs: 15 });
    await expect(instance.start()).rejects.toThrow("Timed out");
    expect(mocks.fork).not.toHaveBeenCalled();
  });

  it("replaces stale discovery only after the old process and writer lock are gone", async () => {
    currentMetadata = metadata(23_456);
    const original = mocks.call.getMockImplementation()!;
    mocks.call.mockImplementation(async (...args: unknown[]) => {
      if (currentMetadata?.pid === 23_456) throw new HostControlError("UNAVAILABLE", "Unavailable");
      return original(...args);
    });
    const instance = supervisor();
    await expect(instance.start()).resolves.toMatchObject({ phase: "ready", ownership: "owned" });
    expect(mocks.fork).toHaveBeenCalledOnce();
  });

  it.each(["desktopParentPid", "developmentParentPid"] as const)("waits out an orphan %s child instead of attaching to a host about to exit", async parent => {
    setOwner(23_456);
    currentStatus[parent] = 999;
    const instance = supervisor();
    const starting = instance.start();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(instance.getState().phase).toBe("starting");
    expect(instance.getState().ownership).toBeNull();
    expect(mocks.fork).not.toHaveBeenCalled();
    currentMetadata = null;
    currentLocked = false;
    livePids.delete(23_456);
    await expect(starting).resolves.toMatchObject({ phase: "ready", ownership: "owned" });
  });

  it.each(["desktopParentPid", "developmentParentPid"] as const)("treats EPERM as a live %s parent rather than taking over its host", async parent => {
    setOwner(23_456);
    currentStatus[parent] = 999;
    killSpy.mockImplementation(() => { throw Object.assign(new Error("Denied"), { code: "EPERM" }); });
    const instance = supervisor();
    await expect(instance.start()).resolves.toMatchObject({ phase: "ready", ownership: "external" });
    expect(mocks.fork).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid development parent PID %s before attaching", async pid => {
    setOwner(23_456);
    currentStatus.developmentParentPid = pid;
    await expect(supervisor().start()).rejects.toThrow("invalid owner status");
    expect(mocks.fork).not.toHaveBeenCalled();
  });

  it("cancels a pending settings flush without forking and joins the flush on the next start", async () => {
    const flush = deferred();
    const beforeStart = vi.fn(() => flush.promise);
    const instance = supervisor({ beforeStart });
    const starting = instance.start();
    await vi.waitFor(() => expect(beforeStart).toHaveBeenCalledOnce());
    await expect(instance.stop()).resolves.toMatchObject({ phase: "stopped" });
    await starting;
    expect(mocks.fork).not.toHaveBeenCalled();
    const restarted = instance.start();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(beforeStart).toHaveBeenCalledOnce();
    flush.resolve();
    await expect(restarted).resolves.toMatchObject({ phase: "ready" });
  });

  it("rechecks the owner after settings persistence and attaches to a host that won the race", async () => {
    const instance = supervisor({ beforeStart: async () => { setOwner(23_456); } });
    await expect(instance.start()).resolves.toMatchObject({ ownership: "external" });
    expect(mocks.fork).not.toHaveBeenCalled();
  });

  it("retires its losing fork before attaching to an external host that wins the writer lock", async () => {
    child.kill.mockImplementation(() => { child.emit("exit", 1, null); return true; });
    child.disconnect.mockImplementation(() => { child.connected = false; child.emit("exit", 1, null); });
    mocks.fork.mockImplementation(() => {
      queueMicrotask(() => setOwner(23_456));
      return child as unknown as ChildProcess;
    });
    const instance = supervisor();
    await expect(instance.start()).resolves.toMatchObject({ phase: "ready", ownership: "external", pid: 23_456 });
    if (process.platform === "win32") {
      expect(child.disconnect).toHaveBeenCalledOnce();
      expect(child.kill).not.toHaveBeenCalled();
    } else expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await instance.shutdown();
    expect(currentMetadata?.pid).toBe(23_456);
    expect(mocks.call.mock.calls.map(call => call[1])).not.toContain("host:stop");
    expect(mocks.terminate).not.toHaveBeenCalled();
  });

  it("cleans up only the losing owned fork when quit races with another host's startup", async () => {
    child.kill.mockImplementation(() => { child.emit("exit", 1, null); return true; });
    child.disconnect.mockImplementation(() => { child.connected = false; child.emit("exit", 1, null); });
    mocks.fork.mockImplementation(() => child as unknown as ChildProcess);
    const instance = supervisor();
    const starting = instance.start();
    await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalledOnce());
    setOwner(23_456);
    await instance.shutdown();
    await starting;
    expect(instance.getState().phase).toBe("stopped");
    expect(currentMetadata?.pid).toBe(23_456);
    expect(mocks.call.mock.calls.map(call => call[1])).not.toContain("host:stop");
  });

  it("reports spawn errors and does not enter an automatic restart loop", async () => {
    mocks.fork.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child as unknown as ChildProcess;
    });
    const instance = supervisor();
    await expect(instance.start()).rejects.toThrow("could not be started");
    expect(instance.getState().phase).toBe("error");
    expect(mocks.fork).toHaveBeenCalledOnce();
  });

  it("does not mistake stale ready status from an exited owned child for an external host", async () => {
    mocks.fork.mockImplementation(() => {
      queueMicrotask(() => { setOwner(child.pid); child.emit("exit", 1, null); });
      return child as unknown as ChildProcess;
    });
    const instance = supervisor({ startupTimeoutMs: 15 });
    await expect(instance.start()).rejects.toThrow("Timed out");
    expect(instance.getState().phase).toBe("error");
    expect(instance.getState().ownership).toBe("owned");
  });

  it("stops an owned child cancelled before its control listener is published", async () => {
    mocks.fork.mockImplementation(() => child as unknown as ChildProcess);
    const instance = supervisor();
    const starting = instance.start();
    await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalledOnce());
    await expect(instance.stop()).resolves.toMatchObject({ phase: "stopped" });
    await starting;
    if (process.platform === "win32") {
      expect(child.disconnect).toHaveBeenCalledOnce();
      expect(child.kill).not.toHaveBeenCalled();
    } else expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });

  describe("Windows shutdown fallbacks", () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    function failStopRequest(): void {
      const original = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args: unknown[]) => {
        if (args[1] === "host:stop") throw new HostControlError("UNAVAILABLE", "Control request timed out");
        return original(...args);
      });
    }

    it("disconnects IPC and waits for persisted state when the control stop request times out", async () => {
      const instance = supervisor();
      await instance.start();
      failStopRequest();
      let persisted = false;
      child.disconnect.mockImplementation(() => {
        child.connected = false;
        setTimeout(() => {
          persisted = true;
          currentMetadata = null;
          currentLocked = false;
          child.emit("exit", 0, null);
        }, 5);
      });

      await expect(instance.stop()).resolves.toMatchObject({ phase: "stopped" });
      expect(persisted).toBe(true);
      expect(child.disconnect).toHaveBeenCalledOnce();
      expect(child.kill).not.toHaveBeenCalled();
      expect(mocks.terminate).not.toHaveBeenCalled();
    });

    it("disconnects a cancelled child that has not published its control listener", async () => {
      mocks.fork.mockImplementation(() => child as unknown as ChildProcess);
      const instance = supervisor();
      const starting = instance.start();
      await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalledOnce());

      await expect(instance.stop()).resolves.toMatchObject({ phase: "stopped" });
      await starting;
      expect(child.disconnect).toHaveBeenCalledOnce();
      expect(child.kill).not.toHaveBeenCalled();
      expect(mocks.terminate).not.toHaveBeenCalled();
    });

    it.each(["connected", "disconnected", "disconnect-error"] as const)(
      "retains tree ownership until the grace period expires for an unresponsive %s child",
      async state => {
        const instance = supervisor({ stopTimeoutMs: 10 });
        await instance.start();
        failStopRequest();
        const order: string[] = [];
        let exited = false;
        child.once("exit", () => { exited = true; order.push("exit"); });
        child.connected = state !== "disconnected";
        child.disconnect.mockImplementation(() => {
          order.push("disconnect");
          if (state === "disconnect-error") throw new Error("IPC channel unavailable");
          child.connected = false;
        });
        mocks.terminate.mockImplementation((pid: number) => {
          expect(pid).toBe(child.pid);
          expect(exited).toBe(false);
          order.push("terminate-tree");
          currentMetadata = null;
          currentLocked = false;
          child.emit("exit", null, "SIGKILL");
        });

        await expect(instance.stop()).resolves.toMatchObject({ phase: "stopped" });
        expect(order).toEqual([
          ...(state === "disconnected" ? [] : ["disconnect"]), "terminate-tree", "exit",
        ]);
        expect(mocks.terminate).toHaveBeenCalledExactlyOnceWith(child.pid);
        expect(child.kill).not.toHaveBeenCalled();
      },
    );

    it.each(["graceful", "unresponsive"] as const)(
      "retires a %s losing fork without stopping the replacement owner",
      async state => {
        mocks.fork.mockImplementation(() => {
          queueMicrotask(() => setOwner(23_456));
          return child as unknown as ChildProcess;
        });
        let exited = false;
        child.once("exit", () => { exited = true; });
        child.disconnect.mockImplementation(() => {
          child.connected = false;
          if (state === "graceful") child.emit("exit", 0, null);
        });
        mocks.terminate.mockImplementation((pid: number) => {
          expect(pid).toBe(child.pid);
          expect(exited).toBe(false);
          child.emit("exit", null, "SIGKILL");
        });
        const instance = supervisor({ stopTimeoutMs: 10 });

        await expect(instance.start()).resolves.toMatchObject({ phase: "ready", ownership: "external", pid: 23_456 });
        expect(child.disconnect).toHaveBeenCalledOnce();
        expect(child.kill).not.toHaveBeenCalled();
        expect(mocks.terminate).toHaveBeenCalledTimes(state === "unresponsive" ? 1 : 0);
        await instance.shutdown();
        expect(currentMetadata?.pid).toBe(23_456);
        expect(mocks.call.mock.calls.map(call => call[1])).not.toContain("host:stop");
      },
    );
  });

  it("waits for the old owned child to exit before restart can fork its replacement", async () => {
    const instance = supervisor();
    await instance.start();
    const original = mocks.call.getMockImplementation()!;
    mocks.call.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "host:stop") { currentMetadata = null; currentLocked = false; return { stopping: true }; }
      return original(...args);
    });
    const restarting = instance.restart();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(mocks.fork).toHaveBeenCalledOnce();
    const oldChild = child;
    child = new FakeChild();
    child.pid++;
    oldChild.emit("exit", 0, null);
    await expect(restarting).resolves.toMatchObject({ phase: "ready", pid: child.pid });
    expect(mocks.fork).toHaveBeenCalledTimes(2);
    mocks.call.mockImplementation(original);
  });

  it.each([
    { launch: "restart", cancel: "shutdown" },
    { launch: "queued start", cancel: "shutdown" },
    { launch: "restart", cancel: "stop" },
    { launch: "queued start", cancel: "stop" },
  ] as const)("cancels $launch after a later $cancel joins the pending stop and allows a future explicit start", async ({ launch, cancel }) => {
    const instance = supervisor();
    await instance.start();
    const original = mocks.call.getMockImplementation()!;
    const stopRequested = deferred();
    mocks.call.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "host:stop") {
        currentMetadata = null;
        currentLocked = false;
        stopRequested.resolve();
        return { stopping: true };
      }
      return original(...args);
    });
    const stopping = launch === "restart" ? instance.restart() : instance.stop();
    const queuedLaunch = launch === "queued start" ? instance.start() : stopping;
    await stopRequested.promise;
    expect(mocks.fork).toHaveBeenCalledOnce();
    const cancelled = cancel === "shutdown" ? instance.shutdown() : instance.stop();
    child.emit("exit", 0, null);
    await Promise.all([stopping, queuedLaunch, cancelled]);
    expect(instance.getState()).toMatchObject({ phase: "stopped", ownership: null });
    expect(mocks.fork).toHaveBeenCalledOnce();

    // A failed installer can explicitly resume the host after shutdown has completed.
    mocks.call.mockImplementation(original);
    child = new FakeChild();
    child.pid++;
    await expect(instance.start()).resolves.toMatchObject({ phase: "ready", ownership: "owned", pid: child.pid });
    expect(mocks.fork).toHaveBeenCalledTimes(2);
  });

  it("records unexpected owned exits without automatically restarting", async () => {
    const instance = supervisor();
    await instance.start();
    child.emit("exit", 3, null);
    currentLocked = false;
    currentMetadata = null;
    expect(instance.getState()).toMatchObject({ phase: "error", ownership: "owned", error: "Local server exited (code 3)" });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(mocks.fork).toHaveBeenCalledOnce();
    await expect(instance.stop()).resolves.toMatchObject({ phase: "stopped" });
  });

  it.each([0, 17])("cleans only its detached owned process group after child exit code %i", async (code) => {
    const instance = supervisor();
    await instance.start();
    child.emit("exit", code, null);
    if (process.platform === "win32") {
      expect(killSpy.mock.calls.filter(call => Number(call[0]) < 0)).toEqual([]);
    } else {
      expect(killSpy).toHaveBeenCalledWith(-child.pid, "SIGKILL");
      expect(killSpy.mock.calls.filter(call => Number(call[0]) < 0)).toEqual([[-child.pid, "SIGKILL"]]);
    }
    currentMetadata = null;
    currentLocked = false;
  });

  it("never sends a process-group signal for an external owner", async () => {
    setOwner(23_456);
    const instance = supervisor();
    await instance.start();
    await instance.stop();
    expect(killSpy.mock.calls.filter(call => Number(call[0]) < 0)).toEqual([]);
  });

  it("rejects malformed or mismatched status instead of treating it as an owner", async () => {
    setOwner(23_456);
    currentStatus.pid++;
    const instance = supervisor();
    await expect(instance.start()).rejects.toThrow("invalid owner status");
    expect(mocks.fork).not.toHaveBeenCalled();
    expect(mocks.terminate).not.toHaveBeenCalled();
  });

  it("rejects invalid metadata without spawning or changing the data directory", async () => {
    mocks.read.mockRejectedValue(new HostControlError("INVALID_METADATA", "Invalid metadata"));
    const instance = supervisor();
    await expect(instance.start()).rejects.toThrow("Invalid metadata");
    expect(mocks.fork).not.toHaveBeenCalled();
    mocks.read.mockResolvedValue(null);
  });

  it("does not direct a stop or invoke to a replacement owner", async () => {
    setOwner(23_456);
    const instance = supervisor();
    await instance.start();
    currentMetadata!.instanceId = "22222222-2222-2222-2222-222222222222";
    const expected = metadata().instanceId;
    mocks.call.mockImplementation(async (_path: string, _method: string, _args: unknown[], options: { expectedInstanceId: string }) => {
      expect(options.expectedInstanceId).toBe(expected);
      throw new HostControlError("INSTANCE_CHANGED", "Local owner changed");
    });
    await expect(instance.invoke("settings:load")).rejects.toThrow("owner changed");
    await expect(instance.stop()).rejects.toThrow("owner changed");
    expect(mocks.terminate).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("finishes a stop when an external host has already removed discovery and released ownership", async () => {
    setOwner(23_456);
    const instance = supervisor();
    await instance.start();
    currentMetadata = null;
    currentLocked = false;
    await expect(instance.stop()).resolves.toMatchObject({ phase: "stopped", ownership: null });
    expect(mocks.terminate).not.toHaveBeenCalled();
  });

  it("reports an externally stopped host through its low-frequency health monitor", async () => {
    vi.useFakeTimers();
    try {
      setOwner(23_456);
      const instance = supervisor();
      await instance.start();
      const callsAfterStart = mocks.call.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_999);
      expect(mocks.call).toHaveBeenCalledTimes(callsAfterStart);
      currentMetadata = null;
      await vi.advanceTimersByTimeAsync(1);
      expect(instance.getState()).toMatchObject({ phase: "error", error: "Local server is no longer available" });
      await instance.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never force-kills an external server that ignores an explicit stop", async () => {
    setOwner(23_456);
    const instance = supervisor({ stopTimeoutMs: 10 });
    await instance.start();
    const original = mocks.call.getMockImplementation()!;
    mocks.call.mockImplementation(async (...args: unknown[]) => args[1] === "host:stop" ? { stopping: true } : original(...args));
    await expect(instance.stop()).rejects.toThrow("Timed out");
    expect(mocks.terminate).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("force-kills only its exact owned process tree when graceful shutdown times out", async () => {
    const instance = supervisor({ stopTimeoutMs: 10 });
    await instance.start();
    const original = mocks.call.getMockImplementation()!;
    mocks.call.mockImplementation(async (...args: unknown[]) => args[1] === "host:stop" ? { stopping: true } : original(...args));
    mocks.terminate.mockImplementation((pid: number) => {
      expect(pid).toBe(child.pid);
      currentMetadata = null;
      currentLocked = false;
      child.emit("exit", null, "SIGKILL");
    });
    await expect(instance.stop()).resolves.toMatchObject({ phase: "stopped" });
    expect(mocks.terminate).toHaveBeenCalledExactlyOnceWith(child.pid);
  });

  it("does not restart while a terminated child's writer lock remains held", async () => {
    const instance = supervisor({ stopTimeoutMs: 10 });
    await instance.start();
    const original = mocks.call.getMockImplementation()!;
    mocks.call.mockImplementation(async (...args: unknown[]) => args[1] === "host:stop" ? { stopping: true } : original(...args));
    mocks.terminate.mockImplementation(() => child.emit("exit", null, "SIGKILL"));
    await expect(instance.restart()).rejects.toThrow("data directory remains in use");
    expect(mocks.fork).toHaveBeenCalledOnce();
  });

  it("survives listener and notification failures without affecting host readiness", async () => {
    const instance = supervisor({ onNotification: () => { throw new Error("Desktop unavailable"); } });
    instance.subscribe(() => { throw new Error("Window destroyed"); });
    await expect(instance.start()).resolves.toMatchObject({ phase: "ready" });
    expect(() => child.emit("message", { type: "codemux.notify", title: "Title", body: "Body" })).not.toThrow();
  });

  it.skipIf(process.platform === "win32")("cleans real nested children after its group leader crashes while a sibling survives", async () => {
    killSpy.mockRestore();
    const realChild = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const realControl = await vi.importActual<typeof import("../../../shared/host-control-client")>("../../../shared/host-control-client");
    const realLock = await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile");
    mocks.fork.mockImplementation(realChild.fork);
    mocks.read.mockImplementation(realControl.readHostControlMetadata);
    mocks.call.mockImplementation(realControl.callHost);
    mocks.check.mockImplementation(realLock.check);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codemux-supervisor-crash-"));
    const dataPath = await fs.realpath(root);
    const workerPath = path.join(root, "worker.cjs");
    const entryPath = path.join(root, "host.cjs");
    await fs.writeFile(workerPath, `
const { spawn } = require('node:child_process');
const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
nested.once('spawn', () => process.send({workerPid:process.pid, nestedPid:nested.pid}));
process.on('disconnect', () => {});
setInterval(() => {}, 1000);
`);
    await fs.writeFile(entryPath, `
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
(async () => {
  const dataPath = await fs.realpath(process.env.TEST_DATA_PATH);
  const credential = 'a'.repeat(64);
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const {method} = JSON.parse(body);
    if (req.headers.authorization !== 'Bearer ' + credential) {res.writeHead(401);res.end('{}');return;}
    const result = {pid:process.pid, phase:'ready', ready:true, dataPath, webPort:8233, gatewayUrl:null};
    res.setHeader('Connection', 'close');
    res.end(JSON.stringify({result}));
    if (method === 'host:stop') server.close(() => process.exit(0));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const instanceId = randomUUID();
  const temporaryPath = path.join(dataPath, '.runtime-control.' + instanceId + '.tmp');
  await fs.writeFile(temporaryPath, JSON.stringify({version:1, instanceId, pid:process.pid, port:server.address().port, dataPath, ownerCredential:credential}), {flag:'wx',mode:0o600});
  await fs.rename(temporaryPath, path.join(dataPath, 'runtime-control.json'));
  const worker = fork(process.env.TEST_WORKER_PATH, [], {stdio:['ignore','ignore','ignore','ipc']});
  worker.once('message', pids => process.send({type:'codemux.notify',title:'Descendants ready',body:JSON.stringify(pids)}));
})().catch(error => {console.error(error);process.exit(1);});
`);
    const sibling = realChild.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const siblingExited = new Promise<void>(resolve => sibling.once("exit", () => resolve()));
    const isRunning = (pid: number) => {
      try {
        const status = realChild.execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        // Linux may briefly retain an exited orphan as a zombie until init reaps it.
        return status.length > 0 && !status.startsWith("Z");
      } catch { return false; }
    };
    const processGroup = (pid: number) => Number(realChild.execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
    let workerPid: number | undefined;
    let nestedPid: number | undefined;
    let leaderPid: number | null = null;
    const instance = supervisor({ dataPath, cwd: root, entryPath, execPath: process.execPath,
      env: { ...process.env, TEST_DATA_PATH: dataPath, TEST_WORKER_PATH: workerPath }, startupTimeoutMs: 5_000, stopTimeoutMs: 1_000, pollIntervalMs: 10,
      onNotification(notification) {
        if (notification.title === "Descendants ready") {
          const pids = JSON.parse(notification.body) as { workerPid: number; nestedPid: number };
          workerPid = pids.workerPid;
          nestedPid = pids.nestedPid;
        }
      },
    });
    try {
      await new Promise<void>((resolve, reject) => { sibling.once("spawn", resolve); sibling.once("error", reject); });
      const started = await instance.start();
      leaderPid = started.pid;
      await vi.waitFor(() => { expect(workerPid).toBeGreaterThan(0); expect(nestedPid).toBeGreaterThan(0); });
      expect(isRunning(workerPid!)).toBe(true);
      expect(isRunning(nestedPid!)).toBe(true);
      expect(processGroup(leaderPid!)).toBe(leaderPid);
      expect(processGroup(workerPid!)).toBe(leaderPid);
      expect(processGroup(nestedPid!)).toBe(leaderPid);
      expect(processGroup(sibling.pid!)).not.toBe(leaderPid);
      process.kill(leaderPid!, "SIGKILL");
      await vi.waitFor(() => expect(instance.getState()).toMatchObject({ phase: "error", error: "Local server exited (signal SIGKILL)" }));
      await vi.waitFor(() => { expect(isRunning(workerPid!)).toBe(false); expect(isRunning(nestedPid!)).toBe(false); }, { timeout: 4_000, interval: 25 });
      expect(isRunning(sibling.pid!)).toBe(true);
      expect(isRunning(process.pid)).toBe(true);
      expect(mocks.terminate).not.toHaveBeenCalled();
    } finally {
      for (const pid of [leaderPid, workerPid, nestedPid]) {
        if (pid && isRunning(pid)) process.kill(pid, "SIGKILL");
      }
      sibling.kill("SIGKILL");
      await siblingExited;
      await instance.shutdown();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["control", "fallback"] as const)("starts and restarts a real IPC child through %s shutdown using paths with spaces and shell punctuation", async stopTransport => {
    killSpy.mockRestore();
    const realChild = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const realControl = await vi.importActual<typeof import("../../../shared/host-control-client")>("../../../shared/host-control-client");
    const realLock = await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile");
    mocks.fork.mockImplementation(realChild.fork);
    mocks.read.mockImplementation(realControl.readHostControlMetadata);
    mocks.call.mockImplementation((...args: Parameters<typeof realControl.callHost>) => {
      if (stopTransport === "fallback" && args[1] === "host:stop") {
        return Promise.reject(new HostControlError("UNAVAILABLE", "Control request timed out"));
      }
      return realControl.callHost(...args);
    });
    mocks.check.mockImplementation(realLock.check);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codemux supervisor ; $-"));
    const dataPath = path.join(root, "runtime data");
    await fs.mkdir(dataPath);
    const canonicalPath = await fs.realpath(dataPath);
    const entryPath = path.join(root, "child ; literal.cjs");
    const lockModule = createRequire(import.meta.url).resolve("proper-lockfile");
    await fs.writeFile(entryPath, `
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
(async () => {
  const dataPath = await fs.realpath(process.env.TEST_DATA_PATH);
  const release = await require(${JSON.stringify(lockModule)}).lock(dataPath, {stale: 30000, update: 10000});
  const filename = path.join(dataPath, 'runtime-control.json');
  const credential = 'a'.repeat(64);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await new Promise(resolve => server.close(resolve));
    await fs.unlink(filename);
    await fs.writeFile(path.join(dataPath, 'shutdown.json'), JSON.stringify({pid:process.pid}));
    await release();
    if (process.connected) process.disconnect();
  };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const { method, args } = JSON.parse(body);
    if (req.headers.authorization !== 'Bearer ' + credential) { res.writeHead(401); res.end('{}'); return; }
    let result;
    if (method === 'host:status') result = {pid:process.pid, phase:'ready', ready:true, dataPath, webPort:8233, gatewayUrl:null};
    else if (method === 'host:stop') {result = {stopping:true}; res.once('finish', stop);}
    else result = {method,args};
    res.setHeader('Connection','close'); res.end(JSON.stringify({result}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.on('SIGTERM', stop);
  process.on('disconnect', stop);
  const instanceId = randomUUID();
  const temporaryPath = path.join(dataPath, '.runtime-control.' + instanceId + '.tmp');
  await fs.writeFile(temporaryPath, JSON.stringify({version:1, instanceId, pid:process.pid, port:server.address().port,dataPath,ownerCredential:credential}), {flag:'wx',mode:0o600});
  await fs.rename(temporaryPath, filename);
  process.send({type:'codemux.notify',title:'Child ready',body:'IPC works'});
})().catch(error => { console.error(error); process.exit(1); });
`);
    const onNotification = vi.fn();
    const instance = supervisor({ dataPath: canonicalPath, cwd: root, entryPath, execPath: process.execPath,
      env: { ...process.env, TEST_DATA_PATH: canonicalPath }, startupTimeoutMs: 5_000, stopTimeoutMs: 3_000, pollIntervalMs: 10, onNotification });
    try {
      const started = await instance.start();
      expect(started).toMatchObject({ phase: "ready", ownership: "owned" });
      expect(started.pid).toBeGreaterThan(0);
      await vi.waitFor(() => expect(onNotification).toHaveBeenCalledWith({ title: "Child ready", body: "IPC works" }));
      await expect(instance.invoke("settings:load", ["literal;$(no shell)"])).resolves.toEqual({ method: "settings:load", args: ["literal;$(no shell)"] });
      const restarted = await instance.restart();
      expect(restarted.phase).toBe("ready");
      expect(restarted.pid).not.toBe(started.pid);
      expect(JSON.parse(await fs.readFile(path.join(dataPath, "shutdown.json"), "utf8"))).toEqual({ pid: started.pid });
      await instance.shutdown();
      expect(instance.getState().phase).toBe("stopped");
      expect(JSON.parse(await fs.readFile(path.join(dataPath, "shutdown.json"), "utf8"))).toEqual({ pid: restarted.pid });
      expect(await realControl.readHostControlMetadata(canonicalPath)).toBeNull();
      expect(await realLock.check(canonicalPath)).toBe(false);
      expect(mocks.terminate).not.toHaveBeenCalled();
    } finally {
      await instance.shutdown();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
