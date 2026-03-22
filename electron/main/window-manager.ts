import { app, BrowserWindow, dialog, shell } from "electron";
import { join } from "path";
import { loadSettings, saveSettings } from "./services/logger";

let mainWindow: BrowserWindow | null = null;
let isQuittingApp = false;

// When app.quit() is called (e.g., from tray menu or Cmd+Q), skip the close dialog
app.on("before-quit", () => {
  isQuittingApp = true;
});

const closeDialogLabels: Record<string, { title: string; message: string; tray: string; quit: string; remember: string }> = {
  zh: {
    title: "关闭 CodeMux",
    message: "您要最小化到系统托盘还是退出应用？",
    tray: "最小化到托盘",
    quit: "退出",
    remember: "记住我的选择",
  },
  en: {
    title: "Close CodeMux",
    message: "Would you like to minimize to system tray or quit?",
    tray: "Minimize to Tray",
    quit: "Quit",
    remember: "Remember my choice",
  },
};

export function createWindow(hidden = false): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Platform-specific title bar styling
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 16 },
        }
      : process.platform === "win32"
        ? {
            titleBarStyle: "hidden" as const,
            titleBarOverlay: {
              color: "#020617",       // slate-950
              symbolColor: "#94a3b8", // slate-400
              height: 40,
            },
          }
        : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: false, // Required for IPC communication in preload
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    if (!hidden) {
      mainWindow?.maximize();
      mainWindow?.show();
    }
  });

  // Intercept close: show dialog asking minimize-to-tray vs quit
  mainWindow.on("close", (event) => {
    if (isQuittingApp || !mainWindow || mainWindow.isDestroyed()) return;

    const settings = loadSettings();

    // User previously chose "quit" and remembered
    if (settings.closeAction === "quit") return;

    // User previously chose "tray" and remembered
    if (settings.closeAction === "tray") {
      event.preventDefault();
      mainWindow.hide();
      updateTrayMenu();
      return;
    }

    // First time or not remembered — show dialog
    event.preventDefault();
    const locale = (settings.locale as string) || "en";
    const labels = closeDialogLabels[locale] || closeDialogLabels.en;

    dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: [labels.tray, labels.quit],
      defaultId: 0,
      title: labels.title,
      message: labels.message,
      checkboxLabel: labels.remember,
      checkboxChecked: false,
    }).then(({ response, checkboxChecked }) => {
      if (response === 0) {
        // Minimize to tray
        if (checkboxChecked) saveSettings({ closeAction: "tray" });
        mainWindow?.hide();
        updateTrayMenu();
      } else {
        // Quit
        if (checkboxChecked) saveSettings({ closeAction: "quit" });
        app.quit();
      }
    });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  // Load page
  if (process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    // In production, load from the app package
    const indexPath = join(app.getAppPath(), "out/renderer/index.html");
    mainWindow.loadFile(indexPath);
  }

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

async function updateTrayMenu(): Promise<void> {
  try {
    const { trayManager } = await import("./services/tray-manager");
    trayManager.updateContextMenu();
  } catch {
    // tray-manager not available
  }
}