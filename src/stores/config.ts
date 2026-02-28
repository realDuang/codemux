import { createStore } from "solid-js/store";
import type { EngineInfo, EngineType, UnifiedModelInfo } from "../types/unified";

interface ConfigState {
  models: UnifiedModelInfo[];
  loading: boolean;
  currentProviderID: string | null;
  currentModelID: string | null;
  engines: EngineInfo[];
  currentEngineType: EngineType | null;
}

export const [configStore, setConfigStore] = createStore<ConfigState>({
  models: [],
  loading: false,
  currentProviderID: null,
  currentModelID: null,
  engines: [],
  currentEngineType: null,
});
