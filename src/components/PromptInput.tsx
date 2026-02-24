import { createSignal, createEffect, createMemo, For, Show } from "solid-js";
import { IconArrowUp } from "./icons";
import { useI18n } from "../lib/i18n";
import { ModelSelector } from "./ModelSelector";
import type { AgentMode } from "../types/unified";

const defaultModes: AgentMode[] = [
  { id: "build", label: "Build" },
  { id: "plan", label: "Plan" },
];

/**
 * Resolve a display name for a mode.
 * Prefers `mode.label`; falls back to extracting the hash fragment from a URI
 * (e.g. `...#agent` → "Agent"), then the raw id with first-letter capitalised.
 */
function getModeDisplayName(mode: AgentMode): string {
  if (mode.label) return mode.label;
  const hash = mode.id.includes("#") ? mode.id.split("#").pop() : undefined;
  const raw = hash ?? mode.id;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Return the active-state background colour class for a mode button. */
function getModeColor(mode: AgentMode, index: number): string {
  const label = getModeDisplayName(mode).toLowerCase();
  if (label === "build" || label === "agent") return "bg-emerald-600";
  if (label === "plan") return "bg-violet-600";
  if (label === "autopilot") return "bg-amber-600";
  // Fallback by position
  const palette = ["bg-emerald-600", "bg-violet-600", "bg-amber-600"];
  if (index < palette.length) return palette[index];
  return "bg-zinc-600";
}

/** Return the textarea / send-button accent colour for the active mode. */
function getModeAccentRing(mode: AgentMode, index: number): {
  bg: string;
  ring: string;
  border: string;
  bgHover: string;
} {
  const label = getModeDisplayName(mode).toLowerCase();
  if (label === "plan")
    return {
      bg: "bg-violet-50/60 dark:bg-violet-950/30 backdrop-blur-xl",
      ring: "focus-within:ring-violet-500/40",
      border: "border-violet-200/40 dark:border-violet-800/40",
      bgHover: "bg-violet-600 hover:bg-violet-700",
    };
  if (label === "autopilot")
    return {
      bg: "bg-amber-50 dark:bg-amber-950/20",
      ring: "focus-within:ring-amber-500",
      border: "border-amber-200 dark:border-amber-800",
      bgHover: "bg-amber-600 hover:bg-amber-700",
    };
  // Default (build / agent / first mode / unknown)
  return {
    bg: "bg-white/60 dark:bg-slate-900/60 backdrop-blur-xl",
    ring: "focus-within:ring-indigo-500/40",
    border: "border-slate-200/40 dark:border-slate-700/40",
    bgHover: "bg-indigo-600 hover:bg-indigo-700",
  };
}

// SVG icon paths cycled by mode index / label
const MODE_ICONS: Array<() => any> = [
  // 0 — wrench / build
  () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z" />
      <path d="m14 7 3 3" />
      <path d="M5 6v4" />
      <path d="M19 14v4" />
      <path d="M10 2v2" />
      <path d="M7 8H3" />
      <path d="M21 16h-4" />
      <path d="M11 3H9" />
    </svg>
  ),
  // 1 — book / plan
  () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  ),
  // 2 — zap / autopilot
  () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
];

function getModeIcon(mode: AgentMode, index: number) {
  const label = getModeDisplayName(mode).toLowerCase();
  if (label === "build" || label === "agent") return MODE_ICONS[0]();
  if (label === "plan") return MODE_ICONS[1]();
  if (label === "autopilot") return MODE_ICONS[2]();
  return MODE_ICONS[index % MODE_ICONS.length]();
}

interface PromptInputProps {
  onSend: (text: string, agent: AgentMode) => void;
  onCancel?: () => void;
  /** When true, the session is generating — show stop button and prevent duplicate sends, but keep textarea editable */
  isGenerating?: boolean;
  currentAgent?: AgentMode;
  onAgentChange?: (agent: AgentMode) => void;
  onModelChange?: (providerID: string, modelID: string) => void;
  availableModes?: AgentMode[];
  engineType?: import("../types/unified").EngineType;
  /** When true, the input is disabled (e.g., no session or modes not loaded yet) */
  disabled?: boolean;
}

