// ============================================================================
// Engine Adapter — Abstract interface for agent engine integration
// Each engine (OpenCode, Copilot CLI, Claude Code) implements this.
// ============================================================================

import { EventEmitter } from "events";
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
  ReasoningEffort,
  CodexServiceTier,
  ImportableSession,
  EngineCommand,
  CommandInvokeResult,
} from "../../../src/types/unified";

/**
 * Accumulates streaming events into a complete message.
 * Shared between all engine adapters that process streaming responses.
 */
export interface MessageBuffer {
  messageId: string;
  sessionId: string;
  parts: UnifiedPart[];
  textAccumulator: string;
  textPartId: string | null;
  reasoningAccumulator: string;
  reasoningPartId: string | null;
  planAccumulator?: string;
  planPartId?: string | null;
  startTime: number;
  tokens?: {
    input: number;
    output: number;
    cache?: { read: number; write: number };
    reasoning?: number;
  };
  cost?: number;
  costUnit?: "usd" | "premium_requests";
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  error?: string;
  workingDirectory?: string;
  activeTurnId?: string;
  engineMeta?: Record<string, unknown>;
  /** Set to true once leading whitespace has been trimmed from textAccumulator */
  leadingTrimmed?: boolean;
}

// --- Adapter Events ---

export interface EngineAdapterEvents {
  /** A message part was created or updated */
  "message.part.updated": (data: {
    sessionId: string;
    messageId: string;
    part: UnifiedPart;
  }) => void;

  /** A message was created or completed */
  "message.updated": (data: {
    sessionId: string;
    message: UnifiedMessage;
  }) => void;

  /** A session was updated (title, time, etc.) — partial updates allowed */
  "session.updated": (data: {
    session: Partial<UnifiedSession> & Pick<UnifiedSession, "id" | "engineType">;
  }) => void;

  /** A new session was created */
  "session.created": (data: { session: UnifiedSession }) => void;

  /** A permission request from the agent */
  "permission.asked": (data: { permission: UnifiedPermission }) => void;

  /** A permission was replied to */
  "permission.replied": (data: {
    permissionId: string;
    optionId: string;
  }) => void;

  /** A question request from the agent */
  "question.asked": (data: { question: UnifiedQuestion }) => void;

  /** A question was replied to */
  "question.replied": (data: {
    questionId: string;
    answers: string[][];
  }) => void;

  /** Engine status changed */
  "status.changed": (data: {
    engineType: EngineType;
    status: EngineStatus;
    error?: string;
  }) => void;

  /** A message was enqueued (submitted while engine is busy) */
  "message.queued": (data: {
    sessionId: string;
    messageId: string;
    queuePosition: number;
  }) => void;

  /** A previously queued message started being processed */
  "message.queued.consumed": (data: {
    sessionId: string;
    messageId: string;
  }) => void;

  /** Available slash commands / skills changed (e.g. after session init, Copilot skills reload) */
  "commands.changed": (data: {
    engineType: EngineType;
    commands: EngineCommand[];
  }) => void;
}

// Type-safe event emitter
export declare interface EngineAdapter {
  on<K extends keyof EngineAdapterEvents>(
    event: K,
    listener: EngineAdapterEvents[K],
  ): this;
  off<K extends keyof EngineAdapterEvents>(
    event: K,
    listener: EngineAdapterEvents[K],
  ): this;
  emit<K extends keyof EngineAdapterEvents>(
    event: K,
    ...args: Parameters<EngineAdapterEvents[K]>
  ): boolean;
}

/**
 * Abstract base class for engine adapters.
 * Each engine implementation extends this and provides concrete implementations
 * for all abstract methods.
 */
export abstract class EngineAdapter extends EventEmitter {
  abstract readonly engineType: EngineType;

  // --- Lifecycle ---

  /** Start the engine process */
  abstract start(): Promise<void>;

  /** Stop the engine process */
  abstract stop(): Promise<void>;

  /** Check if the engine is healthy and responsive */
  abstract healthCheck(): Promise<boolean>;

  /** Get current engine status */
  abstract getStatus(): EngineStatus;

  /** Get full engine info (type, version, status, capabilities) */
  abstract getInfo(): EngineInfo;

  // --- Capabilities ---

  /** Get engine capabilities and feature flags */
  abstract getCapabilities(): EngineCapabilities;

  /** Get available auth methods (e.g., Copilot login) */
  abstract getAuthMethods(): AuthMethod[];

  // --- Sessions ---

  /** Check whether the adapter knows about a session (has it in runtime state). */
  hasSession(_sessionId: string): boolean {
    return true; // Subclasses override; default assumes known for backward compat
  }

  /** List sessions, optionally filtered by directory */
  abstract listSessions(directory?: string): Promise<UnifiedSession[]>;

  /** Create a new session. Optional meta contains persisted engine metadata (e.g. ccSessionId). */
  abstract createSession(directory: string, meta?: Record<string, unknown>): Promise<UnifiedSession>;

  /** Get a specific session by ID */
  abstract getSession(sessionId: string): Promise<UnifiedSession | null>;

  /** Delete a session */
  abstract deleteSession(sessionId: string): Promise<void>;

  // --- Messages ---

