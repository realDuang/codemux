import type {
  TextPart,
  ToolPart,
  UnifiedMessage,
  UnifiedPart,
  UnifiedPermission,
  UnifiedQuestion,
  UnifiedSession,
} from "../../../../src/types/unified";
import { inferToolKind, normalizeToolName } from "../../../../src/types/tool-mapping";
import { fromCodexEffort } from "./config";
import { applyCodexToolDisplay, buildToolTitle, convertApprovalToPermission, convertUserInputToQuestion, normalizeCodexReasoningText } from "./converters";
import { convertDesktopElicitationToQuestion } from "./desktop-elicitation";
import { normalizeCodexResponseContent } from "./response-content";
import { extractCodexToolOutput } from "./tool-output";
import { withCodexAssistantImages } from "./assistant-images";
import { projectCodexUserInput } from "./user-input";
import { convertCodexAsyncQuestion, formatCodexAsyncQuestionReplies, getCodexAsyncQuestions, getPendingCodexAsyncQuestionGroups, parseCodexAsyncQuestionReplies, projectCodexAsyncQuestionReply } from "./async-questions";

export interface DesktopStatePatch {
  op: "add" | "replace" | "remove";
  path: Array<string | number>;
  value?: unknown;
}

/** The Desktop thread-stream-state-changed v11 change payload. */
export type DesktopStateChange =
  | { type: "snapshot"; revision: number; conversationState: unknown }
  | {
    type: "patches";
    baseRevision: number;
    revision: number;
    patches: DesktopStatePatch[];
    acceptedTextChanges?: unknown[];
  };

export interface DesktopPendingRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

export interface DesktopConversationSnapshot {
  session: UnifiedSession;
  messages: UnifiedMessage[];
  permissions: UnifiedPermission[];
  questions: UnifiedQuestion[];
  pendingRequests: DesktopPendingRequest[];
  activeTurnId?: string;
  latestTurnId?: string;
  isActive: boolean;
  incompleteHistory: boolean;
}

export class DesktopStateRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopStateRevisionError";
  }
}

/** Keeps one followed conversation; a rejected update never changes the last good state. */
export class DesktopStateReducer {
  private currentState: Record<string, unknown> | undefined;
  private currentRevision: number | undefined;
  private currentSnapshot: DesktopConversationSnapshot | undefined;

  get revision(): number | undefined { return this.currentRevision; }
  get snapshot(): DesktopConversationSnapshot | undefined { return this.currentSnapshot; }
  get conversationState(): Record<string, unknown> | undefined { return this.currentState; }

  reset(): void {
    this.currentState = undefined;
    this.currentRevision = undefined;
    this.currentSnapshot = undefined;
  }

  apply(update: unknown): DesktopConversationSnapshot {
    const change = parseChange(update);
    if (!Number.isSafeInteger(change.revision) || change.revision < 0) {
      throw new DesktopStateRevisionError("Invalid Desktop stream revision");
    }
    let next: Record<string, unknown>;
    if (change.type === "snapshot") {
      next = structuredClone(requireRecord(change.conversationState, "Desktop conversation snapshot"));
    } else if (change.type === "patches") {
      if (this.currentState == null || this.currentRevision !== change.baseRevision || change.revision <= change.baseRevision) {
        throw new DesktopStateRevisionError(`Desktop stream revision gap: expected ${this.currentRevision ?? "snapshot"}, received ${change.baseRevision}`);
      }
      next = structuredClone(this.currentState);
      for (const patch of change.patches) next = applyPatch(next, patch);
      // acceptedTextChanges is a transcript-reader optimization. The corresponding
      // Immer patches already contain the authoritative conversation item text.
    } else {
      throw new DesktopStateRevisionError("Unsupported Desktop stream update");
    }
    const snapshot = convertDesktopConversation(next);
    if (this.currentSnapshot && snapshot.session.id !== this.currentSnapshot.session.id) {
      throw new DesktopStateRevisionError("Desktop stream changed conversation identity");
    }
    this.currentState = next;
    this.currentRevision = change.revision;
    this.currentSnapshot = snapshot;
    return snapshot;
  }
}

