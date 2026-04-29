import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { UnifiedModelInfo } from "../types/unified";

interface ModelProviderGroup {
  id: string;
  name: string;
  models: UnifiedModelInfo[];
}

interface DropdownPosition {
  left: number;
  top: number;
  width: number;
}

interface ChatModelPickerProps {
  models: UnifiedModelInfo[];
  selectedModelId: string | null;
  customModelInput: boolean;
  disabled?: boolean;
  placeholder: string;
  ariaLabel: string;
  onChange: (modelId: string) => void;
}

const VIEWPORT_MARGIN = 12;
const DROPDOWN_MIN_WIDTH = 260;
const DROPDOWN_MAX_WIDTH = 360;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function modelLabel(model: UnifiedModelInfo | undefined, fallback: string | null): string {
  return model?.name || fallback || "";
}

function modelTitle(model: UnifiedModelInfo | undefined, fallback: string | null): string {
  if (!model) return fallback || "";
  return model.name && model.name !== model.modelId
    ? `${model.name} (${model.modelId})`
    : model.modelId;
}

export function ChatModelPicker(props: ChatModelPickerProps) {
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal<DropdownPosition | null>(null);
  const [inputDraft, setInputDraft] = createSignal<string | null>(null);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let commitTimer: ReturnType<typeof setTimeout> | undefined;

  const groups = createMemo<ModelProviderGroup[]>(() => {
    const byProvider = new Map<string, ModelProviderGroup>();
    for (const model of props.models) {
      const id = model.providerId || "default";
      if (!byProvider.has(id)) {
        byProvider.set(id, {
          id,
          name: model.providerName || id,
          models: [],
        });
      }
      byProvider.get(id)!.models.push(model);
    }
    return Array.from(byProvider.values());
  });

  const selectedModel = createMemo(() =>
    props.models.find((model) => model.modelId === props.selectedModelId),
  );

  const displayValue = createMemo(() =>
    inputDraft() ?? (props.customModelInput
      ? props.selectedModelId ?? ""
      : modelLabel(selectedModel(), props.selectedModelId)),
  );

  const isDisabled = createMemo(() =>
    props.disabled === true || (!props.customModelInput && props.models.length === 0),
  );

  createEffect(() => {
    props.selectedModelId;
    if (!open()) setInputDraft(null);
  });

  onCleanup(() => {
    if (closeTimer) clearTimeout(closeTimer);
    if (commitTimer) clearTimeout(commitTimer);
  });

  const updatePosition = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const viewportWidth = window.innerWidth || DROPDOWN_MAX_WIDTH;
    const maxWidth = Math.max(160, viewportWidth - VIEWPORT_MARGIN * 2);
    const width = Math.min(
      Math.max(rect.width, DROPDOWN_MIN_WIDTH),
      Math.min(DROPDOWN_MAX_WIDTH, maxWidth),
    );
    setPosition({
      left: clamp(rect.left, VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN),
      top: rect.top - 8,
      width,
    });
  };

  const openDropdown = (target: HTMLElement) => {
    if (isDisabled()) return;
    if (closeTimer) clearTimeout(closeTimer);
    updatePosition(target);
    setOpen(true);
  };

  const closeDropdown = () => {
    setOpen(false);
    setPosition(null);
  };

  const closeDropdownSoon = () => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(closeDropdown, 120);
  };

  const commitCustomValue = (value: string) => {
    if (props.disabled) return;
    props.onChange(value);
  };

  const scheduleCustomCommit = (value: string) => {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      commitTimer = undefined;
      commitCustomValue(value);
    }, 400);
  };

  const handleCustomBlur = (value: string) => {
    closeDropdownSoon();
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = undefined;
    }
    setInputDraft(null);
    commitCustomValue(value);
  };

  const selectModel = (modelId: string) => {
    if (isDisabled()) return;
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = undefined;
    }
    setInputDraft(null);
    closeDropdown();
    props.onChange(modelId);
  };

  const dropdownId = "chat-model-picker-dropdown";

  return (
    <div class="inline-flex min-w-0">
      <Show
        when={props.customModelInput}
        fallback={
          <button
            type="button"
            class="flex h-7 w-[220px] max-w-[45vw] min-w-[140px] items-center justify-between gap-2 rounded-lg border-0 bg-transparent py-1 pl-2 pr-2 text-left text-[11px] text-slate-500 transition-colors hover:bg-slate-100 focus:outline-none focus:ring-1 focus:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-400 dark:hover:bg-slate-700/50 dark:focus:ring-slate-600"
            disabled={isDisabled()}
            aria-label={props.ariaLabel}
            aria-haspopup="listbox"
            aria-expanded={open() ? "true" : "false"}
            aria-controls={open() ? dropdownId : undefined}
            title={modelTitle(selectedModel(), props.selectedModelId)}
            onClick={(e) => open() ? closeDropdown() : openDropdown(e.currentTarget)}
            onBlur={closeDropdownSoon}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeDropdown();
              if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openDropdown(e.currentTarget);
              }
            }}
          >
            <span class="min-w-0 flex-1 truncate whitespace-nowrap">
              {modelLabel(selectedModel(), props.selectedModelId) || props.placeholder}
            </span>
            <svg
              class="h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        }
      >
        <input
          type="text"
          value={displayValue()}
          title={props.selectedModelId ?? ""}
          disabled={props.disabled}
          placeholder={props.placeholder}
          role="combobox"
          aria-label={props.ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={open() ? dropdownId : undefined}
          class="h-7 w-[220px] max-w-[45vw] min-w-[140px] rounded-lg border-0 bg-transparent px-2 py-1 text-[11px] text-slate-500 transition-colors hover:bg-slate-100 focus:outline-none focus:ring-1 focus:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-400 dark:hover:bg-slate-700/50 dark:focus:ring-slate-600"
          onFocus={(e) => openDropdown(e.currentTarget)}
          onInput={(e) => {
            const value = e.currentTarget.value;
            setInputDraft(value);
            scheduleCustomCommit(value);
            openDropdown(e.currentTarget);
          }}
          onBlur={(e) => handleCustomBlur(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") closeDropdown();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              openDropdown(e.currentTarget);
            }
          }}
        />
      </Show>

      <Show when={open() && position() && props.models.length > 0}>
        <Portal>
          <div
            id={dropdownId}
            role="listbox"
            aria-label={props.ariaLabel}
            style={{
              left: `${position()!.left}px`,
              top: `${position()!.top}px`,
              width: `${position()!.width}px`,
            }}
            class="fixed z-[9999] max-h-60 -translate-y-full overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800"
            onMouseDown={(e) => e.preventDefault()}
          >
            <For each={groups()}>
              {(group) => (
                <>
                  <Show when={groups().length > 1}>
                    <div class="sticky top-0 z-10 bg-white/95 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:bg-slate-800/95 dark:text-slate-500">
                      <span class="block truncate" title={group.name}>{group.name}</span>
                    </div>
                  </Show>
                  <For each={group.models}>
                    {(model) => {
                      const selected = () => model.modelId === props.selectedModelId;
                      return (
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected() ? "true" : "false"}
                          title={modelTitle(model, model.modelId)}
                          class={`flex w-full min-w-0 items-center px-3 py-1.5 text-left text-[11px] transition-colors ${
                            selected()
                              ? "bg-slate-100 text-slate-700 dark:bg-slate-700/70 dark:text-slate-100"
                              : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
                          }`}
                          onClick={() => selectModel(model.modelId)}
                        >
                          <span class="min-w-0 flex-1 truncate whitespace-nowrap">
                            {model.name || model.modelId}
                          </span>
                        </button>
                      );
                    }}
                  </For>
                </>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
