import { app } from "electron";
import pkg from "electron-updater";
import type { UpdateInfo, ProgressInfo } from "electron-updater";
const { autoUpdater } = pkg;
import { getMainWindow } from "../window-manager";
import log, { loadSettings, saveSettings } from "./logger";

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
  downloadUrl?: string;
}

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

const GITHUB_RELEASES_URL = "https://github.com/realDuang/codemux/releases";

function isCodeSignError(message: string): boolean {
  return /code.?sign/i.test(message) || message.includes("代码不含资源");
}

class UpdateManager {
  private status: UpdateStatus = "idle";
  private updateInfo: UpdateInfo | null = null;
  private downloadProgress: ProgressInfo | null = null;
  private errorMessage: string | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private initialCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
  private updating = false;

  init(): void {
    // Configure logging
    autoUpdater.logger = log;

    // macOS: Disable auto-download since Squirrel.Mac requires code signing
    // which is not configured. Only check for version updates and show a
    // manual download link. Same approach as hello-halo.
    // Windows: Auto-download in background and install on quit.
    if (process.platform === "darwin") {
      autoUpdater.autoDownload = false;
    } else {
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
    }

    // Register event listeners
    autoUpdater.on("checking-for-update", () => {
      this.status = "checking";
      this.sendToRenderer("update:status", this.getState());
    });

    autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.updateInfo = info;
      if (process.platform === "darwin") {
        // macOS: skip download, show manual download link directly
        this.status = "available";
        const version = info.version;
        const state = this.getState();
        state.downloadUrl = `${GITHUB_RELEASES_URL}/tag/v${version}`;
        this.sendToRenderer("update:available", state);
      } else {
        this.status = "available";
        this.sendToRenderer("update:available", this.getState());
      }
    });

    autoUpdater.on("update-not-available", (_info: UpdateInfo) => {
      this.status = "not-available";
      this.sendToRenderer("update:status", this.getState());
      // Reset to idle after a short delay so UI can show "up to date" briefly
      setTimeout(() => {
        if (this.status === "not-available") {
          this.status = "idle";
          this.sendToRenderer("update:status", this.getState());
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
    this.initialized = true;
    this.scheduleCheck();
  }

  async checkForUpdates(): Promise<UpdateState> {
    if (!this.initialized) {
      return { status: "idle" };
    }

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
    this.updating = true;
    // On macOS, MacUpdater.quitAndInstall() relies on Squirrel.Mac having
    // already downloaded the update (squirrelDownloadedUpdate flag). If the
    // Squirrel download hasn't finished (or failed silently), the method
    // only registers a listener but won't trigger a new download when
    // autoInstallOnAppQuit is true. Setting it to false forces a retry.
    if (process.platform === "darwin") {
      autoUpdater.autoInstallOnAppQuit = false;
    }

    const resetUpdating = () => {
      this.updating = false;
    };
    autoUpdater.once("error", resetUpdating);

    try {
      autoUpdater.quitAndInstall();
    } catch {
      resetUpdating();
    }
  }

  isInstallingUpdate(): boolean {
    return this.updating;
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
      if (isCodeSignError(this.errorMessage)) {
        const version = this.updateInfo?.version;
        state.downloadUrl = version
          ? `${GITHUB_RELEASES_URL}/tag/v${version}`
          : `${GITHUB_RELEASES_URL}/latest`;
      }
    }

    return state;
  }

  private scheduleCheck(): void {
    const settings = loadSettings();
    const autoCheck = settings.autoUpdate !== false; // default: true

    if (autoCheck) {
      // Initial check after 30 seconds (let app finish starting)
      this.initialCheckTimer = setTimeout(() => {
        this.initialCheckTimer = null;
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

    if (this.initialCheckTimer) {
      clearTimeout(this.initialCheckTimer);
      this.initialCheckTimer = null;
    }

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