export function convertDesktopConversation(value: unknown): DesktopConversationSnapshot {
  const state = requireRecord(value, "Desktop conversation");
  const id = string(state.id);
  if (!id) throw new Error("Desktop conversation has no id");
  const hostId = string(state.hostId) ?? "local";
  const turns = getTurns(state);
  const latestTurn = turns.at(-1);
  const latestRunnableTurn = [...turns].reverse().find((turn) => turn.turnId != null || (turn.status !== "completed" && turn.status !== "failed"));
  const activeTurn = latestRunnableTurn?.status === "inProgress" ? latestRunnableTurn : undefined;
  const pendingRequests = records(state.requests).flatMap((request): DesktopPendingRequest[] => {
    if (request.completed === true || request.completedAtMs != null) return [];
    if ((typeof request.id !== "string" && typeof request.id !== "number") || typeof request.method !== "string") return [];
    return [{ id: request.id, method: request.method, params: record(request.params) }];
  });
  const permissions: UnifiedPermission[] = [];
  const questions: UnifiedQuestion[] = [];
  for (const request of pendingRequests) {
    const scopedId = desktopRequestId(id, request.id, hostId);
    const nativeIdentity = { codexThreadId: id, codexRequestId: request.id, desktopHostId: hostId };
    if (APPROVAL_METHODS.has(request.method)) {
      const permission = convertApprovalToPermission(id, request.id, request.method, request.params);
      permissions.push({ ...permission, id: scopedId, engineType: "codex-desktop", metadata: { ...permission.metadata, ...nativeIdentity } });
    } else if (request.method === "item/tool/requestUserInput") {
      const question = convertUserInputToQuestion(id, request.id, request.params);
      questions.push({ ...question, id: scopedId, engineType: "codex-desktop", metadata: { ...question.metadata, ...nativeIdentity } });
    } else if (request.method === "mcpServer/elicitation/request") {
      const question = convertDesktopElicitationToQuestion(id, request.id, request.params);
      questions.push({ ...question, id: scopedId, metadata: { ...question.metadata, ...nativeIdentity } });
    }
  }
  for (const turn of turns) {
    const turnId = string(turn.turnId);
    if (!turnId) continue;
    for (const group of getPendingCodexAsyncQuestionGroups(turn)) {
      questions.push(convertCodexAsyncQuestion(id, turnId, group, "codex-desktop", hostId));
    }
  }

  const isActive = records(state.unconfirmedTurnSubmissions).some((submission) => submission.terminal !== true)
    || (state.resumeState === "needs_resume"
      ? record(state.threadRuntimeStatus).type === "active"
      : activeTurn != null || (turns.length === 0 && state.resumeState === "resuming"));
  const settings = record(state.latestThreadSettings);
  const collaboration = record(settings.collaborationMode ?? state.latestCollaborationMode);
  const created = millis(state.createdAt) ?? 0;
  const updated = millis(state.updatedAt) ?? created;
  const effort = string(settings.effort ?? state.latestReasoningEffort);
  const tier = settings.serviceTier;
  const session: UnifiedSession = {
    id,
    engineType: "codex-desktop",
    directory: string(state.cwd) ?? "",
    title: string(state.title),
    parentId: string(state.parentThreadId),
    time: { created, updated },
    modelId: string(settings.model ?? state.latestModel),
    mode: string(collaboration.mode ?? state.mode),
    reasoningEffort: effort ? fromCodexEffort(effort) : undefined,
    serviceTier: tier === "priority" || tier === "fast" ? "fast" : tier === "flex" ? "flex" : undefined,
    activityStatus: pendingRequests.length > 0 ? "waiting" : isActive ? "running" : latestTurn?.status === "failed" ? "error" : "idle",
    engineMeta: { codexThreadId: id, desktopHostId: hostId },
  };
  const messages = turns.flatMap((turn, index) => convertTurn(session, turn, index, string(state.modelProvider)));
  const history = record(record(state.turnHistory).history);
  const canonical = record(state.turnHistory).kind === "canonical";
  return {
    session, messages, permissions, questions, pendingRequests, isActive,
    activeTurnId: string(activeTurn?.turnId),
    latestTurnId: string(latestTurn?.turnId),
    incompleteHistory: canonical
      ? history.isComplete !== true || records(history.islands).length !== 1 || turns.some((turn) => record(turn.itemsPagination).hasLoadedOldest === false)
      : state.resumeState !== "resumed" || record(state.turnsPagination).hasLoadedOldest === false || turns.some((turn) => record(turn.itemsPagination).hasLoadedOldest === false),
  };
}

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
  "execCommandApproval", "applyPatchApproval",
]);

