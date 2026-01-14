import { createSignal, createEffect } from "solid-js";
import { IconArrowUp } from "./icons";

interface PromptInputProps {
  onSend: (text: string, mode?: "build" | "plan") => void;
  disabled?: boolean;
}

export function PromptInput(props: PromptInputProps) {
  const [text, setText] = createSignal("");
  const [textarea, setTextarea] = createSignal<HTMLTextAreaElement>();
  const [mode, setMode] = createSignal<"normal" | "build" | "plan">("normal");

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

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (text().trim() && !props.disabled) {
        const selectedMode = mode();
        props.onSend(
          text(),
          selectedMode === "normal" ? undefined : selectedMode,
        );
        setText("");
      }
    }
  };

  const handleSend = () => {
    if (text().trim() && !props.disabled) {
      const selectedMode = mode();
      props.onSend(
        text(),
        selectedMode === "normal" ? undefined : selectedMode,
      );
      setText("");
    }
  };

  return (
    <div class="w-full max-w-4xl mx-auto">
      {/* Mode selector */}
      <div class="flex gap-2 mb-2 px-1">
        <button
          onClick={() => setMode("normal")}
          class={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
            mode() === "normal"
              ? "bg-blue-600 text-white"
              : "bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-zinc-700"
          }`}
          title="普通对话模式"
        >
          💬 普通
        </button>
        <button
          onClick={() => setMode("build")}
          class={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
            mode() === "build"
              ? "bg-green-600 text-white"
              : "bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-zinc-700"
          }`}
          title="Build 模式 - 用于构建和编码任务"
        >
          🔨 Build
        </button>
        <button
          onClick={() => setMode("plan")}
          class={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
            mode() === "plan"
              ? "bg-purple-600 text-white"
              : "bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-zinc-700"
          }`}
          title="Plan 模式 - 用于规划和设计任务"
        >
          📋 Plan
        </button>
      </div>

      {/* Input area */}
      <div class="relative bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 shadow-sm focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent transition-all">
        <textarea
          ref={setTextarea}
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            adjustHeight();
          }}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={1}
          disabled={props.disabled}
          class="w-full px-4 py-3 pr-12 bg-transparent resize-none focus:outline-none dark:text-white disabled:opacity-50 max-h-[200px] overflow-y-auto"
          style={{ "min-height": "52px" }}
        />
        <button
          onClick={handleSend}
          disabled={!text().trim() || props.disabled}
          class="absolute right-2 bottom-2 p-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-200 dark:disabled:bg-zinc-700 disabled:text-gray-400 dark:disabled:text-zinc-500 transition-colors"
          aria-label="Send message"
        >
          <IconArrowUp width={20} height={20} />
        </button>
      </div>
    </div>
  );
}
