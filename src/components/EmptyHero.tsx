import { For, Show, type JSX } from "solid-js";
import { useI18n } from "../lib/i18n";
import type { EngineInfo } from "../types/unified";

interface EmptyHeroProps {
  icon: JSX.Element;
  title: string;
  description: string;
  detail?: string;
  /** When provided, renders a live status chip per engine under the copy. */
  engines?: EngineInfo[];
  class?: string;
}

/**
 * Centered empty state with the Graphite backdrop: a faded hairline grid,
 * a soft violet/cyan aurora and a glass icon tile.
 */
export function EmptyHero(props: EmptyHeroProps) {
  const { t } = useI18n();

  const statusTone = (status: EngineInfo["status"]) => {
    switch (status) {
      case "running": return "text-emerald-500";
      case "starting": return "text-amber-500";
      case "error": return "text-red-500";
      default: return "text-gray-400 dark:text-gray-600";
    }
  };
  const statusLabel = (status: EngineInfo["status"]) => {
    switch (status) {
      case "running": return t().engine.running;
      case "starting": return t().engine.starting;
      case "error": return t().engine.error;
      default: return t().engine.stopped;
    }
  };

  return (
    <div class={`relative flex flex-col items-center justify-center text-center px-6 isolate ${props.class ?? ""}`}>
      <div aria-hidden="true" class="pointer-events-none absolute inset-0 -z-10 cm-grid-bg" />
      <div aria-hidden="true" class="pointer-events-none absolute inset-0 -z-10 cm-aurora" />

      <div class="animate-cm-fade-up relative mb-6">
        <div class="absolute -inset-3 rounded-[22px] bg-[var(--cm-gradient-soft)] blur-xl opacity-80" aria-hidden="true" />
        <div class="relative w-14 h-14 rounded-2xl flex items-center justify-center bg-[var(--cm-surface)] text-gray-700 dark:text-gray-200 ring-1 ring-[var(--cm-hairline-strong)] shadow-[var(--cm-shadow-md)]">
          {props.icon}
        </div>
      </div>

      <h2 class="animate-cm-fade-up text-[22px] leading-tight font-semibold tracking-tight text-gray-900 dark:text-white mb-2" style={{ "animation-delay": "40ms" }}>
        {props.title}
      </h2>
      <p class="animate-cm-fade-up text-sm text-gray-500 dark:text-gray-400 max-w-sm mx-auto" style={{ "animation-delay": "80ms" }}>
        {props.description}
      </p>
      <Show when={props.detail}>
        <p class="animate-cm-fade-up mt-1 text-xs text-gray-400 dark:text-gray-500 max-w-sm mx-auto" style={{ "animation-delay": "100ms" }}>
          {props.detail}
        </p>
      </Show>

      <Show when={props.engines && props.engines.length > 0}>
        <div class="animate-cm-fade-up mt-7 flex flex-wrap items-center justify-center gap-1.5" style={{ "animation-delay": "140ms" }}>
          <For each={props.engines}>
            {(engine) => (
              <span
                class="cm-mono inline-flex items-center gap-1.5 h-6 pl-2 pr-2.5 rounded-full text-[11px] text-gray-600 dark:text-gray-300 bg-[var(--cm-surface)]/80 backdrop-blur ring-1 ring-[var(--cm-hairline-strong)]"
                title={`${engine.name} · ${statusLabel(engine.status)}`}
              >
                <span class={engine.status === "running" ? `cm-live-dot ${statusTone(engine.status)}` : `w-1.5 h-1.5 rounded-full bg-current ${statusTone(engine.status)}`} />
                {engine.name}
                <Show when={engine.version}>
                  <span class="text-gray-400 dark:text-gray-500">{engine.version}</span>
                </Show>
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
