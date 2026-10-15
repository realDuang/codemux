import type {
  CodexDesktopIpcClient, DesktopFollowerMethod, DesktopQueuedFollowUp, DesktopThreadSnapshot,
} from "./desktop-ipc-client";
import { getCodexAsyncQuestions, parseCodexAsyncQuestionReplies } from "./async-questions";

export type CodexOwnerRequestMethod = "turn/start" | "turn/steer" | "turn/interrupt" | "thread/compact/start";

export interface NativeOwnedThreadState {
  /** The unmodified thread returned by this adapter's own app-server. */
  thread: Record<string, unknown>;
  model: string;
  modelProvider?: string;
  reasoningEffort?: string | null;
  collaborationMode?: Record<string, unknown>;
  serviceTier?: string | null;
  approvalPolicy?: unknown;
  sandboxPolicy?: unknown;
  permissions?: string | null;
  latestTokenUsageInfo?: unknown;
  /** Item lifecycle data observed by this runtime while a native turn is active. */
  turnStateById?: Record<string, {
    completedItemIds?: Record<string, boolean>;
    agentMessageCompletedAtMsById?: Record<string, number>;
    diff?: string | null;
  }>;
  requests?: Array<{ id: string | number; method: string; params: Record<string, unknown> }>;
}

/**
 * Implemented by the existing Codex adapter, never by a second app-server.
 * request() resolves at admission and must retain the adapter's normal message,
 * active-turn, and approval bookkeeping. Completion remains an adapter event.
 */
export interface CodexDesktopOwnerRuntime {
  readThread(engineSessionId: string): Promise<NativeOwnedThreadState>;
  /** Read only metadata; used to notice names changed by another Codex client. */
  readMetadata?(engineSessionId: string): Promise<Record<string, unknown>>;
  request(engineSessionId: string, method: CodexOwnerRequestMethod, params: Record<string, unknown>): Promise<unknown>;
  respond(engineSessionId: string, requestId: string | number, result: unknown): Promise<void>;
  subscribe(listener: (engineSessionId: string) => void): () => void;
  updateSettings?(engineSessionId: string, settings: Record<string, unknown>, options: {
    activeTurnId?: string;
    condition?: Record<string, unknown>;
  }): Promise<boolean>;
  resolveQueuedPermissions?(engineSessionId: string, message: DesktopQueuedFollowUp): Promise<Record<string, unknown>>;
}

type OwnerTransport = Pick<CodexDesktopIpcClient,
  "connect" | "clientId" | "discoverOwner" | "registerOwnedThread" | "publishOwnedThreadState" | "publishOwnedQueuedFollowUps">;

interface OwnedThread {
  engineSessionId: string;
  threadId: string;
  snapshot: DesktopThreadSnapshot;
  encodedState: string;
  unregister: () => void;
  refresh?: Promise<void>;
  refreshAgain: boolean;
  timer?: ReturnType<typeof setTimeout>;
  queuedFollowUps: DesktopQueuedFollowUp[];
  retiredMessageIds: Set<string>;
  queueDrain?: Promise<void>;
  admittingMessageId?: string;
  queuedPermissionSettings: Map<string, Record<string, unknown>>;
}

export interface CodexDesktopOwnerOptions {
  refreshDelayMs?: number;
  onError?: (threadId: string, error: Error) => void;
}

