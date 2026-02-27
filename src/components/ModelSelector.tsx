import { createSignal, createEffect, For, Show, onCleanup } from "solid-js";
import { configStore } from "../stores/config";
import { useI18n } from "../lib/i18n";
import type { EngineType } from "../types/unified";

interface ModelSelectorProps {
  engineType?: EngineType;
  onModelChange?: (providerID: string, modelID: string) => void;
}

export function ModelSelector(props: ModelSelectorProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = createSignal(false);
  const [selectedProvider, setSelectedProvider] = createSignal<string>("");
  const [selectedModel, setSelectedModel] = createSignal<string>("");
  let containerRef: HTMLDivElement | undefined;

  // Close dropdown on outside click without using a full-screen overlay
  // (a fixed inset-0 overlay can block the textarea from receiving focus)
  createEffect(() => {
    if (isOpen()) {
      const handleOutsideClick = (e: MouseEvent) => {
        if (containerRef && !containerRef.contains(e.target as Node)) {
          setIsOpen(false);
        }
      };
      // Use capture phase + setTimeout so the current click that opened
      // the dropdown doesn't immediately close it
      const timer = setTimeout(() => {
        document.addEventListener("pointerdown", handleOutsideClick, true);
      }, 0);
      onCleanup(() => {
        clearTimeout(timer);
        document.removeEventListener("pointerdown", handleOutsideClick, true);
      });
    }
  });

  // Purely reactive: read models and currentModelID from configStore.
  // All model-fetching is done by Chat.tsx which controls timing to avoid
  // race conditions with ACP adapters that only populate models after
  // session/new or session/load.
  createEffect(() => {
    const models = configStore.models;
    const currentId = configStore.currentModelID;

    if (models.length === 0) return;

    // If engine reports a current model, use it (e.g. Copilot CLI
    // determines the model at startup and cannot switch at runtime)
    if (currentId) {
      const current = models.find(m => m.modelId === currentId);
      if (current) {
        setSelectedProvider(current.providerId || "");
        setSelectedModel(current.modelId);
        props.onModelChange?.(current.providerId || "", current.modelId);
        return;
      }
    }

    // Try to restore last selected model from localStorage
    const savedModelStr = localStorage.getItem("opencode_default_model");
    const savedModel = savedModelStr ? JSON.parse(savedModelStr) : null;
    if (savedModel) {
      const exists = models.find(m => m.modelId === savedModel.modelID && m.providerId === savedModel.providerID);
      if (exists) {
        setSelectedProvider(savedModel.providerID);
        setSelectedModel(savedModel.modelID);
        props.onModelChange?.(savedModel.providerID, savedModel.modelID);
        return;
      }
    }

    // Default to first model
    const first = models[0];
    setSelectedProvider(first.providerId || "");
    setSelectedModel(first.modelId);
    props.onModelChange?.(first.providerId || "", first.modelId);
  });

  // Group models by provider for display
  const providerGroups = () => {
    const groups = new Map<string, { name: string; models: typeof configStore.models }>();
    for (const model of configStore.models) {
      const pid = model.providerId || "unknown";
      if (!groups.has(pid)) {
        groups.set(pid, { name: model.providerName || pid, models: [] });
      }
      groups.get(pid)!.models.push(model);
    }
    return Array.from(groups.entries()).map(([id, data]) => ({
      id,
      name: data.name,
      models: data.models,
    }));
  };

  const handleSelect = (providerID: string, modelID: string) => {
    setSelectedProvider(providerID);
    setSelectedModel(modelID);
    setIsOpen(false);
    localStorage.setItem("opencode_default_model", JSON.stringify({ providerID, modelID }));
    props.onModelChange?.(providerID, modelID);
  };

  const selectedProviderName = () => {
    const model = configStore.models.find(m => m.modelId === selectedModel());
    return model?.providerName || t().model.selectModel;
  };

  const selectedModelName = () => {
    const model = configStore.models.find(m => m.modelId === selectedModel());
    return model?.name || "";
  };

  // Copilot engine doesn't support runtime model switching — display only
  const isModelLocked = () => configStore.currentEngineType === "copilot";

  return (
    <div ref={containerRef} class="relative">
      <button
        onClick={() => !isModelLocked() && setIsOpen(!isOpen())}
        class={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-gray-400 ${
          isModelLocked()
            ? "cursor-default opacity-75"
            : "hover:bg-gray-200 dark:hover:bg-slate-700"
        }`}
        title={isModelLocked() ? "Model is determined by Copilot CLI config" : undefined}
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
        <Show when={!isModelLocked()}>
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
        </Show>
      </button>

      <Show when={isOpen() && !isModelLocked()}>
        {/* Dropdown menu - opens upward */}
        <div class="absolute left-0 md:left-auto md:right-0 bottom-full mb-2 w-72 md:w-80 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg shadow-lg z-[60] max-h-[60vh] overflow-y-auto">
          <Show
            when={providerGroups().length > 0}
            fallback={
              <div class="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">
                {t().model.noModels}
              </div>
            }
          >
            <For each={providerGroups()}>
              {(group) => (
                <div class="border-b dark:border-slate-700 last:border-b-0">
                  <div class="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-900">
                    {group.name}
                  </div>
                  <For each={group.models}>
                    {(model) => (
                      <button
                        onClick={() => handleSelect(group.id, model.modelId)}
                        class={`w-full text-left px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors flex items-center justify-between ${
                          selectedProvider() === group.id &&
                          selectedModel() === model.modelId
                            ? "bg-blue-50 dark:bg-blue-900/20"
                            : ""
                        }`}
                      >
                        <span class="text-sm text-gray-800 dark:text-white truncate">
                          {model.name}
                        </span>
                        <Show when={selectedProvider() === group.id && selectedModel() === model.modelId}>
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
    </div>
  );
}
