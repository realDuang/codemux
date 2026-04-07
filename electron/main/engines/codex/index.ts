// ============================================================================
// Codex Engine Adapter
//
// Integrates the OpenAI Codex CLI via its app-server protocol (JSON-RPC over
// stdio). Follows the same patterns as OpenCode/Copilot/Claude adapters.
// ============================================================================

import type {
  EngineType,
  EngineStatus,
  EngineCapabilities,
  EngineInfo,
  AuthMethod,
  UnifiedSession,
  UnifiedMessage,
  ModelListResult,
  UnifiedModelInfo,
  UnifiedProject,
  AgentMode,
  MessagePromptContent,
  PermissionReply,
  ReasoningEffort,
  ImportableSession,
  ToolPart,
} from "../../../../src/types/unified";
import { EngineAdapter, type MessageBuffer } from "../engine-adapter";
import { CodexJsonRpcClient } from "./jsonrpc-client";
import {
  resolveCodexCliPath,
  buildStartupArgs,
  modeToApprovalPolicy,
  CODEX_MODES,
  CODEX_DEFAULT_MODEL,
  CODEX_MODEL_LIST,
} from "./config";
import {
  appendTextDelta,
  appendReasoningDelta,
  createToolPart,
  completeToolPart,
  createStepFinish,
  convertApprovalToPermission,
  convertConfirmationToQuestion,
  finalizeBufferToMessage,
  createUserMessage,
  upsertPart,
  convertThreadItemsToMessages,
} from "./converters";
import { CODEMUX_IDENTITY_PROMPT } from "../identity-prompt";
import { timeId } from "../../utils/id-gen";
import { codexLog } from "../../services/logger";

// ============================================================================
// Constants
// ============================================================================

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2000;

// ============================================================================
// Types
// ============================================================================

interface ThreadInfo {
  threadId: string;
  directory: string;
  createdAt: number;
  lastUsedAt: number;
}

interface SendResolver {
  resolve: (msg: UnifiedMessage) => void;
  reject: (err: Error) => void;
}

/** Enqueued message waiting for the current turn to complete. */
interface QueuedMessage {
  content: MessagePromptContent[];
  options?: {
    mode?: string;
    modelId?: string;
    reasoningEffort?: ReasoningEffort | null;
    directory?: string;
  };
  resolver: SendResolver;
  userMessage: UnifiedMessage;
}

interface PendingInteraction<T> {
  sessionId: string;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

// ============================================================================
// CodexAdapter
// ============================================================================

export class CodexAdapter extends EngineAdapter {
  readonly engineType: EngineType = "codex";

  private client: CodexJsonRpcClient | null = null;
  private status: EngineStatus = "stopped";
  private cliPath: string | undefined;
  private errorMessage: string | undefined;

  // Session ↔ Thread mapping
  private sessionToThread = new Map<string, string>();
  private threadToSession = new Map<string, string>();
  private threads = new Map<string, ThreadInfo>();

  // Streaming state
  private messageBuffers = new Map<string, MessageBuffer>();
  private sendResolvers = new Map<string, SendResolver>();
  private activeToolParts = new Map<string, ToolPart>(); // callId → ToolPart
  private messageQueues = new Map<string, QueuedMessage[]>(); // sessionId → enqueued messages

  // Interactive requests
  private pendingPermissions = new Map<string, PendingInteraction<PermissionReply>>();
  private pendingQuestions = new Map<string, PendingInteraction<string[][]>>();

  // Per-session configuration
  private sessionModes = new Map<string, string>();
  private sessionModels = new Map<string, string>();
  private sessionReasoningEfforts = new Map<string, ReasoningEffort | null>();
  private sessionDirectories = new Map<string, string>();

  // Global state
  private currentModelId: string = CODEX_DEFAULT_MODEL;
  private currentMode: string = "suggest";
  private cachedModels: UnifiedModelInfo[] = [];
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private autoReconnect = true;
  private reconnectAttempts = 0;

  // --- Lifecycle ---

  async start(): Promise<void> {
    if (this.status === "running") return;

    this.status = "starting";
    this.emit("status.changed", { engineType: this.engineType, status: "starting" });

    // Resolve CLI path
    this.cliPath = resolveCodexCliPath();
    if (!this.cliPath) {
      this.status = "error";
      this.errorMessage = "Codex CLI not found. Install via: npm i -g @openai/codex";
      this.emit("status.changed", {
        engineType: this.engineType,
        status: "error",
        error: this.errorMessage,
      });
      codexLog.error(this.errorMessage);
      return;
    }

    codexLog.info(`Codex CLI found at: ${this.cliPath}`);

    try {
      await this.spawnAndInitialize();
      this.autoReconnect = true;
      this.reconnectAttempts = 0;

      // Fetch model list (non-blocking — don't delay startup for model cache)
      this.refreshModelCache().catch((err) => {
        codexLog.warn("Failed to refresh model cache:", err);
      });

      this.status = "running";
      this.emit("status.changed", { engineType: this.engineType, status: "running" });
      this.startSessionCleanup();
      codexLog.info("Codex adapter started successfully");
    } catch (err: any) {
      this.status = "error";
      this.errorMessage = err?.message ?? "Failed to start Codex";
      this.emit("status.changed", {
        engineType: this.engineType,
        status: "error",
        error: this.errorMessage,
      });
      codexLog.error("Failed to start Codex adapter:", err);
    }
  }

