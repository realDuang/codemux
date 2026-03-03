// ============================================================================
// Claude Code Adapter — Claude Code integration via @anthropic-ai/claude-agent-sdk
//
// Uses the official SDK's V2 Session API (unstable_v2_createSession) which spawns
// a Claude Code CLI subprocess communicating over stdio JSON-RPC.
// V2 Sessions enable process reuse: subsequent messages in the same conversation
// reuse the running CC process, avoiding cold start (~3-5s) each time.
// ============================================================================

import { randomBytes } from "crypto";
import { existsSync, unlinkSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { app } from "electron";
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  listSessions as sdkListSessions,
  getSessionMessages as sdkGetSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKSession,
  SDKSessionOptions,
  SDKMessage,
  SDKSessionInfo,
  ModelInfo,
  Options,
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";

import { EngineAdapter } from "./engine-adapter";
import { sessionStore } from "../services/session-store";
import { mainLog } from "../services/logger";
import { inferToolKind } from "../../../src/types/tool-mapping";
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
  NormalizedToolName,
  PermissionOption,
  QuestionInfo,
} from "../../../src/types/unified";

// ============================================================================
// Time-sortable ID generator (same pattern as CopilotSdkAdapter)
// ============================================================================

let _lastTs = 0;
let _counter = 0;

function timeId(prefix: string): string {
  const now = Date.now();
  if (now === _lastTs) {
    _counter++;
  } else {
    _lastTs = now;
    _counter = 0;
  }
  const timePart = now.toString(16).padStart(12, "0");
  const counterPart = (_counter & 0xffff).toString(16).padStart(4, "0");
  const rand = randomBytes(5).toString("hex");
  return `${prefix}_${timePart}${counterPart}${rand}`;
}

// ============================================================================
// Claude Code Tool Name Mapping
// ============================================================================

const CLAUDE_TOOL_MAP: Record<string, NormalizedToolName> = {
  Bash: "shell",
  Read: "read",
  Write: "write",
  Edit: "edit",
  Grep: "grep",
  Glob: "glob",
  WebFetch: "web_fetch",
  WebSearch: "web_fetch",
  Task: "task",
  TodoWrite: "todo",
  TodoRead: "todo",
  NotebookEdit: "edit",
  LSP: "read",
  AskUserQuestion: "unknown",
  Skill: "unknown",
  EnterPlanMode: "unknown",
  ExitPlanMode: "unknown",
};

function normalizeClaudeToolName(toolName: string): NormalizedToolName {
  return (
    CLAUDE_TOOL_MAP[toolName] ??
    CLAUDE_TOOL_MAP[toolName.toLowerCase()] ??
    "unknown"
  );
}

// ============================================================================
// Message Buffer — Accumulates streaming events into a complete message
// ============================================================================

interface MessageBuffer {
  messageId: string;
  sessionId: string;
  parts: UnifiedPart[];
  textAccumulator: string;
  textPartId: string | null;
  reasoningAccumulator: string;
  reasoningPartId: string | null;
  startTime: number;
  tokens?: {
    input: number;
    output: number;
    cache?: { read: number; write: number };
  };
  cost?: number;
  modelId?: string;
  error?: string;
}

// ============================================================================
// V2 Session Info — Tracks a persistent SDK session
// ============================================================================

interface V2SessionInfo {
  session: SDKSession;
  directory: string;
  createdAt: number;
  lastUsedAt: number;
  capturedSessionId?: string; // CC's internal session ID from system init message
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
  /** True when model is overridden by env var (ANTHROPIC_MODEL) — disables model switching */
  private isCustomEnvModel = false;
  private sessionModes = new Map<string, string>();

  // --- Message accumulation ---
  private messageBuffers = new Map<string, MessageBuffer>();
  private messageHistory = new Map<string, UnifiedMessage[]>();

  // --- Pending interactions ---
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingQuestions = new Map<string, PendingQuestion>();

