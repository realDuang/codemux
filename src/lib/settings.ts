/**
 * Unified settings persistence layer.
 *
 * - Electron: reads/writes settings.json via IPC (preload provides sync cache + async save)
 * - Web (browser): falls back to localStorage
 *
 * Settings shape in settings.json:
 * {
 *   "theme": "light" | "dark" | "system",
 *   "locale": "en" | "zh",
 *   "logLevel": "error" | "warn" | "info" | ...,
 *   "engineModels": {
 *     "opencode": { "providerID": "...", "modelID": "..." },
 *     "claude":   { "providerID": "...", "modelID": "..." },
 *     ...
 *   }
 * }
 */

import { isElectron } from "./platform";
import { Auth } from "./auth";

/** Keys that are synchronized between web clients and the host. */
const SHARED_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "theme",
  "locale",
  "engineModels",
  "defaultEngine",
  "showDefaultWorkspace",
  "scheduledTasksEnabled",
  "worktreeEnabled",
]);

// ---------------------------------------------------------------------------
// Renderer-side settings cache
// ---------------------------------------------------------------------------
// contextBridge serializes objects at expose-time; subsequent mutations in
// preload are NOT visible to the renderer.  We therefore deep-clone the
// initial cache into renderer memory and maintain it ourselves.

let _rendererCache: Record<string, unknown> | null = null;

function getRendererCache(): Record<string, unknown> | null {
  if (_rendererCache) return _rendererCache;
  try {
    const preloadCache = (window as any).electronAPI?.settings?.cache;
    if (preloadCache) {
      // Deep-clone so we own the object (contextBridge returns a frozen proxy)
      _rendererCache = JSON.parse(JSON.stringify(preloadCache));
      return _rendererCache;
    }
  } catch {
    // not in Electron
  }
  return null;
}

function electronSave(patch: Record<string, unknown>): void {
  try {
    (window as any).electronAPI?.settings?.save(patch);
  } catch {
    // ignore — not in Electron
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Synchronously read a setting value. Works at module-init time in Electron. */
export function getSetting<T = unknown>(key: string): T | undefined {
  if (isElectron()) {
    const cache = getRendererCache();
    if (cache) {
      return cache[key] as T | undefined;
    }
  }
  // Web fallback: localStorage
  try {
    const raw = localStorage.getItem(`settings:${key}`);
    if (raw === null) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Save a setting value. Async write to settings.json in Electron, localStorage in web. */
export function saveSetting(key: string, value: unknown): void {
  if (isElectron()) {
    // Update renderer-side cache immediately so subsequent reads see the new value
    const cache = getRendererCache();
    if (cache) {
      cache[key] = value;
    }
    electronSave({ [key]: value });
  }
  // Always write to localStorage as well for web mode and as immediate cache
  try {
    localStorage.setItem(`settings:${key}`, JSON.stringify(value));
  } catch (err) {
    // storage full or unavailable
    console.warn("[Settings] Failed to save to localStorage:", err);
  }

  // In web mode, also write back to host so the setting persists across refreshes
  if (!isElectron() && SHARED_SETTINGS_KEYS.has(key) && Auth.isAuthenticated() && typeof fetch === "function") {
    try {
      const p = fetch("/api/settings/shared", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...Auth.getAuthHeaders(),
        },
        body: JSON.stringify({ [key]: value }),
      });
      if (p && typeof p.catch === "function") {
        p.catch(() => {});
      }
    } catch {
      // Best-effort — swallow errors
    }
  }
}

/** Read a nested setting (e.g. "engineModels.claude") */
export function getNestedSetting<T = unknown>(path: string): T | undefined {
  const parts = path.split(".");
  if (parts.length === 1) return getSetting<T>(parts[0]);

  const root = getSetting<Record<string, unknown>>(parts[0]);
  if (!root) return undefined;

  let current: unknown = root;
  for (let i = 1; i < parts.length; i++) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[parts[i]];
  }
  return current as T | undefined;
}

/** Save a nested setting (e.g. "engineModels.claude", value) */
export function saveNestedSetting(path: string, value: unknown): void {
  const parts = path.split(".");
  if (parts.length === 1) {
    saveSetting(parts[0], value);
    return;
  }

  // Read root, merge nested, save entire root
  const root = getSetting<Record<string, unknown>>(parts[0]) ?? {};
  let target: Record<string, unknown> = root;
  for (let i = 1; i < parts.length - 1; i++) {
    if (!target[parts[i]] || typeof target[parts[i]] !== "object") {
      target[parts[i]] = {};
    }
    target = target[parts[i]] as Record<string, unknown>;
  }
  target[parts[parts.length - 1]] = value;
  saveSetting(parts[0], root);
}

// ---------------------------------------------------------------------------
// Host settings bootstrap (web clients only)
// ---------------------------------------------------------------------------
// Fetches shared settings from the host's settings.json via the API and
// writes them into localStorage so that getSetting() returns host values.
// Called once on page load after authentication.

let _bootstrapDone = false;

/**
 * Fetch host settings and write them to localStorage.
 * No-op in Electron (settings already come from preload cache).
 * No-op if already bootstrapped in this page session.
 * Returns true if settings were applied, false otherwise.
 */
export async function bootstrapHostSettings(): Promise<boolean> {
  if (isElectron()) return false;
  if (_bootstrapDone) return false;
  if (!Auth.isAuthenticated()) return false;

  try {
    const res = await fetch("/api/settings/shared", {
      headers: Auth.getAuthHeaders(),
    });
    if (!res.ok) return false;

    const data = await res.json();
    const settings = data.settings as Record<string, unknown> | undefined;
    if (!settings || typeof settings !== "object") return false;

    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) {
        try {
          localStorage.setItem(`settings:${key}`, JSON.stringify(value));
        } catch {
          // localStorage full or unavailable
        }
      }
    }

    _bootstrapDone = true;
    return true;
  } catch {
    return false;
  }
}

/** Reset bootstrap state (for testing). */
export function _resetBootstrapState(): void {
  _bootstrapDone = false;
}
