import { app } from "electron";
import { autoUpdater, type UpdateInfo, type ProgressInfo } from "electron-updater";
import log from "electron-log";
import { getMainWindow } from "../window-manager";
import { loadSettings, saveSettings } from "./logger";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  releaseNotes?: string;
  progress?: {
    percent: number;
    bytesPerSecond: number;
    transferred: number;
    total: number;
  };
  error?: string;
}

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

class UpdateManager {
  private status: UpdateStatus = "idle";
  private updateInfo: UpdateInfo | null = null;
  private downloadProgress: ProgressInfo | null = null;
  private errorMessage: string | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  init(): void {
    // Configure logging
    autoUpdater.logger = log;

    // Auto-download in background
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    // Register event listeners
    autoUpdater.on("checking-for-update", () => {
      this.status = "checking";
      this.sendToRenderer("update:status", this.getState());
    });

    autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.status = "available";
      this.updateInfo = info;
      this.sendToRenderer("update:available", this.getState());
    });

    autoUpdater.on("update-not-available", (_info: UpdateInfo) => {
      this.status = "not-available";
      this.sendToRenderer("update:status", this.getState());
      // Reset to idle after a short delay so UI can show "up to date" briefly
      setTimeout(() => {
        if (this.status === "not-available") {
          this.status = "idle";
        }
      }, 5000);
    });

    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      this.status = "downloading";
      this.downloadProgress = progress;
      this.sendToRenderer("update:progress", this.getState());
    });

    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      this.status = "downloaded";
      this.updateInfo = info;
      this.downloadProgress = null;
      this.sendToRenderer("update:downloaded", this.getState());
    });

    autoUpdater.on("error", (err: Error) => {
      this.status = "error";
      this.errorMessage = err.message;
      this.sendToRenderer("update:error", this.getState());
    });

    // Schedule auto-check if enabled
    this.scheduleCheck();
  }

  async checkForUpdates(): Promise<UpdateState> {
    if (this.status === "checking" || this.status === "downloading") {
      return this.getState();
    }

    try {
      this.status = "checking";
      this.errorMessage = null;
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.status = "error";
      this.errorMessage = err instanceof Error ? err.message : String(err);
    }
    return this.getState();
  }

  quitAndInstall(): void {
    autoUpdater.quitAndInstall();
  }

  getState(): UpdateState {
    const state: UpdateState = { status: this.status };

    if (this.updateInfo) {
      state.version = this.updateInfo.version;
      if (typeof this.updateInfo.releaseNotes === "string") {
        state.releaseNotes = this.updateInfo.releaseNotes;
      }
    }

    if (this.downloadProgress) {
      state.progress = {
        percent: this.downloadProgress.percent,
        bytesPerSecond: this.downloadProgress.bytesPerSecond,
        transferred: this.downloadProgress.transferred,
        total: this.downloadProgress.total,
      };
    }

    if (this.errorMessage) {
      state.error = this.errorMessage;
    }

    return state;
  }

  private scheduleCheck(): void {
    const settings = loadSettings();
    const autoCheck = settings.autoUpdate !== false; // default: true

    if (autoCheck) {
      // Initial check after 30 seconds (let app finish starting)
      setTimeout(() => {
        this.checkForUpdates();
      }, 30_000);

      // Periodic check
      this.checkTimer = setInterval(() => {
        this.checkForUpdates();
      }, CHECK_INTERVAL_MS);
    }
  }

  setAutoCheck(enabled: boolean): void {
    saveSettings({ autoUpdate: enabled });

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    if (enabled) {
      this.checkTimer = setInterval(() => {
        this.checkForUpdates();
      }, CHECK_INTERVAL_MS);
    }
  }

  isAutoCheckEnabled(): boolean {
    const settings = loadSettings();
    return settings.autoUpdate !== false;
  }

  private sendToRenderer(channel: string, data: UpdateState): void {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}

export const updateManager = new UpdateManager();
