// ============================================================================
// Copilot SDK Adapter — GitHub Copilot integration via @github/copilot-sdk
// ============================================================================

import { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { timeId } from "../../utils/id-gen";
import { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import type {
  SessionEvent,
  SessionConfig,
  ResumeSessionConfig,
  PermissionRequestResult,
} from "@github/copilot-sdk";

import { EngineAdapter, MessageBuffer } from "../engine-adapter";
import { CODEMUX_IDENTITY_PROMPT } from "../identity-prompt";
import { copilotLog } from "../../services/logger";
import { inferToolKind, normalizeToolName } from "../../../../src/types/tool-mapping";
import type {
  EngineType,
  EngineStatus,
  EngineCapabilities,
  EngineInfo,
  AuthMethod,
  UnifiedSession,
  UnifiedMessage,
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
  PermissionOption,
  EngineCommand,
  CommandInvokeResult,
} from "../../../../src/types/unified";

import {
  convertEventsToMessages,
  createUserMessage,
  buildToolTitle,
  normalizeTodoInput,
  normalizeTodoStatus,
  upsertPart,
  sdkModelToUnified,
  metadataToSession,
} from "./converters";

import {
  DEFAULT_MODES,
  readConfigModel,
  resolvePlatformCli,
} from "./config";

/** Equivalent to SDK's UserInputRequest */
interface UserInputRequest {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
}

/** Equivalent to SDK's UserInputResponse */
interface UserInputResponse {
  answer: string;
  wasFreeform: boolean;
}

/** Equivalent to SDK's PermissionRequest */
interface PermissionRequest {
  kind: string;
  toolCallId: string;
  [key: string]: any;
}

interface PendingPermission {
  resolve: (result: PermissionRequestResult) => void;
  permission: UnifiedPermission;
}

interface PendingQuestion {
  resolve: (response: UserInputResponse) => void;
  question: UnifiedQuestion;
}

export class CopilotSdkAdapter extends EngineAdapter {
  readonly engineType: EngineType = "copilot";

  private client: CopilotClient | null = null;
  private activeSessions = new Map<string, CopilotSession>();
  private sessionUnsubscribers = new Map<string, () => void>();

  private status: EngineStatus = "stopped";
  private lastError: string | undefined;
  private version: string | undefined;
  private authenticated: boolean | undefined;
  private authMessage: string | undefined;
  private currentModelId: string | null = null;
  private cachedModels: UnifiedModelInfo[] = [];
  private sessionModes = new Map<string, string>();
  private sessionDirectories = new Map<string, string>();

  private sessionTodos = new Map<string, Map<string, { id: string; title: string; status: string }>>();
  private allowedAlwaysKinds = new Set<string>();
  private cachedCommands: EngineCommand[] = [];

  private messageBuffers = new Map<string, MessageBuffer>();
  private messageHistory = new Map<string, UnifiedMessage[]>();

  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingQuestions = new Map<string, PendingQuestion>();

  private idleResolvers = new Map<string, Array<(msg: UnifiedMessage) => void>>();
  // Queued user messages (deferred emit) — emitted only when the engine
  // starts processing the queued turn, not at enqueue time.
  private pendingUserMessages = new Map<string, UnifiedMessage[]>();
  private toolCallParts = new Map<string, ToolPart>();
  private taskCompleteCallIds = new Set<string>();

  constructor(private options?: { cliPath?: string; env?: Record<string, string> }) {
    super();
  }

  async start(): Promise<void> {
    if (this.status === "running") return;

    this.setStatus("starting");
    copilotLog.info("Starting Copilot SDK adapter...");

    try {
      const cliPath = this.options?.cliPath ?? resolvePlatformCli();
      if (!cliPath) {
        throw new Error(
          `No platform-native Copilot CLI binary found for ${process.platform}-${process.arch}. ` +
          `Install @github/copilot-${process.platform}-${process.arch} or provide a custom cliPath.`,
        );
      }
      copilotLog.info("Using Copilot CLI binary:", cliPath);

      // Remove ELECTRON_RUN_AS_NODE which leaks from Electron in packaged builds
      // and causes the Copilot CLI subprocess to malfunction (stream destroyed).
      const env = { ...process.env, ...this.options?.env };
      delete env.ELECTRON_RUN_AS_NODE;

      this.client = new CopilotClient({
        useStdio: true,
        autoRestart: true,
        autoStart: true,
        cliPath,
        env,
      });

      await this.client.start();
      await this.client.ping();

      try {
        const status = await this.client.getStatus();
        this.version = status.version;
      } catch (error) {
        copilotLog.warn("Failed to get Copilot CLI version:", error);
      }

      try {
        const authStatus = await this.client.getAuthStatus();
        this.authenticated = authStatus.isAuthenticated;
        this.authMessage = authStatus.isAuthenticated
          ? authStatus.login ?? authStatus.authType
          : authStatus.statusMessage ?? "Not authenticated";
      } catch (error) {
        copilotLog.warn("Failed to get Copilot auth status:", error);
      }

      this.currentModelId = readConfigModel() ?? null;
      this.setStatus("running");
    } catch (err) {
      copilotLog.error("Failed to start Copilot SDK adapter:", err);
      this.setStatus("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.status === "stopped") return;
    copilotLog.info("Stopping Copilot SDK adapter...");

    for (const [sessionId, session] of this.activeSessions) {
      try {
        const unsub = this.sessionUnsubscribers.get(sessionId);
        if (unsub) unsub();
        await session.disconnect();
      } catch (err) {
        copilotLog.warn(`Error destroying session ${sessionId}:`, err);
      }
    }
    this.activeSessions.clear();
    this.sessionUnsubscribers.clear();

    this.rejectAllPendingPermissions("Adapter stopped");
    this.rejectAllPendingQuestions("Adapter stopped");

    if (this.client) {
      try {
        await this.client.stop();
      } catch (err) {
        copilotLog.warn("Error stopping Copilot client:", err);
      }
      this.client = null;
    }

    this.setStatus("stopped");
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  getStatus(): EngineStatus { return this.status; }

  getInfo(): EngineInfo {
    return {
      type: this.engineType,
      name: "GitHub Copilot",
      version: this.version,
      status: this.status,
      capabilities: this.getCapabilities(),
      authMethods: this.getAuthMethods(),
      authenticated: this.authenticated,
      authMessage: this.authMessage,
      errorMessage: this.status === "error" ? this.lastError : undefined,
    };
  }

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
      customModelInput: false,
      messageEnqueue: true,
      slashCommands: true,
      availableModes: this.getModes(),
    };
  }

  getAuthMethods(): AuthMethod[] {
    return [
      { id: "github", name: "GitHub", description: "Sign in with GitHub to use Copilot" },
    ];
  }

  async listSessions(directory?: string): Promise<UnifiedSession[]> {
    this.ensureClient();
    try {
      const metadataList = await this.client!.listSessions();
      const sessions = metadataList.map((m) => metadataToSession(this.engineType, m));
      if (directory) {
        const normDir = directory.replaceAll("\\", "/");
        return sessions.filter((s) => s.directory === normDir);
      }
      return sessions;
    } catch (err) {
      copilotLog.warn("Failed to list sessions from SDK:", err);
      return [];
    }
  }

  async createSession(directory: string): Promise<UnifiedSession> {
    this.ensureClient();
    const normalizedDir = directory.replaceAll("\\", "/");
    const mode = "autopilot";

    const config: SessionConfig = {
      workingDirectory: directory,
      streaming: true,
      model: this.currentModelId ?? undefined,
      onPermissionRequest: (req, ctx) => this.handlePermissionRequest(req as any, ctx),
      onUserInputRequest: (req, ctx) => this.handleUserInputRequest(req as any, ctx),
      systemMessage: { mode: "append" as const, content: CODEMUX_IDENTITY_PROMPT },
    };

    const sdkSession = await this.client!.createSession(config);
    const sessionId = sdkSession.sessionId;

    this.subscribeToSessionEvents(sdkSession);
    this.activeSessions.set(sessionId, sdkSession);
    this.sessionModes.set(sessionId, mode);
    this.sessionDirectories.set(sessionId, directory);

    const now = Date.now();
    const session: UnifiedSession = {
      id: sessionId,
      engineType: this.engineType,
      directory: normalizedDir,
      time: { created: now, updated: now },
    };

    this.emit("session.created", { session });

    // Fetch initial skills/commands for slash command support.
    // Await the fetch to ensure cachedCommands is populated before
    // the frontend calls listCommands() shortly after session creation.
    try {
      await this.fetchSkills(sdkSession);
    } catch (err) {
      copilotLog.warn(`Failed to fetch initial skills for session ${sessionId}:`, err);
    }

    return session;
  }

  hasSession(sessionId: string): boolean {
    // Check if session is active in memory
    if (this.activeSessions.has(sessionId)) {
      return true;
    }

    // Copilot CLI persists sessions to disk; even after app restart
    // (activeSessions cleared), the CLI can resume them via session.resume RPC.
    // Always return true to let ensureActiveSession attempt resumeSession().
    return true;
  }
  async getSession(sessionId: string): Promise<UnifiedSession | null> { return null; }

  async deleteSession(sessionId: string): Promise<void> {
    const activeSession = this.activeSessions.get(sessionId);
    if (activeSession) {
      const unsub = this.sessionUnsubscribers.get(sessionId);
      if (unsub) unsub();
      this.sessionUnsubscribers.delete(sessionId);
      try {
        await activeSession.disconnect();
      } catch (err) {}
      this.activeSessions.delete(sessionId);
    }

    try {
      await this.client?.deleteSession(sessionId);
    } catch (err) {}

    this.messageHistory.delete(sessionId);
    this.messageBuffers.delete(sessionId);
    this.sessionModes.delete(sessionId);
    this.sessionDirectories.delete(sessionId);
    this.sessionTodos.delete(sessionId);
  }

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: { mode?: string; modelId?: string; directory?: string },
  ): Promise<UnifiedMessage> {
    const session = await this.ensureActiveSession(sessionId, options?.directory);
    const now = Date.now();

    if (options?.modelId && options.modelId !== this.currentModelId) {
      this.currentModelId = options.modelId;
      try {
        await session.rpc.model.switchTo({ modelId: options.modelId });
      } catch (err) {}
    }

    if (options?.mode) {
      const previousMode = this.sessionModes.get(sessionId);
      this.sessionModes.set(sessionId, options.mode);
      if (options.mode !== previousMode) {
        const sdkMode = options.mode as any;
        try {
          await session.rpc.mode.set({ mode: sdkMode });
        } catch (err) {}
      }
    }

    let promptText = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");

    // When only images are sent without text, use a placeholder to avoid empty prompt
    const imageContents = content.filter((c) => c.type === "image" && c.data);
    if (!promptText && imageContents.length > 0) {
      promptText = "Describe this image.";
    }

    // Build file attachments for images — Copilot CLI accepts image files
    // via type:"file" attachments and automatically processes them for vision
    const tempImagePaths: string[] = [];
    const tempDirs: string[] = [];
    const attachments: Array<{ type: "file"; path: string; displayName?: string }> = [];

    for (const img of imageContents) {
      try {
        const ext = img.mimeType?.split("/")[1] ?? "png";
        const tmpDir = mkdtempSync(join(tmpdir(), "codemux-img-"));
        tempDirs.push(tmpDir);
        const tmpPath = join(tmpDir, `image.${ext}`);
        writeFileSync(tmpPath, Buffer.from(img.data!, "base64"));
        tempImagePaths.push(tmpPath);
        attachments.push({ type: "file", path: tmpPath, displayName: `image.${ext}` });
      } catch (err) {
        copilotLog.warn(`Failed to write temp image file:`, err);
      }
    }

    // Cleanup temp files after send completes (deferred)
    const cleanupTempImages = () => {
      for (const p of tempImagePaths) {
        try { unlinkSync(p); } catch {}
      }
      for (const d of tempDirs) {
        try { rmdirSync(d); } catch {}
      }
    };

    // --- Enqueue path: engine is already processing this session ---
    const existingResolvers = this.idleResolvers.get(sessionId);
    if (existingResolvers && existingResolvers.length > 0) {
      // Create user message but DON'T emit yet — defer until handleSessionIdle
      // starts processing this queued turn. Emitting immediately would create
      // a user bubble while the engine is still working on the previous turn.
      const userMessage = createUserMessage(sessionId, promptText, now);
      this.appendMessageToHistory(sessionId, userMessage);

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

      copilotLog.info(`Message enqueued for session ${sessionId} (position ${queuePosition})`);

      return new Promise<UnifiedMessage>((resolve, reject) => {
        existingResolvers.push(resolve);

        const handleEnqueueError = (err: unknown) => {
          cleanupTempImages();
          const idx = existingResolvers.indexOf(resolve);
          if (idx >= 0) existingResolvers.splice(idx, 1);
          if (existingResolvers.length === 0) this.idleResolvers.delete(sessionId);
          reject(err);
        };

        session.send({ prompt: promptText, attachments: attachments.length > 0 ? attachments : undefined, mode: "enqueue" as any }).then(() => {
          cleanupTempImages();
        }).catch(async (err) => {
          if (this.isSessionExpiredError(err)) {
            copilotLog.warn(`Session ${sessionId} expired (enqueue), recreating and retrying...`);
            this.evictStaleSession(sessionId);
            try {
              const freshSession = await this.ensureActiveSession(sessionId, options?.directory);
              freshSession.send({ prompt: promptText, attachments: attachments.length > 0 ? attachments : undefined, mode: "enqueue" as any }).catch(handleEnqueueError);
              return;
            } catch { /* fall through */ }
          }
          handleEnqueueError(err);
        });
      });
    }

    // --- Normal path: session is idle ---

    const userMessage = createUserMessage(sessionId, promptText, now);
    this.appendMessageToHistory(sessionId, userMessage);
    this.emit("message.updated", { sessionId, message: userMessage });

    const messageId = timeId("msg");
    const buffer: MessageBuffer = {
      messageId,
      sessionId,
      parts: [],
      textAccumulator: "",
      textPartId: null,
      reasoningAccumulator: "",
      reasoningPartId: null,
      startTime: Date.now(),
      modelId: this.currentModelId ?? undefined,
    };
    this.messageBuffers.set(sessionId, buffer);

    const initialMessage = this.bufferToMessage(buffer, false);
    this.emit("message.updated", { sessionId, message: initialMessage });

    return new Promise<UnifiedMessage>((resolve, reject) => {
      const resolvers = this.idleResolvers.get(sessionId) ?? [];
      resolvers.push(resolve);
      this.idleResolvers.set(sessionId, resolvers);

      const handleSendError = (err: unknown) => {
        const currentResolvers = this.idleResolvers.get(sessionId);
        if (currentResolvers) {
          const idx = currentResolvers.indexOf(resolve);
          if (idx >= 0) currentResolvers.splice(idx, 1);
          if (currentResolvers.length === 0) this.idleResolvers.delete(sessionId);
        }
        const buf = this.messageBuffers.get(sessionId);
        if (buf) {
          buf.error = err instanceof Error ? err.message : String(err);
          this.finalizeBuffer(sessionId);
        }
        reject(err);
      };

      session.send({ prompt: promptText, attachments: attachments.length > 0 ? attachments : undefined }).catch(async (err) => {
        if (this.isSessionExpiredError(err)) {
          copilotLog.warn(`Session ${sessionId} expired, recreating and retrying...`);
          this.evictStaleSession(sessionId);
          try {
            const freshSession = await this.ensureActiveSession(sessionId, options?.directory);
            freshSession.send({ prompt: promptText, attachments: attachments.length > 0 ? attachments : undefined }).catch(handleSendError);
            return;
          } catch { /* fall through to handleSendError */ }
        }
        handleSendError(err);
      });

      // Cleanup temp image files after a delay — CLI reads them synchronously
      if (tempImagePaths.length > 0) setTimeout(cleanupTempImages, 5000);
    });
  }

  async cancelMessage(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    try {
      await session.abort();
    } catch (err) {}

    for (const [id, pending] of this.pendingQuestions) {
      if (pending.question.sessionId === sessionId) {
        pending.resolve({ answer: "", wasFreeform: false });
        this.pendingQuestions.delete(id);
      }
    }
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.permission.sessionId === sessionId) {
        pending.resolve({ kind: "denied-interactively-by-user" });
        this.pendingPermissions.delete(id);
      }
    }

    const buffer = this.messageBuffers.get(sessionId);
    if (buffer) buffer.error = "Cancelled";
    const finalMessage = this.finalizeBuffer(sessionId);

    // Resolve ALL pending resolvers (including enqueued) with the cancelled message
    const resolvers = this.idleResolvers.get(sessionId);
    if (resolvers && finalMessage) {
      this.idleResolvers.delete(sessionId);
      for (const r of resolvers) r(finalMessage);
    }
    this.pendingUserMessages.delete(sessionId);
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    const cached = this.messageHistory.get(sessionId);
    if (cached && cached.length > 0) return cached;

    try {
      const session = await this.ensureActiveSession(sessionId);
      const events = await session.getMessages();
      const messages = convertEventsToMessages(sessionId, events);
      this.messageHistory.set(sessionId, messages);
      return messages;
    } catch (err) {
      return [];
    }
  }

  async getHistoricalMessages(
    engineSessionId: string,
    directory: string,
  ): Promise<UnifiedMessage[]> {
    this.ensureClient();
    let session: CopilotSession | undefined;
    try {
      const config: ResumeSessionConfig = {
        streaming: true,
        workingDirectory: directory,
        onPermissionRequest: () => ({ kind: "denied-interactively-by-user" as const }),
      };
      session = await this.client!.resumeSession(engineSessionId, config);
      const events = await session.getMessages();
      copilotLog.info(
        `[Copilot] getHistoricalMessages(${engineSessionId}): ${events.length} events`,
      );
      const messages = convertEventsToMessages(engineSessionId, events);
      copilotLog.info(
        `[Copilot] Converted to ${messages.length} messages (${messages.filter(m => m.role === "user").length} user, ${messages.filter(m => m.role === "assistant").length} assistant)`,
      );
      return messages;
    } catch (err: any) {
      copilotLog.warn(`Failed to get historical messages for ${engineSessionId}:`, err?.message);
      throw err;
    } finally {
      if (session) {
        try { await session.disconnect(); } catch { /* ignore */ }
      }
    }
  }

  async listModels(): Promise<ModelListResult> {
    this.ensureClient();
    try {
      const sdkModels = await this.client!.listModels();
      this.cachedModels = sdkModels.map((m: any) => sdkModelToUnified(this.engineType, m));
    } catch (err) {}

    return {
      models: this.cachedModels,
      currentModelId: this.currentModelId ?? undefined,
    };
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.currentModelId = modelId;
    const session = this.activeSessions.get(sessionId);
    if (session) {
      try {
        await session.rpc.model.switchTo({ modelId });
      } catch (err) {}
    }
  }

  getModes(): AgentMode[] { return DEFAULT_MODES; }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.sessionModes.set(sessionId, modeId);
    const session = this.activeSessions.get(sessionId);
    if (session) {
      const sdkMode = modeId as any;
      try {
        await session.rpc.mode.set({ mode: sdkMode });
      } catch (err) {}
    }
  }

  async replyPermission(permissionId: string, reply: PermissionReply, _sessionId?: string): Promise<void> {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) return;

    const optionId = reply.optionId;
    const isApproved = optionId === "allow_once" || optionId === "allow_always";

    if (optionId === "allow_always" && pending.permission.rawInput) {
      const rawKind = (pending.permission.rawInput as any).kind;
      if (rawKind) this.allowedAlwaysKinds.add(rawKind);
    }

    pending.resolve({ kind: isApproved ? "approved" : "denied-interactively-by-user" });
    this.pendingPermissions.delete(permissionId);
    this.emit("permission.replied", { permissionId, optionId });
  }

  async replyQuestion(questionId: string, answers: string[][], _sessionId?: string): Promise<void> {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return;

    // Combine all answers (selected options + custom text) into one string
    const allAnswers = answers[0] ?? [];
    const answer = allAnswers.join("\n") || "";
    pending.resolve({
      answer,
      wasFreeform: allAnswers.some((a) => !pending.question.questions[0]?.options?.some((opt) => opt.label === a)),
    });
    this.pendingQuestions.delete(questionId);
    this.emit("question.replied", { questionId, answers });
  }

  async rejectQuestion(questionId: string, _sessionId?: string): Promise<void> {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return;
    pending.resolve({ answer: "", wasFreeform: true });
    this.pendingQuestions.delete(questionId);
  }

  async listProjects(): Promise<UnifiedProject[]> { return []; }

  // --- Slash Commands / Skills ---

  private async fetchSkills(session: CopilotSession): Promise<void> {
    try {
      copilotLog.debug(`[Copilot] fetchSkills: calling session.rpc.skills.list()...`);
      const result = await session.rpc.skills.list();
      copilotLog.debug(`[Copilot] fetchSkills: received ${Array.isArray((result as any)?.skills ?? result) ? ((result as any)?.skills ?? result).length : 0} skills`);
      const skills = (result as any)?.skills ?? (result as any) ?? [];
      if (Array.isArray(skills)) {
        this.cachedCommands = skills
          .filter((s: any) => s.userInvocable !== false)
          .map((s: any) => ({
            name: s.name,
            description: s.description ?? "",
            source: s.source,
            userInvocable: s.userInvocable,
          }));
        copilotLog.info(`[Copilot] fetchSkills: cached ${this.cachedCommands.length} commands: ${this.cachedCommands.map(c => c.name).join(", ")}`);
        this.emit("commands.changed", {
          engineType: this.engineType,
          commands: this.cachedCommands,
        });
      } else {
        copilotLog.warn(`[Copilot] fetchSkills: skills is not an array: ${typeof skills}`);
      }
    } catch (err) {
      copilotLog.warn(`[Copilot] fetchSkills FAILED:`, err);
    }
  }

  override async listCommands(sessionId?: string, directory?: string): Promise<EngineCommand[]> {
    // If cached commands are available, return them immediately.
    if (this.cachedCommands.length > 0) return this.cachedCommands;

    copilotLog.info(`[Copilot] listCommands: cache empty, sessionId=${sessionId ?? "none"}, activeSessions=${this.activeSessions.size}`);

    // Cache is empty — try to fetch from the active session.
    // This handles the case where the initial fetch was skipped or failed.
    if (sessionId) {
      let session = this.activeSessions.get(sessionId);
      if (!session) {
        // Session not active yet — try to activate it so we can fetch skills.
        // Use the directory passed from engine-manager (from conversationStore),
        // falling back to the in-memory sessionDirectories map.
        const dir = directory || this.sessionDirectories.get(sessionId);
        if (dir) {
          try {
            copilotLog.info(`[Copilot] listCommands: activating session ${sessionId} to fetch skills`);
            session = await this.ensureActiveSession(sessionId, dir);
          } catch (err) {
            copilotLog.warn(`[Copilot] listCommands: failed to activate session:`, err);
          }
        }
      }
      if (session) {
        try {
          await this.fetchSkills(session);
        } catch (err) {
          copilotLog.warn(`[Copilot] Failed to fetch skills on listCommands:`, err);
        }
      }
    } else {
      // No sessionId provided — try the first active session
      const firstSession = this.activeSessions.values().next().value;
      if (firstSession) {
        try {
          await this.fetchSkills(firstSession);
        } catch (err) {
          copilotLog.warn(`[Copilot] Failed to fetch skills on listCommands (fallback):`, err);
        }
      }
    }

    return this.cachedCommands;
  }

  override async invokeCommand(
    sessionId: string,
    commandName: string,
    args: string,
    options?: { mode?: string; modelId?: string; directory?: string },
  ): Promise<CommandInvokeResult> {
    // Send the command as text — Copilot CLI intercepts /command prefix.
    // The CLI emits a command.execute event which we acknowledge via
    // handlePendingCommand() in handleCommandExecute().
    const commandText = `/${commandName}${args ? ` ${args}` : ""}`;
    const message = await this.sendMessage(
      sessionId,
      [{ type: "text", text: commandText }],
      options,
    );
    return { handledAsCommand: true, message };
  }

  /**
   * Handle command.execute event from Copilot CLI.
   * The CLI dispatches this when it intercepts a /command in user input.
   * We must acknowledge it via handlePendingCommand() so the CLI can proceed.
   */
  private async handleCommandExecute(
    sessionId: string,
    data: { requestId: string; command: string; commandName: string; args: string },
  ): Promise<void> {
    copilotLog.info(
      `[Copilot][${sessionId}] command.execute: /${data.commandName} ${data.args} (requestId=${data.requestId})`,
    );
    try {
      const session = this.activeSessions.get(sessionId);
      if (session) {
        await session.rpc.commands.handlePendingCommand({
          requestId: data.requestId,
        });
      }
    } catch (err) {
      copilotLog.warn(`[Copilot][${sessionId}] Failed to acknowledge command:`, err);
    }
  }

  /**
   * Handle commands.changed event — refresh the cached command list.
   */
  private handleCommandsChanged(
    sessionId: string,
    data: { commands: Array<{ name: string; description?: string }> },
  ): void {
    if (Array.isArray(data?.commands)) {
      this.cachedCommands = data.commands.map(cmd => ({
        name: cmd.name,
        description: cmd.description ?? "",
      }));
      this.emit("commands.changed", {
        engineType: this.engineType,
        commands: this.cachedCommands,
      });
      copilotLog.info(
        `[Copilot][${sessionId}] Commands updated: ${this.cachedCommands.length} commands`,
      );
    }
  }

  /**
   * Handle session.skills_loaded event — the Copilot CLI emits this when
   * skills are loaded or reloaded from disk. Update cached commands from
   * the skills data.
   */
  private handleSkillsLoaded(
    sessionId: string,
    data: { skills: Array<{ name: string; description?: string; userInvocable?: boolean; source?: string }> },
  ): void {
    if (Array.isArray(data?.skills)) {
      this.cachedCommands = data.skills
        .filter((s) => s.userInvocable !== false)
        .map((s) => ({
          name: s.name,
          description: s.description ?? "",
          source: s.source,
          userInvocable: s.userInvocable,
        }));
      this.emit("commands.changed", {
        engineType: this.engineType,
        commands: this.cachedCommands,
      });
      copilotLog.info(
        `[Copilot][${sessionId}] Skills loaded: ${this.cachedCommands.length} skills`,
      );
    }
  }

  private setStatus(status: EngineStatus, error?: string): void {
    this.status = status;
    this.lastError = error;
    this.emit("status.changed", { engineType: this.engineType, status, error });
  }

  private isSessionExpiredError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      msg.includes("Session not found") ||
      msg.includes("connection") ||
      msg.includes("disposed") ||
      msg.includes("closed") ||
      msg.includes("EPIPE") ||
      msg.includes("not running")
    );
  }

  /** Remove a stale session from runtime state (activeSessions, event subs). */
  private evictStaleSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
    const unsub = this.sessionUnsubscribers.get(sessionId);
    if (unsub) unsub();
    this.sessionUnsubscribers.delete(sessionId);
  }

  /** Clear all cached sessions (e.g. after CLI reconnect). */
  private evictAllSessions(): void {
    for (const unsub of this.sessionUnsubscribers.values()) {
      try { unsub(); } catch {}
    }
    this.activeSessions.clear();
    this.sessionUnsubscribers.clear();
  }

  private ensureClient(): void {
    if (!this.client || this.status !== "running") throw new Error("Copilot SDK adapter is not running");
  }

  private async ensureActiveSession(sessionId: string, directory?: string): Promise<CopilotSession> {
    // If client reconnected (e.g. CLI restarted), cached sessions are stale
    const clientState = this.client?.getState?.();
    if (clientState && clientState !== "connected") {
      copilotLog.warn(`Client state is "${clientState}", clearing all cached sessions`);
      this.evictAllSessions();
    }

    const existing = this.activeSessions.get(sessionId);
    if (existing) return existing;
    this.ensureClient();

    const workingDirectory = directory || this.sessionDirectories.get(sessionId);
    const config: ResumeSessionConfig = {
      streaming: true,
      workingDirectory,
      model: this.currentModelId ?? undefined,
      systemMessage: { mode: "append" as const, content: CODEMUX_IDENTITY_PROMPT },
      onPermissionRequest: (req, ctx) => this.handlePermissionRequest(req as any, ctx),
      onUserInputRequest: (req, ctx) => this.handleUserInputRequest(req as any, ctx),
    };

    copilotLog.info(`Resuming session ${sessionId}...`);
    try {
      const sdkSession = await this.client!.resumeSession(sessionId, config);
      copilotLog.info(`Session ${sessionId} resumed successfully`);
      this.subscribeToSessionEvents(sdkSession);
      this.activeSessions.set(sessionId, sdkSession);
      if (workingDirectory) this.sessionDirectories.set(sessionId, workingDirectory);
      return sdkSession;
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.includes("not found") || msg.includes("Not found") || msg.includes("no such session")) {
        copilotLog.warn(`Session ${sessionId} not found on resume, creating new session`);
        const newConfig: SessionConfig = {
          streaming: true,
          workingDirectory,
          model: this.currentModelId ?? undefined,
          systemMessage: { mode: "append" as const, content: CODEMUX_IDENTITY_PROMPT },
          onPermissionRequest: (req, ctx) => this.handlePermissionRequest(req as any, ctx),
          onUserInputRequest: (req, ctx) => this.handleUserInputRequest(req as any, ctx),
        };
        const newSession = await this.client!.createSession(newConfig);
        this.subscribeToSessionEvents(newSession);
        this.activeSessions.set(sessionId, newSession);
        if (workingDirectory) this.sessionDirectories.set(sessionId, workingDirectory);
        return newSession;
      }
      throw err;
    }
  }

  private subscribeToSessionEvents(session: CopilotSession, eventSessionId?: string): void {
    const sessionId = eventSessionId || session.sessionId;
    const oldUnsub = this.sessionUnsubscribers.get(sessionId);
    if (oldUnsub) oldUnsub();
    const unsub = session.on((event: SessionEvent) => this.handleSessionEvent(sessionId, event));
    this.sessionUnsubscribers.set(sessionId, unsub);
  }

  private handleSessionEvent(sessionId: string, event: SessionEvent): void {
    try {
      copilotLog.debug(`[Copilot][${sessionId}] SessionEvent: type=${event.type}`);
      switch (event.type) {
        case "assistant.message_delta": this.handleMessageDelta(sessionId, event.data as any); break;
        case "assistant.reasoning_delta": this.handleReasoningDelta(sessionId, event.data as any); break;
        case "assistant.message": this.handleAssistantMessage(sessionId, event.data as any); break;
        case "tool.execution_start": this.handleToolStart(sessionId, event.data as any); break;
        case "tool.execution_complete": this.handleToolComplete(sessionId, event.data as any); break;
        case "tool.execution_partial_result": this.handleToolPartialResult(sessionId, event.data as any); break;
        case "assistant.turn_start": this.handleTurnStart(sessionId, event.data as any); break;
        case "assistant.turn_end": this.handleTurnEnd(sessionId, event.data as any); break;
        case "session.idle": this.handleSessionIdle(sessionId); break;
        case "session.title_changed": this.handleTitleChanged(sessionId, event.data as any); break;
        case "session.error": this.handleSessionError(sessionId, event.data as any); break;
        case "session.model_change": this.handleModelChange(sessionId, event.data as any); break;
        case "session.mode_changed": this.handleModeChanged(sessionId, event.data as any); break;
        case "assistant.usage": this.handleUsage(sessionId, event.data as any); break;
        case "abort": this.handleAbort(sessionId, event.data as any); break;
        case "subagent.started": this.handleSubagentStarted(sessionId, event.data as any); break;
        case "subagent.completed": this.handleSubagentCompleted(sessionId, event.data as any); break;

        // --- Slash Command events ---
        case "command.execute":
          this.handleCommandExecute(sessionId, event.data as any);
          break;
        case "command.completed":
          // Command completed — no action needed on our side
          copilotLog.info(`[Copilot][${sessionId}] Command completed: requestId=${(event.data as any)?.requestId}`);
          break;
        case "commands.changed":
          this.handleCommandsChanged(sessionId, event.data as any);
          break;
        case "session.skills_loaded":
          // Skills loaded/reloaded — refresh command list from the event data
          this.handleSkillsLoaded(sessionId, event.data as any);
          break;
      }
    } catch (err) {
      copilotLog.warn(`Error handling session event for session ${sessionId}:`, err);
    }
  }

  private handleMessageDelta(sessionId: string, data: { deltaContent: string }): void {
    const buffer = this.getOrCreateBuffer(sessionId);
    buffer.textAccumulator += data.deltaContent;

    // Trim leading whitespace from the first text content. Some models send
    // initial deltas with newlines/whitespace before the actual response,
    // which would render as empty lines at the top of the message.
    if (!buffer.leadingTrimmed) {
      const trimmed = buffer.textAccumulator.trimStart();
      if (!trimmed) return; // All whitespace so far — buffer but don't emit
      buffer.textAccumulator = trimmed;
      buffer.leadingTrimmed = true;
    }

    if (!buffer.textPartId) buffer.textPartId = timeId("part");
    const textPart: TextPart = { id: buffer.textPartId, messageId: buffer.messageId, sessionId, type: "text", text: buffer.textAccumulator };
    upsertPart(buffer.parts, textPart);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: textPart });
  }

  private handleReasoningDelta(sessionId: string, data: { deltaContent: string }): void {
    const buffer = this.getOrCreateBuffer(sessionId);
    buffer.reasoningAccumulator += data.deltaContent;
    if (!buffer.reasoningPartId) buffer.reasoningPartId = timeId("part");
    const reasoningPart: any = { id: buffer.reasoningPartId, messageId: buffer.messageId, sessionId, type: "reasoning", text: buffer.reasoningAccumulator };
    upsertPart(buffer.parts, reasoningPart);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: reasoningPart });
  }

  private handleAssistantMessage(sessionId: string, data: { content?: string }): void {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer && data.content) {
      const newBuffer = this.getOrCreateBuffer(sessionId);
      newBuffer.textAccumulator = data.content;
      if (!newBuffer.textPartId) newBuffer.textPartId = timeId("part");
      const textPart: TextPart = { id: newBuffer.textPartId, messageId: newBuffer.messageId, sessionId, type: "text", text: data.content };
      upsertPart(newBuffer.parts, textPart);
      this.emit("message.part.updated", { sessionId, messageId: newBuffer.messageId, part: textPart });
    }
  }

  private handleToolStart(sessionId: string, data: { toolCallId: string; toolName: string; arguments?: any }): void {
    const buffer = this.getOrCreateBuffer(sessionId);
    this.flushTextAccumulator(buffer, sessionId);

    if (data.toolName === "task_complete") {
      const summary = data.arguments?.summary || "";
      this.taskCompleteCallIds.add(data.toolCallId);
      if (summary) {
        buffer.textAccumulator += summary;
        if (!buffer.textPartId) buffer.textPartId = timeId("part");
        const textPart: TextPart = { id: buffer.textPartId, messageId: buffer.messageId, sessionId, type: "text", text: buffer.textAccumulator };
        upsertPart(buffer.parts, textPart);
        this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: textPart });
      }
      return;
    }

    const normalizedTool = normalizeToolName("copilot", data.toolName);
    const sqlQuery = data.arguments?.query || "";
    if (normalizedTool === "sql" && /\btodos\b/i.test(sqlQuery)) {
      this.applySqlTodoChanges(sessionId, sqlQuery);
      this.emitTodoPart(sessionId, buffer, data.toolCallId, "running");
      return;
    }

    const toolPart: ToolPart = {
      id: timeId("part"),
      messageId: buffer.messageId,
      sessionId,
      type: "tool",
      callId: data.toolCallId,
      normalizedTool,
      originalTool: data.toolName,
      title: buildToolTitle(data.toolName, normalizedTool, data.arguments),
      kind: inferToolKind(undefined, normalizedTool),
      state: {
        status: "running",
        input: normalizedTool === "todo" ? normalizeTodoInput(data.arguments) : (data.arguments || {}),
        time: { start: Date.now() },
      },
    };
    this.toolCallParts.set(data.toolCallId, toolPart);
    buffer.parts.push(toolPart);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: toolPart });
  }

  private handleToolComplete(sessionId: string, data: { toolCallId: string; success: boolean; result?: any; error?: any }): void {
    if (this.taskCompleteCallIds.has(data.toolCallId)) {
      this.taskCompleteCallIds.delete(data.toolCallId);
      return;
    }
    const toolPart = this.toolCallParts.get(data.toolCallId);
    if (!toolPart) {
      const buffer = this.messageBuffers.get(sessionId);
      if (buffer) this.emitTodoPart(sessionId, buffer, data.toolCallId, "completed");
      return;
    }
    const now = Date.now();
    const startTime = (toolPart.state as any).time?.start || now;
    const output = data.result?.content || data.error?.message || "";
    if (data.success) {
      toolPart.state = { status: "completed", input: toolPart.state.input, output, time: { start: startTime, end: now, duration: now - startTime } };
    } else {
      toolPart.state = { status: "error", input: toolPart.state.input, output, error: data.error?.message || "Failed", time: { start: startTime, end: now, duration: now - startTime } };
    }
    if (data.result?.detailedContent) toolPart.diff = data.result.detailedContent;
    const buffer = this.messageBuffers.get(sessionId);
    if (buffer) upsertPart(buffer.parts, toolPart);
    this.emit("message.part.updated", { sessionId, messageId: toolPart.messageId, part: toolPart });
    this.toolCallParts.delete(data.toolCallId);
  }

  private handleToolPartialResult(sessionId: string, data: { toolCallId: string }): void {
    const toolPart = this.toolCallParts.get(data.toolCallId);
    if (toolPart) this.emit("message.part.updated", { sessionId, messageId: toolPart.messageId, part: toolPart });
  }

  private handleTurnStart(sessionId: string, _data: any): void {
    const buffer = this.getOrCreateBuffer(sessionId);
    const stepStartPart: any = { id: timeId("part"), messageId: buffer.messageId, sessionId, type: "step-start" };
    buffer.parts.push(stepStartPart);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: stepStartPart });
  }

  private handleTurnEnd(sessionId: string, _data: any): void {
    const buffer = this.getOrCreateBuffer(sessionId);
    this.flushTextAccumulator(buffer, sessionId);
    const stepFinishPart: any = { id: timeId("part"), messageId: buffer.messageId, sessionId, type: "step-finish" };
    buffer.parts.push(stepFinishPart);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: stepFinishPart });
  }

  private handleSessionIdle(sessionId: string): void {
    const finalMessage = this.finalizeBuffer(sessionId);
    if (finalMessage) {
      const resolvers = this.idleResolvers.get(sessionId);
      if (resolvers && resolvers.length > 0) {
        // Copilot CLI processes all enqueued messages in a single turn —
        // session.idle fires only ONCE after all are done. Resolve ALL resolvers
        // with the final message (the combined response).
        this.idleResolvers.delete(sessionId);
        for (const r of resolvers) r(finalMessage);

        // Clear all deferred user messages and emit queued.consumed for each
        // remaining queued item so the frontend clears its queue preview.
        // Also emit message.updated for each deferred user message so the frontend
        // creates the user bubble (the enqueue path doesn't create an optimistic
        // temp message — it stores the text in a preview queue instead).
        const pendingUsers = this.pendingUserMessages.get(sessionId);
        if (pendingUsers && pendingUsers.length > 0) {
          for (const userMsg of pendingUsers) {
            this.emit("message.queued.consumed", { sessionId, messageId: userMsg.id });
            this.emit("message.updated", { sessionId, message: userMsg });
          }
        }
        this.pendingUserMessages.delete(sessionId);
      }
    }
  }

  private handleTitleChanged(sessionId: string, data: { title?: string }): void {
    if (data.title) this.emit("session.updated", { session: { id: sessionId, engineType: this.engineType, title: data.title } });
  }

  private handleSessionError(sessionId: string, data: { message?: string }): void {
    const buffer = this.messageBuffers.get(sessionId);
    if (buffer) {
      buffer.error = data.message || "Unknown error";
      const finalMessage = this.finalizeBuffer(sessionId);
      if (finalMessage) {
        const resolver = this.idleResolvers.get(sessionId);
        if (resolver) { this.idleResolvers.delete(sessionId); for (const r of resolver) r(finalMessage); }
      }
    }
    this.pendingUserMessages.delete(sessionId);
  }

  private handleModelChange(sessionId: string, data: { newModel?: string }): void { if (data.newModel) this.currentModelId = data.newModel; }
  private handleModeChanged(sessionId: string, data: { newMode?: string }): void { if (data.newMode) this.sessionModes.set(sessionId, data.newMode); }

  private handleUsage(sessionId: string, data: any): void {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return;
    const input = data.inputTokens || 0;
    const output = data.outputTokens || 0;
    const cacheRead = data.cacheReadTokens || 0;
    const cacheWrite = data.cacheWriteTokens || 0;
    buffer.tokens = { input, output, cache: cacheRead || cacheWrite ? { read: cacheRead, write: cacheWrite } : undefined };
    // Copilot's `cost` is premium-request count (not USD)
    if (data.cost != null) {
      buffer.cost = data.cost;
      buffer.costUnit = "premium_requests";
    }
    if (data.model) buffer.modelId = data.model;
  }

  private handleAbort(sessionId: string, _data: any): void {
    const finalMessage = this.finalizeBuffer(sessionId);
    if (finalMessage) {
      const resolver = this.idleResolvers.get(sessionId);
      if (resolver) { this.idleResolvers.delete(sessionId); for (const r of resolver) r(finalMessage); }
    }
    this.pendingUserMessages.delete(sessionId);
  }

  private handleSubagentStarted(sessionId: string, data: any): void {
    const buffer = this.getOrCreateBuffer(sessionId);
    this.flushTextAccumulator(buffer, sessionId);
    const toolPart: ToolPart = {
      id: timeId("part"), messageId: buffer.messageId, sessionId, type: "tool", callId: data.toolCallId, normalizedTool: "task", originalTool: data.agentName,
      title: data.agentDisplayName || data.agentName, kind: "other",
      state: { status: "running", input: { agentName: data.agentName, description: data.agentDescription }, time: { start: Date.now() } },
    };
    this.toolCallParts.set(data.toolCallId, toolPart);
    buffer.parts.push(toolPart);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: toolPart });
  }

  private handleSubagentCompleted(sessionId: string, data: any): void {
    const toolPart = this.toolCallParts.get(data.toolCallId);
    if (!toolPart) return;
    const now = Date.now();
    const startTime = (toolPart.state as any).time?.start || now;
    toolPart.state = { status: "completed", input: toolPart.state.input, output: `Subagent ${data.agentDisplayName || data.agentName} completed`, time: { start: startTime, end: now, duration: now - startTime } };
    const buffer = this.messageBuffers.get(sessionId);
    if (buffer) upsertPart(buffer.parts, toolPart);
    this.emit("message.part.updated", { sessionId, messageId: toolPart.messageId, part: toolPart });
    this.toolCallParts.delete(data.toolCallId);
  }

  private handlePermissionRequest(req: PermissionRequest, ctx: { sessionId: string }): Promise<PermissionRequestResult> {
    const sessionId = ctx.sessionId;
    if ((this.sessionModes.get(sessionId) || "autopilot") === "autopilot") return Promise.resolve({ kind: "approved" });
    if (this.allowedAlwaysKinds.has(req.kind)) return Promise.resolve({ kind: "approved" });

    const permissionId = timeId("perm");
    const kind: any = req.kind === "read" ? "read" : req.kind === "write" || req.kind === "shell" ? "edit" : "other";
    const options: PermissionOption[] = [
      { id: "allow_once", label: "Allow Once", type: "allow_once" },
      { id: "allow_always", label: "Always Allow", type: "allow_always" },
      { id: "reject_once", label: "Deny", type: "reject_once" },
    ];

    const permission: UnifiedPermission = { id: permissionId, sessionId, engineType: this.engineType, toolCallId: req.toolCallId, title: req.title || `${req.kind} permission requested`, kind, diff: req.diff, rawInput: { ...req }, options };

    return new Promise<PermissionRequestResult>((resolve) => {
      this.pendingPermissions.set(permissionId, { resolve, permission });
      this.emit("permission.asked", { permission });
    });
  }

  private handleUserInputRequest(req: UserInputRequest, ctx: { sessionId: string }): Promise<UserInputResponse> {
    const questionId = timeId("q");
    const sessionId = ctx.sessionId;
    const question: UnifiedQuestion = { id: questionId, sessionId, engineType: this.engineType, questions: [{ question: req.question, header: req.question.length > 30 ? req.question.slice(0, 27) + "..." : req.question, options: (req.choices || []).map(c => ({ label: c, description: "" })), multiple: false, custom: req.allowFreeform ?? true }] };
    return new Promise<UserInputResponse>((resolve) => {
      this.pendingQuestions.set(questionId, { resolve, question });
      this.emit("question.asked", { question });
    });
  }

  private getOrCreateBuffer(sessionId: string): MessageBuffer {
    let buffer = this.messageBuffers.get(sessionId);
    if (!buffer) { buffer = { messageId: timeId("msg"), sessionId, parts: [], textAccumulator: "", textPartId: null, reasoningAccumulator: "", reasoningPartId: null, startTime: Date.now() }; this.messageBuffers.set(sessionId, buffer); }
    return buffer;
  }

  private flushTextAccumulator(buffer: MessageBuffer, sessionId: string): void {
    if (buffer.textAccumulator && buffer.textPartId) {
      const textPart: TextPart = { id: buffer.textPartId, messageId: buffer.messageId, sessionId, type: "text", text: buffer.textAccumulator };
      upsertPart(buffer.parts, textPart);
      buffer.textAccumulator = ""; buffer.textPartId = null;
    }
  }

  private finalizeBuffer(sessionId: string): UnifiedMessage | null {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return null;
    this.flushTextAccumulator(buffer, sessionId);
    const message = this.bufferToMessage(buffer, true);
    this.appendMessageToHistory(sessionId, message);
    this.emit("message.updated", { sessionId, message });
    this.messageBuffers.delete(sessionId);
    return message;
  }

  private bufferToMessage(buffer: MessageBuffer, completed: boolean): UnifiedMessage {
    return { id: buffer.messageId, sessionId: buffer.sessionId, role: "assistant", time: { created: buffer.startTime, completed: completed ? Date.now() : undefined }, parts: [...buffer.parts], tokens: buffer.tokens, cost: buffer.cost, costUnit: buffer.costUnit, modelId: buffer.modelId || this.currentModelId || undefined, error: buffer.error, workingDirectory: this.sessionDirectories.get(buffer.sessionId) };
  }

  private appendMessageToHistory(sessionId: string, message: UnifiedMessage): void {
    let history = this.messageHistory.get(sessionId);
    if (!history) { history = []; this.messageHistory.set(sessionId, history); }
    const idx = history.findIndex((m) => m.id === message.id);
    if (idx >= 0) history[idx] = message; else history.push(message);
  }

  private applySqlTodoChanges(sessionId: string, sql: string): void {
    let todos = this.sessionTodos.get(sessionId);
    if (!todos) { todos = new Map(); this.sessionTodos.set(sessionId, todos); }
    const insertPattern = /INSERT\s+INTO\s+todos\b[^)]*\)\s*VALUES\s*([\s\S]+?)(?:;|$)/gi;
    let m: any;
    while ((m = insertPattern.exec(sql)) !== null) {
      const rowPattern = /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g;
      let rm: any;
      while ((rm = rowPattern.exec(m[1])) !== null) todos.set(rm[1], { id: rm[1], title: rm[2], status: rm[3] });
    }
    const updatePattern = /UPDATE\s+todos\s+SET\s+status\s*=\s*'([^']+)'(?:\s+WHERE\s+id\s+(?:IN\s*\(([^)]+)\)|=\s*'([^']+)'))?/gi;
    while ((m = updatePattern.exec(sql)) !== null) {
      const status = m[1], inList = m[2], singleId = m[3];
      if (inList) { const ids = [...inList.matchAll(/'([^']+)'/g)].map((im: any) => im[1]); for (const id of ids) { const e = todos.get(id); if (e) e.status = status; } }
      else if (singleId) { const e = todos.get(singleId); if (e) e.status = status; }
      else { for (const t of todos.values()) t.status = status; }
    }
  }

  private getTodosArray(sessionId: string): Array<{ content: string; status: any }> {
    const todos = this.sessionTodos.get(sessionId);
    if (!todos || todos.size === 0) return [];
    return [...todos.values()].map((t) => ({ content: t.title, status: normalizeTodoStatus(t.status) }));
  }

  private emitTodoPart(sessionId: string, buffer: MessageBuffer, toolCallId: string, status: "running" | "completed"): void {
    const todos = this.getTodosArray(sessionId);
    if (todos.length === 0) return;
    let todoPart = buffer.parts.find((p) => p.type === "tool" && (p as ToolPart).normalizedTool === "todo") as ToolPart | undefined;
    const now = Date.now(), startTime = todoPart ? ((todoPart.state as any).time?.start || now) : now;
    const newState = status === "completed" ? { status: "completed" as const, input: { todos }, output: "", time: { start: startTime, end: now, duration: now - startTime } } : { status: "running" as const, input: { todos }, time: { start: startTime } };
    if (todoPart) todoPart.state = newState;
    else { todoPart = { id: timeId("part"), messageId: buffer.messageId, sessionId, type: "tool", callId: `todo-synthetic-${toolCallId}`, normalizedTool: "todo", originalTool: "sql", title: "Todo", kind: "other", state: newState }; buffer.parts.push(todoPart); }
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: todoPart });
  }

  private rejectAllPendingPermissions(_reason: string): void {
    for (const [_id, pending] of this.pendingPermissions) pending.resolve({ kind: "denied-no-approval-rule-and-could-not-request-from-user" });
    this.pendingPermissions.clear();
  }

  private rejectAllPendingQuestions(_reason: string): void {
    for (const [_id, pending] of this.pendingQuestions) pending.resolve({ answer: "", wasFreeform: true });
    this.pendingQuestions.clear();
  }
}
