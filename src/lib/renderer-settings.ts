import { refreshLocaleFromSettings } from "./i18n";
import { getSetting } from "./settings";
import { refreshThemeFromSettings } from "./theme";
import {
  restoreDefaultEngine,
  restoreEnabledEngines,
  restoreEngineModelSelections,
} from "../stores/config";
import { setScheduledTaskStore } from "../stores/scheduled-task";
import { setSessionStore } from "../stores/session";

export function applyRendererSettingsState(): void {
  setSessionStore(
    "showDefaultWorkspace",
    getSetting<boolean>("showDefaultWorkspace") ?? true,
  );
  setScheduledTaskStore(
    "enabled",
    getSetting<boolean>("scheduledTasksEnabled") ?? true,
  );
  restoreEnabledEngines();
  restoreDefaultEngine();
  restoreEngineModelSelections();
  refreshThemeFromSettings();
  refreshLocaleFromSettings();
}
