import path from "path";
import { createSettingsStore } from "../shared/settings-store";

const SETTINGS_FILE = path.join(process.cwd(), ".settings.json");

const { loadSettings, saveSettings } = createSettingsStore({ getFilePath: () => SETTINGS_FILE });

export { loadSettings, saveSettings };
