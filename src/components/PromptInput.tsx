import { createSignal, createEffect } from "solid-js";
import { IconArrowUp } from "./icons";
import { useI18n } from "../lib/i18n";
import { ModelSelector } from "./ModelSelector";

// Agent type matching OpenCode's agent system
export type AgentMode = "build" | "plan";

interface PromptInputProps {
  onSend: (text: string, agent: AgentMode) => void;
  disabled?: boolean;
  currentAgent?: AgentMode;
  onAgentChange?: (agent: AgentMode) => void;
  onModelChange?: (providerID: string, modelID: string) => void;
}

export function PromptInput(props: PromptInputProps) {
  const { t } = useI18n();
  const [text, setText] = createSignal("");
  const [textarea, setTextarea] = createSignal<HTMLTextAreaElement>();
  // Default to "build" mode, matching OpenCode's default behavior
  const [agent, setAgent] = createSignal<AgentMode>(props.currentAgent || "build");

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
    if (props.currentAgent && props.currentAgent !== agent()) {
      setAgent(props.currentAgent);
    }
  });

  const handleAgentChange = (newAgent: AgentMode) => {
    setAgent(newAgent);
    props.onAgentChange?.(newAgent);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (props.disabled) return;
    
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (text().trim()) {
        props.onSend(text(), agent());
        setText("");
      }
    }
  };

  const handleSend = () => {
    if (props.disabled) return;
    
    if (text().trim()) {
      props.onSend(text(), agent());
      setText("");
    }
  };

  return (
    <div class="w-full max-w-4xl mx-auto">
      {/* Agent selector and Model selector row */}
      <div class="flex items-center justify-between gap-2 mb-2 px-1">
        {/* Agent mode buttons - left side */}
        <div class="flex gap-2">
          <button
            onClick={() => handleAgentChange("build")}
            class={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
              agent() === "build"
                ? "bg-emerald-600 text-white shadow-xs"
                : "bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-zinc-700"
            }`}
            title={t().prompt.buildMode}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/></svg>
            {t().prompt.build}
          </button>
          <button
            onClick={() => handleAgentChange("plan")}
            class={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
              agent() === "plan"
                ? "bg-violet-600 text-white shadow-xs"
                : "bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-zinc-700"
            }`}
            title={t().prompt.planMode}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
            {t().prompt.plan}
            <span class="text-[10px] opacity-75">({t().prompt.readOnly})</span>
          </button>
        </div>

        {/* Model selector - right side */}
        <ModelSelector onModelChange={props.onModelChange} />
      </div>

      {/* Input area */}
      <div class={`relative rounded-xl border shadow-xs focus-within:ring-2 focus-within:border-transparent transition-all ${
        agent() === "plan" 
          ? "bg-violet-50 dark:bg-violet-950/20 border-violet-200 dark:border-violet-800 focus-within:ring-violet-500" 
          : "bg-white dark:bg-zinc-800 border-gray-200 dark:border-zinc-700 focus-within:ring-blue-500"
      }`}>
        <textarea
          ref={setTextarea}
          value={text()}
          disabled={props.disabled}
          onInput={(e) => {
            setText(e.currentTarget.value);
            adjustHeight();
          }}
          onKeyDown={handleKeyDown}
          placeholder={agent() === "plan" ? t().prompt.planPlaceholder : t().prompt.placeholder}
          rows={1}
          class="w-full px-4 py-3 pr-12 bg-transparent resize-none focus:outline-none dark:text-white max-h-[200px] overflow-y-auto disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ "min-height": "52px" }}
        />
        <button
          onClick={handleSend}
          disabled={!text().trim() || props.disabled}
          class={`absolute right-2 bottom-2 p-2 rounded-lg text-white transition-colors disabled:bg-gray-200 dark:disabled:bg-zinc-700 disabled:text-gray-400 dark:disabled:text-zinc-500 ${
            agent() === "plan" 
              ? "bg-violet-600 hover:bg-violet-700" 
              : "bg-blue-600 hover:bg-blue-700"
          }`}
          aria-label={t().prompt.send}
        >
          <IconArrowUp width={20} height={20} />
        </button>
      </div>
    </div>
  );
}
