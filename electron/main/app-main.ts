import { app, BrowserWindow, ipcMain, Notification, shell } from "electron";
import path from "node:path";
import { shellEnvSync } from "shell-env";
import log, { getLogFilePath, loadSettings, mainLog } from "./services/logger";
import { createWindow, getMainWindow } from "./window-manager";
import { registerIpcHandlers } from "./ipc-handlers";
import { updateManager } from "./services/update-manager";
import { trayManager } from "./services/tray-manager";
import { runtimeHost } from "./runtime-host";
import { getDevicesPath, getUserDataPath } from "./services/app-paths";
import { flushDesktopSettings } from "./desktop-settings";
import { LocalServerSupervisor } from "./local-server-supervisor";
import { getLocalIp } from "../../shared/http-utils";
import {
  AUTH_API_PORT, GATEWAY_PORT, OPENCODE_PORT, WEBHOOK_PORT, WEB_PORT, WEB_STANDALONE_PORT,
} from "../../shared/ports";

// GUI launchers omit login-shell variables; preserve explicit CodeMux overrides.
try {
  const codemuxEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("CODEMUX_")),
  );
  Object.assign(process.env, shellEnvSync(), codemuxEnv);
} catch {
  // Continue with the inherited environment when the user's shell cannot be read.
}

let supervisor: LocalServerSupervisor | undefined;
let quitting = false;
let quitReady = false;
let finalQuitStarted = false;
let shutdownPromise: Promise<void> | undefined;

export function isStartupReady(): boolean {
  return supervisor?.getState().phase === "ready";
}

async function prepareForQuit(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  quitting = true;
  shutdownPromise = (async () => {
    let failure: unknown;
    try { await flushDesktopSettings(); } catch (error) { failure = error; }
    try { await supervisor?.shutdown(); } catch (error) { failure ??= error; }
    try { await flushDesktopSettings(); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  })();
  return shutdownPromise;
}

async function prepareForInstall(): Promise<void> {
  try {
    await prepareForQuit();
    quitReady = true;
  } catch (error) {
    // The installer has not started; leave the manager usable for a retry.
    shutdownPromise = undefined;
    quitting = false;
    throw error;
  }
}

process.on("uncaughtException", error => {
  if ((error as NodeJS.ErrnoException).code === "EPIPE") {
    mainLog.warn("Suppressed EPIPE error:", error.message);
    return;
  }
  mainLog.error("Uncaught desktop exception:", error);
  // A forked desktop server also stops when this parent's IPC channel closes.
  app.exit(1);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // All normal quit paths, including Windows install-on-quit, drain the owner first.
  app.on("before-quit", event => {
    if (quitReady) {
      finalQuitStarted = true;
      trayManager.destroy();
      return;
    }
    event.preventDefault();
    void prepareForQuit().then(() => {
      quitReady = true;
      app.quit();
    }).catch(error => {
      mainLog.error("Desktop shutdown failed:", error);
      app.exit(1);
    });
  });
  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());

  app.whenReady().then(() => {
    if (quitting) return;
    const logsPath = path.dirname(getLogFilePath());
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CODEMUX_DESKTOP_HOST: "1",
      CODEMUX_DESKTOP_PARENT_PID: String(process.pid),
      CODEMUX_RUNTIME_WEB_MODE: app.isPackaged ? "static" : "dev-proxy",
      CODEMUX_SHARED_DEV_DEVICE_STORE: runtimeHost.usesSharedDevDeviceStore ? "1" : "0",
      CODEMUX_DATA_DIR: getUserDataPath(),
      CODEMUX_LOGS_DIR: logsPath,
      CODEMUX_DEVICES_FILE: getDevicesPath(),
      CODEMUX_APP_PATH: runtimeHost.appPath,
      CODEMUX_RESOURCES_PATH: runtimeHost.resourcesPath,
      CODEMUX_BUNDLED_RESOURCES: app.isPackaged ? "1" : "0",
      CODEMUX_WEB_PORT: String(WEB_PORT),
      CODEMUX_WEB_STANDALONE_PORT: String(WEB_STANDALONE_PORT),
      CODEMUX_GATEWAY_PORT: String(GATEWAY_PORT),
      CODEMUX_OPENCODE_PORT: String(OPENCODE_PORT),
      CODEMUX_AUTH_API_PORT: String(AUTH_API_PORT),
      CODEMUX_WEBHOOK_PORT: String(WEBHOOK_PORT),
    };
    delete childEnv.CODEMUX_DESKTOP_SHELL;
    const localServer = new LocalServerSupervisor({
      dataPath: getUserDataPath(),
      cwd: process.cwd(),
      entryPath: path.join(runtimeHost.appPath, "out", "server", "index.mjs"),
      execPath: process.execPath,
      env: childEnv,
      beforeStart: flushDesktopSettings,
      onNotification: ({ title, body }) => {
        try {
          if (Notification.isSupported()) new Notification({ title, body }).show();
        } catch (error) {
          mainLog.warn("Failed to show notification:", error);
        }
      },
    });
    supervisor = localServer;
    updateManager.setInstallErrorHandler(() => {
      if (finalQuitStarted) return;
      quitReady = false;
      quitting = false;
      shutdownPromise = undefined;
      void localServer.start().catch(error => mainLog.error("Failed to restore server after update error:", error));
    });

    const management = {
      loadSettings,
      async invoke(method: string, args: unknown[] = []): Promise<unknown> {
        if (method === "startup:isReady") return isStartupReady();
        if (method === "settings:load") return loadSettings();
        if (method === "system:getInfo") {
          return {
            platform: process.platform, arch: process.arch, version: app.getVersion(),
            userDataPath: getUserDataPath(), homePath: app.getPath("home"), isPackaged: app.isPackaged,
          };
        }
        if (method === "system:getLocalIp") return getLocalIp();
        const result = await localServer.invoke(method, args);
        if (method === "log:setLevel") {
          // The child persists the setting; mirror its accepted level in desktop logging.
          log.transports.file.level = await localServer.invoke("log:getLevel");
        }
        return result;
      },
    };
    registerIpcHandlers({ management, beforeInstall: prepareForInstall });
    ipcMain.handle("runtime:getState", () => localServer.getState());
    ipcMain.handle("runtime:start", () => {
      if (quitting) throw new Error("CodeMux is shutting down");
      return localServer.start();
    });
    ipcMain.handle("runtime:stop", async () => {
      await flushDesktopSettings();
      return localServer.stop();
    });
    ipcMain.handle("runtime:restart", async () => {
      if (quitting) throw new Error("CodeMux is shutting down");
      await flushDesktopSettings();
      if (quitting) throw new Error("CodeMux is shutting down");
      return localServer.restart();
    });
    ipcMain.handle("runtime:showManager", () => {
      getMainWindow()?.webContents.send("runtime:showManager");
    });
    ipcMain.handle("runtime:openLogs", async () => {
      const error = await shell.openPath(logsPath);
      if (error) throw new Error(error);
    });
    localServer.subscribe(state => {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return;
      win.webContents.send("runtime:state", state);
      if (state.phase === "ready") win.webContents.send("startup:ready");
    });

    // Keep the original file URL and preload so localStorage and desktop identity survive.
    createWindow(process.argv.includes("--hidden"));
    trayManager.init();
    if (app.isPackaged) updateManager.init();
    void localServer.start().catch(error => mainLog.error("Local server startup failed:", error));

    app.on("activate", () => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
      } else if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  }).catch(error => {
    mainLog.error("Failed to initialize desktop:", error);
    app.quit();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
