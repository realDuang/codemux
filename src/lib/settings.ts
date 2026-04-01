/**
 * Unified settings persistence layer.
 *
 * - Electron: reads/writes settings.json via IPC (preload provides sync cache + async save)
 * - Web (browser): falls back to localStorage, or uses host-backed shared settings when enabled
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

import { createSignal } from "solid-js";
import { isElectron } from "./platform";
import { Auth } from "./auth";
import { gatewayClient } from "./gateway-client";
import {
  SHARED_SETTINGS_KEYS,
  SETTINGS_SYNC_ENABLED_KEY,
  filterSharedSettings,
  getSettingsSyncEnabled,
  isLocalOnlySettingsKey,
  isSharedSettingsKey,
} from "../../shared/settings-sync";

// ---------------------------------------------------------------------------
// Renderer-side settings cache
// ---------------------------------------------------------------------------
// contextBridge serializes objects at expose-time; subsequent mutations in
// preload are NOT visible to the renderer.  We therefore deep-clone the
// initial cache into renderer memory and maintain it ourselves.

let _rendererCache: Record<string, unknown> | null = null;
let _sharedSettingsCache: Record<string, unknown> | null = null;
let _settingsSyncEnabled: boolean | null = null;
let _settingsBootstrapPromise: Promise<void> | null = null;
let sharedSettingsWriteChain: Promise<void> = Promise.resolve();
// Keys currently being written via async Electron IPC. Used to prevent stale
// broadcast snapshots from overwriting optimistic cache updates before the
// round-trip completes.
const _pendingElectronWriteKeys = new Set<string>();
const deletedSharedSetting = Symbol("deletedSharedSetting");
const pendingSharedSettingOverrides = new Map<
  string,
  unknown | typeof deletedSharedSetting
>();
const [settingsVersion, setSettingsVersion] = createSignal(0);
const webSettingsChangeListeners = new Set<
  (settings: Record<string, unknown>) => void | Promise<void>
>();
const WEB_SETTINGS_POLL_INTERVAL_MS = 3000;
let webSettingsPollTimer: ReturnType<typeof setInterval> | null = null;
let webSettingsPollInFlight: Promise<void> | null = null;
let webSettingsSnapshotHash: string | null = null;
let removeWebSettingsListeners: (() => void) | null = null;
let removeGatewaySettingsListener: (() => void) | null = null;

function createLocalStorageKey(key: string): string {
  return `settings:${key}`;
}

function readLocalSetting<T = unknown>(key: string): T | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(createLocalStorageKey(key));
    if (raw === null) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function writeLocalSetting(key: string, value: unknown): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (value === undefined) {
      localStorage.removeItem(createLocalStorageKey(key));
      return;
    }
    localStorage.setItem(createLocalStorageKey(key), JSON.stringify(value));
  } catch (err) {
    console.warn("[Settings] Failed to save to localStorage:", err);
  }
}

function writeSharedSettingsFallback(sharedSettings: Record<string, unknown>): void {
  for (const key of SHARED_SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(sharedSettings, key)) {
      writeLocalSetting(key, sharedSettings[key]);
    } else {
      writeLocalSetting(key, undefined);
    }
  }
}

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

function getSharedSettingsCache(): Record<string, unknown> {
  if (!_sharedSettingsCache) {
    _sharedSettingsCache = {};
  }
  return _sharedSettingsCache;
}

function cloneSettingValue<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function setSettingsSyncEnabled(enabled: boolean): void {
  _settingsSyncEnabled = enabled;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeSettingValue(existing: unknown, patch: unknown): unknown {
  if (patch === undefined) {
    return undefined;
  }

  if (isPlainObject(existing) && isPlainObject(patch)) {
    return {
      ...existing,
      ...patch,
    };
  }

  return patch;
}

function setNestedObjectValue(
  target: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  if (path.length === 0) {
    return;
  }

  let cursor = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next = cursor[key];
    if (!isPlainObject(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }

  cursor[path[path.length - 1]] = value;
}

function normalizeSettingsValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSettingsValue(item));
  }
  if (value && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      normalized[key] = normalizeSettingsValue(
        (value as Record<string, unknown>)[key],
      );
    }
    return normalized;
  }
  return value;
}

function buildSharedSettingsSnapshotHash(
  syncEnabled: boolean,
  sharedSettings: Record<string, unknown>,
): string {
  return JSON.stringify(
    normalizeSettingsValue({
      syncEnabled,
      sharedSettings,
    }),
  );
}

function getWebSettingsRecord(
  syncEnabled: boolean,
  sharedSettings: Record<string, unknown>,
): Record<string, unknown> {
  return {
    [SETTINGS_SYNC_ENABLED_KEY]: syncEnabled,
    ...sharedSettings,
  };
}

function applyPendingSharedSettingOverrides(
  sharedSettings: Record<string, unknown>,
): Record<string, unknown> {
  if (pendingSharedSettingOverrides.size === 0) {
    return sharedSettings;
  }

  const next = { ...sharedSettings };
  for (const [key, value] of pendingSharedSettingOverrides) {
    if (value === deletedSharedSetting) {
      delete next[key];
    } else {
      next[key] = cloneSettingValue(value);
    }
  }
  return next;
}

function setPendingSharedSettingOverride(key: string, value: unknown): void {
  pendingSharedSettingOverrides.set(
    key,
    value === undefined ? deletedSharedSetting : cloneSettingValue(value),
  );
}

function clearPendingSharedSettingOverride(key: string): void {
  pendingSharedSettingOverrides.delete(key);
}

function getPendingSharedSettingOverride<T = unknown>(key: string): T | undefined {
  if (!pendingSharedSettingOverrides.has(key)) {
    return undefined;
  }
  const value = pendingSharedSettingOverrides.get(key);
  return value === deletedSharedSetting ? undefined : value as T;
}

function hasPendingSharedSettingOverride(key: string): boolean {
  return pendingSharedSettingOverrides.has(key);
}

function applySharedSettingsSnapshot(snapshot: {
  syncEnabled: boolean;
  sharedSettings: Record<string, unknown>;
}): boolean {
  const syncEnabled = snapshot.syncEnabled === true;
  const sharedSettings = syncEnabled
    ? applyPendingSharedSettingOverrides(filterSharedSettings(snapshot.sharedSettings ?? {}))
    : filterSharedSettings(snapshot.sharedSettings ?? {});
  const nextHash = buildSharedSettingsSnapshotHash(syncEnabled, sharedSettings);

  if (webSettingsSnapshotHash === nextHash) {
    return false;
  }

  webSettingsSnapshotHash = nextHash;
  setSettingsSyncEnabled(syncEnabled);
  _sharedSettingsCache = syncEnabled ? sharedSettings : null;
  if (syncEnabled) {
    writeSharedSettingsFallback(sharedSettings);
  }
  setSettingsVersion((version) => version + 1);
  return true;
}

function queueSharedSettingsWrite<T>(task: () => Promise<T>): Promise<T> {
  const nextWrite = sharedSettingsWriteChain
    .catch(() => undefined)
    .then(task);

  sharedSettingsWriteChain = nextWrite.then(
    () => undefined,
    () => undefined,
  );

  return nextWrite;
}

async function waitForPendingSharedSettingsWrites(): Promise<void> {
  await sharedSettingsWriteChain;
}

function notifyWebSettingsChangeListeners(
  syncEnabled: boolean,
  sharedSettings: Record<string, unknown>,
): void {
  const settings = getWebSettingsRecord(syncEnabled, sharedSettings);
  for (const listener of webSettingsChangeListeners) {
    void listener(settings);
  }
}

async function pollWebSettingsChanges(): Promise<void> {
  if (isElectron() || webSettingsChangeListeners.size === 0) {
    return;
  }

  if (webSettingsPollInFlight) {
    await webSettingsPollInFlight;
    return;
  }

  webSettingsPollInFlight = (async () => {
    try {
      if (!Auth.isAuthenticated()) {
        const changed = applySharedSettingsSnapshot({
          syncEnabled: false,
          sharedSettings: {},
        });
        if (changed) {
          notifyWebSettingsChangeListeners(false, {});
        }
        return;
      }

      await waitForPendingSharedSettingsWrites();

      const data = await fetchJson<{
        syncEnabled: boolean;
        sharedSettings: Record<string, unknown>;
      }>("/api/settings/bootstrap", {
        cache: "no-store",
        headers: getAuthHeaders(),
      });

      const changed = applySharedSettingsSnapshot(data);
      if (changed) {
        notifyWebSettingsChangeListeners(
          data.syncEnabled === true,
          filterSharedSettings(data.sharedSettings ?? {}),
        );
      }
    } catch {
      // Ignore transient network errors and keep the last known shared settings.
    } finally {
      webSettingsPollInFlight = null;
    }
  })();

  await webSettingsPollInFlight;
}

function startWebSettingsChangeSubscription(): void {
  if (isElectron() || webSettingsPollTimer) {
    return;
  }

  const handleVisibilityOrFocus = () => {
    if (
      typeof document !== "undefined"
      && "visibilityState" in document
      && document.visibilityState === "hidden"
    ) {
      return;
    }
    void pollWebSettingsChanges();
  };

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", handleVisibilityOrFocus);
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);
  }

  removeWebSettingsListeners = () => {
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("focus", handleVisibilityOrFocus);
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
    }
  };

  removeGatewaySettingsListener = subscribeToGatewaySettingsChanges();

  webSettingsPollTimer = setInterval(() => {
    void pollWebSettingsChanges();
  }, WEB_SETTINGS_POLL_INTERVAL_MS);

  void pollWebSettingsChanges();
}

function stopWebSettingsChangeSubscription(): void {
  if (webSettingsPollTimer) {
    clearInterval(webSettingsPollTimer);
    webSettingsPollTimer = null;
  }
  removeWebSettingsListeners?.();
  removeWebSettingsListeners = null;
  removeGatewaySettingsListener?.();
  removeGatewaySettingsListener = null;
  webSettingsPollInFlight = null;
}

function subscribeToGatewaySettingsChanges(): (() => void) | null {
  if (isElectron()) {
    return null;
  }

  const handler = async (data: { settings: Record<string, unknown> }) => {
    const settings = data.settings ?? {};
    const syncEnabled = getSettingsSyncEnabled(settings);
    const sharedSettings = filterSharedSettings(settings);
    const changed = applySharedSettingsSnapshot({
      syncEnabled,
      sharedSettings,
    });
    if (changed) {
      notifyWebSettingsChangeListeners(syncEnabled, sharedSettings);
    }
  };

  gatewayClient.on("settings.changed", handler);

  return () => {
    gatewayClient.off("settings.changed", handler);
  };
}

export function replaceRendererSettingsCache(settings: Record<string, unknown>): void {
  const nextCache = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
  // If we have outstanding async IPC writes, their optimistic cache values are
  // more recent than this broadcast snapshot — keep the local values to avoid
  // a race condition overwriting changes that haven't round-tripped yet.
  if (_pendingElectronWriteKeys.size > 0 && _rendererCache) {
    for (const key of _pendingElectronWriteKeys) {
      if (Object.prototype.hasOwnProperty.call(_rendererCache, key)) {
        nextCache[key] = _rendererCache[key];
      }
    }
  }
  _rendererCache = nextCache;
  _settingsSyncEnabled = getSettingsSyncEnabled(nextCache);
  _sharedSettingsCache = filterSharedSettings(nextCache);
  setSettingsVersion((version) => version + 1);
}

export function isSettingsSyncEnabled(): boolean {
  return _settingsSyncEnabled === true;
}

export function getSettingsSyncEnabledSync(): boolean {
  if (_settingsSyncEnabled === null && isElectron()) {
    const cache = getRendererCache();
    if (cache) {
      _settingsSyncEnabled = getSettingsSyncEnabled(cache);
    }
  }
  return isSettingsSyncEnabled();
}

function electronSave(patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  for (const key of keys) {
    _pendingElectronWriteKeys.add(key);
  }
  const cleanup = () => keys.forEach((k) => _pendingElectronWriteKeys.delete(k));
  try {
    const promise = (window as any).electronAPI?.settings?.save(patch) as
      | Promise<{ success: boolean }>
      | undefined;
    if (promise && typeof promise.then === "function") {
      void promise.then(cleanup, cleanup);
    } else {
      cleanup();
    }
  } catch {
    cleanup();
  }
}

function getAuthHeaders(): Record<string, string> {
  return Auth.getAuthHeaders();
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function bootstrapSharedSettings(): Promise<void> {
  if (isElectron()) return;
  if (_settingsBootstrapPromise) return _settingsBootstrapPromise;

  _settingsBootstrapPromise = (async () => {
    if (!Auth.isAuthenticated()) {
      setSettingsSyncEnabled(false);
      return;
    }

    const hadKnownSyncState = _settingsSyncEnabled !== null;
    await waitForPendingSharedSettingsWrites();

    try {
      const data = await fetchJson<{ syncEnabled: boolean; sharedSettings: Record<string, unknown> }>(
        "/api/settings/bootstrap",
        {
          cache: "no-store",
          headers: getAuthHeaders(),
        },
      );
      applySharedSettingsSnapshot(data);
    } catch (err) {
      if (!hadKnownSyncState) {
        setSettingsSyncEnabled(false);
        setSettingsVersion((version) => version + 1);
      } else {
        // Transient failure: keep the previously cached shared settings. The
        // poll timer will retry shortly — log so devs can see the gap.
        console.warn("[Settings] Bootstrap failed, retaining stale cached settings:", err);
      }
    }
  })();

  try {
    await _settingsBootstrapPromise;
  } finally {
    _settingsBootstrapPromise = null;
  }
}

export function resetSettingsBootstrapCache(): void {
  stopWebSettingsChangeSubscription();
  webSettingsChangeListeners.clear();
  pendingSharedSettingOverrides.clear();
  _pendingElectronWriteKeys.clear();
  webSettingsSnapshotHash = null;
  _settingsBootstrapPromise = null;
  sharedSettingsWriteChain = Promise.resolve();
  _sharedSettingsCache = null;
  _settingsSyncEnabled = null;
  _rendererCache = null;
  setSettingsVersion(0);
}

export async function setSharedSettingsSyncEnabled(enabled: boolean): Promise<boolean> {
  if (isElectron()) {
    saveSetting(SETTINGS_SYNC_ENABLED_KEY, enabled);
    setSettingsSyncEnabled(enabled);
    setSettingsVersion((version) => version + 1);
    return enabled;
  }

  if (!Auth.isAuthenticated()) {
    setSettingsSyncEnabled(false);
    return false;
  }

  const data = await fetchJson<{ enabled: boolean }>("/api/settings/sync-enabled", {
    method: "POST",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enabled }),
  });
  setSettingsSyncEnabled(data.enabled === true);
  setSettingsVersion((version) => version + 1);
  if (enabled) {
    await bootstrapSharedSettings();
  }
  return data.enabled === true;
}

async function saveSharedSetting(key: string, value: unknown): Promise<void> {
  if (isElectron()) {
    return;
  }

  if (!Auth.isAuthenticated()) {
    clearPendingSharedSettingOverride(key);
    return;
  }

  try {
    const data = await queueSharedSettingsWrite(() => fetchJson<{
      success: boolean;
      settings: Record<string, unknown>;
    }>("/api/settings/shared", {
      method: "POST",
      headers: {
        ...getAuthHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        patch: value === undefined ? {} : { [key]: value },
        removeKeys: value === undefined ? [key] : [],
      }),
    }));

    // Pending overrides are only for optimistic local reads. Clear them before
    // applying the authoritative server snapshot so we don't mask server-side
    // normalization/merging with stale client data.
    clearPendingSharedSettingOverride(key);
    const sharedSettings = filterSharedSettings(data.settings ?? {});
    const changed = applySharedSettingsSnapshot({
      syncEnabled: true,
      sharedSettings,
    });

    if (changed) {
      notifyWebSettingsChangeListeners(true, sharedSettings);
    }
  } catch (err) {
    clearPendingSharedSettingOverride(key);
    const sharedSettings = filterSharedSettings(getSharedSettingsCache());
    const changed = applySharedSettingsSnapshot({
      syncEnabled: isSettingsSyncEnabled(),
      sharedSettings,
    });
    if (changed) {
      notifyWebSettingsChangeListeners(isSettingsSyncEnabled(), sharedSettings);
    }
    console.warn("[Settings] Failed to persist shared setting, reverted optimistic state:", err);
    throw err;
  } finally {
    setSettingsVersion((version) => version + 1);
  }
}

async function resolvePendingSharedSettingSave(
  key: string,
  value: unknown,
  fallbackValue: unknown,
): Promise<void> {
  await bootstrapSharedSettings();

  if (isSettingsSyncEnabled()) {
    await saveSharedSetting(key, value);
    return;
  }

  writeLocalSetting(key, fallbackValue);
  clearPendingSharedSettingOverride(key);
  setSettingsVersion((version) => version + 1);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Synchronously read a setting value. Works at module-init time in Electron. */
