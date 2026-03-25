import { createSignal, createEffect, createMemo, For, Show, onCleanup } from "solid-js";
import { IconArrowUp } from "./icons";
import { useI18n } from "../lib/i18n";
import { notify } from "../lib/notifications";
import type { AgentMode, ImageAttachment, EngineCommand } from "../types/unified";

const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_IMAGE_SIZE = 3 * 1024 * 1024; // 3MB per image — stays within WS payload limits after base64/JSON overhead
const MAX_IMAGES = 4;

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
  if (label === "default" || label === "interactive" || label === "build") return "bg-indigo-600";
  if (label === "plan") return "bg-cyan-600";
  if (label === "autopilot" || label === "auto-accept") return "bg-emerald-600";
  // Fallback by position
  const palette = ["bg-indigo-600", "bg-cyan-600", "bg-emerald-600"];
  if (index < palette.length) return palette[index];
  return "bg-slate-600";
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
      bg: "bg-cyan-50/60 dark:bg-slate-800/70 backdrop-blur-xl",
      ring: "focus-within:ring-cyan-500/40",
      border: "border-cyan-200/40 dark:border-cyan-600/30",
      bgHover: "bg-cyan-600 hover:bg-cyan-700",
    };
  if (label === "autopilot" || label === "auto-accept")
    return {
      bg: "bg-emerald-50/60 dark:bg-slate-800/70 backdrop-blur-xl",
      ring: "focus-within:ring-emerald-500/40",
      border: "border-emerald-200/40 dark:border-emerald-600/30",
      bgHover: "bg-emerald-600 hover:bg-emerald-700",
    };
  // Default / Interactive / Build / unknown
  return {
    bg: "bg-indigo-50/60 dark:bg-slate-800/70 backdrop-blur-xl",
    ring: "focus-within:ring-indigo-500/40",
    border: "border-indigo-200/40 dark:border-indigo-600/30",
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
  // 3 — check-circle / auto-accept
  () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  ),
];

function getModeIcon(mode: AgentMode, index: number) {
  const label = getModeDisplayName(mode).toLowerCase();
  if (label === "default" || label === "interactive" || label === "build") return MODE_ICONS[0]();
  if (label === "plan") return MODE_ICONS[1]();
  if (label === "autopilot") return MODE_ICONS[2]();
  if (label === "auto-accept") return MODE_ICONS[3]();
  return MODE_ICONS[index % MODE_ICONS.length]();
}

interface PromptInputProps {
  onSend: (text: string, agent: AgentMode, images?: ImageAttachment[]) => void;
  onCancel?: () => void;
  /** When true, the session is generating — show stop button and prevent duplicate sends, but keep textarea editable */
  isGenerating?: boolean;
  /** When true, the engine supports enqueuing messages while busy */
  canEnqueue?: boolean;
  /** Number of messages waiting in the queue */
  queueCount?: number;
  currentAgent?: AgentMode;
  onAgentChange?: (agent: AgentMode) => void;
  availableModes?: AgentMode[];
  /** When true, the input is disabled (e.g., no session or modes not loaded yet) */
  disabled?: boolean;
  /** Whether the current engine supports image attachments */
  imageAttachmentEnabled?: boolean;
  /** Available slash commands from the current engine */
  availableCommands?: EngineCommand[];
  /** Called when user invokes a slash command (instead of onSend) */
  onCommandInvoke?: (commandName: string, args: string, agent: AgentMode) => void;
}

