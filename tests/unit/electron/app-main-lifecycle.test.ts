import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcHandlerDependencies } from "../../../electron/main/ipc-handlers";
import type { LocalServerSupervisorOptions } from "../../../electron/main/local-server-supervisor";
import type { LocalServerState } from "../../../shared/local-server-types";

const mocks = vi.hoisted(() => {
  const state: LocalServerState = { phase: "stopped", ownership: null, pid: null, error: null };
  const supervisor = {
    getState: vi.fn(() => state),
    start: vi.fn<() => Promise<LocalServerState>>(),
    stop: vi.fn(),
    restart: vi.fn(),
    shutdown: vi.fn<() => Promise<void>>(),
    invoke: vi.fn(),
    subscribe: vi.fn(),
  };
  return {
    app: {
      isPackaged: true,
      requestSingleInstanceLock: vi.fn(() => true),
      whenReady: vi.fn<() => Promise<void>>(),
      on: vi.fn(),
      quit: vi.fn(),
      exit: vi.fn(),
      getVersion: vi.fn(() => "1.2.3"),
      getPath: vi.fn((name: string) => `/fixture/${name}`),
    },
    supervisor,
    createSupervisor: vi.fn(function (_options: LocalServerSupervisorOptions) { return supervisor; }),
    runtimeHost: { usesSharedDevDeviceStore: false, appPath: "/fixture/app", resourcesPath: "/fixture/resources" },
    flushDesktopSettings: vi.fn<() => Promise<void>>(),
    registerIpcHandlers: vi.fn<(dependencies: IpcHandlerDependencies) => void>(),
    ipcHandle: vi.fn(),
    createWindow: vi.fn(),
    updateManager: { init: vi.fn(), setInstallErrorHandler: vi.fn<(handler: () => void) => void>() },
    trayManager: { init: vi.fn(), destroy: vi.fn() },
    mainLog: { error: vi.fn(), warn: vi.fn() },
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: mocks.ipcHandle },
  Notification: { isSupported: () => false },
  shell: { openPath: vi.fn() },
}));
vi.mock("shell-env", () => ({ shellEnvSync: () => ({ CODEMUX_CUSTOM_SETTING: "shell override" }) }));
vi.mock("../../../electron/main/services/logger", () => ({
  default: { transports: { file: { level: "warn" } } },
  mainLog: mocks.mainLog,
  getLogFilePath: () => "/fixture/logs/main.log",
  loadSettings: () => ({ locale: "en" }),
}));
vi.mock("../../../electron/main/window-manager", () => ({ createWindow: mocks.createWindow, getMainWindow: () => null }));
vi.mock("../../../electron/main/ipc-handlers", () => ({ registerIpcHandlers: mocks.registerIpcHandlers }));
vi.mock("../../../electron/main/services/update-manager", () => ({ updateManager: mocks.updateManager }));
vi.mock("../../../electron/main/services/tray-manager", () => ({ trayManager: mocks.trayManager }));
vi.mock("../../../electron/main/runtime-host", () => ({ runtimeHost: mocks.runtimeHost }));
vi.mock("../../../electron/main/services/app-paths", () => ({
  getUserDataPath: () => "/fixture/data", getDevicesPath: () => "/fixture/legacy/.devices.json",
}));
vi.mock("../../../electron/main/desktop-settings", () => ({ flushDesktopSettings: mocks.flushDesktopSettings }));
vi.mock("../../../electron/main/local-server-supervisor", () => ({ LocalServerSupervisor: mocks.createSupervisor }));
vi.mock("../../../shared/http-utils", () => ({ getLocalIp: () => "192.0.2.1" }));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function startDesktop() {
  const ready = deferred();
  mocks.app.whenReady.mockReturnValue(ready.promise);
  const entry = await import("../../../electron/main/app-main");
  ready.resolve();
  await vi.waitFor(() => expect(mocks.createWindow).toHaveBeenCalledOnce());
  return entry;
}

function beforeQuit(): (event: { preventDefault: () => void }) => void {
  const listener = mocks.app.on.mock.calls.find(([event]) => event === "before-quit")?.[1];
  if (!listener) throw new Error("Missing before-quit listener");
  return listener;
}

function beforeInstall(): () => Promise<void> {
  const callback = mocks.registerIpcHandlers.mock.calls[0]?.[0].beforeInstall;
  if (!callback) throw new Error("Missing beforeInstall callback");
  return callback;
}

