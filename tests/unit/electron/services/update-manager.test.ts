import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const window = { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } };
  return {
    updater: Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn<() => Promise<unknown>>(),
      quitAndInstall: vi.fn(),
      autoDownload: false,
      autoInstallOnAppQuit: false,
      logger: undefined as unknown,
    }),
    window,
    getMainWindow: vi.fn<() => typeof window | null>(),
    settings: {} as Record<string, unknown>,
    saveSettings: vi.fn<(patch: Record<string, unknown>) => Promise<void>>(),
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    handle: vi.fn(),
  };
});

vi.mock("electron-updater", () => ({ default: { autoUpdater: mocks.updater } }));
vi.mock("../../../../electron/main/window-manager", () => ({ getMainWindow: mocks.getMainWindow }));
vi.mock("../../../../electron/main/services/logger", () => ({
  default: mocks.log,
  loadSettings: () => mocks.settings,
  saveSettings: mocks.saveSettings,
}));
vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle, on: vi.fn() }, dialog: {}, shell: {}, BrowserWindow: {} }));
vi.mock("../../../../electron/main/services/tray-manager", () => ({ trayManager: {} }));

const originalPlatform = process.platform;
const release = { version: "1.8.0", releaseNotes: "Preserve local sessions during updates." };
const fourHours = 4 * 60 * 60 * 1000;

function platform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

async function manager() {
  return (await import("../../../../electron/main/services/update-manager")).updateManager;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  platform("win32");
  mocks.updater.removeAllListeners();
  mocks.updater.autoDownload = false;
  mocks.updater.autoInstallOnAppQuit = false;
  mocks.updater.quitAndInstall.mockReset();
  mocks.updater.checkForUpdates.mockResolvedValue(undefined);
  mocks.settings = { autoUpdate: false, locale: "zh", theme: "dark", remoteAccess: { mode: "off" } };
  mocks.saveSettings.mockImplementation(async patch => { Object.assign(mocks.settings, patch); });
  mocks.window.isDestroyed.mockReturnValue(false);
  mocks.getMainWindow.mockReturnValue(mocks.window);
});

afterEach(() => {
  mocks.updater.removeAllListeners();
  vi.clearAllTimers();
  vi.useRealTimers();
  platform(originalPlatform);
});

