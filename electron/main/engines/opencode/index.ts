// ============================================================================
// OpenCode Adapter — Integration via @opencode-ai/sdk (v2)
//
// Uses the official SDK for all communication with the OpenCode server.
// No raw HTTP requests, no manual SSE parsing, no hand-maintained types.
// ============================================================================

import {
  createOpencodeClient,
  type OpencodeClient,
  type Session as SdkSession,
  type Event as SdkEvent,
  type GlobalEvent as SdkGlobalEvent,
  type Part as SdkPart,
  type QuestionRequest as SdkQuestionRequest,
} from "@opencode-ai/sdk/v2";
import { openCodeLog } from "../../services/logger";
import { CODEMUX_IDENTITY_PROMPT } from "../identity-prompt";
import { EngineAdapter } from "../engine-adapter";
import {
  convertSession,
  convertMessage,
  convertPart,
  convertProviders,
  type ModelPricing,
} from "./converters";
import {
  createOpencodeServer,
  fetchVersion,
  killOrphanedProcess,
} from "./server";
import type {
  EngineType,
  EngineStatus,
  EngineCapabilities,
  EngineInfo,
  AuthMethod,
  UnifiedSession,
  UnifiedMessage,
  UnifiedPart,
  UnifiedPermission,
  UnifiedQuestion,
  ModelListResult,
  UnifiedProject,
  AgentMode,
  MessagePromptContent,
  PermissionReply,
  PermissionOption,
  QuestionInfo,
  EngineCommand,
  CommandInvokeResult,
} from "../../../../src/types/unified";
import { OPENCODE_PORT } from "../../../../shared/ports";

/**
 * OpenCode Engine Adapter
 * Manages the OpenCode server process via SDK and communicates via SDK client.
 */
export class OpenCodeAdapter extends EngineAdapter {
  readonly engineType: EngineType = "opencode";

  private server: { url: string; close(): Promise<void> } | null = null;
  private port: number;
  private status: EngineStatus = "stopped";
  private lastError: string | undefined;
  private version: string | undefined;
  private connectedProviders: string[] = [];
  private client: OpencodeClient | null = null;

  // SSE event loop abort
  private sseAbortController: AbortController | null = null;

  // Cached state
  private sessions = new Map<string, UnifiedSession>();
  private currentDirectory: string | null = null;
  private cachedCommands: EngineCommand[] = [];

  // Message completion tracking: sessionId → array of pending entries.
  // The first entry is the "primary" (normal send), subsequent entries are
  // enqueued messages submitted while the engine was busy.
  // All entries are resolved together when the session becomes idle.
  private pendingMessages = new Map<string, Array<{
    resolve: (msg: UnifiedMessage) => void;
    messageId: string | null;
    assistantParts: UnifiedPart[];
    firstEventTimer: ReturnType<typeof setTimeout> | null;
    promptSent: boolean;
  }>>();

  // Cache of SDK parts by partID for applying message.part.delta increments
  private partCache = new Map<string, SdkPart>();

  // Cache of the last emitted assistant message per session, used to construct the
  // final message when session.status: idle arrives (see resolveSessionIdle).
  private lastEmittedMessage = new Map<string, UnifiedMessage>();

  // Track primary (first) user message IDs per session to avoid false-positive
  // queued.consumed emissions when the primary user message.updated arrives late.
  private primaryUserMsgIds = new Map<string, string>();

  // Track all user message IDs so handlePartUpdated/handlePartDelta can skip
  // emitting parts for user messages. Without this, the frontend creates
  // placeholder "assistant" messages for user-message parts, causing the
  // user's question to appear as an assistant reply.
  // Use a Map to track per-session to allow cleanup when sessions are deleted.
  private userMessageIds = new Map<string, Set<string>>(); // sessionId -> messageIds

  // Cached model pricing (per-million-token rates) keyed by "providerID/modelID"
  private modelPricing = new Map<string, ModelPricing>();

  /** Look up cached pricing for an SDK message's providerID/modelID */
  private getPricing(sdk: any): ModelPricing | undefined {
    if (!sdk.providerID || !sdk.modelID) return undefined;
    return this.modelPricing.get(`${sdk.providerID}/${sdk.modelID}`);
  }

  constructor(options?: { port?: number }) {
    super();
    this.port = options?.port ?? OPENCODE_PORT;
  }

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  // --- SDK client management ---

  private createClient(directory?: string): OpencodeClient {
    return createOpencodeClient({
      baseUrl: this.baseUrl,
      ...(directory ? { directory } : {}),
    });
  }

  private ensureClient(): OpencodeClient {
    if (!this.client) {
      this.client = this.createClient(this.currentDirectory ?? undefined);
    }
    return this.client;
  }

  /**
   * Recreate the client with a new directory context.
   * The SDK bakes the x-opencode-directory header into the client instance,
   * so we need a fresh client when switching directories.
   */
  private switchDirectory(directory: string): void {
    if (this.currentDirectory === directory && this.client) return;
    this.currentDirectory = directory;
    this.client = this.createClient(directory);
  }

