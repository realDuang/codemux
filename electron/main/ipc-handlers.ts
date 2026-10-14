import { ipcMain, dialog, shell, BrowserWindow } from "electron";
import fs from "fs";
import { updateManager } from "./services/update-manager";
import { trayManager } from "./services/tray-manager";
import { HOST_MANAGEMENT_METHODS, type HostManagementController } from "../../shared/host-management";

export interface IpcHandlerDependencies {
  management: Pick<HostManagementController, "invoke" | "loadSettings">;
  beforeInstall?: () => Promise<void>;
}

export function registerIpcHandlers({ management, beforeInstall }: IpcHandlerDependencies): void {
  for (const method of HOST_MANAGEMENT_METHODS) {
    ipcMain.handle(method, (_event, ...args: unknown[]) => management.invoke(method, args));
  }

  // Synchronous read supplies initial settings before the renderer starts.
  ipcMain.on("settings:loadSync", (event) => {
    event.returnValue = management.loadSettings();
  });

  // Native desktop operations stay in the Electron adapter.
  ipcMain.handle("system:openExternal", async (_, url: string) => {
    // Validate URL to prevent opening dangerous protocols
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
        await shell.openExternal(url);
        return;
      }
      throw new Error("Unsupported URL protocol");
    } catch {
      throw new Error("Invalid URL");
    }
  });

  ipcMain.handle("system:selectDirectory", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("system:openPath", async (_, folderPath: string) => {
    const stat = fs.statSync(folderPath);
    if (!stat.isDirectory()) {
      throw new Error("Path is not a directory");
    }
    return shell.openPath(folderPath);
  });

  // ===========================================================================
  // Auto Update
  // ===========================================================================

  ipcMain.handle("update:checkForUpdates", async () => {
    return updateManager.checkForUpdates();
  });

  ipcMain.handle("update:quitAndInstall", async () => {
    await beforeInstall?.();
    updateManager.quitAndInstall();
  });

  ipcMain.handle("update:getStatus", async () => {
    return updateManager.getState();
  });

  ipcMain.handle("update:setAutoCheck", async (_, enabled: boolean) => {
    await updateManager.setAutoCheck(enabled);
    return { success: true };
  });

  ipcMain.handle("update:isAutoCheckEnabled", async () => {
    return updateManager.isAutoCheckEnabled();
  });

  // ===========================================================================
  // Launch at Login
  // ===========================================================================

  ipcMain.handle("autostart:isEnabled", async () => {
    return trayManager.isLaunchAtLoginEnabled();
  });

  ipcMain.handle("autostart:setEnabled", async (_, enabled: boolean) => {
    await trayManager.setLaunchAtLogin(enabled);
    return { success: true };
  });

  // ===========================================================================
  // Titlebar
  // ===========================================================================

  ipcMain.handle("update-title-bar-overlay", (_, options: { color: string; symbolColor: string }) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win && process.platform === "win32") {
      try {
        win.setTitleBarOverlay({
          color: options.color,
          symbolColor: options.symbolColor,
          height: 40,
        });
      } catch {
        // Ignore errors on older Electron versions
      }
    }
  });
}