  // --- Message send completion ---
  private sendResolvers = new Map<
    string,
    {
      resolve: (msg: UnifiedMessage) => void;
      reject: (err: Error) => void;
    }
  >();

  // --- Tool call tracking ---
  private toolCallParts = new Map<string, ToolPart>();
  private toolIdToThoughtId = new Map<string, string>();

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
    mainLog.info("Starting Claude Code adapter...");

    try {
      // Claude Code CLI is available globally (installed via npm install -g @anthropic-ai/claude-code)
      // The SDK will find it automatically, or we can specify pathToClaudeCodeExecutable.
      // No separate server process to manage — the SDK spawns CLI subprocesses per session.

      // Set default model — check env var override first
      const envModel = process.env.ANTHROPIC_MODEL || this.options?.env?.ANTHROPIC_MODEL;
      if (envModel) {
        this.currentModelId = envModel;
        this.isCustomEnvModel = true;
        mainLog.info(`[Claude] Using custom env model: ${envModel}`);
      } else {
        this.currentModelId = this.options?.model ?? null;
        this.isCustomEnvModel = false;
      }

      // Start cleanup interval
      this.startSessionCleanup();

      this.setStatus("running");
      mainLog.info("Claude Code adapter started successfully");
    } catch (err) {
      mainLog.error("Failed to start Claude Code adapter:", err);
      this.setStatus("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.status === "stopped") return;

    mainLog.info("Stopping Claude Code adapter...");

    // Close all V2 sessions
    for (const [sessionId, info] of this.v2Sessions) {
      try {
        info.session.close();
      } catch (e) {
        mainLog.warn(`Error closing Claude session ${sessionId}:`, e);
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
      modelSwitchable: !this.isCustomEnvModel,
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

      // Build a set of ccSessionIds already tracked by codemux-created sessions (cs_*).
      // These sessions have richer state (streaming history, V2 session info) so we
      // skip the SDK-imported duplicate (cc_*) to avoid showing two entries for the
      // same underlying Claude Code conversation.
      const knownCcIds = new Set<string>();
      for (const s of sessionStore.getSessionsByEngine(this.engineType)) {
        const ccId = s.engineMeta?.ccSessionId as string | undefined;
        if (ccId && !s.id.startsWith("cc_")) {
          knownCcIds.add(ccId);
        }
      }

      const sessions = sdkSessions
        .filter((s) => !knownCcIds.has(s.sessionId))
        .map((s) => this.sdkSessionToUnified(s, directory));
      sessionStore.mergeSessions(sessions, this.engineType);
    } catch (err) {
      mainLog.warn("Failed to list Claude sessions from SDK:", err);
    }

    // Return from session store (merged source of truth)
    const allSessions = sessionStore.getSessionsByEngine(this.engineType);
    if (directory) {
      const normDir = directory.replaceAll("\\", "/");
      return allSessions.filter((s) => s.directory === normDir);
    }
    return allSessions;
  }

  async createSession(directory: string): Promise<UnifiedSession> {
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

    sessionStore.upsertSession(session);
    this.emit("session.created", { session });

    return session;
  }

  async getSession(sessionId: string): Promise<UnifiedSession | null> {
    return sessionStore.getSession(sessionId) ?? null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Abort any active request for this session
    const controller = this.activeAbortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeAbortControllers.delete(sessionId);
    }

    // Reject pending send promise so callers don't hang
    const resolver = this.sendResolvers.get(sessionId);
    if (resolver) {
      resolver.reject(new Error("Session deleted"));
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
    const session = sessionStore.getSession(sessionId);
    const ccSessionId =
      v2Info?.capturedSessionId ??
      (session?.engineMeta?.ccSessionId as string | undefined);
    if (ccSessionId && session?.directory) {
      this.deleteCCSessionFile(ccSessionId, session.directory);
    }

    sessionStore.deleteSession(sessionId);
    this.messageHistory.delete(sessionId);
    this.messageBuffers.delete(sessionId);
    this.sessionModes.delete(sessionId);
  }

  // ==========================================================================
  // Claude Code session file management
  // ==========================================================================

  /**
   * Map a project directory to Claude Code's folder name convention.
   * Mirrors the SDK's internal v9() function: replace all non-alphanumeric
   * chars with '-', truncate + hash if longer than 200 chars.
   */
  private static ccProjectFolder(directory: string): string {
    const MAX_PREFIX = 200;
    const sanitized = directory.replace(/[^a-zA-Z0-9]/g, "-");
    if (sanitized.length <= MAX_PREFIX) return sanitized;
    // Simple string hash matching SDK's iq() fallback
    let hash = 0;
    for (let i = 0; i < directory.length; i++) {
      hash = ((hash << 5) - hash + directory.charCodeAt(i)) | 0;
    }
    return `${sanitized.slice(0, MAX_PREFIX)}-${(hash >>> 0).toString(36)}`;
  }

  /**
   * Get the Claude Code config directory (respects CLAUDE_CONFIG_DIR env var).
   */
  private static ccConfigDir(): string {
    return (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
  }

  /**
   * Find the Claude Code projects directory for a given workspace directory.
   * Handles the fallback logic for long paths where the hash suffix may differ.
   */
  private findCCProjectDir(directory: string): string | null {
    const projectsDir = join(ClaudeCodeAdapter.ccConfigDir(), "projects");
    if (!existsSync(projectsDir)) return null;

    const folderName = ClaudeCodeAdapter.ccProjectFolder(directory);
    const exactPath = join(projectsDir, folderName);
    if (existsSync(exactPath)) return exactPath;

    // Fallback for long paths: match by prefix
    if (folderName.length > 200) {
      const prefix = folderName.slice(0, 200);
      try {
        const entries = readdirSync(projectsDir, { withFileTypes: true });
        const match = entries.find(e => e.isDirectory() && e.name.startsWith(prefix + "-"));
        if (match) return join(projectsDir, match.name);
      } catch { /* ignore */ }
    }

    return null;
  }

  /**
   * Delete a Claude Code .jsonl session file from disk.
   */
  private deleteCCSessionFile(ccSessionId: string, directory: string): void {
    const projectDir = this.findCCProjectDir(directory);
    if (!projectDir) return;

    const sessionFile = join(projectDir, `${ccSessionId}.jsonl`);
    try {
      if (existsSync(sessionFile)) {
        unlinkSync(sessionFile);
        mainLog.info(`[Claude] Deleted CC session file: ${sessionFile}`);
      }
    } catch (err) {
      mainLog.warn(`[Claude] Failed to delete CC session file ${sessionFile}:`, err);
    }
  }

  /**
   * Read a Claude Code .jsonl session file and extract uuid→timestamp mapping.
   * The SDK's getSessionMessages() strips the timestamp field, so we read
   * the raw file to recover per-message timestamps for history display.
   */
  private readJsonlTimestamps(
    ccSessionId: string,
    directory: string,
  ): Map<string, number> {
    const timestamps = new Map<string, number>();
    const projectDir = this.findCCProjectDir(directory);
    if (!projectDir) return timestamps;

    const sessionFile = join(projectDir, `${ccSessionId}.jsonl`);
    if (!existsSync(sessionFile)) return timestamps;

    try {
      const content = readFileSync(sessionFile, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.uuid && entry.timestamp) {
            timestamps.set(entry.uuid, new Date(entry.timestamp).getTime());
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch (err) {
      mainLog.warn(`[Claude] Failed to read timestamps from ${sessionFile}:`, err);
    }

    return timestamps;
  }

  // ==========================================================================
  // Messages
  // ==========================================================================

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: { mode?: string; modelId?: string },
  ): Promise<UnifiedMessage> {
    const session = sessionStore.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // Extract text content from prompt
    const textContent = content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    if (!textContent.trim()) {
      throw new Error("Message content cannot be empty");
    }

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
    };
    this.emit("message.updated", { sessionId, message: assistantMessage });

    // Determine permission mode from mode option
    const mode = options?.mode ?? this.sessionModes.get(sessionId) ?? "agent";
    const permissionMode =
      mode === "plan" ? ("plan" as const) : ("default" as const);

    // Get or create V2 session
    const v2Session = await this.getOrCreateV2Session(
      sessionId,
      session.directory,
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
      this.sendResolvers.set(sessionId, { resolve, reject });

      this.processStream(
        v2Session,
        sessionId,
        textContent,
        buffer,
        abortController,
      ).catch((err) => {
        mainLog.error(`[Claude][${sessionId}] Stream processing error:`, err);
        const resolver = this.sendResolvers.get(sessionId);
        if (resolver) {
          this.sendResolvers.delete(sessionId);
          resolver.reject(err);
        }
      });
    });
  }

  async cancelMessage(sessionId: string): Promise<void> {
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
          mainLog.info(`[Claude][${sessionId}] V2 session interrupted`);

          // Drain stale messages so the next send()+stream() cycle starts clean.
          // After interrupt, the CLI will emit remaining buffered messages and
          // finally a `result` message. We must consume them to avoid polluting
          // the next conversation turn.
          try {
            for await (const msg of v2Info.session.stream()) {
              mainLog.debug(`[Claude][${sessionId}] Drain after interrupt: ${(msg as any).type}`);
              if ((msg as any).type === "result") break;
            }
          } catch {
            // Stream may already be closed / errored — safe to ignore
          }
        } else {
          mainLog.info(`[Claude][${sessionId}] Message cancelled (no interrupt available)`);
        }
      } catch (e) {
        mainLog.warn(`[Claude][${sessionId}] Error interrupting session:`, e);
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

    // Finalize any pending buffer
    const buffer = this.messageBuffers.get(sessionId);
    if (buffer) buffer.error = "Cancelled";
    this.finalizeBuffer(sessionId, true);
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    // Return from in-memory history first
    const history = this.messageHistory.get(sessionId);
    if (history && history.length > 0) {
      return history;
    }

    // Resolve the CC session ID from multiple sources
    const session = sessionStore.getSession(sessionId);
    let ccSessionId = session?.engineMeta?.ccSessionId as string | undefined;

    // Fallback: check in-memory v2Sessions for captured session ID
    if (!ccSessionId) {
      const v2Info = this.v2Sessions.get(sessionId);
      if (v2Info?.capturedSessionId) {
        ccSessionId = v2Info.capturedSessionId;
        // Persist it for future restarts
        if (session) {
          session.engineMeta = { ...session.engineMeta, ccSessionId };
          sessionStore.upsertSession(session);
          sessionStore.flushAll();
        }
      }
    }

    if (!ccSessionId) {
      return [];
    }

    // Try to load from SDK session files
    const directory = session?.directory;
    try {
      const sdkMessages = await sdkGetSessionMessages(
        ccSessionId,
        directory ? { dir: directory } : undefined,
      );

      // Read timestamps from the raw .jsonl file (SDK strips them)
      const timestamps = directory
        ? this.readJsonlTimestamps(ccSessionId, directory)
        : new Map<string, number>();

      const messages = this.convertSdkMessages(sdkMessages, sessionId, timestamps);
      this.messageHistory.set(sessionId, messages);
      return messages;
    } catch (err) {
      mainLog.warn(`[Claude][${sessionId}] Failed to load messages from SDK:`, err);
      return [];
    }
  }

  // ==========================================================================
  // Models
  // ==========================================================================

  // Known Claude Code models — this list matches what Claude Code CLI
  // exposes via its /model command. Models are validated server-side;
  // unavailable models will be rejected at send time.
  private static readonly KNOWN_MODELS: Array<{
    modelId: string;
    name: string;
    description: string;
  }> = [
    { modelId: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", description: "Fast and capable" },
    { modelId: "claude-opus-4-20250514", name: "Claude Opus 4", description: "Most powerful" },
    { modelId: "claude-haiku-3-5-20241022", name: "Claude 3.5 Haiku", description: "Fast and lightweight" },
  ];

  async listModels(): Promise<ModelListResult> {
    // Custom env model — only show that one model, no switching allowed
    if (this.isCustomEnvModel && this.currentModelId) {
      return {
        models: [{
          modelId: this.currentModelId,
          name: this.currentModelId,
          description: "Custom model (ANTHROPIC_MODEL)",
          engineType: "claude" as EngineType,
        }],
        currentModelId: this.currentModelId,
      };
    }

    if (this.cachedModels.length === 0) {
      // Populate from known models
      this.cachedModels = ClaudeCodeAdapter.KNOWN_MODELS.map((m) => ({
        ...m,
        engineType: "claude" as EngineType,
      }));
    }

    return {
      models: this.cachedModels,
      currentModelId: this.currentModelId ?? this.cachedModels[0]?.modelId,
    };
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.currentModelId = modelId;
    this.cachedModels = []; // Clear cache so custom model gets re-evaluated
    mainLog.info(`[Claude] Model set to: ${modelId}`);

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
    mainLog.info(`[Claude][${sessionId}] Mode set to: ${modeId}`);

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
  ): Promise<void> {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      mainLog.warn(
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
   * For AskUserQuestion tools, it routes to the question UI.
   * For other tools, it routes to the permission UI.
   */
  private createCanUseTool(sessionId: string): CanUseTool {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        suggestions?: PermissionUpdate[];
        blockedPath?: string;
        decisionReason?: string;
        toolUseID: string;
        agentID?: string;
      },
    ): Promise<PermissionResult> => {
      // --- Handle AskUserQuestion tool as a "question" ---
      if (toolName === "AskUserQuestion") {
        return this.handleAskUserQuestion(sessionId, input, options);
      }

      // --- Auto-approve all other tools ---
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

    mainLog.info(
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

  /**
   * Handle tool permission requests by routing them through the permission UI.
   */
  private handlePermissionRequest(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      blockedPath?: string;
      decisionReason?: string;
      toolUseID: string;
    },
  ): Promise<PermissionResult> {
    const permissionId = timeId("perm");

    // Determine permission kind from tool name
    const kind: "read" | "edit" | "other" =
      toolName === "Read" || toolName === "Glob" || toolName === "Grep"
        ? "read"
        : toolName === "Write" || toolName === "Edit"
          ? "edit"
          : "other";

    // Build a descriptive title
    let title = `${toolName}`;
    if (input.command) {
      title = `Run: ${String(input.command).slice(0, 200)}`;
    } else if (input.file_path) {
      title = `${toolName}: ${input.file_path}`;
    } else if (input.pattern) {
      title = `${toolName}: ${input.pattern}`;
    }
    if (options.blockedPath) {
      title += ` (blocked: ${options.blockedPath})`;
    }

    const permOptions: PermissionOption[] = [
      { id: "allow_once", label: "Allow Once", type: "allow_once" },
      { id: "allow_always", label: "Always Allow", type: "allow_always" },
      { id: "reject_once", label: "Deny", type: "reject_once" },
    ];

    const permission: UnifiedPermission = {
      id: permissionId,
      sessionId,
      engineType: this.engineType,
      toolCallId: options.toolUseID,
      title,
      kind,
      rawInput: input,
      options: permOptions,
      metadata: {
        toolName,
        decisionReason: options.decisionReason,
        blockedPath: options.blockedPath,
      },
    };

    mainLog.info(
      `[Claude][${sessionId}] Permission request: id=${permissionId}, tool=${toolName}`,
    );

    return new Promise<PermissionResult>((resolve) => {
      this.pendingPermissions.set(permissionId, {
        resolve,
        permission,
        suggestions: options.suggestions,
        input,
      });

      // Abort handling
      if (options.signal) {
        const onAbort = () => {
          if (this.pendingPermissions.has(permissionId)) {
            this.pendingPermissions.delete(permissionId);
            resolve({ behavior: "deny", message: "Aborted" });
          }
        };
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.emit("permission.asked", { permission });
    });
  }

  // ==========================================================================
  // Questions
  // ==========================================================================

  async replyQuestion(
    questionId: string,
    answers: string[][],
  ): Promise<void> {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      mainLog.warn(
        `[Claude] No pending question found for ID: ${questionId}`,
      );
      return;
    }

    this.pendingQuestions.delete(questionId);

    // Take the first answer's first value
    const answer = answers[0]?.[0] ?? "";
    pending.resolve(answer);

    this.emit("question.replied", { questionId, answers });
  }

  async rejectQuestion(questionId: string): Promise<void> {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return;

    this.pendingQuestions.delete(questionId);
    pending.resolve(""); // Empty answer = rejection
  }

  // ==========================================================================
  // Projects
  // ==========================================================================

  async listProjects(): Promise<UnifiedProject[]> {
    return sessionStore.getAllProjects().filter(
      (p) => p.engineType === this.engineType,
    );
  }

  // ==========================================================================
  // V2 Session Management
  // ==========================================================================

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

    mainLog.info(
      `[Claude][${sessionId}] Creating new V2 session in ${directory}`,
    );
    const startTime = Date.now();

    // Check if this session has a previous CC session ID for resumption
    const storedSession = sessionStore.getSession(sessionId);
    const ccSessionId = storedSession?.engineMeta?.ccSessionId as
      | string
      | undefined;

    // Build environment variables
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.options?.env,
    };

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
    };

    // Set working directory
    if (directory) {
      // Normalize path for the current platform
      sdkOptions.cwd = directory.replaceAll("/", process.platform === "win32" ? "\\" : "/");
    }

    let v2Session: SDKSession;

    if (ccSessionId) {
      // Resume existing session
      mainLog.info(
        `[Claude][${sessionId}] Resuming CC session: ${ccSessionId}`,
      );
      v2Session = unstable_v2_resumeSession(ccSessionId, sdkOptions);
    } else {
      // Create new session
      v2Session = unstable_v2_createSession(sdkOptions);
    }

    mainLog.info(
      `[Claude][${sessionId}] V2 session created in ${Date.now() - startTime}ms`,
    );

    const info: V2SessionInfo = {
      session: v2Session,
      directory,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      capturedSessionId: ccSessionId,
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

    mainLog.info(`[Claude][${sessionId}] Cleaning up session: ${reason}`);

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

      // Process stream events
      for await (const sdkMessage of v2Session.stream()) {
        if (abortController.signal.aborted) break;

        this.handleSdkMessage(
          sdkMessage,
          sessionId,
          buffer,
          streamingBlocks,
        );
      }
    } catch (err: any) {
      if (abortController.signal.aborted) {
        mainLog.info(`[Claude][${sessionId}] Stream aborted`);
      } else {
        mainLog.error(`[Claude][${sessionId}] Stream error:`, err);
        buffer.error = err?.message ?? String(err);
      }
    } finally {
      this.activeAbortControllers.delete(sessionId);
      this.finalizeBuffer(sessionId, abortController.signal.aborted);
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
        mainLog.info(
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
        // Store the CC session ID for future resumption
        const v2Info = this.v2Sessions.get(sessionId);
        if (v2Info) {
          v2Info.capturedSessionId = ccSessionId;
        }

        // Update session store with CC session ID
        const session = sessionStore.getSession(sessionId);
        if (session) {
          session.engineMeta = {
            ...session.engineMeta,
            ccSessionId,
          };
          sessionStore.upsertSession(session);
          // Flush immediately — ccSessionId is critical for message history
          // recovery after restart, must not be lost in debounce window
          sessionStore.flushAll();
        }
      }

      // Extract version info
      if (msg.claude_code_version) {
        this.version = msg.claude_code_version;
      }

      // Extract model info
      if (msg.model) {
        buffer.modelId = msg.model;
      }

      // Extract available models from init response
      if (msg.models && Array.isArray(msg.models) && msg.models.length > 0) {
        this.cachedModels = msg.models.map((m: any) => ({
          modelId: m.value ?? m.id ?? m.modelId,
          name: m.displayName ?? m.name ?? m.value,
          description: m.description ?? "",
          engineType: "claude" as EngineType,
        }));
        mainLog.info(
          `[Claude][${sessionId}] Loaded ${this.cachedModels.length} models from init`,
        );
      }

      mainLog.info(
        `[Claude][${sessionId}] System init: session=${ccSessionId}, model=${msg.model}`,
      );
    } else if (msg.subtype === "status") {
      // Handle status changes (e.g., compacting)
      if (msg.status === "compacting") {
        mainLog.info(
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

    mainLog.info(
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
          const normalizedTool = normalizeClaudeToolName(
            contentBlock.name ?? "unknown",
          );
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
    const normalizedTool = normalizeClaudeToolName(toolName);
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
      mainLog.warn(
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
    };

    // Add to history
    const history = this.messageHistory.get(sessionId) ?? [];
    history.push(finalMessage);
    this.messageHistory.set(sessionId, history);

    // Emit final message
    this.emit("message.updated", { sessionId: buffer.sessionId, message: finalMessage });

    // Update session title from first user message if no title yet
    const session = sessionStore.getSession(sessionId);
    if (session && (!session.title || session.title === "New Chat")) {
      const firstUserMsg = history.find((m) => m.role === "user");
      if (firstUserMsg) {
        const textPart = firstUserMsg.parts.find((p) => p.type === "text") as
          | TextPart
          | undefined;
        if (textPart) {
          session.title = textPart.text.slice(0, 100);
          session.time.updated = Date.now();
          sessionStore.upsertSession(session);
          this.emit("session.updated", { session });
        }
      }
    }

    // Clean up
    this.messageBuffers.delete(sessionId);
    this.toolCallParts.clear();
    this.toolIdToThoughtId.clear();

    // Resolve sendMessage promise
    const resolver = this.sendResolvers.get(sessionId);
    if (resolver) {
      this.sendResolvers.delete(sessionId);
      resolver.resolve(finalMessage);
    }
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
  // Type Conversion Helpers
  // ==========================================================================

  private sdkSessionToUnified(
    sdkSession: SDKSessionInfo,
    directory?: string,
  ): UnifiedSession {
    return {
      id: `cc_${sdkSession.sessionId.replace(/-/g, "").slice(0, 20)}`,
      engineType: this.engineType,
      directory:
        (sdkSession.cwd ?? directory ?? "").replaceAll("\\", "/"),
      title:
        sdkSession.customTitle ??
        sdkSession.summary ??
        sdkSession.firstPrompt?.slice(0, 100) ??
        "Untitled",
      time: {
        created: sdkSession.lastModified,
        updated: sdkSession.lastModified,
      },
      engineMeta: {
        ccSessionId: sdkSession.sessionId,
        gitBranch: sdkSession.gitBranch,
      },
    };
  }

  private convertSdkMessages(
    sdkMessages: any[],
    sessionId: string,
    timestamps?: Map<string, number>,
  ): UnifiedMessage[] {
    const messages: UnifiedMessage[] = [];

    // Build a lookup from tool_use_id → next user message timestamp.
    // In the .jsonl, a tool_use block in an assistant message is followed by
    // a user message containing the tool_result. The time between the assistant
    // message and the tool_result user message is the tool execution duration.
    const toolResultTimestamps = new Map<string, number>();
    if (timestamps && timestamps.size > 0) {
      for (const msg of sdkMessages) {
        if (msg.type !== "user") continue;
        const content = msg.message?.content;
        if (!Array.isArray(content)) continue;
        const msgTs = timestamps.get(msg.uuid);
        if (!msgTs) continue;
        for (const block of content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            toolResultTimestamps.set(block.tool_use_id, msgTs);
          }
        }
      }
    }

    for (const msg of sdkMessages) {
      const msgTs = timestamps?.get(msg.uuid) ?? 0;

      if (msg.type === "user") {
        const msgId = msg.uuid ?? timeId("msg");
        const parts: UnifiedPart[] = [];
        const content = msg.message?.content;

        if (typeof content === "string") {
          parts.push({ type: "text", text: content, id: timeId("pt"), messageId: msgId, sessionId } as TextPart);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              parts.push({ type: "text", text: block.text, id: timeId("pt"), messageId: msgId, sessionId } as TextPart);
            }
          }
        }

        if (parts.length > 0) {
          messages.push({
            id: msgId,
            sessionId,
            role: "user",
            time: { created: msgTs || Date.now() },
            parts,
          });
        }
      } else if (msg.type === "assistant") {
        const msgId = msg.uuid ?? timeId("msg");
        const parts: UnifiedPart[] = [];
        const content = msg.message?.content;

        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              parts.push({ type: "text", text: block.text, id: timeId("pt"), messageId: msgId, sessionId } as TextPart);
            } else if (block.type === "thinking") {
              parts.push({
                type: "reasoning",
                text: block.thinking,
                id: timeId("pt"),
                messageId: msgId,
                sessionId,
              } as ReasoningPart);
            } else if (block.type === "tool_use") {
              const normalizedTool = normalizeClaudeToolName(block.name ?? "");

              // Calculate tool duration from timestamps
              const toolStart = msgTs;
              const toolEnd = toolResultTimestamps.get(block.id) ?? 0;
              const toolDuration = (toolStart && toolEnd && toolEnd > toolStart)
                ? toolEnd - toolStart
                : 0;

              parts.push({
                type: "step-start",
                id: timeId("pt"),
                messageId: msgId,
                sessionId,
              } as StepStartPart);
              parts.push({
                type: "tool",
                id: timeId("pt"),
                messageId: msgId,
                sessionId,
                callId: block.id,
                normalizedTool,
                originalTool: block.name,
                title: block.name,
                kind: inferToolKind(undefined, normalizedTool),
                state: {
                  status: "completed",
                  input: block.input ?? {},
                  output: "",
                  time: { start: toolStart, end: toolEnd || toolStart, duration: toolDuration },
                },
              } as ToolPart);
              parts.push({
                type: "step-finish",
                id: timeId("pt"),
                messageId: msgId,
                sessionId,
              } as StepFinishPart);
            }
          }
        }

        // Find the next message's timestamp to use as completion time
        const msgIndex = sdkMessages.indexOf(msg);
        const nextMsg = sdkMessages[msgIndex + 1];
        const completedTs = nextMsg ? (timestamps?.get(nextMsg.uuid) ?? 0) : 0;

        if (parts.length > 0) {
          messages.push({
            id: msgId,
            sessionId,
            role: "assistant",
            time: {
              created: msgTs || Date.now(),
              completed: completedTs || msgTs || undefined,
            },
            parts,
          });
        }
      }
    }

    return messages;
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
    for (const [id, pending] of this.pendingPermissions) {
      pending.resolve({ behavior: "deny", message: reason });
    }
    this.pendingPermissions.clear();
  }

  private rejectAllPendingQuestions(reason: string): void {
    for (const [id, pending] of this.pendingQuestions) {
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
