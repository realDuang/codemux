import {
  createMemo,
  createSignal,
  createEffect,
  For,
  Index,
  Show,
  Suspense,
  onCleanup,
  onMount,
} from "solid-js";
import { messageStore, isExpanded, setExpanded, toggleExpanded } from "../stores/message";
import { Part, PartProps, ProviderIcon, PermissionPrompt, QuestionPrompt } from "./share/part";
import { ContextGroup, CONTEXT_TOOLS, type ContextGroupItem } from "./ContextGroup";
import { ContentError } from "./share/content-error";
import { TextShimmer } from "./share/TextShimmer";
import { TextReveal } from "./share/TextReveal";
import { IconSparkles } from "./icons";
import { useI18n } from "../lib/i18n";
import type { UnifiedMessage, UnifiedPart, ToolPart, UnifiedPermission } from "../types/unified";
import styles from "./SessionTurn.module.css";

interface SessionTurnProps {
  sessionID: string;
  userMessage: UnifiedMessage;
  assistantMessages: UnifiedMessage[];
  isLastTurn: boolean;
  isWorking: boolean;
  onPermissionRespond?: (sessionID: string, permissionID: string, reply: string) => void;
  onQuestionRespond?: (sessionID: string, questionID: string, answers: string[][]) => void;
  onQuestionDismiss?: (sessionID: string, questionID: string) => void;
  onContinue?: (sessionID: string) => void;
}

/**
 * Extract file basename from a path string.
 * Handles all engine path formats (filePath, file_path, path).
 */
function extractFileBasename(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const raw = (input.filePath ?? input.file_path ?? input.path) as string | undefined;
  if (typeof raw !== "string" || !raw) return undefined;
  return raw.split(/[/\\]/).pop() || raw;
}

/**
 * Extract a truncated command summary from shell input.
 */
function extractCommandSummary(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const cmd = input.command as string | undefined;
  if (typeof cmd !== "string" || !cmd) return undefined;
  const parts = cmd.trimStart().split(/\s+/).slice(0, 2).join(" ");
  return parts.length > 24 ? parts.slice(0, 23) + "\u2026" : parts;
}

/**
 * Extract a search pattern or query from grep/glob input.
 */
function extractPattern(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const raw = (input.pattern ?? input.query) as string | undefined;
  if (typeof raw !== "string" || !raw) return undefined;
  return raw.length > 20 ? raw.slice(0, 19) + "\u2026" : raw;
}

/**
 * Extract hostname from a URL.
 */
function extractHostname(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const url = input.url as string | undefined;
  if (typeof url !== "string" || !url) return undefined;
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url.length > 24 ? url.slice(0, 23) + "\u2026" : url;
  }
}

/**
 * Extract task description.
 */
function extractDescription(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const desc = input.description as string | undefined;
  if (typeof desc !== "string" || !desc) return undefined;
  return desc.length > 30 ? desc.slice(0, 29) + "\u2026" : desc;
}

/**
 * Append a detail string to a base status label with a separator.
 */
function withDetail(base: string, detail: string | undefined): string {
  return detail ? `${base} · ${detail}` : base;
}

/**
 * Compute status text from the current part being processed.
 * Extracts specific details (filenames, commands, patterns) from tool input
 * for a richer status display across all engine types.
 */
