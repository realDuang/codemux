import fs from "node:fs";
import path from "node:path";

export interface SettingsStoreOptions {
  getFilePath: () => string;
  createDirectory?: boolean;
}

export function createSettingsStore({ getFilePath, createDirectory = false }: SettingsStoreOptions) {
  function loadSettings(): Record<string, unknown> {
    try {
      return JSON.parse(fs.readFileSync(getFilePath(), "utf-8"));
    } catch {
      return {};
    }
  }

  function saveSettings(patch: Record<string, unknown>): void {
    const existing = loadSettings();
    const merged = { ...existing };
    for (const [key, value] of Object.entries(patch)) {
      if (
        value && typeof value === "object" && !Array.isArray(value) &&
        existing[key] && typeof existing[key] === "object" && !Array.isArray(existing[key])
      ) {
        merged[key] = { ...(existing[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
      } else {
        merged[key] = value;
      }
    }

    const filePath = getFilePath();
    if (createDirectory) {
      const directory = path.dirname(filePath);
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
      }
    }
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  return { loadSettings, saveSettings };
}