function getTurns(state: Record<string, unknown>): Record<string, unknown>[] {
  const legacy = records(state.turns);
  const turnHistory = record(state.turnHistory);
  if (turnHistory.kind !== "canonical") return legacy;
  const history = record(turnHistory.history);
  const entities = record(history.entitiesByKey);
  const canonical = records(history.islands).flatMap((island) => records(island.entries).flatMap((entry) => {
    const entity = typeof entry.value === "string" ? entities[entry.value] : undefined;
    return entity && typeof entity === "object" && !Array.isArray(entity) ? [record(entity)] : [];
  }));
  const byId = new Map(legacy.flatMap((turn) => string(turn.turnId) ? [[string(turn.turnId)!, turn] as const] : []));
  const seen = new Set(canonical.map((turn) => string(turn.turnId)).filter(Boolean));
  // Canonical history defines order; the legacy overlay carries optimistic sends
  // and Desktop-only items, including steering messages, for those same turns.
  const merged = canonical.map((turn) => {
    const overlay = byId.get(string(turn.turnId) ?? "");
    return overlay ? mergeTurn(turn, overlay) : turn;
  });
  return insertBeforeSharedAnchors(merged, legacy, (turn) => string(turn.turnId), seen);
}

function mergeTurn(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const existingItems = records(existing.items);
  const incomingItems = records(incoming.items);
  const hasPagination = existing.itemsPagination != null || incoming.itemsPagination != null;
  let items = incomingItems;
  if (hasPagination) {
    items = mergeItems(existingItems, incomingItems);
  } else if (existingItems.some((item) => item.type === "steeringUserMessage")) {
    const incomingById = new Map(incomingItems.map((item) => [string(item.id), item]));
    items = mergeItems(existingItems.map((item) => item.type === "agentMessage" ? incomingById.get(string(item.id)) ?? item : item), incomingItems);
  } else if (existingItems.length > incomingItems.length) {
    items = existingItems;
    const final = [...incomingItems].reverse().find((item) => item.type === "agentMessage" && item.phase === "final_answer");
    if (final) {
      const match = existingItems.find((item) => item.type === "agentMessage" && (item.id === final.id || (item.phase === "final_answer" && item.text === final.text)));
      if (!match) items = [...existingItems, final];
      else if (match.id !== final.id) items = existingItems.map((item) => item === match ? { ...item, ...final, id: item.id } : item);
    }
  }
  const oldParams = record(existing.params);
  const newParams = record(incoming.params);
  const preserveOpening = oldParams.clientUserMessageId != null && records(oldParams.input).length > 0 && records(newParams.input).length === 0;
  return {
    ...incoming,
    status: existing.status !== "inProgress" && incoming.status === "inProgress" && hasPagination ? existing.status : incoming.status,
    params: preserveOpening ? oldParams : newParams,
    items,
    completedItemIds: { ...record(incoming.completedItemIds), ...record(existing.completedItemIds) },
    itemsPagination: hasPagination ? { ...record(incoming.itemsPagination), ...record(existing.itemsPagination) } : undefined,
  };
}

function mergeItems(existing: Record<string, unknown>[], incoming: Record<string, unknown>[]): Record<string, unknown>[] {
  return insertBeforeSharedAnchors(existing, incoming, (item) => string(item.id), new Set(existing.map((item) => string(item.id)).filter(Boolean)));
}

function insertBeforeSharedAnchors<T>(existing: T[], incoming: T[], identity: (item: T) => string | undefined, existingIds: Set<string | undefined>): T[] {
  const before = new Map<string, T[]>();
  let pending: T[] = [];
  for (const item of incoming) {
    const id = identity(item);
    if (id && existingIds.has(id)) {
      if (pending.length > 0) before.set(id, [...(before.get(id) ?? []), ...pending]);
      pending = [];
    } else pending.push(item);
  }
  return [...existing.flatMap((item) => [...(before.get(identity(item) ?? "") ?? []), item]), ...pending];
}