  async stop(): Promise<void> {
    this.autoReconnect = false;
    this.stopSessionCleanup();

    // Reject all pending interactions
    this.rejectAllPendingPermissions("Adapter stopped");
    this.rejectAllPendingQuestions("Adapter stopped");

    // Reject all send resolvers
    for (const [, resolver] of this.sendResolvers) {
      resolver.reject(new Error("Adapter stopped"));
    }
    this.sendResolvers.clear();
    this.messageBuffers.clear();
    this.activeToolParts.clear();

    // Reject all queued messages
    for (const [, queue] of this.messageQueues) {
      for (const queued of queue) {
        queued.resolver.reject(new Error("Adapter stopped"));
      }
    }
    this.messageQueues.clear();

    // Stop client
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }

    // Clear all maps
    this.sessionToThread.clear();
    this.threadToSession.clear();
    this.threads.clear();
    this.sessionModes.clear();
    this.sessionModels.clear();
    this.sessionReasoningEfforts.clear();
    this.sessionDirectories.clear();

    this.status = "stopped";
    this.emit("status.changed", { engineType: this.engineType, status: "stopped" });
    codexLog.info("Codex adapter stopped");
  }

  async healthCheck(): Promise<boolean> {
    return this.status === "running" && this.client?.running === true;
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getInfo(): EngineInfo {
    return {
      type: this.engineType,
      name: "Codex",
      status: this.status,
      capabilities: this.getCapabilities(),
      errorMessage: this.errorMessage,
    };
  }

  // --- Capabilities ---

  getCapabilities(): EngineCapabilities {
    return {
      providerModelHierarchy: false,
      dynamicModes: true,
      messageCancellation: true,
      permissionAlways: true,
      imageAttachment: true,
      loadSession: true,
      listSessions: true,
      modelSwitchable: true,
      customModelInput: true,
      messageEnqueue: true,
      slashCommands: false,
      availableModes: this.getModes(),
    };
  }

  getAuthMethods(): AuthMethod[] {
    return [{
      id: "openai",
      name: "OpenAI API",
      description: "Authenticate with your OpenAI API key (set OPENAI_API_KEY) or run `codex login`",
    }];
  }

  // --- Sessions ---

  hasSession(sessionId: string): boolean {
    return this.sessionToThread.has(sessionId);
  }

  async listSessions(_directory?: string): Promise<UnifiedSession[]> {
    const sessions: UnifiedSession[] = [];
    for (const [sessionId, threadId] of this.sessionToThread) {
      const info = this.threads.get(threadId);
      if (!info) continue;
      if (_directory && info.directory !== _directory) continue;
      sessions.push({
        id: sessionId,
        engineType: this.engineType,
        directory: info.directory,
        time: { created: info.createdAt, updated: info.createdAt },
      });
    }
    return sessions;
  }

  async createSession(directory: string, meta?: Record<string, unknown>): Promise<UnifiedSession> {
    const sessionId = timeId("cs");

    if (!this.client?.running) {
      // Try restarting
      await this.start();
      if (!this.client?.running) {
        throw new Error("Codex is not running");
      }
    }

    // Send ThreadStart to Codex to create a new thread
    let threadId: string;
    try {
      const result = await this.client.request("codex/threadStart", {
        instructions: CODEMUX_IDENTITY_PROMPT,
      }) as { thread_id: string };
      threadId = result.thread_id;
    } catch (err: any) {
      codexLog.error(`Failed to create thread for session ${sessionId}:`, err);
      throw err;
    }

    // Set up bidirectional mapping
    this.sessionToThread.set(sessionId, threadId);
    this.threadToSession.set(threadId, sessionId);
    this.threads.set(threadId, {
      threadId,
      directory,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    this.sessionDirectories.set(sessionId, directory);

    // Set default mode for this session
    this.sessionModes.set(sessionId, this.currentMode);

    const session: UnifiedSession = {
      id: sessionId,
      engineType: this.engineType,
      directory,
      time: { created: Date.now(), updated: Date.now() },
      engineMeta: { codexThreadId: threadId, ...meta },
    };

    this.emit("session.created", { session });
    codexLog.info(`Session created: ${sessionId} → thread ${threadId}`);

    return session;
  }

  async getSession(sessionId: string): Promise<UnifiedSession | null> {
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId) return null;
    const info = this.threads.get(threadId);
    if (!info) return null;

    return {
      id: sessionId,
      engineType: this.engineType,
      directory: info.directory,
      time: { created: info.createdAt, updated: info.createdAt },
      engineMeta: { codexThreadId: threadId },
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const threadId = this.sessionToThread.get(sessionId);
    if (threadId) {
      this.threadToSession.delete(threadId);
      this.threads.delete(threadId);
    }
    this.sessionToThread.delete(sessionId);
    this.sessionModes.delete(sessionId);
    this.sessionModels.delete(sessionId);
    this.sessionReasoningEfforts.delete(sessionId);
    this.sessionDirectories.delete(sessionId);
    this.messageBuffers.delete(sessionId);

    // Reject pending interactions for this session
    this.rejectPendingForSession(sessionId, "Session deleted");

    codexLog.info(`Session deleted: ${sessionId}`);
  }

  // --- Messages ---

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: {
      mode?: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort | null;
      directory?: string;
    },
  ): Promise<UnifiedMessage> {
    if (!this.client?.running) {
      // Try restarting
      await this.start();
      if (!this.client?.running) {
        throw new Error("Codex is not running");
      }
    }

    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId) {
      throw new Error(`No thread found for session ${sessionId}`);
    }

    // Extract text content
    const textContent = content
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && !!c.text)
      .map((c) => c.text)
      .join("\n");

    // Extract image attachments
    const imageContents = content.filter((c) => c.type === "image" && c.data);

    if (!textContent && imageContents.length === 0) {
      throw new Error("No content provided");
    }

    // Create user message
    const userMsg = createUserMessage(sessionId, textContent || "(image)");

    // --- Enqueue path: engine is already processing this session ---
    const existingResolver = this.sendResolvers.get(sessionId);
    if (existingResolver) {
      // If no mode/model overrides, use TurnSteer to append mid-turn
      const hasModeOverride = options?.mode && options.mode !== (this.sessionModes.get(sessionId) ?? this.currentMode);
      const hasModelOverride = options?.modelId && options.modelId !== (this.sessionModels.get(sessionId) ?? this.currentModelId);

      if (!hasModeOverride && !hasModelOverride && this.client?.running) {
        // TurnSteer: append content to the active turn
        const turnContent = this.buildTurnContent(textContent || "(image)", imageContents);
        this.client.notify("codex/turnSteer", {
          thread_id: threadId,
          content: turnContent,
        });

        // Emit the user message immediately
        this.emit("message.updated", { sessionId, message: userMsg });

        codexLog.debug(`TurnSteer sent for session ${sessionId}`);

        // The existing resolver will capture the combined response —
        // return a promise that resolves when the current turn completes.
        return new Promise<UnifiedMessage>((resolve) => {
          const originalResolver = this.sendResolvers.get(sessionId)!;
          const originalResolve = originalResolver.resolve;
          originalResolver.resolve = (msg) => {
            originalResolve(msg);
            resolve(msg);
          };
        });
      }

      // Fallback: queue the message for next turn (different mode/model)
      return new Promise<UnifiedMessage>((resolve, reject) => {
        const queue = this.messageQueues.get(sessionId) ?? [];
        const queuePosition = queue.length + 1;

        queue.push({
          content,
          options,
          resolver: { resolve, reject },
          userMessage: userMsg,
        });
        this.messageQueues.set(sessionId, queue);

        this.emit("message.queued", {
          sessionId,
          messageId: userMsg.id,
          queuePosition,
        });

        codexLog.debug(`Message enqueued for session ${sessionId} (position ${queuePosition})`);
      });
    }

    // --- Normal path: session is idle ---

    // Touch lastUsedAt
    const threadInfo = this.threads.get(threadId);
    if (threadInfo) threadInfo.lastUsedAt = Date.now();

    // Emit user message immediately
    this.emit("message.updated", { sessionId, message: userMsg });

    // Create message buffer for assistant response
    const buffer = this.createMessageBuffer(sessionId);

    // Apply mode/model overrides
    const modeId = options?.mode ?? this.sessionModes.get(sessionId) ?? this.currentMode;
    const modelId = options?.modelId ?? this.sessionModels.get(sessionId) ?? this.currentModelId;

    // Build turn content array
    const turnContent = this.buildTurnContent(textContent, imageContents);

    // Send TurnStart
    return new Promise<UnifiedMessage>((resolve, reject) => {
      this.sendResolvers.set(sessionId, { resolve, reject });

      const turnParams: Record<string, unknown> = {
        thread_id: threadId,
        content: turnContent,
        model: modelId,
        approval_policy: modeToApprovalPolicy(modeId),
      };

      // Apply reasoning effort if set
      const effort = options?.reasoningEffort ?? this.sessionReasoningEfforts.get(sessionId);
      if (effort) {
        turnParams.reasoning = { effort };
      }

      this.client!.request("codex/turnStart", turnParams, 120_000).catch((err: Error) => {
        codexLog.error(`TurnStart failed for session ${sessionId}:`, err);
        // Only reject if not already resolved (e.g. by TurnComplete)
        const resolver = this.sendResolvers.get(sessionId);
        if (resolver) {
          this.sendResolvers.delete(sessionId);
          buffer.error = err.message;
          resolver.resolve(finalizeBufferToMessage(buffer));
        }
      });
    });
  }