/** Publishes only explicitly registered CodeMux-created threads to Desktop followers. */
export class CodexDesktopOwner {
  private readonly threads = new Map<string, OwnedThread>();
  private readonly byEngineSession = new Map<string, string>();
  private readonly unsubscribe: () => void;
  private metadataTimer: ReturnType<typeof setInterval> | undefined;
  private metadataPoll: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly client: OwnerTransport,
    private readonly runtime: CodexDesktopOwnerRuntime,
    private readonly options: CodexDesktopOwnerOptions = {},
  ) {
    this.unsubscribe = runtime.subscribe((sessionId) => {
      const thread = this.threads.get(this.byEngineSession.get(sessionId) ?? "");
      if (!thread || thread.timer || this.disposed) return;
      thread.timer = setTimeout(() => {
        thread.timer = undefined;
        void this.refresh(thread.threadId).then(() => this.drainQueue(thread)).catch((error: unknown) => this.reportError(thread, error));
      }, options.refreshDelayMs ?? 100);
    });
  }

  /** Call only after this runtime successfully creates a new native thread. */
  async registerCreatedThread(engineSessionId: string, threadId: string): Promise<void> {
    if (this.disposed) throw new Error("Codex Desktop owner is disposed");
    const existing = this.threads.get(threadId);
    if (existing) {
      if (existing.engineSessionId !== engineSessionId) throw new Error("Desktop thread already has a different engine session");
      return;
    }
    await this.client.connect();
    const owner = await this.client.discoverOwner(threadId);
    if (owner && owner.ownerClientId !== this.client.clientId) throw new Error("Cannot claim a thread owned by another Codex client");
    const state = buildDesktopOwnerState(await this.runtime.readThread(engineSessionId));
    if (state.id !== threadId) throw new Error("Codex owner thread identity mismatch");
    const entry: OwnedThread = {
      engineSessionId, threadId,
      snapshot: { type: "snapshot", revision: 0, conversationState: state },
      encodedState: JSON.stringify(state),
      unregister: () => {}, refreshAgain: false,
      queuedFollowUps: [], retiredMessageIds: new Set(), queuedPermissionSettings: new Map(),
    };
    this.threads.set(threadId, entry);
    this.byEngineSession.set(engineSessionId, threadId);
    try {
      this.registerTransport(entry);
      this.startMetadataPolling();
    } catch (error) {
      this.threads.delete(threadId);
      this.byEngineSession.delete(engineSessionId);
      throw error;
    }
  }

  /** Re-register after IPC reconnect, without resuming or replacing native threads. */
  async reconnect(): Promise<void> {
    if (this.disposed) return;
    await this.client.connect();
    for (const entry of this.threads.values()) {
      const owner = await this.client.discoverOwner(entry.threadId);
      if (owner && owner.ownerClientId !== this.client.clientId) {
        this.unregisterThread(entry.threadId);
        this.reportError(entry, new Error("Another Codex client now owns this thread"));
        continue;
      }
      entry.unregister();
      await this.refresh(entry.threadId, false);
      this.registerTransport(entry);
      void this.drainQueue(entry).catch((error: unknown) => this.reportError(entry, error));
    }
  }

  unregisterThread(threadId: string): void {
    const entry = this.threads.get(threadId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.unregister();
    this.threads.delete(threadId);
    this.byEngineSession.delete(entry.engineSessionId);
    if (this.threads.size === 0 && this.metadataTimer) {
      clearInterval(this.metadataTimer);
      this.metadataTimer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    for (const id of [...this.threads.keys()]) this.unregisterThread(id);
    // Detaching a follower transport must not stop the runtime or its turns.
  }

  async refresh(threadId: string, publish = true): Promise<void> {
    const entry = this.requireThread(threadId);
    if (entry.refresh) {
      entry.refreshAgain = true;
      return entry.refresh;
    }
    entry.refresh = (async () => {
      do {
        entry.refreshAgain = false;
        const state = buildDesktopOwnerState(await this.runtime.readThread(entry.engineSessionId));
        if (this.threads.get(threadId) !== entry) return;
        if (state.id !== threadId) throw new Error("Codex owner thread identity changed");
        const encodedState = JSON.stringify(state);
        if (encodedState !== entry.encodedState) {
          entry.snapshot = { type: "snapshot", revision: entry.snapshot.revision + 1, conversationState: state };
          entry.encodedState = encodedState;
          if (publish) this.client.publishOwnedThreadState(threadId, entry.snapshot);
        }
      } while (entry.refreshAgain);
    })().finally(() => { entry.refresh = undefined; });
    return entry.refresh;
  }

  private startMetadataPolling(): void {
    if (!this.runtime.readMetadata || this.metadataTimer || this.disposed) return;
    this.metadataTimer = setInterval(() => { void this.pollTitles(); }, 2_000);
    this.metadataTimer.unref?.();
  }

  private async pollTitles(): Promise<void> {
    const readMetadata = this.runtime.readMetadata;
    if (!readMetadata || this.metadataPoll || this.disposed) return;
    this.metadataPoll = Promise.allSettled([...this.threads.values()].map(async (entry) => {
      try {
        const metadata = await readMetadata.call(this.runtime, entry.engineSessionId);
        if (this.disposed || this.threads.get(entry.threadId) !== entry) return;
        if (metadata.id !== entry.threadId) throw new Error("Codex title metadata returned a different thread");
        const title = text(metadata.name) ?? null;
        if (title !== entry.snapshot.conversationState.title) await this.refresh(entry.threadId);
      } catch (error) {
        if (!this.disposed && this.threads.get(entry.threadId) === entry) this.reportError(entry, error);
      }
    })).then(() => {});
    try { await this.metadataPoll; }
    finally { this.metadataPoll = undefined; }
  }

  private registerTransport(entry: OwnedThread): void {
    const supportedMethods = [...FOLLOWER_METHODS];
    if (this.runtime.updateSettings) supportedMethods.push("thread-follower-update-thread-settings");
    entry.unregister = this.client.registerOwnedThread({
      conversationId: entry.threadId,
      hostId: "local",
      supportedMethods,
      supportsUntrustedAppInput: false,
      clientName: "CodeMux",
      getSnapshot: () => entry.snapshot,
      getQueuedFollowUps: () => entry.queuedFollowUps,
      handleRequest: (method, params) => this.handleFollower(entry.threadId, method, params),
    });
  }

  private async handleFollower(threadId: string, method: DesktopFollowerMethod, params: Record<string, unknown>): Promise<unknown> {
    const entry = this.requireThread(threadId);
    if (params.conversationId !== threadId) throw new Error("Follower request thread identity mismatch");
    if (method === "thread-follower-set-queued-follow-ups-state") {
      const incoming = parseQueuedFollowUps(record(params.state)[threadId] ?? [], threadId);
      const discarded = params.discardedMessageIds ?? [];
      if (!Array.isArray(discarded) || discarded.some((id) => typeof id !== "string")) throw new Error("Invalid discarded Desktop message IDs");
      const permissionSettings = await Promise.all(incoming.map(async (message) => {
        if (!hasQueuedPermissionOverrides(message)) return [message.id, {}] as const;
        if (!this.runtime.resolveQueuedPermissions) throw new Error("Queued Desktop permission changes are not supported by this owner");
        return [message.id, await this.runtime.resolveQueuedPermissions(entry.engineSessionId, message)] as const;
      }));
      if (this.requireThread(threadId) !== entry) throw new Error("The Desktop queue owner changed during preparation");
      for (const [id, settings] of permissionSettings) entry.queuedPermissionSettings.set(id, settings);
      for (const id of discarded) entry.retiredMessageIds.add(id as string);
      const preserved = entry.queuedFollowUps.filter((message) => message.id === entry.admittingMessageId
        || (record(message.submission).status === "outcome-unknown" && !entry.retiredMessageIds.has(message.id)));
      const preservedIds = new Set(preserved.map((message) => message.id));
      entry.queuedFollowUps = [...preserved, ...incoming.filter((message) => !preservedIds.has(message.id) && !entry.retiredMessageIds.has(message.id))];
      this.publishQueue(entry);
      void this.drainQueue(entry).catch((error: unknown) => this.reportError(entry, error));
      return { ok: true };
    }
    if (method === "thread-follower-remove-queued-message" || method === "thread-follower-clear-queued-messages") {
      if (method === "thread-follower-remove-queued-message" && typeof params.messageId !== "string") throw new Error("Invalid queued Desktop message ID");
      entry.queuedFollowUps = entry.queuedFollowUps.filter((message) => {
        if (message.id === entry.admittingMessageId) return true;
        if (method === "thread-follower-remove-queued-message" && message.id !== params.messageId) return true;
        entry.retiredMessageIds.add(message.id);
        return false;
      });
      this.publishQueue(entry);
      return { ok: true };
    }
    if (method === "thread-follower-read-model-settings") {
      await this.refresh(threadId);
      const state = entry.snapshot.conversationState;
      return { settings: {
        model: state.latestModel, reasoningEffort: state.latestReasoningEffort,
        daybreakEnabled: null, resumeState: "resumed", mode: state.mode,
        threadSource: state.threadSource ?? null, modelProvider: state.modelProvider ?? null,
      } };
    }
    if (method === "thread-follower-load-complete-history") {
      await this.refresh(threadId);
      this.client.publishOwnedThreadState(threadId, entry.snapshot);
      return { revision: entry.snapshot.revision };
    }
    if (method === "thread-follower-start-turn") {
      const turnStart = record(params.turnStart);
      if (Array.isArray(record(turnStart.context).responseItems) && (record(turnStart.context).responseItems as unknown[]).length > 0) {
        throw new Error("Untrusted Desktop app input is not supported by this owner");
      }
      const request = record(turnStart.request);
      if (request.threadId != null && request.threadId !== threadId) throw new Error("Follower turn targets another thread");
      const result = await this.runtime.request(entry.engineSessionId, "turn/start", { ...request, threadId });
      await this.refresh(threadId);
      return { result };
    }
    if (method === "thread-follower-steer-turn" || method === "thread-follower-interrupt-turn") {
      await this.refresh(threadId);
      const active = records(entry.snapshot.conversationState.turns).findLast((turn) => turn.status === "inProgress");
      const activeTurnId = text(active?.turnId);
      if (method === "thread-follower-interrupt-turn") {
        if (!activeTurnId || (params.expectedTurnId != null && params.expectedTurnId !== activeTurnId)) return { ok: true, interruptedTurnId: null };
        await this.runtime.request(entry.engineSessionId, "turn/interrupt", { threadId, turnId: activeTurnId });
        if (params.mode === "user-stop") {
          for (const message of entry.queuedFollowUps) entry.retiredMessageIds.add(message.id);
          entry.queuedFollowUps = [];
          entry.queuedPermissionSettings.clear();
          this.publishQueue(entry);
        }
        await this.refresh(threadId);
        return { ok: true, interruptedTurnId: activeTurnId };
      }
      if (!activeTurnId) throw new Error("No active Codex turn to steer");
      if (params.toolOutput != null) throw new Error("Desktop dynamic tool outputs require their original runtime owner");
      const asyncQuestionReply = record(record(params.restoreMessage).context).turnTrigger === "send_user_message_async_question";
      if (asyncQuestionReply) {
        const replies = parseCodexAsyncQuestionReplies(params.input);
        const knownIds = new Set(records(active?.items).flatMap(getCodexAsyncQuestions).map((question) => question.id));
        if (!replies?.every((reply) => knownIds.has(reply.questionItemId))) {
          throw new Error("The asynchronous question no longer belongs to the active Codex turn");
        }
      }
      const result = await this.runtime.request(entry.engineSessionId, "turn/steer", {
        threadId, expectedTurnId: activeTurnId, input: params.input,
        ...(asyncQuestionReply ? { restoreMessage: { context: { turnTrigger: "send_user_message_async_question" } } } : {}),
        ...(params.clientUserMessageId != null ? { clientUserMessageId: params.clientUserMessageId } : {}),
        ...(params.additionalContext != null ? { additionalContext: params.additionalContext } : {}),
      });
      await this.refresh(threadId);
      return { result };
    }
    if (method === "thread-follower-compact-thread") {
      await this.runtime.request(entry.engineSessionId, "thread/compact/start", { threadId });
      await this.refresh(threadId);
      return { ok: true };
    }
    if (method === "thread-follower-update-thread-settings" && this.runtime.updateSettings) {
      const applied = await this.runtime.updateSettings(entry.engineSessionId, record(params.threadSettings), {
        activeTurnId: text(params.activeTurnId), condition: params.condition == null ? undefined : record(params.condition),
      });
      await this.refresh(threadId);
      return { applied };
    }
    const requestMethod = APPROVAL_REQUESTS[method];
    if (requestMethod) {
      const pending = records(entry.snapshot.conversationState.requests).find((request) => request.id === params.requestId && request.method === requestMethod);
      if (!pending) throw new Error("The Desktop approval request is no longer pending");
      const response = method === "thread-follower-command-approval-decision" || method === "thread-follower-file-approval-decision"
        ? { decision: params.decision } : params.response;
      await this.runtime.respond(entry.engineSessionId, pending.id as string | number, response);
      await this.refresh(threadId);
      return { ok: true };
    }
    throw new Error(`Unsupported Desktop follower method: ${method}`);
  }

  private publishQueue(entry: OwnedThread): void {
    if (this.threads.get(entry.threadId) === entry && !this.disposed) {
      this.client.publishOwnedQueuedFollowUps(entry.threadId, entry.queuedFollowUps);
    }
  }

  private drainQueue(entry: OwnedThread): Promise<void> {
    if (entry.queueDrain) return entry.queueDrain;
    if (entry.queuedFollowUps.length === 0) return Promise.resolve();
    entry.queueDrain = Promise.resolve().then(async () => {
      while (this.threads.get(entry.threadId) === entry && !this.disposed) {
        await this.refresh(entry.threadId);
        if (this.threads.get(entry.threadId) !== entry || this.disposed) return;
        const message = entry.queuedFollowUps[0];
        if (!message || record(message.submission).status === "outcome-unknown") return;
        const active = records(entry.snapshot.conversationState.turns).findLast((turn) => turn.status === "inProgress");
        const activeTurnId = text(active?.turnId);
        const sendNow = message.submissionIntent === "send-now" || record(message.submission).queueModeOverride === "send-now";
        if (activeTurnId && !sendNow) return;
        entry.admittingMessageId = message.id;
        entry.queuedFollowUps = entry.queuedFollowUps.map((queued) => queued.id === message.id
          ? { ...queued, submission: { ...record(queued.submission), hostId: "local", status: "sending" } } : queued);
        this.publishQueue(entry);
        try {
          const params = { ...queuedTurnRequest(entry.threadId, message), ...entry.queuedPermissionSettings.get(message.id) };
          await this.runtime.request(entry.engineSessionId, activeTurnId ? "turn/steer" : "turn/start", {
            ...params, ...(activeTurnId ? { expectedTurnId: activeTurnId } : {}),
          });
          // Admission, rather than receipt of the queue, is the point where the
          // original message can disappear from every follower's composer.
          entry.retiredMessageIds.add(message.id);
          entry.queuedPermissionSettings.delete(message.id);
          entry.queuedFollowUps = entry.queuedFollowUps.filter((queued) => queued.id !== message.id);
          this.publishQueue(entry);
        } catch (error) {
          // Delivery may have succeeded before an IPC timeout. Keep this exact
          // input visible and never retry it automatically as a second turn.
          entry.queuedFollowUps = entry.queuedFollowUps.map((queued) => queued.id === message.id
            ? { ...queued, submission: { ...record(queued.submission), status: "outcome-unknown" } } : queued);
          this.publishQueue(entry);
          this.reportError(entry, error);
          return;
        } finally {
          entry.admittingMessageId = undefined;
        }
      }
    }).finally(() => { entry.queueDrain = undefined; });
    return entry.queueDrain;
  }

  private requireThread(threadId: string): OwnedThread {
    const entry = this.threads.get(threadId);
    if (!entry || this.disposed) throw new Error("CodeMux does not own this Desktop thread");
    return entry;
  }

  private reportError(entry: OwnedThread, error: unknown): void {
    this.options.onError?.(entry.threadId, error instanceof Error ? error : new Error(String(error)));
  }
}

const APPROVAL_REQUESTS: Partial<Record<DesktopFollowerMethod, string>> = {
  "thread-follower-command-approval-decision": "item/commandExecution/requestApproval",
  "thread-follower-file-approval-decision": "item/fileChange/requestApproval",
  "thread-follower-permissions-request-approval-response": "item/permissions/requestApproval",
  "thread-follower-submit-user-input": "item/tool/requestUserInput",
  "thread-follower-submit-mcp-server-elicitation-response": "mcpServer/elicitation/request",
};
const FOLLOWER_METHODS: DesktopFollowerMethod[] = [
  "thread-follower-start-turn", "thread-follower-steer-turn", "thread-follower-interrupt-turn",
  "thread-follower-load-complete-history", "thread-follower-read-model-settings", "thread-follower-compact-thread",
  "thread-follower-set-queued-follow-ups-state", "thread-follower-remove-queued-message", "thread-follower-clear-queued-messages",
  ...Object.keys(APPROVAL_REQUESTS) as DesktopFollowerMethod[],
];

function parseQueuedFollowUps(value: unknown, threadId: string): DesktopQueuedFollowUp[] {
  if (!Array.isArray(value)) throw new Error("Invalid Desktop follow-up queue");
  const ids = new Set<string>();
  return value.map((candidate) => {
    const message = record(candidate);
    if (!text(message.id) || ids.has(message.id as string) || typeof message.text !== "string"
      || !Number.isFinite(message.createdAt) || (message.cwd != null && typeof message.cwd !== "string")
      || message.context == null || typeof message.context !== "object" || Array.isArray(message.context)) {
      throw new Error("Invalid queued Desktop message");
    }
    ids.add(message.id as string);
    const queued = structuredClone(message) as DesktopQueuedFollowUp;
    queuedTurnRequest(threadId, queued);
    return queued;
  });
}

function queuedTurnRequest(threadId: string, message: DesktopQueuedFollowUp): Record<string, unknown> {
  const context = message.context;
  const submission = record(message.submission);
  const options = record(message.submissionOptions);
  if (submission.hostId != null && submission.hostId !== "local") throw new Error("Queued Desktop input targets another host");
  if (context.messageThreadId != null && context.messageThreadId !== threadId) throw new Error("Queued Desktop input targets another thread");
  if (submission.editPosition != null) throw new Error("Editing an earlier Desktop turn is not supported by this owner");
  if (message.submissionIntent != null && !["queue", "start", "send-now"].includes(String(message.submissionIntent))) throw new Error("Unsupported Desktop submission intent");
  if (submission.queueModeOverride != null && !["queue", "queue-only", "send-now"].includes(String(submission.queueModeOverride))) throw new Error("Unsupported Desktop queue mode");
  for (const key of ["responseItems", "imageAttachments", "attachments", "fileAttachments", "appMentions", "writingBlockContexts"]) {
    if (Array.isArray(context[key]) && (context[key] as unknown[]).length > 0) throw new Error("Queued Desktop attachments require their original input preparation");
  }
  if (context.prompt != null && typeof context.prompt !== "string") throw new Error("Unsupported Desktop prompt content");
  return { threadId, input: [{ type: "text", text: typeof context.prompt === "string" ? context.prompt : message.text }], clientUserMessageId: message.id,
    ...(message.cwd ? { cwd: message.cwd } : {}),
    ...(typeof context.turnTrigger === "string" ? { turnTrigger: context.turnTrigger } : {}),
    ...(context.additionalContext != null ? { additionalContext: context.additionalContext } : {}),
    ...(message.responsesapiClientMetadata != null ? { responsesapiClientMetadata: message.responsesapiClientMetadata } : {}),
    ...(options.collaborationMode != null ? { collaborationMode: options.collaborationMode } : {}),
    ...(Object.hasOwn(options, "serviceTier") ? { serviceTier: options.serviceTier } : {}),
  };
}

function hasQueuedPermissionOverrides(message: DesktopQueuedFollowUp): boolean {
  const options = record(message.submissionOptions);
  return !!options.shouldSendPermissionOverrides || !!options.usePermissionSelection || message.context.workPermissions != null
    || (options.permissionSelection != null && record(options.permissionSelection).kind !== "server-default");
}

/** Uses the same legacy turn shape accepted by Desktop's v11 snapshot hydrator. */
export function buildDesktopOwnerState(native: NativeOwnedThreadState): Record<string, unknown> {
  const thread = native.thread;
  const id = text(thread.id);
  if (!id) throw new Error("Native Codex thread has no identity");
  const cwd = text(thread.cwd) ?? "";
  const collaborationMode = native.collaborationMode ?? {
    mode: "default", settings: { model: native.model, reasoning_effort: native.reasoningEffort ?? null, developer_instructions: null },
  };
  const settings = {
    cwd, model: native.model, effort: native.reasoningEffort ?? null, collaborationMode,
    serviceTier: native.serviceTier ?? null, approvalPolicy: native.approvalPolicy,
    sandboxPolicy: native.sandboxPolicy, permissions: native.permissions,
  };
  return {
    id, sessionId: text(thread.sessionId) ?? id, hostId: "local",
    title: text(thread.name) ?? null, cwd, createdAt: secondsToMillis(thread.createdAt), updatedAt: secondsToMillis(thread.updatedAt),
    forkedFromId: thread.forkedFromId ?? null, originator: thread.originator ?? "codemux",
    source: thread.source ?? "appServer", agentNickname: thread.agentNickname,
    threadSource: thread.threadSource, threadStartKind: "default", workspaceKind: "project",
    historyMode: thread.historyMode ?? "legacy",
    mode: "default", modelProvider: native.modelProvider ?? thread.modelProvider ?? "",
    latestModel: native.model, latestReasoningEffort: native.reasoningEffort ?? null,
    latestCollaborationMode: collaborationMode, latestThreadSettings: settings,
    currentPermissions: { approvalPolicy: native.approvalPolicy, sandboxPolicy: native.sandboxPolicy, permissions: native.permissions },
    resumeState: "resumed", hasUnreadTurn: false, threadGoal: null,
    threadRuntimeStatus: thread.status ?? { type: records(thread.turns).some((turn) => turn.status === "inProgress") ? "active" : "idle" },
    rolloutPath: thread.path ?? "", gitInfo: thread.gitInfo ?? null, latestTokenUsageInfo: native.latestTokenUsageInfo ?? null,
    requests: native.requests ?? [],
    turnsPagination: { olderCursor: null, oldestLoadedTurnId: null, isLoadingOlder: false, hasLoadedOldest: true },
    turns: records(thread.turns).map((turn) => {
      const first = records(turn.items).find((item) => item.type !== "contextCompaction");
      const turnState = typeof turn.id === "string" ? native.turnStateById?.[turn.id] : undefined;
      return {
        params: {
          ...settings, threadId: id, input: first?.type === "userMessage" ? first.content : [],
          clientUserMessageId: first?.type === "userMessage" ? first.clientId : undefined,
          summary: "none", personality: null, outputSchema: null, attachments: [],
        },
        permissionParamsSource: "inferred", turnId: turn.id, status: turn.status,
        turnStartedAtMs: turn.startedAt == null ? null : secondsToMillis(turn.startedAt),
        durationMs: turn.durationMs ?? null,
        finalAssistantStartedAtMs: turn.completedAt == null ? null : secondsToMillis(turn.completedAt),
        error: turn.error ?? null, diff: turnState?.diff ?? null, items: records(turn.items),
        ...(turnState?.completedItemIds != null ? { completedItemIds: { ...turnState.completedItemIds } } : {}),
        ...(turnState?.agentMessageCompletedAtMsById != null ? { agentMessageCompletedAtMsById: { ...turnState.agentMessageCompletedAtMsById } } : {}),
      };
    }),
  };
}

function record(value: unknown): Record<string, unknown> { return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function secondsToMillis(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value * 1000 : 0; }