/** UI stores key parts globally, while native item IDs are only locally unique. */
export function desktopMessageId(threadId: string, turnKey: string, itemKey: string, hostId = "local", kind: "item" | "input" | "error" = "item"): string {
  return `codex-desktop:v1:${encodeURIComponent(hostId)}:${encodeURIComponent(threadId)}:${encodeURIComponent(turnKey)}:${kind}:${encodeURIComponent(itemKey)}`;
}

/** Native JSON-RPC IDs can repeat across owners and distinguish numbers from strings. */
export function desktopRequestId(threadId: string, requestId: string | number, hostId = "local"): string {
  return `codex-desktop:v1:${encodeURIComponent(hostId)}:${encodeURIComponent(threadId)}:request:${typeof requestId}:${encodeURIComponent(String(requestId))}`;
}

function convertTurn(session: UnifiedSession, turn: Record<string, unknown>, index: number, providerId?: string): UnifiedMessage[] {
  const params = record(turn.params);
  const turnId = string(turn.turnId);
  const turnKey = turnId ?? string(params.clientUserMessageId) ?? `local:${index}`;
  const created = millis(turn.turnStartedAtMs) ?? session.time.created;
  const duration = number(turn.durationMs);
  const terminal = turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted";
  const completed = terminal ? created + Math.max(0, duration ?? 0) : undefined;
  const items = records(turn.items);
  const asyncQuestionIds = new Set(items.flatMap(getCodexAsyncQuestions).map(question => question.id));
  const latestWorkItem = [...items].reverse().find((item) => !["userMessage", "hookPrompt", "steeringUserMessage", "steered"].includes(string(item.type) ?? ""));
  const messages: UnifiedMessage[] = [];
  const hostId = string(session.engineMeta?.desktopHostId) ?? "local";
  const makeMessage = (item: Record<string, unknown>, itemIndex: number, kind: "item" | "input" = "item"): UnifiedMessage | undefined => {
    const itemId = string(item.id) ?? `${turnKey}:item:${itemIndex}`;
    const messageId = desktopMessageId(session.id, turnKey, itemId, hostId, kind);
    const type = string(item.type) ?? "unknown";
    const isUser = type === "userMessage" || type === "steeringUserMessage";
    const observedStart = millis(record(turn.aeonAssistantMessageStartedAtMsById)[itemId])
      ?? millis(record(turn.commandExecutionStartedAtMsById)[itemId]);
    const itemStarted = observedStart ?? created;
    const itemFinished = millis(record(turn.agentMessageCompletedAtMsById)[itemId]) ?? millis(item.completedAtMs);
    const reviewFinished = type === "automaticApprovalReview"
      && ["approved", "denied", "aborted", "timedOut"].includes(string(item.status) ?? "");
    const historyItem = type === "userInputResponse" || type === "mcpServerElicitation" || type === "permissionRequest";
    const itemCompleted = historyItem ? item.completed === true
      : type === "planImplementation" ? item.isCompleted === true
      : type === "error" || type === "todo-list" || (type === "reasoning" && item !== latestWorkItem) ? true
      : isUser ? type !== "steeringUserMessage" || item.status !== "pending"
      : terminal || reviewFinished || type === "strictReviewNotice" || type === "autoReviewInterruptionWarning"
        || itemFinished != null || record(turn.completedItemIds)[itemId] === true || item.completed === true
        || ["completed", "failed", "declined"].includes(string(item.status) ?? "");
    const itemEnd = itemCompleted ? itemFinished ?? (number(item.durationMs) != null ? itemStarted + Math.max(0, number(item.durationMs)!) : completed ?? itemStarted) : undefined;
    const message: UnifiedMessage = {
      id: messageId, sessionId: session.id, role: isUser ? "user" : "assistant",
      // Native item order is authoritative when only some items have start timestamps.
      time: { created: Math.max(itemStarted, messages.at(-1)?.time.created ?? itemStarted),
        ...(itemEnd != null && !(type === "reasoning" && !terminal && itemFinished == null) ? { completed: itemEnd } : {}) },
      parts: [], workingDirectory: string(params.cwd) ?? session.directory,
      modelId: string(params.model) ?? session.modelId,
      providerId,
      reasoningEffort: fromCodexEffort(string(params.effort) ?? "") ?? session.reasoningEffort,
      mode: string(record(params.collaborationMode).mode) ?? session.mode,
      engineMeta: { codexThreadId: session.id, codexTurnId: turnId, codexItemId: string(item.id), desktopItemType: type },
    };
    const base = { id: messageId, messageId, sessionId: session.id };
    if (isUser) {
      const input = type === "userMessage" ? item.content : item.input;
      const parsedReplies = parseCodexAsyncQuestionReplies(input);
      const questionReplies = parsedReplies?.every(reply => asyncQuestionIds.has(reply.questionItemId)) ? parsedReplies : undefined;
      if (questionReplies) {
        message.role = "assistant";
        message.parts = [{ ...base, type: "text", text: formatCodexAsyncQuestionReplies(questionReplies), phase: "commentary", completed: itemCompleted }];
        message.engineMeta = { ...message.engineMeta,
          codexAsyncQuestionReplyIds: questionReplies.map(reply => reply.questionItemId),
          codexAsyncQuestionReplyAccepted: type === "userMessage" || item.status === "accepted",
        };
      } else {
        const replyDisplay = projectCodexAsyncQuestionReply(input);
        message.parts = userParts(base, input, hostId).map(part =>
          part.type === "text" && replyDisplay ? { ...part, ...replyDisplay } : part);
      }
      if (type === "steeringUserMessage") {
        message.engineMeta = { ...message.engineMeta, clientUserMessageId: item.clientUserMessageId, serverUserMessageId: item.serverUserMessageId };
      }
    } else if (type === "agentMessage" || type === "plan") {
      const phase = item.phase === "commentary" ? "commentary"
        : item.phase === "partial_answer" ? "partial"
          : item.phase === "final_answer" ? "final" : item.delivery === "async" || type === "plan" ? "partial" : undefined;
      const textPart: TextPart = { ...base, type: "text", completed: itemCompleted,
        ...normalizeCodexResponseContent(string(item.text) ?? "", item.memoryCitation, item.questions), ...(phase ? { phase } : {}) };
      message.parts = [hostId === "local" ? withCodexAssistantImages(textPart, session.id) : textPart];
    } else if (type === "reasoning") {
      const text = normalizeCodexReasoningText(item.summary, item.content);
      // Native reasoning can contain encrypted content only. Session activity
      // carries its progress; an empty display item would leave a thinking box.
      if (!text) return undefined;
      message.parts = [{ ...base, type: "reasoning", summaryFormat: "heading-prefixed", text, completed: itemCompleted,
        ...(observedStart != null && itemFinished != null && itemFinished > observedStart
          ? { time: { start: observedStart, end: itemFinished } } : {}) }];
    } else if (type === "contextCompaction") {
      message.isCompaction = true;
      message.parts = [{ ...base, type: "system-notice", noticeType: "compact", text: "notice:context_compressed" }];
    } else if (type === "userInputResponse") {
      const answers = record(item.answers);
      message.parts = records(item.questions).flatMap((question, index): UnifiedPart[] => {
        const values = answers[string(question.id) ?? ""];
        const text = [string(question.question), ...(Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [])].filter(Boolean).join("\n\n");
        return text ? [{ ...base, id: `${base.id}:question:${index}`, type: "text", text, phase: "commentary" }] : [];
      });
      if (message.parts.length === 0) return undefined;
    } else if (type === "mcpServerElicitation") {
      // Pending requests are handled by the question dock. The transcript keeps
      // only the completed response, without reintroducing authorization actions.
      if (item.completed !== true) return undefined;
      const params = record(item.params);
      const metadata = record(params._meta);
      // OpenAI forms are gated off in the default coding transcript. Keep the
      // same default rather than interpreting their private schemas as plain text.
      if (params.mode !== "form" && params.mode !== "url" && params.mode !== "openai/userVerification") return undefined;
      if (params.mode === "form" && Object.hasOwn(metadata, "openai/elicitation") && metadata.codex_approval_kind == null) return undefined;
      const notices: Record<string, string> = {
        accept: "notice:elicitation_accepted", decline: "notice:elicitation_declined", cancel: "notice:elicitation_cancelled",
      };
      const notice = notices[string(item.action) ?? ""] ?? "notice:elicitation_completed";
      message.parts = [{ ...base, type: "system-notice", noticeType: item.action === "decline" ? "warning" : "info", text: notice }];
      const text = string(params.mode === "openai/userVerification" ? params.title : params.message);
      if (text) message.parts.push({ ...base, id: `${base.id}:message`, type: "text", text, phase: "commentary" });
    } else if (type === "permissionRequest") {
      // Desktop hides completed permissions from its transcript; pending
      // permissions already have the actionable request dock.
      return undefined;
    } else if (type === "planImplementation") {
      message.parts = [{ ...base, type: "system-notice", noticeType: "info", text: item.isCompleted === true ? "notice:plan_implementation_completed" : "notice:plan_implementation_pending" }];
      const text = string(item.planContent);
      if (text) message.parts.push({ ...base, id: `${base.id}:plan`, type: "text", text, phase: "commentary" });
    } else if (type === "todo-list") {
      const todos = records(item.plan).map((step, index) => ({
        id: `${itemId}:${index}`, content: string(step.step) ?? "",
        status: step.status === "inProgress" ? "in_progress" : step.status === "completed" ? "completed" : "pending",
        priority: "medium",
      }));
      const part = toolPart(base, { ...item, todos, status: "completed" }, itemStarted, itemEnd, message.workingDirectory);
      message.parts = [{ ...part, normalizedTool: "todo" }];
      const explanation = string(item.explanation);
      if (explanation) message.parts.unshift({ ...base, id: `${base.id}:explanation`, type: "text", text: explanation, phase: "commentary" });
    } else if (type === "error") {
      message.parts = [];
      if (item.willRetry === true) message.parts.push({ ...base, id: `${base.id}:retry`, type: "system-notice", noticeType: "info", text: "notice:stream_reconnecting" });
      const text = [string(item.message), string(item.additionalDetails)].filter(Boolean).join("\n\n");
      if (text) message.parts.push({ ...base, type: "system-notice", noticeType: item.willRetry === true ? "info" : "warning", text });
      if (message.parts.length === 0) return undefined;
    } else if (type === "permissionsApprovalResponse" || type === "steered") {
      // These are transport markers, not executable tools.
      return undefined;
    } else if (type === "automaticApprovalReview") {
      const notices: Record<string, string> = {
        inProgress: "notice:automatic_approval_review",
        approved: "notice:automatic_approval_approved",
        denied: "notice:automatic_approval_denied",
        aborted: "notice:automatic_approval_aborted",
        timedOut: "notice:automatic_approval_timed_out",
      };
      message.parts = [{ ...base, type: "system-notice", noticeType: item.status === "denied" || item.status === "timedOut" ? "warning" : "info", text: notices[string(item.status) ?? ""] ?? "notice:automatic_approval_review" }];
    } else if (type === "strictReviewNotice" || type === "autoReviewInterruptionWarning") {
      message.parts = [{ ...base, type: "system-notice", noticeType: "warning", text: type === "strictReviewNotice" ? "notice:strict_review_required" : "notice:auto_review_interrupted" }];
    } else {
      const unfinished = terminal && item.status === "inProgress";
      const tool = toolPart(base, unfinished ? { ...item, status: "failed", error: errorText(turn.error) ?? "Tool execution ended before completion" } : item, itemStarted, itemEnd, message.workingDirectory);
      const richOutput = extractCodexToolOutput(item, base);
      if (richOutput.output !== undefined) {
        if (tool.state.status === "running" || tool.state.status === "pending") {
          tool.state.input = { ...record(tool.state.input), _output: richOutput.output };
        } else tool.state.output = richOutput.output;
      }
      message.parts = [tool, ...richOutput.attachments];
    }
    message.parts.forEach((part, partIndex) => { part.order = partIndex; });
    return message;
  };
  if (!hasOpeningUserMessage(turn, items) && records(params.input).length > 0) {
    const user = makeMessage({ id: string(params.clientUserMessageId) ?? `${turnKey}:user`, type: "userMessage", content: params.input }, -1, "input");
    if (user) messages.push(user);
  }
  const serverUserIds = new Set(items.filter((item) => item.type === "userMessage").map((item) => string(item.id)));
  items.forEach((item, itemIndex) => {
    if (item.type === "steeringUserMessage" && serverUserIds.has(string(item.serverUserMessageId)) && string(item.serverUserMessageId)) return;
    const message = makeMessage(item, itemIndex);
    if (message) messages.push(message);
  });
  if (turn.status === "failed" || turn.status === "interrupted") {
    const error = errorText(turn.error) ?? (turn.status === "interrupted" ? "Turn interrupted" : "Turn failed");
    const last = [...messages].reverse().find((message) => message.role === "assistant");
    if (last) last.error = error;
    else messages.push({ id: desktopMessageId(session.id, turnKey, "error", hostId, "error"), sessionId: session.id, role: "assistant", time: { created, completed }, parts: [], error, engineMeta: { codexThreadId: session.id, codexTurnId: turnId } });
  }
  return messages;
}

