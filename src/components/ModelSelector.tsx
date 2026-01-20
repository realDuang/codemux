import { createSignal, createEffect, For, Show } from "solid-js";
import { client } from "../lib/opencode-client";
import { configStore, setConfigStore } from "../stores/config";
import { useI18n } from "../lib/i18n";
import { logger } from "../lib/logger";

interface ModelSelectorProps {
  onModelChange?: (providerID: string, modelID: string) => void;
}

export function ModelSelector(props: ModelSelectorProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = createSignal(false);
  const [selectedProvider, setSelectedProvider] = createSignal<string>("");
  const [selectedModel, setSelectedModel] = createSignal<string>("");

  // Load providers config
  createEffect(async () => {
    try {
      const response = await client.getProviders();
      setConfigStore({
        providers: response.all || [],
        connectedProviderIDs: response.connected || [],
        loading: false,
      });

      // Try to restore last selected model from localStorage
      const savedModel = client.getDefaultModel();
      if (savedModel) {
        const savedProvider = response.all.find((p) => p.id === savedModel.providerID);
        // Verify saved provider and model are still valid and connected
        if (
          savedProvider &&
          response.connected?.includes(savedModel.providerID) &&
          savedProvider.models[savedModel.modelID]
        ) {
          setSelectedProvider(savedModel.providerID);
          setSelectedModel(savedModel.modelID);
          props.onModelChange?.(savedModel.providerID, savedModel.modelID);
          return;
        }
      }

      // If no saved selection or invalid, use default
      if (response.connected?.length > 0) {
        const firstProviderId = response.connected[0];
        const provider = response.all.find((p) => p.id === firstProviderId);
        if (provider && Object.keys(provider.models).length > 0) {
          const firstModelId = Object.keys(provider.models)[0];
          setSelectedProvider(firstProviderId);
          setSelectedModel(firstModelId);
          props.onModelChange?.(firstProviderId, firstModelId);
        }
      }
    } catch (error) {
      logger.error("Failed to load providers:", error);
    }
  });

  const connectedProviders = () => {
    const connectedIDs = new Set(configStore.connectedProviderIDs);
    return configStore.providers.filter((provider) =>
      connectedIDs.has(provider.id)
    );
  };

  const handleSelect = (providerID: string, modelID: string) => {
    setSelectedProvider(providerID);
    setSelectedModel(modelID);
    setIsOpen(false);
    // Save to localStorage
    client.setDefaultModel(providerID, modelID);
    props.onModelChange?.(providerID, modelID);
  };

  const selectedProviderName = () => {
    const provider = configStore.providers.find(
      (p) => p.id === selectedProvider()
    );
    return provider?.name || t().model.selectModel;
  };

  const selectedModelName = () => {
    const provider = configStore.providers.find(
      (p) => p.id === selectedProvider()
    );
    const model = provider?.models[selectedModel()];
    return model?.name || "";
  };

  return (
    <div class="relative">
      <button
        onClick={() => setIsOpen(!isOpen())}
        class="px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-zinc-700"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path d="M13 7H7v6h6V7z" />
          <path
            fill-rule="evenodd"
            d="M7 2a1 1 0 012 0v1h2V2a1 1 0 112 0v1h2a2 2 0 012 2v2h1a1 1 0 110 2h-1v2h1a1 1 0 110 2h-1v2a2 2 0 01-2 2h-2v1a1 1 0 11-2 0v-1H9v1a1 1 0 11-2 0v-1H5a2 2 0 01-2-2v-2H2a1 1 0 110-2h1V9H2a1 1 0 010-2h1V5a2 2 0 012-2h2V2z"
            clip-rule="evenodd"
          />
        </svg>
        <span class="max-w-[120px] truncate">
          {selectedModelName() || t().model.selectModel}
        </span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 20 20"
          fill="currentColor"
          class={`transition-transform ${isOpen() ? "rotate-180" : ""}`}
        >
          <path
            fill-rule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clip-rule="evenodd"
          />
        </svg>
      </button>

      <Show when={isOpen()}>
        {/* Dropdown menu - opens upward */}
        <div class="absolute right-0 bottom-full mb-2 w-72 md:w-80 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg shadow-lg z-[60] max-h-[60vh] overflow-y-auto">
          <Show
            when={connectedProviders().length > 0}
            fallback={
              <div class="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">
                {t().model.noModels}
              </div>
            }
          >
            <For each={connectedProviders()}>
              {(provider) => (
                <div class="border-b dark:border-zinc-700 last:border-b-0">
                  <div class="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-zinc-900">
                    {provider.name}
                  </div>
                  <For each={Object.entries(provider.models)}>
                    {([modelId, model]) => (
                      <button
                        onClick={() => handleSelect(provider.id, modelId)}
                        class={`w-full text-left px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-zinc-700 transition-colors flex items-center justify-between ${
                          selectedProvider() === provider.id &&
                          selectedModel() === modelId
                            ? "bg-blue-50 dark:bg-blue-900/20"
                            : ""
                        }`}
                      >
                        <span class="text-sm text-gray-800 dark:text-white truncate">
                          {model.name}
                        </span>
                        <Show when={selectedProvider() === provider.id && selectedModel() === modelId}>
                          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-blue-500 flex-shrink-0 ml-2" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                          </svg>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>

      {/* Close dropdown on outside click */}
      <Show when={isOpen()}>
        <div
          class="fixed inset-0 z-[55]"
          onClick={() => setIsOpen(false)}
        ></div>
      </Show>
    </div>
  );
}
