import fs from "fs";
import path from "path";

const SETTINGS_FILE = path.join(process.cwd(), ".settings.json");

function loadSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
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
  const tmpPath = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2));
  fs.renameSync(tmpPath, SETTINGS_FILE);
}

export { loadSettings, saveSettings };
