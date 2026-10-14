import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    on: vi.fn(),
    quit: vi.fn(),
    getAppPath: vi.fn(() => "/fixture/app"),
    getPath: vi.fn(() => "/fixture/home"),
    setLoginItemSettings: vi.fn(),
  },
  window: {
    on: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    maximize: vi.fn(),
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    webContents: { setWindowOpenHandler: vi.fn(), send: vi.fn() },
  },
  showMessageBox: vi.fn(),
  loadSettings: vi.fn<() => Record<string, unknown>>(),
  saveSettings: vi.fn<(settings: Record<string, unknown>) => Promise<void>>(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  fs: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  autoUpdater: {
    on: vi.fn(),
    once: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: vi.fn(function () { return mocks.window; }),
  dialog: { showMessageBox: mocks.showMessageBox },
  shell: { openExternal: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false },
  Tray: vi.fn(),
  Menu: { buildFromTemplate: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
}));
vi.mock("electron-updater", () => ({ default: { autoUpdater: mocks.autoUpdater } }));
vi.mock("fs", () => ({ default: mocks.fs }));
vi.mock("../../../electron/main/services/logger", () => ({
  default: mocks.log,
  windowLog: mocks.log,
  loadSettings: mocks.loadSettings,
  saveSettings: mocks.saveSettings,
}));

const originalPlatform = process.platform;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function expectNoLoginSideEffects(): void {
  expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
  expect(mocks.fs.mkdirSync).not.toHaveBeenCalled();
  expect(mocks.fs.writeFileSync).not.toHaveBeenCalled();
  expect(mocks.fs.unlinkSync).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.loadSettings.mockReturnValue({});
  mocks.saveSettings.mockResolvedValue(undefined);
  mocks.autoUpdater.checkForUpdates.mockResolvedValue(undefined);
  mocks.fs.existsSync.mockReturnValue(false);
  setPlatform("darwin");
});

