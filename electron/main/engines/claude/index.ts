// ============================================================================
// Claude Code Adapter — Claude Code integration via @anthropic-ai/claude-agent-sdk
//
// Uses the official SDK's V2 Session API (unstable_v2_createSession) which spawns
// a Claude Code CLI subprocess communicating over stdio JSON-RPC.
// V2 Sessions enable process reuse: subsequent messages in the same conversation
// reuse the running CC process, avoiding cold start (~3-5s) each time.
// ============================================================================

import { timeId } from "../../utils/id-gen";
import { CODEMUX_IDENTITY_PROMPT } from "../identity-prompt";
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  listSessions as sdkListSessions,
  getSessionMessages as sdkGetSessionMessages,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKSession,
  SDKMessage,
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";

import { EngineAdapter, MessageBuffer } from "../engine-adapter";
import { claudeLog } from "../../services/logger";
import { inferToolKind, normalizeToolName } from "../../../../src/types/tool-mapping";
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
  UnifiedModelInfo,
  ModelListResult,
  UnifiedProject,
  AgentMode,
  MessagePromptContent,
  PermissionReply,
  ToolPart,
  TextPart,
  ReasoningPart,
  StepStartPart,
  StepFinishPart,
  QuestionInfo,
} from "../../../../src/types/unified";

import { sdkSessionToUnified, convertSdkMessages } from "./converters";
import { deleteCCSessionFile, readJsonlTimestamps } from "./cc-session-files";
import { createRequire } from "node:module";
import { sep } from "node:path";

// ============================================================================
// V2 Session Info — Tracks a persistent SDK session
// ============================================================================

interface V2SessionInfo {
  session: SDKSession;
  directory: string;
  createdAt: number;
  lastUsedAt: number;
  capturedSessionId?: string; // CC's internal session ID from system init message
  permissionMode?: "default" | "plan" | "acceptEdits" | "dontAsk";
}

// ============================================================================
// Streaming block tracking for content_block_delta accumulation
// ============================================================================

interface StreamingBlock {
  index: number;
  type: "text" | "thinking" | "tool_use";
  content: string;
  toolName?: string;
  toolId?: string;
}

// ============================================================================
// Pending Permission / Question types
// ============================================================================

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  permission: UnifiedPermission;
  suggestions?: PermissionUpdate[];
  input: Record<string, unknown>;
}

interface PendingQuestion {
  resolve: (answer: string) => void;
  question: UnifiedQuestion;
}

// ============================================================================
// Default Agent Modes
// ============================================================================

const DEFAULT_MODES: AgentMode[] = [
  { id: "agent", label: "Agent", description: "Interactive coding agent" },
  { id: "plan", label: "Plan", description: "Plan before executing" },
];

// ============================================================================
// Session idle timeout (30 min)
// ============================================================================

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// ============================================================================
// ClaudeCodeAdapter
// ============================================================================

export class ClaudeCodeAdapter extends EngineAdapter {
  readonly engineType: EngineType = "claude";

  // --- V2 Sessions (persistent, process reuse) ---
  private v2Sessions = new Map<string, V2SessionInfo>();

  // --- State ---
  private status: EngineStatus = "stopped";
  private version: string | undefined;
  private currentModelId: string | null = null;
  private cachedModels: UnifiedModelInfo[] = [];
  private sessionModes = new Map<string, string>();

  // --- Session directory cache (used instead of external store lookups) ---
  private sessionDirectories = new Map<string, string>();
  /** Persisted ccSessionId per session, for SDK session resumption across restarts */
  private sessionCcIds = new Map<string, string>();

  // --- Message accumulation ---
  private messageBuffers = new Map<string, MessageBuffer>();
  private messageHistory = new Map<string, UnifiedMessage[]>();

  // --- Pending interactions ---
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingQuestions = new Map<string, PendingQuestion>();

  // --- Message send completion ---
  private sendResolvers = new Map<
    string,
    Array<{
      resolve: (msg: UnifiedMessage) => void;
      reject: (err: Error) => void;
    }>
  >();

  // --- Queued user messages (deferred emit) ---
  // When messages are enqueued while the engine is busy, the user message is
  // NOT emitted immediately. Instead it is stored here and emitted when the
  // engine starts processing the queued turn (in processStream).
  private pendingUserMessages = new Map<string, UnifiedMessage[]>();

  // --- Queued message texts (deferred send to CLI) ---
  // Claude CLI doesn't reliably queue multiple stdin sends. We maintain our
  // own text queue and send() one at a time after each stream() completes.
  private pendingMessageTexts = new Map<string, string[]>();

  // --- Tool call tracking ---
  private toolCallParts = new Map<string, ToolPart>();

  // --- Active requests (for abort) ---
  private activeAbortControllers = new Map<string, AbortController>();

  // --- Cleanup interval ---
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  // --- Constructor ---

