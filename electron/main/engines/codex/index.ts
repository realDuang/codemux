import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";

import type {
  AgentMode,
  AuthMethod,
  CodexServiceTier,
  CommandInvokeResult,
  EngineCapabilities,
  EngineCommand,
  EngineInfo,
  EngineStatus,
  EngineType,
  MessagePromptContent,
  ModelListResult,
  PermissionReply,
  ReasoningEffort,
  ToolPart,
  UnifiedMessage,
  UnifiedModelInfo,
  UnifiedPermission,
  UnifiedProject,
  UnifiedQuestion,
  UnifiedSession,
  ImportableSession,
} from "../../../../src/types/unified";
import { isCodexServiceTier } from "../../../../src/types/unified";
import { EngineAdapter, type MessageBuffer } from "../engine-adapter";
import { CODEMUX_IDENTITY_PROMPT } from "../identity-prompt";
import { timeId } from "../../utils/id-gen";
import { codexLog } from "../../services/logger";
import { CodexJsonRpcClient } from "./jsonrpc-client";
import {
  CODEX_FALLBACK_MODEL,
  CODEX_MODES,
  type CodexApprovalPolicy,
  type CodexConfigRequirements,
  type CodexSandboxMode,
  type CodexSandboxPolicy,
  buildStartupArgs,
  clampApprovalPolicy,
  clampSandboxMode,
  clampSandboxPolicy,
  fromCodexEffort,
  modeToApprovalPolicy,
  modeToSandboxMode,
  modeToSandboxPolicy,
  normalizeDirectory,
  resolveCodexCliPath,
  resolveCodexCliVersion,
  sandboxModeFromPolicy,
  toCodexEffort,
} from "./config";
import {
  appendPlanDelta,
  appendReasoningDelta,
  appendTextDelta,
  applyTurnMetadata,
  applyTurnUsage,
  completeToolPart,
  convertApprovalToPermission,
  convertThreadToMessages,
  convertUserInputToQuestion,
  createStepFinish,
  createSystemNotice,
  createToolPart,
  createUserMessage,
  finalizeBufferToMessage,
  formatTurnPlanMarkdown,
  replacePlanText,
  upsertPart,
} from "./converters";

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const START_TIMEOUT_MS = 120_000;
const DEFAULT_MODE_ID = "default";
const MAX_IMAGE_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/**
 * Read the `model_provider` field from `~/.codex/config.toml`.
 * Uses simple line parsing to avoid a TOML dependency.
 */
function readCodexModelProvider(): string | undefined {
  try {
    const configPath = join(homedir(), ".codex", "config.toml");
    if (!existsSync(configPath)) return undefined;
    const content = readFileSync(configPath, "utf-8");
    // Match top-level `model_provider = "..."` (before any [section] header)
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) break; // entered a section
      const match = trimmed.match(/^model_provider\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    }
  } catch (err) {
    codexLog.warn("[Codex] Failed to read ~/.codex/config.toml:", err);
  }
  return undefined;
}

type CodexTurnInput =
  | { type: "text"; text: string; text_elements: unknown[] }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string };

interface ThreadInfo {
  threadId: string;
  directory: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  title?: string;
  loaded: boolean;
}

interface SendResolver {
  resolve: (msg: UnifiedMessage) => void;
  reject: (err: Error) => void;
}

interface QueuedMessage {
  input: CodexTurnInput[];
  userMessage: UnifiedMessage;
  tempDirs: string[];
  options?: {
    mode?: string;
    modelId?: string;
    reasoningEffort?: ReasoningEffort | null;
    serviceTier?: CodexServiceTier | null;
    directory?: string;
  };
  resolver: SendResolver;
}

interface PendingPermission {
  requestId: number | string;
  sessionId: string;
  method: string;
  params: unknown;
  permission: UnifiedPermission;
}

interface PendingQuestion {
  requestId: number | string;
  sessionId: string;
  params: unknown;
  question: UnifiedQuestion;
}

interface SkillEntry {
  name: string;
  description: string;
  path: string;
  scope?: string;
  enabled: boolean;
}

interface ThreadResponse {
  thread?: {
    id?: string;
    cwd?: string;
    createdAt?: number | string;
    updatedAt?: number | string;
    name?: string | null;
    preview?: string;
  };
  cwd?: string;
  model?: string;
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandboxPolicy;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
}

interface TurnResponse {
  turn?: {
    id?: string;
    status?: string;
  };
  turnId?: string;
}

export class CodexAdapter extends EngineAdapter {
  readonly engineType: EngineType = "codex";

  private client: CodexJsonRpcClient | null = null;
  private status: EngineStatus = "stopped";
  private cliPath: string | undefined;
  private version: string | undefined;
  private lastError: string | undefined;
  private authenticated: boolean | undefined;
  private authMessage: string | undefined;
  private authType: "chatgpt" | "apiKey" | undefined;
  private startPromise: Promise<void> | null = null;

  private sessionToThread = new Map<string, string>();
  private threadToSession = new Map<string, string>();
  private threads = new Map<string, ThreadInfo>();

  private messageBuffers = new Map<string, MessageBuffer>();
  private messageHistory = new Map<string, UnifiedMessage[]>();
  private turnResolvers = new Map<string, SendResolver[]>();
  private messageQueues = new Map<string, QueuedMessage[]>();
  private activeTurnIds = new Map<string, string>();
  private activeToolParts = new Map<string, ToolPart>();
  private activeTempDirs = new Map<string, string[]>();

  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingQuestions = new Map<string, PendingQuestion>();

  private sessionModes = new Map<string, string>();
  private sessionModels = new Map<string, string>();
  private sessionReasoningEfforts = new Map<string, ReasoningEffort>();
  private sessionServiceTiers = new Map<string, CodexServiceTier>();
  private sessionDirectories = new Map<string, string>();
  /** Custom system prompts per session (e.g. orchestration instructions for agent team) */
  private sessionSystemPrompts = new Map<string, string>();

  private currentModelId: string = CODEX_FALLBACK_MODEL;
  private currentMode: string = DEFAULT_MODE_ID;
  private cachedModels: UnifiedModelInfo[] = [];
  private configRequirements: CodexConfigRequirements | null = null;

  private skillsByDirectory = new Map<string, EngineCommand[]>();
  private skillEntriesByDirectory = new Map<string, Map<string, SkillEntry>>();

  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    if (this.status === "running" && this.client?.running) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    this.setStatus("starting");

