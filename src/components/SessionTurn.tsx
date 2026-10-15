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
import { messageStore, setMessageStore, isExpanded, setExpanded, toggleExpanded } from "../stores/message";
import { Part, PartProps, ProviderIcon, PermissionPrompt, QuestionPrompt } from "./share/part";
import { ContextGroup, CONTEXT_TOOLS, type ContextGroupItem } from "./ContextGroup";
import { ToolActivityGroup } from "./ToolActivityGroup";
import { ContentError } from "./share/content-error";
import { TextShimmer } from "./share/TextShimmer";
import { TextReveal } from "./share/TextReveal";
import { useI18n } from "../lib/i18n";
import { logger } from "../lib/logger";
import { gateway } from "../lib/gateway-api";
import { compareParts, groupCompactTurnParts, groupTurnParts, selectFinalResponseParts, selectResponseParts, shouldHideUnfinishedTool, type CompactTurnSegment, type TurnPart } from "../lib/message-parts";
import type { UnifiedMessage, UnifiedPart, TextPart, ToolPart, UnifiedPermission } from "../types/unified";
import { TokenUsage } from "./TokenUsage";
import styles from "./SessionTurn.module.css";

interface SessionTurnProps {
  sessionID: string;
  userMessage: UnifiedMessage;
  assistantMessages: UnifiedMessage[];
  isLastTurn: boolean;
  isWorking: boolean;
  compactActivityGroups?: boolean;
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
      case "task": {
        base = t().steps.delegatingWork;
        const currentTool = (input?._currentTool ?? input?._lastToolName) as string | undefined;
        const desc = extractDescription(input);
        detail = currentTool && desc ? `${desc} (${currentTool})` : (desc ?? currentTool);
        break;
      }
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
 * Looks for ATX headings (H1-H3) or **bold** first lines.
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

interface ActivitySegmentTriggerProps {
  controlsId: string;
  expanded: boolean;
  working: boolean;
  hasError: boolean;
  status: string;
  onToggle: () => void;
}

function ActivitySegmentTrigger(props: ActivitySegmentTriggerProps) {
  const { t } = useI18n();
  const [visibleStatus, setVisibleStatus] = createSignal(props.status);
  let lastStatusChange = Date.now();

  // Keep active titles readable while tool/reasoning events arrive in quick succession.
  // Completion bypasses this delay through the working prop below.
  createEffect(() => {
    const next = props.status;
    if (!props.working) {
      setVisibleStatus(next);
      lastStatusChange = Date.now();
      return;
    }
    if (next === visibleStatus()) return;
    const delay = Math.max(0, 1000 - (Date.now() - lastStatusChange));
    const update = () => {
      setVisibleStatus(next);
      lastStatusChange = Date.now();
    };
    if (delay === 0) update();
    else {
      const timer = setTimeout(update, delay);
      onCleanup(() => clearTimeout(timer));
    }
  });

  return (
    <div class={styles.stepsTrigger} data-component="activity-segment-trigger">
      <button
        type="button"
        class={styles.stepsTriggerButton}
        onClick={props.onToggle}
        aria-expanded={props.expanded}
        aria-controls={props.controlsId}
        data-working={props.working ? "" : undefined}
      >
        <Show when={props.working}>
          <span class={styles.workingDot} />
        </Show>
        <span class={styles.statusText}>
          <Show when={props.working} fallback={props.expanded ? t().steps.hideSteps : t().steps.showSteps}>
            <TextReveal text={visibleStatus()} class={styles.statusReveal} travel={12} duration={250} truncate />
          </Show>
        </span>
        <Show when={props.hasError}><span class={styles.activityAttention}>{t().common.error}</span></Show>
        <span class={styles.arrow} aria-hidden="true" data-expanded={props.expanded ? "" : undefined}>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
    </div>
  );
}

export function SessionTurn(props: SessionTurnProps) {
  const { t } = useI18n();
  const [observedWorking, setObservedWorking] = createSignal(false);
  createEffect(() => { if (props.isWorking) setObservedWorking(true); });
  
  const stepsExpandedKey = () => `steps-${props.userMessage.id}`;
  const stepsExpanded = () => props.compactActivityGroups
    ? messageStore.expanded[stepsExpandedKey()] ?? props.isWorking
    : isExpanded(stepsExpandedKey());
  const handleStepsToggle = () => setExpanded(stepsExpandedKey(), !stepsExpanded());

  // Lazy-load step parts only while the turn's outer disclosure is expanded.
  // Uses a local Set to track in-flight requests, avoiding re-entrant fetches
  // when the effect re-runs due to store updates within the async body.
  const [stepsLoading, setStepsLoading] = createSignal(false);
  const stepsInflight = new Set<string>();
  createEffect(() => {
    if (!stepsExpanded()) return;
    // Only load messages that have steps, aren't loaded, and aren't in-flight
    const toLoad = props.assistantMessages.filter(
      (msg) => (msg.stepCount ?? 0) > 0
        && !messageStore.stepsLoaded[msg.id]
        && !stepsInflight.has(msg.id)
    );
    if (toLoad.length === 0) return;

    for (const msg of toLoad) stepsInflight.add(msg.id);
    setStepsLoading(true);
    Promise.all(
      toLoad.map(async (msg) => {
        try {
          const steps = await gateway.getMessageSteps(props.sessionID, msg.id);
          if (steps.length > 0) {
            const existing = messageStore.part[msg.id] || [];
            const existingIds = new Set(existing.map((p) => p.id));
            const newSteps = steps.filter((s) => !existingIds.has(s.id));
            if (newSteps.length > 0) {
              setMessageStore("part", msg.id, (draft) => {
                const merged = [...(draft || []), ...newSteps];
                merged.sort(compareParts);
                return merged;
              });
            }
          }
          setMessageStore("stepsLoaded", msg.id, true);
        } catch (err) {
          logger.error(`[SessionTurn] Failed to load steps for ${msg.id}:`, err);
          // Don't mark as loaded on failure — allows retry on next expand
        } finally {
          stepsInflight.delete(msg.id);
        }
      })
    ).finally(() => {
      if (stepsInflight.size === 0) setStepsLoading(false);
    });
  });

  // Auto-expand steps panel when AI starts working (last turn only).
  // Only auto-expand once per turn to respect manual user collapse.
  let hasAutoExpanded = false;
  createEffect(() => {
    if (props.isWorking && !props.compactActivityGroups && !hasAutoExpanded) {
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

  // Combined memo: single reverse scan derives all part-scanning state at once.
  // Previously 6 separate memos each scanned the same parts arrays, creating
  // 6× redundant SolidJS subscriptions and 6× the scan work per streaming frame.
  const derivedPartState = createMemo(() => {
    const msgs = props.assistantMessages;
    let hasSteps = false;
    const textParts: { message: UnifiedMessage; part: TextPart; index: number }[] = [];
    let isReasoningActive = false;
    let reasoningHeading: string | null | undefined;
    let currentStatus: string | undefined;

    // Flags to short-circuit: once found, stop searching
    let foundReasoning = false;
    let foundStatus = false;

    // Reverse scan: most recent message first
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const msg = msgs[mi];
      // Check metadata stepCount for historical sessions
      if (!hasSteps && msg.stepCount && msg.stepCount > 0) hasSteps = true;

      const parts = messageStore.part[msg.id] || [];

      for (let pi = parts.length - 1; pi >= 0; pi--) {
        const p = parts[pi];
        if (!p) continue;

        // Progress text remains accessible even when the turn has no tools or reasoning.
        if (!hasSteps) {
          if (p.type === "reasoning" && p.text.trim()) hasSteps = true;
          else if (p.type === "tool" && (p as ToolPart).normalizedTool !== "todo") hasSteps = true;
          else if (p.type === "text" && p.phase === "commentary" && p.text && !p.synthetic) hasSteps = true;
          else if (p.type === "system-notice") hasSteps = true;
        }

        if (p.type === "text") {
          textParts.push({ message: msg, part: p, index: pi });
        }

        // isReasoningActive: only check last message's parts
        if (!foundReasoning && mi === msgs.length - 1 && props.isWorking) {
          if (p.type === "reasoning") {
            isReasoningActive = p.completed !== true && p.time?.end === undefined;
            foundReasoning = true;
          } else if (p.type === "tool" || p.type === "text") {
            foundReasoning = true;
          }
        }

        // reasoningHeading: last reasoning part across all messages (only when working)
        if (reasoningHeading === undefined && props.isWorking && p.type === "reasoning") {
          const heading = extractReasoningHeading(p.text);
          if (heading !== undefined) {
            reasoningHeading = heading ?? null;
          }
        }

        // currentStatus: last part with computable status (only when working)
        if (!foundStatus && props.isWorking) {
          const status = computeStatusFromPart(p, t);
          if (status) {
            currentStatus = status;
            foundStatus = true;
          }
        }
      }
    }

    // Default status when working but no part produced a status
    if (props.isWorking && !foundStatus) {
      currentStatus = t().steps.consideringNextSteps;
    }

    textParts.reverse();
    const responses = new Set(selectResponseParts(textParts.map(({ part }) => part)));
    return {
      hasSteps,
      responseParts: textParts.filter(({ part }) => responses.has(part)),
      isReasoningActive,
      reasoningHeading: reasoningHeading ?? undefined,
      currentStatus,
    };
  });

  // Convenience accessors (unwrap the combined memo for downstream consumers)
  const hasSteps = () => derivedPartState().hasSteps;
  const responseParts = () => derivedPartState().responseParts;
  const isReasoningActive = () => derivedPartState().isReasoningActive;
  const reasoningHeading = () => derivedPartState().reasoningHeading;
  const currentStatus = () => derivedPartState().currentStatus;

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

  // Compute duration — live-ticking while no final endTime, static when done.
  // Use a self-contained timer that doesn't depend on isWorking prop for ticking,
  // since isWorking reactivity can be lost through Index/prop chain.
  const [tick, setTick] = createSignal(Date.now());

  // Safety-net end time: captured once when we first notice the session is done
  // but time.completed is missing (e.g. session.idle event was dropped).
  const [capturedEndTime, setCapturedEndTime] = createSignal<number | undefined>();

  const finalEndTime = createMemo(() => {
    // Only trust time.completed when isWorking is false — during multi-step
    // tasks, intermediate messages may carry completed timestamps prematurely.
    if (props.isWorking) return undefined;
    const lastAssistant = props.assistantMessages.at(-1);
    return lastAssistant?.time?.completed ?? capturedEndTime();
  });

  createEffect(() => {
    if (!props.isWorking && !capturedEndTime()) {
      const lastAssistant = props.assistantMessages.at(-1);
      if (lastAssistant && !lastAssistant.time?.completed) {
        setCapturedEndTime(Date.now());
      }
    }
  });

  createEffect(() => {
    if (finalEndTime()) return; // Already completed, no timer needed
    const tickTimer = setInterval(() => {
      setTick(Date.now());
    }, 1000);
    onCleanup(() => clearInterval(tickTimer));
  });

  const duration = createMemo(() => {
    // For queued messages, processedAt marks when the engine actually started
    // processing (excludes queue wait time). Falls back to time.created.
    const msg = props.userMessage;
    const startTime = msg?.processedAt ?? msg?.time.created ?? Date.now();
    const endTime = finalEndTime();
    if (endTime) return formatDuration(startTime, endTime);
    const _ = tick(); // subscribe to tick signal for live updates
    return formatDuration(startTime, Date.now());
  });

  // Get model info from the first assistant message.
  const modelInfo = createMemo(() => {
    const firstAssistant = props.assistantMessages[0];
    if (firstAssistant) {
      return {
        providerID: firstAssistant.providerId,
        modelID: firstAssistant.modelId,
        reasoningEffort: firstAssistant.reasoningEffort,
      };
    }
    return undefined;
  });

  // Filter parts for display — same rules apply to all message roles
  const filterParts = (allParts: UnifiedPart[], message?: UnifiedMessage) => {
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
      if (x.type === "text" && !(x.displayText ?? x.text)) return false;
      // Stored history can still contain empty reasoning from older adapters.
      if (x.type === "reasoning" && !x.text.trim()) return false;
      if (shouldHideUnfinishedTool(x, props.isWorking, message)) return false;
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
  };

  // Filter user message parts
  const filteredUserParts = createMemo(() =>
    filterParts(userParts())
  );

  // Responses stay between the activities that produced them, including after history reload.
  const timelineParts = createMemo(() => {
    const items: TurnPart[] = [];
    for (const message of props.assistantMessages) {
      const parts = messageStore.part[message.id] || [];
      const visible = new Set(filterParts(parts, message));
      parts.forEach((part, index) => {
        if (visible.has(part)) items.push({ message, part, index });
      });
    }
    return items;
  });
  const timelineSegments = createMemo(() => groupTurnParts(timelineParts()));
  const compactSegments = createMemo(() => props.compactActivityGroups ? groupCompactTurnParts(timelineParts()) : []);
  const compactFinalParts = createMemo(() => {
    if (!props.compactActivityGroups) return [];
    // Preserve empty final placeholders so they cannot promote legacy progress text.
    const textParts = props.assistantMessages.flatMap(message => messageStore.part[message.id] ?? [])
      .filter((part): part is TextPart => part.type === "text");
    return selectFinalResponseParts(textParts, props.isWorking, !!lastMessageError());
  });
  const compactFinalIds = createMemo(() => new Set(compactFinalParts().map(part => part.id)));

  type RenderItem =
    | ({ kind: "part" } & TurnPart)
    | { kind: "context-group"; items: ContextGroupItem[]; isStreaming: boolean };
  type RenderSegment =
    | { kind: "activity"; id: string; source: TurnPart[]; items: RenderItem[] }
    | { kind: "response"; items: TurnPart[] };

  // Context groups cannot span a response or a message boundary.
  const groupedRenderSegments = createMemo(() => {
    const segments: RenderSegment[] = [];
    let activityBoundary = "start";
    for (const segment of timelineSegments()) {
      if (segment.kind === "response") {
        segments.push({ kind: "response", items: segment.items });
        const last = segment.items.at(-1)!;
        activityBoundary = `${last.message.id}:${last.part.id}`;
        continue;
      }
      const result: RenderItem[] = [];
      let contextBuf: { item: ContextGroupItem; source: TurnPart }[] = [];
      const flushContext = (isStreaming: boolean) => {
        if (contextBuf.length >= 2) {
          result.push({ kind: "context-group", items: contextBuf.map(({ item }) => item), isStreaming });
        } else if (contextBuf.length === 1) {
          result.push({ kind: "part", ...contextBuf[0].source });
        }
        contextBuf = [];
      };

      for (const source of segment.items) {
        const part = source.part;
        if (contextBuf.at(-1)?.source.message.id !== source.message.id) flushContext(false);
        if (part.type === "tool" && CONTEXT_TOOLS.has(part.normalizedTool)) {
          const input = part.state.input as Record<string, unknown> | undefined;
          let action: string = part.normalizedTool;
          let detail = "";
          switch (part.normalizedTool) {
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
          contextBuf.push({ item: { part, action, detail }, source });
        } else {
          flushContext(false);
          result.push({ kind: "part", ...source });
        }
      }
      const lastContext = contextBuf.at(-1)?.source;
      const lastMessageParts = lastContext && messageStore.part[lastContext.message.id];
      const isStreamingTail = props.isWorking
        && lastContext?.message.id === lastAssistantMsgId()
        && lastContext?.part.id === lastMessageParts?.at(-1)?.id;
      flushContext(isStreamingTail);
      // The preceding response keeps expansion stable when a delayed activity item appears.
      segments.push({ kind: "activity", id: activityBoundary, source: segment.items, items: result });
    }
    return segments;
  });

  const activityExpandedKey = (id: string) => `activity-${props.userMessage.id}-${id}`;
  // Standalone file parts are tool output; final inline assets stay with their text part.
  const isCompactStep = (segment: CompactTurnSegment) => segment.kind !== "message"
    || segment.item.part.type !== "text" || !compactFinalIds().has(segment.item.part.id);
  const hasUnloadedSteps = createMemo(() => props.assistantMessages.some(
    (message) => (message.stepCount ?? 0) > 0 && !messageStore.stepsLoaded[message.id],
  ));
  const showTurnStepsTrigger = createMemo(() => !props.compactActivityGroups
    ? props.isWorking || hasSteps()
    : props.isWorking || hasUnloadedSteps() || compactSegments().some(isCompactStep));
  const compactStepId = (index: number) => `compact-activity-${props.userMessage.id}-${index}`;
  const turnHasToolError = createMemo(() => groupedRenderSegments().some((segment) => segment.kind === "activity"
    && segment.source.some(({ part }) => part.type === "tool" && part.state.status === "error")));

  return (
    <div class={styles.sessionTurn} data-component="session-turn" data-compact-activities={props.compactActivityGroups ? "" : undefined} data-compacting={isCompactingTurn() ? "" : undefined}>
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {observedWorking() && !props.isWorking ? t().steps.turnFinished : ""}
      </span>
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
          <Show when={showTurnStepsTrigger()}>
            <div class={styles.stepsTrigger}>
              <button
                type="button"
                data-component="turn-steps-trigger"
                class={styles.stepsTriggerButton}
                onClick={handleStepsToggle}
                aria-expanded={stepsExpanded()}
                aria-controls={(props.compactActivityGroups
                  ? compactSegments().flatMap((segment, index) => isCompactStep(segment) ? [compactStepId(index)] : [])
                  : groupedRenderSegments().flatMap((segment, index) => segment.kind === "activity" ? [`activity-${props.userMessage.id}-${index}`] : [])).join(" ") || undefined}
                data-working={props.isWorking ? "" : undefined}
              >
                {/* Handoff wrap: thinking layer ↔ meta layer with blur/fade transition */}
                <span class={styles.handoffWrap}>
                  {/* Thinking layer (working state) */}
                  <span
                    class={styles.handoffThinking}
                    data-visible={props.isWorking ? "true" : "false"}
                    aria-hidden={!props.isWorking}
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
                    aria-hidden={props.isWorking}
                  >
                    <Show when={modelInfo()?.modelID}>
                      <span class={styles.modelIcon} title={`${modelInfo()?.providerID} / ${modelInfo()?.modelID}${modelInfo()?.reasoningEffort ? ` (${modelInfo()!.reasoningEffort})` : ""}`}>
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
                <Show when={turnHasToolError()}><span class={styles.activityAttention}>{t().common.error}</span></Show>

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

          <Show when={stepsExpanded() && stepsLoading()}>
            <div class={styles.stepsContent}>
              <div class="flex items-center gap-2 px-3 py-2 text-sm" style={{ color: "var(--color-text-secondary)" }}>
                <TextShimmer text={t().steps.loadingSteps} />
              </div>
            </div>
          </Show>

          <Show when={props.compactActivityGroups} fallback={
          <Index each={groupedRenderSegments()}>
            {(segment, segmentIndex) => {
              const responseItems = () => {
                const current = segment();
                return current.kind === "response" ? current.items : [];
              };
              const activityItems = () => {
                const current = segment();
                return current.kind === "activity" ? current.items : [];
              };
              const activityKey = () => {
                const current = segment();
                return current.kind === "activity" ? activityExpandedKey(current.id) : "";
              };
              const activityExpanded = () => props.compactActivityGroups ? isExpanded(activityKey()) : stepsExpanded();
              const activityWorking = () => props.isWorking && segmentIndex === groupedRenderSegments().length - 1;
              const activityId = () => `activity-${props.userMessage.id}-${segmentIndex}`;
              const activityHasError = () => {
                const current = segment();
                return current.kind === "activity" && current.source.some(({ part }) => part.type === "tool" && part.state.status === "error");
              };
              const activityStatus = () => {
                const current = segment();
                const last = current.kind === "activity" ? current.source.at(-1)?.part : undefined;
                if (activityWorking() && currentStatus()) return currentStatus()!;
                return computeStatusFromPart(last, t) || t().steps.consideringNextSteps;
              };
              return (
                <Show when={segment().kind === "response"} fallback={
                  <>
                  <Show when={props.compactActivityGroups}>
                    <ActivitySegmentTrigger
                      controlsId={activityId()}
                      expanded={activityExpanded()}
                      hasError={activityHasError()}
                      working={activityWorking()}
                      status={activityStatus()}
                      onToggle={() => toggleExpanded(activityKey())}
                    />
                  </Show>
                  <div id={activityId()} hidden={!activityExpanded()}>
                  <Show when={activityExpanded()}>
                    <div class={styles.stepsContent} data-segment="activity">
                      <div class={styles.assistantMessageParts}>
                        <Suspense>
                          <Index each={activityItems()}>
                            {(renderItem) => {
                              const partItem = () => {
                                const current = renderItem();
                                return current.kind === "part" ? current : undefined;
                              };
                              const contextItems = () => {
                                const current = renderItem();
                                return current.kind === "context-group" ? current.items : [];
                              };
                              const contextStreaming = () => {
                                const current = renderItem();
                                return current.kind === "context-group" && current.isStreaming;
                              };
                              return (
                                <Show when={partItem()} fallback={
                                  <ContextGroup
                                    items={contextItems()}
                                    isStreaming={contextStreaming()}
                                    defaultOpen={contextStreaming()}
                                  />
                                }>
                                  {(ri) => {
                                    const isPartStreaming = () => {
                                      const { part, message } = ri();
                                      if (part.type === "text") return props.isWorking && part.completed !== true && message.time.completed == null;
                                      return props.isWorking && part.type === "reasoning"
                                        && part.completed !== true && part.time?.end === undefined && isReasoningActive()
                                        && message.id === lastAssistantMsgId()
                                        && part.id === messageStore.part[message.id]?.filter((candidate) => candidate.type === "reasoning").at(-1)?.id;
                                    };
                                    return (
                                      <Show when={`${ri().message.id}:${ri().part.id}`} keyed>
                                        {(_partKey) => (
                                          <Part
                                            last={false}
                                            part={ri().part}
                                            index={ri().index}
                                            message={ri().message}
                                            isStreaming={isPartStreaming()}
                                            permission={getPermissionForPart(ri().part)}
                                            onPermissionRespond={props.onPermissionRespond}
                                            question={getQuestionForPart(ri().part)}
                                            onQuestionRespond={props.onQuestionRespond}
                                            onQuestionDismiss={props.onQuestionDismiss}
                                          />
                                        )}
                                      </Show>
                                    );
                                  }}
                                </Show>
                              );
                            }}
                          </Index>
                        </Suspense>
                      </div>
                    </div>
                  </Show>
                  </div>
                  </>
                }>
                  <div class={styles.response} data-segment="response" role="article" aria-label={t().steps.response}>
                    <div class={styles.responseContent}>
                      <Index each={responseItems()}>
                        {(response) => (
                          <Show when={`${response().message.id}:${response().part.id}`} keyed>
                            {(_partKey) => (
                              <Part
                                last={response().part.id === responseParts().at(-1)?.part.id}
                                part={response().part}
                                index={response().index}
                                message={response().message}
                                isStreaming={props.isWorking
                                  && !(response().part.type === "text" && (response().part as TextPart).completed === true)
                                  && response().message.id === lastAssistantMsgId()
                                  && response().part.id === messageStore.part[response().message.id]?.at(-1)?.id}
                              />
                            )}
                          </Show>
                        )}
                      </Index>
                    </div>
                  </div>
                </Show>
              );
            }}
          </Index>
          }>
            <Index each={compactSegments()}>
              {(segment, segmentIndex) => {
                const renderItem = (item: () => TurnPart) => <Show when={`${item().message.id}:${item().part.id}`} keyed>{(_key) =>
                  <Part
                    last={item().part.type === "file" || item().part.id === compactFinalParts().at(-1)?.id}
                    expandText
                    part={item().part}
                    index={item().index}
                    message={item().message}
                    isStreaming={(() => { const source = item(); const part = source.part; return !!props.isWorking
                      && (part.type === "text" || part.type === "reasoning") && part.completed !== true && source.message.time.completed == null; })()}
                    permission={getPermissionForPart(item().part)}
                    onPermissionRespond={props.onPermissionRespond}
                    question={getQuestionForPart(item().part)}
                    onQuestionRespond={props.onQuestionRespond}
                    onQuestionDismiss={props.onQuestionDismiss}
                  />
                }</Show>;
                const activity = () => { const current = segment(); return current.kind === "activity" ? current : undefined; };
                const single = () => { const current = segment(); return current.kind !== "activity" ? current : undefined; };
                const renderSegment = () => <Show when={activity()} fallback={
                  <Show when={single()}>{item => <div class={styles.compactStandalone} data-segment={item().kind}>{renderItem(() => item().item)}</div>}</Show>
                }>{group => <ToolActivityGroup
                  id={activityExpandedKey(group().id)}
                  items={group().items}
                  expanded={isExpanded(activityExpandedKey(group().id))}
                  working={!!props.isWorking && segmentIndex === compactSegments().length - 1}
                  onToggle={() => toggleExpanded(activityExpandedKey(group().id))}
                  renderReasoning={renderItem}
                />}</Show>;
                return <Show when={isCompactStep(segment())} fallback={renderSegment()}>
                  <div id={compactStepId(segmentIndex)} hidden={!stepsExpanded()}>
                    <Show when={stepsExpanded()}>{renderSegment()}</Show>
                  </div>
                </Show>;
              }}
            </Index>
          </Show>

          {/* Compact conversations use the input area's permission and question controls. */}
          <Show when={!props.compactActivityGroups && stepsExpanded()}>
            <For each={unmatchedPermissions()}>
              {(perm) => (
                <PermissionPrompt permission={perm} onRespond={props.onPermissionRespond} />
              )}
            </For>
            <For each={unmatchedQuestions()}>
              {(question) => (
                <QuestionPrompt
                  question={question}
                  onRespond={props.onQuestionRespond}
                  onDismiss={props.onQuestionDismiss}
                />
              )}
            </For>
          </Show>

          {/* Per-turn token usage (collapsed by default) */}
          <Show when={!props.isWorking && props.assistantMessages.length > 0}>
            <TokenUsage messages={props.assistantMessages} />
          </Show>

          {/* Error/Cancelled Banner */}
          <Show when={!props.isWorking && lastMessageError()}>
            {(_) => {
              const isCancelled = () => lastMessageError() === "Cancelled";
              /** Resolve error:* keys to i18n, pass through unknown strings as-is. */
              const errorKeyMap: Record<string, () => string> = {
                "error:stopped_by_user": () => t().steps.stoppedByUser,
                "error:interrupted": () => t().steps.interrupted,
                "error:empty_response": () => t().steps.emptyResponse,
              };
              const resolvedError = () => {
                const raw = lastMessageError() ?? "";
                return errorKeyMap[raw]?.() ?? raw;
              };
              const isKnownSoftError = () =>
                lastMessageError() === "error:stopped_by_user" || isCancelled();
              const variant = () => isKnownSoftError() ? "cancelled" : "error";
              return (
                <div class={styles.errorBanner} data-variant={variant()}>
                  <div class={styles.errorBannerHeader}>
                    <span class={styles.errorBannerIcon}>
                      <Show when={isKnownSoftError()} fallback={
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <circle cx="12" cy="12" r="10" />
                          <path d="m15 9-6 6" />
                          <path d="m9 9 6 6" />
                        </svg>
                      }>
                        {/* Triangle warning icon for cancelled/stopped */}
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
                          <path d="M12 9v4" />
                          <path d="M12 17h.01" />
                        </svg>
                      </Show>
                    </span>
                    <h3 class={styles.errorBannerTitle}>
                      {isKnownSoftError() ? t().steps.cancelled : t().steps.errorOccurred}
                    </h3>
                    {/* Continue button for cancelled/stopped state */}
                    <Show when={isKnownSoftError() && props.isLastTurn && props.onContinue}>
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
                  <Show when={!isKnownSoftError()}>
                    <div class={styles.errorBannerContent}>
                      <ContentError>{resolvedError()}</ContentError>
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