  /**
   * Get a client scoped to a specific session's directory.
   * Falls back to ensureClient() if sessionId is unknown or has no directory.
   */
  private clientForSession(sessionId?: string): OpencodeClient {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session?.directory) {
        return this.createClient(session.directory);
      }
    }
    return this.ensureClient();
  }

  // --- SSE connection via SDK (global event stream, all projects) ---

  private connectSSE(): void {
    this.disconnectSSE();

    this.sseAbortController = new AbortController();
    const signal = this.sseAbortController.signal;

    // Global events don't need a directory — they receive events from all projects.
    // Use a bare client (no directory header) for SSE.
    const sseClient = this.createClient();

    const startStream = async () => {
      try {
        const result = await sseClient.global.event();

        for await (const globalEvent of result.stream) {
          if (signal.aborted) break;

          const event = globalEvent as SdkGlobalEvent;
          if (event?.payload) {
            this.handleSdkEvent(event.payload);
          }
        }
      } catch (err: any) {
        if (signal.aborted) return;
        openCodeLog.error("SSE stream error:", err?.message ?? err);
      }

      // Reconnect after delay if still running
      if (!signal.aborted && this.status === "running") {
        setTimeout(() => {
          if (!signal.aborted && this.status === "running") {
            this.connectSSE();
          }
        }, 2000);
      }
    };

    startStream();
  }

  private disconnectSSE(): void {
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }
  }

  // --- SSE event dispatch ---

  /** Clear the first-event timer for a session (called when any SSE event arrives) */
  private clearFirstEventTimer(sessionId: string): void {
    const entries = this.pendingMessages.get(sessionId);
    const primary = entries?.[0];
    if (primary?.firstEventTimer) {
      clearTimeout(primary.firstEventTimer);
      primary.firstEventTimer = null;
    }
  }

  private handleSdkEvent(event: SdkEvent): void {
    switch (event.type) {
      case "message.part.updated":
        this.handlePartUpdated(event.properties.part);
        break;

      case "message.part.delta":
        this.handlePartDelta(event.properties as any);
        break;

      case "message.updated":
        this.handleMessageUpdated(event.properties.info);
        break;

      case "session.updated":
        this.handleSessionUpdated(event.properties.info);
        break;

      case "session.created":
        this.handleSessionCreated(event.properties.info);
        break;

      case "permission.asked":
        this.handlePermissionAsked(event.properties);
        break;

      case "permission.replied":
        this.handlePermissionReplied(event.properties);
        break;

      case "question.asked":
        this.handleQuestionAsked(event.properties);
        break;

      case "question.replied":
        this.handleQuestionReplied(event.properties);
        break;

      case "question.rejected":
        this.handleQuestionRejected(event.properties);
        break;

      case "session.status":
        this.handleSessionStatus(event.properties as any);
        break;

      case "session.idle":
        this.handleSessionIdleEvent(event.properties as any);
        break;
    }
  }

  // --- SSE event handlers ---

  private handlePartUpdated(sdkPart: SdkPart): void {
    if (!sdkPart) return;

    const sessionID = (sdkPart as any).sessionID;
    const messageID = (sdkPart as any).messageID;
    const partID = (sdkPart as any).id;

    // Skip parts belonging to user messages — the frontend handles user text
    // via optimistic temp messages. Emitting user-message parts would cause
    // the frontend to create a placeholder "assistant" message for them.
    if (messageID && sessionID) {
      const sessionUserMsgIds = this.userMessageIds.get(sessionID);
      if (sessionUserMsgIds?.has(messageID)) return;
    }

    // First SSE event for this session — clear the first-event timeout
    if (sessionID) {
      this.clearFirstEventTimer(sessionID);
    }

    // Cache the SDK part for delta accumulation
    if (partID) {
      this.partCache.set(partID, { ...sdkPart });
    }

    const part = convertPart(this.engineType, sdkPart);
    this.emit("message.part.updated", {
      sessionId: sessionID,
      messageId: messageID,
      part,
    });

    // Track parts for pending messages and detect completion via step-finish
    if (sessionID) {
      const entries = this.pendingMessages.get(sessionID);
      const pending = entries?.[0];
      if (pending) {
        if (pending.messageId === null) {
          if (sdkPart.type === "step-start") {
            pending.messageId = messageID;
          }
        }

        if (pending.messageId && messageID === pending.messageId) {
          const existingIdx = pending.assistantParts.findIndex((p) => p.id === part.id);
          if (existingIdx >= 0) {
            pending.assistantParts[existingIdx] = part;
          } else {
            pending.assistantParts.push(part);
          }
        }
      }
    }
  }

  private handlePartDelta(props: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: string;
    delta: string;
  }): void {
    const { sessionID, messageID, partID, field, delta } = props;
    if (!sessionID || !partID) return;

    // Skip deltas for user message parts (same reason as handlePartUpdated)
    if (messageID && sessionID) {
      const sessionUserMsgIds = this.userMessageIds.get(sessionID);
      if (sessionUserMsgIds?.has(messageID)) return;
    }

    // First SSE event for this session — clear the first-event timeout
    this.clearFirstEventTimer(sessionID);

    // Get or create cached part
    let cached = this.partCache.get(partID);
    if (!cached) {
      // Part not seen yet — create a minimal placeholder based on field
      const placeholder = {
        type: field === "reasoning" ? "reasoning" : "text",
        id: partID,
        messageID,
        sessionID,
      } as SdkPart;
      if (field === "text" || field === "reasoning") {
        (placeholder as any)[field] = "";
      }
      this.partCache.set(partID, placeholder);
      cached = placeholder;
    }

    // Append delta to the specified field
    if (field in (cached as any)) {
      (cached as any)[field] = ((cached as any)[field] ?? "") + delta;
    } else {
      (cached as any)[field] = delta;
    }

    // Convert and re-emit as message.part.updated so the frontend receives
    // the accumulated text progressively
    const part = convertPart(this.engineType, cached);
    this.emit("message.part.updated", {
      sessionId: sessionID,
      messageId: messageID,
      part,
    });
  }

  private handleMessageUpdated(sdkMsg: any): void {
    const sessionID = sdkMsg?.sessionID;
    if (!sessionID) return;

    // First SSE event for this session — clear the first-event timeout
    this.clearFirstEventTimer(sessionID);

    // User messages: normally skipped (frontend handles them via optimistic insert).
    // However, when there are enqueued entries (entries.length > 1), a user message
    // from OpenCode means the engine has started processing a queued message.
    // We must distinguish the primary (first) user message from truly queued ones
    // to avoid emitting queued.consumed for the primary user message update.
    if (sdkMsg.role === "user") {
      // Track user message ID so handlePartUpdated/handlePartDelta skip its parts.
      if (!this.userMessageIds.has(sessionID)) {
        this.userMessageIds.set(sessionID, new Set());
      }
      this.userMessageIds.get(sessionID)!.add(sdkMsg.id);

      const entries = this.pendingMessages.get(sessionID);
      if (entries && entries.length > 1) {
        const knownPrimary = this.primaryUserMsgIds.get(sessionID);
        if (!knownPrimary) {
          // First user message.updated for this queue — record as primary, skip.
          this.primaryUserMsgIds.set(sessionID, sdkMsg.id);
        } else if (sdkMsg.id !== knownPrimary) {
          // A different user message while queue is active — truly queued consumption.
          this.emit("message.queued.consumed", {
            sessionId: sessionID,
            messageId: sdkMsg.id,
          });
          // Emit message.updated for the queued user message so the frontend
          // creates the user bubble (the enqueue path doesn't create an optimistic
          // temp message — it stores the text in a preview queue instead).
          const userMessage = convertMessage(this.engineType, sdkMsg);
          this.emit("message.updated", {
            sessionId: sessionID,
            message: userMessage,
          });
        }
        // If sdkMsg.id === knownPrimary, it's a repeated update for the primary — skip.
      }
      return;
    }

    const message = convertMessage(this.engineType, sdkMsg, this.getPricing(sdkMsg));

    if (sdkMsg.role === "assistant") {
      const entries = this.pendingMessages.get(sessionID);
      const pending = entries?.[0];
      if (pending) {
        // Track the message ID for this pending turn
        if (pending.messageId === null || pending.messageId === sdkMsg.id) {
          pending.messageId = sdkMsg.id;
        }

        if (sdkMsg.time?.completed || sdkMsg.error) {
          // Cache the full message for resolveSessionIdle to use later.
          // DON'T resolve the pending promise here — wait for session.status: idle
          // which is the authoritative signal that the entire agent loop has finished.
          // Resolving here causes the stop button to disappear prematurely when
          // intermediate assistant messages complete during multi-step agent loops.
          this.lastEmittedMessage.set(sessionID, message);

          // Emit a stripped copy without time.completed and error so the frontend
          // (Chat.tsx:899-904) doesn't clear the sending state prematurely.
          const strippedMessage: UnifiedMessage = {
            ...message,
            time: { created: message.time.created },
            error: undefined,
          };
          this.emit("message.updated", {
            sessionId: sessionID,
            message: strippedMessage,
          });
          return;
        }
      }
    }

    this.emit("message.updated", {
      sessionId: sessionID,
      message,
    });
  }

  private handleSessionStatus(data: { sessionID: string; status: { type: string } }): void {
    const sessionID = data?.sessionID;
    if (!sessionID) return;

    if (data.status?.type === "idle") {
      this.resolveSessionIdle(sessionID);
    }
  }

  private handleSessionIdleEvent(data: { sessionID: string }): void {
    const sessionID = data?.sessionID;
    if (!sessionID) return;

    // session.idle is the deprecated form of session.status: idle.
    // Both are emitted by OpenCode — handle whichever arrives first.
    this.resolveSessionIdle(sessionID);
  }

  /**
   * Called when OpenCode signals that a session's agent loop has fully completed.
   * This is the authoritative "turn done" signal — resolves ALL pending sendMessage
   * promises (including enqueued ones) and emits the final message with time.completed
   * to the frontend.
   */
  private resolveSessionIdle(sessionID: string): void {
    const entries = this.pendingMessages.get(sessionID);
    if (!entries || entries.length === 0) return;

    // Ignore idle events that arrive before promptAsync has been sent.
    // This happens when the pre-prompt abort triggers a session.status: idle
    // SSE event that races with the pending entry registration.
    const primary = entries[0];
    if (!primary.promptSent) return;

    // Clear all timers across all entries
    for (const entry of entries) {
      if (entry.firstEventTimer) clearTimeout(entry.firstEventTimer);
    }
    this.pendingMessages.delete(sessionID);
    this.primaryUserMsgIds.delete(sessionID);

    // Use the last cached message (which has the real time.completed from OpenCode),
    // or fall back to constructing one from accumulated parts.
    const cachedMessage = this.lastEmittedMessage.get(sessionID);
    this.lastEmittedMessage.delete(sessionID);

    const finalMessage: UnifiedMessage = cachedMessage
      ? { ...cachedMessage, time: { ...cachedMessage.time, completed: cachedMessage.time.completed ?? Date.now() } }
      : {
          id: primary.messageId ?? "",
          sessionId: sessionID,
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
          parts: primary.assistantParts,
        };

    // Clear part cache for this session
    for (const [partID, part] of this.partCache.entries()) {
      if ((part as any).sessionID === sessionID) {
        this.partCache.delete(partID);
      }
    }

    // Re-emit the final message WITH time.completed so the frontend clears
    // the sending state. The earlier emission (handleMessageUpdated) was
    // stripped of time.completed to prevent premature state clearing during
    // multi-step agent loops.
    this.emit("message.updated", {
      sessionId: sessionID,
      message: finalMessage,
    });

    // Resolve ALL pending entries — primary and enqueued — with the final message.
    // OpenCode processes all queued messages in one loop, so they all complete together.
    for (const entry of entries) {
      entry.resolve(finalMessage);
    }
  }

  private handleSessionUpdated(sdkSession: SdkSession): void {
    const session = convertSession(this.engineType, sdkSession);
    this.sessions.set(session.id, session);
    this.emit("session.updated", { session });
  }

  private handleSessionCreated(sdkSession: SdkSession): void {
    const session = convertSession(this.engineType, sdkSession);
    this.sessions.set(session.id, session);
    this.emit("session.created", { session });
  }

  private handlePermissionAsked(data: any): void {
    const options: PermissionOption[] = [
      { id: "once", label: "Allow once", type: "accept_once" },
      { id: "always", label: "Always allow", type: "accept_always" },
      { id: "reject", label: "Reject", type: "reject" },
    ];

    const permission: UnifiedPermission = {
      id: data.id,
      sessionId: data.sessionID,
      engineType: this.engineType,
      toolCallId: data.callID,
      title: data.title ?? data.type ?? "Permission request",
      kind: "edit",
      rawInput: data.metadata,
      options,
      permission: data.type,
      patterns: data.pattern ? (Array.isArray(data.pattern) ? data.pattern : [data.pattern]) : [],
    };

    this.emit("permission.asked", { permission });
  }

  private handlePermissionReplied(data: any): void {
    this.emit("permission.replied", {
      permissionId: data.permissionID ?? data.id,
      optionId: data.response ?? "unknown",
    });
  }

  private handleQuestionAsked(data: SdkQuestionRequest): void {
    const questions: QuestionInfo[] = (data.questions || []).map((q) => ({
      question: q.question,
      header: q.header,
      options: (q.options || []).map((o) => ({
        label: o.label,
        description: o.description,
      })),
      multiple: q.multiple,
      custom: q.custom,
    }));

    const question: UnifiedQuestion = {
      id: data.id,
      sessionId: data.sessionID,
      engineType: this.engineType,
      toolCallId: data.tool?.callID,
      questions,
    };

    this.emit("question.asked", { question });
  }

  private handleQuestionReplied(data: any): void {
    this.emit("question.replied", {
      questionId: data.requestID ?? data.id,
      answers: data.answers ?? [],
    });
  }

  private handleQuestionRejected(data: any): void {
    this.emit("question.replied", {
      questionId: data.requestID ?? data.id,
      answers: [],
    });
  }

  // --- EngineAdapter Implementation ---

  async start(): Promise<void> {
    if (this.server) return;

    this.status = "starting";
    this.lastError = undefined;
    this.emit("status.changed", { engineType: this.engineType, status: this.status });

    // Use SDK to spawn and manage the OpenCode server process
    try {
      // Clean up any orphaned opencode process on our port (e.g. from a previous crash)
      await killOrphanedProcess(this.port);

      this.server = await createOpencodeServer({
        hostname: "127.0.0.1",
        port: this.port,
        timeout: 15000,
        config: {
          server: {
            cors: ["*"],
          },
        },
      });
      openCodeLog.info(`OpenCode server started at ${this.server.url}`);
    } catch (err: any) {
      this.status = "error";
      this.lastError = err.message;
      this.emit("status.changed", {
        engineType: this.engineType,
        status: "error",
        error: err.message,
      });
      throw err;
    }

    // Initialize the SDK client
    this.client = this.createClient();

    // Start SSE event stream (global, all projects)
    this.connectSSE();

    // Fetch initial provider data via SDK
    try {
      const providerResult = await this.ensureClient().provider.list();
      if (providerResult.data) {
        const connected = providerResult.data.connected ?? [];
        this.connectedProviders = providerResult.data.all
          .filter(p => connected.includes(p.id))
          .map(p => p.name);
        openCodeLog.info(`Connected providers: ${this.connectedProviders.join(", ") || "none"}`);
      }
    } catch {
      // Provider fetch may fail initially, will retry on listModels()
    }

    // Fetch CLI version
    try {
      this.version = await fetchVersion();
    } catch {
      // Version fetch is non-critical
    }

    this.status = "running";
    this.emit("status.changed", { engineType: this.engineType, status: "running" });

    // Fetch initial commands for slash command support
    this.fetchCommands().catch(err => {
      openCodeLog.warn("Failed to fetch initial commands:", err);
    });
  }

  async stop(): Promise<void> {
    this.disconnectSSE();

    if (this.server) {
      await this.server.close();
      this.server = null;
    }

    this.status = "stopped";
    this.emit("status.changed", { engineType: this.engineType, status: "stopped" });
    this.client = null;

    // Reject any pending messages
    for (const [sessionId, entries] of this.pendingMessages) {
      for (const entry of entries) {
        if (entry.firstEventTimer) clearTimeout(entry.firstEventTimer);
        entry.resolve({
          id: entry.messageId ?? "",
          sessionId,
          role: "assistant",
          time: { created: Date.now() },
          parts: entry.assistantParts,
          error: "Engine stopped",
        });
      }
    }
    this.pendingMessages.clear();
    this.lastEmittedMessage.clear();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.ensureClient().global.health();
      return !!result.data;
    } catch {
      return false;
    }
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getInfo(): EngineInfo {
    const hasProviders = this.connectedProviders.length > 0;
    return {
      type: this.engineType,
      name: "OpenCode",
      version: this.version,
      status: this.status,
      capabilities: this.getCapabilities(),
      authenticated: hasProviders,
      authMessage: hasProviders
        ? this.connectedProviders.join(", ")
        : undefined,
      errorMessage: this.status === "error" ? this.lastError : undefined,
    };
  }

  getCapabilities(): EngineCapabilities {
    return {
      providerModelHierarchy: true,
      dynamicModes: false,
      messageCancellation: true,
      permissionAlways: true,
      imageAttachment: true,
      loadSession: true,
      listSessions: true,
      modelSwitchable: true,
      customModelInput: false,
      messageEnqueue: true,
      slashCommands: true,
      availableModes: this.getModes(),
    };
  }

  getAuthMethods(): AuthMethod[] {
    return []; // OpenCode uses env-based auth (API keys)
  }

  // --- Sessions ---

  async createSession(directory: string): Promise<UnifiedSession> {
    this.switchDirectory(directory);

    const client = this.ensureClient();
    const result = await client.session.create({ directory });
    if (result.error) {
      throw new Error(`Failed to create session: ${JSON.stringify(result.error)}`);
    }

    const session = convertSession(this.engineType, result.data);
    this.sessions.set(session.id, session);
    return session;
  }

  async listSessions(directory?: string): Promise<UnifiedSession[]> {
    // When a specific directory is provided, list sessions for that project only.
    if (directory) {
      return this.listSessionsForDirectory(directory);
    }

    // No directory — list sessions across ALL known projects.
    // OpenCode requires a project directory context for session.list(),
    // so we fetch the project list first, then list sessions per-project.
    try {
      const projects = await this.listProjects();
      if (projects.length === 0) {
        return [];
      }

      const allSessions: UnifiedSession[] = [];
      for (const project of projects) {
        try {
          const sessions = await this.listSessionsForDirectory(project.directory);
          allSessions.push(...sessions);
        } catch (err: any) {
          openCodeLog.warn(`Failed to list sessions for project ${project.directory}:`, err?.message);
        }
      }

      return allSessions;
    } catch (err: any) {
      openCodeLog.warn("Failed to list projects for session enumeration:", err?.message);
      return [];
    }
  }

  private async listSessionsForDirectory(directory: string): Promise<UnifiedSession[]> {
    const client = this.createClient(directory);
    const result = await client.session.list({ directory });
    if (result.error) {
      throw new Error(`Failed to list sessions: ${JSON.stringify(result.error)}`);
    }

    const sessions = (result.data ?? []).map((sdk: SdkSession) => {
      const session = convertSession(this.engineType, sdk);
      this.sessions.set(session.id, session);
      return session;
    });
    return sessions;
  }

  async getSession(sessionId: string): Promise<UnifiedSession | null> {
    // Try cache first
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;

    try {
      const client = this.clientForSession(sessionId);
      const result = await client.session.get({ sessionID: sessionId });
      if (result.error) return null;

      const session = convertSession(this.engineType, result.data);
      this.sessions.set(session.id, session);
      return session;
    } catch {
      return null;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Use the session's directory to create a client with the correct project context
    const session = this.sessions.get(sessionId);
    const client = session?.directory
      ? this.createClient(session.directory)
      : this.ensureClient();
    await client.session.delete({ sessionID: sessionId });
    this.sessions.delete(sessionId);

    // Clean up user message IDs for this session to prevent memory leak
    this.userMessageIds.delete(sessionId);
  }

  /** Push a renamed title to OpenCode via session.update. */
  async renameSession(sessionId: string, title: string, directory?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const dir = directory ?? session?.directory;
    const client = dir ? this.createClient(dir) : this.ensureClient();
    try {
      await client.session.update({
        sessionID: sessionId,
        ...(dir ? { directory: dir } : {}),
        title,
      });
    } catch (err) {
      // Don't surface — local rename already succeeded
      openCodeLog.warn(`session.update title failed for ${sessionId}:`, err);
    }
  }

  // --- Messages ---

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: { mode?: string; modelId?: string; directory?: string },
  ): Promise<UnifiedMessage> {
    const session = this.sessions.get(sessionId);

    // Build prompt parts — text and image
    const parts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; url: string; filename?: string }> = [];
    for (const c of content) {
      if (c.type === "text" && c.text) {
        parts.push({ type: "text" as const, text: c.text });
      } else if (c.type === "image" && c.data) {
        const mime = c.mimeType ?? "image/png";
        parts.push({
          type: "file" as const,
          mime,
          url: `data:${mime};base64,${c.data}`,
          filename: "image.png",
        });
      }
    }
    if (parts.length === 0) {
      parts.push({ type: "text" as const, text: "" });
    }

    // Build model spec if provided
    let model: { providerID: string; modelID: string } | undefined;
    if (options?.modelId) {
      const slashIdx = options.modelId.indexOf("/");
      if (slashIdx > 0) {
        model = {
          providerID: options.modelId.slice(0, slashIdx),
          modelID: options.modelId.slice(slashIdx + 1),
        };
      }
    }

    const dir = session?.directory ?? options?.directory ?? this.currentDirectory ?? undefined;

    // --- Enqueue path: engine is already processing this session ---
    const existingEntries = this.pendingMessages.get(sessionId);
    if (existingEntries && existingEntries.length > 0) {
      const client = dir ? this.createClient(dir) : this.ensureClient();

      // Skip abort — submit directly to OpenCode's native queue.
      // OpenCode persists the user message to DB immediately; the running
      // agent loop discovers it via `lastUser.id > lastAssistant.id`.
      const promptResult = await client.session.promptAsync({
        sessionID: sessionId,
        directory: dir,
        parts,
        agent: options?.mode,
        model,
        system: CODEMUX_IDENTITY_PROMPT,
      });

      const promptError = (promptResult as any).error;
      if (promptError) {
        const errMsg = typeof promptError === "string"
          ? promptError
          : JSON.stringify(promptError);
        throw new Error(`Failed to enqueue message: ${errMsg}`);
      }

      // Create a promise that resolves when the session becomes idle
      const queuePosition = existingEntries.length;
      const messagePromise = new Promise<UnifiedMessage>((resolve) => {
        const entry = {
          resolve,
          messageId: null as string | null,
          assistantParts: [] as UnifiedPart[],
          firstEventTimer: null as ReturnType<typeof setTimeout> | null,
          promptSent: true,
        };
        existingEntries.push(entry);
      });

      // Emit queue event for the frontend
      this.emit("message.queued", {
        sessionId,
        messageId: "", // Engine assigns the real ID
        queuePosition,
      });

      openCodeLog.info(`Message enqueued for session ${sessionId} (position ${queuePosition})`);
      return messagePromise;
    }

    // --- Normal path: session is idle ---

    // Pre-prompt abort: clear any residual unfinished state in OpenCode.
    // This is harmless if the session is already idle, but critical for sessions
    // that were left in a "busy" state after a previous cancel or crash.
    // IMPORTANT: Must happen BEFORE registering the pending entry, otherwise the
    // abort's "session.status: idle" SSE event would consume the pending entry,
    // causing subsequent SSE events to bypass the stripping logic in
    // handleMessageUpdated (L515-543), which results in premature time.completed
    // emissions and broken step visibility in the UI.
    const client = dir ? this.createClient(dir) : this.ensureClient();
    await client.session.abort({ sessionID: sessionId }).catch(() => {});

    // Create a promise that will be resolved when SSE delivers step-finish or message.updated
    const messagePromise = new Promise<UnifiedMessage>((resolve) => {
      const entry = {
        resolve,
        messageId: null as string | null,
        assistantParts: [] as UnifiedPart[],
        firstEventTimer: null as ReturnType<typeof setTimeout> | null,
        promptSent: false,
      };
      this.pendingMessages.set(sessionId, [entry]);
    });

    // Fire async prompt via SDK (returns 204, response comes via SSE)
    const promptResult = await client.session.promptAsync({
      sessionID: sessionId,
      directory: dir,
      parts,
      agent: options?.mode,
      model,
      system: CODEMUX_IDENTITY_PROMPT,
    });

    // SDK uses ThrowOnError=false by default, so errors are returned in the result
    // rather than thrown. If promptAsync failed, clean up and throw immediately
    // instead of waiting for SSE (which will never arrive).
    const promptError = (promptResult as any).error;
    if (promptError) {
      const entries = this.pendingMessages.get(sessionId);
      if (entries) {
        for (const e of entries) {
          if (e.firstEventTimer) clearTimeout(e.firstEventTimer);
        }
      }
      this.pendingMessages.delete(sessionId);
      this.primaryUserMsgIds.delete(sessionId);
      const errMsg = typeof promptError === "string"
        ? promptError
        : JSON.stringify(promptError);
      throw new Error(`Failed to send message: ${errMsg}`);
    }

    // Start first-event timer: if no SSE event arrives within 30s, the session
    // is likely stale (e.g., left in busy state after a crash or failed abort).
    const entries = this.pendingMessages.get(sessionId);
    const pending = entries?.[0];
    if (pending) {
      // Mark prompt as sent so resolveSessionIdle knows this idle event is real
      // (not from the pre-prompt abort).
      pending.promptSent = true;

      pending.firstEventTimer = setTimeout(() => {
        const currentEntries = this.pendingMessages.get(sessionId);
        if (currentEntries && currentEntries.length > 0) {
          openCodeLog.warn(`No SSE response within 30s for session ${sessionId} — session may be stale`);
          // Resolve all entries as stale
          for (const e of currentEntries) {
            e.resolve({
              id: "",
              sessionId,
              role: "assistant",
              time: { created: Date.now() },
              parts: [],
              error: "No response from engine",
              staleSession: true,
            });
          }
          this.pendingMessages.delete(sessionId);
          this.primaryUserMsgIds.delete(sessionId);
        }
      }, 30_000);
    }

    // Wait for SSE to deliver the complete assistant response
    return messagePromise;
  }

  async cancelMessage(sessionId: string, directory?: string): Promise<void> {
    // Fire abort via SDK to kill running processes ASAP.
    // Don't add to cancelledSessions — let OpenCode's abort response (message.updated
    // with error + session.status: idle) flow through SSE naturally so the frontend
    // gets the correct error state. The cancelledSessions mechanism would block these
    // events, leaving the frontend without an error banner or completed timestamp.
    // Use the session's directory to create a client with the correct project context.
    // OpenCode's state is scoped per-directory — sending abort with the wrong directory
    // causes SessionPrompt.cancel() to silently miss the session's AbortController.
    const session = this.sessions.get(sessionId);
    const dir = session?.directory ?? directory;
    const client = dir
      ? this.createClient(dir)
      : this.ensureClient();
    client.session.abort({ sessionID: sessionId }).catch((err: any) => {
      openCodeLog.warn("cancelMessage abort call failed:", err);
    });

    // Remove ALL pending entries so that subsequent SSE events (the abort error
    // message, session.status: idle) are NOT suppressed by handleMessageUpdated's
    // stripping logic (which only activates when pending entries exist).
    const entries = this.pendingMessages.get(sessionId);
    if (entries && entries.length > 0) {
      for (const entry of entries) {
        if (entry.firstEventTimer) clearTimeout(entry.firstEventTimer);
      }
      this.pendingMessages.delete(sessionId);
      this.primaryUserMsgIds.delete(sessionId);
      this.lastEmittedMessage.delete(sessionId);

      // Resolve ALL pending promises immediately so the UI unblocks.
      // The actual error/completed state will arrive via SSE shortly.
      const primary = entries[0];
      for (const entry of entries) {
        entry.resolve({
          id: primary.messageId ?? "",
          sessionId,
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
          parts: primary.assistantParts,
          error: "Cancelled",
        });
      }
    }
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    const client = this.clientForSession(sessionId);
    const result = await client.session.messages({ sessionID: sessionId });
    if (result.error) {
      throw new Error(`Failed to list messages: ${JSON.stringify(result.error)}`);
    }

    // SDK returns Array<{ info: Message, parts: Part[] }>
    return (result.data ?? []).map((wrapper: any) => {
      const msg = wrapper.info ?? wrapper;
      if (wrapper.parts && (!msg.parts || msg.parts.length === 0)) {
        msg.parts = wrapper.parts;
      }
      return convertMessage(this.engineType, msg, this.getPricing(msg));
    });
  }

  async getHistoricalMessages(
    engineSessionId: string,
    directory: string,
  ): Promise<UnifiedMessage[]> {
    const client = this.createClient(directory);
    const result = await client.session.messages({ sessionID: engineSessionId });
    if (result.error) {
      throw new Error(`Failed to list messages: ${JSON.stringify(result.error)}`);
    }
    return (result.data ?? []).map((wrapper: any) => {
      const msg = wrapper.info ?? wrapper;
      if (wrapper.parts && (!msg.parts || msg.parts.length === 0)) {
        msg.parts = wrapper.parts;
      }
      return convertMessage(this.engineType, msg, this.getPricing(msg));
    });
  }

  // --- Models ---

  async listModels(): Promise<ModelListResult> {
    const client = this.ensureClient();
    const result = await client.provider.list();
    if (result.error || !result.data) {
      throw new Error(`Failed to list providers: ${JSON.stringify(result.error)}`);
    }
    const models = convertProviders(this.engineType, result.data);
    // Cache pricing for cost calculation in convertMessage
    for (const m of models) {
      if (m.cost) {
        this.modelPricing.set(m.modelId, {
          input: m.cost.input,
          output: m.cost.output,
          cacheRead: m.cost.cache?.read ?? 0,
          cacheWrite: m.cost.cache?.write ?? 0,
        });
      }
    }
    return { models };
  }

  async setModel(_sessionId: string, _modelId: string): Promise<void> {
    // OpenCode doesn't have per-session model switching via API
    // Model is specified per-message in sendMessage()
  }

  // --- Modes ---

  getModes(): AgentMode[] {
    return [
      { id: "build", label: "Build", description: "Default build mode" },
      { id: "plan", label: "Plan", description: "Planning mode — no file changes" },
    ];
  }

  async setMode(_sessionId: string, _modeId: string): Promise<void> {
    // Mode is specified per-message via agent field
  }

  // --- Permissions ---

  async replyPermission(permissionId: string, reply: PermissionReply, sessionId?: string): Promise<void> {
    let replyValue: "once" | "always" | "reject";
    switch (reply.optionId) {
      case "once":
      case "accept_once":
      case "allow_once":
        replyValue = "once";
        break;
      case "always":
      case "accept_always":
      case "allow_always":
        replyValue = "always";
        break;
      default:
        replyValue = "reject";
        break;
    }

    // Use the session's directory for correct client context
    const client = this.clientForSession(sessionId);
    await client.permission.reply({
      requestID: permissionId,
      reply: replyValue,
    });

    this.emit("permission.replied", {
      permissionId,
      optionId: reply.optionId,
    });
  }

  // --- Questions ---

  async replyQuestion(questionId: string, answers: string[][], sessionId?: string): Promise<void> {
    // Use the session's directory for correct client context
    const client = this.clientForSession(sessionId);
    await client.question.reply({
      requestID: questionId,
      answers,
    });

    this.emit("question.replied", {
      questionId,
      answers,
    });
  }

  async rejectQuestion(questionId: string, sessionId?: string): Promise<void> {
    // Use the session's directory for correct client context
    const client = this.clientForSession(sessionId);
    await client.question.reject({
      requestID: questionId,
    });

    this.emit("question.replied", {
      questionId,
      answers: [],
    });
  }

  // --- Projects ---

  async listProjects(): Promise<UnifiedProject[]> {
    try {
      const client = this.ensureClient();
      const result = await client.project.list();
      if (result.error) return [];

      return (result.data ?? []).map((p) => ({
        id: p.id,
        directory: p.worktree.replaceAll("\\", "/"),
        name: p.name,
        engineType: this.engineType,
        engineMeta: { icon: p.icon },
      }));
    } catch {
      return [];
    }
  }

  // --- Slash Commands ---

  private async fetchCommands(): Promise<void> {
    try {
      const client = this.ensureClient();
      const result = await client.command.list({
        directory: this.currentDirectory ?? undefined,
      });
      const commands = result.data ?? [];
      if (Array.isArray(commands)) {
        this.cachedCommands = commands.map((cmd) => ({
          name: cmd.name,
          description: cmd.description ?? "",
          argumentHint: cmd.template ? `<${cmd.template}>` : undefined,
        }));
        this.emit("commands.changed", {
          engineType: this.engineType,
          commands: this.cachedCommands,
        });
      }
    } catch (err) {
      openCodeLog.warn("Failed to list commands:", err);
    }
  }

  override async listCommands(_sessionId?: string): Promise<EngineCommand[]> {
    return this.cachedCommands;
  }

  override async invokeCommand(
    sessionId: string,
    commandName: string,
    args: string,
    options?: { mode?: string; modelId?: string; directory?: string },
  ): Promise<CommandInvokeResult> {
    const session = this.sessions.get(sessionId);
    const dir = session?.directory ?? options?.directory ?? this.currentDirectory ?? undefined;
    const client = dir ? this.createClient(dir) : this.ensureClient();

    // Build model spec if provided
    let model: { providerID: string; modelID: string } | undefined;
    if (options?.modelId) {
      const slashIdx = options.modelId.indexOf("/");
      if (slashIdx > 0) {
        model = {
          providerID: options.modelId.slice(0, slashIdx),
          modelID: options.modelId.slice(slashIdx + 1),
        };
      }
    }

    try {
      const result = await client.session.command({
        sessionID: sessionId,
        directory: dir,
        command: commandName,
        arguments: args,
        agent: options?.mode,
        model: model ? `${model.providerID}/${model.modelID}` : undefined,
      });

      if (result.error) {
        throw new Error(`Command failed: ${JSON.stringify(result.error)}`);
      }

      // OpenCode command responses flow through SSE events (message.part.updated, etc.)
      // just like regular promptAsync responses. We need to wait for the session to
      // become idle, similar to sendMessage().
      // For now, fall back to sendMessage with the command as text, since the SSE
      // event handling is already wired up for that flow.
      return { handledAsCommand: false };
    } catch (err) {
      openCodeLog.warn(`Command /${commandName} failed, falling back to sendMessage:`, err);
      return { handledAsCommand: false };
    }
  }
}