export function getSetting<T = unknown>(key: string): T | undefined {
  settingsVersion();
  if (isElectron()) {
    const cache = getRendererCache();
    if (cache) {
      return cache[key] as T | undefined;
    }
  }
  if (isSharedSettingsKey(key) && hasPendingSharedSettingOverride(key)) {
    return getPendingSharedSettingOverride<T>(key);
  }
  if (isLocalOnlySettingsKey(key)) {
    return readLocalSetting<T>(key);
  }
  if (isSettingsSyncEnabled() && isSharedSettingsKey(key)) {
    return getSharedSettingsCache()[key] as T | undefined;
  }
  return readLocalSetting<T>(key);
}

/** Save a setting value. Async write to settings.json in Electron, localStorage in web. */
export function saveSetting(key: string, value: unknown): void {
  const currentValue = getSetting(key);
  const nextValue = mergeSettingValue(currentValue, value);

  if (isElectron()) {
    // Update renderer-side cache immediately so subsequent reads see the new value
    const cache = getRendererCache();
    if (cache) {
      if (nextValue === undefined) {
        delete cache[key];
      } else {
        cache[key] = nextValue;
      }
    }
    electronSave({ [key]: value });
    if (key === SETTINGS_SYNC_ENABLED_KEY) {
      setSettingsSyncEnabled(value === true);
    }
    if (isSharedSettingsKey(key)) {
      const sharedCache = getSharedSettingsCache();
      if (value === undefined) {
        delete sharedCache[key];
      } else {
        sharedCache[key] = nextValue;
      }
    }
  }
  if (isLocalOnlySettingsKey(key)) {
    writeLocalSetting(key, nextValue);
    setSettingsVersion((version) => version + 1);
    return;
  }
  if (isSettingsSyncEnabled() && isSharedSettingsKey(key)) {
    setPendingSharedSettingOverride(key, nextValue);
    setSettingsVersion((version) => version + 1);
    void saveSharedSetting(key, value).catch((error) => {
      console.warn("[Settings] Failed to persist shared setting:", error);
    });
    return;
  }
  if (
    !isElectron()
    && isSharedSettingsKey(key)
    && Auth.isAuthenticated()
    && _settingsSyncEnabled === null
  ) {
    setPendingSharedSettingOverride(key, nextValue);
    setSettingsVersion((version) => version + 1);
    void resolvePendingSharedSettingSave(key, value, nextValue).catch((error) => {
      clearPendingSharedSettingOverride(key);
      setSettingsVersion((version) => version + 1);
      console.warn("[Settings] Failed to resolve shared setting save:", error);
    });
    return;
  }
  writeLocalSetting(key, nextValue);
  setSettingsVersion((version) => version + 1);
}

