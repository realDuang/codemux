export const SETTINGS_SYNC_ENABLED_KEY = "settingsSyncEnabled" as const;

export const SHARED_SETTINGS_KEYS = [
  "theme",
  "locale",
  "engineModels",
  "defaultEngine",
  "showDefaultWorkspace",
  "scheduledTasksEnabled",
  "worktreeEnabled",
] as const;

export const LOCAL_ONLY_SETTINGS_KEYS = [
  "lastSessionId",
  "fileExplorerPanelOpen",
  "fileExplorerPanelWidth",
  "fileExplorerTreeWidth",
  "fileExplorerActiveTab",
] as const;

const SHARED_SETTINGS_KEY_SET = new Set<string>(SHARED_SETTINGS_KEYS);
const LOCAL_ONLY_SETTINGS_KEY_SET = new Set<string>(LOCAL_ONLY_SETTINGS_KEYS);

export type SharedSettingsKey = (typeof SHARED_SETTINGS_KEYS)[number];
export type LocalOnlySettingsKey = (typeof LOCAL_ONLY_SETTINGS_KEYS)[number];

export function isSharedSettingsKey(key: string): key is SharedSettingsKey {
  return SHARED_SETTINGS_KEY_SET.has(key);
}

export function isLocalOnlySettingsKey(key: string): key is LocalOnlySettingsKey {
  return LOCAL_ONLY_SETTINGS_KEY_SET.has(key);
}

export function filterSharedSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const key of SHARED_SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      filtered[key] = settings[key];
    }
  }
  return filtered;
}

export function filterSharedSettingsPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (isSharedSettingsKey(key) && isValidSharedSettingValue(key, value)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

const VALID_THEMES = new Set(["light", "dark", "system"]);
const VALID_LOCALES = new Set(["en", "zh", "ru"]);
const MAX_ENGINE_MODELS = 16;
const MAX_ENGINE_KEY_LENGTH = 64;
const MAX_ENGINE_MODEL_FIELD_LENGTH = 256;
const ALLOWED_ENGINE_MODEL_KEYS = new Set(["providerID", "modelID", "enabled"]);

function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate that a shared setting value has the expected type/shape. */
function isValidSharedSettingValue(key: SharedSettingsKey, value: unknown): boolean {
  switch (key) {
    case "theme":
      return typeof value === "string" && VALID_THEMES.has(value);
    case "locale":
      return typeof value === "string" && VALID_LOCALES.has(value);
    case "defaultEngine":
      return typeof value === "string" && value.length <= 64;
    case "showDefaultWorkspace":
    case "scheduledTasksEnabled":
    case "worktreeEnabled":
      return typeof value === "boolean";
    case "engineModels": {
      if (!isPlainObjectValue(value)) return false;
      const entries = Object.entries(value);
      if (entries.length > MAX_ENGINE_MODELS) return false;
      for (const [engineKey, v] of entries) {
        if (engineKey.length === 0 || engineKey.length > MAX_ENGINE_KEY_LENGTH) return false;
        if (engineKey === "__proto__" || engineKey === "constructor" || engineKey === "prototype") return false;
        if (!isPlainObjectValue(v)) return false;
        const entry = v as Record<string, unknown>;
        for (const key of Object.keys(entry)) {
          if (!ALLOWED_ENGINE_MODEL_KEYS.has(key)) return false;
        }
        if (
          "providerID" in entry
          && (typeof entry.providerID !== "string" || entry.providerID.length > MAX_ENGINE_MODEL_FIELD_LENGTH)
        ) return false;
        if (
          "modelID" in entry
          && (typeof entry.modelID !== "string" || entry.modelID.length > MAX_ENGINE_MODEL_FIELD_LENGTH)
        ) return false;
        if ("enabled" in entry && typeof entry.enabled !== "boolean") return false;
        for (const nestedValue of Object.values(entry)) {
          if (nestedValue !== null && typeof nestedValue === "object") return false;
        }
      }
      return true;
    }
    default:
      return false;
  }
}

export function filterSharedSettingsRemoveKeys(removeKeys: string[]): string[] {
  return removeKeys.filter((key) => isSharedSettingsKey(key));
}

export function getSettingsSyncEnabled(settings: Record<string, unknown>): boolean {
  return settings[SETTINGS_SYNC_ENABLED_KEY] === true;
}

export function applySettingsMutation(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
  removeKeys: string[] = [],
): Record<string, unknown> {
  const next = { ...existing };

  for (const key of removeKeys) {
    delete next[key];
  }

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete next[key];
      continue;
    }

    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      next[key] &&
      typeof next[key] === "object" &&
      !Array.isArray(next[key])
    ) {
      next[key] = {
        ...(next[key] as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
      continue;
    }

    next[key] = value;
  }

  return next;
}