afterEach(() => {
  setPlatform(originalPlatform);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TrayManager.setLaunchAtLogin", () => {
  it.each(["darwin", "win32", "linux"] as const)("waits for persistence before enabling %s startup", async platform => {
    setPlatform(platform);
    const saved = deferred();
    mocks.saveSettings.mockReturnValue(saved.promise);
    const { trayManager } = await import("../../../electron/main/services/tray-manager");

    const enabling = trayManager.setLaunchAtLogin(true);
    expect(mocks.saveSettings).toHaveBeenCalledWith({ launchAtLogin: true });
    expectNoLoginSideEffects();

    saved.resolve();
    await enabling;

    if (platform === "linux") {
      expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
      expect(mocks.fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining("autostart"), { recursive: true });
      expect(mocks.fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining("codemux.desktop"),
        expect.stringContaining(" --hidden\nTerminal=false\n"),
      );
    } else {
      expect(mocks.app.setLoginItemSettings).toHaveBeenCalledWith({
        openAtLogin: true,
        ...(platform === "darwin" ? { openAsHidden: true } : {}),
        args: platform === "win32" ? ["--hidden"] : [],
      });
    }
  });

  it.each(["darwin", "win32", "linux"] as const)("rejects failed persistence without changing %s startup", async platform => {
    setPlatform(platform);
    const error = new Error("Settings service unavailable");
    mocks.saveSettings.mockRejectedValue(error);
    const { trayManager } = await import("../../../electron/main/services/tray-manager");

    await expect(trayManager.setLaunchAtLogin(false)).rejects.toBe(error);
    expectNoLoginSideEffects();
  });

  it("removes the existing Linux autostart file only after disabling is saved", async () => {
    setPlatform("linux");
    mocks.fs.existsSync.mockReturnValue(true);
    const saved = deferred();
    mocks.saveSettings.mockReturnValue(saved.promise);
    const { trayManager } = await import("../../../electron/main/services/tray-manager");

    const disabling = trayManager.setLaunchAtLogin(false);
    expectNoLoginSideEffects();
    saved.resolve();
    await disabling;

    expect(mocks.fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining("codemux.desktop"));
    expect(mocks.fs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("UpdateManager.setAutoCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each([true, false])("changes automatic checking to %s only after saving", async enabled => {
    mocks.loadSettings.mockReturnValue({ autoUpdate: !enabled });
    const saved = deferred();
    mocks.saveSettings.mockReturnValue(saved.promise);
    const { updateManager } = await import("../../../electron/main/services/update-manager");
    updateManager.init();
    const originalTimerCount = enabled ? 0 : 2;
    expect(vi.getTimerCount()).toBe(originalTimerCount);

    const changing = updateManager.setAutoCheck(enabled);
    expect(mocks.saveSettings).toHaveBeenCalledWith({ autoUpdate: enabled });
    expect(vi.getTimerCount()).toBe(originalTimerCount);

    saved.resolve();
    await changing;
    expect(vi.getTimerCount()).toBe(enabled ? 1 : 0);

    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(enabled ? 1 : 0);
  });

  it.each([true, false])("preserves the previous schedule when saving %s fails", async enabled => {
    mocks.loadSettings.mockReturnValue({ autoUpdate: !enabled });
    const error = new Error("Settings service unavailable");
    mocks.saveSettings.mockRejectedValue(error);
    const { updateManager } = await import("../../../electron/main/services/update-manager");
    updateManager.init();

    await expect(updateManager.setAutoCheck(enabled)).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(enabled ? 0 : 2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(enabled ? 0 : 1);
  });
});

describe("createWindow close preference", () => {
  async function requestClose(response: number, checkboxChecked = true) {
    mocks.showMessageBox.mockResolvedValue({ response, checkboxChecked });
    const { trayManager } = await import("../../../electron/main/services/tray-manager");
    const updateTrayMenu = vi.spyOn(trayManager, "updateContextMenu").mockImplementation(() => {});
    const { createWindow, getMainWindow } = await import("../../../electron/main/window-manager");
    const window = createWindow();
    const close = mocks.window.on.mock.calls.find(([event]) => event === "close")?.[1] as
      (event: { preventDefault: () => void }) => void;
    const event = { preventDefault: vi.fn() };
    close(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    return { window, getMainWindow, updateTrayMenu };
  }

  it.each([{ response: 0, action: "tray" }, { response: 1, action: "quit" }])(
    "waits for the remembered $action preference before acting",
    async ({ response, action }) => {
      const saved = deferred();
      mocks.saveSettings.mockReturnValue(saved.promise);
      const { updateTrayMenu } = await requestClose(response);
      await vi.waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledWith({ closeAction: action }));
      expect(mocks.window.hide).not.toHaveBeenCalled();
      expect(mocks.app.quit).not.toHaveBeenCalled();
      expect(updateTrayMenu).not.toHaveBeenCalled();

      saved.resolve();
      await vi.waitFor(() => expect(response === 0 ? mocks.window.hide : mocks.app.quit).toHaveBeenCalledOnce());
      if (response === 0) {
        await vi.waitFor(() => expect(updateTrayMenu).toHaveBeenCalledOnce());
        expect(mocks.app.quit).not.toHaveBeenCalled();
      } else {
        expect(mocks.window.hide).not.toHaveBeenCalled();
        expect(updateTrayMenu).not.toHaveBeenCalled();
      }
    },
  );

  it.each([0, 1])("retains the window when remembering response %s fails", async response => {
    const error = new Error("Settings service unavailable");
    mocks.saveSettings.mockRejectedValue(error);
    const { window, getMainWindow, updateTrayMenu } = await requestClose(response);

    await vi.waitFor(() => expect(mocks.log.error).toHaveBeenCalledWith(expect.any(String), error));
    expect(getMainWindow()).toBe(window);
    expect(mocks.window.hide).not.toHaveBeenCalled();
    expect(mocks.app.quit).not.toHaveBeenCalled();
    expect(updateTrayMenu).not.toHaveBeenCalled();
  });

  it.each([0, 1])("preserves response %s without persistence when remember is unchecked", async response => {
    await requestClose(response, false);
    await vi.waitFor(() => expect(response === 0 ? mocks.window.hide : mocks.app.quit).toHaveBeenCalledOnce());
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });
});
