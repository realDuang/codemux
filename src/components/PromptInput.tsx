import { createSignal, createEffect, createMemo, For, Show, onCleanup, type JSX } from "solid-js";
import { IconArrowUp } from "./icons";
import { useI18n } from "../lib/i18n";
import { notify } from "../lib/notifications";
import { isBrowser } from "../lib/platform";
import type { AgentMode, ImageAttachment, EngineCommand } from "../types/unified";
import {
  ACCEPTED_IMAGE_MIME_TYPES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_SIZE_BYTES,
  validateImageAddition,
} from "../../shared/image-limits";

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

// Permission-preset labels share the styling of equivalent existing modes.
const MODE_STYLE_ALIASES: Record<string, string> = {
  "ask for approval": "manual",
  "approve for me": "auto",
  "full access": "bypass permissions",
};

/** Lowercased label used to pick a mode's colour, icon and placeholder. */
function getModeStyleKey(mode: AgentMode): string {
  const label = getModeDisplayName(mode).toLowerCase();
  return MODE_STYLE_ALIASES[label] ?? label;
}

/** Return the active-state text colour class for a mode segment. */
function getModeColor(mode: AgentMode, index: number): string {
  // Active segment tint: icon + label pick up the mode hue on a raised chip.
  const label = getModeStyleKey(mode);
  if (label === "default" || label === "manual" || label === "interactive" || label === "build") return "text-indigo-600 dark:text-indigo-300";
  if (label === "plan") return "text-cyan-600 dark:text-cyan-300";
  if (label === "autopilot" || label === "bypass permissions") return "text-emerald-600 dark:text-emerald-300";
  if (label === "accept edits") return "text-amber-600 dark:text-amber-300";
  if (label === "auto") return "text-violet-600 dark:text-violet-300";
  // Fallback by position
  const palette = ["text-indigo-600 dark:text-indigo-300", "text-cyan-600 dark:text-cyan-300", "text-emerald-600 dark:text-emerald-300"];
  if (index < palette.length) return palette[index];
  return "text-slate-700 dark:text-slate-200";
}

/** Return the composer / send-button accent for the active mode. */
function getModeAccentRing(mode: AgentMode, _index: number): {
  bg: string;
  ring: string;
  border: string;
  bgHover: string;
} {
  const label = getModeStyleKey(mode);
  const base = "bg-[var(--cm-surface)] dark:bg-[var(--cm-surface-2)]";
  if (label === "plan")
    return {
      bg: base,
      ring: "focus-within:ring-4 focus-within:ring-cyan-500/10 focus-within:border-cyan-500/50",
      border: "border-[var(--cm-hairline-strong)]",
      bgHover: "bg-cyan-600 hover:bg-cyan-500 shadow-[0_6px_18px_-6px] shadow-cyan-500/60",
    };
  if (label === "autopilot" || label === "bypass permissions")
    return {
      bg: base,
      ring: "focus-within:ring-4 focus-within:ring-emerald-500/10 focus-within:border-emerald-500/50",
      border: "border-[var(--cm-hairline-strong)]",
      bgHover: "bg-emerald-600 hover:bg-emerald-500 shadow-[0_6px_18px_-6px] shadow-emerald-500/60",
    };
  if (label === "accept edits")
    return {
      bg: base,
      ring: "focus-within:ring-4 focus-within:ring-amber-500/10 focus-within:border-amber-500/50",
      border: "border-[var(--cm-hairline-strong)]",
      bgHover: "bg-amber-600 hover:bg-amber-500 shadow-[0_6px_18px_-6px] shadow-amber-500/60",
    };
  if (label === "auto")
    return {
      bg: base,
      ring: "focus-within:ring-4 focus-within:ring-violet-500/10 focus-within:border-violet-500/50",
      border: "border-[var(--cm-hairline-strong)]",
      bgHover: "bg-violet-600 hover:bg-violet-500 shadow-[0_6px_18px_-6px] shadow-violet-500/60",
    };
  // Default / Interactive / Build / unknown — signature gradient
  return {
    bg: base,
    ring: "focus-within:ring-4 focus-within:ring-indigo-500/10 focus-within:border-indigo-500/50",
    border: "border-[var(--cm-hairline-strong)]",
    bgHover: "cm-btn-primary",
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
  // 2 — zap / autonomous
  () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
];

// Icons for Claude Code's additional permission modes
const EXTRA_MODE_ICONS: Record<string, () => any> = {
  // pencil — accept edits
  "accept edits": () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  ),
  // sparkles — auto (classifier)
  auto: () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </svg>
  ),
};

