import { createStore } from "solid-js/store";
import type { EngineInfo, EngineType, UnifiedModelInfo } from "../types/unified";

export interface EngineModelSelection {
  providerID: string;
  modelID: string;
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
  /** User-selected model per engine type, persisted to localStorage */
  engineModelSelections: Record<string, EngineModelSelection>;
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
});

const STORAGE_KEY_PREFIX = "engine_model_";

export function loadEngineModelSelection(engineType: string): EngineModelSelection | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${engineType}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.providerID && parsed.modelID) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function saveEngineModelSelection(engineType: string, selection: EngineModelSelection): void {
  setConfigStore("engineModelSelections", engineType, selection);
  localStorage.setItem(`${STORAGE_KEY_PREFIX}${engineType}`, JSON.stringify(selection));
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
    if (models?.some(m => m.modelId === selection.modelID)) {
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
 * Restore persisted model selections from localStorage for all known engines.
 */
export function restoreEngineModelSelections(): void {
  for (const engine of configStore.engines) {
    const saved = loadEngineModelSelection(engine.type);
    if (saved) {
      setConfigStore("engineModelSelections", engine.type, saved);
    }
  }
}