  async cancelMessage(sessionId: string, _directory?: string): Promise<void> {
    if (!this.client?.running) return;

    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId) return;

    codexLog.info(`Cancelling turn for session ${sessionId}`);

    // Send TurnInterrupt notification
    this.client.notify("codex/turnInterrupt", { thread_id: threadId });

    // Resolve pending send with cancelled status
    const resolver = this.sendResolvers.get(sessionId);
    if (resolver) {
      this.sendResolvers.delete(sessionId);
      const buffer = this.messageBuffers.get(sessionId);
      if (buffer) {
        buffer.error = "Cancelled";
        resolver.resolve(finalizeBufferToMessage(buffer));
        this.messageBuffers.delete(sessionId);
      } else {
        const cancelMsg: UnifiedMessage = {
          id: timeId("msg"),
          sessionId,
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
          parts: [],
          error: "Cancelled",
        };
        resolver.resolve(cancelMsg);
      }
    }

    // Reject all queued messages
    const queue = this.messageQueues.get(sessionId);
    if (queue) {
      for (const queued of queue) {
        queued.resolver.reject(new Error("Cancelled"));
      }
      this.messageQueues.delete(sessionId);
    }

    // Reject pending interactions
    this.rejectPendingForSession(sessionId, "Cancelled");
  }

  async listMessages(_sessionId: string): Promise<UnifiedMessage[]> {
    // Messages are managed by ConversationStore, not the adapter
    return [];
  }

  // --- Historical Import ---

  async listHistoricalSessions(limit: number): Promise<ImportableSession[]> {
    if (!this.client?.running) return [];

    try {
      const result = await this.client.request("codex/threadList", {}) as {
        threads?: Array<{
          thread_id: string;
          title?: string;
          created_at?: number;
          updated_at?: number;
          archived?: boolean;
        }>;
      };

      const threads = result.threads ?? [];
      const sessions: ImportableSession[] = threads
        .filter((t) => !t.archived)
        .map((t) => ({
          engineSessionId: `codex_${t.thread_id}`,
          title: t.title ?? "Codex Thread",
          directory: "",
          createdAt: t.created_at ?? 0,
          updatedAt: t.updated_at ?? t.created_at ?? 0,
          alreadyImported: this.threadToSession.has(t.thread_id),
          engineMeta: { codexThreadId: t.thread_id },
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);

      return limit > 0 ? sessions.slice(0, limit) : sessions;
    } catch (err: any) {
      codexLog.warn("Failed to list historical sessions:", err?.message);
      return [];
    }
  }

  async getHistoricalMessages(
    engineSessionId: string,
    _directory: string,
    engineMeta?: Record<string, unknown>,
  ): Promise<UnifiedMessage[]> {
    if (!this.client?.running) return [];

    const threadId =
      (engineMeta?.codexThreadId as string) ??
      (engineSessionId.startsWith("codex_") ? engineSessionId.slice(6) : engineSessionId);

    try {
      const result = await this.client.request("codex/threadRead", {
        thread_id: threadId,
      }) as { items?: unknown[] };

      const items = result.items ?? [];
      return convertThreadItemsToMessages(engineSessionId, items as any[]);
    } catch (err: any) {
      codexLog.warn(`Failed to get historical messages for ${threadId}:`, err?.message);
      return [];
    }
  }

  // --- Models ---

  async listModels(): Promise<ModelListResult> {
    const models = this.cachedModels.length > 0
      ? this.cachedModels
      : CODEX_MODEL_LIST.map((m) => ({ ...m, engineType: this.engineType as EngineType }));

    return {
      models,
      currentModelId: this.currentModelId,
    };
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.sessionModels.set(sessionId, modelId);
    this.currentModelId = modelId;
    codexLog.info(`Model set to ${modelId} for session ${sessionId}`);
  }

  // --- Modes ---

  getModes(): AgentMode[] {
    return CODEX_MODES;
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.sessionModes.set(sessionId, modeId);
    this.currentMode = modeId;
    codexLog.info(`Mode set to ${modeId} for session ${sessionId}`);
  }

  // --- Reasoning Effort ---

  async setReasoningEffort(sessionId: string, effort: ReasoningEffort | null): Promise<void> {
    this.sessionReasoningEfforts.set(sessionId, effort);
  }

  getReasoningEffort(sessionId: string): ReasoningEffort | null {
    return this.sessionReasoningEfforts.get(sessionId) ?? null;
  }

  // --- Permissions ---

  async replyPermission(permissionId: string, reply: PermissionReply, _sessionId?: string): Promise<void> {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      codexLog.warn(`No pending permission for ID ${permissionId}`);
      return;
    }

    this.pendingPermissions.delete(permissionId);

    // Touch lastUsedAt
    if (pending.sessionId) {
      const threadId = this.sessionToThread.get(pending.sessionId);
      if (threadId) {
        const info = this.threads.get(threadId);
        if (info) info.lastUsedAt = Date.now();
      }
    }

    // Respond to the JSON-RPC request
    const requestId = parseInt(permissionId, 10) || permissionId;
    const approved = reply.optionId === "allow_once" || reply.optionId === "allow_always";

    if (this.client?.running) {
      this.client.respond(requestId as number | string, { approved });
    }

    pending.resolve(reply);
    this.emit("permission.replied", { permissionId, optionId: reply.optionId });
  }

  // --- Questions ---

  async replyQuestion(questionId: string, answers: string[][], _sessionId?: string): Promise<void> {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      codexLog.warn(`No pending question for ID ${questionId}`);
      return;
    }

    this.pendingQuestions.delete(questionId);

    // Touch lastUsedAt
    if (pending.sessionId) {
      const threadId = this.sessionToThread.get(pending.sessionId);
      if (threadId) {
        const info = this.threads.get(threadId);
        if (info) info.lastUsedAt = Date.now();
      }
    }

    // Respond to the JSON-RPC request
    const requestId = parseInt(questionId, 10) || questionId;
    const answer = answers[0]?.[0] ?? "";

    if (this.client?.running) {
      this.client.respond(requestId as number | string, { answer });
    }

    pending.resolve(answers);
    this.emit("question.replied", { questionId, answers });
  }

  async rejectQuestion(questionId: string, _sessionId?: string): Promise<void> {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return;

    this.pendingQuestions.delete(questionId);

    const requestId = parseInt(questionId, 10) || questionId;
    if (this.client?.running) {
      this.client.respondError(requestId as number | string, -1, "User rejected");
    }

    pending.reject(new Error("User rejected"));
  }

  // --- Projects ---

  async listProjects(): Promise<UnifiedProject[]> {
    return [];
  }

  // ============================================================================
  // Private Implementation
  // ============================================================================

  /**
   * Spawn the Codex process and perform the Initialize handshake.
   */
  private async spawnAndInitialize(): Promise<void> {
    if (!this.cliPath) throw new Error("CLI path not resolved");

    const args = buildStartupArgs(this.currentModelId, modeToApprovalPolicy(this.currentMode));

    this.client = new CodexJsonRpcClient({
      cliPath: this.cliPath,
      args,
    });

    // Wire up event handlers before starting
    this.client.on("notification", (method, params) => this.handleNotification(method, params));
    this.client.on("request", (id, method, params) => this.handleServerRequest(id, method, params));
    this.client.on("error", (err) => {
      codexLog.error("Codex client error:", err);
      this.emit("error" as any, err);
    });
    this.client.on("exit", (code, signal) => {
      codexLog.warn(`Codex process exited: code=${code}, signal=${signal}`);

      // Reject all pending operations
      for (const [, resolver] of this.sendResolvers) {
        resolver.reject(new Error("Codex process exited"));
      }
      this.sendResolvers.clear();
      this.rejectAllPendingPermissions("Codex process exited");
      this.rejectAllPendingQuestions("Codex process exited");

      // Attempt auto-reconnect
      if (this.autoReconnect && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts++;
        codexLog.info(`Auto-reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);

        this.status = "starting";
        this.emit("status.changed", { engineType: this.engineType, status: "starting" });

        setTimeout(async () => {
          try {
            await this.spawnAndInitialize();
            this.reconnectAttempts = 0;

            // Re-create threads for active sessions
            await this.recreateActiveThreads();

            this.status = "running";
            this.emit("status.changed", { engineType: this.engineType, status: "running" });
            codexLog.info("Auto-reconnect successful");
          } catch (err: any) {
            codexLog.error(`Auto-reconnect attempt ${this.reconnectAttempts} failed:`, err);
            if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
              this.status = "error";
              this.errorMessage = `Codex process exited and reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts`;
              this.emit("status.changed", {
                engineType: this.engineType,
                status: "error",
                error: this.errorMessage,
              });
            }
          }
        }, RECONNECT_DELAY_MS);
        return;
      }

      this.status = "error";
      this.errorMessage = `Codex process exited unexpectedly (code=${code})`;
      this.emit("status.changed", {
        engineType: this.engineType,
        status: "error",
        error: this.errorMessage,
      });
    });

    // Start the process
    await this.client.start();

    // Perform Initialize handshake
    const initResult = await this.client.request("initialize", {
      client_name: "codemux",
      client_version: "1.0.0",
      protocol_version: "1.0",
    }) as Record<string, unknown>;

    codexLog.info("Codex initialized:", initResult);

    // Send Initialized notification
    this.client.notify("initialized", {});
  }

  /**
   * Fetch available models from OpenAI API.
   * Uses OPENAI_API_KEY for authentication. Falls back to hardcoded list.
   */
  private async refreshModelCache(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");

    if (!apiKey) {
      codexLog.info("No OPENAI_API_KEY found, using default model list");
      this.cachedModels = CODEX_MODEL_LIST.map((m) => ({ ...m, engineType: this.engineType as EngineType }));
      return;
    }

    const modelsUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;

    try {
      codexLog.info(`Fetching models from ${modelsUrl}...`);

      const response = await fetch(modelsUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        codexLog.warn(`Models API returned ${response.status}: ${response.statusText}`);
        this.cachedModels = CODEX_MODEL_LIST.map((m) => ({ ...m, engineType: this.engineType as EngineType }));
        return;
      }

      const data = (await response.json()) as { data?: Array<{ id: string; owned_by?: string }> };

      if (!data.data || !Array.isArray(data.data)) {
        codexLog.warn("Unexpected models response format");
        this.cachedModels = CODEX_MODEL_LIST.map((m) => ({ ...m, engineType: this.engineType as EngineType }));
        return;
      }

      // Filter to models relevant for Codex (GPT-4.1, o-series, etc.)
      // Exclude embedding, tts, whisper, dall-e, moderation models
      const excludePatterns = /^(text-|tts-|whisper|dall-e|davinci|babbage|embedding|moderation|ft:|chatgpt-4o-latest)/;
      const relevantModels = data.data
        .filter((m) => typeof m.id === "string" && !excludePatterns.test(m.id))
        .map((m): UnifiedModelInfo => {
          // Check if this model has known capabilities from our static list
          const knownModel = CODEX_MODEL_LIST.find((km) => km.modelId === m.id);
          return {
            modelId: m.id,
            name: knownModel?.name ?? m.id,
            engineType: this.engineType,
            capabilities: knownModel?.capabilities ?? { reasoning: m.id.startsWith("o") },
            cost: knownModel?.cost,
          };
        })
        .sort((a, b) => {
          // Sort: known models first (in config order), then alphabetically
          const aIdx = CODEX_MODEL_LIST.findIndex((km) => km.modelId === a.modelId);
          const bIdx = CODEX_MODEL_LIST.findIndex((km) => km.modelId === b.modelId);
          if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
          if (aIdx >= 0) return -1;
          if (bIdx >= 0) return 1;
          return a.modelId.localeCompare(b.modelId);
        });

      if (relevantModels.length > 0) {
        this.cachedModels = relevantModels;
        codexLog.info(`Loaded ${relevantModels.length} models from OpenAI API`);
      } else {
        codexLog.warn("No relevant models returned from API, using defaults");
        this.cachedModels = CODEX_MODEL_LIST.map((m) => ({ ...m, engineType: this.engineType as EngineType }));
      }
    } catch (err) {
      codexLog.warn("Failed to fetch models from OpenAI API:", err);
      this.cachedModels = CODEX_MODEL_LIST.map((m) => ({ ...m, engineType: this.engineType as EngineType }));
    }
  }

  // --- Notification Handling ---

  private handleNotification(method: string, params: unknown): void {
    const data = (params ?? {}) as Record<string, unknown>;
    const threadId = data.thread_id as string | undefined;
    const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;

    switch (method) {
      case "codex/agentMessageDelta":
        if (sessionId) this.handleAgentMessageDelta(sessionId, data);
        break;

      case "codex/reasoningTextDelta":
        if (sessionId) this.handleReasoningDelta(sessionId, data);
        break;

      case "codex/execCommandBegin":
        if (sessionId) this.handleExecBegin(sessionId, data);
        break;

      case "codex/execCommandEnd":
        if (sessionId) this.handleExecEnd(sessionId, data);
        break;

      case "codex/commandExecutionOutputDelta":
        if (sessionId) this.handleCommandOutputDelta(sessionId, data);
        break;

      case "codex/fileChange":
        if (sessionId) this.handleFileChange(sessionId, data);
        break;

      case "codex/agentToolCallBegin":
        if (sessionId) this.handleToolCallBegin(sessionId, data);
        break;

      case "codex/agentToolCallEnd":
        if (sessionId) this.handleToolCallEnd(sessionId, data);
        break;

      case "codex/mcpToolCallBegin":
        if (sessionId) this.handleToolCallBegin(sessionId, { ...data, item_type: "mcp_tool_call" });
        break;

      case "codex/mcpToolCallEnd":
        if (sessionId) this.handleToolCallEnd(sessionId, data);
        break;

      case "codex/turnComplete":
        if (sessionId) this.handleTurnComplete(sessionId, data);
        break;

      case "codex/turnFailed":
        if (sessionId) this.handleTurnFailed(sessionId, data);
        break;

      default:
        codexLog.debug(`Unhandled notification: ${method}`);
        break;
    }
  }

  private handleAgentMessageDelta(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const delta = (data.delta as string) ?? (data.text as string) ?? "";
    if (!delta) return;

    const textPart = appendTextDelta(buffer, delta);
    this.emit("message.part.updated", {
      sessionId,
      messageId: buffer.messageId,
      part: textPart,
    });
  }

  private handleReasoningDelta(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const delta = (data.delta as string) ?? (data.text as string) ?? "";
    if (!delta) return;

    const reasoningPart = appendReasoningDelta(buffer, delta);
    this.emit("message.part.updated", {
      sessionId,
      messageId: buffer.messageId,
      part: reasoningPart,
    });
  }

  private handleExecBegin(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const callId = (data.call_id as string) ?? (data.id as string) ?? timeId("call");
    const command = data.command as string | undefined;
    const itemType = "command_execution";

    const { stepStart, toolPart } = createToolPart(buffer, callId, itemType, {
      command: command ?? "",
    });
    this.activeToolParts.set(callId, toolPart);

    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: stepStart });
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: toolPart });
  }

  private handleExecEnd(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const callId = (data.call_id as string) ?? (data.id as string) ?? "";
    const toolPart = this.activeToolParts.get(callId);
    if (!toolPart) return;

    const exitCode = data.exit_code as number | undefined;
    // Use explicit output, or fall back to accumulated streaming output
    const explicitOutput = data.output as string | undefined;
    const accumulatedOutput = (toolPart.state.status === "running"
      ? (toolPart.state.input as Record<string, unknown>)?._output as string
      : undefined);
    const output = explicitOutput || accumulatedOutput || "";
    const error = exitCode !== 0 ? `Exit code: ${exitCode}` : undefined;

    completeToolPart(toolPart, output, error);
    this.activeToolParts.delete(callId);

    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: toolPart });

    const stepFinish = createStepFinish(buffer);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: stepFinish });
  }

  private handleCommandOutputDelta(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const callId = (data.call_id as string) ?? (data.id as string) ?? "";
    const toolPart = this.activeToolParts.get(callId);
    if (!toolPart) return;

    // Update running tool output incrementally
    const delta = (data.delta as string) ?? "";
    if (delta && toolPart.state.status === "running") {
      // Append output to the tool's input (used for display)
      const currentInput = toolPart.state.input as Record<string, unknown>;
      currentInput._output = ((currentInput._output as string) ?? "") + delta;
      this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: toolPart });
    }
  }

  private handleFileChange(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const callId = (data.call_id as string) ?? (data.id as string) ?? timeId("call");
    const path = (data.path as string) ?? (data.file as string) ?? "";

    const { stepStart, toolPart } = createToolPart(buffer, callId, "file_change", {
      path,
      diff: data.diff,
    });

    if (data.diff) {
      toolPart.diff = data.diff as string;
    }

    // File changes are typically completed immediately
    completeToolPart(toolPart, `Changed: ${path}`);

    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: stepStart });
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: toolPart });

    const stepFinish = createStepFinish(buffer);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: stepFinish });
  }

  private handleToolCallBegin(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const callId = (data.call_id as string) ?? (data.id as string) ?? timeId("call");
    const itemType = (data.item_type as string) ?? (data.type as string) ?? "unknown";
    const args = data.arguments ?? data.params ?? {};

    const { stepStart, toolPart } = createToolPart(buffer, callId, itemType, args);
    this.activeToolParts.set(callId, toolPart);

    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: stepStart });
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: toolPart });
  }

  private handleToolCallEnd(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const callId = (data.call_id as string) ?? (data.id as string) ?? "";
    const toolPart = this.activeToolParts.get(callId);
    if (!toolPart) return;

    const output = data.output ?? data.result ?? "";
    const error = data.error as string | undefined;

    completeToolPart(toolPart, output, error);
    this.activeToolParts.delete(callId);

    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: toolPart });

    const stepFinish = createStepFinish(buffer);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: stepFinish });
  }

  private handleTurnFailed(sessionId: string, data: Record<string, unknown>): void {
    const errorMessage = (data.error as string) ?? (data.message as string) ?? "Turn failed";
    codexLog.error(`Turn failed for session ${sessionId}: ${errorMessage}`);

    const buffer = this.messageBuffers.get(sessionId);
    if (buffer) {
      buffer.error = errorMessage;
      const message = finalizeBufferToMessage(buffer);
      this.messageBuffers.delete(sessionId);
      this.emit("message.updated", { sessionId, message });

      const resolver = this.sendResolvers.get(sessionId);
      if (resolver) {
        this.sendResolvers.delete(sessionId);
        resolver.resolve(message);
      }
    } else {
      // No buffer — create a minimal error message
      const resolver = this.sendResolvers.get(sessionId);
      if (resolver) {
        this.sendResolvers.delete(sessionId);
        const errorMsg: UnifiedMessage = {
          id: timeId("msg"),
          sessionId,
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
          parts: [],
          error: errorMessage,
        };
        this.emit("message.updated", { sessionId, message: errorMsg });
        resolver.resolve(errorMsg);
      }
    }

    // Process next queued message if any
    this.processNextQueuedMessage(sessionId);
  }

  private handleTurnComplete(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return;

    // Extract token usage if available
    if (data.usage && typeof data.usage === "object") {
      const usage = data.usage as Record<string, unknown>;
      const cacheRead = (usage.cache_read_tokens as number) ?? (usage.cached_tokens as number) ?? 0;
      const cacheWrite = (usage.cache_write_tokens as number) ?? 0;
      buffer.tokens = {
        input: (usage.input_tokens as number) ?? (usage.prompt_tokens as number) ?? 0,
        output: (usage.output_tokens as number) ?? (usage.completion_tokens as number) ?? 0,
        ...(cacheRead || cacheWrite ? { cache: { read: cacheRead, write: cacheWrite } } : {}),
      };
    }

    // Extract cost if available (USD)
    if (typeof data.cost === "number") {
      buffer.cost = data.cost;
      buffer.costUnit = "usd";
    }

    // Extract model info if available
    if (data.model) {
      buffer.modelId = data.model as string;
    }

    // Finalize and emit
    const message = finalizeBufferToMessage(buffer);
    this.messageBuffers.delete(sessionId);

    this.emit("message.updated", { sessionId, message });

    // Resolve the send promise
    const resolver = this.sendResolvers.get(sessionId);
    if (resolver) {
      this.sendResolvers.delete(sessionId);
      resolver.resolve(message);
    }

    codexLog.debug(`Turn completed for session ${sessionId}`);

    // Process next queued message if any
    this.processNextQueuedMessage(sessionId);
  }

  // --- Server Request Handling (blocking requests from Codex) ---

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const data = (params ?? {}) as Record<string, unknown>;
    const threadId = data.thread_id as string | undefined;
    const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;

    // Approval requests
    if (
      method === "codex/approvalRequest" ||
      method === "codex/fileApprovalRequest" ||
      method === "codex/execApprovalRequest" ||
      method === "codex/mcpApprovalRequest" ||
      method === "codex/backgroundApprovalRequest"
    ) {
      if (!sessionId) {
        this.client?.respond(id, { approved: false });
        return;
      }
      this.handleApprovalRequest(sessionId, id, method, params);
      return;
    }

    // Confirmation request
    if (method === "codex/askForConfirmation") {
      if (!sessionId) {
        this.client?.respond(id, { answer: "no" });
        return;
      }
      this.handleConfirmationRequest(sessionId, id, params);
      return;
    }

    // Unknown request — respond with error
    codexLog.warn(`Unhandled server request: ${method}`);
    this.client?.respondError(id, -32601, `Method not supported: ${method}`);
  }

  private handleApprovalRequest(
    sessionId: string,
    requestId: number | string,
    method: string,
    params: unknown,
  ): void {
    const permission = convertApprovalToPermission(sessionId, requestId, method, params);

    // Store pending interaction
    this.pendingPermissions.set(String(requestId), {
      sessionId,
      resolve: () => {}, // Resolved via replyPermission
      reject: (err) => {
        codexLog.debug(`Permission ${requestId} rejected:`, err.message);
      },
    });

    this.emit("permission.asked", { permission });
  }

  private handleConfirmationRequest(
    sessionId: string,
    requestId: number | string,
    params: unknown,
  ): void {
    const question = convertConfirmationToQuestion(sessionId, requestId, params);

    // Store pending interaction
    this.pendingQuestions.set(String(requestId), {
      sessionId,
      resolve: () => {}, // Resolved via replyQuestion
      reject: (err) => {
        codexLog.debug(`Question ${requestId} rejected:`, err.message);
      },
    });

    this.emit("question.asked", { question });
  }

  // --- Session Cleanup ---

  /**
   * After a reconnect, re-create Codex threads for all active sessions.
   * Updates the bidirectional session↔thread mappings with new thread IDs.
   */
  private async recreateActiveThreads(): Promise<void> {
    const entries = Array.from(this.sessionToThread.entries());
    if (entries.length === 0) return;

    codexLog.info(`Re-creating ${entries.length} active thread(s) after reconnect...`);

    for (const [sessionId, oldThreadId] of entries) {
      const info = this.threads.get(oldThreadId);
      if (!info) continue;

      try {
        const result = await this.client!.request("codex/threadStart", {
          instructions: CODEMUX_IDENTITY_PROMPT,
        }) as { thread_id: string };

        const newThreadId = result.thread_id;

        // Update mappings
        this.threadToSession.delete(oldThreadId);
        this.threads.delete(oldThreadId);

        this.sessionToThread.set(sessionId, newThreadId);
        this.threadToSession.set(newThreadId, sessionId);
        this.threads.set(newThreadId, {
          threadId: newThreadId,
          directory: info.directory,
          createdAt: info.createdAt,
          lastUsedAt: Date.now(),
        });

        codexLog.info(`Session ${sessionId}: thread ${oldThreadId} → ${newThreadId}`);
      } catch (err: any) {
        codexLog.error(`Failed to re-create thread for session ${sessionId}:`, err);
      }
    }
  }

  private startSessionCleanup(): void {
    if (this.cleanupIntervalId) return;

    this.cleanupIntervalId = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, threadId] of Array.from(this.sessionToThread.entries())) {
        // Skip sessions with active turns
        if (this.sendResolvers.has(sessionId)) {
          const info = this.threads.get(threadId);
          if (info) info.lastUsedAt = now;
          continue;
        }

        const info = this.threads.get(threadId);
        if (!info) continue;

        if (now - info.lastUsedAt > SESSION_IDLE_TIMEOUT_MS) {
          this.cleanupSession(sessionId, "idle timeout (30 min)");
        }
      }
    }, 60_000); // Check every minute
  }

  private stopSessionCleanup(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }

  private cleanupSession(sessionId: string, reason: string): void {
    codexLog.info(`Cleaning up session ${sessionId}: ${reason}`);

    this.rejectPendingForSession(sessionId, reason);

    const threadId = this.sessionToThread.get(sessionId);
    if (threadId) {
      this.threadToSession.delete(threadId);
      this.threads.delete(threadId);
    }
    this.sessionToThread.delete(sessionId);
    this.sessionModes.delete(sessionId);
    this.sessionModels.delete(sessionId);
    this.sessionReasoningEfforts.delete(sessionId);
    this.sessionDirectories.delete(sessionId);
    this.messageBuffers.delete(sessionId);
  }

  // --- Buffer Management ---

  /**
   * Build the content array for a TurnStart request, supporting text + images.
   */
  private buildTurnContent(
    text: string,
    imageContents: MessagePromptContent[],
  ): unknown[] {
    const turnContent: unknown[] = [];

    if (text) {
      turnContent.push({ type: "input_text", text });
    }

    for (const img of imageContents) {
      if (img.data) {
        // Codex accepts base64 data URIs for images
        const mimeType = img.mimeType ?? "image/png";
        turnContent.push({
          type: "input_image",
          image_url: `data:${mimeType};base64,${img.data}`,
        });
      }
    }

    return turnContent;
  }

  /**
   * Process the next queued message for a session after a turn completes.
   */
  private processNextQueuedMessage(sessionId: string): void {
    const queue = this.messageQueues.get(sessionId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    if (queue.length === 0) {
      this.messageQueues.delete(sessionId);
    }

    // Emit the deferred user message
    this.emit("message.queued.consumed", {
      sessionId,
      messageId: next.userMessage.id,
    });
    this.emit("message.updated", { sessionId, message: next.userMessage });

    // Extract content
    const textContent = next.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && !!c.text)
      .map((c) => c.text)
      .join("\n");
    const imageContents = next.content.filter((c) => c.type === "image" && c.data);

    // Create new buffer
    const buffer = this.createMessageBuffer(sessionId);

    // Apply options
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId) {
      next.resolver.reject(new Error("No thread found"));
      return;
    }

    const modeId = next.options?.mode ?? this.sessionModes.get(sessionId) ?? this.currentMode;
    const modelId = next.options?.modelId ?? this.sessionModels.get(sessionId) ?? this.currentModelId;
    const turnContent = this.buildTurnContent(textContent, imageContents);

    // Register resolver
    this.sendResolvers.set(sessionId, next.resolver);

    const turnParams: Record<string, unknown> = {
      thread_id: threadId,
      content: turnContent,
      model: modelId,
      approval_policy: modeToApprovalPolicy(modeId),
    };

    const effort = next.options?.reasoningEffort ?? this.sessionReasoningEfforts.get(sessionId);
    if (effort) {
      turnParams.reasoning = { effort };
    }

    this.client!.request("codex/turnStart", turnParams, 120_000).catch((err: Error) => {
      codexLog.error(`TurnStart (queued) failed for session ${sessionId}:`, err);
      const resolver = this.sendResolvers.get(sessionId);
      if (resolver) {
        this.sendResolvers.delete(sessionId);
        buffer.error = err.message;
        resolver.resolve(finalizeBufferToMessage(buffer));
      }
    });
  }

  private createMessageBuffer(sessionId: string): MessageBuffer {
    const buffer: MessageBuffer = {
      messageId: timeId("msg"),
      sessionId,
      parts: [],
      textAccumulator: "",
      textPartId: null,
      reasoningAccumulator: "",
      reasoningPartId: null,
      startTime: Date.now(),
    };
    this.messageBuffers.set(sessionId, buffer);
    return buffer;
  }

  private ensureBuffer(sessionId: string): MessageBuffer {
    let buffer = this.messageBuffers.get(sessionId);
    if (!buffer) {
      buffer = this.createMessageBuffer(sessionId);
    }
    return buffer;
  }

  // --- Cleanup Helpers ---

  private rejectAllPendingPermissions(reason: string): void {
    for (const [id, pending] of this.pendingPermissions) {
      pending.reject(new Error(reason));
    }
    this.pendingPermissions.clear();
  }

  private rejectAllPendingQuestions(reason: string): void {
    for (const [id, pending] of this.pendingQuestions) {
      pending.reject(new Error(reason));
    }
    this.pendingQuestions.clear();
  }

  private rejectPendingForSession(sessionId: string, reason: string): void {
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.sessionId === sessionId) {
        // Respond to JSON-RPC so Codex doesn't hang
        const requestId = parseInt(id, 10) || id;
        if (this.client?.running) {
          this.client.respond(requestId as number | string, { approved: false });
        }
        pending.reject(new Error(reason));
        this.pendingPermissions.delete(id);
      }
    }
    for (const [id, pending] of this.pendingQuestions) {
      if (pending.sessionId === sessionId) {
        const requestId = parseInt(id, 10) || id;
        if (this.client?.running) {
          this.client.respondError(requestId as number | string, -1, reason);
        }
        pending.reject(new Error(reason));
        this.pendingQuestions.delete(id);
      }
    }
  }
}
