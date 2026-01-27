import fs from "fs";
import path from "path";

const STORAGE_SYNC_FILE = path.join(process.cwd(), ".storage-sync.json");

const SYNCED_KEYS = [
  "opencode.global.dat:server",
  "opencode.global.dat:layout.page",
];

export interface StorageSyncData {
  data: Record<string, string>;
  timestamp: number;
  deviceId: string | null;
}

class StorageSyncStore {
  private state: StorageSyncData = {
    data: {},
    timestamp: 0,
    deviceId: null,
  };

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(STORAGE_SYNC_FILE)) {
        this.state = JSON.parse(fs.readFileSync(STORAGE_SYNC_FILE, "utf-8"));
      }
    } catch (e) {
      console.error("[StorageSyncStore] Failed to load:", e);
      this.state = { data: {}, timestamp: 0, deviceId: null };
    }
  }

  private save() {
    try {
      fs.writeFileSync(STORAGE_SYNC_FILE, JSON.stringify(this.state, null, 2));
    } catch (e) {
      console.error("[StorageSyncStore] Failed to save:", e);
    }
  }

  getState(): StorageSyncData {
    return { ...this.state, data: { ...this.state.data } };
  }

  getSyncedKeys(): string[] {
    return SYNCED_KEYS;
  }

  updateData(
    data: Record<string, string>,
    deviceId: string
  ): StorageSyncData {
    for (const key of Object.keys(data)) {
      if (SYNCED_KEYS.includes(key)) {
        this.state.data[key] = data[key];
      }
    }
    this.state.timestamp = Date.now();
    this.state.deviceId = deviceId;
    this.save();
    return this.getState();
  }
}

export const storageSyncStore = new StorageSyncStore();