function hasOpeningUserMessage(turn: Record<string, unknown>, items: Record<string, unknown>[]): boolean {
  const params = record(turn.params);
  const openingId = string(record(turn.itemsPagination).openingUserMessageId);
  const clientId = string(params.clientUserMessageId);
  const inputKey = userInputKey(params.input);
  return items.some((item) => {
    if (item.type !== "userMessage") return false;
    if (openingId != null) return item.id === openingId;
    const itemClientId = string(item.clientId);
    if (clientId != null && itemClientId != null) return itemClientId === clientId;
    if (record(turn.itemsPagination).hasLoadedOldest === false) return false;
    return inputKey.length > 0 && userInputKey(item.content) === inputKey;
  });
}

function userInputKey(input: unknown): string {
  const values = records(input).map((block) => [block.type, block.text ?? block.url ?? block.path ?? block.name ?? ""]);
  return values.length > 0 ? JSON.stringify(values) : "";
}

function userParts(base: { id: string; messageId: string; sessionId: string }, input: unknown, hostId: string): UnifiedPart[] {
  const blocks = records(input);
  const projected = projectCodexUserInput(blocks, { allowLocalFiles: hostId === "local" });
  return blocks.flatMap((block, index): UnifiedPart[] => {
    const part = { ...base, id: `${base.id}:input:${index}` };
    const content = projected[index];
    if (content) return [{ ...part, ...content }];
    if (block.type === "text") return [{ ...part, type: "text", text: "" }];
    if (block.type === "skill") return [{ ...part, type: "text", text: `$${string(block.name) ?? "skill"}` }];
    return [];
  });
}

