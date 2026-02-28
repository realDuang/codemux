// ============================================================================
// Copilot SDK Adapter — GitHub Copilot integration via @github/copilot-sdk
//
// Complete rewrite of the Copilot engine adapter using the official SDK
// instead of the old ACP (JSON-RPC/stdio) approach.
// ============================================================================

import { randomBytes } from "crypto";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { app } from "electron";
import { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import type {
  SessionEvent,
  SessionConfig,
  ResumeSessionConfig,
  PermissionRequest,
  PermissionRequestResult,
  SessionMetadata,
  ModelInfo,
  MessageOptions,
} from "@github/copilot-sdk";

/** Equivalent to SDK's UserInputRequest (not re-exported from package index) */
interface UserInputRequest {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
}

/** Equivalent to SDK's UserInputResponse (not re-exported from package index) */
interface UserInputResponse {
  answer: string;
  wasFreeform: boolean;
}

import { EngineAdapter } from "./engine-adapter";
import { sessionStore } from "../services/session-store";
import { copilotLog } from "../services/logger";
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
// Time-sortable ID generator
// ============================================================================

let _lastTs = 0;
let _counter = 0;

/**
 * Generate a time-sortable ID with the given prefix.
 * Format: {prefix}_{12-hex-timestamp}{4-hex-counter}{10-hex-random}
 * Lexicographic order matches creation order for correct frontend sorting.
 */
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
// Copilot Tool Name Mapping
// ============================================================================

const COPILOT_TOOL_MAP: Record<string, NormalizedToolName> = {
  powershell: "shell",
  bash: "shell",
  shell: "shell",
  read_powershell: "shell",
  write_powershell: "shell",
  stop_powershell: "shell",
  view: "read",
  read_file: "read",
  create: "write",
  write_file: "write",
  edit: "edit",
  edit_file: "edit",
  grep: "grep",
  search: "grep",
  glob: "glob",
  find: "glob",
  list: "list",
  web_fetch: "web_fetch",
  fetch_url: "web_fetch",
  web_search: "web_fetch",
  task: "task",
  update_todo: "todo",
  report_intent: "unknown",
};

function normalizeCopilotToolName(toolName: string): NormalizedToolName {
  return (
    COPILOT_TOOL_MAP[toolName] ??
    COPILOT_TOOL_MAP[toolName.toLowerCase()] ??
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
  tokens?: { input: number; output: number; cache?: { read: number; write: number } };
  cost?: number;
  modelId?: string;
  error?: string;
}

// ============================================================================
// Pending Permission / Question types
// ============================================================================

interface PendingPermission {
  resolve: (result: PermissionRequestResult) => void;
  permission: UnifiedPermission;
}

interface PendingQuestion {
  resolve: (response: UserInputResponse) => void;
  question: UnifiedQuestion;
}

// ============================================================================
// Default Agent Modes
// ============================================================================

const DEFAULT_MODES: AgentMode[] = [
  { id: "agent", label: "Agent", description: "Interactive coding agent" },
  { id: "plan", label: "Plan", description: "Plan before executing" },
  { id: "autopilot", label: "Autopilot", description: "Fully autonomous mode" },
];

// ============================================================================
// Config Helpers
// ============================================================================

/**
 * Read the current model from ~/.copilot/config.json.
 * Falls back to undefined if the file doesn't exist or is unreadable.
 */
function readConfigModel(): string | undefined {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const configPath = join(home, ".copilot", "config.json");
    if (!existsSync(configPath)) return undefined;
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    return config?.model || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the platform-native Copilot CLI binary path.
 *
 * The `@github/copilot` package ships optional platform-specific packages
 * (e.g. `@github/copilot-win32-x64`) containing a pre-built native binary.
 * This is the same resolution strategy used by the CLI's own `npm-loader.js`.
 *
 * Using the native binary avoids the Electron + Commander.js argv conflict:
 * when the SDK spawns the CLI's `index.js` via `process.execPath` (= Electron),
 * Commander detects `process.versions.electron` and mis-parses `process.argv`.
 * The native binary has no such issue since it runs independently.
 */
function resolvePlatformCli(): string | undefined {
  const pkgName = `@github/copilot-${process.platform}-${process.arch}`;
  const binaryName = process.platform === "win32" ? "copilot.exe" : "copilot";

  // Strategy 1: import.meta.resolve (works in dev mode where node_modules is
  // on disk and the code runs unbundled or with working module resolution).
  try {
    const resolved = fileURLToPath(import.meta.resolve(pkgName));
    if (existsSync(resolved)) return resolved;
  } catch {
    // Not resolvable — expected in packaged builds
  }

  // Strategy 2: Scan known filesystem locations for the platform binary.
  // In packaged Electron apps, electron-builder may hoist the package into
  // @github/copilot/node_modules/ and asar-unpack it to app.asar.unpacked/.
  const appPath = app.getAppPath(); // e.g. resources/app.asar
  const candidates = [
    // Packaged: nested inside @github/copilot (asar-unpacked)
    join(dirname(appPath), "app.asar.unpacked", "node_modules", "@github", "copilot", "node_modules", pkgName, binaryName),
    // Packaged: top-level node_modules (asar-unpacked)
    join(dirname(appPath), "app.asar.unpacked", "node_modules", pkgName, binaryName),
    // Dev: top-level node_modules
    join(appPath, "node_modules", pkgName, binaryName),
    // Dev: nested inside @github/copilot
    join(appPath, "node_modules", "@github", "copilot", "node_modules", pkgName, binaryName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

// ============================================================================
// CopilotSdkAdapter
// ============================================================================

export class CopilotSdkAdapter extends EngineAdapter {
  readonly engineType: EngineType = "copilot";

  // --- SDK client & sessions ---
  private client: CopilotClient | null = null;
  private activeSessions = new Map<string, CopilotSession>();
  private sessionUnsubscribers = new Map<string, () => void>();

  // --- State ---
  private status: EngineStatus = "stopped";
  private version: string | undefined;
  private currentModelId: string | null = null;
  private cachedModels: UnifiedModelInfo[] = [];
  private sessionModes = new Map<string, string>();

  // --- Permission auto-approve rules ---
  private allowedAlwaysKinds = new Set<string>();

  // --- Message accumulation ---
  private messageBuffers = new Map<string, MessageBuffer>();
  private messageHistory = new Map<string, UnifiedMessage[]>();

  // --- Pending interactions ---
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingQuestions = new Map<string, PendingQuestion>();

  // --- Message send completion ---
  private idleResolvers = new Map<string, (msg: UnifiedMessage) => void>();

  // --- Tool call tracking ---
  private toolCallParts = new Map<string, ToolPart>();

  // --- Turn tracking ---
  private activeTurnSessions = new Set<string>();

  // --- Constructor ---

  constructor(private options?: { cliPath?: string; env?: Record<string, string> }) {
    super();
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async start(): Promise<void> {
    if (this.status === "running") return;

    this.setStatus("starting");
    copilotLog.info("Starting Copilot SDK adapter...");

    try {
      // Prefer the platform-native binary (e.g. @github/copilot-win32-x64).
      // This avoids the Electron + Commander.js argv parsing conflict that
      // occurs when the SDK spawns the JS-based CLI via process.execPath.
      const cliPath = this.options?.cliPath ?? resolvePlatformCli();
      if (!cliPath) {
        throw new Error(
          `No platform-native Copilot CLI binary found for ${process.platform}-${process.arch}. ` +
          `Install @github/copilot-${process.platform}-${process.arch} or provide a custom cliPath.`,
        );
      }
      copilotLog.info("Using Copilot CLI binary:", cliPath);

      this.client = new CopilotClient({
        useStdio: true,
        autoRestart: true,
        autoStart: true,
        cliPath,
        env: this.options?.env,
      });

      await this.client.start();

      // Verify connection with a ping
      const ping = await this.client.ping();
      copilotLog.info("Copilot SDK connected", {
        message: ping.message,
        protocolVersion: ping.protocolVersion,
      });

      // Fetch CLI version
      try {
        const status = await this.client.getStatus();
        this.version = status.version;
        copilotLog.info(`Copilot CLI version: ${this.version}`);
      } catch {
        // Version fetch is non-critical
      }

      // Read initial model from config
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

    // Destroy all active sessions
    for (const [sessionId, session] of this.activeSessions) {
      try {
        const unsub = this.sessionUnsubscribers.get(sessionId);
        if (unsub) unsub();
        await session.destroy();
      } catch (err) {
        copilotLog.warn(`Error destroying session ${sessionId}:`, err);
      }
    }
    this.activeSessions.clear();
    this.sessionUnsubscribers.clear();

    // Clear all pending interactions
    this.rejectAllPendingPermissions("Adapter stopped");
    this.rejectAllPendingQuestions("Adapter stopped");

    // Stop the client
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

  getStatus(): EngineStatus {
    return this.status;
  }

  getInfo(): EngineInfo {
    return {
      type: this.engineType,
      name: "GitHub Copilot",
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
      dynamicModes: true,
      messageCancellation: true,
      permissionAlways: true,
      imageAttachment: true,
      loadSession: true,
      listSessions: true,
      availableModes: this.getModes(),
    };
  }

  getAuthMethods(): AuthMethod[] {
    return [
      {
        id: "github",
        name: "GitHub",
        description: "Sign in with GitHub to use Copilot",
      },
    ];
  }

  // ==========================================================================
  // Sessions
  // ==========================================================================

  async listSessions(directory?: string): Promise<UnifiedSession[]> {
    this.ensureClient();

    try {
      const metadataList = await this.client!.listSessions();
      const sessions = metadataList.map((m) => this.metadataToSession(m));
      sessionStore.mergeSessions(sessions, this.engineType);
    } catch (err) {
      copilotLog.warn("Failed to list sessions from SDK:", err);
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
    this.ensureClient();

    const normalizedDir = directory.replaceAll("\\", "/");
    const mode = "agent"; // Default mode for new sessions

    const config: SessionConfig = {
      workingDirectory: directory,
      streaming: true,
      model: this.currentModelId ?? undefined,
      onPermissionRequest: (req, ctx) => this.handlePermissionRequest(req, ctx),
      onUserInputRequest: (req, ctx) => this.handleUserInputRequest(req, ctx),
    };

    const sdkSession = await this.client!.createSession(config);
    const sessionId = sdkSession.sessionId;

    // Subscribe to session events
    this.subscribeToSessionEvents(sdkSession);
    this.activeSessions.set(sessionId, sdkSession);
    this.sessionModes.set(sessionId, mode);

    const now = Date.now();
    const session: UnifiedSession = {
      id: sessionId,
      engineType: this.engineType,
      directory: normalizedDir,
      time: { created: now, updated: now },
    };

    sessionStore.upsertSession(session);

    this.emit("session.created", { session });
    copilotLog.info(`Created session ${sessionId} in ${normalizedDir}`);

    return session;
  }

  async getSession(sessionId: string): Promise<UnifiedSession | null> {
    return sessionStore.getSession(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Destroy active session if it exists
    const activeSession = this.activeSessions.get(sessionId);
    if (activeSession) {
      const unsub = this.sessionUnsubscribers.get(sessionId);
      if (unsub) unsub();
      this.sessionUnsubscribers.delete(sessionId);

      try {
        await activeSession.destroy();
      } catch (err) {
        copilotLog.warn(`Error destroying session ${sessionId}:`, err);
      }
      this.activeSessions.delete(sessionId);
    }

    // Delete from SDK
    try {
      await this.client?.deleteSession(sessionId);
    } catch (err) {
      copilotLog.warn(`Error deleting session ${sessionId} from SDK:`, err);
    }

    // Clean up local state
    this.messageHistory.delete(sessionId);
    this.messageBuffers.delete(sessionId);
    this.sessionModes.delete(sessionId);
    this.activeTurnSessions.delete(sessionId);
    sessionStore.deleteSession(sessionId);

    copilotLog.info(`Deleted session ${sessionId}`);
  }

  // ==========================================================================
  // Messages
  // ==========================================================================

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: { mode?: string; modelId?: string },
  ): Promise<UnifiedMessage> {
    const session = await this.ensureActiveSession(sessionId);
    const now = Date.now();

    // Apply model override if provided
    if (options?.modelId) {
      this.currentModelId = options.modelId;
    }

    // Apply mode if provided
    if (options?.mode) {
      this.sessionModes.set(sessionId, options.mode);
    }

    // Build prompt text from content parts
    const promptText = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");

    // Create and emit user message
    const userMessage = this.createUserMessage(sessionId, promptText, now);
    this.appendMessageToHistory(sessionId, userMessage);
    this.emit("message.updated", { sessionId, message: userMessage });

    // Create message buffer for the assistant response
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

    // Emit initial empty assistant message
    const initialMessage = this.bufferToMessage(buffer, false);
    this.emit("message.updated", { sessionId, message: initialMessage });

    // Build send options (mode here is delivery mode, not agent mode)
    const sendOptions: MessageOptions = {
      prompt: promptText,
    };

    // Wrap in a promise that resolves when session.idle fires
    return new Promise<UnifiedMessage>((resolve, reject) => {
      this.idleResolvers.set(sessionId, resolve);

      session.send(sendOptions).catch((err) => {
        copilotLog.error(`Error sending message to session ${sessionId}:`, err);
        this.idleResolvers.delete(sessionId);

        // Finalize buffer with error
        const buf = this.messageBuffers.get(sessionId);
        if (buf) {
          buf.error = err instanceof Error ? err.message : String(err);
          const finalMsg = this.finalizeBuffer(sessionId);
          if (finalMsg) {
            reject(err);
            return;
          }
        }
        reject(err);
      });
    });
  }

  async cancelMessage(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      copilotLog.warn(`Cannot cancel: no active session ${sessionId}`);
      return;
    }

    try {
      await session.abort();
      copilotLog.info(`Cancelled message in session ${sessionId}`);
    } catch (err) {
      copilotLog.warn(`Error cancelling message in session ${sessionId}:`, err);
    }

    // Finalize any pending buffer
    this.finalizeBuffer(sessionId);
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    // Return cached history if available
    const cached = this.messageHistory.get(sessionId);
    if (cached && cached.length > 0) {
      return cached;
    }

    // Try to load from SDK via resumeSession + getMessages
    try {
      const session = await this.ensureActiveSession(sessionId);
      const events = await session.getMessages();
      const messages = this.convertEventsToMessages(sessionId, events);
      this.messageHistory.set(sessionId, messages);
      return messages;
    } catch (err) {
      copilotLog.warn(`Failed to load messages for session ${sessionId}:`, err);
      return [];
    }
  }

  // ==========================================================================
  // Models
  // ==========================================================================

  async listModels(): Promise<ModelListResult> {
    this.ensureClient();

    try {
      const sdkModels = await this.client!.listModels();
      this.cachedModels = sdkModels.map((m) => this.sdkModelToUnified(m));
    } catch (err) {
      copilotLog.warn("Failed to list models from SDK:", err);
    }

    // Always prefer config file model as current
    const configModel = readConfigModel();
    if (configModel) {
      this.currentModelId = configModel;
    }

    return {
      models: this.cachedModels,
      currentModelId: this.currentModelId ?? undefined,
    };
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.currentModelId = modelId;

    // Switch model in active session via RPC
    const session = this.activeSessions.get(sessionId);
    if (session) {
      try {
        await session.rpc.model.switchTo({ modelId });
        copilotLog.info(`Model switched to ${modelId} for session ${sessionId}`);
      } catch (err) {
        copilotLog.warn(`Failed to switch model via RPC for session ${sessionId}:`, err);
      }
    } else {
      copilotLog.info(`Model set to ${modelId} (no active session, applies on next create)`);
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

    // Notify copilot backend of mode change via RPC
    const session = this.activeSessions.get(sessionId);
    if (session) {
      const sdkMode = modeId === "agent" ? "interactive" : modeId as "interactive" | "plan" | "autopilot";
      try {
        await session.rpc.mode.set({ mode: sdkMode });
        copilotLog.info(`Mode set to ${sdkMode} for session ${sessionId}`);
      } catch (err) {
        copilotLog.warn(`Failed to set mode via RPC for session ${sessionId}:`, err);
      }
    } else {
      copilotLog.info(`Mode set to ${modeId} for session ${sessionId} (no active session)`);
    }
  }

  // ==========================================================================
  // Permissions
  // ==========================================================================

  async replyPermission(permissionId: string, reply: PermissionReply): Promise<void> {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      copilotLog.warn(`No pending permission found for ID ${permissionId}`);
      return;
    }

    const optionId = reply.optionId;
    const isApproved = optionId === "allow_once" || optionId === "allow_always";

    // Persist "always allow" rule for this permission kind
    if (optionId === "allow_always" && pending.permission.rawInput) {
      const rawKind = (pending.permission.rawInput as Record<string, unknown>).kind as string | undefined;
      if (rawKind) {
        this.allowedAlwaysKinds.add(rawKind);
        copilotLog.info(`Added allow_always rule for kind: ${rawKind}`);
      }
    }

    const result: PermissionRequestResult = {
      kind: isApproved ? "approved" : "denied-interactively-by-user",
    };

    pending.resolve(result);
    this.pendingPermissions.delete(permissionId);

    this.emit("permission.replied", { permissionId, optionId });
    copilotLog.info(`Permission ${permissionId} replied: ${optionId}`);
  }

  // ==========================================================================
  // Questions
  // ==========================================================================

  async replyQuestion(questionId: string, answers: string[][]): Promise<void> {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      copilotLog.warn(`No pending question found for ID ${questionId}`);
      return;
    }

    // Take the first answer from the first question group
    const answer = answers[0]?.[0] ?? "";

    const response: UserInputResponse = {
      answer,
      wasFreeform: !pending.question.questions[0]?.options?.some(
        (opt) => opt.label === answer,
      ),
    };

    pending.resolve(response);
    this.pendingQuestions.delete(questionId);

    this.emit("question.replied", { questionId, answers });
    copilotLog.info(`Question ${questionId} replied`);
  }

  async rejectQuestion(questionId: string): Promise<void> {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      copilotLog.warn(`No pending question found for ID ${questionId}`);
      return;
    }

    // Resolve with a dismissal answer
    const response: UserInputResponse = {
      answer: "",
      wasFreeform: true,
    };

    pending.resolve(response);
    this.pendingQuestions.delete(questionId);

    copilotLog.info(`Question ${questionId} rejected/dismissed`);
  }

  // ==========================================================================
  // Projects
  // ==========================================================================

  async listProjects(): Promise<UnifiedProject[]> {
    const allProjects = sessionStore.getAllProjects();
    return allProjects.filter((p) => p.engineType === this.engineType);
  }

  // ==========================================================================
  // Private — Status Management
  // ==========================================================================

  private setStatus(status: EngineStatus, error?: string): void {
    this.status = status;
    this.emit("status.changed", {
      engineType: this.engineType,
      status,
      error,
    });
    copilotLog.info(`Status changed to: ${status}${error ? ` (${error})` : ""}`);
  }

  private ensureClient(): void {
    if (!this.client || this.status !== "running") {
      throw new Error("Copilot SDK adapter is not running");
    }
  }

  // ==========================================================================
  // Private — Session Management
  // ==========================================================================

  /**
   * Ensure a CopilotSession is active and subscribed to events.
   * If the session isn't in activeSessions, resume it from the SDK.
   */
  private async ensureActiveSession(sessionId: string): Promise<CopilotSession> {
    const existing = this.activeSessions.get(sessionId);
    if (existing) return existing;

    this.ensureClient();

    const storedSession = sessionStore.getSession(sessionId);
    const config: ResumeSessionConfig = {
      streaming: true,
      workingDirectory: storedSession?.directory,
      onPermissionRequest: (req, ctx) => this.handlePermissionRequest(req, ctx),
      onUserInputRequest: (req, ctx) => this.handleUserInputRequest(req, ctx),
    };

    const sdkSession = await this.client!.resumeSession(sessionId, config);
    this.subscribeToSessionEvents(sdkSession);
    this.activeSessions.set(sessionId, sdkSession);

    copilotLog.info(`Resumed session ${sessionId}`);
    return sdkSession;
  }

  /**
   * Subscribe to ALL events from a CopilotSession and route them
   * to the appropriate handler.
   */
  private subscribeToSessionEvents(session: CopilotSession): void {
    const sessionId = session.sessionId;

    // Remove old subscription if any
    const oldUnsub = this.sessionUnsubscribers.get(sessionId);
    if (oldUnsub) oldUnsub();

    const unsub = session.on((event: SessionEvent) => {
      this.handleSessionEvent(sessionId, event);
    });

    this.sessionUnsubscribers.set(sessionId, unsub);
  }

  // ==========================================================================
  // Private — Event Handling
  // ==========================================================================

  private handleSessionEvent(sessionId: string, event: SessionEvent): void {
    const type = event.type;

    try {
      switch (type) {
        // --- Text streaming ---
        case "assistant.message_delta":
          this.handleMessageDelta(sessionId, event.data);
          break;

        // --- Reasoning streaming ---
        case "assistant.reasoning_delta":
          this.handleReasoningDelta(sessionId, event.data);
          break;

        // --- Complete assistant message ---
        case "assistant.message":
          this.handleAssistantMessage(sessionId, event.data);
          break;

        // --- Tool events ---
        case "tool.execution_start":
          this.handleToolStart(sessionId, event.data);
          break;
        case "tool.execution_complete":
          this.handleToolComplete(sessionId, event.data);
          break;
        case "tool.execution_partial_result":
          this.handleToolPartialResult(sessionId, event.data);
          break;

        // --- Turn lifecycle ---
        case "assistant.turn_start":
          this.handleTurnStart(sessionId, event.data);
          break;
        case "assistant.turn_end":
          this.handleTurnEnd(sessionId, event.data);
          break;

        // --- Session lifecycle ---
        case "session.idle":
          this.handleSessionIdle(sessionId);
          break;
        case "session.title_changed":
          this.handleTitleChanged(sessionId, event.data);
          break;
        case "session.error":
          this.handleSessionError(sessionId, event.data);
          break;
        case "session.model_change":
          this.handleModelChange(sessionId, event.data);
          break;
        case "session.mode_changed":
          this.handleModeChanged(sessionId, event.data);
          break;

        // --- Usage ---
        case "assistant.usage":
          this.handleUsage(sessionId, event.data);
          break;

        // --- Abort ---
        case "abort":
          this.handleAbort(sessionId, event.data);
          break;

        // --- Subagent ---
        case "subagent.started":
          this.handleSubagentStarted(sessionId, event.data);
          break;
        case "subagent.completed":
          this.handleSubagentCompleted(sessionId, event.data);
          break;

        // --- User message (from history replay) ---
        case "user.message":
          // Handled in convertEventsToMessages, not during streaming
          break;

        default:
          copilotLog.debug(`Unhandled session event: ${type}`);
          break;
      }
    } catch (err) {
      copilotLog.error(`Error handling event ${type} for session ${sessionId}:`, err);
    }
  }

  // --- Text Delta ---

  private handleMessageDelta(
    sessionId: string,
    data: { messageId?: string; deltaContent: string; parentToolCallId?: string },
  ): void {
    const buffer = this.getOrCreateBuffer(sessionId);

    buffer.textAccumulator += data.deltaContent;

    // Create or update the text part
    if (!buffer.textPartId) {
      buffer.textPartId = timeId("part");
    }

    const textPart: TextPart = {
      id: buffer.textPartId,
      messageId: buffer.messageId,
      sessionId,
      type: "text",
      text: buffer.textAccumulator,
    };

    this.upsertPart(buffer, textPart);
    this.emit("message.part.updated", {
      sessionId,
      messageId: buffer.messageId,
      part: textPart,
    });
  }

  // --- Reasoning Delta ---

  private handleReasoningDelta(
    sessionId: string,
    data: { reasoningId?: string; deltaContent: string },
  ): void {
    const buffer = this.getOrCreateBuffer(sessionId);

    buffer.reasoningAccumulator += data.deltaContent;

    if (!buffer.reasoningPartId) {
      buffer.reasoningPartId = timeId("part");
    }

    const reasoningPart: ReasoningPart = {
      id: buffer.reasoningPartId,
      messageId: buffer.messageId,
      sessionId,
      type: "reasoning",
      text: buffer.reasoningAccumulator,
    };

    this.upsertPart(buffer, reasoningPart);
    this.emit("message.part.updated", {
      sessionId,
      messageId: buffer.messageId,
      part: reasoningPart,
    });
  }

  // --- Complete Assistant Message ---

  private handleAssistantMessage(
    sessionId: string,
    data: {
      messageId?: string;
      content?: string;
      toolRequests?: unknown[];
      phase?: string;
      parentToolCallId?: string;
    },
  ): void {
    // The complete message event is primarily useful during history replay.
    // During streaming, we already have the accumulated text from deltas.
    // If we have content and no buffer yet, create the text part.
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer && data.content) {
      const newBuffer = this.getOrCreateBuffer(sessionId);
      newBuffer.textAccumulator = data.content;
      if (!newBuffer.textPartId) {
        newBuffer.textPartId = timeId("part");
      }
      const textPart: TextPart = {
        id: newBuffer.textPartId,
        messageId: newBuffer.messageId,
        sessionId,
        type: "text",
        text: data.content,
      };
      this.upsertPart(newBuffer, textPart);
      this.emit("message.part.updated", {
        sessionId,
        messageId: newBuffer.messageId,
        part: textPart,
      });
    }
  }

  // --- Tool Start ---

  private handleToolStart(
    sessionId: string,
    data: {
      toolCallId: string;
      toolName: string;
      arguments?: unknown;
      mcpServerName?: string;
      parentToolCallId?: string;
    },
  ): void {
    const buffer = this.getOrCreateBuffer(sessionId);

    // Flush accumulated text before tool call starts
    this.flushTextAccumulator(buffer, sessionId);

    const normalizedTool = normalizeCopilotToolName(data.toolName);
    const kind = inferToolKind(undefined, normalizedTool);
    const partId = timeId("part");

    // Build a human-readable title
    const title = this.buildToolTitle(data.toolName, normalizedTool, data.arguments);

    const toolPart: ToolPart = {
      id: partId,
      messageId: buffer.messageId,
      sessionId,
      type: "tool",
      callId: data.toolCallId,
      normalizedTool,
      originalTool: data.toolName,
      title,
      kind,
      state: {
        status: "running",
        input: data.arguments ?? {},
        time: { start: Date.now() },
      },
    };

    // Track by toolCallId for later updates
    this.toolCallParts.set(data.toolCallId, toolPart);

    buffer.parts.push(toolPart);
    this.emit("message.part.updated", {
      sessionId,
      messageId: buffer.messageId,
      part: toolPart,
    });
  }

  // --- Tool Complete ---

  private handleToolComplete(
    sessionId: string,
    data: {
      toolCallId: string;
      success: boolean;
      result?: { content?: string; detailedContent?: string; contents?: unknown[] };
      error?: { message: string; code?: string };
      parentToolCallId?: string;
    },
  ): void {
    const toolPart = this.toolCallParts.get(data.toolCallId);
    if (!toolPart) {
      copilotLog.warn(`Tool complete for unknown toolCallId: ${data.toolCallId}`);
      return;
    }

    const now = Date.now();
    const startTime = toolPart.state.status === "running" ? toolPart.state.time.start : now;

    // Extract output content
    const output = data.result?.content ?? data.error?.message ?? "";

    // Extract diff if available
    const diff = data.result?.detailedContent ?? undefined;

    if (data.success) {
      toolPart.state = {
        status: "completed",
        input: toolPart.state.status !== "pending" ? toolPart.state.input : {},
        output,
        time: {
          start: startTime,
          end: now,
          duration: now - startTime,
        },
      };
    } else {
      toolPart.state = {
        status: "error",
        input: toolPart.state.status !== "pending" ? toolPart.state.input : {},
        output,
        error: data.error?.message ?? "Tool execution failed",
        time: {
          start: startTime,
          end: now,
          duration: now - startTime,
        },
      };
    }

    if (diff) {
      toolPart.diff = diff;
    }

    // Update the part in the buffer
    const buffer = this.messageBuffers.get(sessionId);
    if (buffer) {
      this.upsertPart(buffer, toolPart);
    }

    this.emit("message.part.updated", {
      sessionId,
      messageId: toolPart.messageId,
      part: toolPart,
    });

    this.toolCallParts.delete(data.toolCallId);
  }

  // --- Tool Partial Result ---

  private handleToolPartialResult(
    sessionId: string,
    data: { toolCallId: string; partialOutput: string },
  ): void {
    const toolPart = this.toolCallParts.get(data.toolCallId);
    if (!toolPart) return;

    // Update the title with partial output for live feedback
    if (data.partialOutput && toolPart.state.status === "running") {
      // Keep existing title; partial output can be shown as running output
      // We don't overwrite the state, just emit an update
      this.emit("message.part.updated", {
        sessionId,
        messageId: toolPart.messageId,
        part: toolPart,
      });
    }
  }

  // --- Turn Lifecycle ---

  private handleTurnStart(
    sessionId: string,
    data: { turnId?: string },
  ): void {
    this.activeTurnSessions.add(sessionId);

    const buffer = this.getOrCreateBuffer(sessionId);

    // Emit step-start part
    const stepStartPart: StepStartPart = {
      id: timeId("part"),
      messageId: buffer.messageId,
      sessionId,
      type: "step-start",
    };
    buffer.parts.push(stepStartPart);
    this.emit("message.part.updated", {
      sessionId,
      messageId: buffer.messageId,
      part: stepStartPart,
    });
  }

  private handleTurnEnd(
    sessionId: string,
    data: { turnId?: string },
  ): void {
    this.activeTurnSessions.delete(sessionId);

    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return;

    // Flush text before emitting step-finish
    this.flushTextAccumulator(buffer, sessionId);

    // Emit step-finish part
    const stepFinishPart: StepFinishPart = {
      id: timeId("part"),
      messageId: buffer.messageId,
      sessionId,
      type: "step-finish",
    };
    buffer.parts.push(stepFinishPart);
    this.emit("message.part.updated", {
      sessionId,
      messageId: buffer.messageId,
      part: stepFinishPart,
    });
  }

  // --- Session Idle ---

  private handleSessionIdle(sessionId: string): void {
    const finalMessage = this.finalizeBuffer(sessionId);
    if (finalMessage) {
      const resolver = this.idleResolvers.get(sessionId);
      if (resolver) {
        this.idleResolvers.delete(sessionId);
        resolver(finalMessage);
      }
    }
  }

  // --- Title Changed ---

  private handleTitleChanged(
    sessionId: string,
    data: { title?: string },
  ): void {
    if (!data.title) return;

    const stored = sessionStore.getSession(sessionId);
    if (stored) {
      stored.title = data.title;
      stored.time.updated = Date.now();
      sessionStore.upsertSession(stored);
      this.emit("session.updated", { session: stored });
    }
  }

  // --- Session Error ---

  private handleSessionError(
    sessionId: string,
    data: { errorType?: string; message?: string; stack?: string; statusCode?: number },
  ): void {
    copilotLog.error(`Session ${sessionId} error:`, {
      type: data.errorType,
      message: data.message,
      statusCode: data.statusCode,
    });

    const buffer = this.messageBuffers.get(sessionId);
    if (buffer) {
      buffer.error = data.message ?? data.errorType ?? "Unknown error";
      const finalMessage = this.finalizeBuffer(sessionId);

      if (finalMessage) {
        const resolver = this.idleResolvers.get(sessionId);
        if (resolver) {
          this.idleResolvers.delete(sessionId);
          resolver(finalMessage);
        }
      }
    }
  }

  // --- Model Change ---

  private handleModelChange(
    sessionId: string,
    data: { previousModel?: string; newModel?: string },
  ): void {
    if (data.newModel) {
      this.currentModelId = data.newModel;
      copilotLog.info(`Model changed to ${data.newModel} (was: ${data.previousModel})`);
    }
  }

  // --- Mode Changed ---

  private handleModeChanged(
    sessionId: string,
    data: { previousMode?: string; newMode?: string },
  ): void {
    if (data.newMode) {
      this.sessionModes.set(sessionId, data.newMode);
      copilotLog.info(`Mode changed to ${data.newMode} for session ${sessionId}`);
    }
  }

  // --- Usage ---

  private handleUsage(
    sessionId: string,
    data: {
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cost?: number;
      duration?: number;
    },
  ): void {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return;

    buffer.tokens = {
      input: data.inputTokens ?? 0,
      output: data.outputTokens ?? 0,
      cache:
        data.cacheReadTokens || data.cacheWriteTokens
          ? {
              read: data.cacheReadTokens ?? 0,
              write: data.cacheWriteTokens ?? 0,
            }
          : undefined,
    };
    buffer.cost = data.cost;
    if (data.model) {
      buffer.modelId = data.model;
    }
  }

  // --- Abort ---

  private handleAbort(
    sessionId: string,
    data: { reason?: string },
  ): void {
    copilotLog.info(`Session ${sessionId} aborted: ${data.reason ?? "unknown"}`);
    const finalMessage = this.finalizeBuffer(sessionId);
    if (finalMessage) {
      const resolver = this.idleResolvers.get(sessionId);
      if (resolver) {
        this.idleResolvers.delete(sessionId);
        resolver(finalMessage);
      }
    }
  }

  // --- Subagent ---

  private handleSubagentStarted(
    sessionId: string,
    data: {
      toolCallId: string;
      agentName: string;
      agentDisplayName?: string;
      agentDescription?: string;
    },
  ): void {
    const buffer = this.getOrCreateBuffer(sessionId);

    // Flush text before subagent
    this.flushTextAccumulator(buffer, sessionId);

    const partId = timeId("part");
    const toolPart: ToolPart = {
      id: partId,
      messageId: buffer.messageId,
      sessionId,
      type: "tool",
      callId: data.toolCallId,
      normalizedTool: "task",
      originalTool: data.agentName,
      title: data.agentDisplayName ?? data.agentName,
      kind: "other",
      state: {
        status: "running",
        input: {
          agentName: data.agentName,
          description: data.agentDescription,
        },
        time: { start: Date.now() },
      },
    };

    this.toolCallParts.set(data.toolCallId, toolPart);
    buffer.parts.push(toolPart);
    this.emit("message.part.updated", {
      sessionId,
      messageId: buffer.messageId,
      part: toolPart,
    });
  }

  private handleSubagentCompleted(
    sessionId: string,
    data: { toolCallId: string; agentName: string; agentDisplayName?: string },
  ): void {
    const toolPart = this.toolCallParts.get(data.toolCallId);
    if (!toolPart) return;

    const now = Date.now();
    const startTime = toolPart.state.status === "running" ? toolPart.state.time.start : now;

    toolPart.state = {
      status: "completed",
      input: toolPart.state.status !== "pending" ? toolPart.state.input : {},
      output: `Subagent ${data.agentDisplayName ?? data.agentName} completed`,
      time: {
        start: startTime,
        end: now,
        duration: now - startTime,
      },
    };

    const buffer = this.messageBuffers.get(sessionId);
    if (buffer) {
      this.upsertPart(buffer, toolPart);
    }

    this.emit("message.part.updated", {
      sessionId,
      messageId: toolPart.messageId,
      part: toolPart,
    });

    this.toolCallParts.delete(data.toolCallId);
  }

  // ==========================================================================
  // Private — Permission Handling
  // ==========================================================================

  private handlePermissionRequest(
    req: PermissionRequest,
    ctx: { sessionId: string },
  ): Promise<PermissionRequestResult> {
    const sessionId = ctx.sessionId;

    // Auto-approve in autopilot mode
    const currentMode = this.sessionModes.get(sessionId) ?? "agent";
    if (currentMode === "autopilot") {
      copilotLog.info(`Auto-approved ${req.kind} permission in autopilot mode (session ${sessionId})`);
      return Promise.resolve({ kind: "approved" });
    }

    // Auto-approve if user previously selected "Always Allow" for this kind
    if (this.allowedAlwaysKinds.has(req.kind)) {
      copilotLog.info(`Auto-approved ${req.kind} permission via allow_always rule`);
      return Promise.resolve({ kind: "approved" });
    }

    const permissionId = timeId("perm");

    // Map permission kind to UI kind
    const kind: "read" | "edit" | "other" =
      req.kind === "read"
        ? "read"
        : req.kind === "write" || req.kind === "shell"
          ? "edit"
          : "other";

    // Extract title and input from the dynamic fields
    const title = (req as Record<string, unknown>).title as string
      ?? `${req.kind} permission requested`;
    const rawInput = { ...req };
    const diff = (req as Record<string, unknown>).diff as string | undefined;

    const options: PermissionOption[] = [
      { id: "allow_once", label: "Allow Once", type: "allow_once" },
      { id: "allow_always", label: "Always Allow", type: "allow_always" },
      { id: "reject_once", label: "Deny", type: "reject_once" },
    ];

    const permission: UnifiedPermission = {
      id: permissionId,
      sessionId,
      engineType: this.engineType,
      toolCallId: req.toolCallId,
      title,
      kind,
      diff,
      rawInput,
      options,
    };

    return new Promise<PermissionRequestResult>((resolve) => {
      this.pendingPermissions.set(permissionId, { resolve, permission });
      this.emit("permission.asked", { permission });
      copilotLog.info(`Permission requested: ${permissionId} (${req.kind})`);
    });
  }

  // ==========================================================================
  // Private — Question / User Input Handling
  // ==========================================================================

  private handleUserInputRequest(
    req: UserInputRequest,
    ctx: { sessionId: string },
  ): Promise<UserInputResponse> {
    const questionId = timeId("q");
    const sessionId = ctx.sessionId;

    // Build choices as QuestionOption[]
    const questionOptions = (req.choices ?? []).map((choice: string) => ({
      label: choice,
      description: "",
    }));

    const questionInfo: QuestionInfo = {
      question: req.question,
      header: req.question.length > 30 ? req.question.slice(0, 27) + "..." : req.question,
      options: questionOptions,
      multiple: false,
      custom: req.allowFreeform ?? true,
    };

    const question: UnifiedQuestion = {
      id: questionId,
      sessionId,
      engineType: this.engineType,
      questions: [questionInfo],
    };

    return new Promise<UserInputResponse>((resolve) => {
      this.pendingQuestions.set(questionId, { resolve, question });
      this.emit("question.asked", { question });
      copilotLog.info(`Question asked: ${questionId}`);
    });
  }

  // ==========================================================================
  // Private — Buffer Management
  // ==========================================================================

  /**
   * Get the current message buffer for a session, or create a new one.
   */
  private getOrCreateBuffer(sessionId: string): MessageBuffer {
    let buffer = this.messageBuffers.get(sessionId);
    if (!buffer) {
      buffer = {
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
    }
    return buffer;
  }

  /**
   * Flush the text accumulator into a finalized TextPart.
   * Called before tool calls and at turn boundaries.
   */
  private flushTextAccumulator(buffer: MessageBuffer, sessionId: string): void {
    if (buffer.textAccumulator && buffer.textPartId) {
      const textPart: TextPart = {
        id: buffer.textPartId,
        messageId: buffer.messageId,
        sessionId,
        type: "text",
        text: buffer.textAccumulator,
      };
      this.upsertPart(buffer, textPart);

      // Reset for next text segment (new part ID)
      buffer.textAccumulator = "";
      buffer.textPartId = null;
    }
  }

  /**
   * Insert or update a part in the buffer's parts array.
   */
  private upsertPart(buffer: MessageBuffer, part: UnifiedPart): void {
    const idx = buffer.parts.findIndex((p) => p.id === part.id);
    if (idx >= 0) {
      buffer.parts[idx] = part;
    } else {
      buffer.parts.push(part);
    }
  }

  /**
   * Finalize the current buffer into a complete UnifiedMessage,
   * append to history, emit events, and clean up.
   */
  private finalizeBuffer(sessionId: string): UnifiedMessage | null {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return null;

    // Flush any remaining text
    this.flushTextAccumulator(buffer, sessionId);

    const message = this.bufferToMessage(buffer, true);
    this.appendMessageToHistory(sessionId, message);

    this.emit("message.updated", { sessionId, message });

    // Update session time
    const stored = sessionStore.getSession(sessionId);
    if (stored) {
      stored.time.updated = Date.now();
      sessionStore.upsertSession(stored);
      this.emit("session.updated", { session: stored });
    }

    // Clean up
    this.messageBuffers.delete(sessionId);

    return message;
  }

  /**
   * Convert a buffer to a UnifiedMessage.
   */
  private bufferToMessage(buffer: MessageBuffer, completed: boolean): UnifiedMessage {
    const now = Date.now();
    return {
      id: buffer.messageId,
      sessionId: buffer.sessionId,
      role: "assistant",
      time: {
        created: buffer.startTime,
        completed: completed ? now : undefined,
      },
      parts: [...buffer.parts],
      tokens: buffer.tokens,
      cost: buffer.cost,
      modelId: buffer.modelId ?? this.currentModelId ?? undefined,
      error: buffer.error,
    };
  }

  // ==========================================================================
  // Private — User Message Creation
  // ==========================================================================

  private createUserMessage(
    sessionId: string,
    text: string,
    timestamp: number,
  ): UnifiedMessage {
    const messageId = timeId("msg");
    const partId = timeId("part");

    const textPart: TextPart = {
      id: partId,
      messageId,
      sessionId,
      type: "text",
      text,
    };

    return {
      id: messageId,
      sessionId,
      role: "user",
      time: {
        created: timestamp,
        completed: timestamp,
      },
      parts: [textPart],
    };
  }

  // ==========================================================================
  // Private — Message History
  // ==========================================================================

  private appendMessageToHistory(sessionId: string, message: UnifiedMessage): void {
    let history = this.messageHistory.get(sessionId);
    if (!history) {
      history = [];
      this.messageHistory.set(sessionId, history);
    }

    // Replace existing message with same ID, or append
    const idx = history.findIndex((m) => m.id === message.id);
    if (idx >= 0) {
      history[idx] = message;
    } else {
      history.push(message);
    }
  }

  // ==========================================================================
  // Private — Convert SDK Metadata → UnifiedSession
  // ==========================================================================

  private metadataToSession(meta: SessionMetadata): UnifiedSession {
    const directory = meta.context?.cwd
      ? meta.context.cwd.replaceAll("\\", "/")
      : homedir().replaceAll("\\", "/");

    return {
      id: meta.sessionId,
      engineType: this.engineType,
      directory,
      title: meta.summary,
      time: {
        created: meta.startTime.getTime(),
        updated: meta.modifiedTime.getTime(),
      },
      engineMeta: {
        isRemote: meta.isRemote,
        repository: meta.context?.repository,
        branch: meta.context?.branch,
        gitRoot: meta.context?.gitRoot,
      },
    };
  }

  // ==========================================================================
  // Private — Convert SDK ModelInfo → UnifiedModelInfo
  // ==========================================================================

  private sdkModelToUnified(model: ModelInfo): UnifiedModelInfo {
    return {
      modelId: model.id,
      name: model.name,
      engineType: this.engineType,
      capabilities: {
        attachment: model.capabilities?.supports?.vision ?? false,
        reasoning: model.capabilities?.supports?.reasoningEffort != null,
      },
      meta: {
        maxContextTokens: model.capabilities?.limits?.max_context_window_tokens,
        policy: (model as unknown as Record<string, unknown>).policy,
        billing: (model as unknown as Record<string, unknown>).billing,
      },
    };
  }

  // ==========================================================================
  // Private — Convert SessionEvent[] to UnifiedMessage[] (history replay)
  // ==========================================================================

  /**
   * Convert an array of SDK session events into UnifiedMessage[].
   * Used when loading historical messages from a resumed session.
   */
  private convertEventsToMessages(
    sessionId: string,
    events: SessionEvent[],
  ): UnifiedMessage[] {
    const messages: UnifiedMessage[] = [];
    let currentAssistantMsg: UnifiedMessage | null = null;
    let textAccum = "";
    let textPartId: string | null = null;
    let reasoningAccum = "";
    let reasoningPartId: string | null = null;

    const flushText = () => {
      if (textAccum && textPartId && currentAssistantMsg) {
        const existingIdx = currentAssistantMsg.parts.findIndex((p) => p.id === textPartId);
        const textPart: TextPart = {
          id: textPartId,
          messageId: currentAssistantMsg.id,
          sessionId,
          type: "text",
          text: textAccum,
        };
        if (existingIdx >= 0) {
          currentAssistantMsg.parts[existingIdx] = textPart;
        } else {
          currentAssistantMsg.parts.push(textPart);
        }
      }
      textAccum = "";
      textPartId = null;
    };

    const flushReasoning = () => {
      if (reasoningAccum && reasoningPartId && currentAssistantMsg) {
        const existingIdx = currentAssistantMsg.parts.findIndex((p) => p.id === reasoningPartId);
        const reasoningPart: ReasoningPart = {
          id: reasoningPartId,
          messageId: currentAssistantMsg.id,
          sessionId,
          type: "reasoning",
          text: reasoningAccum,
        };
        if (existingIdx >= 0) {
          currentAssistantMsg.parts[existingIdx] = reasoningPart;
        } else {
          currentAssistantMsg.parts.push(reasoningPart);
        }
      }
      reasoningAccum = "";
      reasoningPartId = null;
    };

    const ensureAssistantMessage = (): UnifiedMessage => {
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          id: timeId("msg"),
          sessionId,
          role: "assistant",
          time: { created: Date.now() },
          parts: [],
        };
      }
      return currentAssistantMsg;
    };

    const finalizeAssistant = () => {
      if (currentAssistantMsg) {
        flushText();
        flushReasoning();
        currentAssistantMsg.time.completed = Date.now();
        messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
    };

    // Track tool calls for history replay
    const replayToolParts = new Map<string, ToolPart>();

    for (const event of events) {
      switch (event.type) {
        case "user.message": {
          // Finalize any pending assistant message
          finalizeAssistant();

          const userData = event.data as { content?: string };
          const userMsg = this.createUserMessage(
            sessionId,
            userData.content ?? "",
            Date.now(),
          );
          messages.push(userMsg);
          break;
        }

        case "assistant.message_delta": {
          const msg = ensureAssistantMessage();
          const delta = event.data as { deltaContent: string };
          textAccum += delta.deltaContent;
          if (!textPartId) textPartId = timeId("part");
          break;
        }

        case "assistant.reasoning_delta": {
          ensureAssistantMessage();
          const rDelta = event.data as { deltaContent: string };
          reasoningAccum += rDelta.deltaContent;
          if (!reasoningPartId) reasoningPartId = timeId("part");
          break;
        }

        case "assistant.message": {
          const aData = event.data as { content?: string };
          if (aData.content && !textAccum) {
            const msg = ensureAssistantMessage();
            textAccum = aData.content;
            if (!textPartId) textPartId = timeId("part");
          }
          break;
        }

        case "tool.execution_start": {
          const msg = ensureAssistantMessage();
          flushText();

          const tData = event.data as {
            toolCallId: string;
            toolName: string;
            arguments?: unknown;
          };
          const normalizedTool = normalizeCopilotToolName(tData.toolName);
          const kind = inferToolKind(undefined, normalizedTool);
          const title = this.buildToolTitle(tData.toolName, normalizedTool, tData.arguments);
          const partId = timeId("part");

          const toolPart: ToolPart = {
            id: partId,
            messageId: msg.id,
            sessionId,
            type: "tool",
            callId: tData.toolCallId,
            normalizedTool,
            originalTool: tData.toolName,
            title,
            kind,
            state: {
              status: "running",
              input: tData.arguments ?? {},
              time: { start: Date.now() },
            },
          };

          replayToolParts.set(tData.toolCallId, toolPart);
          msg.parts.push(toolPart);
          break;
        }

        case "tool.execution_complete": {
          const cData = event.data as {
            toolCallId: string;
            success: boolean;
            result?: { content?: string; detailedContent?: string };
            error?: string;
          };

          const existingTool = replayToolParts.get(cData.toolCallId);
          if (existingTool) {
            const now = Date.now();
            const startTime =
              existingTool.state.status === "running"
                ? existingTool.state.time.start
                : now;

            if (cData.success) {
              existingTool.state = {
                status: "completed",
                input: existingTool.state.status !== "pending" ? existingTool.state.input : {},
                output: cData.result?.content ?? "",
                time: {
                  start: startTime,
                  end: now,
                  duration: now - startTime,
                },
              };
            } else {
              existingTool.state = {
                status: "error",
                input: existingTool.state.status !== "pending" ? existingTool.state.input : {},
                error: cData.error ?? "Failed",
                time: {
                  start: startTime,
                  end: now,
                  duration: now - startTime,
                },
              };
            }

            if (cData.result?.detailedContent) {
              existingTool.diff = cData.result.detailedContent;
            }

            replayToolParts.delete(cData.toolCallId);
          }
          break;
        }

        case "assistant.usage": {
          const msg = ensureAssistantMessage();
          {
            const uData = event.data as {
              model?: string;
              inputTokens?: number;
              outputTokens?: number;
              cacheReadTokens?: number;
              cacheWriteTokens?: number;
              cost?: number;
            };
            msg.tokens = {
              input: uData.inputTokens ?? 0,
              output: uData.outputTokens ?? 0,
              cache:
                uData.cacheReadTokens || uData.cacheWriteTokens
                  ? {
                      read: uData.cacheReadTokens ?? 0,
                      write: uData.cacheWriteTokens ?? 0,
                    }
                  : undefined,
            };
            msg.cost = uData.cost;
            if (uData.model) msg.modelId = uData.model;
          }
          break;
        }

        case "session.idle":
          finalizeAssistant();
          break;

        case "session.title_changed": {
          const tData = event.data as { title?: string };
          if (tData.title) {
            const stored = sessionStore.getSession(sessionId);
            if (stored) {
              stored.title = tData.title;
              sessionStore.upsertSession(stored);
            }
          }
          break;
        }

        default:
          // Skip events that don't contribute to message history
          break;
      }
    }

    // Finalize any remaining assistant message
    finalizeAssistant();

    return messages;
  }

  // ==========================================================================
  // Private — Utility
  // ==========================================================================

  /**
   * Build a human-readable title for a tool call.
   */
  private buildToolTitle(
    originalTool: string,
    normalizedTool: NormalizedToolName,
    args: unknown,
  ): string {
    const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

    switch (normalizedTool) {
      case "shell": {
        const cmd = (input.command as string) ?? "";
        const short = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
        return short || "Running command";
      }
      case "read": {
        const filePath = (input.path as string) ?? (input.file_path as string) ?? "";
        return filePath ? `Reading ${filePath}` : "Reading file";
      }
      case "write": {
        const filePath = (input.path as string) ?? (input.file_path as string) ?? "";
        return filePath ? `Writing ${filePath}` : "Writing file";
      }
      case "edit": {
        const filePath = (input.path as string) ?? (input.file_path as string) ?? "";
        return filePath ? `Editing ${filePath}` : "Editing file";
      }
      case "grep": {
        const pattern = (input.pattern as string) ?? (input.query as string) ?? "";
        return pattern ? `Searching for "${pattern}"` : "Searching";
      }
      case "glob": {
        const pattern = (input.pattern as string) ?? "";
        return pattern ? `Finding files matching ${pattern}` : "Finding files";
      }
      case "web_fetch": {
        const url = (input.url as string) ?? "";
        return url ? `Fetching ${url}` : "Fetching URL";
      }
      case "task":
        return (input.description as string) ?? "Running task";
      case "todo":
        return "Updating todos";
      case "list":
        return "Listing files";
      default:
        return originalTool;
    }
  }

  // ==========================================================================
  // Private — Cleanup Helpers
  // ==========================================================================

  private rejectAllPendingPermissions(reason: string): void {
    for (const [id, pending] of this.pendingPermissions) {
      pending.resolve({
        kind: "denied-no-approval-rule-and-could-not-request-from-user",
      });
    }
    this.pendingPermissions.clear();
  }

  private rejectAllPendingQuestions(reason: string): void {
    for (const [id, pending] of this.pendingQuestions) {
      pending.resolve({ answer: "", wasFreeform: true });
    }
    this.pendingQuestions.clear();
  }
}
