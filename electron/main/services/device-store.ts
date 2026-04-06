import path from "path";
import { app } from "electron";
import { DeviceStoreBase } from "../../../shared/device-store-base";

// Re-export shared types for existing consumers
export type { DeviceInfo, PendingRequest, DeviceStoreData } from "../../../shared/device-store-types";

// =============================================================================
// Electron DeviceStore — lazy init (must call init() after app.whenReady())
// =============================================================================

class ElectronDeviceStore extends DeviceStoreBase {
  private initialized = false;

  protected getFilePath(): string {
    // In development, share .devices.json with scripts/ Vite plugin
    if (!app.isPackaged) {
      return path.join(process.cwd(), ".devices.json");
    }
    // In production, use standard user data directory
    return path.join(app.getPath("userData"), "devices.json");
  }

  /**
   * Initialize DeviceStore — must be called after app.whenReady()
   * because app.getPath() is not available before that.
   */
  init(): void {
    if (this.initialized) return;
    this.loadData();
    this.initialized = true;
  }

  /**
   * In development, the renderer auth proxy and the server-side shell helpers
   * both share .devices.json with the Electron main process.
   * Reload before reads so approvals made from another process are visible
   * immediately to the running auth API server.
   */
  protected override beforeRead(): void {
    if (!this.initialized || app.isPackaged) return;
    this.loadData();
  }

  /**
   * Reload data from disk.
   * Used to sync with Web side in dev mode.
   */
  override reload(): void {
    if (!this.initialized) return;
    super.reload();
  }
}

export const deviceStore = new ElectronDeviceStore();
