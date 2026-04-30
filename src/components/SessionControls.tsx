import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { ChatModelPicker } from "./ChatModelPicker";
import { useI18n } from "../lib/i18n";
import type { CodexServiceTier, ReasoningEffort, UnifiedModelInfo } from "../types/unified";

interface SessionControlsProps {
  models: UnifiedModelInfo[];
  selectedModelId: string | null;
  customModelInput: boolean;
  modelDisabled?: boolean;
  modelPlaceholder: string;
  modelAriaLabel: string;
  supportedEfforts: ReasoningEffort[];
  selectedEffort: ReasoningEffort | null;
  fastModeSupported: boolean;
  serviceTier: CodexServiceTier | null;
  scopeHint: string;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  onFastModeToggle: (nextActive: boolean) => void;
}

interface PopoverPosition {
  left: number;
  top: number;
  width: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function SettingRow(props: { label: string; description?: string; children: JSX.Element }) {
  return (
    <div class="space-y-2">
      <div>
        <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          {props.label}
        </div>
        <Show when={props.description}>
          <div class="mt-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            {props.description}
          </div>
        </Show>
      </div>
      {props.children}
    </div>
  );
}

export function SessionControls(props: SessionControlsProps) {
  const { t } = useI18n();
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal<PopoverPosition | null>(null);
  let triggerRef: HTMLButtonElement | undefined;
  let panelRef: HTMLDivElement | undefined;

  const selectedModel = createMemo(() =>
    props.models.find((model) => model.modelId === props.selectedModelId),
  );

  const modelLabel = createMemo(() =>
    selectedModel()?.name || props.selectedModelId || props.modelPlaceholder,
  );

  const effortLabels: Record<ReasoningEffort, () => string> = {
    low: () => t().prompt.reasoningEffortLow,
    medium: () => t().prompt.reasoningEffortMedium,
    high: () => t().prompt.reasoningEffortHigh,
    max: () => t().prompt.reasoningEffortMax,
  };

  const effortLabel = createMemo(() => {
    const effort = props.selectedEffort;
    return effort ? effortLabels[effort]?.() ?? effort : null;
  });

  const fastActive = createMemo(() => props.serviceTier === "fast");

  const summary = createMemo(() => {
    const parts = [modelLabel()];
    const effort = effortLabel();
    if (effort && props.supportedEfforts.length > 0) parts.push(effort);
    if (props.fastModeSupported && fastActive()) parts.push(t().engine.fastMode);
    return parts.join(" · ");
  });

  const updatePosition = () => {
    if (!triggerRef) return;
    const rect = triggerRef.getBoundingClientRect();
    const viewportWidth = window.innerWidth || 380;
    const width = Math.min(380, Math.max(280, viewportWidth - 24));
    const maxLeft = Math.max(12, viewportWidth - width - 12);
    setPosition({
      left: clamp(rect.left, 12, maxLeft),
      top: rect.top - 8,
      width,
    });
  };

  const toggleOpen = () => {
    if (open()) {
      setOpen(false);
      setPosition(null);
      return;
    }
    updatePosition();
    setOpen(true);
  };

  createEffect(() => {
    if (!open()) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (triggerRef?.contains(target) || panelRef?.contains(target)) return;
      if (target.closest("#chat-model-picker-dropdown")) return;
      setOpen(false);
      setPosition(null);
    };

    const handleResize = () => updatePosition();

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("resize", handleResize);
    onCleanup(() => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("resize", handleResize);
    });
  });

  return (
    <div class="min-w-0">
      <button
        ref={triggerRef}
        type="button"
        class={`inline-flex h-7 max-w-[56vw] items-center gap-2 rounded-full border px-2.5 text-[11px] font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-slate-300 dark:focus:ring-slate-600 ${
          open()
            ? "border-slate-300 bg-white text-slate-700 shadow-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
            : "border-slate-200/80 bg-white/50 text-slate-500 hover:border-slate-300 hover:bg-white dark:border-slate-700/80 dark:bg-slate-800/40 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:bg-slate-800"
        }`}
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        title={summary()}
        onClick={toggleOpen}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            setPosition(null);
          }
        }}
      >
        <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M4 7h16" />
          <path d="M7 12h10" />
          <path d="M10 17h4" />
        </svg>
        <span class="min-w-0 truncate">{summary()}</span>
        <svg class="h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <Show when={open() && position()}>
        <Portal>
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t().chat.sessionScopeHint}
            style={{
              left: `${position()!.left}px`,
              top: `${position()!.top}px`,
              width: `${position()!.width}px`,
            }}
            class="fixed z-[9998] -translate-y-full rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-xl shadow-slate-900/10 backdrop-blur dark:border-slate-700 dark:bg-slate-900/95 dark:shadow-black/30"
          >
            <div class="space-y-3">
              <SettingRow label={t().engine.defaultModel}>
                <ChatModelPicker
                  models={props.models}
                  selectedModelId={props.selectedModelId}
                  customModelInput={props.customModelInput}
                  disabled={props.modelDisabled}
                  fullWidth
                  placeholder={props.modelPlaceholder}
                  ariaLabel={props.modelAriaLabel}
                  onChange={props.onModelChange}
                />
              </SettingRow>

              <Show when={props.supportedEfforts.length > 0}>
                <SettingRow label={t().engine.reasoningEffort} description={t().engine.reasoningEffortDesc}>
                  <div class="flex gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
                    <For each={props.supportedEfforts}>
                      {(effort) => {
                        const active = () => props.selectedEffort === effort;
                        return (
                          <button
                            type="button"
                            aria-pressed={active()}
                            class={`shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                              active()
                                ? "bg-white text-slate-800 shadow-sm dark:bg-slate-700 dark:text-slate-100"
                                : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                            }`}
                            onClick={() => props.onReasoningEffortChange(effort)}
                          >
                            {effortLabels[effort]?.() ?? effort}
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </SettingRow>
              </Show>

              <Show when={props.fastModeSupported}>
                <SettingRow label={t().engine.fastMode} description={t().engine.fastModeDesc}>
                  <button
                    type="button"
                    aria-pressed={fastActive()}
                    class={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-[12px] transition-colors ${
                      fastActive()
                        ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300"
                        : "border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800"
                    }`}
                    onClick={() => props.onFastModeToggle(!fastActive())}
                  >
                    <span class="inline-flex items-center gap-2 font-medium">
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
                      </svg>
                      <span>{t().engine.fastMode}</span>
                    </span>
                    <span class={`h-2 w-2 rounded-full ${fastActive() ? "bg-blue-500" : "bg-slate-300 dark:bg-slate-600"}`} />
                  </button>
                </SettingRow>
              </Show>

              <div class="rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                {props.scopeHint}
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
