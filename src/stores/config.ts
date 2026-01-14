import { createStore } from "solid-js/store";
import { Config } from "../types/opencode";

interface ConfigState {
  providers: Config.Provider[];
  connectedProviderIDs: string[];
  loading: boolean;
  currentProviderID: string | null;
  currentModelID: string | null;
}

export const [configStore, setConfigStore] = createStore<ConfigState>({
  providers: [],
  connectedProviderIDs: [],
  loading: false,
  currentProviderID: null,
  currentModelID: null,
});