    try {
      this.cliPath = resolveCodexCliPath();
      if (!this.cliPath) {
        throw new Error("Codex CLI not found. Install `codex` and ensure it is in PATH.");
      }

      this.version = resolveCodexCliVersion(this.cliPath);

      await this.spawnAndInitialize();
      await this.refreshRuntimeMetadata();

      this.startSessionCleanup();
      this.setStatus("running");
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : "Failed to start Codex adapter.";
      throw this.failStart(message);
    }
  }

  async stop(): Promise<void> {
    this.stopSessionCleanup();
    this.rejectPendingInteractions("Adapter stopped");
    this.rejectQueuedMessages("Adapter stopped");
    this.failAllInFlight("Adapter stopped");

    if (this.client) {
      try {
        await this.client.stop();
      } catch (error) {
        codexLog.warn("Failed to stop Codex client cleanly:", error);
      }
      this.client = null;
    }

    this.activeTurnIds.clear();
    this.activeToolParts.clear();
    this.cleanupActiveTempDirs();

    this.setStatus("stopped");
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
      customModelInput: true,
      messageEnqueue: true,
      slashCommands: true,
      fastModeSupported: this.authenticated === true,
      availableModes: this.getModes(),
    };
  }

  getAuthMethods(): AuthMethod[] {
    return [{
      id: "openai",
      name: "OpenAI",
      description: "Use Codex's existing OpenAI login or API key configuration.",
    }];
  }

  hasSession(sessionId: string): boolean {
    return this.sessionToThread.has(sessionId) && this.client?.running === true;
  }

  async listSessions(directory?: string): Promise<UnifiedSession[]> {
    const sessions: UnifiedSession[] = [];

    for (const [sessionId, threadId] of this.sessionToThread) {
      const thread = this.threads.get(threadId);
      if (!thread) continue;
      if (directory && normalizeDirectory(directory) !== thread.directory) continue;

      sessions.push({
        id: sessionId,
        engineType: this.engineType,
        directory: thread.directory,
        title: thread.title,
        time: {
          created: thread.createdAt,
          updated: thread.updatedAt,
        },
        engineMeta: { codexThreadId: threadId },
      });
    }

    return sessions;
  }

  async createSession(directory: string, meta?: Record<string, unknown>): Promise<UnifiedSession> {
    await this.start();

    const normalizedDirectory = normalizeDirectory(directory);
    const customSystemPrompt = (meta?.systemPrompt && typeof meta.systemPrompt === "string") ? meta.systemPrompt : undefined;
    const existingThreadId = resolveThreadId(undefined, meta);
    let threadResponse: ThreadResponse;
    if (existingThreadId) {
      try {
        threadResponse = await this.resumeThread(existingThreadId, normalizedDirectory, customSystemPrompt);
      } catch (error) {
        codexLog.warn(`Failed to resume Codex thread ${existingThreadId}, starting a new one instead:`, error);
        threadResponse = await this.startThread(normalizedDirectory, customSystemPrompt);
      }
    } else {
      threadResponse = await this.startThread(normalizedDirectory, customSystemPrompt);
    }

    const threadId = threadResponse.thread?.id;
    if (!threadId) {
      throw new Error("Codex did not return a thread ID");
    }

    const sessionId = toEngineSessionId(threadId);
    this.registerThread(sessionId, threadId, normalizedDirectory, threadResponse.thread?.name ?? undefined, true, threadResponse.thread?.createdAt, threadResponse.thread?.updatedAt);

    if (!this.sessionModes.has(sessionId)) {
      this.sessionModes.set(sessionId, this.currentMode);
    }
    if (!this.sessionDirectories.has(sessionId)) {
      this.sessionDirectories.set(sessionId, normalizedDirectory);
    }
    if (customSystemPrompt) {
      this.sessionSystemPrompts.set(sessionId, customSystemPrompt);
    }
    if (threadResponse.model) {
      this.sessionModels.set(sessionId, threadResponse.model);
      this.currentModelId = threadResponse.model;
    }
    if (threadResponse.reasoningEffort) {
      const effort = fromCodexEffort(threadResponse.reasoningEffort);
      if (effort) this.sessionReasoningEfforts.set(sessionId, effort);
    }
    if (threadResponse.serviceTier === "fast" || threadResponse.serviceTier === "flex") {
      this.sessionServiceTiers.set(sessionId, threadResponse.serviceTier);
    }

    if (threadResponse.thread?.name) {
      setTimeout(() => {
        this.emit("session.updated", {
          session: {
            id: sessionId,
            engineType: this.engineType,
            title: threadResponse.thread?.name ?? undefined,
          },
        });
      }, 0);
    }

    this.refreshCommandsForDirectory(normalizedDirectory).catch((error) => {
      codexLog.warn(`Failed to refresh skills for ${normalizedDirectory}:`, error);
    });

    return {
      id: sessionId,
      engineType: this.engineType,
      directory: normalizedDirectory,
      title: threadResponse.thread?.name ?? undefined,
      time: {
        created: toMillis(threadResponse.thread?.createdAt, Date.now()),
        updated: toMillis(threadResponse.thread?.updatedAt, Date.now()),
      },
      engineMeta: { codexThreadId: threadId },
    };
  }

  async getSession(sessionId: string): Promise<UnifiedSession | null> {
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId) return null;
    const thread = this.threads.get(threadId);
    if (!thread) return null;

    return {
      id: sessionId,
      engineType: this.engineType,
      directory: thread.directory,
      title: thread.title,
      time: {
        created: thread.createdAt,
        updated: thread.updatedAt,
      },
      engineMeta: { codexThreadId: threadId },
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const threadId = this.sessionToThread.get(sessionId);
    if (threadId && this.client?.running) {
      try {
        await this.client.request("thread/unsubscribe", { threadId });
      } catch (error) {
        codexLog.warn(`Failed to unsubscribe thread ${threadId}:`, error);
      }
    }

    this.clearSessionState(sessionId);
  }

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: {
      mode?: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: CodexServiceTier | null;
      directory?: string;
    },
  ): Promise<UnifiedMessage> {
    const prepared = this.buildPromptInput(content);
    const userMessage = createUserMessage(sessionId, prepared.displayText);
    const directory = normalizeDirectory(options?.directory ?? this.sessionDirectories.get(sessionId) ?? this.threads.get(this.sessionToThread.get(sessionId) ?? "")?.directory ?? "");
    if (!directory) {
      this.cleanupTempDirs(prepared.tempDirs);
      throw new Error(`No working directory found for Codex session ${sessionId}`);
    }

    this.sessionDirectories.set(sessionId, directory);

    if (this.hasActiveTurn(sessionId)) {
      if (this.canSteer(sessionId, options, directory)) {
        return this.steerTurn(sessionId, prepared.input, userMessage, prepared.tempDirs, options);
      }

      return this.enqueueMessage(sessionId, prepared.input, userMessage, prepared.tempDirs, options);
    }

    return this.startPreparedTurn(sessionId, prepared.input, userMessage, prepared.tempDirs, options, false);
  }

  async cancelMessage(sessionId: string, directory?: string): Promise<void> {
    const threadId = this.sessionToThread.get(sessionId);
    const turnId = this.activeTurnIds.get(sessionId);
    if (threadId && turnId && this.client?.running) {
      try {
        await this.client.request("turn/interrupt", { threadId, turnId });
      } catch (error) {
        codexLog.warn(`Failed to interrupt turn ${turnId}:`, error);
      }
    }

    this.failActiveTurn(sessionId, "Cancelled", false);
    this.rejectQueuedMessagesForSession(sessionId, "Cancelled");
    this.rejectPendingForSession(sessionId, "Cancelled");

    if (directory) {
      this.sessionDirectories.set(sessionId, normalizeDirectory(directory));
    }
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    return [...(this.messageHistory.get(sessionId) ?? [])];
  }

  async listHistoricalSessions(limit: number): Promise<ImportableSession[]> {
    try {
      await this.start();
    } catch {
      return [];
    }

    if (!this.client?.running) return [];

    const sessions: ImportableSession[] = [];
    let cursor: string | null | undefined;

    do {
      const response = asRecord(await this.client.request("thread/list", {
        cursor,
        limit: limit > 0 ? Math.min(limit, 100) : 100,
        sortKey: "updated_at",
        archived: false,
      }));

      const data = Array.isArray(response.data) ? response.data : [];
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;

      for (const entry of data) {
        const thread = asRecord(entry);
        const threadId = typeof thread.id === "string" ? thread.id : undefined;
        if (!threadId) continue;

        sessions.push({
          engineSessionId: toEngineSessionId(threadId),
          title:
            (typeof thread.name === "string" && thread.name) ||
            (typeof thread.preview === "string" && thread.preview) ||
            "Codex Thread",
          directory: typeof thread.cwd === "string" ? normalizeDirectory(thread.cwd) : "",
          createdAt: toMillis(thread.createdAt, 0),
          updatedAt: toMillis(thread.updatedAt, toMillis(thread.createdAt, 0)),
          alreadyImported: this.threadToSession.has(threadId),
          engineMeta: { codexThreadId: threadId },
        });

        if (limit > 0 && sessions.length >= limit) {
          return sessions.slice(0, limit);
        }
      }
    } while (cursor);

    return sessions;
  }

  async getHistoricalMessages(
    engineSessionId: string,
    directory: string,
    engineMeta?: Record<string, unknown>,
  ): Promise<UnifiedMessage[]> {
    try {
      await this.start();
    } catch {
      return [];
    }

    if (!this.client?.running) return [];

    const threadId = resolveThreadId(engineSessionId, engineMeta);
    if (!threadId) return [];

    try {
      const response = asRecord(await this.client.request("thread/read", {
        threadId,
        includeTurns: true,
      }));

      return convertThreadToMessages(engineSessionId, response as any, normalizeDirectory(directory));
    } catch (error) {
      codexLog.warn(`Failed to read Codex thread ${threadId}:`, error);
      return [];
    }
  }

  async listModels(): Promise<ModelListResult> {
    try {
      await this.start();
      await this.refreshModelCache();
    } catch (error) {
      codexLog.warn("Failed to refresh Codex model list:", error);
    }

    return {
      models: this.cachedModels,
      currentModelId: this.currentModelId,
    };
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.sessionModels.set(sessionId, modelId);
    this.currentModelId = modelId;
  }

  getModes(): AgentMode[] {
    return CODEX_MODES;
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.sessionModes.set(sessionId, modeId);
    this.currentMode = modeId;
  }

  override async setReasoningEffort(sessionId: string, effort: ReasoningEffort | null): Promise<void> {
    if (effort == null) {
      this.sessionReasoningEfforts.delete(sessionId);
      return;
    }
    this.sessionReasoningEfforts.set(sessionId, effort);
  }

  override getReasoningEffort(sessionId: string): ReasoningEffort | null {
    return this.sessionReasoningEfforts.get(sessionId) ?? null;
  }

  async replyPermission(permissionId: string, reply: PermissionReply, _sessionId?: string): Promise<void> {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) return;

    this.pendingPermissions.delete(permissionId);

    if (!this.client?.running) {
      throw new Error("Codex client is not running");
    }

    switch (pending.method) {
      case "item/commandExecution/requestApproval":
        this.client.respond(pending.requestId, {
          decision: mapCommandApprovalDecision(reply.optionId),
        });
        break;
      case "item/fileChange/requestApproval":
        this.client.respond(pending.requestId, {
          decision: mapFileApprovalDecision(reply.optionId),
        });
        break;
      case "item/permissions/requestApproval": {
        const params = asRecord(pending.params);
        const granted = reply.optionId === "allow_once" || reply.optionId === "allow_always"
          ? asRecord(params.permissions)
          : {};
        this.client.respond(pending.requestId, {
          permissions: granted,
          scope: reply.optionId === "allow_always" ? "session" : "turn",
        });
        break;
      }
      case "execCommandApproval":
        this.client.respond(pending.requestId, {
          decision: mapLegacyReviewDecision(reply.optionId),
        });
        break;
      case "applyPatchApproval":
        this.client.respond(pending.requestId, {
          decision: mapLegacyReviewDecision(reply.optionId),
        });
        break;
      default:
        this.client.respondError(pending.requestId, -32601, `Unsupported approval request: ${pending.method}`);
        break;
    }

    this.touchThread(pending.sessionId);
    this.emit("permission.replied", { permissionId, optionId: reply.optionId });
  }

  async replyQuestion(questionId: string, answers: string[][], _sessionId?: string): Promise<void> {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return;

    this.pendingQuestions.delete(questionId);

    if (!this.client?.running) {
      throw new Error("Codex client is not running");
    }

    const params = asRecord(pending.params);
    const questionDefs = Array.isArray(params.questions) ? params.questions : [];
    const responseAnswers: Record<string, { answers: string[] }> = {};

    questionDefs.forEach((question, index) => {
      const questionRecord = asRecord(question);
      const questionIdValue = typeof questionRecord.id === "string" ? questionRecord.id : `q${index}`;
      responseAnswers[questionIdValue] = {
        answers: answers[index] ?? [],
      };
    });

    this.client.respond(pending.requestId, { answers: responseAnswers });
    this.touchThread(pending.sessionId);
    this.emit("question.replied", { questionId, answers });
  }

  async rejectQuestion(questionId: string, _sessionId?: string): Promise<void> {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return;
    this.pendingQuestions.delete(questionId);

    if (this.client?.running) {
      this.client.respondError(pending.requestId, -32000, "User rejected the prompt");
    }
  }

  async listProjects(): Promise<UnifiedProject[]> {
    return [];
  }

  override async listCommands(sessionId?: string, directory?: string): Promise<EngineCommand[]> {
    const normalizedDirectory = normalizeDirectory(
      directory ??
      (sessionId ? this.sessionDirectories.get(sessionId) : undefined) ??
      "",
    );

    if (!normalizedDirectory) {
      return [];
    }

    try {
      await this.start();
      return await this.refreshCommandsForDirectory(normalizedDirectory);
    } catch (error) {
      codexLog.warn(`Failed to load Codex skills for ${normalizedDirectory}:`, error);
      return this.skillsByDirectory.get(normalizedDirectory) ?? [];
    }
  }

  override async invokeCommand(
    sessionId: string,
    commandName: string,
    args: string,
    options?: { mode?: string; modelId?: string; reasoningEffort?: ReasoningEffort | null; serviceTier?: CodexServiceTier | null; directory?: string },
  ): Promise<CommandInvokeResult> {
    const directory = normalizeDirectory(
      options?.directory ??
      this.sessionDirectories.get(sessionId) ??
      this.threads.get(this.sessionToThread.get(sessionId) ?? "")?.directory ??
      "",
    );

    if (!directory) {
      return { handledAsCommand: false };
    }

    const commands = await this.listCommands(sessionId, directory);
    if (commands.length === 0) {
      return { handledAsCommand: false };
    }

    const skills = this.skillEntriesByDirectory.get(directory);
    const skill = skills?.get(commandName);
    if (!skill?.enabled) {
      return { handledAsCommand: false };
    }

    const displayText = `/${commandName}${args ? ` ${args}` : ""}`;
    const userMessage = createUserMessage(sessionId, displayText);
    const input: CodexTurnInput[] = [
      { type: "skill", name: skill.name, path: skill.path },
      ...(args.trim() ? [{ type: "text" as const, text: args, text_elements: [] as unknown[] }] : []),
    ];

    const message = await this.startPreparedTurn(
      sessionId,
      input,
      userMessage,
      [],
      { ...options, directory },
      false,
    );

    return {
      handledAsCommand: true,
      message,
    };
  }

  private async spawnAndInitialize(): Promise<void> {
    if (!this.cliPath) throw new Error("Codex CLI path is not resolved");

    const client = new CodexJsonRpcClient({
      cliPath: this.cliPath,
      args: buildStartupArgs(),
    });

    client.on("notification", (method, params) => this.handleNotification(method, params));
    client.on("request", (id, method, params) => this.handleServerRequest(id, method, params));
    client.on("error", (error) => {
      codexLog.error("Codex client error:", error);
      this.lastError = error.message;
    });
    client.on("exit", (code, signal) => {
      codexLog.warn(`Codex process exited (code=${code}, signal=${signal})`);
      this.client = null;
      this.setStatus("error", `Codex process exited (code=${code}, signal=${signal})`);
      this.rejectPendingInteractions("Codex process exited");
      this.rejectQueuedMessages("Codex process exited");
      this.failAllInFlight("Codex process exited");
      this.activeTurnIds.clear();
      this.activeToolParts.clear();
      this.cleanupActiveTempDirs();
      for (const thread of this.threads.values()) {
        thread.loaded = false;
      }
    });

    try {
      await client.start();
      await client.request("initialize", {
        clientInfo: {
          name: "codemux",
          title: "CodeMux",
          version: process.env.npm_package_version ?? "0.0.0",
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: null,
        },
      });
      client.notify("initialized");

      this.client = client;
    } catch (error) {
      try {
        await client.stop();
      } catch (stopError) {
        codexLog.warn("Failed to stop partially initialized Codex client:", stopError);
      }
      throw error;
    }
  }

  private async refreshRuntimeMetadata(): Promise<void> {
    await Promise.allSettled([
      this.refreshConfigRequirements(),
      this.refreshModelCache(),
      this.refreshAuthStatus(),
    ]);

    // If account/read reports unauthenticated but models are available
    // (e.g. custom model_provider in config.toml), treat as authenticated.
    if (!this.authenticated && this.cachedModels.length > 0) {
      this.authenticated = true;
      this.authMessage = readCodexModelProvider() ?? "Authenticated";
    }
  }

  private async refreshConfigRequirements(): Promise<void> {
    if (!this.client?.running) return;

    const response = asRecord(await this.client.request("configRequirements/read"));
    const requirements = asRecord(response.requirements);
    this.configRequirements = Object.keys(requirements).length > 0
      ? {
          allowedApprovalPolicies: Array.isArray(requirements.allowedApprovalPolicies)
            ? requirements.allowedApprovalPolicies.filter((value): value is CodexApprovalPolicy => typeof value === "string")
            : null,
          allowedSandboxModes: Array.isArray(requirements.allowedSandboxModes)
            ? requirements.allowedSandboxModes.filter((value): value is CodexSandboxMode => typeof value === "string")
            : null,
        }
      : null;
  }

  private async refreshAuthStatus(): Promise<void> {
    if (!this.client?.running) return;

    try {
      const response = asRecord(await this.client.request("account/read", { refreshToken: false }));
      const account = asRecord(response.account);
      const requiresOpenaiAuth = response.requiresOpenaiAuth === true;

      if (Object.keys(account).length === 0) {
        this.authenticated = false;
        this.authType = undefined;
        this.authMessage = requiresOpenaiAuth ? "OpenAI authentication required" : "Not authenticated";
        return;
      }

      this.authenticated = true;
      if (account.type === "chatgpt" && typeof account.email === "string") {
        this.authType = "chatgpt";
        this.authMessage = account.email;
        return;
      }
      if (account.type === "apiKey") {
        this.authType = "apiKey";
        this.authMessage = "API key";
        return;
      }

      this.authType = undefined;
      this.authMessage = "Authenticated";
    } catch (error) {
      codexLog.warn("Failed to read Codex auth status:", error);
    }
  }

  private async refreshModelCache(): Promise<void> {
    if (!this.client?.running) {
      this.ensureFallbackModels();
      return;
    }

    const models: UnifiedModelInfo[] = [];
    let cursor: string | null | undefined;

    do {
      const response = asRecord(await this.client.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      }));

      const data = Array.isArray(response.data) ? response.data : [];
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;

      for (const entry of data) {
        const model = asRecord(entry);
        const modelId = typeof model.model === "string"
          ? model.model
          : typeof model.id === "string"
            ? model.id
            : undefined;
        if (!modelId) continue;

        const supportedReasoningEfforts = Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts
            .map((value) => asRecord(value))
            .map((value) => typeof value.reasoningEffort === "string" ? fromCodexEffort(value.reasoningEffort) : undefined)
            .filter((value): value is ReasoningEffort => value !== undefined)
          : undefined;
        const defaultReasoningEffort = typeof model.defaultReasoningEffort === "string"
          ? fromCodexEffort(model.defaultReasoningEffort)
          : undefined;

        models.push({
          modelId,
          name: typeof model.displayName === "string" && model.displayName ? model.displayName : modelId,
          description: typeof model.description === "string" ? model.description : undefined,
          engineType: this.engineType,
          capabilities: {
            attachment: Array.isArray(model.inputModalities) && model.inputModalities.includes("image"),
            reasoning: Boolean(supportedReasoningEfforts && supportedReasoningEfforts.length > 0),
            supportedReasoningEfforts,
            defaultReasoningEffort,
          },
          meta: {
            hidden: model.hidden === true,
            isDefault: model.isDefault === true,
            upgrade: typeof model.upgrade === "string" ? model.upgrade : undefined,
          },
        });

        if (model.isDefault === true) {
          this.currentModelId = modelId;
        }
      }
    } while (cursor);

    if (models.length === 0) {
      this.ensureFallbackModels();
      return;
    }

    this.cachedModels = models;
  }

  private ensureFallbackModels(): void {
    if (this.cachedModels.length > 0) return;
    this.cachedModels = [{
      modelId: CODEX_FALLBACK_MODEL,
      name: CODEX_FALLBACK_MODEL,
      engineType: this.engineType,
      capabilities: {
        reasoning: true,
        supportedReasoningEfforts: ["low", "medium", "high", "max"],
        defaultReasoningEffort: "medium",
      },
    }];
  }

  private async refreshCommandsForDirectory(directory: string): Promise<EngineCommand[]> {
    if (!this.client?.running) return this.skillsByDirectory.get(directory) ?? [];

    const response = asRecord(await this.client.request("skills/list", {
      cwds: [directory],
      forceReload: false,
    }));
    const data = Array.isArray(response.data) ? response.data : [];
    const entry = data
      .map((item) => asRecord(item))
      .find((item) => normalizeDirectory(String(item.cwd ?? "")) === directory)
      ?? data.map((item) => asRecord(item))[0];

    const skills = Array.isArray(entry?.skills) ? entry.skills : [];
    const nextCommands: EngineCommand[] = [];
    const nextSkillEntries = new Map<string, SkillEntry>();

    for (const skillValue of skills) {
      const skill = asRecord(skillValue);
      const skillInterface = asRecord(skill.interface);
      const name = typeof skill.name === "string" ? skill.name : undefined;
      const path = typeof skill.path === "string" ? skill.path : undefined;
      if (!name || !path) continue;

      const description =
        (typeof skillInterface.shortDescription === "string" && skillInterface.shortDescription) ||
        (typeof skill.shortDescription === "string" && skill.shortDescription) ||
        (typeof skill.description === "string" && skill.description) ||
        "";
      const enabled = skill.enabled !== false;

      nextCommands.push({
        name,
        description,
        source: typeof skill.scope === "string" ? skill.scope : undefined,
        userInvocable: enabled,
      });
      nextSkillEntries.set(name, {
        name,
        description,
        path,
        scope: typeof skill.scope === "string" ? skill.scope : undefined,
        enabled,
      });
    }

    const previous = this.skillsByDirectory.get(directory) ?? [];
    this.skillsByDirectory.set(directory, nextCommands);
    this.skillEntriesByDirectory.set(directory, nextSkillEntries);

    if (JSON.stringify(previous) !== JSON.stringify(nextCommands)) {
      this.emit("commands.changed", {
        engineType: this.engineType,
        commands: nextCommands,
      });
    }

    return nextCommands;
  }

  private handleNotification(method: string, params: unknown): void {
    const data = asRecord(params);
    const threadId = extractThreadId(method, data);
    const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;

    switch (method) {
      case "thread/started":
        this.handleThreadStarted(data);
        return;
      case "thread/name/updated":
        if (sessionId) this.handleThreadNameUpdated(sessionId, data);
        return;
      case "thread/status/changed":
        if (threadId) this.handleThreadStatusChanged(threadId, data);
        return;
      case "thread/closed":
        if (threadId) this.handleThreadClosed(threadId);
        return;
      case "thread/tokenUsage/updated":
        if (sessionId) this.handleTokenUsageUpdated(sessionId, data);
        return;
      case "turn/started":
        if (sessionId) this.handleTurnStarted(sessionId, data);
        return;
      case "turn/completed":
        if (sessionId) this.handleTurnCompleted(sessionId, data);
        return;
      case "turn/diff/updated":
        if (sessionId) this.handleTurnDiffUpdated(sessionId, data);
        return;
      case "turn/plan/updated":
        if (sessionId) this.handleTurnPlanUpdated(sessionId, data);
        return;
      case "item/started":
        if (sessionId) this.handleItemStarted(sessionId, data);
        return;
      case "item/completed":
        if (sessionId) this.handleItemCompleted(sessionId, data);
        return;
      case "item/agentMessage/delta":
        if (sessionId) this.handleAgentMessageDelta(sessionId, data);
        return;
      case "item/plan/delta":
        if (sessionId) this.handlePlanDelta(sessionId, data);
        return;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        if (sessionId) this.handleReasoningDelta(sessionId, data);
        return;
      case "item/commandExecution/outputDelta":
        if (sessionId) this.handleToolOutputDelta(sessionId, data);
        return;
      case "item/fileChange/outputDelta":
        if (sessionId) this.handleFileChangeDelta(sessionId, data);
        return;
      case "item/mcpToolCall/progress":
        if (sessionId) this.handleMcpProgress(sessionId, data);
        return;
      case "serverRequest/resolved":
        this.handleServerRequestResolved(data);
        return;
      case "skills/changed":
        this.handleSkillsChanged();
        return;
      case "model/rerouted":
        if (sessionId) this.handleModelRerouted(sessionId, data);
        return;
      case "thread/compacted":
        if (sessionId) this.handleContextCompacted(sessionId);
        return;
      case "error":
        if (sessionId) this.handleTurnError(sessionId, data);
        return;
      default:
        codexLog.debug(`Unhandled Codex notification: ${method}`);
        return;
    }
  }

  private handleThreadStarted(data: Record<string, unknown>): void {
    const thread = asRecord(data.thread);
    const threadId = typeof thread.id === "string" ? thread.id : undefined;
    if (!threadId) return;

    const sessionId = this.threadToSession.get(threadId);
    if (!sessionId) return;

    this.registerThread(
      sessionId,
      threadId,
      normalizeDirectory(typeof thread.cwd === "string" ? thread.cwd : this.sessionDirectories.get(sessionId) ?? ""),
      typeof thread.name === "string" ? thread.name : undefined,
      true,
      typeof thread.createdAt === "string" || typeof thread.createdAt === "number" ? thread.createdAt : undefined,
      typeof thread.updatedAt === "string" || typeof thread.updatedAt === "number" ? thread.updatedAt : undefined,
    );
  }

  private handleThreadNameUpdated(sessionId: string, data: Record<string, unknown>): void {
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId) return;
    const thread = this.threads.get(threadId);
    if (!thread) return;

    const title = typeof data.threadName === "string" && data.threadName ? data.threadName : undefined;
    thread.title = title;
    thread.updatedAt = Date.now();

    this.emit("session.updated", {
      session: {
        id: sessionId,
        engineType: this.engineType,
        title,
      },
    });
  }

  private handleThreadStatusChanged(threadId: string, data: Record<string, unknown>): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.loaded = true;
    thread.updatedAt = Date.now();

    const status = asRecord(data.status);
    if (status.type === "notLoaded") {
      thread.loaded = false;
    }
  }

  private handleThreadClosed(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.loaded = false;
  }

  private handleTokenUsageUpdated(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return;
    applyTurnUsage(buffer, data.tokenUsage);
  }

  private handleTurnStarted(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const turn = asRecord(data.turn);
    const turnId = typeof turn.id === "string" ? turn.id : undefined;
    if (!turnId) return;

    buffer.activeTurnId = turnId;
    this.activeTurnIds.set(sessionId, turnId);
    this.touchThread(sessionId);
  }

  private handleTurnCompleted(sessionId: string, data: Record<string, unknown>): void {
    const turn = asRecord(data.turn);
    const status = typeof turn.status === "string" ? turn.status : "completed";

    if (status === "failed") {
      this.failActiveTurn(sessionId, normalizeTurnError(turn.error) ?? "Turn failed", false);
      return;
    }
    if (status === "interrupted") {
      this.failActiveTurn(sessionId, "Cancelled", false);
      return;
    }

    const buffer = this.messageBuffers.get(sessionId) ?? this.ensureBuffer(sessionId);
    applyTurnMetadata(buffer, turn);
    buffer.activeTurnId = typeof turn.id === "string" ? turn.id : buffer.activeTurnId;

    const message = finalizeBufferToMessage(buffer);
    this.appendMessageToHistory(sessionId, message);
    this.emit("message.updated", { sessionId, message });
    this.resolveTurnResolvers(sessionId, message);
    this.finishTurn(sessionId);
    this.processNextQueuedMessage(sessionId);
  }

  private handleTurnDiffUpdated(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return;
    if (typeof data.diff !== "string") return;
    buffer.engineMeta = {
      ...(buffer.engineMeta ?? {}),
      turnDiff: data.diff,
    };
  }

  private handleTurnPlanUpdated(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const plan = Array.isArray(data.plan)
      ? data.plan.map((step) => asRecord(step))
      : [];
    const markdown = formatTurnPlanMarkdown(
      typeof data.explanation === "string" ? data.explanation : null,
      plan.map((step) => ({
        step: typeof step.step === "string" ? step.step : undefined,
        status: typeof step.status === "string" ? step.status : undefined,
      })),
    );

    const part = replacePlanText(buffer, markdown);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part });
  }

  private handleItemStarted(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const item = asRecord(data.item);
    const itemType = typeof item.type === "string" ? item.type : "unknown";

    switch (itemType) {
      case "contextCompaction": {
        const notice = createSystemNotice(buffer, "compact", "notice:context_compressed");
        this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: notice });
        return;
      }
      case "enteredReviewMode": {
        const notice = createSystemNotice(buffer, "info", "Entered review mode");
        this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: notice });
        return;
      }
      case "exitedReviewMode": {
        const notice = createSystemNotice(buffer, "info", "Exited review mode");
        this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: notice });
        return;
      }
      case "agentMessage":
      case "reasoning":
      case "plan":
      case "userMessage":
      case "hookPrompt":
        return;
      default:
        break;
    }

    const callId = typeof item.id === "string" ? item.id : timeId("call");
    if (this.activeToolParts.has(callId)) return;

    const { stepStart, toolPart } = createToolPart(buffer, callId, itemType, this.itemToToolParams(item));
    this.activeToolParts.set(callId, toolPart);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: stepStart });
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: toolPart });
  }

  private handleItemCompleted(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const item = asRecord(data.item);
    const itemType = typeof item.type === "string" ? item.type : "unknown";

    switch (itemType) {
      case "agentMessage": {
        const text = typeof item.text === "string" ? item.text : "";
        if (text) {
          const part = this.replaceTextPart(buffer, text);
          this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part });
        }
        return;
      }
      case "reasoning": {
        const content = [
          ...extractStrings(item.summary),
          ...extractStrings(item.content),
        ].join("\n\n");
        if (content) {
          const part = this.replaceReasoningPart(buffer, content);
          this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part });
        }
        return;
      }
      case "plan": {
        const text = typeof item.text === "string" ? item.text : "";
        const part = replacePlanText(buffer, text.startsWith("#") ? text : `## Plan\n\n${text}`.trimEnd());
        this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part });
        return;
      }
      case "contextCompaction": {
        const notice = createSystemNotice(buffer, "compact", "notice:context_compressed");
        this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: notice });
        return;
      }
      case "enteredReviewMode": {
        const notice = createSystemNotice(buffer, "info", typeof item.review === "string" && item.review ? `Entered review mode: ${item.review}` : "Entered review mode");
        this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: notice });
        return;
      }
      case "exitedReviewMode": {
        const notice = createSystemNotice(buffer, "info", typeof item.review === "string" && item.review ? `Exited review mode: ${item.review}` : "Exited review mode");
        this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: notice });
        return;
      }
      default:
        break;
    }

    const callId = typeof item.id === "string" ? item.id : "";
    let toolPart = callId ? this.activeToolParts.get(callId) : undefined;
    if (!toolPart) {
      const synthetic = createToolPart(buffer, callId || timeId("call"), itemType, this.itemToToolParams(item));
      toolPart = synthetic.toolPart;
      this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: synthetic.stepStart });
      this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: toolPart });
    }

    completeToolPart(
      toolPart,
      this.itemToToolOutput(item),
      normalizeItemToolError(item),
      this.itemToToolMetadata(item),
    );
    if (callId) this.activeToolParts.delete(callId);

    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: toolPart });
    const stepFinish = createStepFinish(buffer);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: stepFinish });
  }

  private handleAgentMessageDelta(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!delta) return;
    const part = appendTextDelta(buffer, delta);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part });
  }

  private handlePlanDelta(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!delta) return;
    const part = appendPlanDelta(buffer, delta);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part });
  }

  private handleReasoningDelta(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!delta) return;
    const part = appendReasoningDelta(buffer, delta);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part });
  }

  private handleToolOutputDelta(sessionId: string, data: Record<string, unknown>): void {
    const itemId = typeof data.itemId === "string" ? data.itemId : "";
    const toolPart = this.activeToolParts.get(itemId);
    if (!toolPart || toolPart.state.status !== "running") return;
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!delta) return;

    const input = toolPart.state.input as Record<string, unknown>;
    input._output = `${typeof input._output === "string" ? input._output : ""}${delta}`;
    this.emit("message.part.updated", { sessionId, messageId: toolPart.messageId, part: toolPart });
  }

  private handleFileChangeDelta(sessionId: string, data: Record<string, unknown>): void {
    const itemId = typeof data.itemId === "string" ? data.itemId : "";
    const toolPart = this.activeToolParts.get(itemId);
    if (!toolPart) return;
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!delta) return;

    toolPart.diff = `${toolPart.diff ?? ""}${delta}`;
    this.emit("message.part.updated", { sessionId, messageId: toolPart.messageId, part: toolPart });
  }

  private handleMcpProgress(sessionId: string, data: Record<string, unknown>): void {
    const itemId = typeof data.itemId === "string" ? data.itemId : "";
    const toolPart = this.activeToolParts.get(itemId);
    if (!toolPart || toolPart.state.status !== "running") return;
    const message = typeof data.message === "string" ? data.message : "";
    if (!message) return;

    const input = toolPart.state.input as Record<string, unknown>;
    input._output = `${typeof input._output === "string" ? input._output : ""}${input._output ? "\n" : ""}${message}`;
    this.emit("message.part.updated", { sessionId, messageId: toolPart.messageId, part: toolPart });
  }

  private handleServerRequestResolved(data: Record<string, unknown>): void {
    const requestId = String(data.requestId ?? "");
    if (!requestId) return;
    this.pendingPermissions.delete(requestId);
    this.pendingQuestions.delete(requestId);
  }

  private handleSkillsChanged(): void {
    for (const directory of this.skillsByDirectory.keys()) {
      this.refreshCommandsForDirectory(directory).catch((error) => {
        codexLog.warn(`Failed to refresh skills for ${directory}:`, error);
      });
    }
  }

  private handleModelRerouted(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return;
    if (typeof data.toModel === "string" && data.toModel) {
      buffer.modelId = data.toModel;
    }
  }

  private handleContextCompacted(sessionId: string): void {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return;
    const notice = createSystemNotice(buffer, "compact", "notice:context_compressed");
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: notice });
  }

  private handleTurnError(sessionId: string, data: Record<string, unknown>): void {
    const error = normalizeTurnError(data.error) ?? "Turn failed";
    this.failActiveTurn(sessionId, error, false);
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const requestId = String(id);
    const sessionId = this.resolveSessionIdForRequest(method, params);

    if (!sessionId) {
      this.client?.respondError(id, -32000, `Cannot resolve session for server request ${method}`);
      return;
    }

    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
      case "execCommandApproval":
      case "applyPatchApproval": {
        const permission = convertApprovalToPermission(sessionId, requestId, method, params);
        this.pendingPermissions.set(requestId, { requestId: id, sessionId, method, params, permission });
        this.emit("permission.asked", { permission });
        return;
      }
      case "item/tool/requestUserInput": {
        const question = convertUserInputToQuestion(sessionId, requestId, params);
        this.pendingQuestions.set(requestId, { requestId: id, sessionId, params, question });
        this.emit("question.asked", { question });
        return;
      }
      default:
        this.client?.respondError(id, -32601, `CodeMux does not support ${method}`);
    }
  }

  private resolveSessionIdForRequest(method: string, params: unknown): string | undefined {
    const data = asRecord(params);

    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      const conversationId = typeof data.conversationId === "string" ? data.conversationId : undefined;
      return conversationId ? this.threadToSession.get(conversationId) ?? toEngineSessionId(conversationId) : undefined;
    }

    const threadId = typeof data.threadId === "string" ? data.threadId : undefined;
    if (!threadId) return undefined;
    return this.threadToSession.get(threadId) ?? toEngineSessionId(threadId);
  }

  private buildPromptInput(content: MessagePromptContent[]): { input: CodexTurnInput[]; tempDirs: string[]; displayText: string } {
    const text = content
      .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n")
      .trim();
    const images = content.filter((item): item is { type: "image"; data: string; mimeType?: string } => item.type === "image" && typeof item.data === "string");

    if (!text && images.length === 0) {
      throw new Error("Message content cannot be empty");
    }

    const input: CodexTurnInput[] = [];
    const tempDirs: string[] = [];

    try {
      if (text) {
        input.push({ type: "text", text, text_elements: [] });
      }

      for (const image of images) {
        const decoded = Buffer.from(image.data, "base64");
        if (decoded.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) {
          throw new Error(`Image attachment exceeds the maximum supported size of ${MAX_IMAGE_ATTACHMENT_BYTES} bytes`);
        }

        let tempDir: string | null = null;
        try {
          tempDir = mkdtempSync(join(tmpdir(), "codemux-codex-img-"));
          const extension = imageFileExtensionFromMimeType(image.mimeType);
          const tempPath = join(tempDir, `image.${extension}`);
          writeFileSync(tempPath, decoded);
          tempDirs.push(tempDir);
          input.push({ type: "localImage", path: tempPath });
        } catch (error) {
          if (tempDir) {
            this.cleanupTempDirs([tempDir]);
          }
          const message = error instanceof Error && error.message ? error.message : String(error);
          throw new Error(`Failed to prepare image attachment: ${message}`, { cause: error });
        }
      }

      return {
        input,
        tempDirs,
        displayText: text || "(image)",
      };
    } catch (error) {
      this.cleanupTempDirs(tempDirs);
      throw error;
    }
  }

  private async startPreparedTurn(
    sessionId: string,
    input: CodexTurnInput[],
    userMessage: UnifiedMessage,
    tempDirs: string[],
    options: {
      mode?: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: CodexServiceTier | null;
      directory?: string;
    } | undefined,
    emitQueuedConsumed: boolean,
  ): Promise<UnifiedMessage> {
    const directory = normalizeDirectory(options?.directory ?? this.sessionDirectories.get(sessionId) ?? this.threads.get(this.sessionToThread.get(sessionId) ?? "")?.directory ?? "");
    const threadId = await this.ensureThreadLoaded(sessionId, directory);
    const modeId = options?.mode ?? this.sessionModes.get(sessionId) ?? this.currentMode;
    const modelId = options?.modelId ?? this.sessionModels.get(sessionId) ?? this.currentModelId;
    const reasoningEffort = options?.reasoningEffort ?? this.sessionReasoningEfforts.get(sessionId) ?? null;
    const hasExplicitServiceTier = options != null && Object.prototype.hasOwnProperty.call(options, "serviceTier");
    const serviceTier = hasExplicitServiceTier
      ? (options!.serviceTier ?? null)
      : (this.sessionServiceTiers.get(sessionId) ?? null);
    if (hasExplicitServiceTier) {
      if (serviceTier && isCodexServiceTier(serviceTier)) {
        this.sessionServiceTiers.set(sessionId, serviceTier);
      } else {
        this.sessionServiceTiers.delete(sessionId);
      }
    }
    const approvalPolicy = clampApprovalPolicy(modeToApprovalPolicy(modeId), this.configRequirements);
    const sandboxPolicy = clampSandboxPolicy(modeToSandboxPolicy(modeId, directory), this.configRequirements);

    const buffer = this.createMessageBuffer(sessionId, directory, threadId);
    this.messageBuffers.set(sessionId, buffer);
    this.activeTempDirs.set(sessionId, [...tempDirs]);

    if (emitQueuedConsumed) {
      this.emit("message.queued.consumed", { sessionId, messageId: userMessage.id });
    }
    this.appendMessageToHistory(sessionId, userMessage);
    this.emit("message.updated", { sessionId, message: userMessage });

    return new Promise<UnifiedMessage>((resolve, reject) => {
      this.pushTurnResolver(sessionId, { resolve, reject });
      this.touchThread(sessionId);

      void this.client!.request("turn/start", {
        threadId,
        input,
        cwd: directory,
        approvalPolicy,
        sandboxPolicy,
        model: modelId,
        effort: reasoningEffort ? toCodexEffort(reasoningEffort) : undefined,
        ...(serviceTier ? { serviceTier } : {}),
        collaborationMode: {
          mode: modeId,
          settings: {
            model: modelId,
            reasoning_effort: reasoningEffort ? toCodexEffort(reasoningEffort) : null,
            developer_instructions: null,
          },
        },
      }, START_TIMEOUT_MS)
        .then((response) => {
          const result = asRecord(response) as TurnResponse;
          const turnId = typeof result.turn?.id === "string"
            ? result.turn.id
            : typeof result.turnId === "string"
              ? result.turnId
              : undefined;
          if (turnId) {
            this.activeTurnIds.set(sessionId, turnId);
            buffer.activeTurnId = turnId;
          }
          buffer.modelId = modelId;
          buffer.reasoningEffort = reasoningEffort ?? undefined;
        })
        .catch((error) => {
          codexLog.error(`Failed to start turn for ${sessionId}:`, error);
          this.failActiveTurn(sessionId, error instanceof Error ? error.message : String(error), false);
        });
    });
  }

  private async steerTurn(
    sessionId: string,
    input: CodexTurnInput[],
    userMessage: UnifiedMessage,
    tempDirs: string[],
    options: {
      mode?: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: CodexServiceTier | null;
      directory?: string;
    } | undefined,
  ): Promise<UnifiedMessage> {
    const threadId = this.sessionToThread.get(sessionId);
    const activeTurnId = this.activeTurnIds.get(sessionId);
    if (!threadId || !activeTurnId || !this.client?.running) {
      return this.enqueueMessage(sessionId, input, userMessage, tempDirs, options);
    }

    try {
      await this.client.request("turn/steer", {
        threadId,
        input,
        expectedTurnId: activeTurnId,
      }, START_TIMEOUT_MS);

      this.appendMessageToHistory(sessionId, userMessage);
      this.emit("message.updated", { sessionId, message: userMessage });
      const existing = this.activeTempDirs.get(sessionId) ?? [];
      this.activeTempDirs.set(sessionId, [...existing, ...tempDirs]);
      this.touchThread(sessionId);

      return new Promise<UnifiedMessage>((resolve, reject) => {
        this.pushTurnResolver(sessionId, { resolve, reject });
      });
    } catch (error) {
      codexLog.warn(`turn/steer failed for ${sessionId}, falling back to queue:`, error);
      return this.enqueueMessage(sessionId, input, userMessage, tempDirs, options);
    }
  }

  private async enqueueMessage(
    sessionId: string,
    input: CodexTurnInput[],
    userMessage: UnifiedMessage,
    tempDirs: string[],
    options: {
      mode?: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: CodexServiceTier | null;
      directory?: string;
    } | undefined,
  ): Promise<UnifiedMessage> {
    return new Promise<UnifiedMessage>((resolve, reject) => {
      const queue = this.messageQueues.get(sessionId) ?? [];
      queue.push({
        input,
        userMessage,
        tempDirs,
        options,
        resolver: { resolve, reject },
      });
      this.messageQueues.set(sessionId, queue);

      this.emit("message.queued", {
        sessionId,
        messageId: userMessage.id,
        queuePosition: queue.length,
      });
    });
  }

  private async processNextQueuedMessage(sessionId: string): Promise<void> {
    if (this.hasActiveTurn(sessionId)) return;

    const queue = this.messageQueues.get(sessionId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift();
    if (!next) return;
    if (queue.length === 0) {
      this.messageQueues.delete(sessionId);
    }

    try {
      const message = await this.startPreparedTurn(
        sessionId,
        next.input,
        next.userMessage,
        next.tempDirs,
        next.options,
        true,
      );
      next.resolver.resolve(message);
    } catch (error) {
      this.cleanupTempDirs(next.tempDirs);
      next.resolver.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private createMessageBuffer(sessionId: string, directory: string, threadId: string): MessageBuffer {
    return {
      messageId: timeId("msg"),
      sessionId,
      parts: [],
      textAccumulator: "",
      textPartId: null,
      reasoningAccumulator: "",
      reasoningPartId: null,
      planAccumulator: undefined,
      planPartId: null,
      startTime: Date.now(),
      workingDirectory: directory,
      activeTurnId: this.activeTurnIds.get(sessionId),
      engineMeta: { codexThreadId: threadId },
    };
  }

  private ensureBuffer(sessionId: string): MessageBuffer {
    const existing = this.messageBuffers.get(sessionId);
    if (existing) return existing;

    const threadId = this.sessionToThread.get(sessionId) ?? resolveThreadId(sessionId);
    const directory = this.sessionDirectories.get(sessionId) ?? this.threads.get(threadId ?? "")?.directory ?? ".";
    const buffer = this.createMessageBuffer(sessionId, directory, threadId ?? "");
    this.messageBuffers.set(sessionId, buffer);
    return buffer;
  }

  private replaceTextPart(buffer: MessageBuffer, text: string) {
    buffer.textAccumulator = text;
    buffer.leadingTrimmed = true;
    if (!buffer.textPartId) buffer.textPartId = timeId("part");
    const part = {
      id: buffer.textPartId,
      messageId: buffer.messageId,
      sessionId: buffer.sessionId,
      type: "text" as const,
      text,
    };
    upsertPart(buffer.parts, part);
    return part;
  }

  private replaceReasoningPart(buffer: MessageBuffer, text: string) {
    buffer.reasoningAccumulator = text;
    if (!buffer.reasoningPartId) buffer.reasoningPartId = timeId("part");
    const part = {
      id: buffer.reasoningPartId,
      messageId: buffer.messageId,
      sessionId: buffer.sessionId,
      type: "reasoning" as const,
      text,
    };
    upsertPart(buffer.parts, part);
    return part;
  }

  private itemToToolParams(item: Record<string, unknown>): Record<string, unknown> {
    const type = typeof item.type === "string" ? item.type : "unknown";
    switch (type) {
      case "commandExecution":
        return {
          command: item.command,
          cwd: item.cwd,
          commandActions: item.commandActions,
        };
      case "fileChange":
        return { changes: item.changes };
      case "mcpToolCall":
        return { server: item.server, tool: item.tool, arguments: item.arguments };
      case "dynamicToolCall":
        return { tool: item.tool, arguments: item.arguments };
      case "collabAgentToolCall":
        return {
          tool: item.tool,
          prompt: item.prompt,
          description: typeof item.tool === "string" ? `Delegating via ${item.tool}` : "Delegating task",
        };
      case "webSearch":
        return { query: item.query, action: item.action };
      case "imageView":
        return { path: item.path };
      case "imageGeneration":
        return { description: item.revisedPrompt ?? "Generating image", savedPath: item.savedPath };
      default:
        return {};
    }
  }

  private itemToToolOutput(item: Record<string, unknown>): unknown {
    const type = typeof item.type === "string" ? item.type : "unknown";
    switch (type) {
      case "commandExecution":
        return item.aggregatedOutput ?? "";
      case "fileChange": {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        return changes
          .map((change) => asRecord(change))
          .map((change) => typeof change.path === "string" ? change.path : "")
          .filter(Boolean)
          .join("\n");
      }
      case "mcpToolCall":
        return item.result ?? "";
      case "dynamicToolCall":
        return item.contentItems ?? item.result ?? "";
      case "collabAgentToolCall":
        return { receiverThreadIds: item.receiverThreadIds, agentsStates: item.agentsStates };
      case "webSearch":
        return item.query ?? "";
      case "imageView":
        return item.path ?? "";
      case "imageGeneration":
        return item.savedPath ?? item.result ?? "";
      default:
        return "";
    }
  }

  private itemToToolMetadata(item: Record<string, unknown>): Record<string, unknown> | undefined {
    const type = typeof item.type === "string" ? item.type : "unknown";
    if (type === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const diff = changes
        .map((change) => asRecord(change))
        .map((change) => typeof change.diff === "string" ? change.diff : "")
        .filter(Boolean)
        .join("\n");
      return diff ? { diff } : undefined;
    }
    return undefined;
  }

  private async startThread(directory: string, customSystemPrompt?: string): Promise<ThreadResponse> {
    const modeId = this.currentMode;
    const approvalPolicy = clampApprovalPolicy(modeToApprovalPolicy(modeId), this.configRequirements);
    const sandboxMode = clampSandboxMode(modeToSandboxMode(modeId), this.configRequirements);
    const baseInstructions = customSystemPrompt
      ? CODEMUX_IDENTITY_PROMPT + "\n\n" + customSystemPrompt
      : CODEMUX_IDENTITY_PROMPT;
    const response = asRecord(await this.client!.request("thread/start", {
      cwd: directory,
      model: this.currentModelId,
      approvalPolicy,
      sandbox: sandboxMode,
      baseInstructions,
      serviceName: "codemux",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    })) as ThreadResponse;

    return response;
  }

  private async resumeThread(threadId: string, directory: string, customSystemPrompt?: string): Promise<ThreadResponse> {
    const sessionId = toEngineSessionId(threadId);
    const modeId = this.sessionModes.get(sessionId) ?? this.currentMode;
    const approvalPolicy = clampApprovalPolicy(modeToApprovalPolicy(modeId), this.configRequirements);
    const sandboxMode = clampSandboxMode(modeToSandboxMode(modeId), this.configRequirements);
    const modelId = this.sessionModels.get(sessionId) ?? this.currentModelId;
    const serviceTier = this.sessionServiceTiers.get(sessionId);
    const systemPrompt = customSystemPrompt ?? this.sessionSystemPrompts.get(sessionId);
    const baseInstructions = systemPrompt
      ? CODEMUX_IDENTITY_PROMPT + "\n\n" + systemPrompt
      : CODEMUX_IDENTITY_PROMPT;

    const response = asRecord(await this.client!.request("thread/resume", {
      threadId,
      cwd: directory,
      model: modelId,
      approvalPolicy,
      sandbox: sandboxMode,
      baseInstructions,
      persistExtendedHistory: true,
      ...(serviceTier ? { serviceTier } : {}),
    })) as ThreadResponse;

    return response;
  }

  private async ensureThreadLoaded(sessionId: string, directory: string): Promise<string> {
    if (!this.client?.running) {
      throw new Error("Codex client is not running");
    }

    const threadId = this.sessionToThread.get(sessionId) ?? resolveThreadId(sessionId);
    if (!threadId) {
      throw new Error(`No Codex thread found for session ${sessionId}`);
    }

    const thread = this.threads.get(threadId);
    if (thread?.loaded) {
      return threadId;
    }

    const response = await this.resumeThread(threadId, directory);
    this.registerThread(
      sessionId,
      threadId,
      directory,
      response.thread?.name ?? thread?.title,
      true,
      response.thread?.createdAt ?? thread?.createdAt,
      response.thread?.updatedAt ?? thread?.updatedAt,
    );
    return threadId;
  }

  private pushTurnResolver(sessionId: string, resolver: SendResolver): void {
    const resolvers = this.turnResolvers.get(sessionId) ?? [];
    resolvers.push(resolver);
    this.turnResolvers.set(sessionId, resolvers);
  }

  private resolveTurnResolvers(sessionId: string, message: UnifiedMessage): void {
    const resolvers = this.turnResolvers.get(sessionId) ?? [];
    this.turnResolvers.delete(sessionId);
    for (const resolver of resolvers) {
      resolver.resolve(message);
    }
  }

  private rejectQueuedMessages(reason: string): void {
    for (const [sessionId] of this.messageQueues) {
      this.rejectQueuedMessagesForSession(sessionId, reason);
    }
  }

  private rejectQueuedMessagesForSession(sessionId: string, reason: string): void {
    const queue = this.messageQueues.get(sessionId);
    if (!queue) return;
    this.messageQueues.delete(sessionId);
    for (const queued of queue) {
      this.cleanupTempDirs(queued.tempDirs);
      queued.resolver.reject(new Error(reason));
    }
  }

  private rejectPendingInteractions(reason: string): void {
    for (const [id, pending] of this.pendingPermissions) {
      this.pendingPermissions.delete(id);
      this.respondToDroppedPermission(pending, reason);
      this.emit("permission.replied", { permissionId: id, optionId: "reject_once" });
      codexLog.debug(`Dropped pending permission ${id}: ${reason}`);
      void pending;
    }
    for (const [id, pending] of this.pendingQuestions) {
      this.pendingQuestions.delete(id);
      this.respondToDroppedQuestion(pending, reason);
      codexLog.debug(`Dropped pending question ${id}: ${reason}`);
    }
  }

  private rejectPendingForSession(sessionId: string, reason: string): void {
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.sessionId !== sessionId) continue;
      this.pendingPermissions.delete(id);
      this.respondToDroppedPermission(pending, reason);
      this.emit("permission.replied", { permissionId: id, optionId: "reject_once" });
      codexLog.debug(`Dropped pending permission ${id}: ${reason}`);
    }
    for (const [id, pending] of this.pendingQuestions) {
      if (pending.sessionId !== sessionId) continue;
      this.pendingQuestions.delete(id);
      this.respondToDroppedQuestion(pending, reason);
      codexLog.debug(`Dropped pending question ${id}: ${reason}`);
    }
  }

  private respondToDroppedPermission(pending: PendingPermission, reason: string): void {
    if (!this.client?.running) return;

    try {
      switch (pending.method) {
        case "item/commandExecution/requestApproval":
          this.client.respond(pending.requestId, { decision: "decline" });
          return;
        case "item/fileChange/requestApproval":
          this.client.respond(pending.requestId, { decision: "decline" });
          return;
        case "item/permissions/requestApproval":
          this.client.respond(pending.requestId, { permissions: {}, scope: "turn" });
          return;
        case "execCommandApproval":
        case "applyPatchApproval":
          this.client.respond(pending.requestId, { decision: "denied" });
          return;
        default:
          this.client.respondError(pending.requestId, -32000, reason);
      }
    } catch (error) {
      codexLog.warn(`Failed to reject pending permission ${String(pending.requestId)}:`, error);
    }
  }

  private respondToDroppedQuestion(pending: PendingQuestion, reason: string): void {
    if (!this.client?.running) return;

    try {
      this.client.respondError(pending.requestId, -32000, reason);
    } catch (error) {
      codexLog.warn(`Failed to reject pending question ${String(pending.requestId)}:`, error);
    }
  }

  private failAllInFlight(errorMessage: string): void {
    for (const sessionId of this.messageBuffers.keys()) {
      this.failActiveTurn(sessionId, errorMessage, false);
    }
  }

  private failActiveTurn(sessionId: string, errorMessage: string, staleSession: boolean): void {
    const buffer = this.messageBuffers.get(sessionId) ?? this.ensureBuffer(sessionId);
    buffer.error = errorMessage;
    const message: UnifiedMessage = {
      ...finalizeBufferToMessage(buffer),
      staleSession,
    };

    this.appendMessageToHistory(sessionId, message);
    this.emit("message.updated", { sessionId, message });
    this.resolveTurnResolvers(sessionId, message);
    this.finishTurn(sessionId);
    void this.processNextQueuedMessage(sessionId);
  }

  private finishTurn(sessionId: string): void {
    this.messageBuffers.delete(sessionId);
    this.activeTurnIds.delete(sessionId);

    const tempDirs = this.activeTempDirs.get(sessionId);
    if (tempDirs) {
      this.cleanupTempDirs(tempDirs);
      this.activeTempDirs.delete(sessionId);
    }
  }

  private hasActiveTurn(sessionId: string): boolean {
    return this.activeTurnIds.has(sessionId) || this.messageBuffers.has(sessionId) || (this.turnResolvers.get(sessionId)?.length ?? 0) > 0;
  }

  private canSteer(
    sessionId: string,
    options: {
      mode?: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: CodexServiceTier | null;
      directory?: string;
    } | undefined,
    directory: string,
  ): boolean {
    const requestedMode = options?.mode ?? this.sessionModes.get(sessionId) ?? this.currentMode;
    const requestedModel = options?.modelId ?? this.sessionModels.get(sessionId) ?? this.currentModelId;
    const requestedEffort = options?.reasoningEffort ?? this.sessionReasoningEfforts.get(sessionId) ?? null;
    const requestedTier = options?.serviceTier ?? this.sessionServiceTiers.get(sessionId) ?? null;
    const sessionDirectory = normalizeDirectory(this.sessionDirectories.get(sessionId) ?? directory);

    return requestedMode === (this.sessionModes.get(sessionId) ?? this.currentMode)
      && requestedModel === (this.sessionModels.get(sessionId) ?? this.currentModelId)
      && requestedEffort === (this.sessionReasoningEfforts.get(sessionId) ?? null)
      && requestedTier === (this.sessionServiceTiers.get(sessionId) ?? null)
      && directory === sessionDirectory;
  }

  private registerThread(
    sessionId: string,
    threadId: string,
    directory: string,
    title: string | undefined,
    loaded: boolean,
    createdAt?: string | number,
    updatedAt?: string | number,
  ): void {
    const normalizedDirectory = normalizeDirectory(directory);
    this.sessionToThread.set(sessionId, threadId);
    this.threadToSession.set(threadId, sessionId);
    this.sessionDirectories.set(sessionId, normalizedDirectory);

    const existing = this.threads.get(threadId);
    const now = Date.now();
    this.threads.set(threadId, {
      threadId,
      directory: normalizedDirectory,
      createdAt: toMillis(createdAt, existing?.createdAt ?? now),
      updatedAt: toMillis(updatedAt, existing?.updatedAt ?? now),
      lastUsedAt: now,
      title: title ?? existing?.title,
      loaded,
    });
  }

  private touchThread(sessionId: string): void {
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId) return;
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.lastUsedAt = Date.now();
    thread.updatedAt = Date.now();
  }

  private clearSessionState(sessionId: string): void {
    const threadId = this.sessionToThread.get(sessionId);
    if (threadId) {
      this.threadToSession.delete(threadId);
      this.threads.delete(threadId);
    }

    this.sessionToThread.delete(sessionId);
    this.messageBuffers.delete(sessionId);
    this.messageHistory.delete(sessionId);
    this.turnResolvers.delete(sessionId);
    this.activeTurnIds.delete(sessionId);
    this.sessionModes.delete(sessionId);
    this.sessionModels.delete(sessionId);
    this.sessionReasoningEfforts.delete(sessionId);
    this.sessionServiceTiers.delete(sessionId);
    this.sessionDirectories.delete(sessionId);
    this.sessionSystemPrompts.delete(sessionId);
    this.rejectQueuedMessagesForSession(sessionId, "Session deleted");
    this.rejectPendingForSession(sessionId, "Session deleted");

    const tempDirs = this.activeTempDirs.get(sessionId);
    if (tempDirs) {
      this.cleanupTempDirs(tempDirs);
      this.activeTempDirs.delete(sessionId);
    }
  }

  private appendMessageToHistory(sessionId: string, message: UnifiedMessage): void {
    const history = this.messageHistory.get(sessionId) ?? [];
    history.push(message);
    this.messageHistory.set(sessionId, history);
  }

  private startSessionCleanup(): void {
    if (this.cleanupIntervalId) return;
    this.cleanupIntervalId = setInterval(() => {
      void this.cleanupIdleThreads();
    }, 60_000);
  }

  private stopSessionCleanup(): void {
    if (!this.cleanupIntervalId) return;
    clearInterval(this.cleanupIntervalId);
    this.cleanupIntervalId = null;
  }

  private async cleanupIdleThreads(): Promise<void> {
    if (!this.client?.running) return;
    const now = Date.now();

    for (const [threadId, thread] of this.threads) {
      if (!thread.loaded) continue;
      const sessionId = this.threadToSession.get(threadId);
      if (!sessionId) continue;
      if (this.hasActiveTurn(sessionId)) continue;
      if ((this.messageQueues.get(sessionId)?.length ?? 0) > 0) continue;
      if (now - thread.lastUsedAt < SESSION_IDLE_TIMEOUT_MS) continue;

      try {
        await this.client.request("thread/unsubscribe", { threadId });
        thread.loaded = false;
      } catch (error) {
        codexLog.warn(`Failed to unsubscribe idle Codex thread ${threadId}:`, error);
      }
    }
  }

  private cleanupTempDirs(tempDirs: string[]): void {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }

  private cleanupActiveTempDirs(): void {
    for (const dirs of this.activeTempDirs.values()) {
      this.cleanupTempDirs(dirs);
    }
    this.activeTempDirs.clear();
  }

  private setStatus(status: EngineStatus, error?: string): void {
    this.status = status;
    this.lastError = status === "error" ? error : undefined;
    this.emit("status.changed", {
      engineType: this.engineType,
      status,
      error,
    });
  }

  private failStart(message: string): Error {
    this.setStatus("error", message);
    return new Error(message);
  }
}

