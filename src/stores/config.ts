import { createStore } from "solid-js/store";
import { isReasoningEffort, type EngineInfo, type EngineType, type ReasoningEffort, type UnifiedModelInfo } from "../types/unified";
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
  /** User-chosen default engine for new sessions, persisted to settings.json */
  defaultNewSessionEngine: EngineType | null;
  /** User-selected reasoning effort per engine type, persisted to settings.json */
  engineReasoningEfforts: Record<string, ReasoningEffort>;
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
  defaultNewSessionEngine: null,
  engineReasoningEfforts: {},
});

export function loadEngineModelSelection(engineType: string): EngineModelSelection | null {
  try {
    const saved = getNestedSetting<Partial<EngineModelSelection>>(`engineModels.${engineType}`);
    if (saved && typeof saved.modelID === "string" && saved.modelID.length > 0) {
      return {
        providerID: typeof saved.providerID === "string" ? saved.providerID : "",
        modelID: saved.modelID,
        enabled: typeof saved.enabled === "boolean" ? saved.enabled : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveEngineModelSelection(engineType: string, selection: EngineModelSelection): void {
  setConfigStore("engineModelSelections", engineType, selection);
  // Merge with existing persisted object to preserve `enabled` flag set by setEngineEnabled()
  const existing = getNestedSetting<Record<string, unknown>>(`engineModels.${engineType}`) ?? {};
  saveNestedSetting(`engineModels.${engineType}`, { ...existing, ...selection });
}

/**
 * Get capabilities for a given engine type from the engine list.
 */
function getEngineCapabilities(engineType: string) {
  return configStore.engines.find((e) => e.type === engineType)?.capabilities;
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
    const caps = getEngineCapabilities(engineType);
    // Engines with customModelInput allow arbitrary model IDs — skip validation
    // For others: validate against model list when available; trust manual input when list is empty
    if (caps?.customModelInput || !models || models.length === 0 || models.some(m => m.modelId === selection.modelID)) {
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
      // Engines with customModelInput always accept any saved model ID
      // For others: only restore if model list is empty (can't validate) or the saved model exists
      if (engine.capabilities?.customModelInput || !models || models.length === 0 || models.some(m => m.modelId === saved.modelID)) {
        setConfigStore("engineModelSelections", engine.type, saved);
      }
      // Stale models are simply not loaded — no need to delete from settings file
    }
  }
}

// ---------------------------------------------------------------------------
// Default engine resolution
// ---------------------------------------------------------------------------

/**
 * Get the default engine type for new sessions.
 * Single source of truth: settings.json "defaultEngine".
 * Falls back to first running+enabled engine when the saved value is unavailable.
 */
export function getDefaultEngineType(): string {
  // User-configured default engine for new sessions (from settings.json)
  const userDefault = configStore.defaultNewSessionEngine;
  if (userDefault) {
    const engine = configStore.engines.find(e => e.type === userDefault);
    if (engine && engine.status === "running" && isEngineEnabled(userDefault)) {
      return userDefault;
    }
  }
  // Fallback: first running + enabled engine
  const fallback = configStore.engines.find((e) => e.status === "running" && isEngineEnabled(e.type));
  return fallback?.type || configStore.engines[0]?.type || "opencode";
}

/** Set the default engine for new sessions and persist to settings. */
export function setDefaultNewSessionEngine(engineType: EngineType): void {
  setConfigStore("defaultNewSessionEngine", engineType);
  saveSetting("defaultEngine", engineType);
}

/** Restore the default engine setting from settings. */
export function restoreDefaultEngine(): void {
  const saved = getSetting<string>("defaultEngine");
  if (saved) {
    setConfigStore("defaultNewSessionEngine", saved as EngineType);
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

// ---------------------------------------------------------------------------
// Reasoning effort per engine
// ---------------------------------------------------------------------------

/** Save reasoning effort for an engine and persist to settings.json. */
export function saveReasoningEffort(engineType: string, effort: ReasoningEffort): void {
  setConfigStore("engineReasoningEfforts", engineType, effort);
  saveNestedSetting(`engineReasoningEfforts.${engineType}`, effort);
}

/** Load persisted reasoning effort for an engine. */
export function loadReasoningEffort(engineType: string): ReasoningEffort | null {
  const saved = getNestedSetting<string>(`engineReasoningEfforts.${engineType}`);
  if (isReasoningEffort(saved)) return saved;
  return null;
}

/**
 * Get the reasoning effort that is actually effective for the currently selected
 * model of an engine.
 *
 * This validates the saved effort against the selected model's supported effort
 * list and falls back to the model default when the saved value is no longer
 * applicable.
 */
export function getEffectiveReasoningEffortForEngine(engineType: string): ReasoningEffort | null {
  const saved = configStore.engineReasoningEfforts[engineType] ?? null;
  const modelId = getSelectedModelForEngine(engineType);
  const models = configStore.engineModels[engineType] || configStore.models;
  const model = modelId ? models.find((m) => m.modelId === modelId) : undefined;

  if (!model) {
    return saved ?? null;
  }

  const supported = model.capabilities?.supportedReasoningEfforts;
  if (saved && supported?.includes(saved)) {
    return saved;
  }

  return model.capabilities?.defaultReasoningEffort ?? null;
}

/** Restore persisted reasoning efforts for all known engines into the store. */
export function restoreReasoningEfforts(): void {
  for (const engine of configStore.engines) {
    const saved = loadReasoningEffort(engine.type);
    if (saved) {
      setConfigStore("engineReasoningEfforts", engine.type, saved);
    }
  }
}