function toolPart(base: { id: string; messageId: string; sessionId: string }, item: Record<string, unknown>, started: number, completed?: number, workingDirectory?: string): ToolPart {
  const originalTool = (item.type === "functionCallOutput" ? string(item.name) : undefined) ?? string(item.type) ?? "unknown";
  const normalizedTool = normalizeToolName("codex", originalTool);
  const changes = records(item.changes);
  const filePath = string(item.path) ?? string(changes[0]?.path);
  const input = { ...item, ...(filePath ? { filePath } : {}) };
  const output = item.aggregatedOutput ?? item.result ?? item.contentItems ?? item.output ?? "";
  const error = errorText(item.error) ?? (typeof item.exitCode === "number" && item.exitCode !== 0 ? `Exit code: ${item.exitCode}` : undefined);
  const end = completed ?? started;
  const part: ToolPart = {
    ...base, type: "tool", callId: string(item.id) ?? base.id, originalTool, normalizedTool,
    title: buildToolTitle(originalTool, normalizedTool, input),
    kind: inferToolKind(undefined, normalizedTool),
    state: completed == null
      ? { status: "running", input: { ...input, _output: output }, time: { start: started } }
      : error || item.status === "failed" || item.status === "declined"
        ? { status: "error", input, output, error: error ?? "Tool failed", time: { start: started, end, duration: Math.max(0, end - started) } }
        : { status: "completed", input, output, time: { start: started, end, duration: Math.max(0, end - started) } },
  };
  applyCodexToolDisplay(part, input, workingDirectory);
  const paths = changes.map((change) => string(change.path)).filter((path): path is string => Boolean(path));
  if (paths.length > 0) part.locations = paths.map((path) => ({ path }));
  else if (filePath) part.locations = [{ path: filePath }];
  const diff = changes.map((change) => string(change.diff) ?? "").filter(Boolean).join("\n");
  if (diff) part.diff = diff;
  return part;
}