  constructor(
    private options?: {
      model?: string;
      env?: Record<string, string>;
    },
  ) {
    super();
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async start(): Promise<void> {
    if (this.status === "running") return;

    this.setStatus("starting");
    claudeLog.info("Starting Claude Code adapter...");

    try {
      // Claude Code CLI is available globally (installed via npm install -g @anthropic-ai/claude-code)
      // The SDK will find it automatically, or we can specify pathToClaudeCodeExecutable.
      // No separate server process to manage — the SDK spawns CLI subprocesses per session.

      // Model is determined per-request via sendMessage's modelId parameter,
      // sourced from the user's selection in settings.json. No env var override needed.
      this.currentModelId = this.options?.model ?? null;

      // Start cleanup interval
      this.startSessionCleanup();

      // Fetch model list via SDK (uses CLI's own auth)
      // Must complete before setStatus("running") so frontend gets models on first listModels() call
      await this.refreshModelCache();

      this.setStatus("running");
      claudeLog.info("Claude Code adapter started successfully");
    } catch (err) {
      claudeLog.error("Failed to start Claude Code adapter:", err);
      this.setStatus("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.status === "stopped") return;

    claudeLog.info("Stopping Claude Code adapter...");

    // Close all V2 sessions
    for (const [sessionId, info] of this.v2Sessions) {
      try {
        info.session.close();
      } catch (e) {
        claudeLog.warn(`Error closing Claude session ${sessionId}:`, e);
      }
    }
    this.v2Sessions.clear();

    // Abort all active requests
    for (const [, controller] of this.activeAbortControllers) {
      controller.abort();
    }
    this.activeAbortControllers.clear();

    // Clear pending interactions
    this.rejectAllPendingPermissions("Adapter stopped");
    this.rejectAllPendingQuestions("Adapter stopped");

    // Stop cleanup interval
    this.stopSessionCleanup();

    this.setStatus("stopped");
  }

  async healthCheck(): Promise<boolean> {
    return this.status === "running";
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getInfo(): EngineInfo {
    return {
      type: this.engineType,
      name: "Claude Code",
      version: this.version,
      status: this.status,
      capabilities: this.getCapabilities(),
      authMethods: this.getAuthMethods(),
    };
  }

  // ==========================================================================
  // Capabilities
  // ==========================================================================

  getCapabilities(): EngineCapabilities {
    return {
      providerModelHierarchy: false,
      dynamicModes: false,
      messageCancellation: true,
      permissionAlways: false,
      imageAttachment: false,
      loadSession: true,
      listSessions: true,
      modelSwitchable: true,
      customModelInput: true,
      messageEnqueue: true,
      availableModes: this.getModes(),
    };
  }

  getAuthMethods(): AuthMethod[] {
    return [
      {
        id: "anthropic",
        name: "Anthropic API",
        description:
          "Authenticate with your Anthropic API key (set ANTHROPIC_API_KEY)",
      },
    ];
  }

  // ==========================================================================
  // Sessions
  // ==========================================================================

  async listSessions(directory?: string): Promise<UnifiedSession[]> {
    // Use SDK's listSessions to get session metadata from Claude Code's session files
    try {
      const sdkSessions = await sdkListSessions(
        directory ? { dir: directory } : undefined,
      );

      const sessions = sdkSessions.map((s) => sdkSessionToUnified(this.engineType, s, directory));
      if (directory) {
        const normDir = directory.replaceAll("\\", "/");
        return sessions.filter((s) => s.directory === normDir);
      }
      return sessions;
    } catch (err) {
      claudeLog.warn("Failed to list Claude sessions from SDK:", err);
      return [];
    }
  }

  async createSession(directory: string, meta?: Record<string, unknown>): Promise<UnifiedSession> {
    const normalizedDir = directory.replaceAll("\\", "/");
    const sessionId = timeId("cs");
    const now = Date.now();

    const session: UnifiedSession = {
      id: sessionId,
      engineType: this.engineType,
      directory: normalizedDir,
      title: "New Chat",
      time: {
        created: now,
        updated: now,
      },
    };

    this.sessionDirectories.set(sessionId, normalizedDir);
    // Restore ccSessionId from persisted engineMeta for session resumption
    if (meta?.ccSessionId && typeof meta.ccSessionId === "string") {
      this.sessionCcIds.set(sessionId, meta.ccSessionId);
    }
    this.emit("session.created", { session });

    return session;
  }

  hasSession(sessionId: string): boolean {
    return this.v2Sessions.has(sessionId) || this.sessionDirectories.has(sessionId);
  }

  async getSession(sessionId: string): Promise<UnifiedSession | null> {
    return null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Abort any active request for this session
    const controller = this.activeAbortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeAbortControllers.delete(sessionId);
    }

    // Reject pending send promises so callers don't hang
    const resolvers = this.sendResolvers.get(sessionId);
    if (resolvers) {
      for (const r of resolvers) r.reject(new Error("Session deleted"));
      this.sendResolvers.delete(sessionId);
    }

    // Reject pending permissions/questions for this session
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.permission.sessionId === sessionId) {
        pending.resolve({ behavior: "deny", message: "Session deleted" });
        this.pendingPermissions.delete(id);
      }
    }
    for (const [id, pending] of this.pendingQuestions) {
      if (pending.question.sessionId === sessionId) {
        pending.resolve("Session deleted");
        this.pendingQuestions.delete(id);
      }
    }

    // Close V2 session if active
    const v2Info = this.v2Sessions.get(sessionId);
    if (v2Info) {
      try {
        v2Info.session.close();
      } catch {
        // Ignore close errors
      }
      this.v2Sessions.delete(sessionId);
    }

    // Delete the Claude Code .jsonl session file so it won't reappear on next listSessions
    const ccSessionId = v2Info?.capturedSessionId;
    const directory = v2Info?.directory ?? this.sessionDirectories.get(sessionId);
    if (ccSessionId && directory) {
      deleteCCSessionFile(ccSessionId, directory);
    }

    this.sessionDirectories.delete(sessionId);
    this.messageHistory.delete(sessionId);
    this.messageBuffers.delete(sessionId);
    this.sessionModes.delete(sessionId);
  }

  // ==========================================================================
  // Messages
  // ==========================================================================

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: { mode?: string; modelId?: string },
  ): Promise<UnifiedMessage> {
    const directory =
      this.v2Sessions.get(sessionId)?.directory ??
      this.sessionDirectories.get(sessionId);
    if (!directory) throw new Error(`Session ${sessionId} not found (no directory)`);

    // Extract text content from prompt
    const textContent = content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    if (!textContent.trim()) {
      throw new Error("Message content cannot be empty");
    }

    // --- Enqueue path: engine is already processing this session ---
    const existingResolvers = this.sendResolvers.get(sessionId);
    if (existingResolvers && existingResolvers.length > 0) {
      // Create user message but DON'T emit yet — defer until processStream
      // starts processing this queued turn. Emitting immediately would create
      // a user bubble in the frontend while the engine is still working on
      // the previous turn, causing the isWorking indicator to jump.
      const userMsgId = timeId("msg");
      const userMessage: UnifiedMessage = {
        id: userMsgId,
        sessionId,
        role: "user",
        time: { created: Date.now() },
        parts: [{ type: "text", text: textContent, id: timeId("pt"), messageId: userMsgId, sessionId } as TextPart],
      };

      const history = this.messageHistory.get(sessionId) ?? [];
      history.push(userMessage);
      this.messageHistory.set(sessionId, history);

      // Store for deferred emit
      const pending = this.pendingUserMessages.get(sessionId) ?? [];
      pending.push(userMessage);
      this.pendingUserMessages.set(sessionId, pending);

      const queuePosition = existingResolvers.length;
      this.emit("message.queued", {
        sessionId,
        messageId: "",
        queuePosition,
      });

      claudeLog.info(`[Claude][${sessionId}] Message enqueued (position ${queuePosition})`);

      // DON'T send to stdin yet — Claude CLI doesn't reliably queue multiple
      // stdin sends. Store the text and send it when processStream finishes
      // the current turn and is ready for the next one.
      const pendingTexts = this.pendingMessageTexts.get(sessionId) ?? [];
      pendingTexts.push(textContent);
      this.pendingMessageTexts.set(sessionId, pendingTexts);

      return new Promise<UnifiedMessage>((resolve, reject) => {
        existingResolvers.push({ resolve, reject });
      });
    }

    // --- Normal path: session is idle ---

    // Create user message
    const userMsgId = timeId("msg");
    const userMessage: UnifiedMessage = {
      id: userMsgId,
      sessionId,
      role: "user",
      time: { created: Date.now() },
      parts: [{ type: "text", text: textContent, id: timeId("pt"), messageId: userMsgId, sessionId } as TextPart],
    };

    // Emit user message
    const history = this.messageHistory.get(sessionId) ?? [];
    history.push(userMessage);
    this.messageHistory.set(sessionId, history);
    this.emit("message.updated", { sessionId, message: userMessage });

    // Create assistant message buffer
    const assistantMsgId = timeId("msg");
    const buffer: MessageBuffer = {
      messageId: assistantMsgId,
      sessionId,
      parts: [],
      textAccumulator: "",
      textPartId: null,
      reasoningAccumulator: "",
      reasoningPartId: null,
      startTime: Date.now(),
    };
    this.messageBuffers.set(sessionId, buffer);

    // Emit initial empty assistant message
    const assistantMessage: UnifiedMessage = {
      id: assistantMsgId,
      sessionId,
      role: "assistant",
      time: { created: Date.now() },
      parts: [],
      workingDirectory: directory,
    };
    this.emit("message.updated", { sessionId, message: assistantMessage });

    // Determine permission mode from mode option
    const mode = options?.mode ?? this.sessionModes.get(sessionId) ?? "agent";
    const permissionMode =
      mode === "plan" ? ("plan" as const) : ("default" as const);

    // Get or create V2 session
    const v2Session = await this.getOrCreateV2Session(
      sessionId,
      directory,
      {
        model: options?.modelId ?? this.currentModelId ?? undefined,
        permissionMode,
      },
    );

    // Create abort controller for this request
    const abortController = new AbortController();
    this.activeAbortControllers.set(sessionId, abortController);

    // Send message and process stream
    return new Promise<UnifiedMessage>((resolve, reject) => {
      const resolvers = this.sendResolvers.get(sessionId) ?? [];
      resolvers.push({ resolve, reject });
      this.sendResolvers.set(sessionId, resolvers);

      this.processStream(
        v2Session,
        sessionId,
        textContent,
        buffer,
        abortController,
      ).catch((err) => {
        claudeLog.error(`[Claude][${sessionId}] Stream processing error:`, err);
        const currentResolvers = this.sendResolvers.get(sessionId);
        if (currentResolvers) {
          this.sendResolvers.delete(sessionId);
          for (const r of currentResolvers) r.reject(err);
        }
      });
    });
  }

