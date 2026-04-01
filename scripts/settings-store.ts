import fs from "fs";
import path from "path";
import { applySettingsMutation } from "../shared/settings-sync";

const SETTINGS_FILE = path.join(process.cwd(), ".settings.json");

function ensureDirectory(): void {
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadStandaloneSettings(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function replaceStandaloneSettings(settings: Record<string, unknown>): void {
  ensureDirectory();
  const tmpPath = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
  fs.renameSync(tmpPath, SETTINGS_FILE);
}

export function saveStandaloneSettings(patch: Record<string, unknown>): void {
  const current = loadStandaloneSettings();
  const next = applySettingsMutation(current, patch);
  replaceStandaloneSettings(next);
}