function computeStatusFromPart(
  part: UnifiedPart | undefined,
  t: () => any
): string | undefined {
  if (!part) return undefined;

  if (part.type === "tool") {
    const tp = part as ToolPart;
    const input = tp.state?.input as Record<string, unknown> | undefined;

    let base: string;
    let detail: string | undefined;

    switch (tp.normalizedTool) {
      case "task":
        base = t().steps.delegatingWork;
        detail = extractDescription(input);
        break;
      case "todo":
        return t().steps.planningNextSteps;
      case "read":
        base = t().steps.gatheringContext;
        detail = extractFileBasename(input);
        break;
      case "list":
        base = t().steps.searchingCodebase;
        detail = extractFileBasename(input);
        break;
      case "grep":
      case "glob":
        base = t().steps.searchingCodebase;
        detail = extractPattern(input);
        break;
      case "web_fetch":
        base = t().steps.searchingWeb;
        detail = extractHostname(input);
        break;
      case "edit":
      case "write":
        base = t().steps.makingEdits;
        detail = extractFileBasename(input);
        break;
      case "shell":
        base = t().steps.runningCommands;
        detail = extractCommandSummary(input);
        break;
      default:
        // For unknown tools, use the adapter-generated title directly
        return tp.title || tp.originalTool;
    }

    // If input extraction failed, fall back to adapter-generated title
    if (!detail && tp.title && tp.title !== tp.originalTool) {
      return tp.title;
    }
    return withDetail(base, detail);
  }
  if (part.type === "reasoning") {
    const text = (part as any).text ?? "";
    const match = text.trimStart().match(/^\*\*(.+?)\*\*/);
    if (match) return `${t().parts.thinking} · ${match[1].trim()}`;
    return t().parts.thinking;
  }
  if (part.type === "text") {
    return t().steps.gatheringThoughts;
  }
  return undefined;
}

/**
 * Format duration in human-readable format
 */
