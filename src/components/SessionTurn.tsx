import {
  createMemo,
  createSignal,
  For,
  Index,
  Show,
  Suspense,
  onCleanup,
} from "solid-js";
import { messageStore, isExpanded, toggleExpanded } from "../stores/message";
import { Part, ProviderIcon, PermissionPrompt, QuestionPrompt } from "./share/part";
import { ContentError } from "./share/content-error";
import { IconSparkles } from "./icons";
import { useI18n } from "../lib/i18n";
import type { UnifiedMessage, UnifiedPart, UnifiedPermission, UnifiedQuestion, ToolPart } from "../types/unified";
import { Spinner } from "./Spinner";

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
}

/**
 * Compute status text from the current part being processed
 */
function computeStatusFromPart(
  part: UnifiedPart | undefined,
  t: () => any
): string | undefined {
  if (!part) return undefined;

  if (part.type === "tool") {
    switch (part.normalizedTool) {
      case "task":
        return t().steps.delegatingWork;
      case "todo":
        return t().steps.planningNextSteps;
      case "read":
        return t().steps.gatheringContext;
      case "list":
      case "grep":
      case "glob":
        return t().steps.searchingCodebase;
      case "web_fetch":
        return t().steps.searchingWeb;
      case "edit":
      case "write":
        return t().steps.makingEdits;
      case "shell":
        return t().steps.runningCommands;
      default:
        return undefined;
    }
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

export function SessionTurn(props: SessionTurnProps) {
  const { t } = useI18n();
  
  const stepsExpandedKey = () => `steps-${props.userMessage.id}`;
  const stepsExpanded = () => isExpanded(stepsExpandedKey());
  const handleStepsToggle = () => toggleExpanded(stepsExpandedKey());

  const isCompactingTurn = createMemo(() => {
    for (const msg of props.assistantMessages) {
      if ((msg.engineMeta as any)?.summary === true || msg.mode === "compaction" || (msg.engineMeta as any)?.agent === "compaction") {
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

  // Get permission for a specific tool part (by callId).
  // Some agents (e.g. Copilot CLI) use a different toolCallId in the
  // permission request than in the tool_call notification, so we also
  // match by rawInput command against a pending/running tool part.
  const getPermissionForPart = (part: UnifiedPart) => {
    if (part.type !== "tool") return undefined;
    const tp = part as ToolPart;
    // Direct match by callId
    const direct = permissions().find(p => p.toolCallId === tp.callId);
    if (direct) return direct;
    // Fallback: match by rawInput command against a pending/running tool
    if (tp.state.status === "pending" || tp.state.status === "running") {
      const cmd = (tp.state as any).input?.command;
      if (cmd) {
        return permissions().find(p => {
          const ri = p.rawInput as any;
          return ri?.command === cmd || ri?.commands?.includes(cmd);
        });
      }
      // Last resort: if there's only one unmatched permission and this is
      // the only pending/running tool, assume they belong together.
      const unmatchedPerms = permissions().filter(p => {
        for (const msg of props.assistantMessages) {
          const parts = messageStore.part[msg.id] || [];
          if (parts.some((pp: any) => pp.type === "tool" && pp.callId === p.toolCallId)) return false;
        }
        return true;
      });
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

  // Get question for a specific tool part (by callId)
  const getQuestionForPart = (part: UnifiedPart) => {
    if (part.type !== "tool") return undefined;
    const tp = part as ToolPart;
    // Direct match by callId
    const direct = questions().find(q => q.toolCallId === tp.callId);
    if (direct) return direct;
    // Fallback: if there's only one unmatched question and this is the only pending/running tool
    if (tp.state.status === "pending" || tp.state.status === "running") {
      const unmatchedQs = questions().filter(q => {
        for (const msg of props.assistantMessages) {
          const parts = messageStore.part[msg.id] || [];
          if (parts.some((pp: any) => pp.type === "tool" && pp.callId === q.toolCallId)) return false;
        }
        return true;
      });
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

  // Check if there are any tool parts (steps)
  const hasSteps = createMemo(() => {
    for (const assistantMsg of props.assistantMessages) {
      const parts = messageStore.part[assistantMsg.id] || [];
      for (const p of parts) {
        if (p?.type === "tool") return true;
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

  // Compute duration — live-ticking while working, static when done
  const [tick, setTick] = createSignal(Date.now());
  const tickTimer = setInterval(() => {
    if (props.isWorking) setTick(Date.now());
  }, 1000);
  onCleanup(() => clearInterval(tickTimer));

  const duration = createMemo(() => {
    const startTime = props.userMessage.time.created;
    const lastAssistant = props.assistantMessages.at(-1);
    const endTime = lastAssistant?.time?.completed;
    if (endTime) return formatDuration(startTime, endTime);
    // While working, use live tick
    if (props.isWorking) {
      const _ = tick(); // subscribe to tick signal
      return formatDuration(startTime, Date.now());
    }
    return formatDuration(startTime);
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
    const filtered = allParts.filter((x, index) => {
      if (!x) return false;
      // Filter out all step-start, model info will be shown in header
      if (x.type === "step-start") return false;
      if (x.type === "snapshot") return false;
      if (x.type === "patch") return false;
      if (x.type === "step-finish") return false;
      if (x.type === "text" && (x as any).synthetic === true) return false;
      if (x.type === "tool" && x.originalTool === "todoread") return false;
      if (x.type === "text" && !(x as any).text) return false;
      // Show pending/running tools when working
      if (
        x.type === "tool" &&
        !props.isWorking &&
        ((x as any).state?.status === "pending" ||
          (x as any).state?.status === "running")
      ) {
        return false;
      }
      return true;
    });

    // For assistant messages, reorder: reasoning -> tools -> text
    if (messageRole === "assistant") {
      const reasoning = filtered.filter((p) => p.type === "reasoning");
      const tools = filtered.filter((p) => p.type === "tool");
      const text = filtered.filter((p) => p.type === "text");
      const others = filtered.filter(
        (p) => p.type !== "reasoning" && p.type !== "tool" && p.type !== "text"
      );
      return [...others, ...reasoning, ...tools, ...text];
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
      // When showing steps, filter out the last text part (it's shown separately as response)
      const lastText = lastTextPart();
      const stepsFiltered = !props.isWorking && lastText
        ? filtered.filter((p) => p.id !== lastText.id)
        : filtered;
      if (stepsFiltered.length > 0) {
        result.push({ message: msg, parts: stepsFiltered });
      }
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
                {/* Spinner when working */}
                <Show when={props.isWorking}>
                  <Spinner size="small" />
                </Show>
                
                {/* Model icon - show when not working */}
                <Show when={!props.isWorking && modelInfo()?.modelID}>
                  <span class={styles.modelIcon} title={`${modelInfo()?.providerID} / ${modelInfo()?.modelID}`}>
                    <ProviderIcon model={modelInfo()?.modelID || ""} size={14} />
                  </span>
                </Show>

                {/* Status text */}
                <span class={styles.statusText}>
                  <Show
                    when={props.isWorking}
                    fallback={
                      stepsExpanded() ? t().steps.hideSteps : t().steps.showSteps
                    }
                  >
                    {currentStatus()}
                  </Show>
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
          <Show when={stepsExpanded() && allStepsParts().length > 0}>
            <div class={styles.stepsContent}>
              <For each={allStepsParts()}>
                {(item) => (
                  <div class={styles.assistantMessageParts}>
                    <Suspense>
                      <Index each={item.parts}>
                        {(part, partIndex) => (
                          <Part
                            last={false}
                            part={part()}
                            index={partIndex}
                            message={item.message}
                            permission={getPermissionForPart(part())}
                            onPermissionRespond={props.onPermissionRespond}
                            question={getQuestionForPart(part())}
                            onQuestionRespond={props.onQuestionRespond}
                            onQuestionDismiss={props.onQuestionDismiss}
                          />
                        )}
                      </Index>
                    </Suspense>
                  </div>
                )}
              </For>
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

          {/* Permission prompts for running tools (show even when steps collapsed) */}
          <Show when={permissions().length > 0 && !stepsExpanded()}>
            <div class={styles.permissionPrompts}>
              <For each={permissions()}>
                {(perm) => {
                  // Find the tool part for this permission (using extended matching)
                  for (const msg of props.assistantMessages) {
                    const parts = messageStore.part[msg.id] || [];
                    for (let i = 0; i < parts.length; i++) {
                      const p = parts[i];
                      if (p.type === "tool" && getPermissionForPart(p)?.id === perm.id) {
                        return (
                          <Part
                            last={false}
                            part={p}
                            index={i}
                            message={msg}
                            permission={perm}
                            onPermissionRespond={props.onPermissionRespond}
                          />
                        );
                      }
                    }
                  }
                  // No matching tool part found — render standalone permission prompt
                  return (
                    <PermissionPrompt
                      permission={perm}
                      onRespond={props.onPermissionRespond}
                    />
                  );
                }}
              </For>
            </div>
          </Show>

          {/* Question prompts for running tools (show even when steps collapsed) */}
          <Show when={questions().length > 0 && !stepsExpanded()}>
            <div class={styles.permissionPrompts}>
              <For each={questions()}>
                {(q) => {
                  // Find the tool part for this question
                  for (const msg of props.assistantMessages) {
                    const parts = messageStore.part[msg.id] || [];
                    for (let i = 0; i < parts.length; i++) {
                      const p = parts[i];
                      if (p.type === "tool" && getQuestionForPart(p)?.id === q.id) {
                        return (
                          <Part
                            last={false}
                            part={p}
                            index={i}
                            message={msg}
                            question={q}
                            onQuestionRespond={props.onQuestionRespond}
                            onQuestionDismiss={props.onQuestionDismiss}
                          />
                        );
                      }
                    }
                  }
                  // No matching tool part found — render standalone question prompt
                  return (
                    <QuestionPrompt
                      question={q}
                      onRespond={props.onQuestionRespond}
                      onDismiss={props.onQuestionDismiss}
                    />
                  );
                }}
              </For>
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
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <circle cx="12" cy="12" r="10" />
                          <rect x="9" y="9" width="6" height="6" rx="1" />
                        </svg>
                      </Show>
                    </span>
                    <h3 class={styles.errorBannerTitle}>
                      {isCancelled() ? t().steps.cancelled : t().steps.errorOccurred}
                    </h3>
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
