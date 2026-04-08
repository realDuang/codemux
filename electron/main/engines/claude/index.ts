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
  ModelInfo as ClaudeModelInfo,
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
  SystemNoticePart,
  QuestionInfo,
  EngineCommand,
  CommandInvokeResult,
  ReasoningEffort,
} from "../../../../src/types/unified";
import { REASONING_EFFORT_VALUES, normalizeReasoningEfforts } from "../../../../src/types/unified";

import { sdkSessionToUnified, convertSdkMessages } from "./converters";
import { deleteCCSessionFile, readJsonlTimestamps } from "./cc-session-files";
import { createRequire } from "node:module";
import { sep, dirname, join } from "node:path";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { createTwoFilesPatch } from "diff";

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

/** Tracks stream end conditions for comprehensive result classification. */
interface StreamEndState {
  /** Whether a result message was received (false = stream interrupted/crashed) */
  receivedResult: boolean;
  /** result.subtype === "error_during_execution" — tool error, not an API error */
  hadErrorDuringExecution: boolean;
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
  { id: "default", label: "Default", description: "Standard behavior, prompts for dangerous operations" },
  { id: "acceptEdits", label: "Auto-Accept", description: "Auto-accept file edit operations" },
  { id: "plan", label: "Plan", description: "Planning mode, no actual tool execution" },
];

function getDefaultClaudeReasoningEffort(
  supportedReasoningEfforts: ReasoningEffort[] | undefined,
): ReasoningEffort | undefined {
  if (!supportedReasoningEfforts || supportedReasoningEfforts.length === 0) return undefined;
  return supportedReasoningEfforts.includes("medium")
    ? "medium"
    : supportedReasoningEfforts[0];
}

export function getClaudeReasoningCapabilities(
  model: Pick<ClaudeModelInfo, "supportsEffort" | "supportedEffortLevels">,
): NonNullable<UnifiedModelInfo["capabilities"]> {
  const reasoning = model.supportsEffort === true;
  const supportedReasoningEfforts = reasoning
    ? normalizeReasoningEfforts(model.supportedEffortLevels) ?? [...REASONING_EFFORT_VALUES]
    : undefined;

  return {
    reasoning,
    supportedReasoningEfforts,
    defaultReasoningEffort: getDefaultClaudeReasoningEffort(supportedReasoningEfforts),
  };
}

// ============================================================================
// Session idle timeout (30 min)
// ============================================================================

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// ============================================================================
// ClaudeCodeAdapter
// ============================================================================

export class ClaudeCodeAdapter extends EngineAdapter {
  readonly engineType: EngineType = "claude";

  /** Reusable stderr callback for SDK-spawned CLI subprocesses. */
  private stderrCallback = (data: string) => {
    claudeLog.warn("[Claude][CLI stderr]", data.trimEnd());
  };

  // --- V2 Sessions (persistent, process reuse) ---
  private v2Sessions = new Map<string, V2SessionInfo>();

  // --- Slash commands ---
  private availableCommands: EngineCommand[] = [];
  /** Cached user-installed skill names, for system prompt injection */
  private cachedSkillNames: string[] = [];
  /** In-flight warmup promise — prevents concurrent warmups and lets listCommands await it */
  private warmupPromise: Promise<void> | null = null;

  // --- State ---
  private status: EngineStatus = "stopped";
  private lastError: string | undefined;
  private version: string | undefined;
  private authenticated: boolean | undefined;
  private authMessage: string | undefined;
  private currentModelId: string | null = null;
  private cachedModels: UnifiedModelInfo[] = [];
  private sessionModes = new Map<string, string>();
  private sessionReasoningEfforts = new Map<string, ReasoningEffort>();

  // --- Session directory cache (used instead of external store lookups) ---
  private sessionDirectories = new Map<string, string>();
  /** Persisted ccSessionId per session, for SDK session resumption across restarts */
  private sessionCcIds = new Map<string, string>();
  /** Sessions that were just resumed after a dead process — emit notice on next message */
  private pendingResumeNotice = new Set<string>();

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

  /** Maps SDK task_id → tool_use_id for correlating task_progress/notification to ToolPart */
  private taskToToolUseId = new Map<string, string>();

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

      // Check authentication via SDK accountInfo()
      await this.checkAuthentication();

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

  /**
   * Check if Claude Code has valid authentication by querying accountInfo().
   * tokenSource === "none" means no auth is configured.
   */
  private async checkAuthentication(): Promise<void> {
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        ...this.options?.env,
      };
      const sdkEnv = { ...env };
      delete sdkEnv.ELECTRON_RUN_AS_NODE;

      const q = sdkQuery({
        prompt: "",
        options: {
          model: this.currentModelId ?? "claude-sonnet-4-20250514",
          env: sdkEnv,
          abortController: new AbortController(),
          pathToClaudeCodeExecutable: this.resolveCliPath(),
          stderr: this.stderrCallback,
        } as any,
      });

