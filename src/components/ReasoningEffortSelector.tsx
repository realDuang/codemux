import { createMemo, For, Show } from "solid-js";
import { saveReasoningEffort, getEffectiveReasoningEffortForEngine } from "../stores/config";
import { useI18n } from "../lib/i18n";
import type { EngineType, UnifiedModelInfo, ReasoningEffort } from "../types/unified";

interface ReasoningEffortSelectorProps {
  engineType: EngineType;
  models: () => UnifiedModelInfo[];
  selectedModelId: () => string;
  currentEffort?: () => ReasoningEffort | null;
  onSelect?: (effort: ReasoningEffort) => void;
  compact?: boolean;
}

export function ReasoningEffortSelector(props: ReasoningEffortSelectorProps) {
  const { t } = useI18n();

  const selectedModel = createMemo(() =>
    props.models().find((m) => m.modelId === props.selectedModelId()),
  );

  const supportedEfforts = createMemo(() =>
    selectedModel()?.capabilities?.supportedReasoningEfforts ?? [],
  );

  const currentEffort = createMemo(() =>
    props.currentEffort?.() ?? getEffectiveReasoningEffortForEngine(props.engineType),
  );

  const handleEffortSelect = (effort: ReasoningEffort) => {
    if (props.onSelect) {
      props.onSelect(effort);
      return;
    }
    saveReasoningEffort(props.engineType, effort);
  };

  const levelLabels: Record<string, () => string> = {
    low: () => t().prompt.reasoningEffortLow,
    medium: () => t().prompt.reasoningEffortMedium,
    high: () => t().prompt.reasoningEffortHigh,
    max: () => t().prompt.reasoningEffortMax,
  };

  return (
    <Show when={supportedEfforts().length > 0}>
      <div class={props.compact
        ? "flex items-center gap-2 flex-wrap"
        : "px-4 sm:px-6 pb-4 sm:pb-6 pt-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4 -mt-2"}>
        <Show when={!props.compact}>
          <div>
            <h4 class="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t().engine.reasoningEffort}
            </h4>
            <p class="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
              {t().engine.reasoningEffortDesc}
            </p>
          </div>
        </Show>
        <div
          class={`flex rounded-lg overflow-hidden border border-gray-300 dark:border-slate-600 flex-shrink-0 ${props.compact ? "bg-white/80 dark:bg-slate-800/80" : ""}`}
          role="group"
          aria-label={t().engine.reasoningEffort}
        >
          <For each={supportedEfforts()}>
            {(effort) => {
              const isActive = () => currentEffort() === effort;
              return (
                <button
                  type="button"
                  onClick={() => handleEffortSelect(effort)}
                  aria-pressed={isActive()}
                  class={`px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive()
                      ? "bg-amber-500 text-white"
                      : "bg-white dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-600"
                  }`}
                >
                  {levelLabels[effort]?.() ?? effort}
                </button>
              );
            }}
          </For>
        </div>
      </div>
    </Show>
  );
}
