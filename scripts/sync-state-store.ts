import fs from "fs";
import path from "path";

const SYNC_STATE_FILE = path.join(process.cwd(), ".sync-state.json");

export interface SyncState {
  // Current URL path in the Official App iframe
  currentUrl: string | null;
  // Timestamp of when this state was set
  timestamp: number;
  // Device ID that set this state
  deviceId: string | null;
}

class SyncStateStore {
  private state: SyncState = {
    currentUrl: null,
    timestamp: 0,
    deviceId: null,
  };

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(SYNC_STATE_FILE)) {
        this.state = JSON.parse(fs.readFileSync(SYNC_STATE_FILE, "utf-8"));
      }
    } catch (e) {
      console.error("[SyncStateStore] Failed to load sync state:", e);
      this.state = { currentUrl: null, timestamp: 0, deviceId: null };
    }
  }

  private save() {
    try {
      fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (e) {
      console.error("[SyncStateStore] Failed to save sync state:", e);
    }
  }

  getState(): SyncState {
    return { ...this.state };
  }

  setState(url: string, deviceId: string): SyncState {
    this.state = {
      currentUrl: url,
      timestamp: Date.now(),
      deviceId,
    };
    this.save();
    return { ...this.state };
  }

  // Only update if timestamp is newer (for conflict resolution)
  setStateIfNewer(url: string, timestamp: number, deviceId: string): boolean {
    if (timestamp > this.state.timestamp) {
      this.state = { currentUrl: url, timestamp, deviceId };
      this.save();
      return true;
    }
    return false;
  }
}

export const syncStateStore = new SyncStateStore();