function applyPatch(state: Record<string, unknown>, patch: DesktopStatePatch): Record<string, unknown> {
  if (!["add", "replace", "remove"].includes(patch.op) || !Array.isArray(patch.path)) throw new DesktopStateRevisionError("Invalid Desktop state patch");
  if (patch.path.some((key) => key === "__proto__" || key === "constructor" || key === "prototype")) throw new DesktopStateRevisionError("Unsafe Desktop state patch path");
  if (patch.path.length === 0) {
    if (patch.op === "remove") throw new DesktopStateRevisionError("Cannot remove Desktop conversation root");
    return structuredClone(requireRecord(patch.value, "Desktop root patch"));
  }
  let target: Record<string, unknown> | unknown[] = state;
  for (const key of patch.path.slice(0, -1)) {
    const child: unknown = Array.isArray(target) ? target[arrayIndex(key, target.length, false)] : target[String(key)];
    if (!child || typeof child !== "object") throw new DesktopStateRevisionError("Desktop patch path does not exist");
    target = child as Record<string, unknown> | unknown[];
  }
  const key = patch.path.at(-1)!;
  if (Array.isArray(target)) {
    if (key === "length" && patch.op === "replace" && Number.isSafeInteger(patch.value) && (patch.value as number) >= 0) {
      target.length = patch.value as number;
      return state;
    }
    const index = arrayIndex(key, target.length, patch.op === "add");
    if (patch.op === "remove") target.splice(index, 1);
    else if (patch.op === "add") target.splice(index, 0, structuredClone(patch.value));
    else target[index] = structuredClone(patch.value);
  } else {
    const field = String(key);
    // JSON snapshots omit undefined properties; Immer can subsequently replace
    // those fields, so an object replacement need not already have an own key.
    if (patch.op === "remove") delete target[field];
    else target[field] = structuredClone(patch.value);
  }
  return state;
}