function runtimeHandler(channel: string): () => unknown {
  const listener = mocks.ipcHandle.mock.calls.find(([name]) => name === channel)?.[1];
  if (!listener) throw new Error(`Missing ${channel} handler`);
  return listener;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.app.isPackaged = true;
  mocks.runtimeHost.usesSharedDevDeviceStore = false;
  mocks.supervisor.getState.mockReturnValue({ phase: "stopped", ownership: null, pid: null, error: null });
  mocks.supervisor.start.mockResolvedValue(mocks.supervisor.getState());
  mocks.supervisor.shutdown.mockResolvedValue(undefined);
  mocks.flushDesktopSettings.mockResolvedValue(undefined);
  // Importing the entry point must not add process-wide handlers to the test worker.
  vi.spyOn(process, "on").mockReturnValue(process);
  vi.spyOn(process, "once").mockReturnValue(process);
  vi.stubEnv("CODEMUX_CUSTOM_SETTING", "explicit override");
  vi.stubEnv("CODEMUX_DESKTOP_SHELL", "1");
  for (const [name, value] of Object.entries({
    CODEMUX_WEB_PORT: "18233", CODEMUX_WEB_STANDALONE_PORT: "18234", CODEMUX_GATEWAY_PORT: "14200",
    CODEMUX_OPENCODE_PORT: "14096", CODEMUX_AUTH_API_PORT: "14097", CODEMUX_WEBHOOK_PORT: "14098",
  })) vi.stubEnv(name, value);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("app-main desktop lifecycle", () => {
  it.each([true, false])("opens the manager and IPC while packaged=%s server startup is pending", async packaged => {
    mocks.app.isPackaged = packaged;
    mocks.runtimeHost.usesSharedDevDeviceStore = !packaged;
    const starting = deferred();
    mocks.supervisor.start.mockReturnValue(starting.promise.then(() => mocks.supervisor.getState()));
    try {
      const entry = await startDesktop();
      expect(mocks.supervisor.start).toHaveBeenCalledOnce();
      expect(mocks.registerIpcHandlers).toHaveBeenCalledOnce();
      expect(mocks.ipcHandle.mock.calls.map(([channel]) => channel)).toEqual([
        "remoteHosts:list", "remoteHosts:save", "remoteHosts:connect", "remoteHosts:disconnect", "remoteHosts:remove",
        "runtime:getState", "runtime:start", "runtime:stop", "runtime:restart", "runtime:showManager", "runtime:openLogs",
      ]);
      expect(mocks.createWindow.mock.invocationCallOrder[0]).toBeLessThan(mocks.supervisor.start.mock.invocationCallOrder[0]);
      expect(entry.isStartupReady()).toBe(false);
      mocks.supervisor.getState.mockReturnValue({ phase: "ready", ownership: "owned", pid: 123, error: null });
      expect(entry.isStartupReady()).toBe(true);
      expect(mocks.createSupervisor).toHaveBeenCalledWith(expect.objectContaining({
        dataPath: "/fixture/data", cwd: process.cwd(), execPath: process.execPath,
        entryPath: path.join("/fixture/app", "out", "server", "index.mjs"), beforeStart: mocks.flushDesktopSettings,
      }));
      const { env } = mocks.createSupervisor.mock.calls[0][0];
      expect(env).toMatchObject({
        ELECTRON_RUN_AS_NODE: "1", CODEMUX_DESKTOP_HOST: "1", CODEMUX_DESKTOP_PARENT_PID: String(process.pid),
        CODEMUX_RUNTIME_WEB_MODE: packaged ? "static" : "dev-proxy",
        CODEMUX_SHARED_DEV_DEVICE_STORE: packaged ? "0" : "1", CODEMUX_BUNDLED_RESOURCES: packaged ? "1" : "0",
        CODEMUX_DATA_DIR: "/fixture/data", CODEMUX_DEVICES_FILE: "/fixture/legacy/.devices.json",
        CODEMUX_LOGS_DIR: path.dirname("/fixture/logs/main.log"),
        CODEMUX_APP_PATH: "/fixture/app", CODEMUX_RESOURCES_PATH: "/fixture/resources",
        CODEMUX_WEB_PORT: "18233", CODEMUX_WEB_STANDALONE_PORT: "18234", CODEMUX_GATEWAY_PORT: "14200",
        CODEMUX_OPENCODE_PORT: "14096", CODEMUX_AUTH_API_PORT: "14097", CODEMUX_WEBHOOK_PORT: "14098",
        CODEMUX_CUSTOM_SETTING: "explicit override",
      });
      expect(env).not.toHaveProperty("CODEMUX_DESKTOP_SHELL");
    } finally {
      starting.resolve();
      await starting.promise;
    }
  });

  it("drains desktop settings before owned shutdown and allows only the prepared final quit", async () => {
    await startDesktop();
    const firstFlush = deferred();
    const stopped = deferred();
    const finalFlush = deferred();
    mocks.flushDesktopSettings.mockReturnValueOnce(firstFlush.promise).mockReturnValueOnce(finalFlush.promise);
    mocks.supervisor.shutdown.mockReturnValue(stopped.promise);
    const event = { preventDefault: vi.fn() };
    beforeQuit()(event);
    try {
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(mocks.supervisor.shutdown).not.toHaveBeenCalled();
      expect(mocks.trayManager.destroy).not.toHaveBeenCalled();
      firstFlush.resolve();
      await vi.waitFor(() => expect(mocks.supervisor.shutdown).toHaveBeenCalledOnce());
      expect(mocks.app.quit).not.toHaveBeenCalled();
      stopped.resolve();
      await vi.waitFor(() => expect(mocks.flushDesktopSettings).toHaveBeenCalledTimes(2));
      expect(mocks.app.quit).not.toHaveBeenCalled();
      finalFlush.resolve();
      await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
      const finalEvent = { preventDefault: vi.fn() };
      beforeQuit()(finalEvent);
      expect(finalEvent.preventDefault).not.toHaveBeenCalled();
      expect(mocks.trayManager.destroy).toHaveBeenCalledOnce();
      expect(mocks.supervisor.shutdown).toHaveBeenCalledOnce();
      expect(mocks.app.exit).not.toHaveBeenCalled();
    } finally {
      firstFlush.resolve(); stopped.resolve(); finalFlush.resolve();
    }
  });

  it("prepares installation before final quit and restores the server when installation fails", async () => {
    await startDesktop();
    const stopped = deferred();
    mocks.supervisor.shutdown.mockReturnValueOnce(stopped.promise);
    const prepared = vi.fn();
    const preparing = beforeInstall()().then(prepared);
    try {
      await vi.waitFor(() => expect(mocks.supervisor.shutdown).toHaveBeenCalledOnce());
      expect(prepared).not.toHaveBeenCalled();
      expect(mocks.trayManager.destroy).not.toHaveBeenCalled();
    } finally {
      stopped.resolve();
      await preparing;
    }
    expect(prepared).toHaveBeenCalledOnce();
    expect(mocks.app.quit).not.toHaveBeenCalled();
    const installFailed = mocks.updateManager.setInstallErrorHandler.mock.calls[0][0];
    installFailed();
    expect(mocks.supervisor.start).toHaveBeenCalledTimes(2);
    expect(mocks.trayManager.destroy).not.toHaveBeenCalled();

    // Resetting the quit state makes a later ordinary quit drain the owner again.
    const retryQuit = { preventDefault: vi.fn() };
    beforeQuit()(retryQuit);
    expect(retryQuit.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
    expect(mocks.supervisor.shutdown).toHaveBeenCalledTimes(2);
    const finalEvent = { preventDefault: vi.fn() };
    beforeQuit()(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
    expect(mocks.trayManager.destroy).toHaveBeenCalledOnce();
    installFailed();
    expect(mocks.supervisor.start).toHaveBeenCalledTimes(2);
  });

  it.each(["quit", "install"] as const)("rejects server launches while %s waits for the final settings flush", async mode => {
    await startDesktop();
    const finalFlush = deferred();
    mocks.flushDesktopSettings.mockResolvedValueOnce(undefined).mockReturnValueOnce(finalFlush.promise);
    let installing: Promise<void> | undefined;
    if (mode === "install") installing = beforeInstall()();
    else beforeQuit()({ preventDefault: vi.fn() });

    try {
      await vi.waitFor(() => expect(mocks.flushDesktopSettings).toHaveBeenCalledTimes(2));
      expect(mocks.supervisor.shutdown).toHaveBeenCalledOnce();
      expect(() => runtimeHandler("runtime:start")()).toThrow("CodeMux is shutting down");
      await expect(runtimeHandler("runtime:restart")()).rejects.toThrow("CodeMux is shutting down");
      expect(mocks.supervisor.start).toHaveBeenCalledOnce();
      expect(mocks.supervisor.restart).not.toHaveBeenCalled();
      expect(mocks.flushDesktopSettings).toHaveBeenCalledTimes(2);
      expect(mocks.app.quit).not.toHaveBeenCalled();
    } finally {
      finalFlush.resolve();
      if (installing) await installing;
      else await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
    }
  });

  it("rejects an admitted restart when quit begins during its settings flush", async () => {
    await startDesktop();
    const pendingWrites = deferred();
    mocks.flushDesktopSettings
      .mockReturnValueOnce(pendingWrites.promise)
      .mockReturnValueOnce(pendingWrites.promise);
    const restarting = runtimeHandler("runtime:restart")() as Promise<unknown>;
    const rejected = expect(restarting).rejects.toThrow("CodeMux is shutting down");
    expect(mocks.flushDesktopSettings).toHaveBeenCalledOnce();
    const quitEvent = { preventDefault: vi.fn() };
    beforeQuit()(quitEvent);

    try {
      expect(quitEvent.preventDefault).toHaveBeenCalledOnce();
      expect(mocks.flushDesktopSettings).toHaveBeenCalledTimes(2);
      expect(mocks.supervisor.restart).not.toHaveBeenCalled();
      expect(mocks.supervisor.shutdown).not.toHaveBeenCalled();
    } finally {
      pendingWrites.resolve();
      await rejected;
      await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
    }
    expect(mocks.supervisor.restart).not.toHaveBeenCalled();
    expect(mocks.supervisor.start).toHaveBeenCalledOnce();
    expect(mocks.supervisor.shutdown).toHaveBeenCalledOnce();
    expect(mocks.flushDesktopSettings).toHaveBeenCalledTimes(3);
  });
});
