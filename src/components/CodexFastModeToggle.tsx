import { createMemo, Show } from "solid-js";
import { configStore, isFastModeActive, saveServiceTier, clearServiceTier } from "../stores/config";
import { useI18n } from "../lib/i18n";
import type { EngineType } from "../types/unified";

interface CodexFastModeToggleProps {
  engineType: EngineType;
}

export function CodexFastModeToggle(props: CodexFastModeToggleProps) {
  const { t } = useI18n();

  const engine = createMemo(() =>
    configStore.engines.find((e) => e.type === props.engineType),
  );

  const supported = createMemo(() =>
    engine()?.capabilities.fastModeSupported === true,
  );

  const active = createMemo(() =>
    isFastModeActive(props.engineType),
  );

  const handleToggle = () => {
    if (active()) {
      clearServiceTier(props.engineType);
    } else {
      saveServiceTier(props.engineType, "fast");
    }
  };

  return (
    <Show when={supported()}>
      <div class="px-4 sm:px-6 pb-4 sm:pb-6 pt-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4 -mt-2">
        <div>
          <h4 class="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t().engine.fastMode}
          </h4>
          <p class="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            {t().engine.fastModeDesc}
          </p>
        </div>
        <button
          onClick={handleToggle}
          class={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
            active()
              ? "bg-blue-600"
              : "bg-gray-300 dark:bg-slate-600"
          }`}
          role="switch"
          aria-checked={active()}
          aria-label={t().engine.fastMode}
        >
          <span
            class={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              active() ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </div>
    </Show>
  );
}