function toEngineSessionId(threadId: string): string {
  return threadId.startsWith("codex_") ? threadId : `codex_${threadId}`;
}

function resolveThreadId(engineSessionId?: string, engineMeta?: Record<string, unknown>): string | undefined {
  if (engineMeta?.codexThreadId && typeof engineMeta.codexThreadId === "string") {
    return engineMeta.codexThreadId;
  }
  if (!engineSessionId) return undefined;
  return engineSessionId.startsWith("codex_") ? engineSessionId.slice("codex_".length) : engineSessionId;
}

function extractThreadId(method: string, data: Record<string, unknown>): string | undefined {
  if (typeof data.threadId === "string") return data.threadId;
  if (method === "thread/started") {
    const thread = asRecord(data.thread);
    return typeof thread.id === "string" ? thread.id : undefined;
  }
  return undefined;
}

function mapCommandApprovalDecision(optionId: string): string {
  switch (optionId) {
    case "allow_always":
      return "acceptForSession";
    case "reject_once":
      return "decline";
    case "allow_once":
    default:
      return "accept";
  }
}

function mapFileApprovalDecision(optionId: string): string {
  switch (optionId) {
    case "allow_always":
      return "acceptForSession";
    case "reject_once":
      return "decline";
    case "allow_once":
    default:
      return "accept";
  }
}

