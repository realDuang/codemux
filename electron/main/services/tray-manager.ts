import { app, Tray, Menu, nativeImage } from "electron";
import { join } from "path";
import fs from "fs";
import { getMainWindow, createWindow } from "../window-manager";
import { loadSettings, saveSettings } from "./logger";

class TrayManager {
  private tray: Tray | null = null;

  init(): void {
    if (this.tray) return;

    const iconPath = this.getIconPath();
    const icon = nativeImage.createFromPath(iconPath);
    // Use a 16x16 icon for the tray on all platforms
    const trayIcon = icon.resize({ width: 16, height: 16 });

    this.tray = new Tray(trayIcon);
    this.tray.setToolTip("CodeMux");
    this.updateContextMenu();

    // Toggle window visibility on click (Windows/Linux) or double-click
    this.tray.on("click", () => {
      this.toggleWindow();
    });
  }

  private getIconPath(): string {
    if (app.isPackaged) {
      // In packaged app, icon is in the app resources
      if (process.platform === "win32") {
        return join(process.resourcesPath, "app.asar", "out", "renderer", "assets", "favicon-32x32.png");
      }
      return join(process.resourcesPath, "app.asar", "out", "renderer", "assets", "favicon-32x32.png");
    }
    // In dev mode, use the public folder
    return join(app.getAppPath(), "public", "assets", "favicon-32x32.png");
  }

  private toggleWindow(): void {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      if (win.isVisible()) {
        win.hide();
      } else {
        win.show();
        win.focus();
      }
    } else {
      // Window was closed (macOS), recreate it
      createWindow();
    }
    this.updateContextMenu();
  }

  showWindow(): void {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    } else {
      createWindow();
    }
    this.updateContextMenu();
  }

  updateContextMenu(): void {
    if (!this.tray) return;

    const win = getMainWindow();
    const isVisible = win && !win.isDestroyed() && win.isVisible();

    const contextMenu = Menu.buildFromTemplate([
      {
        label: isVisible ? "Hide Window" : "Show Window",
        click: () => this.toggleWindow(),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  // --- Launch at Login ---

  isLaunchAtLoginEnabled(): boolean {
    const settings = loadSettings();
    return settings.launchAtLogin === true;
  }

  setLaunchAtLogin(enabled: boolean): void {
    saveSettings({ launchAtLogin: enabled });

    if (process.platform === "linux") {
      // On Linux, app.setLoginItemSettings may not work reliably.
      // We handle it via .desktop file in autostart directory.
      this.setLinuxAutostart(enabled);
      return;
    }

    app.setLoginItemSettings({
      openAtLogin: enabled,
      ...(process.platform === "darwin" ? { openAsHidden: true } : {}),
      args: process.platform === "win32" ? ["--hidden"] : [],
    });
  }

  private setLinuxAutostart(enabled: boolean): void {
    try {
      const autostartDir = join(app.getPath("home"), ".config", "autostart");
      const desktopFile = join(autostartDir, "codemux.desktop");

      if (enabled) {
        if (!fs.existsSync(autostartDir)) {
          fs.mkdirSync(autostartDir, { recursive: true });
        }
        const appPath = process.execPath;
        const content = `[Desktop Entry]
Type=Application
Name=CodeMux
Exec=${appPath} --hidden
Terminal=false
X-GNOME-Autostart-enabled=true
`;
        fs.writeFileSync(desktopFile, content);
      } else {
        if (fs.existsSync(desktopFile)) {
          fs.unlinkSync(desktopFile);
        }
      }
    } catch {
      // Silently fail if autostart setup fails
    }
  }

}

export const trayManager = new TrayManager();