      try {
        const info = await q.accountInfo();
        if (!info || info.tokenSource === "none") {
          this.authenticated = false;
          this.authMessage = "Not authenticated";
          claudeLog.warn("[Claude] No authentication configured (tokenSource: none)");
        } else {
          this.authenticated = true;
          this.authMessage = info.tokenSource;
          claudeLog.info(`[Claude] Authenticated via ${info.tokenSource}`);
        }
      } finally {
        q.close();
      }
    } catch (err) {
      claudeLog.warn("[Claude] Failed to check authentication:", err);
      this.authenticated = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.status === "stopped") return;

    claudeLog.info("Stopping Claude Code adapter...");

    // Gracefully interrupt all sessions that have active requests first.
    // interrupt() tells the CC CLI subprocess to stop the current turn cleanly,
    // preserving server-side session state. Without this, session.close() kills
    // the process mid-stream, corrupting the CC session and causing context loss
    // on next resume.
    //
    // NOTE: We do NOT drain the stream here (unlike cancelMessage). Drain exists
    // so the *next* send()+stream() cycle starts clean, but stop() is terminal —
    // there is no next cycle. More importantly, draining during Electron's
    // will-quit flow triggers NAPI crashes because the native CC SDK module is
    // being torn down while we're still iterating its async iterator.
    const interruptPromises: Promise<void>[] = [];
    for (const [sessionId, info] of this.v2Sessions) {
      // Only need to interrupt sessions with active requests
      if (!this.activeAbortControllers.has(sessionId)) continue;

      const buffer = this.messageBuffers.get(sessionId);
      if (buffer) buffer.error = "Cancelled";

      const controller = this.activeAbortControllers.get(sessionId);
      if (controller) {
        controller.abort();
        this.activeAbortControllers.delete(sessionId);
      }

      interruptPromises.push(
        (async () => {
          try {
            const query = (info.session as any).query;
            if (query && typeof query.interrupt === "function") {
              await query.interrupt();
              claudeLog.info(`[Claude][${sessionId}] V2 session interrupted during stop`);
            }
          } catch (e) {
            claudeLog.warn(`[Claude][${sessionId}] Error interrupting session during stop:`, e);
          }
          // Finalize the buffer so the message is properly completed
          this.finalizeBuffer(sessionId, true);
        })()
      );
    }

    // Wait for all interrupts to settle (with a hard cap so stop() never hangs)
    if (interruptPromises.length > 0) {
      const hardTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));
      await Promise.race([Promise.allSettled(interruptPromises), hardTimeout]);
    }

    // Now close all V2 sessions.
    //
    // session.close() internally schedules abort after 5s via setTimeout().unref(),
    // and transport.close() then schedules SIGTERM after another 2s (also .unref()).
    // Since .unref() timers don't prevent the event loop from exiting, app.exit(0)
    // tears down the NAPI modules while the CLI subprocess is still alive and
    // sending callbacks through its NAPI threadsafe function — causing the fatal
    // "napi_ref_threadsafe_function" crash during node::FreeEnvironment.
    //
    // Fix: directly kill the subprocess BEFORE calling session.close(), then wait
    // for it to actually exit. This guarantees no NAPI callbacks are in flight
    // when app.exit(0) destroys the native module.
    const exitPromises: Promise<void>[] = [];
    for (const [sessionId, info] of this.v2Sessions) {
      try {
        const transport = (info.session as any)?.query?.transport;
        const proc = transport?.process as import("child_process").ChildProcess | undefined;
        if (proc && proc.exitCode === null && !proc.killed) {
          const exitPromise = new Promise<void>((resolve) => {
            proc.once("exit", () => resolve());
            // Safety: resolve anyway after 3s if the process doesn't exit
            setTimeout(resolve, 3000).unref();
          });
          proc.kill("SIGTERM");
          exitPromises.push(exitPromise);
          claudeLog.info(`[Claude][${sessionId}] Sent SIGTERM to CLI subprocess (pid=${proc.pid})`);
        }
        info.session.close();
      } catch (e) {
        claudeLog.warn(`Error closing Claude session ${sessionId}:`, e);
      }
    }

    // Wait for all CLI subprocesses to actually exit before returning.
    // This ensures no NAPI threadsafe function callbacks are pending when
    // app.exit(0) destroys the native module environment.
    if (exitPromises.length > 0) {
      await Promise.all(exitPromises);
      claudeLog.info("All CLI subprocesses exited");
    }

    this.v2Sessions.clear();

    // Abort any remaining active requests (sessions without V2 info)
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
      authenticated: this.authenticated,
      authMessage: this.authMessage,
      errorMessage: this.status === "error" ? this.lastError : undefined,
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
      imageAttachment: true,
      loadSession: true,
      listSessions: true,
      modelSwitchable: true,
      customModelInput: true,
      messageEnqueue: true,
      slashCommands: true,
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

    // Warm up in background — store the promise so listCommands() can await it.
    this.triggerWarmup(directory);

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
    options?: { mode?: string; modelId?: string; reasoningEffort?: ReasoningEffort | null },
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

    // Check if there are image attachments
    const imageContents = content.filter((c) => c.type === "image" && c.data);
    const hasImages = imageContents.length > 0;

    if (!textContent.trim() && !hasImages) {
      throw new Error("Message content cannot be empty");
    }

    // Build the message to send — string for text-only, SDKUserMessage for multimodal
    let messageToSend: string | object = textContent;
    if (hasImages) {
      const contentBlocks: Array<{ type: string; [key: string]: any }> = [];
      if (textContent.trim()) {
        contentBlocks.push({ type: "text", text: textContent });
      }
      for (const img of imageContents) {
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mimeType ?? "image/png",
            data: img.data!,
          },
        });
      }
      messageToSend = {
        type: "user",
        message: { role: "user", content: contentBlocks },
        parent_tool_use_id: null,
        session_id: "",
      };
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
      reasoningEffort: this.sessionReasoningEfforts.get(sessionId),
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
    const mode = options?.mode ?? this.sessionModes.get(sessionId) ?? "default";
    const permissionMode = mode as "default" | "plan" | "acceptEdits" | "dontAsk";

    // Apply reasoning effort if it changed (triggers session rebuild via getOrCreateV2Session)
    if (options?.reasoningEffort !== undefined) {
      const current = this.sessionReasoningEfforts.get(sessionId) ?? null;
      if (options.reasoningEffort !== current) {
        if (options.reasoningEffort) {
          this.sessionReasoningEfforts.set(sessionId, options.reasoningEffort);
        } else {
          this.sessionReasoningEfforts.delete(sessionId);
        }
        // Invalidate existing session so getOrCreateV2Session rebuilds with new effort
        const v2Info = this.v2Sessions.get(sessionId);
        if (v2Info) {
          if (v2Info.capturedSessionId) {
            this.sessionCcIds.set(sessionId, v2Info.capturedSessionId);
          }
          try { v2Info.session.close(); } catch { /* ignore */ }
          this.v2Sessions.delete(sessionId);
        }
      }
    }

    // Get or create V2 session
    const v2Session = await this.getOrCreateV2Session(
      sessionId,
      directory,
      {
        model: options?.modelId ?? this.currentModelId ?? undefined,
        permissionMode,
      },
    );

    // If session was resumed after a dead process, emit a notice
    if (this.pendingResumeNotice.delete(sessionId)) {
      const noticePart: SystemNoticePart = {
        type: "system-notice",
        id: timeId("part"),
        messageId: buffer.messageId,
        sessionId,
        noticeType: "info",
        text: "notice:session_resumed",
      };
      buffer.parts.push(noticePart);
      this.emitPartUpdated(sessionId, buffer, noticePart);
    }

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
        messageToSend,
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
      throw err;
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

    try {
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
      const cause = err instanceof TypeError ? (err as { cause?: NodeJS.ErrnoException }).cause : undefined;
      const code = cause?.code;

      if (code === "ENOTFOUND") {
        claudeLog.warn(`[Claude] Cannot resolve host for ${modelsUrl} — DNS lookup failed`);
      } else if (code === "ECONNREFUSED") {
        claudeLog.warn(`[Claude] Connection refused: ${modelsUrl}`);
      } else if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
        claudeLog.warn(`[Claude] Connection timed out: ${modelsUrl}`);
      } else if (code === "ECONNRESET") {
        claudeLog.warn(`[Claude] Connection reset: ${modelsUrl}`);
      } else if (err instanceof DOMException && err.name === "TimeoutError") {
        claudeLog.warn("[Claude] Models request timed out (AbortSignal)");
      } else {
        claudeLog.warn("[Claude] Failed to fetch models via HTTP:", err);
      }
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
          stderr: this.stderrCallback,
        } as any,
      });

      try {
        const models = await q.supportedModels();

        if (models && models.length > 0) {
          this.cachedModels = models.map((m: ClaudeModelInfo) => ({
            modelId: m.value,
            name: m.displayName || m.value,
            description: m.description || "",
            engineType: "claude" as EngineType,
            capabilities: getClaudeReasoningCapabilities(m),
          }));
          claudeLog.info(`[Claude] Loaded ${this.cachedModels.length} models via SDK`);
        } else {
          claudeLog.warn("[Claude] SDK returned empty model list");
        }
      } finally {
        q.close();
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
      // Preserve ccSessionId so the recreated session resumes context
      if (v2Info.capturedSessionId) {
        this.sessionCcIds.set(sessionId, v2Info.capturedSessionId);
      }
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

    const v2Info = this.v2Sessions.get(sessionId);
    if (v2Info) {
      // Update tracked permissionMode
      v2Info.permissionMode = modeId as any;

      // Use the internal Query API to switch permission mode at runtime
      // (same pattern as cancelMessage's interrupt() call)
      try {
        const query = (v2Info.session as any).query;
        if (query && typeof query.setPermissionMode === "function") {
          await query.setPermissionMode(modeId);
          claudeLog.info(`[Claude][${sessionId}] Permission mode switched to: ${modeId}`);
        } else {
          claudeLog.warn(`[Claude][${sessionId}] setPermissionMode not available on query, will apply on next message`);
        }
      } catch (err) {
        claudeLog.warn(`[Claude][${sessionId}] Failed to set permission mode:`, err);
      }
    }
  }

  // ==========================================================================
  // Reasoning Effort
  // ==========================================================================

  override async setReasoningEffort(sessionId: string, effort: ReasoningEffort | null): Promise<void> {
    const current = this.sessionReasoningEfforts.get(sessionId) ?? null;
    if (current === effort) return; // No change, skip session rebuild

    if (effort) {
      this.sessionReasoningEfforts.set(sessionId, effort);
      claudeLog.info(`[Claude][${sessionId}] Reasoning effort set to: ${effort}`);
    } else {
      this.sessionReasoningEfforts.delete(sessionId);
      claudeLog.info(`[Claude][${sessionId}] Reasoning effort cleared`);
    }

    // Close existing session so it will be recreated with the new effort setting
    const v2Info = this.v2Sessions.get(sessionId);
    if (v2Info) {
      if (v2Info.capturedSessionId) {
        this.sessionCcIds.set(sessionId, v2Info.capturedSessionId);
      }
      try {
        v2Info.session.close();
      } catch {
        // Ignore
      }
      this.v2Sessions.delete(sessionId);
    }
  }

  override getReasoningEffort(sessionId: string): ReasoningEffort | null {
    return this.sessionReasoningEfforts.get(sessionId) ?? null;
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
      // --- ExitPlanMode: intercept and ask user for confirmation ---
      if (toolName === "ExitPlanMode") {
        return this.handleExitPlanMode(sessionId, input, options);
      }

      // --- All other tools: auto-approve ---
      return { behavior: "allow", updatedInput: input };
    };
  }

  /**
   * Intercept ExitPlanMode: read the plan file content and append it to the
   * message stream so the user can see the full plan, then show a confirmation
   * dialog asking the user to approve or reject.
   *
   * Flow: canUseTool blocks → read plan file → emit plan text → emit question
   *       → user replies → resolve promise → SDK gets allow/deny
   */
  private handleExitPlanMode(
    sessionId: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
  ): Promise<PermissionResult> {
    const questionId = timeId("q");

    const allowedPrompts = input.allowedPrompts as
      | Array<{ tool: string; prompt: string }>
      | undefined;

    // Read the plan file and append its content to the message stream
    // so the user can review it before the confirmation dialog appears.
    const buffer = this.messageBuffers.get(sessionId);
    if (buffer) {
      const planContent = this.readLatestPlanFile(sessionId);
      if (planContent) {
        this.appendText(sessionId, buffer, "\n\n" + planContent);
      }
    }

    const question: UnifiedQuestion = {
      id: questionId,
      sessionId,
      engineType: this.engineType,
      toolCallId: options.toolUseID,
      questions: [
        {
          question: "The plan is ready for your review. Do you approve it?",
          header: "Plan Review",
          options: [
            { label: "Approve", description: "Approve the plan and start implementation" },
            { label: "Reject", description: "Reject the plan and continue planning" },
          ],
          multiple: false,
          custom: true, // allow user to type custom feedback
        },
      ],
      metadata: allowedPrompts ? { allowedPrompts } : undefined,
    };

    claudeLog.info(
      `[Claude][${sessionId}] ExitPlanMode intercepted: questionId=${questionId}`,
    );

    return new Promise<PermissionResult>((resolve) => {
      this.pendingQuestions.set(questionId, {
        resolve: (answer: string) => {
          const trimmed = answer.trim();
          const lower = trimmed.toLowerCase();
          const approved =
            lower.includes("approve") ||
            trimmed.includes("同意") ||
            trimmed.includes("批准") ||
            trimmed.includes("确认") ||
            trimmed === "1" || // 1-based: first option = Approve (Feishu/DingTalk display)
            trimmed === "0"; // 0-based: backward compat with frontend UI
          if (approved) {
            resolve({ behavior: "allow", updatedInput: input });
          } else {
            resolve({
              behavior: "deny",
              message: answer || "Plan rejected by user",
            });
          }
        },
        question,
      });

      // Abort handling (same pattern as handleAskUserQuestion)
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
   * Read the most recently modified plan file from ~/.claude/plans/.
   * Returns the file content, or null if no plan file is found.
   */
  private readLatestPlanFile(_sessionId: string): string | null {
    try {
      const plansDir = join(homedir(), ".claude", "plans");
      const files = readdirSync(plansDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => {
          const fullPath = join(plansDir, f);
          return { path: fullPath, mtime: statSync(fullPath).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length === 0) return null;

      // The most recently modified plan file was just written by Claude
      const content = readFileSync(files[0].path, "utf-8");
      return content.trim() || null;
    } catch {
      return null;
    }
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
  // Slash Commands
  // ==========================================================================

  override async listCommands(sessionId?: string, directory?: string): Promise<EngineCommand[]> {
    // Fast path: commands already populated
    if (this.availableCommands.length > 0) return this.availableCommands;

    // Commands not yet available — trigger warmup if not already running,
    // then await it so the first listCommands() call returns real data
    // instead of a hardcoded fallback.
    const dir = directory || (sessionId && this.sessionDirectories.get(sessionId)) || ".";
    this.triggerWarmup(dir);

    if (this.warmupPromise) {
      try {
        await this.warmupPromise;
      } catch {
        // warmup failed — fall through to fallback
      }
    }

    if (this.availableCommands.length > 0) return this.availableCommands;

    // Fallback: minimal list if warmup failed entirely
    return [
      { name: "compact", description: "Compact conversation context" },
      { name: "context", description: "Show current context window usage" },
      { name: "cost", description: "Show token usage and cost" },
    ];
  }

  /**
   * Trigger a warmup if one isn't already in progress and commands haven't
   * been populated yet. Safe to call multiple times — deduplicates via
   * warmupPromise.
   */
  private triggerWarmup(directory: string): void {
    if (this.availableCommands.length > 0) return;
    if (this.warmupPromise) return;

    this.warmupPromise = this.warmupV2Session("warmup", directory)
      .catch((err) => claudeLog.warn("[Claude] Warmup failed:", err))
      .finally(() => { this.warmupPromise = null; });
  }

  override async invokeCommand(
    sessionId: string,
    commandName: string,
    args: string,
    options?: { mode?: string; modelId?: string; directory?: string },
  ): Promise<CommandInvokeResult> {
    // Claude Code processes slash commands as inline text
    const commandText = `/${commandName}${args ? ` ${args}` : ""}`;
    const message = await this.sendMessage(
      sessionId,
      [{ type: "text", text: commandText }],
      options,
    );
    return { handledAsCommand: true, message };
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
      // Resolve the SDK's main entry point (listed in package.json "exports"),
      // then derive cli.js from the same directory. We can't require.resolve
      // cli.js directly because the SDK's "exports" field doesn't list it.
      const sdkMain = _require.resolve("@anthropic-ai/claude-agent-sdk");
      const cliPath = join(dirname(sdkMain), "cli.js");
      claudeLog.debug(`[Claude] resolveCliPath: raw=${cliPath}`);
      const asarMarker = `app.asar${sep}`;
      if (cliPath.includes(asarMarker)) {
        const unpacked = cliPath.replace(asarMarker, `app.asar.unpacked${sep}`);
        claudeLog.info(`[Claude] resolveCliPath: ASAR rewrite → ${unpacked}`);
        return unpacked;
      }
      return cliPath;
    } catch (err) {
      claudeLog.warn("[Claude] resolveCliPath: resolve failed:", err);
      return undefined;
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
      // Check if the CLI subprocess is still alive before reusing
      if (!this.isSessionTransportReady(existing.session)) {
        claudeLog.warn(
          `[Claude][${sessionId}] CLI subprocess is dead, cleaning up and recreating session`,
        );
        this.cleanupSession(sessionId, "transport not ready");
        this.pendingResumeNotice.add(sessionId);
        // Fall through to create a new session (ccSessionId is preserved by cleanupSession)
      } else {
        // Check if permissionMode changed — switch at runtime without destroying session
        const requestedMode = opts.permissionMode ?? "default";
        if (existing.permissionMode !== requestedMode) {
          claudeLog.info(
            `[Claude][${sessionId}] permissionMode changed from ${existing.permissionMode} to ${requestedMode}, switching at runtime`,
          );
          existing.permissionMode = requestedMode;
          try {
            const query = (existing.session as any).query;
            if (query && typeof query.setPermissionMode === "function") {
              await query.setPermissionMode(requestedMode);
              claudeLog.info(`[Claude][${sessionId}] Permission mode switched to: ${requestedMode}`);
            } else {
              claudeLog.warn(`[Claude][${sessionId}] setPermissionMode not available on query, will apply on next message`);
            }
          } catch (err) {
            claudeLog.warn(`[Claude][${sessionId}] Failed to set permission mode at runtime:`, err);
          }
        }

        // Session is ready — update usage timestamp and return
        existing.lastUsedAt = Date.now();
        return existing.session;
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

    // Build system prompt append: identity + cached user skills
    let promptAppend = CODEMUX_IDENTITY_PROMPT;
    if (this.cachedSkillNames.length > 0) {
      promptAppend += `\n\nThe user has installed the following additional skills (invokable via the Skill tool): ${this.cachedSkillNames.join(", ")}. When the user's request matches one of these skills, use the Skill tool to invoke it.`;
    }

    const sdkOptions: any = {
      model: opts.model ?? this.currentModelId ?? "claude-sonnet-4-20250514",
      env,
      permissionMode: opts.permissionMode ?? "default",
      allowedTools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "WebFetch", "WebSearch", "Task", "TodoWrite", "TodoRead", "NotebookEdit", "Skill"],
      canUseTool: this.createCanUseTool(sessionId),
      systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: promptAppend },
      pathToClaudeCodeExecutable: this.resolveCliPath(),
      stderr: this.stderrCallback,
      maxThinkingTokens: 10240,
    };

    // Apply reasoning effort level if set for this session
    const reasoningEffort = this.sessionReasoningEfforts.get(sessionId);
    if (reasoningEffort) {
      sdkOptions.effort = reasoningEffort;
    }

    // Set working directory.
    // Note: sdkOptions.cwd is currently ignored by the SDK's V2 session API
    // (rQ constructor doesn't forward it to ProcessTransport), so we also
    // temporarily chdir to the target directory before creating the session.
    // The rQ → y4 → spawn() chain is fully synchronous, so this is safe in
    // single-threaded Node.js.
    const nativeCwd = directory
      ? directory.replaceAll("/", process.platform === "win32" ? "\\" : "/")
      : undefined;
    if (nativeCwd) {
      sdkOptions.cwd = nativeCwd;
    }

    let v2Session: SDKSession;

    const origCwd = nativeCwd ? process.cwd() : undefined;
    if (nativeCwd) {
      try {
        process.chdir(nativeCwd);
      } catch (e) {
        claudeLog.warn(
          `[Claude][${sessionId}] Failed to chdir to ${nativeCwd}: ${e}`,
        );
      }
    }

    try {
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
    } finally {
      if (origCwd) {
        try {
          process.chdir(origCwd);
        } catch {
          // ignore — original cwd may have been removed
        }
      }
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
    this.registerProcessExitListener(v2Session, sessionId);
    return v2Session;
  }

  /**
   * Check if the CLI subprocess behind a V2 session is still alive.
   * Returns false if the process has exited (OOM, crash, signal).
   */
  private isSessionTransportReady(session: SDKSession): boolean {
    try {
      const query = (session as any).query;
      const transport = query?.transport;
      if (!transport) return false;

      if (typeof transport.isReady === "function") {
        return transport.isReady();
      }
      if (typeof transport.ready === "boolean") {
        return transport.ready;
      }
      // Can't determine — assume ready to avoid unnecessary recreation
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Register a listener for CLI subprocess exit events.
   * When the CC subprocess dies (OOM, crash, signal), we immediately clean up
   * the session entry from v2Sessions. The ccSessionId is preserved in
   * sessionCcIds so the next getOrCreateV2Session() call can resume it
   * with a fresh process.
   */
  private registerProcessExitListener(session: SDKSession, sessionId: string): void {
    try {
      const transport = (session as any).query?.transport;
      if (!transport) return;

      if (typeof transport.onExit === "function") {
        transport.onExit((error: Error | undefined) => {
          claudeLog.warn(
            `[Claude][${sessionId}] CLI subprocess exited${error ? `: ${error.message}` : ""}`,
          );
          // Only clean up if the session is still the one we registered for
          const current = this.v2Sessions.get(sessionId);
          if (current && current.session === session) {
            this.cleanupSession(sessionId, `process exited${error ? ` (${error.message})` : ""}`);
          }
        });
      }
    } catch (e) {
      claudeLog.warn(`[Claude][${sessionId}] Failed to register process exit listener:`, e);
    }
  }

  /**
   * Clean up a V2 session.
   */
  private cleanupSession(sessionId: string, reason: string): void {
    const info = this.v2Sessions.get(sessionId);
    if (!info) return;

    claudeLog.info(`[Claude][${sessionId}] Cleaning up session: ${reason}`);

    // Preserve ccSessionId before destroying the V2 session so that
    // getOrCreateV2Session() can resume instead of creating a fresh session.
    if (info.capturedSessionId) {
      this.sessionCcIds.set(sessionId, info.capturedSessionId);
    }

    try {
      info.session.close();
    } catch {
      // Ignore close errors
    }

    this.v2Sessions.delete(sessionId);
  }

  /**
   * Built-in commands that ship with Claude Code. Used to distinguish
   * user-installed skills from built-in slash commands.
   */
  private static readonly BUILT_IN_COMMANDS = new Set([
    "compact", "context", "cost", "init", "review",
    "help", "clear", "config", "doctor", "memory", "model",
    "login", "logout", "bug", "mcp", "approved-tools",
    "pr-comments", "release-notes", "listen",
    // CC CLI built-in skills (returned by supportedCommands() but not user-defined)
    "update-config", "debug", "simplify", "batch", "loop",
    "claude-api", "heapdump", "security-review", "insights",
  ]);

  private isBuiltInCommand(name: string): boolean {
    return ClaudeCodeAdapter.BUILT_IN_COMMANDS.has(name);
  }

  /**
   * Scan a `.claude/skills/` directory for user-defined skills.
   * Each skill is a subdirectory containing a SKILL.md file with YAML front matter.
   */
  private static scanSkillsDir(dir: string): EngineCommand[] {
    if (!existsSync(dir)) return [];
    try {
      const entries = readdirSync(dir);
      const skills: EngineCommand[] = [];
      for (const entry of entries) {
        const skillFile = join(dir, entry, "SKILL.md");
        if (!existsSync(skillFile)) continue;
        let name = entry;
        let description = "";
        try {
          const content = readFileSync(skillFile, "utf-8");
          const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
            if (nameMatch) name = nameMatch[1].trim();
            const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
            if (descMatch) description = descMatch[1].trim();
          }
        } catch { /* ignore read errors */ }
        skills.push({ name, description });
      }
      return skills;
    } catch {
      return [];
    }
  }

  /**
   * Warm up by querying the SDK for available commands (including user-installed
   * skills). Uses the SDK Query's supportedCommands() API which returns
   * SlashCommand[] with full name + description + argumentHint.
   *
   * Creates a lightweight sdkQuery session, extracts commands, and closes it.
   */
  private async warmupV2Session(sessionId: string, directory: string): Promise<void> {
    // Skip if commands are already populated (e.g. another session already warmed up)
    if (this.availableCommands.length > 0) return;

    const cwd = directory.replaceAll("/", process.platform === "win32" ? "\\" : "/");
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.options?.env,
    };
    delete env.ANTHROPIC_MODEL;
    delete env.ELECTRON_RUN_AS_NODE;

    const q = sdkQuery({
      prompt: "",
      options: {
        model: "claude-sonnet-4-20250514",
        env,
        cwd,
        abortController: new AbortController(),
        pathToClaudeCodeExecutable: this.resolveCliPath(),
        stderr: this.stderrCallback,
      } as any,
    });

    try {
      const commands = await q.supportedCommands();
      this.availableCommands = commands.map((cmd: { name: string; description: string; argumentHint: string }) => ({
        name: cmd.name,
        description: cmd.description || "",
        argumentHint: cmd.argumentHint || undefined,
      }));

      // Supplement with user-defined skills from .claude/skills/ directories.
      // The CC CLI's supportedCommands() API may not include these.
      const existingNames = new Set(this.availableCommands.map((c) => c.name));
      const userSkillDirs = [
        join(homedir(), ".claude", "skills"),
        join(cwd, ".claude", "skills"),
      ];
      for (const dir of userSkillDirs) {
        for (const skill of ClaudeCodeAdapter.scanSkillsDir(dir)) {
          if (!existingNames.has(skill.name)) {
            existingNames.add(skill.name);
            this.availableCommands.push(skill);
          }
        }
      }

      // Cache skill names (non-built-in commands) for system prompt injection
      this.cachedSkillNames = this.availableCommands
        .filter((cmd) => !this.isBuiltInCommand(cmd.name))
        .map((cmd) => cmd.name);

      this.emit("commands.changed", {
        engineType: this.engineType,
        commands: this.availableCommands,
      });

      claudeLog.info(
        `[Claude][${sessionId}] Warmup complete via supportedCommands(): ${this.availableCommands.length} commands (${this.cachedSkillNames.length} user skills: ${this.cachedSkillNames.join(", ")})`,
      );
    } catch (err) {
      claudeLog.warn(`[Claude][${sessionId}] supportedCommands() failed, using fallback:`, err);
      // Minimal fallback + user-defined skills
      this.availableCommands = [
        { name: "compact", description: "Compact conversation context" },
        { name: "context", description: "Show current context window usage" },
        { name: "cost", description: "Show token usage and cost" },
      ];
      const existingNames = new Set(this.availableCommands.map((c) => c.name));
      for (const dir of [join(homedir(), ".claude", "skills"), join(cwd, ".claude", "skills")]) {
        for (const skill of ClaudeCodeAdapter.scanSkillsDir(dir)) {
          if (!existingNames.has(skill.name)) {
            existingNames.add(skill.name);
            this.availableCommands.push(skill);
          }
        }
      }
      this.emit("commands.changed", {
        engineType: this.engineType,
        commands: this.availableCommands,
      });
    } finally {
      try {
        q.close();
      } catch {
        // Ignore errors during cleanup
      }
    }
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
    messageContent: string | object,
    buffer: MessageBuffer,
    abortController: AbortController,
  ): Promise<void> {
    const streamingBlocks = new Map<number, StreamingBlock>();
    const endState: StreamEndState = {
      receivedResult: false,
      hadErrorDuringExecution: false,
    };

    try {
      // Send the message — string for text-only, SDKUserMessage for multimodal
      await v2Session.send(messageContent as any);

      // Slash commands (e.g. /compact, /help) are processed locally by the CLI
      // and may NOT produce a system:init message. We must not misclassify
      // their output as stale autonomous turns.
      const isSlashCommand =
        typeof messageContent === "string" && messageContent.startsWith("/");

      // Process stream events — loop to handle multiple turns from enqueued messages
      let staleTurnRetries = 0;
      while (!abortController.signal.aborted) {
        let firstMessageIsInit = false;
        let messageCount = 0;
        // Reset per-turn — only the final turn's result matters for end-state
        endState.receivedResult = false;
        endState.hadErrorDuringExecution = false;

        for await (const sdkMessage of v2Session.stream()) {
          if (abortController.signal.aborted) break;
          messageCount++;

          // Track whether the first message is system:init (normal turn start).
          // Stale autonomous turns (from subagent completions after a previous
          // turn's result) start with other types like task_notification.
          if (messageCount === 1) {
            firstMessageIsInit =
              (sdkMessage as any).type === "system" &&
              (sdkMessage as any).subtype === "init";
          }

          this.handleSdkMessage(
            sdkMessage,
            sessionId,
            buffer,
            streamingBlocks,
            endState,
          );
        }

        // Safety: if stream() produced zero messages, the CLI is likely idle
        // or the subprocess has died. Break immediately to prevent tight-loop
        // spinning that starves the event loop (see #43203-discard-spin).
        if (messageCount === 0 && !abortController.signal.aborted) {
          claudeLog.warn(
            `[Claude][${sessionId}] stream() returned 0 messages — CLI may be idle or dead, breaking`,
          );
          break;
        }

        // If the first message was NOT system:init, this MAY be a stale
        // autonomous turn produced by the CLI after the previous turn's result
        // (e.g. from subagent task_notification). However, slash commands also
        // lack system:init — don't discard those.
        if (!firstMessageIsInit && !isSlashCommand && !abortController.signal.aborted) {
          staleTurnRetries++;
          if (staleTurnRetries > 3) {
            claudeLog.warn(
              `[Claude][${sessionId}] Too many stale turn retries (${staleTurnRetries}), breaking`,
            );
            break;
          }
          claudeLog.info(
            `[Claude][${sessionId}] Discarding stale autonomous turn (first msg was not system:init, retry ${staleTurnRetries})`,
          );
          buffer.parts = [];
          buffer.textAccumulator = "";
          buffer.textPartId = null;
          buffer.reasoningAccumulator = "";
          buffer.reasoningPartId = null;
          buffer.leadingTrimmed = undefined;
          delete buffer.tokens;
          delete buffer.cost;
          delete buffer.error;
          streamingBlocks.clear();
          continue;
        }

        // stream() returned (hit a result message) — evaluate end state
        //
        // Truth table:
        // | hasContent | isInterrupted | wasAborted | Error key                 |
        // |------------|---------------|------------|---------------------------|
        // | yes        | -             | yes        | "error:stopped_by_user"   |
        // | yes        | yes           | no         | "error:interrupted"       |
        // | yes        | no            | no         | (none — normal)           |
        // | no         | -             | yes        | (none — user intended)    |
        // | no         | yes           | no         | "error:interrupted"       |
        // | no         | no            | no         | "error:empty_response"    |
        const hasContent = !!(buffer.textAccumulator || buffer.parts.length > 0);
        const wasAborted = abortController.signal.aborted;
        const isInterrupted = !endState.receivedResult || endState.hadErrorDuringExecution;

        if (!buffer.error) {
          if (hasContent) {
            if (wasAborted) {
              buffer.error = "error:stopped_by_user";
            } else if (isInterrupted) {
              buffer.error = "error:interrupted";
            }
          } else {
            // No content
            if (!wasAborted) {
              if (isInterrupted) {
                buffer.error = "error:interrupted";
              } else {
                buffer.error = "error:empty_response";
              }
            }
          }
        }

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
          reasoningEffort: buffer.reasoningEffort,
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
    endState: StreamEndState,
  ): void {
    claudeLog.debug(
      `[Claude][${sessionId}] handleSdkMessage: type=${(msg as any).type}, subtype=${(msg as any).subtype ?? "N/A"}`,
    );

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
        this.handleResultMessage(msg, sessionId, buffer, endState);
        break;

      case "stream_event":
        this.handleStreamEvent(
          msg as any,
          sessionId,
          buffer,
          streamingBlocks,
        );
        break;

      case "tool_progress":
        this.handleToolProgress(msg as any, sessionId);
        break;

      case "tool_use_summary":
        this.handleToolUseSummary(msg as any, sessionId);
        break;

      default:
        // Log type/subtype only — avoid serializing full message to prevent leaking user data
        claudeLog.debug(
          `[Claude][${sessionId}] Unhandled message: type=${(msg as any).type}, subtype=${(msg as any).subtype}`,
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
    claudeLog.debug(
      `[Claude][${sessionId}] handleSystemMessage: subtype=${msg.subtype}`,
    );
    if (msg.subtype === "init") {
      const ccSessionId = msg.session_id;

      if (ccSessionId) {
        // Store the CC session ID for future resumption — both in the V2 session
        // object AND in the persistent sessionCcIds map. The latter survives V2
        // session destruction (idle timeout, setModel, stop) so that
        // getOrCreateV2Session() can still call resumeSession() instead of
        // creating a brand-new session and losing conversation context.
        const v2Info = this.v2Sessions.get(sessionId);
        if (v2Info) {
          v2Info.capturedSessionId = ccSessionId;
        }
        this.sessionCcIds.set(sessionId, ccSessionId);

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

      // Note: Command/skill discovery is handled by warmupV2Session() via
      // supportedCommands() API. The init message's slash_commands/skills
      // arrays are ignored here to avoid overwriting the richer data from
      // the API (which includes descriptions and argumentHints).
    } else if (msg.subtype === "local_command_output") {
      // Slash command output (e.g., /help, /cost, /compact).
      const output = msg.content ?? "";
      claudeLog.debug(
        `[Claude][${sessionId}] local_command_output: content_length=${output.length}`,
      );
      if (output) {
        this.appendText(sessionId, buffer, output);
      }
    } else if (msg.subtype === "status") {
      // Handle status changes (e.g., compacting)
      if (msg.status === "compacting") {
        claudeLog.info(
          `[Claude][${sessionId}] Context compacting...`,
        );
      }
    } else if (msg.subtype === "compact_boundary") {
      // Context compaction completed — emit a SystemNoticePart so frontend
      // renders it as a centered gray notification bar instead of inline text.
      const meta = msg.compact_metadata as
        | { trigger: "manual" | "auto"; pre_tokens: number }
        | undefined;
      if (meta) {
        const preK = Math.round(meta.pre_tokens / 1000);
        claudeLog.info(
          `[Claude][${sessionId}] Context compacted: trigger=${meta.trigger}, pre_tokens=${preK}K`,
        );
        const noticePart: SystemNoticePart = {
          type: "system-notice",
          id: timeId("part"),
          messageId: buffer.messageId,
          sessionId,
          noticeType: "compact",
          text: "notice:context_compressed",
        };
        buffer.parts.push(noticePart);
        this.emitPartUpdated(sessionId, buffer, noticePart);
      }
    } else if (msg.subtype === "task_started") {
      // Subagent task started — map task_id to tool_use_id and enrich ToolPart
      const toolUseId = msg.tool_use_id;
      const taskId = msg.task_id;
      if (toolUseId && taskId) {
        this.taskToToolUseId.set(taskId, toolUseId);
        const toolPart = this.toolCallParts.get(toolUseId);
        if (toolPart && (toolPart.state.status === "running" || toolPart.state.status === "pending")) {
          const input = ((toolPart.state as any).input ?? {}) as Record<string, unknown>;
          input._taskId = taskId;
          input._taskDescription = msg.description;
          if (msg.prompt) input._taskPrompt = msg.prompt;
          (toolPart.state as any).input = input;
          this.emit("message.part.updated", { sessionId, messageId: toolPart.messageId, part: toolPart });
        }
      }
      claudeLog.debug(`[Claude][${sessionId}] task_started: task=${taskId}, tool_use=${toolUseId}`);
    } else if (msg.subtype === "task_progress") {
      // Subagent progress update — update ToolPart with latest activity info
      const toolUseId = msg.tool_use_id || this.taskToToolUseId.get(msg.task_id);
      if (toolUseId) {
        const toolPart = this.toolCallParts.get(toolUseId);
        if (toolPart && (toolPart.state.status === "running" || toolPart.state.status === "pending")) {
          const input = ((toolPart.state as any).input ?? {}) as Record<string, unknown>;
          if (msg.description) input._taskDescription = msg.description;
          if (msg.last_tool_name) input._lastToolName = msg.last_tool_name;
          if (msg.summary) input._summary = msg.summary;
          if (msg.usage) {
            input._taskUsage = {
              totalTokens: msg.usage.total_tokens,
              toolUses: msg.usage.tool_uses,
              durationMs: msg.usage.duration_ms,
            };
          }
          (toolPart.state as any).input = input;
          this.emit("message.part.updated", { sessionId, messageId: toolPart.messageId, part: toolPart });
        }
      }
      claudeLog.debug(`[Claude][${sessionId}] task_progress: task=${msg.task_id}, last_tool=${msg.last_tool_name}`);
    } else if (msg.subtype === "task_notification") {
      // Subagent finished — update ToolPart with final status/summary
      const toolUseId = msg.tool_use_id || this.taskToToolUseId.get(msg.task_id);
      if (toolUseId) {
        const toolPart = this.toolCallParts.get(toolUseId);
        if (toolPart && (toolPart.state.status === "running" || toolPart.state.status === "pending")) {
          const input = ((toolPart.state as any).input ?? {}) as Record<string, unknown>;
          input._taskStatus = msg.status;
          if (msg.summary) input._summary = msg.summary;
          if (msg.usage) {
            input._taskUsage = {
              totalTokens: msg.usage.total_tokens,
              toolUses: msg.usage.tool_uses,
              durationMs: msg.usage.duration_ms,
            };
          }
          (toolPart.state as any).input = input;
          this.emit("message.part.updated", { sessionId, messageId: toolPart.messageId, part: toolPart });
        }
        this.taskToToolUseId.delete(msg.task_id);
      }
      claudeLog.debug(`[Claude][${sessionId}] task_notification: task=${msg.task_id}, status=${msg.status}`);
    }
  }

  /**
   * Handle tool_progress messages — update parent Task ToolPart with current subtool info.
   */
  private handleToolProgress(
    msg: { tool_use_id: string; tool_name: string; parent_tool_use_id: string | null; elapsed_time_seconds: number; task_id?: string },
    sessionId: string,
  ): void {
    // Only interested in tools running inside a subagent (parent_tool_use_id set)
    const parentToolUseId = msg.parent_tool_use_id;
    if (parentToolUseId) {
      const toolPart = this.toolCallParts.get(parentToolUseId);
      if (toolPart && (toolPart.state.status === "running" || toolPart.state.status === "pending")) {
        const input = ((toolPart.state as any).input ?? {}) as Record<string, unknown>;
        input._currentTool = msg.tool_name;
        input._currentToolElapsed = msg.elapsed_time_seconds;
        (toolPart.state as any).input = input;
        this.emit("message.part.updated", { sessionId, messageId: toolPart.messageId, part: toolPart });
      }
    }
  }

  /**
   * Handle tool_use_summary — enrich the most recent preceding ToolPart with the summary.
   */
  private handleToolUseSummary(
    msg: { summary: string; preceding_tool_use_ids: string[] },
    sessionId: string,
  ): void {
    // Find the last preceding tool_use that is a Task part and attach the summary
    for (let i = msg.preceding_tool_use_ids.length - 1; i >= 0; i--) {
      const toolPart = this.toolCallParts.get(msg.preceding_tool_use_ids[i]);
      if (toolPart && toolPart.normalizedTool === "task") {
        const input = ((toolPart.state as any).input ?? {}) as Record<string, unknown>;
        if (!input._summary) {
          input._summary = msg.summary;
          (toolPart.state as any).input = input;
          this.emit("message.part.updated", { sessionId, messageId: toolPart.messageId, part: toolPart });
        }
        break;
      }
    }
    claudeLog.debug(`[Claude][${sessionId}] tool_use_summary: ids=${msg.preceding_tool_use_ids.length}`);
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

    // Handle content — may be a string (from slash command output via Ko1())
    // or an array of content blocks (from normal LLM responses).
    const content = betaMessage.content;
    if (typeof content === "string") {
      // Slash command output converted by SDK: content is plain text
      if (content.trim()) {
        this.appendText(sessionId, buffer, content);
      }
      return;
    }

    if (!Array.isArray(content)) return;

    // Process content blocks
    for (const block of content) {
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
   * Handle user messages from the stream.
   * These include tool_result blocks (normal flow) and also synthetic user
   * messages from slash command output (CLI wraps output in user messages
   * for commands with display !== "system").
   */
  private handleUserMessage(
    msg: any,
    sessionId: string,
    buffer: MessageBuffer,
  ): void {
    const betaMessage = msg.message;
    if (!betaMessage?.content) return;

    // Ignore synthetic replay messages — these are echoes of the command input,
    // not actual output we should display.
    if (msg.isReplay || msg.isSynthetic) return;

    // String content — may be slash command output stripped of XML tags
    if (typeof betaMessage.content === "string") {
      const text = betaMessage.content.trim();
      if (text) {
        this.appendText(sessionId, buffer, text);
      }
      return;
    }

    if (!Array.isArray(betaMessage.content)) return;

    for (const block of betaMessage.content) {
      if (block.type === "tool_result") {
        this.handleToolResult(sessionId, buffer, block);
      } else if (block.type === "text") {
        // Text blocks in user messages — from slash command output
        const text = (block.text ?? "").trim();
        if (text) {
          this.appendText(sessionId, buffer, text);
        }
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
    endState: StreamEndState,
  ): void {
    endState.receivedResult = true;

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
    } else if (msg.subtype === "error_during_execution") {
      endState.hadErrorDuringExecution = true;
      claudeLog.info(
        `[Claude][${sessionId}] Result subtype=error_during_execution (interrupted)`,
      );
    }

    // For slash commands: if the buffer has no text content but the result
    // message carries text, use it as the command output. This handles
    // local-jsx commands where the JSX rendering doesn't produce stream
    // messages but the CLI records a result text.
    if (
      !msg.is_error &&
      typeof msg.result === "string" &&
      msg.result.trim() &&
      buffer.parts.length === 0 &&
      !buffer.textAccumulator
    ) {
      this.appendText(sessionId, buffer, msg.result);
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

          // Update tool part with parsed input (normalize snake_case keys)
          const toolPart = this.toolCallParts.get(block.toolId);
          if (toolPart && toolPart.state.status === "running") {
            (toolPart.state as any).input = ClaudeCodeAdapter.normalizeInputKeys(parsedInput);
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

  /**
   * Convert snake_case keys to camelCase so frontend tool components
   * (which expect camelCase like `filePath`) work with Claude SDK input
   * (which sends snake_case like `file_path`).
   */
  private static normalizeInputKeys(input: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      result[camelKey] = value;
    }
    return result;
  }

  private createToolPart(
    sessionId: string,
    buffer: MessageBuffer,
    toolCallId: string,
    toolName: string,
    input: any,
  ): void {
    const normalizedTool = normalizeToolName("claude", toolName);
    const toolPartId = timeId("tp");
    const normalizedInput = input && typeof input === "object"
      ? ClaudeCodeAdapter.normalizeInputKeys(input)
      : (input ?? {});
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
        input: normalizedInput,
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
      // Build metadata for tools that need it (e.g., Edit → diff)
      const metadata = this.buildToolMetadata(toolPart, output);
      toolPart.state = {
        status: "completed",
        input: (toolPart.state as any).input ?? {},
        output,
        time: { start: startTime, end: now, duration: now - startTime },
        metadata,
      };
    }

    // Add step-finish
    const stepFinishPart: StepFinishPart = { type: "step-finish", id: timeId("pt"), messageId: buffer.messageId, sessionId };
    buffer.parts.push(stepFinishPart);
    this.emitPartUpdated(sessionId, buffer, stepFinishPart);

    // Emit updated tool part
    this.emitPartUpdated(sessionId, buffer, toolPart);
  }

  /**
   * Build metadata for completed tool parts.
   * For Edit tools, constructs a unified diff from oldString/newString.
   */
  private buildToolMetadata(
    toolPart: ToolPart,
    _output: string,
  ): Record<string, unknown> | undefined {
    if (toolPart.normalizedTool !== "edit") return undefined;

    const input = (toolPart.state as any).input as Record<string, unknown> | undefined;
    if (!input) return undefined;

    const filePath = (input.filePath as string) ?? "";
    const oldStr = (input.oldString as string) ?? "";
    const newStr = (input.newString as string) ?? "";

    if (!oldStr && !newStr) return undefined;

    try {
      const diff = createTwoFilesPatch(filePath, filePath, oldStr, newStr, "", "", { context: 3 });
      return { diff };
    } catch {
      return undefined;
    }
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
      reasoningEffort: buffer.reasoningEffort,
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
    for (const [taskId, toolUseId] of this.taskToToolUseId) {
      if (!this.toolCallParts.has(toolUseId)) {
        this.taskToToolUseId.delete(taskId);
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
      reasoningEffort: buffer.reasoningEffort,
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
    for (const [taskId, toolUseId] of this.taskToToolUseId) {
      if (!this.toolCallParts.has(toolUseId)) {
        this.taskToToolUseId.delete(taskId);
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
        // Check for dead processes first (killed by OS, crashed, OOM)
        if (!this.isSessionTransportReady(info.session)) {
          this.cleanupSession(sessionId, "process not ready (polling)");
          continue;
        }

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
    this.lastError = error;
    this.emit("status.changed", {
      engineType: this.engineType,
      status,
      error,
    });
  }
}
