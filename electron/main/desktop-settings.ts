import { app } from "electron";
import path from "node:path";
import { callHost, HostControlError, readHostControlMetadata } from "../../shared/host-control-client";
import { acquireRuntimeLock } from "../../shared/runtime-lock";
import { createSettingsStore } from "../../shared/settings-store";

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 100;
const OWNER_TIMEOUT_MS = 1_000;

const readonlyStore = createSettingsStore({
  getFilePath: () => path.join(app.getPath("userData"), "settings.json"),
});

let queue = Promise.resolve();
const pendingWrites = new Set<Promise<void>>();

function isLocked(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ELOCKED";
}

async function persistSettings(dataPath: string, patch: Record<string, unknown>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const previousOwner = await readHostControlMetadata(dataPath);
    if (previousOwner) {
      try {
        await callHost(dataPath, "settings:save", [patch], { timeoutMs: OWNER_TIMEOUT_MS });
        return;
      } catch (error) {
        // Application errors must reach the caller; only a missing owner permits
        // attempting the data-directory lease used by every runtime host.
        if (!(error instanceof HostControlError)
          || !["NOT_RUNNING", "UNAVAILABLE", "UNAUTHORIZED"].includes(error.code)) throw error;
        lastError = error;
      }
    }

    let ownership;
    try {
      ownership = await acquireRuntimeLock(dataPath);
    } catch (error) {
      if (!isLocked(error)) throw error;
      lastError = error;
    }

    if (ownership) {
      try {
        const currentOwner = await readHostControlMetadata(dataPath);
        if (currentOwner?.instanceId === previousOwner?.instanceId) {
          // Unchanged, unreachable metadata can remain after a crash. Holding
          // the runtime lease proves no live host can write this store.
          createSettingsStore({
            getFilePath: () => path.join(ownership.dataPath, "settings.json"),
            createDirectory: true,
          }).saveSettings(patch);
          return;
        }
        lastError = new HostControlError("UNAVAILABLE", "CodeMux host ownership changed while saving settings");
      } finally {
        await ownership.release();
      }
    }

    if (attempt + 1 < MAX_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw lastError ?? new HostControlError("UNAVAILABLE", "CodeMux settings could not be saved");
}

export const desktopSettings = {
  // Native startup and preload need a synchronous read. Always read persisted
  // state so a failed asynchronous write never becomes an optimistic cache.
  loadSettings: readonlyStore.loadSettings,
  saveSettings(patch: Record<string, unknown>): Promise<void> {
    const dataPath = app.getPath("userData");
    const snapshot = structuredClone(patch);
    const operation = queue.then(() => persistSettings(dataPath, snapshot));
    pendingWrites.add(operation);
    // Keep serialization alive after a rejected write, and attach a rejection
    // handler even when a native event does not retain the returned promise.
    queue = operation.then(
      () => { pendingWrites.delete(operation); },
      () => { pendingWrites.delete(operation); },
    );
    return operation;
  },
};

/** Drain admitted native writes before handing ownership to a server process. */
export async function flushDesktopSettings(): Promise<void> {
  let failed = false;
  let failure: unknown;
  while (pendingWrites.size > 0) {
    const results = await Promise.allSettled([...pendingWrites]);
    for (const result of results) {
      if (result.status === "rejected" && !failed) {
        failed = true;
        failure = result.reason;
      }
    }
  }
  if (failed) throw failure;
}