function getModeIcon(mode: AgentMode, index: number) {
  const label = getModeStyleKey(mode);
  if (EXTRA_MODE_ICONS[label]) return EXTRA_MODE_ICONS[label]();
  if (label === "default" || label === "manual" || label === "interactive" || label === "build") return MODE_ICONS[0]();
  if (label === "plan") return MODE_ICONS[1]();
  if (label === "autopilot" || label === "bypass permissions") return MODE_ICONS[2]();
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
  /** Prevent sending while disconnected without blocking draft editing. */
  sendDisabled?: boolean;
  /** The current Web draft could not be persisted on this device. */
  draftSaveFailed?: boolean;
  /** Whether the current engine supports image attachments */
  imageAttachmentEnabled?: boolean;
  /** Available slash commands from the current engine */
  availableCommands?: EngineCommand[];
  /** Called when user invokes a slash command (instead of onSend) */
  onCommandInvoke?: (commandName: string, args: string, agent: AgentMode) => void;
  /** Controlled text draft for the current session */
  text?: string;
  onTextChange?: (text: string) => void;
  /** Controlled image draft for the current session */
  images?: ImageAttachment[];
  onImagesChange?: (images: ImageAttachment[]) => void;
  /** Toolbar content rendered in the bottom bar (left of send button) */
  toolbarContent?: JSX.Element;
  /** Each new value moves keyboard focus into the textarea once it is enabled. */
  focusRequest?: number;
}