function mapLegacyReviewDecision(optionId: string): string {
  switch (optionId) {
    case "allow_always":
      return "approved_for_session";
    case "reject_once":
      return "denied";
    case "allow_once":
    default:
      return "approved";
  }
}

function normalizeTurnError(error: unknown): string | undefined {
  if (typeof error === "string" && error) return error;
  if (!error || typeof error !== "object") return undefined;

  const record = error as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : undefined;
  const details = typeof record.additionalDetails === "string" ? record.additionalDetails : undefined;
  if (message && details) return `${message}\n\n${details}`;
  return message;
}

function normalizeItemToolError(item: Record<string, unknown>): string | undefined {
  const explicit = normalizeTurnError(item.error);
  if (explicit) return explicit;
  if (typeof item.exitCode === "number" && item.exitCode !== 0) {
    return `Exit code: ${item.exitCode}`;
  }
  if (item.status === "failed" || item.status === "declined") {
    return typeof item.result === "string" && item.result ? item.result : "Tool failed";
  }
  return undefined;
}

function extractStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function toMillis(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function imageFileExtensionFromMimeType(mimeType?: string): string {
  if (typeof mimeType !== "string") return "png";

  const normalized = mimeType.trim().toLowerCase().split(";", 1)[0] ?? "";
  const subtype = normalized.split("/", 2)[1] ?? "";

  switch (subtype) {
    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
    case "gif":
      return subtype;
    default:
      return "png";
  }
}