function parseChange(value: unknown): DesktopStateChange {
  const change = record(value);
  if (change.type === "snapshot") {
    return { type: "snapshot", revision: change.revision as number, conversationState: change.conversationState };
  }
  if (change.type !== "patches" || !Array.isArray(change.patches)) throw new DesktopStateRevisionError("Unsupported Desktop stream update");
  const patches = change.patches.map((value): DesktopStatePatch => {
    const patch = record(value);
    if (!["add", "replace", "remove"].includes(String(patch.op)) || !Array.isArray(patch.path)
      || patch.path.some((key) => typeof key !== "string" && typeof key !== "number")) {
      throw new DesktopStateRevisionError("Invalid Desktop state patch");
    }
    return { op: patch.op as DesktopStatePatch["op"], path: patch.path, value: patch.value };
  });
  return { type: "patches", revision: change.revision as number, baseRevision: change.baseRevision as number, patches };
}

function arrayIndex(key: string | number, length: number, allowEnd: boolean): number {
  if (key === "-" && allowEnd) return length;
  const index = typeof key === "number" ? key : /^\d+$/.test(key) ? Number(key) : NaN;
  if (!Number.isSafeInteger(index) || index < 0 || index > length || (!allowEnd && index === length)) throw new DesktopStateRevisionError("Invalid Desktop patch array index");
  return index;
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function millis(value: unknown): number | undefined {
  if (value instanceof Date) return number(value.getTime());
  if (typeof value === "number") return number(value);
  if (typeof value !== "string" || !value) return undefined;
  return number(Number(value)) ?? number(Date.parse(value));
}
function errorText(value: unknown): string | undefined { return string(value) ?? string(record(value).message); }