export function PromptInput(props: PromptInputProps) {
  const { t } = useI18n();
  const [internalText, setInternalText] = createSignal("");
  const [textarea, setTextarea] = createSignal<HTMLTextAreaElement>();
  const [internalImages, setInternalImages] = createSignal<ImageAttachment[]>([]);
  const [dragOver, setDragOver] = createSignal(false);
  let fileInputRef: HTMLInputElement | undefined;
  let pasteCounter = 0;

  const text = createMemo(() => props.text ?? internalText());
  const images = createMemo(() => props.images ?? internalImages());

  const setTextValue = (value: string) => {
    if (props.onTextChange) {
      props.onTextChange(value);
    }
    if (props.text === undefined) {
      setInternalText(value);
    }
  };

  const setImagesValue = (
    value: ImageAttachment[] | ((prev: ImageAttachment[]) => ImageAttachment[]),
  ) => {
    const next = typeof value === "function" ? value(images()) : value;
    if (props.onImagesChange) {
      props.onImagesChange(next);
    }
    if (props.images === undefined) {
      setInternalImages(next);
    }
  };

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

  // A request may arrive before the new session enables the input; consume it
  // on the first enabled pass so a later re-enable does not steal focus again.
  let handledFocusRequest = props.focusRequest;
  createEffect(() => {
    const request = props.focusRequest;
    if (!request || request === handledFocusRequest || props.disabled) return;
    handledFocusRequest = request;
    queueMicrotask(() => textarea()?.focus());
  });

  /** Select a command from the autocomplete menu */
  const selectCommand = (cmd: EngineCommand) => {
    setTextValue(`/${cmd.name} `);
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
    const validation = validateImageAddition(
      images().map((img) => ({ size: img.size, mimeType: img.mimeType })),
      { size: file.size, mimeType: file.type },
    );
    if (!validation.ok) {
      const key =
        validation.reason === "mime"
          ? "imageUnsupportedType"
          : validation.reason === "size"
            ? "imageTooLarge"
            : validation.reason === "count"
              ? "imageLimitReached"
              : "imageTotalTooLarge";
      notify(t().prompt[key], "warning", 3000);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      if (!base64) return;
      setImagesValue((prev) => [
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
    setImagesValue((prev) => prev.filter((img) => img.id !== id));
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

  const modes = createMemo<AgentMode[]>(() =>
    props.availableModes && props.availableModes.length > 0
      ? props.availableModes
      : [
          { id: "build", label: t().chat.defaultModeLabel },
          { id: "plan", label: t().prompt.plan },
        ]
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
    text();
    const el = textarea();
    if (!el) return;
    if (!text()) {
      el.style.height = "auto";
      return;
    }
    adjustHeight();
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
        if (cmds.length > 0) setCommandSelectedIndex((i) => (i + 1) % cmds.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (cmds.length > 0) setCommandSelectedIndex((i) => (i - 1 + cmds.length) % cmds.length);
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
      if (hasContent && canSend && !props.disabled && !props.sendDisabled) {
        doSend();
      }
    }
  };

  /** Shared send logic — detects slash command or falls through to normal send */
  const doSend = () => {
    const clearUncontrolledDraft = () => {
      // Controlled drafts are consumed by the caller after send validation.
      if (props.text !== undefined || props.images !== undefined) return;
      setTextValue("");
      setImagesValue([]);
    };
    const trimmed = text().trim();
    // Detect slash command: text starts with / and onCommandInvoke is provided
    if (trimmed.startsWith("/") && props.onCommandInvoke) {
      const spaceIdx = trimmed.indexOf(" ");
      const commandName = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
      if (commandName) {
        props.onCommandInvoke(commandName, args, agent());
        clearUncontrolledDraft();
        return;
      }
    }
    // Normal send
    const imgs = images().length > 0 ? [...images()] : undefined;
    props.onSend(text(), agent(), imgs);
    clearUncontrolledDraft();
  };

  const handleSend = () => {
    const canSend = !props.isGenerating || props.canEnqueue;
    if (!canSend || props.disabled || props.sendDisabled) return;

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
    const label = getModeStyleKey(agent());
    if (label === "plan") return t().prompt.planPlaceholder;
    if (label === "autopilot" || label === "bypass permissions") return t().prompt.autopilotPlaceholder;
    if (label === "build" || label === "interactive" || label === "default" || label === "manual") return t().prompt.buildPlaceholder;
    return t().prompt.placeholder;
  });

  return (
    <div class="w-full max-w-4xl mx-auto">
      {/* Agent selector and Model selector row */}
      <div class="flex items-center justify-between gap-1.5 sm:gap-2 mb-2 flex-wrap">
        {/* Agent mode segmented control - left side */}
        <div role="radiogroup" class="inline-flex items-center gap-0.5 p-0.5 rounded-[10px] bg-gray-900/[0.04] dark:bg-white/[0.04] ring-1 ring-inset ring-[var(--cm-hairline)]">
          <For each={modes()}>
            {(mode, index) => {
              const displayName = getModeDisplayName(mode);
              const isActive = () => agent().id === mode.id;
              const color = getModeColor(mode, index());
              const icon = getModeIcon(mode, index());

              return (
                <button
                  role="radio"
                  aria-checked={isActive()}
                  onClick={() => handleAgentChange(mode)}
                  class={`px-2 sm:px-2.5 py-1 text-xs font-medium rounded-lg transition-all flex items-center gap-1 sm:gap-1.5 min-h-[30px] ${
                    isActive()
                      ? `${color} bg-[var(--cm-surface)] dark:bg-white/[0.09] shadow-[var(--cm-shadow-sm)] ring-1 ring-[var(--cm-hairline)]`
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
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
        data-orbit={props.isGenerating ? "" : undefined}
        class={`cm-orbit relative rounded-2xl border shadow-[var(--cm-shadow-md)] transition-[box-shadow,border-color] duration-200 ${activeAccent().bg} ${activeAccent().border} ${activeAccent().ring} ${dragOver() ? "ring-4 ring-blue-500/20 border-blue-500/60 border-dashed" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Slash command autocomplete dropdown */}
        <Show when={showCommandMenu() && filteredCommands().length > 0}>
          <div
            ref={(el) => { commandMenuRef = el; }}
            class="absolute bottom-full left-0 right-0 mb-2 p-1 bg-[var(--cm-surface)] dark:bg-[var(--cm-surface-2)] border border-[var(--cm-hairline-strong)] rounded-xl shadow-[var(--cm-shadow-lg)] backdrop-blur-xl max-h-56 overflow-y-auto z-50"
          >
            <For each={filteredCommands()}>
              {(cmd, index) => (
                <button
                  data-command-item
                  onClick={() => selectCommand(cmd)}
                  onMouseEnter={() => setCommandSelectedIndex(index())}
                  class={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-3 text-sm transition-colors ${
                    commandSelectedIndex() === index()
                      ? "bg-indigo-500/10 text-indigo-700 dark:text-indigo-200"
                      : "text-gray-700 dark:text-gray-300 hover:bg-gray-900/[0.04] dark:hover:bg-white/[0.04]"
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
                <div class="relative flex-shrink-0 w-12 h-12 rounded-lg overflow-hidden bg-slate-200 dark:bg-slate-700 ring-1 ring-[var(--cm-hairline-strong)] group">
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
            setTextValue(e.currentTarget.value);
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
          class={`w-full px-3.5 sm:px-4 pt-3.5 pb-2 bg-transparent resize-none focus:outline-none text-gray-900 dark:text-gray-50 max-h-[120px] sm:max-h-[200px] overflow-y-auto text-[14px] leading-relaxed placeholder:text-gray-400 dark:placeholder:text-gray-500 ${props.disabled ? "cursor-not-allowed opacity-50" : ""}`}
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
        {/* Bottom toolbar: session config (left) + action buttons (right) */}
        <div class="flex items-center justify-between pl-2 pr-2 pb-2 pt-0.5 gap-2">
          {/* Left: toolbar content (model/effort/fast mode) */}
          <div class="flex items-center gap-1.5 overflow-x-auto min-w-0">
            {props.toolbarContent}
          </div>
          {/* Right: attachment + send/stop buttons */}
          {(() => {
            const isGenerating = props.isGenerating;
            const hasContent = !!text().trim() || images().length > 0;
            const showSendButton = !isGenerating || (isGenerating && props.canEnqueue && hasContent);
            const showStopButton = isGenerating && !(props.canEnqueue && hasContent);

            if (showSendButton) {
              return (
                <div class="flex items-center gap-1 flex-shrink-0">
                  <Show when={props.imageAttachmentEnabled}>
                    <button
                      onClick={() => fileInputRef?.click()}
                      disabled={props.disabled || images().length >= MAX_IMAGES_PER_MESSAGE}
                      class="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-900/5 dark:hover:bg-white/5 transition-colors disabled:opacity-30"
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
                    disabled={!hasContent || props.disabled || props.sendDisabled}
                    class={`w-8 h-8 flex items-center justify-center rounded-[10px] text-white transition-all disabled:!bg-none disabled:!bg-gray-900/[0.06] dark:disabled:!bg-white/[0.07] disabled:!text-gray-400 dark:disabled:!text-gray-500 disabled:!shadow-none disabled:!filter-none disabled:!opacity-100 ${activeAccent().bgHover}`}
                    aria-label={t().prompt.send}
                  >
                    <IconArrowUp width={17} height={17} />
                  </button>
                </div>
              );
            }

            if (showStopButton) {
              return (
                <div class="flex items-center flex-shrink-0 relative">
                  <button
                    onClick={() => props.onCancel?.()}
                    class="relative w-8 h-8 flex items-center justify-center rounded-[10px] bg-gray-900 hover:bg-gray-800 dark:bg-white dark:hover:bg-gray-200 text-white dark:text-gray-900 transition-all shadow-[var(--cm-shadow-md)] ring-1 ring-inset ring-white/10"
                    aria-label="Stop"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="5" y="5" width="14" height="14" rx="3" />
                    </svg>
                    {/* Queue count badge */}
                    <Show when={(props.queueCount ?? 0) > 0}>
                      <span class="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] flex items-center justify-center px-1 text-[10px] font-bold bg-amber-500 text-white rounded-full shadow-sm">
                        {props.queueCount}
                      </span>
                    </Show>
                  </button>
                </div>
              );
            }

            return null;
          })()}
        </div>
      </div>
      <Show when={isBrowser() && props.draftSaveFailed} fallback={
        <Show when={isBrowser() && images().length > 0}>
          <p class="mt-1.5 px-1 text-xs text-slate-500 dark:text-slate-400" role="status">{t().prompt.draftImagesNotSaved}</p>
        </Show>
      }>
        <p class="mt-1.5 px-1 text-xs text-amber-700 dark:text-amber-400" role="status">{t().prompt.draftSaveFailed}</p>
      </Show>
    </div>
  );
}