  /**
   * Send a message/prompt to the engine.
   * The engine will emit message.part.updated and message.updated events
   * as the response streams in.
   */
  abstract sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: {
      mode?: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: CodexServiceTier | null;
      directory?: string;
    },
  ): Promise<UnifiedMessage>;

  /** Cancel an in-flight message */
  abstract cancelMessage(sessionId: string, directory?: string): Promise<void>;

  /** List messages for a session */
  abstract listMessages(sessionId: string): Promise<UnifiedMessage[]>;

  // --- Historical Import ---

  /** List historical sessions from the engine with a count limit (0 = all) */
  async listHistoricalSessions(limit: number): Promise<ImportableSession[]> {
    const sessions = await this.listSessions();
    sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
    const sliced = limit > 0 ? sessions.slice(0, limit) : sessions;
    return sliced.map((s) => ({
      engineSessionId: s.id,
      title: s.title ?? "Untitled",
      directory: s.directory,
      createdAt: s.time?.created ?? 0,
      updatedAt: s.time?.updated ?? 0,
      alreadyImported: false,
      engineMeta: s.engineMeta,
    }));
  }

  /**
   * Retrieve full message history for a historical session.
   * Unlike listMessages(), this works with sessions that are NOT active in memory.
   */
  abstract getHistoricalMessages(
    engineSessionId: string,
    directory: string,
    engineMeta?: Record<string, unknown>,
  ): Promise<UnifiedMessage[]>;

  // --- Models ---

  /** List available models */
  abstract listModels(): Promise<ModelListResult>;

  /** Set the active model for a session */
  abstract setModel(sessionId: string, modelId: string): Promise<void>;

  // --- Modes ---

  /** Get available modes */
  abstract getModes(): AgentMode[];

  /** Set the active mode for a session */
  abstract setMode(sessionId: string, modeId: string): Promise<void>;

  // --- Reasoning Effort ---

  /** Set the reasoning effort level for a session (no-op by default) */
  async setReasoningEffort(_sessionId: string, _effort: ReasoningEffort | null): Promise<void> {}

  /** Get the current reasoning effort level for a session */
  getReasoningEffort(_sessionId: string): ReasoningEffort | null {
    return null;
  }

  // --- Service Tier ---

  /** Set the service tier for a session (no-op by default) */
  async setServiceTier(_sessionId: string, _tier: CodexServiceTier | null): Promise<void> {}

  /** Get the current service tier for a session */
  getServiceTier(_sessionId: string): CodexServiceTier | null {
    return null;
  }

  // --- Permissions ---

  /** Reply to a permission request */
  abstract replyPermission(
    permissionId: string,
    reply: PermissionReply,
    sessionId?: string,
  ): Promise<void>;

  /**
   * List pending permission requests (not yet replied to).
   * Optionally filter by sessionId.
   * Default: returns empty array (engines without permission support).
   * Async so adapters backed by a remote authoritative server (OpenCode) can
   * query it directly instead of maintaining a drift-prone local mirror.
   */
  getPendingPermissions(_sessionId?: string): Promise<UnifiedPermission[]> | UnifiedPermission[] {
    return [];
  }

  // --- Questions ---

  /** Reply to a question request */
  abstract replyQuestion(
    questionId: string,
    answers: string[][],
    sessionId?: string,
  ): Promise<void>;

  /** Reject/dismiss a question request */
  abstract rejectQuestion(
    questionId: string,
    sessionId?: string,
  ): Promise<void>;

  /**
   * List pending question requests (not yet answered).
   * Optionally filter by sessionId.
   * Default: returns empty array (engines without question support).
   */
  getPendingQuestions(_sessionId?: string): Promise<UnifiedQuestion[]> | UnifiedQuestion[] {
    return [];
  }

  /**
   * Filter a Map of pending entries by engine-side sessionId. Shared helper
   * used by Copilot/Claude/Codex whose pending Maps hold `{ ...; question }`
   * or `{ ...; permission }` value shapes — each knows how to project out the
   * UnifiedQuestion/UnifiedPermission. When `sessionId` is undefined we still
   * must not match entries with a nullish session id on either side (that
   * would bypass filtering); callers already avoid passing undefined.
   */
  protected static filterPending<V, R>(
    map: Map<string, V>,
    sessionId: string | undefined,
    project: (v: V) => R,
    getSessionId: (v: V) => string | undefined,
  ): R[] {
    const out: R[] = [];
    for (const v of map.values()) {
      if (!sessionId || getSessionId(v) === sessionId) out.push(project(v));
    }
    return out;
  }

  // --- Projects ---

  /** List projects (directories with engine bindings) */
  abstract listProjects(): Promise<UnifiedProject[]>;

  // --- Slash Commands / Skills ---

  /**
   * List available slash commands for this engine.
   * Default: returns empty array (engine doesn't support commands).
   * @param sessionId Optional session ID for session-scoped command lists
   * @param directory Optional working directory (for resuming/creating sessions to fetch commands)
   */
  async listCommands(_sessionId?: string, _directory?: string): Promise<EngineCommand[]> {
    return [];
  }

  /**
   * Invoke a slash command. Returns a result indicating whether the command
   * was handled natively or should fall through to sendMessage.
   *
   * Default: returns { handledAsCommand: false }, causing the caller to
   * fall back to sending "/commandName args" as a regular message.
   */
  async invokeCommand(
    _sessionId: string,
    _commandName: string,
    _args: string,
    _options?: { mode?: string; modelId?: string; reasoningEffort?: ReasoningEffort | null; serviceTier?: CodexServiceTier | null; directory?: string },
  ): Promise<CommandInvokeResult> {
    return { handledAsCommand: false };
  }
}
