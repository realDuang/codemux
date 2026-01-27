import { createEffect, onCleanup } from "solid-js";
import { Auth } from "./auth";
import { logger } from "./logger";

const SYNCED_KEYS = [
  "opencode.global.dat:server",
  "opencode.global.dat:layout.page",
];

const SYNC_DEBOUNCE_MS = 1000;
const POLL_INTERVAL_MS = 5000;

export function getCurrentNetworkSourceKey(): string {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    return "local";
  }
  
  const protocol = window.location.protocol;
  const port = window.location.port;
  
  if (!port || (protocol === "https:" && port === "443") || (protocol === "http:" && port === "80")) {
    return `${protocol}//${host}`;
  }
  
  return `${protocol}//${host}:${port}`;
}

interface StorageSyncResponse {
  data: Record<string, string>;
  timestamp: number;
  deviceId: string | null;
  syncedKeys: string[];
}

let lastUploadTimestamp = 0;
let lastLocalSnapshot = "";
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function getLocalStorageSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const key of SYNCED_KEYS) {
    const value = localStorage.getItem(key);
    if (value) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

async function uploadToServer(data: Record<string, string>): Promise<void> {
  const token = Auth.getToken();
  if (!token) return;

  try {
    const response = await fetch("/api/storage-sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ data }),
    });

    if (response.ok) {
      lastUploadTimestamp = Date.now();
      logger.debug("[StorageSync] Uploaded to server");
    }
  } catch (err) {
    logger.warn("[StorageSync] Upload failed:", err);
  }
}

async function fetchFromServer(): Promise<StorageSyncResponse | null> {
  const token = Auth.getToken();
  if (!token) return null;

  try {
    const response = await fetch("/api/storage-sync", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    logger.warn("[StorageSync] Fetch failed:", err);
    return null;
  }
}

function mergeServerDataToLocal(serverData: Record<string, string>): boolean {
  let changed = false;

  for (const key of SYNCED_KEYS) {
    const serverValue = serverData[key];
    if (!serverValue) continue;

    const localValue = localStorage.getItem(key);

    if (!localValue) {
      localStorage.setItem(key, serverValue);
      changed = true;
      logger.debug("[StorageSync] Set missing key from server:", key);
      continue;
    }

    try {
      const serverObj = JSON.parse(serverValue);
      const localObj = JSON.parse(localValue);

      if (key === "opencode.global.dat:server") {
        changed = mergeServerData(localObj, serverObj, key) || changed;
      } else {
        changed = mergeLayoutData(localObj, serverObj, key) || changed;
      }
    } catch {
      logger.warn("[StorageSync] Failed to parse JSON for key:", key);
    }
  }

  return changed;
}

function mergeServerData(
  local: Record<string, unknown>,
  server: Record<string, unknown>,
  key: string
): boolean {
  let changed = false;
  const currentSource = getCurrentNetworkSourceKey();

  const serverProjects = (server.projects || {}) as Record<string, unknown[]>;
  const serverLastProject = (server.lastProject || {}) as Record<string, string>;

  const serverWorktrees = new Set<string>();
  for (const list of Object.values(serverProjects)) {
    for (const proj of list as Array<{ worktree?: string }>) {
      if (proj.worktree) serverWorktrees.add(proj.worktree);
    }
  }

  if (serverWorktrees.size > 0) {
    const serverProjectList = Array.from(serverWorktrees).map((w) => ({
      worktree: w,
      expanded: true,
    }));

    const allKeys = new Set([
      ...Object.keys(serverProjects),
      currentSource,
    ]);

    const newProjects: Record<string, unknown[]> = {};
    for (const k of allKeys) {
      newProjects[k] = serverProjectList;
    }

    local.projects = newProjects;
    changed = true;
    logger.debug("[StorageSync] Synced projects from server:", serverWorktrees.size);
  }

  const lastProjectValue = serverLastProject["local"] || 
    (serverWorktrees.size > 0 ? Array.from(serverWorktrees)[0] : null);
  
  if (lastProjectValue) {
    const newLastProject: Record<string, string> = { ...serverLastProject };
    newLastProject[currentSource] = lastProjectValue;
    local.lastProject = newLastProject;
    changed = true;
  }

  if (changed) {
    localStorage.setItem(key, JSON.stringify(local));
  }

  return changed;
}

function mergeLayoutData(
  local: Record<string, unknown>,
  server: Record<string, unknown>,
  key: string
): boolean {
  let changed = false;
  const currentSource = getCurrentNetworkSourceKey();

  for (const [sourceKey, value] of Object.entries(server)) {
    if (!local[sourceKey]) {
      local[sourceKey] = value;
      changed = true;
    }
  }

  if (!local[currentSource]) {
    const fallbackValue = local["local"] || server["local"] || Object.values(server)[0];
    if (fallbackValue) {
      local[currentSource] = fallbackValue;
      changed = true;
      logger.debug("[StorageSync] Set layout for", currentSource);
    }
  }

  if (changed) {
    localStorage.setItem(key, JSON.stringify(local));
    logger.debug("[StorageSync] Merged layout data");
  }

  return changed;
}

function debouncedUpload() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    const snapshot = getLocalStorageSnapshot();
    if (Object.keys(snapshot).length > 0) {
      uploadToServer(snapshot);
    }
    debounceTimer = null;
  }, SYNC_DEBOUNCE_MS);
}

function handleStorageChange(event: StorageEvent) {
  if (!event.key || !SYNCED_KEYS.includes(event.key)) return;
  logger.debug("[StorageSync] Detected change in:", event.key);
  debouncedUpload();
}

export async function initStorageSyncAsync(): Promise<void> {
  const localSnapshot = getLocalStorageSnapshot();
  const hasLocalData = Object.keys(localSnapshot).length > 0;

  if (hasLocalData) {
    await uploadToServer(localSnapshot);
    lastLocalSnapshot = JSON.stringify(localSnapshot);
    logger.debug("[StorageSync] Uploaded local data to server");
  } else {
    const response = await fetchFromServer();
    if (response?.data && Object.keys(response.data).length > 0) {
      mergeServerDataToLocal(response.data);
      lastLocalSnapshot = JSON.stringify(getLocalStorageSnapshot());
      logger.debug("[StorageSync] Pulled data from server (local was empty)");
    }
  }
}

function checkAndUploadLocalChanges() {
  const snapshot = getLocalStorageSnapshot();
  const snapshotStr = JSON.stringify(snapshot);
  
  if (snapshotStr !== lastLocalSnapshot) {
    lastLocalSnapshot = snapshotStr;
    logger.debug("[StorageSync] Detected local change, uploading");
    uploadToServer(snapshot);
  }
}

export function initStorageSync() {
  window.addEventListener("storage", handleStorageChange);

  initStorageSyncAsync();

  const pollInterval = setInterval(async () => {
    checkAndUploadLocalChanges();

    const response = await fetchFromServer();
    if (response?.data && response.timestamp > lastUploadTimestamp) {
      mergeServerDataToLocal(response.data);
      lastLocalSnapshot = JSON.stringify(getLocalStorageSnapshot());
    }
  }, POLL_INTERVAL_MS);

  return () => {
    window.removeEventListener("storage", handleStorageChange);
    clearInterval(pollInterval);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
  };
}

export function useStorageSync() {
  createEffect(() => {
    const cleanup = initStorageSync();
    onCleanup(cleanup);
  });
}
