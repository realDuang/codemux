import { app, Notification } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { HostPlatform } from "../../shared/host-platform";
import { desktopSettings } from "./desktop-settings";

export const DEV_ISOLATED_ENV = "CODEMUX_DEV_ISOLATED";
export const DEV_ISOLATED_DIR = ".codemux-dev";

export const runtimeHost: HostPlatform = {
  paths: {
    get userDataPath() { return app.getPath("userData"); },
    get logsPath() { return app.getPath("logs"); },
    get devicesPath() {
      return runtimeHost.usesSharedDevDeviceStore ? path.join(process.cwd(), ".devices.json") : undefined;
    },
  },
  get appPath() { return app.getAppPath(); },
  get resourcesPath() { return process.resourcesPath; },
  get isPackaged() { return app.isPackaged; },
  get isDevIsolated() { return !app.isPackaged && process.env[DEV_ISOLATED_ENV] === "1"; },
  get usesSharedDevDeviceStore() { return !app.isPackaged && !runtimeHost.isDevIsolated; },
  get useLibraryDefaultLogPath() { return !app.isPackaged && !runtimeHost.isDevIsolated; },
  get logFileName() { return process.env.CODEMUX_DESKTOP_SHELL === "1" ? "desktop.log" : undefined; },
  get settings() { return process.env.CODEMUX_DESKTOP_SHELL === "1" ? desktopSettings : undefined; },
  notify(title, body) {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  },
};

export function configureDevIsolatedAppPaths(cwd = process.cwd()): void {
  if (!runtimeHost.isDevIsolated) return;

  const root = path.join(cwd, DEV_ISOLATED_DIR);
  const userData = path.join(root, "userData");
  const sessionData = path.join(root, "sessionData");
  const logs = path.join(root, "logs");

  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(sessionData, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });

  app.setPath("userData", userData);
  app.setPath("sessionData", sessionData);
  app.setPath("logs", logs);
}