export function PromptInput(props: PromptInputProps) {
  const { t } = useI18n();
  const [text, setText] = createSignal("");
  const [textarea, setTextarea] = createSignal<HTMLTextAreaElement>();

  const modes = createMemo(() =>
    props.availableModes && props.availableModes.length > 0
      ? props.availableModes
      : defaultModes
  );

  // Default to first available mode
  const [agent, setAgent] = createSignal<AgentMode>(
    props.currentAgent ?? modes()[0],
  );

  const adjustHeight = () => {
    const el = textarea();
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  createEffect(() => {
    // Reset height when text is cleared
    if (!text()) {
      const el = textarea();
      if (el) el.style.height = "auto";
    }
  });

  // Sync agent with props when it changes externally
  createEffect(() => {
    if (props.currentAgent && props.currentAgent.id !== agent().id) {
      setAgent(props.currentAgent);
    }
  });

  const handleAgentChange = (newAgent: AgentMode) => {
    setAgent(newAgent);
    props.onAgentChange?.(newAgent);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (text().trim() && !props.isGenerating && !props.disabled) {
        props.onSend(text(), agent());
        setText("");
      }
    }
  };

  const handleSend = () => {
    if (props.isGenerating || props.disabled) return;

    if (text().trim()) {
      props.onSend(text(), agent());
      setText("");
    }
  };

  // Derived accent info for the currently active mode
  const activeAccent = createMemo(() => {
    const current = agent();
    const idx = modes().findIndex((m) => m.id === current.id);
    return getModeAccentRing(current, idx === -1 ? 0 : idx);
  });

  // Whether the active mode is read-only (plan)
  const isReadOnly = createMemo(() => {
    const label = getModeDisplayName(agent()).toLowerCase();
    return label === "plan";
  });

  return (
    <div class="w-full max-w-4xl mx-auto">
      {/* Agent selector and Model selector row */}
      <div class="flex items-center justify-between gap-2 mb-2 px-1">
        {/* Agent mode buttons - left side */}
        <div class="flex gap-2">
          <For each={modes()}>
            {(mode, index) => {
              const displayName = getModeDisplayName(mode);
              const isActive = () => agent().id === mode.id;
              const color = getModeColor(mode, index());
              const icon = getModeIcon(mode, index());
              const isModePlan = displayName.toLowerCase() === "plan";

              return (
                <button
                  onClick={() => handleAgentChange(mode)}
                  class={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center gap-1.5 ${
                    isActive()
                      ? `${color} text-white shadow-md shadow-indigo-500/20`
                      : "bg-slate-100/60 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 hover:bg-slate-200/80 dark:hover:bg-slate-700/60 backdrop-blur-sm"
                  }`}
                  title={mode.description ?? displayName}
                >
                  {icon}
                  {displayName}
                  {isModePlan && (
                    <span class="text-[10px] opacity-75">
                      ({t().prompt.readOnly})
                    </span>
                  )}
                </button>
              );
            }}
          </For>
        </div>

        {/* Model selector - right side */}
        <ModelSelector engineType={props.engineType} onModelChange={props.onModelChange} />
      </div>

      {/* Input area */}
      <div
        class={`relative rounded-2xl border shadow-lg shadow-black/[0.03] dark:shadow-black/20 focus-within:ring-2 focus-within:border-transparent transition-all ${activeAccent().bg} ${activeAccent().border} ${activeAccent().ring}`}
      >
        <textarea
          ref={setTextarea}
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            adjustHeight();
          }}
          onKeyDown={handleKeyDown}
          disabled={props.disabled}
          placeholder={
            props.disabled
              ? "Select a mode to start..."
              : isReadOnly() ? t().prompt.planPlaceholder : t().prompt.placeholder
          }
          rows={1}
          class={`w-full px-4 py-3 pr-12 bg-transparent resize-none focus:outline-none dark:text-white max-h-[200px] overflow-y-auto placeholder:text-slate-400 dark:placeholder:text-slate-500 ${props.disabled ? "cursor-not-allowed opacity-50" : ""}`}
          style={{ "min-height": "52px" }}
        />
        <Show
          when={props.isGenerating}
          fallback={
            <button
              onClick={handleSend}
              disabled={!text().trim() || props.disabled}
              class={`absolute right-2.5 bottom-2.5 p-2 rounded-xl text-white transition-all disabled:bg-slate-200 dark:disabled:bg-slate-700 disabled:text-slate-400 dark:disabled:text-slate-500 shadow-md disabled:shadow-none ${activeAccent().bgHover}`}
              aria-label={t().prompt.send}
            >
              <IconArrowUp width={20} height={20} />
            </button>
          }
        >
          <button
            onClick={() => props.onCancel?.()}
            class="absolute right-2.5 bottom-2.5 p-2 rounded-xl bg-red-500 hover:bg-red-600 text-white transition-all shadow-md"
            aria-label="Stop"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        </Show>
      </div>
    </div>
  );
}
