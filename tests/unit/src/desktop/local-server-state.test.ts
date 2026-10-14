import { describe, expect, it, vi } from "vitest";
import type { LocalServerState } from "../../../../shared/local-server-types";
import { initialLocalServerView, observeLocalServer, receiveLocalServerState } from "../../../../src/desktop/local-server-state";

function state(phase: LocalServerState["phase"]): LocalServerState {
  return { phase, ownership: "owned", pid: phase === "stopped" ? null : 42, error: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createAPI() {
  const initial = deferred<LocalServerState>();
  const command = deferred<LocalServerState>();
  const unsubscribe = vi.fn();
  let listener!: (state: LocalServerState) => void;
  const api = {
    getState: vi.fn(() => initial.promise),
    onStateChange: vi.fn((callback: typeof listener) => {
      listener = callback;
      return unsubscribe;
    }),
    start: vi.fn(() => command.promise),
    stop: vi.fn(() => command.promise),
    restart: vi.fn(() => command.promise),
  };
  return { api, initial, command, unsubscribe, emit: (value: LocalServerState) => listener(value) };
}

describe("receiveLocalServerState", () => {
  it.each(["stopped", "starting", "stopping", "error"] as const)("keeps the initial %s host in management until it is ready", (phase) => {
    const view = receiveLocalServerState(initialLocalServerView, state(phase));
    expect(view.hasBeenReady).toBe(false);
    expect(view.managerVisible).toBe(true);
  });

  it("keeps the business tree available throughout stop, crash, and recovery", () => {
    let view = receiveLocalServerState(initialLocalServerView, state("ready"));
    expect(view).toMatchObject({ hasBeenReady: true, managerVisible: false });

    for (const phase of ["stopping", "stopped", "starting", "error"] as const) {
      view = receiveLocalServerState(view, state(phase));
      expect(view.hasBeenReady).toBe(true);
      expect(view.managerVisible).toBe(true);
    }

    view = receiveLocalServerState(view, state("ready"));
    expect(view).toMatchObject({ hasBeenReady: true, managerVisible: false });
  });

  it("respects dismissal until the host enters a different unavailable state", () => {
    const ready = receiveLocalServerState(initialLocalServerView, state("ready"));
    const stopped = receiveLocalServerState(ready, state("stopped"));
    const dismissed = { ...stopped, managerVisible: false };
    expect(receiveLocalServerState(dismissed, state("stopped")).managerVisible).toBe(false);
    expect(receiveLocalServerState(dismissed, state("error")).managerVisible).toBe(true);
  });

  it("keeps a manually opened manager visible when a ready snapshot is repeated", () => {
    const ready = receiveLocalServerState(initialLocalServerView, state("ready"));
    const opened = { ...ready, managerVisible: true };
    expect(receiveLocalServerState(opened, state("ready")).managerVisible).toBe(true);
  });
});

describe("observeLocalServer", () => {
  it("subscribes before reading and accepts an initial snapshot without newer events", async () => {
    const { api, initial } = createAPI();
    const onState = vi.fn();
    const observer = observeLocalServer(api, onState, vi.fn());
    expect(api.onStateChange.mock.invocationCallOrder[0]).toBeLessThan(api.getState.mock.invocationCallOrder[0]);
    initial.resolve(state("stopped"));
    await initial.promise;
    expect(onState).toHaveBeenCalledExactlyOnceWith(state("stopped"));
    observer.dispose();
  });

  it("ignores an obsolete initial snapshot after the ready event", async () => {
    const { api, initial, emit } = createAPI();
    const onState = vi.fn();
    const observer = observeLocalServer(api, onState, vi.fn());
    emit(state("ready"));
    initial.resolve(state("starting"));
    await initial.promise;
    expect(onState).toHaveBeenCalledExactlyOnceWith(state("ready"));
    observer.dispose();
  });

  it("ignores a failed initial query after a newer host event", async () => {
    const { api, initial, emit } = createAPI();
    const onError = vi.fn();
    const observer = observeLocalServer(api, vi.fn(), onError);
    emit(state("ready"));
    initial.reject(new Error("obsolete read"));
    await initial.promise.catch(() => undefined);
    expect(onError).not.toHaveBeenCalled();
    observer.dispose();
  });

  it("reports an initial failure so management can offer recovery", async () => {
    const { api, initial } = createAPI();
    const onError = vi.fn();
    const observer = observeLocalServer(api, vi.fn(), onError);
    const error = new Error("host unavailable");
    initial.reject(error);
    await initial.promise.catch(() => undefined);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    observer.dispose();
  });

  it("accepts a command response while discarding its older initial query", async () => {
    const { api, initial, command } = createAPI();
    const onState = vi.fn();
    const observer = observeLocalServer(api, onState, vi.fn());
    const started = observer.run("start");
    command.resolve(state("ready"));
    await started;
    initial.resolve(state("stopped"));
    await initial.promise;
    expect(api.start).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenCalledExactlyOnceWith(state("ready"));
    observer.dispose();
  });

  it("ignores a delayed command response after a newer crash event", async () => {
    const { api, command, emit } = createAPI();
    const onState = vi.fn();
    const observer = observeLocalServer(api, onState, vi.fn());
    const restarted = observer.run("restart");
    emit(state("error"));
    command.resolve(state("ready"));
    await restarted;
    expect(onState).toHaveBeenCalledExactlyOnceWith(state("error"));
    observer.dispose();
  });

  it("leaves the current state intact and returns an explicit command failure", async () => {
    const { api, command, emit } = createAPI();
    const onState = vi.fn();
    const observer = observeLocalServer(api, onState, vi.fn());
    emit(state("ready"));
    const stopped = observer.run("stop");
    command.reject(new Error("stop failed"));
    await expect(stopped).rejects.toThrow("stop failed");
    expect(onState).toHaveBeenCalledExactlyOnceWith(state("ready"));
    observer.dispose();
  });

  it("unsubscribes and ignores pending reads, commands, and events after disposal", async () => {
    const { api, initial, command, emit, unsubscribe } = createAPI();
    const onState = vi.fn();
    const observer = observeLocalServer(api, onState, vi.fn());
    const started = observer.run("start");
    observer.dispose();
    emit(state("ready"));
    initial.resolve(state("stopped"));
    command.resolve(state("ready"));
    await Promise.all([initial.promise, started]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(onState).not.toHaveBeenCalled();
  });
});