export function PromptInput(props: PromptInputProps) {
  const { t } = useI18n();
  const [text, setText] = createSignal("");
  const [textarea, setTextarea] = createSignal<HTMLTextAreaElement>();
  const [images, setImages] = createSignal<ImageAttachment[]>([]);
  const [dragOver, setDragOver] = createSignal(false);
  let fileInputRef: HTMLInputElement | undefined;
  let pasteCounter = 0;

  // --- Slash command autocomplete state ---
  const [showCommandMenu, setShowCommandMenu] = createSignal(false);
  const [commandSelectedIndex, setCommandSelectedIndex] = createSignal(0);
  let commandMenuRef: HTMLDivElement | undefined;

  /** Parse the current text: detect `/command args` prefix */
  const commandQuery = createMemo(() => {
    const val = text();
    if (!val.startsWith("/")) return null;
    // Only trigger for single-line prefix (no newlines before command)
    const firstNewline = val.indexOf("\n");
    const commandLine = firstNewline === -1 ? val : val.slice(0, firstNewline);
    const spaceIdx = commandLine.indexOf(" ");
    const name = spaceIdx === -1
      ? commandLine.slice(1) // everything after /
      : commandLine.slice(1, spaceIdx); // from / to first space
    const args = spaceIdx === -1 ? "" : commandLine.slice(spaceIdx + 1);
    return { name, args, full: commandLine };
  });

  /** Filter available commands by the typed query */
  const filteredCommands = createMemo(() => {
    const commands = props.availableCommands;
    if (!commands || commands.length === 0) return [];
    const q = commandQuery();
    if (!q) return [];
    const search = q.name.toLowerCase();
    // If user has typed a space (selecting/entering args), hide the dropdown
    if (q.args !== "") return [];
    // Filter by name or description prefix match
    return commands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(search) ||
        cmd.description.toLowerCase().includes(search)
    );
  });

  // Show/hide the command menu reactively
  createEffect(() => {
    const q = commandQuery();
    const cmds = filteredCommands();
    if (q && cmds.length > 0) {
      setShowCommandMenu(true);
      // Reset selection when filter changes
      setCommandSelectedIndex(0);
    } else {
      setShowCommandMenu(false);
    }
  });

  /** Select a command from the autocomplete menu */
  const selectCommand = (cmd: EngineCommand) => {
    setText(`/${cmd.name} `);
    setShowCommandMenu(false);
    textarea()?.focus();
  };

  // Scroll selected command item into view
  createEffect(() => {
    if (!showCommandMenu()) return;
    const idx = commandSelectedIndex();
    const container = commandMenuRef;
    if (!container) return;
    const items = container.querySelectorAll("[data-command-item]");
    const item = items[idx] as HTMLElement | undefined;
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  });

  // Close command menu on click outside
  const handleClickOutside = (e: MouseEvent) => {
    if (commandMenuRef && !commandMenuRef.contains(e.target as Node)) {
      setShowCommandMenu(false);
    }
  };
  createEffect(() => {
    if (showCommandMenu()) {
      document.addEventListener("mousedown", handleClickOutside);
    } else {
      document.removeEventListener("mousedown", handleClickOutside);
    }
  });
  onCleanup(() => document.removeEventListener("mousedown", handleClickOutside));

  const addImageFromFile = (file: File) => {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      notify(t().prompt.imageUnsupportedType, "warning", 3000);
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      notify(t().prompt.imageTooLarge, "warning", 3000);
      return;
    }
    if (images().length >= MAX_IMAGES) {
      notify(t().prompt.imageLimitReached, "warning", 3000);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      if (!base64) return;
      setImages((prev) => [
        ...prev,
        {
          id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: file.name || `paste-${++pasteCounter}.${(file.type.split("/")[1]) || "png"}`,
          mimeType: file.type,
          data: base64,
          size: file.size,
        },
      ]);
    };
    reader.readAsDataURL(file);
  };

  const removeImage = (id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  };

  const handlePaste = (e: ClipboardEvent) => {
    if (!props.imageAttachmentEnabled) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    // Only prevent default paste if clipboard has no text (image-only paste)
    const hasText = Array.from(items).some((item) => item.type === "text/plain");
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        if (!hasText) e.preventDefault();
        const file = item.getAsFile();
        if (file) addImageFromFile(file);
      }
    }
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!props.imageAttachmentEnabled) return;
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (const file of files) {
      if (file.type.startsWith("image/")) addImageFromFile(file);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (props.imageAttachmentEnabled) setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

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
    const maxHeight = window.innerWidth < 640 ? 120 : 200;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
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
    // Slash command menu keyboard navigation
    if (showCommandMenu()) {
      const cmds = filteredCommands();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCommandSelectedIndex((i) => (i + 1) % cmds.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCommandSelectedIndex((i) => (i - 1 + cmds.length) % cmds.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const selected = cmds[commandSelectedIndex()];
        if (selected) selectCommand(selected);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowCommandMenu(false);
        return;
      }
      // Enter while command menu is open: select the highlighted command
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const selected = cmds[commandSelectedIndex()];
        if (selected) selectCommand(selected);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const canSend = !props.isGenerating || props.canEnqueue;
      const hasContent = text().trim() || images().length > 0;
      if (hasContent && canSend && !props.disabled) {
        doSend();
      }
    }
  };

  /** Shared send logic — detects slash command or falls through to normal send */
  const doSend = () => {
    const trimmed = text().trim();
    // Detect slash command: text starts with / and onCommandInvoke is provided
    if (trimmed.startsWith("/") && props.onCommandInvoke) {
      const spaceIdx = trimmed.indexOf(" ");
      const commandName = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
      if (commandName) {
        props.onCommandInvoke(commandName, args, agent());
        setText("");
        setImages([]);
        return;
      }
    }
    // Normal send
    const imgs = images().length > 0 ? [...images()] : undefined;
    props.onSend(text(), agent(), imgs);
    setText("");
    setImages([]);
  };

  const handleSend = () => {
    const canSend = !props.isGenerating || props.canEnqueue;
    if (!canSend || props.disabled) return;

    const hasContent = text().trim() || images().length > 0;
    if (hasContent) {
      doSend();
    }
  };

  // Derived accent info for the currently active mode
  const activeAccent = createMemo(() => {
    const current = agent();
    const idx = modes().findIndex((m) => m.id === current.id);
    return getModeAccentRing(current, idx === -1 ? 0 : idx);
  });

  // Placeholder text based on active mode and generating state
  const modePlaceholder = createMemo(() => {
    if (props.isGenerating) {
      if (props.canEnqueue) return t().prompt.typeNextMessage ?? "Type your next message...";
      return t().prompt.waitingForResponse ?? "Waiting for response...";
    }
    const label = getModeDisplayName(agent()).toLowerCase();
    if (label === "plan") return t().prompt.planPlaceholder;
    if (label === "autopilot") return t().prompt.autopilotPlaceholder;
    if (label === "build" || label === "interactive" || label === "default") return t().prompt.buildPlaceholder;
    return t().prompt.placeholder;
  });

  return (
    <div class="w-full max-w-4xl mx-auto">
      {/* Agent selector and Model selector row */}
      <div class="flex items-center justify-between gap-1.5 sm:gap-2 mb-2 px-1 flex-wrap">
        {/* Agent mode buttons - left side */}
        <div class="flex gap-1.5 sm:gap-2">
          <For each={modes()}>
            {(mode, index) => {
              const displayName = getModeDisplayName(mode);
              const isActive = () => agent().id === mode.id;
              const color = getModeColor(mode, index());
              const icon = getModeIcon(mode, index());

              return (
                <button
                  onClick={() => handleAgentChange(mode)}
                  class={`px-2 sm:px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center gap-1 sm:gap-1.5 min-h-[36px] ${
                    isActive()
                      ? `${color} text-white shadow-md shadow-current/20`
                      : "bg-slate-100/60 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 hover:bg-slate-200/80 dark:hover:bg-slate-700/60 backdrop-blur-sm"
                  }`}
                  title={mode.description ?? displayName}
                >
                  {icon}
                  <span class="hidden sm:inline">{displayName}</span>
                </button>
              );
            }}
          </For>
        </div>
      </div>

      {/* Input area */}
      <div
        class={`relative rounded-2xl border shadow-lg shadow-black/[0.03] dark:shadow-black/20 focus-within:ring-2 focus-within:border-transparent transition-all ${activeAccent().bg} ${activeAccent().border} ${activeAccent().ring} ${dragOver() ? "ring-2 ring-blue-400 border-blue-400" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Slash command autocomplete dropdown */}
        <Show when={showCommandMenu() && filteredCommands().length > 0}>
          <div
            ref={(el) => { commandMenuRef = el; }}
            class="absolute bottom-full left-0 right-0 mb-1 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-xl shadow-black/10 dark:shadow-black/30 max-h-48 overflow-y-auto z-50"
          >
            <For each={filteredCommands()}>
              {(cmd, index) => (
                <button
                  data-command-item
                  onClick={() => selectCommand(cmd)}
                  onMouseEnter={() => setCommandSelectedIndex(index())}
                  class={`w-full text-left px-3 py-2 flex items-center gap-3 text-sm transition-colors ${
                    commandSelectedIndex() === index()
                      ? "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300"
                      : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-700/50"
                  }`}
                >
                  <span class="font-mono font-semibold text-xs shrink-0 text-indigo-600 dark:text-indigo-400">/{cmd.name}</span>
                  <span class="text-xs text-gray-500 dark:text-gray-400 truncate flex-1">{cmd.description}</span>
                  <Show when={cmd.argumentHint}>
                    <span class="text-[10px] text-gray-400 dark:text-gray-500 shrink-0 font-mono">{cmd.argumentHint}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        {/* Image preview area */}
        <Show when={images().length > 0}>
          <div class="flex gap-2 px-3 pt-3 pb-1 overflow-x-auto">
            <For each={images()}>
              {(img) => (
                <div class="relative flex-shrink-0 w-12 h-12 rounded-lg overflow-hidden bg-slate-200 dark:bg-slate-700 group">
                  <img
                    src={`data:${img.mimeType};base64,${img.data}`}
                    alt={img.name}
                    class="w-full h-full object-cover"
                  />
                  <button
                    onClick={() => removeImage(img.id)}
                    class="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white rounded-full text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label={t().prompt.removeImage}
                  >
                    ✕
                  </button>
                  <div class="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-[8px] px-1 truncate">
                    {img.name}
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
        <textarea
          ref={setTextarea}
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            adjustHeight();
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={props.disabled}
          placeholder={
            props.disabled
              ? "Select a mode to start..."
              : modePlaceholder()
          }
          rows={1}
          class={`w-full px-3 sm:px-4 py-3 pr-16 sm:pr-20 bg-transparent resize-none focus:outline-none dark:text-white max-h-[120px] sm:max-h-[200px] overflow-y-auto text-sm placeholder:text-slate-400 dark:placeholder:text-slate-500 ${props.disabled ? "cursor-not-allowed opacity-50" : ""}`}
          style={{ "min-height": "52px" }}
        />
        {/* Hidden file input for image selection */}
        <input
          ref={(el) => { fileInputRef = el; }}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          class="hidden"
          onChange={(e) => {
            const files = e.currentTarget.files;
            if (files) for (const f of files) addImageFromFile(f);
            e.currentTarget.value = "";
          }}
        />
        {/* Attachment button + 3-state send button */}
        {(() => {
          const isGenerating = props.isGenerating;
          const hasContent = !!text().trim() || images().length > 0;
          const showSendButton = !isGenerating || (isGenerating && props.canEnqueue && hasContent);
          const showStopButton = isGenerating && !(props.canEnqueue && hasContent);

          if (showSendButton) {
            return (
              <div class="absolute right-2.5 bottom-2.5 flex items-center gap-1">
                <Show when={props.imageAttachmentEnabled}>
                  <button
                    onClick={() => fileInputRef?.click()}
                    disabled={props.disabled || images().length >= MAX_IMAGES}
                    class="p-2 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors disabled:opacity-30"
                    aria-label={t().prompt.attachImage}
                    title={t().prompt.attachImage}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                  </button>
                </Show>
                <button
                  onClick={handleSend}
                  disabled={!hasContent || props.disabled}
                  class={`p-2 rounded-xl text-white transition-all disabled:bg-slate-200 dark:disabled:bg-slate-700 disabled:text-slate-400 dark:disabled:text-slate-500 shadow-md disabled:shadow-none ${activeAccent().bgHover}`}
                  aria-label={t().prompt.send}
                >
                  <IconArrowUp width={20} height={20} />
                </button>
              </div>
            );
          }

          if (showStopButton) {
            return (
              <button
                onClick={() => props.onCancel?.()}
                class="absolute right-2.5 bottom-2.5 p-2 rounded-xl bg-red-500 hover:bg-red-600 text-white transition-all shadow-md"
                aria-label="Stop"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
                {/* Queue count badge */}
                <Show when={(props.queueCount ?? 0) > 0}>
                  <span class="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] flex items-center justify-center px-1 text-[10px] font-bold bg-amber-500 text-white rounded-full shadow-sm">
                    {props.queueCount}
                  </span>
                </Show>
              </button>
            );
          }

          return null;
        })()}
      </div>
    </div>
  );
}