export async function refreshSharedSettings(): Promise<void> {
  if (isElectron()) return;
  await waitForPendingSharedSettingsWrites();
  await bootstrapSharedSettings();
}

export function subscribeToSettingsChanges(
  callback: (settings: Record<string, unknown>) => void | Promise<void>,
): (() => void) | undefined {
  if (!isElectron()) {
    webSettingsChangeListeners.add(callback);
    if (webSettingsChangeListeners.size === 1) {
      startWebSettingsChangeSubscription();
    }
    return () => {
      webSettingsChangeListeners.delete(callback);
      if (webSettingsChangeListeners.size === 0) {
        stopWebSettingsChangeSubscription();
      }
    };
  }
  try {
    return (window as any).electronAPI?.settings?.onChanged?.((settings: Record<string, unknown>) => {
      replaceRendererSettingsCache(settings);
      void callback(settings);
    });
  } catch {
    return undefined;
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

  if (!isElectron() && isSettingsSyncEnabled() && isSharedSettingsKey(parts[0])) {
    const [rootKey, childKey, ...nestedParts] = parts;
    const existingChild = getNestedSetting<Record<string, unknown>>(`${rootKey}.${childKey}`);
    const nextChild = isPlainObject(existingChild) ? { ...existingChild } : {};

    if (nestedParts.length === 0) {
      if (isPlainObject(value) && isPlainObject(existingChild)) {
        Object.assign(nextChild, value);
      } else {
        saveSetting(rootKey, { [childKey]: value });
        return;
      }
    } else {
      setNestedObjectValue(nextChild, nestedParts, value);
    }

    saveSetting(rootKey, { [childKey]: nextChild });
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
