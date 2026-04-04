/**
 * Settings keys that are safe to share between the host and authenticated
 * web clients.  Used by both the server (auth-route-handlers) and the
 * renderer (settings.ts) — keep this as the single source of truth.
 */
export const SHARED_SETTINGS_KEYS = [
  "theme",
  "locale",
  "engineModels",
  "defaultEngine",
  "showDefaultWorkspace",
  "scheduledTasksEnabled",
  "worktreeEnabled",
] as const;

export type SharedSettingsKey = (typeof SHARED_SETTINGS_KEYS)[number];

const SHARED_KEY_SET: ReadonlySet<string> = new Set(SHARED_SETTINGS_KEYS);

export function isSharedSettingsKey(key: string): key is SharedSettingsKey {
  return SHARED_KEY_SET.has(key);
}

// ---------------------------------------------------------------------------
// Value validation for PATCH /api/settings/shared
// ---------------------------------------------------------------------------

const VALID_THEMES = new Set(["light", "dark", "system"]);
const VALID_LOCALES = new Set(["en", "zh", "ru"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate that a shared setting value has the expected type/shape.
 * Rejects malformed or potentially dangerous values (e.g. prototype pollution).
 */
export function isValidSharedSettingValue(key: SharedSettingsKey, value: unknown): boolean {
  switch (key) {
    case "theme":
      return typeof value === "string" && VALID_THEMES.has(value);
    case "locale":
      return typeof value === "string" && VALID_LOCALES.has(value);
    case "defaultEngine":
      return typeof value === "string" && value.length > 0 && value.length <= 64;
    case "showDefaultWorkspace":
    case "scheduledTasksEnabled":
    case "worktreeEnabled":
      return typeof value === "boolean";
    case "engineModels": {
      if (!isPlainObject(value)) return false;
      const entries = Object.entries(value);
      if (entries.length > 16) return false;
      for (const [engineKey, v] of entries) {
        if (engineKey === "__proto__" || engineKey === "constructor" || engineKey === "prototype") return false;
        if (engineKey.length === 0 || engineKey.length > 64) return false;
        if (!isPlainObject(v)) return false;
        for (const [field, fieldValue] of Object.entries(v)) {
          if (field === "__proto__" || field === "constructor" || field === "prototype") return false;
          if (field === "providerID" || field === "modelID") {
            if (typeof fieldValue !== "string" || fieldValue.length > 256) return false;
          } else if (field === "enabled") {
            if (typeof fieldValue !== "boolean") return false;
          } else {
            return false;
          }
        }
      }
      return true;
    }
    default:
      return false;
  }
}