describe("UpdateManager.init", () => {
  it.each(["darwin", "win32", "linux"] as const)("retains the %s download policy without scheduling disabled automatic checks", async target => {
    platform(target);
    const updates = await manager();
    updates.init();
    expect(mocks.updater.logger).toBe(mocks.log);
    expect(mocks.updater.autoDownload).toBe(target !== "darwin");
    if (target !== "darwin") expect(mocks.updater.autoInstallOnAppQuit).toBe(true);
    expect(updates.isAutoCheckEnabled()).toBe(false);
    await vi.advanceTimersByTimeAsync(fourHours * 2);
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it("notifies the renderer of checking, availability, progress, and a completed download", async () => {
    const updates = await manager();
    updates.init();
    mocks.updater.emit("checking-for-update");
    expect(mocks.window.webContents.send).toHaveBeenLastCalledWith("update:status", { status: "checking" });
    mocks.updater.emit("update-available", release);
    expect(mocks.window.webContents.send).toHaveBeenLastCalledWith("update:available", { status: "available", ...release });
    const progress = { percent: 42, bytesPerSecond: 128, transferred: 420, total: 1000, delta: 10 };
    mocks.updater.emit("download-progress", progress);
    expect(mocks.window.webContents.send).toHaveBeenLastCalledWith("update:progress", {
      status: "downloading", ...release, progress: { percent: 42, bytesPerSecond: 128, transferred: 420, total: 1000 },
    });
    mocks.updater.emit("update-downloaded", release);
    expect(mocks.window.webContents.send).toHaveBeenLastCalledWith("update:downloaded", { status: "downloaded", ...release });
    expect(updates.getState()).not.toHaveProperty("progress");
  });

  it("provides the existing macOS manual release link without starting a download", async () => {
    platform("darwin");
    const updates = await manager();
    updates.init();
    mocks.updater.emit("update-available", { version: release.version, releaseNotes: [{ version: "1.8.0", note: "note" }] });
    expect(mocks.window.webContents.send).toHaveBeenLastCalledWith("update:available", {
      status: "available", version: "1.8.0", downloadUrl: "https://github.com/realDuang/codemux/releases/tag/v1.8.0",
    });
    expect(updates.getState()).not.toHaveProperty("releaseNotes");
    expect(mocks.updater.autoDownload).toBe(false);
  });

  it("briefly shows up-to-date state without letting an older reset hide a newer available update", async () => {
    const updates = await manager();
    updates.init();
    mocks.updater.emit("update-not-available", release);
    await vi.advanceTimersByTimeAsync(4999);
    expect(updates.getState().status).toBe("not-available");
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.window.webContents.send).toHaveBeenLastCalledWith("update:status", { status: "idle" });
    mocks.updater.emit("update-not-available", release);
    mocks.updater.emit("update-available", release);
    await vi.advanceTimersByTimeAsync(5000);
    expect(updates.getState().status).toBe("available");
  });

  it.each(["missing", "destroyed"])("retains updater state when the renderer window is %s", async state => {
    const updates = await manager();
    updates.init();
    if (state === "missing") mocks.getMainWindow.mockReturnValue(null);
    else mocks.window.isDestroyed.mockReturnValue(true);
    expect(() => mocks.updater.emit("update-downloaded", release)).not.toThrow();
    expect(updates.getState()).toEqual({ status: "downloaded", ...release });
    expect(mocks.window.webContents.send).not.toHaveBeenCalled();
  });

  it("keeps default automatic checking delayed and periodic without modifying persisted preferences", async () => {
    delete mocks.settings.autoUpdate;
    mocks.updater.checkForUpdates.mockImplementation(async () => { mocks.updater.emit("update-not-available", release); });
    const updates = await manager();
    updates.init();
    expect(updates.isAutoCheckEnabled()).toBe(true);
    await vi.advanceTimersByTimeAsync(29999);
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(fourHours - 30000);
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });
});

describe("UpdateManager.checkForUpdates", () => {
  it("avoids checks before initialization and duplicate requests while checking or downloading", async () => {
    const updates = await manager();
    expect(await updates.checkForUpdates()).toEqual({ status: "idle" });
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
    updates.init();
    const checking = deferred();
    mocks.updater.checkForUpdates.mockReturnValueOnce(checking.promise);
    const pending = updates.checkForUpdates();
    expect(await updates.checkForUpdates()).toEqual({ status: "checking" });
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce();
    checking.resolve();
    await pending;
    mocks.updater.emit("download-progress", { percent: 10, bytesPerSecond: 1, transferred: 1, total: 10 });
    expect((await updates.checkForUpdates()).status).toBe("downloading");
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it.each([new Error("update service unavailable"), "update service unavailable"])("reports failed checks and clears the error on a later successful attempt (%s)", async failure => {
    const updates = await manager();
    updates.init();
    mocks.updater.checkForUpdates.mockRejectedValueOnce(failure);
    expect(await updates.checkForUpdates()).toEqual({ status: "error", error: "update service unavailable" });
    mocks.updater.checkForUpdates.mockImplementationOnce(async () => { mocks.updater.emit("update-available", release); });
    expect(await updates.checkForUpdates()).toEqual({ status: "available", ...release });
  });
});

describe("UpdateManager.getState", () => {
  it.each([
    { message: "code signing failed", version: true, suffix: "tag/v1.8.0" },
    { message: "代码不含资源", version: false, suffix: "latest" },
  ])("offers a manual recovery link for a signing failure: $message", async ({ message, version, suffix }) => {
    const updates = await manager();
    updates.init();
    if (version) mocks.updater.emit("update-available", release);
    mocks.updater.emit("error", new Error(message));
    expect(updates.getState()).toMatchObject({ status: "error", error: message, downloadUrl: `https://github.com/realDuang/codemux/releases/${suffix}` });
    expect(mocks.window.webContents.send).toHaveBeenLastCalledWith("update:error", updates.getState());
  });
});

describe("UpdateManager.setAutoCheck", () => {
  it("persists only the update preference before replacing timers and preserves the previous schedule on failure", async () => {
    mocks.settings.autoUpdate = true;
    const updates = await manager();
    updates.init();
    const original = structuredClone(mocks.settings);
    const saved = deferred();
    mocks.saveSettings.mockImplementationOnce(async patch => { await saved.promise; Object.assign(mocks.settings, patch); });
    const disabling = updates.setAutoCheck(false);
    expect(mocks.saveSettings).toHaveBeenCalledWith({ autoUpdate: false });
    expect(updates.isAutoCheckEnabled()).toBe(true);
    expect(vi.getTimerCount()).toBe(2);
    saved.resolve();
    await disabling;
    expect(mocks.settings).toEqual({ ...original, autoUpdate: false });
    expect(vi.getTimerCount()).toBe(0);
    await updates.setAutoCheck(true);
    expect(vi.getTimerCount()).toBe(1);
    mocks.saveSettings.mockRejectedValueOnce(new Error("settings owner unavailable"));
    await expect(updates.setAutoCheck(false)).rejects.toThrow("settings owner unavailable");
    expect(updates.isAutoCheckEnabled()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(fourHours);
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce();
  });
});

describe("UpdateManager.quitAndInstall", () => {
  it.each(["event", "throw"])("recovers the local server once when installation fails through %s", async failureMode => {
    platform("darwin");
    const updates = await manager();
    updates.init();
    const recover = vi.fn();
    updates.setInstallErrorHandler(recover);
    if (failureMode === "throw") mocks.updater.quitAndInstall.mockImplementationOnce(() => { throw new Error("installer failed"); });
    updates.quitAndInstall();
    expect(mocks.updater.autoInstallOnAppQuit).toBe(false);
    expect(updates.isInstallingUpdate()).toBe(failureMode === "event");
    mocks.updater.emit("error", new Error("installer failed"));
    mocks.updater.emit("error", new Error("late installer failure"));
    expect(updates.isInstallingUpdate()).toBe(false);
    expect(recover).toHaveBeenCalledOnce();
    updates.quitAndInstall();
    expect(updates.isInstallingUpdate()).toBe(true);
    expect(mocks.updater.quitAndInstall).toHaveBeenCalledTimes(2);
  });
});

describe("registerIpcHandlers updater integration", () => {
  it.each([true, false])("installs only after asynchronous host cleanup succeeds=%s", async success => {
    const updates = await manager();
    updates.init();
    const recover = vi.fn();
    updates.setInstallErrorHandler(recover);
    const cleanup = deferred();
    const { registerIpcHandlers } = await import("../../../../electron/main/ipc-handlers");
    registerIpcHandlers({ management: { invoke: vi.fn(), loadSettings: () => mocks.settings }, beforeInstall: () => cleanup.promise });
    const install = mocks.handle.mock.calls.find(([name]) => name === "update:quitAndInstall")![1] as () => Promise<void>;
    const installing = install();
    const completed = success ? installing : expect(installing).rejects.toThrow("cleanup failed");
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updates.isInstallingUpdate()).toBe(false);
    if (success) cleanup.resolve();
    else cleanup.reject(new Error("cleanup failed"));
    await completed;
    expect(mocks.updater.quitAndInstall).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(updates.isInstallingUpdate()).toBe(success);
    if (success) {
      mocks.updater.emit("error", new Error("installation failed after cleanup"));
      expect(updates.isInstallingUpdate()).toBe(false);
      expect(recover).toHaveBeenCalledOnce();
    } else expect(recover).not.toHaveBeenCalled();
  });
});
