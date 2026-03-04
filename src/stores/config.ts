import { createStore } from "solid-js/store";
import type { EngineInfo, EngineType, UnifiedModelInfo } from "../types/unified";
import { getSetting, saveSetting, getNestedSetting, saveNestedSetting } from "../lib/settings";

export interface EngineModelSelection {
  providerID: string;
  modelID: string;
  /** Whether this engine is enabled (default: true when undefined) */
  enabled?: boolean;
}

interface ConfigState {
  models: UnifiedModelInfo[];
  loading: boolean;
  currentProviderID: string | null;
  currentModelID: string | null;
  engines: EngineInfo[];
  currentEngineType: EngineType | null;
  /** Model lists keyed by engine type */
  engineModels: Record<string, UnifiedModelInfo[]>;
  /** User-selected model per engine type, persisted to settings.json */
  engineModelSelections: Record<string, EngineModelSelection>;
  /** Engine enabled state, keyed by engine type. Missing = true (default enabled). */
  enabledEngines: Record<string, boolean>;
}

export const [configStore, setConfigStore] = createStore<ConfigState>({
  models: [],
  loading: false,
  currentProviderID: null,
  currentModelID: null,
  engines: [],
  currentEngineType: null,
  engineModels: {},
  engineModelSelections: {},
  enabledEngines: {},
});

export function loadEngineModelSelection(engineType: string): EngineModelSelection | null {
  try {
    const saved = getNestedSetting<EngineModelSelection>(`engineModels.${engineType}`);
    if (saved && saved.providerID !== undefined && saved.modelID) return saved;
    return null;
  } catch {
    return null;
  }
}

export function saveEngineModelSelection(engineType: string, selection: EngineModelSelection): void {
  setConfigStore("engineModelSelections", engineType, selection);
  saveNestedSetting(`engineModels.${engineType}`, selection);
}

/**
 * Get the model ID to use for a given engine type.
 * Priority: user selection > engine-reported currentModelID > first model in list.
 */
export function getSelectedModelForEngine(engineType: string): string | undefined {
  // User selection (from Settings)
  const selection = configStore.engineModelSelections[engineType];
  if (selection?.modelID) {
    const models = configStore.engineModels[engineType];
    // Claude engine always allows custom model input — skip validation
    // For others: validate against model list when available; trust manual input when list is empty
    if (engineType === "claude" || !models || models.length === 0 || models.some(m => m.modelId === selection.modelID)) {
      return selection.modelID;
    }
  }
  // Engine-reported current model as fallback (e.g. Copilot default)
  if (configStore.currentModelID && configStore.currentEngineType === engineType) {
    return configStore.currentModelID;
  }
  // Fallback to first model
  const models = configStore.engineModels[engineType] || configStore.models;
  return models[0]?.modelId;
}

/**
 * Restore persisted model selections from settings.json for all known engines.
 * Validates saved selections against the current model list — if the saved model
 * is no longer available (e.g. deprecated), it is discarded.
 */
export function restoreEngineModelSelections(): void {
  for (const engine of configStore.engines) {
    const saved = loadEngineModelSelection(engine.type);
    if (saved) {
      const models = configStore.engineModels[engine.type];
      // Claude engine always allows custom model input — always restore
      // For others: only restore if model list is empty (can't validate) or the saved model exists
      if (engine.type === "claude" || !models || models.length === 0 || models.some(m => m.modelId === saved.modelID)) {
        setConfigStore("engineModelSelections", engine.type, saved);
      }
      // Stale models are simply not loaded — no need to delete from settings file
    }
  }
}

// ---------------------------------------------------------------------------
// Engine enabled/disabled state
// ---------------------------------------------------------------------------

/** Check if an engine is enabled. Missing entries default to true. */
export function isEngineEnabled(engineType: string): boolean {
  const explicit = configStore.enabledEngines[engineType];
  if (explicit !== undefined) return explicit;
  // Fall back to persisted value in engineModels settings
  const saved = getNestedSetting<{ enabled?: boolean }>(`engineModels.${engineType}`);
  return saved?.enabled !== false; // undefined or true → enabled
}

/** Toggle engine enabled state and persist to settings.json. */
export function setEngineEnabled(engineType: string, enabled: boolean): void {
  // Update reactive store
  setConfigStore("enabledEngines", engineType, enabled);
  // Persist into engineModels.{type}.enabled in settings.json
  const existing = getNestedSetting<Record<string, unknown>>(`engineModels.${engineType}`) ?? {};
  existing.enabled = enabled;
  saveNestedSetting(`engineModels.${engineType}`, existing);
}

/** Restore enabled state for all known engines from settings.json into the store. */
export function restoreEnabledEngines(): void {
  for (const engine of configStore.engines) {
    const saved = getNestedSetting<{ enabled?: boolean }>(`engineModels.${engine.type}`);
    // Only set explicit false; missing/true both mean enabled
    const enabled = saved?.enabled !== false;
    setConfigStore("enabledEngines", engine.type, enabled);
  }
}
