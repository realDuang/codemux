import { createSignal, createEffect, For, Show } from "solid-js";
import { client } from "../lib/opencode-client";
import { configStore, setConfigStore } from "../stores/config";

interface ModelSelectorProps {
  onModelChange?: (providerID: string, modelID: string) => void;
}

export function ModelSelector(props: ModelSelectorProps) {
  const [isOpen, setIsOpen] = createSignal(false);
  const [selectedProvider, setSelectedProvider] = createSignal<string>("");
  const [selectedModel, setSelectedModel] = createSignal<string>("");

  // 加载 providers 配置
  createEffect(async () => {
    try {
      const response = await client.getProviders();
      setConfigStore({
        providers: response.all || [],
        connectedProviderIDs: response.connected || [],
        loading: false,
      });

      // 设置默认选择
      if (response.connected?.length > 0) {
        const firstProviderId = response.connected[0];
        const provider = response.all.find((p) => p.id === firstProviderId);
        if (provider && Object.keys(provider.models).length > 0) {
          const firstModelId = Object.keys(provider.models)[0];
          setSelectedProvider(firstProviderId);
          setSelectedModel(firstModelId);
        }
      }
    } catch (error) {
      console.error("Failed to load providers:", error);
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
    props.onModelChange?.(providerID, modelID);
  };

  const selectedProviderName = () => {
    const provider = configStore.providers.find(
      (p) => p.id === selectedProvider()
    );
    return provider?.name || "选择模型";
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
        class="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-700 transition-colors flex items-center gap-2"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-4 w-4"
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
        <span class="max-w-[200px] truncate">
          {selectedModelName() || "选择模型"}
        </span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-4 w-4"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fill-rule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clip-rule="evenodd"
          />
        </svg>
      </button>

      <Show when={isOpen()}>
        <div class="absolute right-0 top-full mt-2 w-96 bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto">
          <Show
            when={connectedProviders().length > 0}
            fallback={
              <div class="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">
                没有可用的模型，请先配置服务器
              </div>
            }
          >
            <For each={connectedProviders()}>
              {(provider) => (
                <div class="border-b dark:border-zinc-700 last:border-b-0">
                  <div class="px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-zinc-900">
                    {provider.name}
                  </div>
                  <For each={Object.entries(provider.models)}>
                    {([modelId, model]) => (
                      <button
                        onClick={() => handleSelect(provider.id, modelId)}
                        class={`w-full text-left px-4 py-2 hover:bg-gray-50 dark:hover:bg-zinc-700 transition-colors ${
                          selectedProvider() === provider.id &&
                          selectedModel() === modelId
                            ? "bg-blue-50 dark:bg-blue-900/20"
                            : ""
                        }`}
                      >
                        <div class="font-medium text-sm text-gray-800 dark:text-white">
                          {model.name}
                        </div>
                        <div class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {(model.limit.context / 1000).toFixed(0)}K 上下文
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>

      {/* 点击外部关闭下拉菜单 */}
      <Show when={isOpen()}>
        <div
          class="fixed inset-0 z-40"
          onClick={() => setIsOpen(false)}
        ></div>
      </Show>
    </div>
  );
}
