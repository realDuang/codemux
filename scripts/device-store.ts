import path from "path";
import { DeviceStoreBase } from "../shared/device-store-base";

// Re-export shared types for existing consumers
export type { DeviceInfo, PendingRequest, DeviceStoreData } from "../shared/device-store-types";

// =============================================================================
// Scripts DeviceStore — eager init, reloads from disk before every read
// =============================================================================

const DEVICES_FILE = path.join(process.cwd(), ".devices.json");

class ScriptsDeviceStore extends DeviceStoreBase {
  constructor() {
    super();
    this.loadData();
  }

  protected getFilePath(): string {
    return DEVICES_FILE;
  }

  /**
   * In dev mode, the scripts/ Vite plugin shares .devices.json with the
   * Electron main process. Reload from disk before every read operation
   * to stay in sync.
   */
  protected override beforeRead(): void {
    this.loadData();
  }
}

export const deviceStore = new ScriptsDeviceStore();