function formatDuration(startTime: number, endTime?: number): string {
  const end = endTime ?? Date.now();
  const diff = Math.max(0, end - startTime);
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/** Lazy wrapper for Part — uses IntersectionObserver to defer rendering of off-screen parts. */
function LazyPart(props: PartProps & { isNearEnd: boolean }) {
  // Always render immediately if near end of list (for auto-scroll)
  const [visible, setVisible] = createSignal(props.isNearEnd);
  let ref!: HTMLDivElement;

  onMount(() => {
    if (visible()) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(ref);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div ref={ref} style={{ "min-height": visible() ? undefined : "40px" }}>
      <Show when={visible()}>
        <Part
          last={props.last}
          part={props.part}
          index={props.index}
          message={props.message}
          isStreaming={props.isStreaming}
          permission={props.permission}
          onPermissionRespond={props.onPermissionRespond}
          question={props.question}
          onQuestionRespond={props.onQuestionRespond}
          onQuestionDismiss={props.onQuestionDismiss}
        />
      </Show>
    </div>
  );
}

/**
 * Extract a reasoning heading from markdown text.
 * Looks for H1-H6 headings, setext headings, or **bold** first lines.
 */
function extractReasoningHeading(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trimStart();
  // Markdown ATX headings: # Heading
  const atx = trimmed.match(/^#{1,3}\s+(.+)$/m);
  if (atx) {
    const h = atx[1].trim();
    return h.length > 50 ? h.slice(0, 49) + "\u2026" : h;
  }
  // **Bold** first line
  const bold = trimmed.match(/^\*\*(.+?)\*\*/);
  if (bold) {
    const h = bold[1].trim();
    return h.length > 50 ? h.slice(0, 49) + "\u2026" : h;
  }
  return undefined;
}

export function SessionTurn(props: SessionTurnProps) {
  const { t } = useI18n();
  
  const stepsExpandedKey = () => `steps-${props.userMessage.id}`;
  const stepsExpanded = () => isExpanded(stepsExpandedKey());
  const handleStepsToggle = () => toggleExpanded(stepsExpandedKey());

  // Auto-expand steps panel when AI starts working (last turn only).
  // Only auto-expand once per turn to respect manual user collapse.
  let hasAutoExpanded = false;
  createEffect(() => {
    if (props.isWorking && !hasAutoExpanded) {
      setExpanded(stepsExpandedKey(), true);
      hasAutoExpanded = true;
    }
  });

  const isCompactingTurn = createMemo(() => {
    for (const msg of props.assistantMessages) {
      if (msg.isCompaction || msg.mode === "compaction") {
        return true;
      }
    }
    return false;
  });

  // Get user message parts
  const userParts = createMemo(
    () => messageStore.part[props.userMessage.id] || []
  );

  // Get pending permissions for this session
  const permissions = createMemo(
    () => messageStore.permission[props.sessionID] || []
  );

  // Pre-computed lookup maps for O(1) permission matching.
  // Build callId→permission and command→permission maps once, reuse everywhere.
  const permissionByCallId = createMemo(() => {
    const map = new Map<string, UnifiedPermission>();
    for (const p of permissions()) {
      if (p.toolCallId) map.set(p.toolCallId, p);
    }
    return map;
  });

  const permissionByCommand = createMemo(() => {
    const map = new Map<string, UnifiedPermission>();
    for (const p of permissions()) {
      const ri = p.rawInput as any;
      if (ri?.command) map.set(ri.command, p);
      if (ri?.commands) {
        for (const cmd of ri.commands) map.set(cmd, p);
      }
    }
    return map;
  });

  // Collect all tool callIds across assistant messages (for unmatched-permission detection)
  const allToolCallIds = createMemo(() => {
    const ids = new Set<string>();
    for (const msg of props.assistantMessages) {
      const parts = messageStore.part[msg.id] || [];
      for (const p of parts) {
        if (p.type === "tool" && (p as ToolPart).callId) {
          ids.add((p as ToolPart).callId);
        }
      }
    }
    return ids;
  });

  // Get permission for a specific tool part (by callId) — O(1) lookup.
  // Some agents (e.g. Copilot CLI) use a different toolCallId in the
  // permission request than in the tool_call notification, so we also
  // match by rawInput command against a pending/running tool part.
  const getPermissionForPart = (part: UnifiedPart) => {
    if (part.type !== "tool") return undefined;
    const tp = part as ToolPart;
    // Direct match by callId — O(1)
    const direct = permissionByCallId().get(tp.callId);
    if (direct) return direct;
    // Fallback: match by rawInput command against a pending/running tool — O(1)
    if (tp.state.status === "pending" || tp.state.status === "running") {
      const cmd = (tp.state as any).input?.command;
      if (cmd) {
        const byCmd = permissionByCommand().get(cmd);
        if (byCmd) return byCmd;
      }
      // Last resort: if there's only one unmatched permission and this is
      // the only pending/running tool, assume they belong together.
      const toolIds = allToolCallIds();
      const unmatchedPerms = permissions().filter(p => !p.toolCallId || !toolIds.has(p.toolCallId));
      if (unmatchedPerms.length === 1) return unmatchedPerms[0];
    }
    return undefined;
  };

  // Get permissions that don't match any tool part (need standalone rendering)
  const unmatchedPermissions = createMemo(() => {
    const matched = new Set<string>();
    for (const msg of props.assistantMessages) {
      const parts = messageStore.part[msg.id] || [];
      for (const p of parts) {
        if (p.type !== "tool") continue;
        const perm = getPermissionForPart(p);
        if (perm) matched.add(perm.id);
      }
    }
    return permissions().filter(p => !matched.has(p.id));
  });

  // Get pending questions for this session
  const questions = createMemo(
    () => messageStore.question[props.sessionID] || []
  );

  // Pre-computed lookup map for O(1) question matching by callId.
  const questionByCallId = createMemo(() => {
    const map = new Map<string, typeof questions extends () => (infer T)[] ? T : never>();
    for (const q of questions()) {
      if (q.toolCallId) map.set(q.toolCallId, q);
    }
    return map;
  });

  // Get question for a specific tool part (by callId) — O(1) lookup.
  const getQuestionForPart = (part: UnifiedPart) => {
    if (part.type !== "tool") return undefined;
    const tp = part as ToolPart;
    // Direct match by callId — O(1)
    const direct = questionByCallId().get(tp.callId);
    if (direct) return direct;
    // Fallback: if there's only one unmatched question and this is the only pending/running tool
    if (tp.state.status === "pending" || tp.state.status === "running") {
      const toolIds = allToolCallIds();
      const unmatchedQs = questions().filter(q => !q.toolCallId || !toolIds.has(q.toolCallId));
      if (unmatchedQs.length === 1) return unmatchedQs[0];
    }
    return undefined;
  };

  // Get questions that don't match any tool part (need standalone rendering)
  const unmatchedQuestions = createMemo(() => {
    const matched = new Set<string>();
    for (const msg of props.assistantMessages) {
      const parts = messageStore.part[msg.id] || [];
      for (const p of parts) {
        if (p.type !== "tool") continue;
        const q = getQuestionForPart(p);
        if (q) matched.add(q.id);
      }
    }
    return questions().filter(q => !matched.has(q.id));
  });

  // Check if there are any step parts (tool, reasoning, step-start, etc.)
  const hasSteps = createMemo(() => {
    for (const assistantMsg of props.assistantMessages) {
      const parts = messageStore.part[assistantMsg.id] || [];
      for (const p of parts) {
        if (p?.type === "reasoning") return true;
        // Todo tools are hidden from steps (shown in TodoDock)
        if (p?.type === "tool" && (p as ToolPart).normalizedTool !== "todo") return true;
      }
    }
    return false;
  });

  // Get the last text part from assistant messages (the response)
  const lastTextPart = createMemo(() => {
    const msgs = props.assistantMessages;
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const msgParts = messageStore.part[msgs[mi].id] || [];
      for (let pi = msgParts.length - 1; pi >= 0; pi--) {
        const part = msgParts[pi];
        if (part?.type === "text") return part;
      }
    }
    return undefined;
  });

  // Get the latest text part during streaming (for live response area)
  const streamingTextPart = createMemo(() => {
    if (!props.isWorking) return undefined;
    const msgs = props.assistantMessages;
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const msgParts = messageStore.part[msgs[mi].id] || [];
      for (let pi = msgParts.length - 1; pi >= 0; pi--) {
        const part = msgParts[pi];
        if (part?.type === "text" && (part as any).text) return part;
      }
    }
    return undefined;
  });

  // Detect if reasoning is the active part (for trigger bar pulse dot)
  const isReasoningActive = createMemo(() => {
    if (!props.isWorking) return false;
    const msgs = props.assistantMessages;
    if (msgs.length === 0) return false;
    const lastMsg = msgs[msgs.length - 1];
    const parts = messageStore.part[lastMsg.id] || [];
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i]?.type === "reasoning") return true;
      if (parts[i]?.type === "tool") return false;
    }
    return false;
  });

  // Extract heading from the latest reasoning part for the trigger bar subtitle
  const reasoningHeading = createMemo(() => {
    if (!props.isWorking) return undefined;
    const msgs = props.assistantMessages;
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const parts = messageStore.part[msgs[mi].id] || [];
      for (let pi = parts.length - 1; pi >= 0; pi--) {
        const p = parts[pi];
        if (p?.type === "reasoning") {
          return extractReasoningHeading((p as any).text);
        }
      }
    }
    return undefined;
  });

  // Last assistant message ID (for streaming detection)
  const lastAssistantMsgId = () => {
    const msgs = props.assistantMessages;
    return msgs.length > 0 ? msgs[msgs.length - 1].id : undefined;
  };

  // Detect error/cancelled state from the last assistant message
  const lastMessageError = createMemo(() => {
    const msgs = props.assistantMessages;
    if (msgs.length === 0) return undefined;
    return msgs[msgs.length - 1].error;
  });

  // Compute current working status
  const currentStatus = createMemo(() => {
    if (!props.isWorking) return undefined;

    const msgs = props.assistantMessages;
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const msgParts = messageStore.part[msgs[mi].id] || [];
      for (let pi = msgParts.length - 1; pi >= 0; pi--) {
        const part = msgParts[pi];
        if (part) {
          const status = computeStatusFromPart(part, t);
          if (status) return status;
        }
      }
    }
    return t().steps.consideringNextSteps;
  });

  // Compute duration — live-ticking while no final endTime, static when done.
  // Use a self-contained timer that doesn't depend on isWorking prop for ticking,
  // since isWorking reactivity can be lost through Index/prop chain.
  const [tick, setTick] = createSignal(Date.now());

  const finalEndTime = createMemo(() => {
    // Only trust time.completed when isWorking is false — during multi-step
    // tasks, intermediate messages may carry completed timestamps prematurely.
    if (props.isWorking) return undefined;
    const lastAssistant = props.assistantMessages.at(-1);
    return lastAssistant?.time?.completed;
  });

  createEffect(() => {
    if (finalEndTime()) return; // Already completed, no timer needed
    const tickTimer = setInterval(() => {
      setTick(Date.now());
    }, 1000);
    onCleanup(() => clearInterval(tickTimer));
  });

  const duration = createMemo(() => {
    const startTime = props.userMessage.time.created;
    const endTime = finalEndTime();
    if (endTime) return formatDuration(startTime, endTime);
    const _ = tick(); // subscribe to tick signal for live updates
    return formatDuration(startTime, Date.now());
  });

  // Get model info from the first assistant message
  const modelInfo = createMemo(() => {
    const firstAssistant = props.assistantMessages[0];
    if (firstAssistant) {
      return {
        providerID: firstAssistant.providerId,
        modelID: firstAssistant.modelId,
      };
    }
    return undefined;
  });

  // Filter parts for display
  const filterParts = (allParts: UnifiedPart[], messageRole: string) => {
    if (messageRole !== "assistant") {
      // For non-assistant messages, just filter
      return allParts.filter((x) => {
        if (!x) return false;
        // Filter out all step-start, model info will be shown in header
        if (x.type === "step-start") return false;
        if (x.type === "snapshot") return false;
        if (x.type === "patch") return false;
        if (x.type === "step-finish") return false;
        if (x.type === "text" && (x as any).synthetic === true) return false;
        // Hide all todo tools (todowrite/todoread) — displayed in TodoDock instead
        if (x.type === "tool" && (x as ToolPart).normalizedTool === "todo") return false;
        if (x.type === "text" && !(x as any).text) return false;
        // Hide pending/running tools when not working
        if (
          x.type === "tool" &&
          !props.isWorking &&
          ((x as any).state?.status === "pending" ||
            (x as any).state?.status === "running")
        ) {
          return false;
        }
        // Hide pending/running permission/question tools — input area handles interaction
        if (
          x.type === "tool" &&
          ((x as any).state?.status === "pending" ||
            (x as any).state?.status === "running")
        ) {
          const tp = x as ToolPart;
          const hasPerm = permissionByCallId().has(tp.callId);
          const hasQ = questionByCallId().has(tp.callId);
          if (hasPerm || hasQ) return false;
        }
        return true;
      });
    }

    // Filter assistant message parts — same logic, preserve original order
    const filtered: UnifiedPart[] = [];

    for (const x of allParts) {
      if (!x) continue;
      // Filter out all step-start, model info will be shown in header
      if (x.type === "step-start") continue;
      if (x.type === "snapshot") continue;
      if (x.type === "patch") continue;
      if (x.type === "step-finish") continue;
      if (x.type === "text" && (x as any).synthetic === true) continue;
      // Hide all todo tools (todowrite/todoread) — displayed in TodoDock instead
      if (x.type === "tool" && (x as ToolPart).normalizedTool === "todo") continue;
      if (x.type === "text" && !(x as any).text) continue;
      // Hide pending/running tools when not working
      if (
        x.type === "tool" &&
        !props.isWorking &&
        ((x as any).state?.status === "pending" ||
          (x as any).state?.status === "running")
      ) {
        continue;
      }
      // Hide pending/running permission/question tools — input area handles interaction
      if (
        x.type === "tool" &&
        ((x as any).state?.status === "pending" ||
          (x as any).state?.status === "running")
      ) {
        const tp = x as ToolPart;
        const hasPerm = permissionByCallId().has(tp.callId);
        const hasQ = questionByCallId().has(tp.callId);
        if (hasPerm || hasQ) continue;
      }

      filtered.push(x);
    }

    return filtered;
  };

  // Filter user message parts
  const filteredUserParts = createMemo(() =>
    filterParts(userParts(), "user")
  );

  // Get all steps parts (for expanded view)
  const allStepsParts = createMemo(() => {
    const result: { message: UnifiedMessage; parts: UnifiedPart[] }[] = [];
    for (const msg of props.assistantMessages) {
      const parts = messageStore.part[msg.id] || [];
      const filtered = filterParts(parts, "assistant");
      // Filter out the text part displayed in response area (both streaming and completed)
      const responseText = props.isWorking ? streamingTextPart() : lastTextPart();
      const stepsFiltered = responseText
        ? filtered.filter((p) => p.id !== responseText.id)
        : filtered;
      if (stepsFiltered.length > 0) {
        result.push({ message: msg, parts: stepsFiltered });
      }
    }
    return result;
  });

  // Build grouped render items: consecutive context tools (read/grep/glob/list) are collapsed
  // into ContextGroup cards. Other parts render individually.
  type RenderItem =
    | { kind: "part"; part: UnifiedPart; index: number; message: UnifiedMessage }
    | { kind: "context-group"; items: ContextGroupItem[]; isStreaming: boolean; isLast: boolean };

  const groupedRenderItems = createMemo(() => {
    const result: RenderItem[] = [];
    const stepsParts = allStepsParts();

    for (const item of stepsParts) {
      let contextBuf: ContextGroupItem[] = [];
      const isLastMsg = item.message.id === lastAssistantMsgId();

      const flushContext = (isStreamingTail: boolean) => {
        if (contextBuf.length === 0) return;
        // Only group if 2+ consecutive context tools
        if (contextBuf.length >= 2) {
          result.push({
            kind: "context-group",
            items: [...contextBuf],
            isStreaming: isStreamingTail,
            isLast: isStreamingTail,
          });
        } else {
          // Single context tool → render as normal part
          for (const c of contextBuf) {
            result.push({
              kind: "part",
              part: c.part as unknown as UnifiedPart,
              index: item.parts.indexOf(c.part as unknown as UnifiedPart),
              message: item.message,
            });
          }
        }
        contextBuf = [];
      };

      for (let pi = 0; pi < item.parts.length; pi++) {
        const p = item.parts[pi];

        if (p.type === "tool" && CONTEXT_TOOLS.has((p as ToolPart).normalizedTool)) {
          const tp = p as ToolPart;
          const input = (tp.state as any)?.input as Record<string, unknown> | undefined;

          let action: string = tp.normalizedTool;
          let detail = "";
          switch (tp.normalizedTool) {
            case "read":
              action = "Read";
              detail = extractFileBasename(input) || "";
              break;
            case "grep":
              action = "Grep";
              detail = extractPattern(input) || "";
              break;
            case "glob":
              action = "Glob";
              detail = extractPattern(input) || "";
              break;
            case "list":
              action = "LS";
              detail = extractFileBasename(input) || "";
              break;
          }
          contextBuf.push({ part: tp, action, detail });
        } else {
          // Non-context tool: flush any accumulated context group
          const isTail = isLastMsg && pi === item.parts.length - 1 && props.isWorking;
          flushContext(false);
          result.push({ kind: "part", part: p, index: pi, message: item.message });
        }
      }

      // Flush remaining context buffer at end of message parts
      const isStreamingTail = isLastMsg && props.isWorking;
      flushContext(isStreamingTail);
    }
    return result;
  });

  return (
    <div class={styles.sessionTurn} data-component="session-turn" data-compacting={isCompactingTurn() ? "" : undefined}>
      {/* Compacting Turn - Show simplified UI */}
      <Show when={isCompactingTurn()} fallback={
        <>
          {/* User Message - Only show when there are displayable parts */}
          <Show when={filteredUserParts().length > 0}>
            <div class={styles.userMessage}>
              <Index each={filteredUserParts()}>
                {(part, partIndex) => (
                  <Part
                    last={props.isLastTurn && filteredUserParts().length === partIndex + 1}
                    part={part()}
                    index={partIndex}
                    message={props.userMessage}
                  />
                )}
              </Index>
            </div>
          </Show>

          {/* Steps Trigger - Show when working or has steps */}
          <Show when={props.isWorking || hasSteps()}>
            <div class={styles.stepsTrigger}>
              <button
                type="button"
                class={styles.stepsTriggerButton}
                onClick={handleStepsToggle}
                data-working={props.isWorking ? "" : undefined}
              >
                {/* Handoff wrap: thinking layer ↔ meta layer with blur/fade transition */}
                <span class={styles.handoffWrap}>
                  {/* Thinking layer (working state) */}
                  <span
                    class={styles.handoffThinking}
                    data-visible={props.isWorking ? "true" : "false"}
                  >
                    <span
                      class={styles.workingDot}
                      data-phase={isReasoningActive() ? "reasoning" : "tool"}
                    />
                    <span class={styles.statusText}>
                      <Show
                        when={isReasoningActive()}
                        fallback={
                          <TextReveal
                            text={currentStatus() || ""}
                            class={styles.statusReveal}
                            travel={12}
                            duration={250}
                            truncate
                          />
                        }
                      >
                        <TextShimmer
                          text={t().parts.thinking}
                          active={true}
                          class={styles.statusShimmer}
                        />
                        <Show when={reasoningHeading()}>
                          <span class={styles.statusDivider}>·</span>
                          <TextReveal
                            text={reasoningHeading()!}
                            class={styles.statusHeading}
                            travel={8}
                            duration={300}
                            truncate
                          />
                        </Show>
                      </Show>
                    </span>
                  </span>

                  {/* Meta layer (completed state) */}
                  <span
                    class={styles.handoffMeta}
                    data-visible={!props.isWorking ? "true" : "false"}
                  >
                    <Show when={modelInfo()?.modelID}>
                      <span class={styles.modelIcon} title={`${modelInfo()?.providerID} / ${modelInfo()?.modelID}`}>
                        <ProviderIcon model={modelInfo()?.modelID || ""} size={14} />
                      </span>
                    </Show>
                    <span class={styles.statusText}>
                      {stepsExpanded() ? t().steps.hideSteps : t().steps.showSteps}
                    </span>
                  </span>
                </span>

                {/* Duration */}
                <span class={styles.separator}>·</span>
                <span class={styles.duration}>{duration()}</span>

                {/* Expand/Collapse arrow */}
                <Show when={props.assistantMessages.length > 0}>
                  <span
                    class={styles.arrow}
                    data-expanded={stepsExpanded() ? "" : undefined}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </span>
                </Show>
              </button>
            </div>
          </Show>

          {/* Expanded Steps Content */}
          <Show when={stepsExpanded() && groupedRenderItems().length > 0}>
            <div class={styles.stepsContent}>
              <div class={styles.assistantMessageParts}>
                <Suspense>
                  <For each={groupedRenderItems()}>
                    {(renderItem) => {
                      if (renderItem.kind === "context-group") {
                        return (
                          <ContextGroup
                            items={renderItem.items}
                            isStreaming={renderItem.isStreaming}
                            defaultOpen={renderItem.isStreaming}
                          />
                        );
                      }

                      // Regular part rendering
                      const ri = renderItem;
                      const lastReasoningIdx = () => {
                        const msgParts = messageStore.part[ri.message.id] || [];
                        return msgParts.reduce(
                          (acc: number, pp, i) => (pp.type === "reasoning" ? i : acc),
                          -1
                        );
                      };

                      const isPartStreaming = () =>
                        props.isWorking &&
                        ri.part.type === "reasoning" &&
                        ri.message.id === lastAssistantMsgId() &&
                        ri.index === lastReasoningIdx();

                      const partProps = {
                        get last() { return false as const; },
                        get part() { return ri.part; },
                        get index() { return ri.index; },
                        get message() { return ri.message; },
                        get isStreaming() { return isPartStreaming(); },
                        get permission() { return getPermissionForPart(ri.part); },
                        get onPermissionRespond() { return props.onPermissionRespond; },
                        get question() { return getQuestionForPart(ri.part); },
                        get onQuestionRespond() { return props.onQuestionRespond; },
                        get onQuestionDismiss() { return props.onQuestionDismiss; },
                      };

                      return <Part {...partProps} />;
                    }}
                  </For>
                </Suspense>
              </div>
            </div>
            {/* Render unmatched permissions that couldn't be associated with any tool part */}
            <For each={unmatchedPermissions()}>
              {(perm) => (
                <PermissionPrompt
                  permission={perm}
                  onRespond={props.onPermissionRespond}
                />
              )}
            </For>
            {/* Render unmatched questions that couldn't be associated with any tool part */}
            <For each={unmatchedQuestions()}>
              {(q) => (
                <QuestionPrompt
                  question={q}
                  onRespond={props.onQuestionRespond}
                  onDismiss={props.onQuestionDismiss}
                />
              )}
            </For>
          </Show>

          {/* Permission/Question prompts removed from steps —
              they are handled by the input area (Chat.tsx) */}

          {/* Streaming Response (live text during working) */}
          <Show when={props.isWorking && streamingTextPart()}>
            <div class={styles.response}>
              <div class={styles.responseHeader}>
                <h3 class={styles.responseTitle}>
                  <span class={styles.responseIcon}><IconSparkles width={14} height={14} /></span>
                  {t().steps.response}
                </h3>
              </div>
              <div class={styles.responseContent}>
                <Part
                  last={true}
                  part={streamingTextPart()!}
                  index={0}
                  message={props.assistantMessages.at(-1)!}
                  isStreaming={true}
                />
              </div>
            </div>
          </Show>

          {/* Response (last text part) - Always show when not working and has response */}
          <Show when={!props.isWorking && lastTextPart()}>
            <div class={styles.response}>
              <div class={styles.responseHeader}>
                <h3 class={styles.responseTitle}>
                  <span class={styles.responseIcon}><IconSparkles width={14} height={14} /></span>
                  {t().steps.response}
                </h3>
              </div>
              <div class={styles.responseContent}>
                <Part
                  last={true}
                  part={lastTextPart()!}
                  index={0}
                  message={props.assistantMessages.at(-1)!}
                />
              </div>
            </div>
          </Show>

          {/* Error/Cancelled Banner */}
          <Show when={!props.isWorking && lastMessageError()}>
            {(_) => {
              const isCancelled = () => lastMessageError() === "Cancelled";
              const variant = () => isCancelled() ? "cancelled" : "error";
              return (
                <div class={styles.errorBanner} data-variant={variant()}>
                  <div class={styles.errorBannerHeader}>
                    <span class={styles.errorBannerIcon}>
                      <Show when={isCancelled()} fallback={
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <circle cx="12" cy="12" r="10" />
                          <path d="m15 9-6 6" />
                          <path d="m9 9 6 6" />
                        </svg>
                      }>
                        {/* Triangle warning icon for cancelled */}
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
                          <path d="M12 9v4" />
                          <path d="M12 17h.01" />
                        </svg>
                      </Show>
                    </span>
                    <h3 class={styles.errorBannerTitle}>
                      {isCancelled() ? t().steps.cancelled : t().steps.errorOccurred}
                    </h3>
                    {/* Continue button for cancelled state */}
                    <Show when={isCancelled() && props.isLastTurn && props.onContinue}>
                      <button
                        type="button"
                        class={styles.continueButton}
                        onClick={() => props.onContinue?.(props.sessionID)}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <polygon points="6 3 20 12 6 21 6 3" />
                        </svg>
                        {t().steps.continueWork}
                      </button>
                    </Show>
                  </div>
                  <Show when={!isCancelled()}>
                    <div class={styles.errorBannerContent}>
                      <ContentError>{lastMessageError()}</ContentError>
                    </div>
                  </Show>
                </div>
              );
            }}
          </Show>
        </>
      }>
        {/* Compacting Turn - Simplified view */}
        <div class={styles.compactingTurn}>
          <span class={styles.compactingIcon}>📊</span>
          <span class={styles.compactingText}>
            {props.isWorking ? t().steps.organizingContext : t().steps.contextOrganized}
          </span>
          <span class={styles.separator}>·</span>
          <span class={styles.duration}>{duration()}</span>
        </div>
      </Show>
    </div>
  );
}
