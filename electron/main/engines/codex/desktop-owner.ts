import type {
  CodexDesktopIpcClient, DesktopFollowerMethod, DesktopThreadSnapshot,
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
}

type OwnerTransport = Pick<CodexDesktopIpcClient,
  "connect" | "clientId" | "discoverOwner" | "registerOwnedThread" | "publishOwnedThreadState">;

interface OwnedThread {
  engineSessionId: string;
  threadId: string;
  snapshot: DesktopThreadSnapshot;
  encodedState: string;
  unregister: () => void;
  refresh?: Promise<void>;
  refreshAgain: boolean;
  timer?: ReturnType<typeof setTimeout>;
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
        void this.refresh(thread.threadId).catch((error: unknown) => this.reportError(thread, error));
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
      getSnapshot: () => entry.snapshot,
      handleRequest: (method, params) => this.handleFollower(entry.threadId, method, params),
    });
  }

  private async handleFollower(threadId: string, method: DesktopFollowerMethod, params: Record<string, unknown>): Promise<unknown> {
    const entry = this.requireThread(threadId);
    if (params.conversationId !== threadId) throw new Error("Follower request thread identity mismatch");
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
  ...Object.keys(APPROVAL_REQUESTS) as DesktopFollowerMethod[],
];

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