  async cancelMessage(sessionId: string): Promise<void> {
    // Mark the buffer as cancelled BEFORE aborting, so that whichever code path
    // calls finalizeBuffer first (this method or sendMessageV2's finally block)
    // will see the "Cancelled" error and emit it to the frontend.
    const buffer = this.messageBuffers.get(sessionId);
    if (buffer) buffer.error = "Cancelled";

    const controller = this.activeAbortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeAbortControllers.delete(sessionId);
    }

    // Interrupt the V2 session's underlying Query to stop the CLI subprocess.
    // SDKSession doesn't expose interrupt() directly, but the internal `query`
    // property (an instance of the Query class) does. Without this call, the
    // CLI process continues executing tools in the background even though we
    // stopped reading the stream.
    const v2Info = this.v2Sessions.get(sessionId);
    if (v2Info) {
      try {
        const query = (v2Info.session as any).query;
        if (query && typeof query.interrupt === "function") {
          await query.interrupt();
          claudeLog.info(`[Claude][${sessionId}] V2 session interrupted`);

          // Drain stale messages so the next send()+stream() cycle starts clean.
          // After interrupt, the CLI will emit remaining buffered messages and
          // finally a `result` message. We must consume them to avoid polluting
          // the next conversation turn.
          // Timeout after 5s to avoid blocking cancel indefinitely if CLI hangs.
          try {
            const drainTimeout = new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error("drain timeout")), 5000)
            );
            const drainWork = (async () => {
              for await (const msg of v2Info.session.stream()) {
                claudeLog.debug(`[Claude][${sessionId}] Drain after interrupt: ${(msg as any).type}`);
                if ((msg as any).type === "result") break;
              }
            })();
            await Promise.race([drainWork, drainTimeout]);
          } catch {
            // Stream may already be closed / errored / timed out — safe to ignore
          }
        } else {
          claudeLog.info(`[Claude][${sessionId}] Message cancelled (no interrupt available)`);
        }
      } catch (e) {
        claudeLog.warn(`[Claude][${sessionId}] Error interrupting session:`, e);
      }
    }

    // Reject pending questions/permissions for this session so the UI unblocks
    for (const [id, pending] of this.pendingQuestions) {
      if (pending.question.sessionId === sessionId) {
        pending.resolve("");
        this.pendingQuestions.delete(id);
      }
    }
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.permission.sessionId === sessionId) {
        pending.resolve({ behavior: "deny", message: "Cancelled" });
        this.pendingPermissions.delete(id);
      }
    }

    // Finalize if sendMessageV2's finally block hasn't already done so
    this.finalizeBuffer(sessionId, true);
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    // Return from in-memory history first
    const history = this.messageHistory.get(sessionId);
    if (history && history.length > 0) {
      return history;
    }

    // Resolve the CC session ID from in-memory v2Sessions
    const v2Info = this.v2Sessions.get(sessionId);
    const ccSessionId = v2Info?.capturedSessionId;

    if (!ccSessionId) {
      return [];
    }

    // Try to load from SDK session files
    const directory = v2Info?.directory ?? this.sessionDirectories.get(sessionId);
    try {
      const sdkMessages = await sdkGetSessionMessages(
        ccSessionId,
        directory ? { dir: directory } : undefined,
      );

      // Read timestamps from the raw .jsonl file (SDK strips them)
      const timestamps = directory
        ? readJsonlTimestamps(ccSessionId, directory)
        : new Map<string, number>();

      const messages = convertSdkMessages(sdkMessages, sessionId, timestamps);
      this.messageHistory.set(sessionId, messages);
      return messages;
    } catch (err) {
      claudeLog.warn(`[Claude][${sessionId}] Failed to load messages from SDK:`, err);
      return [];
    }
  }

  async getHistoricalMessages(
    engineSessionId: string,
    directory: string,
    engineMeta?: Record<string, unknown>,
  ): Promise<UnifiedMessage[]> {
    // engineSessionId for Claude is "cc_<ccSessionId>", extract the real CC session ID
    const ccSessionId =
      (engineMeta?.ccSessionId as string) ??
      (engineSessionId.startsWith("cc_") ? engineSessionId.slice(3) : engineSessionId);

    try {
      const sdkMessages = await sdkGetSessionMessages(
        ccSessionId,
        directory ? { dir: directory } : undefined,
      );

      const timestamps = directory
        ? readJsonlTimestamps(ccSessionId, directory)
        : new Map<string, number>();

      return convertSdkMessages(sdkMessages, engineSessionId, timestamps);
    } catch (err) {
      claudeLog.warn(`[Claude] Failed to get historical messages for ${ccSessionId}:`, err);
      return [];
    }
  }

  // ==========================================================================
  // Models
  // ==========================================================================

  /**
   * Fetch available models. Tries HTTP GET /v1/models first (supports custom
   * API endpoints / proxies), falls back to SDK supportedModels() if no
   * ANTHROPIC_API_KEY is available (e.g. when using CLI OAuth auth).
   */
  private async refreshModelCache(): Promise<void> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.options?.env,
    };

    // Resolve credentials: ANTHROPIC_API_KEY (X-Api-Key) or ANTHROPIC_AUTH_TOKEN (Bearer)
    const apiKey = env.ANTHROPIC_API_KEY;
    const authToken = env.ANTHROPIC_AUTH_TOKEN;
    const baseUrl = env.ANTHROPIC_BASE_URL;

    if (apiKey || authToken) {
      const success = await this.fetchModelsViaHttp(
        apiKey ? { type: "api-key", value: apiKey } : { type: "bearer", value: authToken! },
        baseUrl,
      );
      if (success) return;
    }

    // Fallback: use SDK query (works with CLI OAuth, but only returns official models)
    await this.fetchModelsViaSdk(env);
  }

  /**
   * Fetch models via HTTP GET /v1/models.
   * Supports three auth modes:
   * - Anthropic native: X-Api-Key header (when using ANTHROPIC_API_KEY with api.anthropic.com)
   * - Custom endpoint with API key: Bearer header (ANTHROPIC_API_KEY with non-Anthropic host)
   * - Custom endpoint with auth token: Bearer header (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL)
   */
  private async fetchModelsViaHttp(
    credential: { type: "api-key"; value: string } | { type: "bearer"; value: string },
    baseUrlEnv?: string,
  ): Promise<boolean> {
    try {
      // Normalize base URL: strip trailing slashes and known path suffixes
      let baseUrl = (baseUrlEnv || "https://api.anthropic.com").replace(/\/+$/, "");
      const suffixes = ["/chat/completions", "/completions", "/responses", "/v1/chat"];
      for (const suffix of suffixes) {
        if (baseUrl.endsWith(suffix)) {
          baseUrl = baseUrl.slice(0, -suffix.length);
          break;
        }
      }
      if (!baseUrl.includes("/v1")) {
        baseUrl = `${baseUrl}/v1`;
      }
      const modelsUrl = `${baseUrl}/models`;

      // Build auth headers based on credential type and target host
      const isAnthropicNative = new URL(modelsUrl).hostname.endsWith("anthropic.com");
      let headers: Record<string, string> = { "Content-Type": "application/json" };

      if (credential.type === "api-key" && isAnthropicNative) {
        // Anthropic native API uses X-Api-Key
        headers["X-Api-Key"] = credential.value;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        // Custom endpoints / proxies use Bearer (both api-key and auth-token)
        headers["Authorization"] = `Bearer ${credential.value}`;
      }

      claudeLog.info(`[Claude] Fetching models from ${modelsUrl}...`);

      const response = await fetch(modelsUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        claudeLog.warn(`[Claude] Models API returned ${response.status}: ${response.statusText}`);
        return false;
      }

      const data = (await response.json()) as { data?: Array<{ id: string; display_name?: string }> };

      if (!data.data || !Array.isArray(data.data)) {
        claudeLog.warn("[Claude] Unexpected models response format");
        return false;
      }

      const models = data.data
        .filter((m) => typeof m.id === "string")
        .map((m) => ({
          modelId: m.id,
          name: m.display_name || m.id,
          description: "",
          engineType: "claude" as EngineType,
        }))
        .sort((a, b) => a.modelId.localeCompare(b.modelId));

      if (models.length > 0) {
        this.cachedModels = models;
        claudeLog.info(`[Claude] Loaded ${models.length} models from ${modelsUrl}`);
        return true;
      }

      claudeLog.warn("[Claude] Models API returned empty list");
      return false;
    } catch (err) {
      claudeLog.warn("[Claude] Failed to fetch models via HTTP:", err);
      return false;
    }
  }

  /**
   * Fallback: fetch models via SDK query (spawns CLI subprocess).
   * Works with CLI OAuth auth but only returns Anthropic official models.
   */
  private async fetchModelsViaSdk(env: Record<string, string | undefined>): Promise<void> {
    try {
      claudeLog.info("[Claude] Fetching models via SDK query (fallback)...");

      // Don't let stale env var override the user's model selection
      const sdkEnv = { ...env };
      delete sdkEnv.ANTHROPIC_MODEL;
      delete sdkEnv.ELECTRON_RUN_AS_NODE;

      const q = sdkQuery({
        prompt: "",
        options: {
          model: this.currentModelId ?? "claude-sonnet-4-20250514",
          env: sdkEnv,
          abortController: new AbortController(),
          pathToClaudeCodeExecutable: this.resolveCliPath(),
        } as any,
      });

      const models = await q.supportedModels();
      q.close();

      if (models && models.length > 0) {
        this.cachedModels = models.map((m) => ({
          modelId: m.value,
          name: m.displayName || m.value,
          description: m.description || "",
          engineType: "claude" as EngineType,
        }));
        claudeLog.info(`[Claude] Loaded ${this.cachedModels.length} models via SDK`);
      } else {
        claudeLog.warn("[Claude] SDK returned empty model list");
      }
    } catch (err) {
      claudeLog.warn("[Claude] Failed to fetch models via SDK:", err);
    }
  }

  async listModels(): Promise<ModelListResult> {
    return {
      models: this.cachedModels,
      currentModelId: this.currentModelId ?? this.cachedModels[0]?.modelId,
    };
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.currentModelId = modelId;
    claudeLog.info(`[Claude] Model set to: ${modelId}`);

    // Close existing session to force recreation with new model
    const v2Info = this.v2Sessions.get(sessionId);
    if (v2Info) {
      try {
        v2Info.session.close();
      } catch {
        // Ignore
      }
      this.v2Sessions.delete(sessionId);
    }
  }

  // ==========================================================================
  // Modes
  // ==========================================================================

  getModes(): AgentMode[] {
    return DEFAULT_MODES;
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.sessionModes.set(sessionId, modeId);
    claudeLog.info(`[Claude][${sessionId}] Mode set to: ${modeId}`);

    // Close existing session to force recreation with new permission mode
    const v2Info = this.v2Sessions.get(sessionId);
    if (v2Info) {
      try {
        v2Info.session.close();
      } catch {
        // Ignore
      }
      this.v2Sessions.delete(sessionId);
    }
  }

  // ==========================================================================
  // Permissions
  // ==========================================================================

  async replyPermission(
    permissionId: string,
    reply: PermissionReply,
    _sessionId?: string,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      claudeLog.warn(
        `[Claude] No pending permission found for ID: ${permissionId}`,
      );
      return;
    }

    this.pendingPermissions.delete(permissionId);

    const isApproved =
      reply.optionId === "allow" ||
      reply.optionId === "allow_once" ||
      reply.optionId === "accept_once" ||
      reply.optionId === "allow_always";

    if (isApproved) {
      const result: PermissionResult = {
        behavior: "allow",
        updatedInput: pending.input,
      };
      // If "always allow", return the SDK's suggestions as updatedPermissions
      // so the SDK persists the rule for this session
      if (reply.optionId === "allow_always" && pending.suggestions) {
        result.updatedPermissions = pending.suggestions;
      }
      pending.resolve(result);
    } else {
      pending.resolve({ behavior: "deny", message: "Denied by user" });
    }

    this.emit("permission.replied", {
      permissionId,
      optionId: reply.optionId,
    });
  }

  /**
   * Create a canUseTool callback bound to a specific codemux session ID.
   * This callback is invoked by the SDK before each tool execution.
   */
  private createCanUseTool(sessionId: string): CanUseTool {
    return async (
      _toolName: string,
      input: Record<string, unknown>,
      _options: {
        signal: AbortSignal;
        suggestions?: PermissionUpdate[];
        blockedPath?: string;
        decisionReason?: string;
        toolUseID: string;
        agentID?: string;
      },
    ): Promise<PermissionResult> => {
      // --- Auto-approve all tools ---
      // Permissions are controlled via allowedTools + this callback.
      // We auto-allow everything to avoid blocking the agent workflow.
      return { behavior: "allow", updatedInput: input };
    };
  }

  /**
   * Handle AskUserQuestion tool calls by routing them through the question UI.
   */
  private handleAskUserQuestion(
    sessionId: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
  ): Promise<PermissionResult> {
    const questionId = timeId("q");
    const rawQuestions = (input.questions ?? []) as Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect?: boolean;
    }>;

    const questions: QuestionInfo[] = rawQuestions.map((q) => ({
      question: q.question,
      header: q.header ?? "",
      options: (q.options ?? []).map((o) => ({
        label: o.label,
        description: o.description,
      })),
      multiple: q.multiSelect ?? false,
      custom: true,
    }));

    const question: UnifiedQuestion = {
      id: questionId,
      sessionId,
      engineType: this.engineType,
      toolCallId: options.toolUseID,
      questions,
    };

    claudeLog.info(
      `[Claude][${sessionId}] AskUserQuestion: id=${questionId}, ${questions.length} questions`,
    );

    return new Promise<PermissionResult>((resolve) => {
      // Store pending question with a resolver that converts to PermissionResult
      this.pendingQuestions.set(questionId, {
        resolve: (answer: string) => {
          // Convert answer back to updatedInput with answers field
          resolve({
            behavior: "allow",
            updatedInput: { ...input, answers: { "0": answer } },
          });
        },
        question,
      });

      // Abort handling
      if (options.signal) {
        const onAbort = () => {
          if (this.pendingQuestions.has(questionId)) {
            this.pendingQuestions.delete(questionId);
            resolve({ behavior: "deny", message: "Aborted" });
          }
        };
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.emit("question.asked", { question });
    });
  }

  // ==========================================================================
  // Questions
  // ==========================================================================

  async replyQuestion(
    questionId: string,
    answers: string[][],
    _sessionId?: string,
  ): Promise<void> {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      claudeLog.warn(
        `[Claude] No pending question found for ID: ${questionId}`,
      );
      return;
    }

    this.pendingQuestions.delete(questionId);

    // Combine all answers (selected options + custom text) into one string
    const answer = (answers[0] ?? []).join("\n") || "";
    pending.resolve(answer);

    this.emit("question.replied", { questionId, answers });
  }

  async rejectQuestion(questionId: string, _sessionId?: string): Promise<void> {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return;

    this.pendingQuestions.delete(questionId);
    pending.resolve(""); // Empty answer = rejection
  }

  // ==========================================================================
  // Projects
  // ==========================================================================

  async listProjects(): Promise<UnifiedProject[]> {
    return [];
  }

  // ==========================================================================
  // V2 Session Management
  // ==========================================================================

  /**
   * Resolve the SDK's cli.js path for child process spawning.
   * In production Electron, the SDK is inside app.asar but child processes
   * can't read from ASAR archives. Rewrite to the app.asar.unpacked path.
   */
  private resolveCliPath(): string | undefined {
    try {
      const _require = createRequire(import.meta.url);
      const cliPath = _require.resolve("@anthropic-ai/claude-agent-sdk/cli.js");
      const asarMarker = `app.asar${sep}`;
      if (cliPath.includes(asarMarker)) {
        return cliPath.replace(asarMarker, `app.asar.unpacked${sep}`);
      }
      return cliPath;
    } catch {
      return undefined; // Let SDK resolve it with default logic
    }
  }

  /**
   * Get or create a V2 Session for the given session ID.
   * V2 Sessions enable process reuse — subsequent messages reuse the running
   * Claude Code subprocess.
   */
  private async getOrCreateV2Session(
    sessionId: string,
    directory: string,
    opts: {
      model?: string;
      permissionMode?: "default" | "plan" | "acceptEdits" | "dontAsk";
    },
  ): Promise<SDKSession> {
    const existing = this.v2Sessions.get(sessionId);
    if (existing) {
      // Check if permissionMode changed — must recreate session if so
      const requestedMode = opts.permissionMode ?? "default";
      if (existing.permissionMode !== requestedMode) {
        claudeLog.info(
          `[Claude][${sessionId}] permissionMode changed from ${existing.permissionMode} to ${requestedMode}, recreating session`,
        );
        this.cleanupSession(sessionId, "permissionMode changed");
      } else {
        // Check if session is still ready
        try {
          // V2 session transport may have died; we detect this when stream() fails
          existing.lastUsedAt = Date.now();
          return existing.session;
        } catch {
          // Session is dead, recreate
          this.cleanupSession(sessionId, "session not ready");
        }
      }
    }

    claudeLog.info(
      `[Claude][${sessionId}] Creating new V2 session in ${directory}`,
    );
    const startTime = Date.now();

    // Check if this session has a previous CC session ID for resumption
    const ccSessionId = this.sessionCcIds.get(sessionId);

    // Build environment variables
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.options?.env,
    };
    // Don't let stale env var override the user's model selection
    delete env.ANTHROPIC_MODEL;
    // Remove ELECTRON_RUN_AS_NODE which leaks from Electron and can
    // interfere with child process behavior
    delete env.ELECTRON_RUN_AS_NODE;

    // Build SDK session options
    // We use 'as any' because the SDK v0.2.x SDKSessionOptions type is still
    // narrower than the internal Options type. The SDK internally passes these
    // through to ProcessTransport which accepts all Options fields.
    const sdkOptions: any = {
      model: opts.model ?? this.currentModelId ?? "claude-sonnet-4-20250514",
      env,
      permissionMode: opts.permissionMode ?? "default",
      allowedTools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "WebFetch", "WebSearch", "Task", "TodoWrite", "TodoRead", "NotebookEdit"],
      canUseTool: this.createCanUseTool(sessionId),
      systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: CODEMUX_IDENTITY_PROMPT },
      pathToClaudeCodeExecutable: this.resolveCliPath(),
    };

    // Set working directory (requires SDK patch: patches/@anthropic-ai+claude-agent-sdk+0.2.63.patch)
    if (directory) {
      sdkOptions.cwd = directory.replaceAll("/", process.platform === "win32" ? "\\" : "/");
    }

    let v2Session: SDKSession;

    if (ccSessionId) {
      // Resume existing session
      claudeLog.info(
        `[Claude][${sessionId}] Resuming CC session: ${ccSessionId}`,
      );
      v2Session = unstable_v2_resumeSession(ccSessionId, sdkOptions);
    } else {
      // Create new session
      v2Session = unstable_v2_createSession(sdkOptions);
    }

    claudeLog.info(
      `[Claude][${sessionId}] V2 session created in ${Date.now() - startTime}ms`,
    );

    const info: V2SessionInfo = {
      session: v2Session,
      directory,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      capturedSessionId: ccSessionId,
      permissionMode: opts.permissionMode ?? "default",
    };

    this.v2Sessions.set(sessionId, info);
    return v2Session;
  }

  /**
   * Clean up a V2 session.
   */
  private cleanupSession(sessionId: string, reason: string): void {
    const info = this.v2Sessions.get(sessionId);
    if (!info) return;

    claudeLog.info(`[Claude][${sessionId}] Cleaning up session: ${reason}`);

    try {
      info.session.close();
    } catch {
      // Ignore close errors
    }

    this.v2Sessions.delete(sessionId);
  }

  // ==========================================================================
  // Stream Processing
  // ==========================================================================

  /**
   * Send a message to the V2 session and process the streaming response.
   * This is the core of the adapter — it translates SDK stream events into
   * unified parts and emits them to the gateway.
   *
   * When enqueued messages exist, the CLI produces multiple result messages
   * (one per queued message). stream() yields events up to each result then
   * returns. We loop: finalize the current buffer, resolve the oldest resolver,
   * and if more resolvers remain, create a new buffer and call stream() again.
   */
  private async processStream(
    v2Session: SDKSession,
    sessionId: string,
    messageContent: string,
    buffer: MessageBuffer,
    abortController: AbortController,
  ): Promise<void> {
    const streamingBlocks = new Map<number, StreamingBlock>();

    try {
      // Send the message
      await v2Session.send(messageContent);

      // Process stream events — loop to handle multiple turns from enqueued messages
      while (!abortController.signal.aborted) {
        for await (const sdkMessage of v2Session.stream()) {
          if (abortController.signal.aborted) break;

          this.handleSdkMessage(
            sdkMessage,
            sessionId,
            buffer,
            streamingBlocks,
          );
        }

        // stream() returned (hit a result message) — finalize the current turn
        this.finalizeCurrentTurn(sessionId, buffer, false);

        // Check if more enqueued messages need processing
        const resolvers = this.sendResolvers.get(sessionId);
        if (!resolvers || resolvers.length === 0) break;

        // More enqueued messages remain — create a new buffer for the next turn
        // First, emit the deferred user message (stored during enqueue) so the
        // frontend creates the user bubble at the right time.
        const pendingUsers = this.pendingUserMessages.get(sessionId);
        if (pendingUsers && pendingUsers.length > 0) {
          const userMsg = pendingUsers.shift()!;
          if (pendingUsers.length === 0) this.pendingUserMessages.delete(sessionId);
          this.emit("message.updated", { sessionId, message: userMsg });
        }

        // Send the next queued text to CLI stdin (one at a time)
        const pendingTexts = this.pendingMessageTexts.get(sessionId);
        if (pendingTexts && pendingTexts.length > 0) {
          const nextText = pendingTexts.shift()!;
          if (pendingTexts.length === 0) this.pendingMessageTexts.delete(sessionId);
          await v2Session.send(nextText);
        }

        buffer = {
          messageId: timeId("msg"),
          sessionId,
          parts: [],
          textAccumulator: "",
          textPartId: null,
          reasoningAccumulator: "",
          reasoningPartId: null,
          startTime: Date.now(),
          modelId: buffer.modelId,
        };
        this.messageBuffers.set(sessionId, buffer);
        streamingBlocks.clear();

        // Emit initial empty assistant message for the next turn
        this.emit("message.updated", {
          sessionId,
          message: {
            id: buffer.messageId,
            sessionId,
            role: "assistant",
            time: { created: Date.now() },
            parts: [],
            workingDirectory: this.sessionDirectories.get(sessionId),
          },
        });
      }
    } catch (err: any) {
      if (abortController.signal.aborted) {
        claudeLog.info(`[Claude][${sessionId}] Stream aborted`);
      } else {
        claudeLog.error(`[Claude][${sessionId}] Stream error:`, err);
        buffer.error = err?.message ?? String(err);
        // Finalize with error — resolves all remaining resolvers
        this.finalizeBuffer(sessionId, false);
      }
    } finally {
      this.activeAbortControllers.delete(sessionId);
      // If the loop was broken by abort, finalize any remaining buffer
      if (this.messageBuffers.has(sessionId)) {
        this.finalizeBuffer(sessionId, abortController.signal.aborted);
      }
    }
  }

  /**
   * Handle a single SDK message from the stream.
   */
  private handleSdkMessage(
    msg: SDKMessage,
    sessionId: string,
    buffer: MessageBuffer,
    streamingBlocks: Map<number, StreamingBlock>,
  ): void {
    switch (msg.type) {
      case "system":
        this.handleSystemMessage(msg, sessionId, buffer);
        break;

      case "assistant":
        this.handleAssistantMessage(msg, sessionId, buffer);
        break;

      case "user":
        this.handleUserMessage(msg, sessionId, buffer);
        break;

      case "result":
        this.handleResultMessage(msg, sessionId, buffer);
        break;

      case "stream_event":
        this.handleStreamEvent(
          msg as any,
          sessionId,
          buffer,
          streamingBlocks,
        );
        break;

      default:
        // tool_progress, auth_status, etc. — log but don't process
        claudeLog.info(
          `[Claude][${sessionId}] Unhandled message type: ${(msg as any).type}`,
        );
        break;
    }
  }

  /**
   * Handle system init message — captures session ID, tools, model info.
   */
  private handleSystemMessage(
    msg: any,
    sessionId: string,
    buffer: MessageBuffer,
  ): void {
    if (msg.subtype === "init") {
      const ccSessionId = msg.session_id;

      if (ccSessionId) {
        // Store the CC session ID in the in-memory V2 session for future resumption
        const v2Info = this.v2Sessions.get(sessionId);
        if (v2Info) {
          v2Info.capturedSessionId = ccSessionId;
        }

        // Emit ccSessionId so EngineManager can persist it in ConversationStore
        this.emit("session.updated", {
          session: {
            id: sessionId,
            engineType: this.engineType,
            engineMeta: { ccSessionId },
          },
        });
      }

      // Extract version info
      if (msg.claude_code_version) {
        this.version = msg.claude_code_version;
      }

      // Extract model info
      if (msg.model) {
        buffer.modelId = msg.model;
      }

      claudeLog.info(
        `[Claude][${sessionId}] System init: session=${ccSessionId}, model=${msg.model}`,
      );
    } else if (msg.subtype === "status") {
      // Handle status changes (e.g., compacting)
      if (msg.status === "compacting") {
        claudeLog.info(
          `[Claude][${sessionId}] Context compacting...`,
        );
      }
    }
  }

  /**
   * Handle complete assistant message (non-streaming).
   * Extracts text and tool_use content blocks.
   */
  private handleAssistantMessage(
    msg: any,
    sessionId: string,
    buffer: MessageBuffer,
  ): void {
    const betaMessage = msg.message;
    if (!betaMessage?.content) return;

    // Extract token usage
    if (betaMessage.usage) {
      buffer.tokens = {
        input: betaMessage.usage.input_tokens ?? 0,
        output: betaMessage.usage.output_tokens ?? 0,
        cache: {
          read: betaMessage.usage.cache_read_input_tokens ?? 0,
          write: betaMessage.usage.cache_creation_input_tokens ?? 0,
        },
      };
    }

    // Process content blocks
    for (const block of betaMessage.content) {
      if (block.type === "text") {
        this.appendText(sessionId, buffer, block.text ?? "");
      } else if (block.type === "thinking") {
        this.appendReasoning(sessionId, buffer, block.thinking ?? "");
      } else if (block.type === "tool_use") {
        // Flush accumulated text first
        this.flushTextAccumulator(sessionId, buffer);

        // Create tool part
        this.createToolPart(
          sessionId,
          buffer,
          block.id,
          block.name,
          block.input,
        );
      }
    }
  }

  /**
   * Handle user messages from the stream (typically tool_result).
   */
  private handleUserMessage(
    msg: any,
    sessionId: string,
    buffer: MessageBuffer,
  ): void {
    const betaMessage = msg.message;
    if (!betaMessage?.content) return;

    for (const block of betaMessage.content) {
      if (block.type === "tool_result") {
        this.handleToolResult(sessionId, buffer, block);
      }
    }
  }

  /**
   * Handle result message — marks completion with final token usage and cost.
   */
  private handleResultMessage(
    msg: any,
    sessionId: string,
    buffer: MessageBuffer,
  ): void {
    // Extract final usage
    if (msg.usage) {
      buffer.tokens = {
        input: msg.usage.input_tokens ?? buffer.tokens?.input ?? 0,
        output: msg.usage.output_tokens ?? buffer.tokens?.output ?? 0,
        cache: {
          read: msg.usage.cache_read_input_tokens ?? buffer.tokens?.cache?.read ?? 0,
          write: msg.usage.cache_creation_input_tokens ?? buffer.tokens?.cache?.write ?? 0,
        },
      };
    }

    if (msg.total_cost_usd != null) {
      buffer.cost = msg.total_cost_usd;
    }

    // Check for error results
    if (msg.is_error) {
      buffer.error = msg.result ?? "Unknown error";
    }

    claudeLog.info(
      `[Claude][${sessionId}] Result: cost=$${buffer.cost?.toFixed(4)}, ` +
        `tokens=${buffer.tokens?.input ?? 0}/${buffer.tokens?.output ?? 0}`,
    );
  }

  /**
   * Handle streaming partial events (text_delta, thinking_delta, tool input).
   */
  private handleStreamEvent(
    msg: any,
    sessionId: string,
    buffer: MessageBuffer,
    streamingBlocks: Map<number, StreamingBlock>,
  ): void {
    const event = msg.event ?? msg;

    if (!event?.type) return;

    switch (event.type) {
      case "content_block_start": {
        const idx = event.index;
        const contentBlock = event.content_block;
        if (!contentBlock) break;

        const block: StreamingBlock = {
          index: idx,
          type: contentBlock.type,
          content: "",
        };

        if (contentBlock.type === "tool_use") {
          block.toolName = contentBlock.name;
          block.toolId = contentBlock.id;

          // Flush accumulated text before tool call
          this.flushTextAccumulator(sessionId, buffer);

          // Create the step-start + tool part early
          const stepStartPart: StepStartPart = { type: "step-start", id: timeId("pt"), messageId: buffer.messageId, sessionId };
          buffer.parts.push(stepStartPart);
          this.emitPartUpdated(sessionId, buffer, stepStartPart);

          // Create a pending tool part
          const toolPartId = timeId("tp");
          const normalizedTool = normalizeToolName("claude", contentBlock.name ?? "unknown");
          const toolPart: ToolPart = {
            type: "tool",
            id: toolPartId,
            messageId: buffer.messageId,
            sessionId,
            callId: contentBlock.id ?? toolPartId,
            normalizedTool,
            originalTool: contentBlock.name ?? "unknown",
            title: contentBlock.name ?? "Tool call",
            kind: inferToolKind(undefined, normalizedTool),
            state: { status: "running", input: {}, time: { start: Date.now() } },
          };

          buffer.parts.push(toolPart);
          this.toolCallParts.set(contentBlock.id ?? toolPartId, toolPart);
          this.emitPartUpdated(sessionId, buffer, toolPart);
        } else if (contentBlock.type === "thinking") {
          // Start reasoning block
          block.content = contentBlock.thinking ?? "";
        }

        streamingBlocks.set(idx, block);
        break;
      }

      case "content_block_delta": {
        const idx = event.index;
        const block = streamingBlocks.get(idx);
        if (!block) break;

        const delta = event.delta;
        if (!delta) break;

        if (delta.type === "text_delta" && delta.text) {
          block.content += delta.text;
          this.appendText(sessionId, buffer, delta.text);
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          block.content += delta.thinking;
          this.appendReasoning(sessionId, buffer, delta.thinking);
        } else if (delta.type === "input_json_delta" && delta.partial_json) {
          block.content += delta.partial_json;
          // Tool input JSON accumulates but we don't parse until complete
        }
        break;
      }

      case "content_block_stop": {
        const idx = event.index;
        const block = streamingBlocks.get(idx);
        if (!block) break;

        if (block.type === "tool_use" && block.toolId) {
          // Parse accumulated JSON input for the tool
          let parsedInput: Record<string, unknown> = {};
          try {
            if (block.content.trim()) {
              parsedInput = JSON.parse(block.content);
            }
          } catch {
            parsedInput = { raw: block.content };
          }

          // Update tool part with parsed input
          const toolPart = this.toolCallParts.get(block.toolId);
          if (toolPart && toolPart.state.status === "running") {
            (toolPart.state as any).input = parsedInput;
            this.emitPartUpdated(sessionId, buffer, toolPart);
          }
        }

        streamingBlocks.delete(idx);
        break;
      }

      case "message_start":
      case "message_delta":
      case "message_stop":
        // These are message-level events, no action needed for parts
        break;

      default:
        break;
    }
  }

  // ==========================================================================
  // Text & Reasoning Accumulation
  // ==========================================================================

  private appendText(
    sessionId: string,
    buffer: MessageBuffer,
    text: string,
  ): void {
    buffer.textAccumulator += text;

    // Trim leading whitespace from the first text content. Some models send
    // initial deltas with newlines/whitespace before the actual response,
    // which would render as empty lines at the top of the message.
    if (!buffer.leadingTrimmed) {
      const trimmed = buffer.textAccumulator.trimStart();
      if (!trimmed) return; // All whitespace so far — buffer but don't emit
      buffer.textAccumulator = trimmed;
      buffer.leadingTrimmed = true;
    }

    if (!buffer.textPartId) {
      // Create a new text part
      buffer.textPartId = timeId("tp");
      const textPart: TextPart = {
        type: "text",
        id: buffer.textPartId,
        messageId: buffer.messageId,
        sessionId,
        text: buffer.textAccumulator,
      };
      buffer.parts.push(textPart);
      this.emitPartUpdated(sessionId, buffer, textPart);
    } else {
      // Update existing text part with accumulated text
      const textPart = buffer.parts.find(
        (p) => p.type === "text" && p === this.findLastTextPart(buffer),
      ) as TextPart | undefined;
      if (textPart) {
        textPart.text = buffer.textAccumulator;
        this.emitPartUpdated(sessionId, buffer, textPart);
      }
    }
  }

  private appendReasoning(
    sessionId: string,
    buffer: MessageBuffer,
    text: string,
  ): void {
    buffer.reasoningAccumulator += text;

    if (!buffer.reasoningPartId) {
      buffer.reasoningPartId = timeId("tp");
      const reasoningPart: ReasoningPart = {
        type: "reasoning",
        id: buffer.reasoningPartId,
        messageId: buffer.messageId,
        sessionId,
        text: buffer.reasoningAccumulator,
      };
      buffer.parts.push(reasoningPart);
      this.emitPartUpdated(sessionId, buffer, reasoningPart);
    } else {
      const reasoningPart = buffer.parts.find(
        (p) => p.type === "reasoning",
      ) as ReasoningPart | undefined;
      if (reasoningPart) {
        reasoningPart.text = buffer.reasoningAccumulator;
        this.emitPartUpdated(sessionId, buffer, reasoningPart);
      }
    }
  }

  private findLastTextPart(buffer: MessageBuffer): TextPart | undefined {
    for (let i = buffer.parts.length - 1; i >= 0; i--) {
      if (buffer.parts[i].type === "text") return buffer.parts[i] as TextPart;
    }
    return undefined;
  }

  private flushTextAccumulator(
    sessionId: string,
    buffer: MessageBuffer,
  ): void {
    if (buffer.textAccumulator.trim()) {
      // Text part is already maintained in parts array via appendText
      // Reset accumulator for next text block
      buffer.textAccumulator = "";
      buffer.textPartId = null;
    }
  }

  // ==========================================================================
  // Tool Handling
  // ==========================================================================

  private createToolPart(
    sessionId: string,
    buffer: MessageBuffer,
    toolCallId: string,
    toolName: string,
    input: any,
  ): void {
    const normalizedTool = normalizeToolName("claude", toolName);
    const toolPartId = timeId("tp");
    const toolPart: ToolPart = {
      type: "tool",
      id: toolPartId,
      messageId: buffer.messageId,
      sessionId,
      callId: toolCallId,
      normalizedTool,
      originalTool: toolName,
      title: toolName,
      kind: inferToolKind(undefined, normalizedTool),
      state: {
        status: "running",
        input: input ?? {},
        time: { start: Date.now() },
      },
    };

    const stepStartPart: StepStartPart = { type: "step-start", id: timeId("pt"), messageId: buffer.messageId, sessionId };
    buffer.parts.push(stepStartPart);
    this.emitPartUpdated(sessionId, buffer, stepStartPart);

    buffer.parts.push(toolPart);
    this.toolCallParts.set(toolCallId, toolPart);
    this.emitPartUpdated(sessionId, buffer, toolPart);
  }

  private handleToolResult(
    sessionId: string,
    buffer: MessageBuffer,
    block: any,
  ): void {
    const toolCallId = block.tool_use_id;
    const toolPart = this.toolCallParts.get(toolCallId);

    if (!toolPart) {
      claudeLog.warn(
        `[Claude][${sessionId}] Tool result for unknown tool call: ${toolCallId}`,
      );
      return;
    }

    // Extract output text
    let output = "";
    if (typeof block.content === "string") {
      output = block.content;
    } else if (Array.isArray(block.content)) {
      output = block.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
    }

    const now = Date.now();
    const startTime =
      toolPart.state.status === "running"
        ? toolPart.state.time.start
        : now;

    if (block.is_error) {
      toolPart.state = {
        status: "error",
        input: (toolPart.state as any).input ?? {},
        error: output,
        time: { start: startTime, end: now, duration: now - startTime },
      };
    } else {
      toolPart.state = {
        status: "completed",
        input: (toolPart.state as any).input ?? {},
        output,
        time: { start: startTime, end: now, duration: now - startTime },
      };
    }

    // Add step-finish
    const stepFinishPart: StepFinishPart = { type: "step-finish", id: timeId("pt"), messageId: buffer.messageId, sessionId };
    buffer.parts.push(stepFinishPart);
    this.emitPartUpdated(sessionId, buffer, stepFinishPart);

    // Emit updated tool part
    this.emitPartUpdated(sessionId, buffer, toolPart);
  }

  // ==========================================================================
  // Buffer Finalization
  // ==========================================================================

  /**
   * Finalize the current turn's buffer and resolve the oldest resolver.
   * Used when processing enqueued messages — each result message triggers
   * finalization of one turn, leaving remaining resolvers for subsequent turns.
   */
  private finalizeCurrentTurn(sessionId: string, buffer: MessageBuffer, aborted: boolean): void {
    // Flush any remaining text
    this.flushTextAccumulator(sessionId, buffer);

    // Build final message
    const finalMessage: UnifiedMessage = {
      id: buffer.messageId,
      sessionId: buffer.sessionId,
      role: "assistant",
      time: { created: buffer.startTime, completed: Date.now() },
      parts: buffer.parts,
      tokens: buffer.tokens
        ? {
            input: buffer.tokens.input,
            output: buffer.tokens.output,
            cache: buffer.tokens.cache
              ? { read: buffer.tokens.cache.read, write: buffer.tokens.cache.write }
              : undefined,
          }
        : undefined,
      cost: buffer.cost,
      modelId: buffer.modelId,
      error: buffer.error,
      workingDirectory: this.sessionDirectories.get(sessionId),
    };

    // Add to history
    const history = this.messageHistory.get(sessionId) ?? [];
    history.push(finalMessage);
    this.messageHistory.set(sessionId, history);

    // Emit final message
    this.emit("message.updated", { sessionId: buffer.sessionId, message: finalMessage });

    // Clean up buffer and tool call parts for this turn
    this.messageBuffers.delete(sessionId);
    for (const [key, part] of this.toolCallParts) {
      if (part.sessionId === sessionId) {
        this.toolCallParts.delete(key);
      }
    }

    // Resolve only the first (oldest) resolver — the one that owns this turn
    const resolvers = this.sendResolvers.get(sessionId);
    if (resolvers && resolvers.length > 0) {
      const first = resolvers.shift()!;
      first.resolve(finalMessage);

      if (resolvers.length === 0) {
        this.sendResolvers.delete(sessionId);
      } else {
        // More enqueued messages remain
        this.emit("message.queued.consumed", { sessionId, messageId: "" });
      }
    }
  }

  private finalizeBuffer(sessionId: string, aborted: boolean): void {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return;

    // Flush any remaining text
    this.flushTextAccumulator(sessionId, buffer);

    // Build final message
    const finalMessage: UnifiedMessage = {
      id: buffer.messageId,
      sessionId: buffer.sessionId,
      role: "assistant",
      time: { created: buffer.startTime, completed: Date.now() },
      parts: buffer.parts,
      tokens: buffer.tokens
        ? {
            input: buffer.tokens.input,
            output: buffer.tokens.output,
            cache: buffer.tokens.cache
              ? { read: buffer.tokens.cache.read, write: buffer.tokens.cache.write }
              : undefined,
          }
        : undefined,
      cost: buffer.cost,
      modelId: buffer.modelId,
      error: buffer.error,
      workingDirectory: this.sessionDirectories.get(sessionId),
    };

    // Add to history
    const history = this.messageHistory.get(sessionId) ?? [];
    history.push(finalMessage);
    this.messageHistory.set(sessionId, history);

    // Emit final message
    this.emit("message.updated", { sessionId: buffer.sessionId, message: finalMessage });

    // Title updates are handled by EngineManager's applyTitleFallback()

    // Clean up
    this.messageBuffers.delete(sessionId);
    for (const [key, part] of this.toolCallParts) {
      if (part.sessionId === sessionId) {
        this.toolCallParts.delete(key);
      }
    }

    // Resolve ALL sendMessage promises (including enqueued) — used for abort/error
    const resolvers = this.sendResolvers.get(sessionId);
    if (resolvers) {
      this.sendResolvers.delete(sessionId);
      for (const r of resolvers) r.resolve(finalMessage);
    }
    // Clear any deferred user messages that were never emitted
    this.pendingUserMessages.delete(sessionId);
    // Clear any queued message texts that were never sent to CLI
    this.pendingMessageTexts.delete(sessionId);
  }

  // ==========================================================================
  // Event Emission Helpers
  // ==========================================================================

  private emitPartUpdated(
    sessionId: string,
    buffer: MessageBuffer,
    part: UnifiedPart,
  ): void {
    this.emit("message.part.updated", {
      sessionId,
      messageId: buffer.messageId,
      part,
    });
  }

  // ==========================================================================
  // Session Cleanup
  // ==========================================================================

  private startSessionCleanup(): void {
    if (this.cleanupIntervalId) return;

    this.cleanupIntervalId = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, info] of Array.from(this.v2Sessions.entries())) {
        // Skip sessions with active requests
        if (this.activeAbortControllers.has(sessionId)) {
          info.lastUsedAt = now;
          continue;
        }

        // Clean up idle sessions
        if (now - info.lastUsedAt > SESSION_IDLE_TIMEOUT_MS) {
          this.cleanupSession(sessionId, "idle timeout (30 min)");
        }
      }
    }, 60 * 1000);
  }

  private stopSessionCleanup(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }

  // ==========================================================================
  // Pending Interaction Cleanup
  // ==========================================================================

  private rejectAllPendingPermissions(reason: string): void {
    for (const [_id, pending] of this.pendingPermissions) {
      pending.resolve({ behavior: "deny", message: reason });
    }
    this.pendingPermissions.clear();
  }

  private rejectAllPendingQuestions(reason: string): void {
    for (const [_id, pending] of this.pendingQuestions) {
      pending.resolve("");
    }
    this.pendingQuestions.clear();
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private setStatus(
    status: EngineStatus,
    error?: string,
  ): void {
    this.status = status;
    this.emit("status.changed", {
      engineType: this.engineType,
      status,
      error,
    });
  }
}
