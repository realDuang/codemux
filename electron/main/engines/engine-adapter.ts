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
} from "../../../src/types/unified";

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

  /** A session was updated (title, time, etc.) */
  "session.updated": (data: { session: UnifiedSession }) => void;

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

  /** List sessions, optionally filtered by directory */
  abstract listSessions(directory?: string): Promise<UnifiedSession[]>;

  /** Create a new session */
  abstract createSession(directory: string): Promise<UnifiedSession>;

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
    },
  ): Promise<UnifiedMessage>;

  /** Cancel an in-flight message */
  abstract cancelMessage(sessionId: string): Promise<void>;

  /** List messages for a session */
  abstract listMessages(sessionId: string): Promise<UnifiedMessage[]>;

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

  // --- Permissions ---

  /** Reply to a permission request */
  abstract replyPermission(
    permissionId: string,
    reply: PermissionReply,
  ): Promise<void>;

  // --- Questions ---

  /** Reply to a question request */
  abstract replyQuestion(
    questionId: string,
    answers: string[][],
  ): Promise<void>;

  /** Reject/dismiss a question request */
  abstract rejectQuestion(
    questionId: string,
  ): Promise<void>;

  // --- Projects ---

  /** List projects (directories with engine bindings) */
  abstract listProjects(): Promise<UnifiedProject[]>;
}
