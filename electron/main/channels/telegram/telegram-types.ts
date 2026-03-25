// ============================================================================
// Telegram Channel Types
// Type definitions for the Telegram bot channel adapter.
// Architecture: P2P (private chat) is the primary interaction mode.
// Group chats are supported when bot is added by user — bot cannot create groups.
// ============================================================================

import type { EngineType, UnifiedProject, UnifiedSession } from "../../../../src/types/unified";
import type { BaseGroupBinding } from "../base-session-mapper";

// Re-export shared streaming types for convenience
export type { StreamingSession } from "../streaming/streaming-types";
export { createStreamingSession } from "../streaming/streaming-types";
import { GATEWAY_PORT } from "../../../../shared/ports";

// --- Telegram Configuration ---

export interface TelegramConfig {
  /** Telegram Bot API token from @BotFather */
  botToken: string;
  /** HTTPS URL for webhook mode; empty string = long polling */
  webhookUrl?: string;
  /** Secret token for webhook verification (X-Telegram-Bot-Api-Secret-Token) */
  webhookSecretToken?: string;
  /** Auto-approve all permission requests from engines */
  autoApprovePermissions: boolean;
  /** Throttle interval (ms) for streaming message updates */
  streamingThrottleMs: number;
  /** Use sendMessageDraft for streaming output (Bot API 9.3+, private chats only) */
  useMessageDraft: boolean;
  /** Gateway WebSocket URL */
  gatewayUrl: string;
}

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  botToken: "",
  webhookUrl: "",
  webhookSecretToken: "",
  autoApprovePermissions: true,
  streamingThrottleMs: 1500,
  useMessageDraft: true,
  gatewayUrl: `ws://127.0.0.1:${GATEWAY_PORT}`,
};

/** TTL for temporary P2P sessions (2 hours in ms) */
export const TEMP_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// --- Group Binding ---

/**
 * Binding between a Telegram group chat and a CodeMux session.
 * Telegram bots cannot create groups — bindings are created when the bot
 * receives a message in an existing group where it has been added.
 */
export interface TelegramGroupBinding extends BaseGroupBinding {
  // No extra fields needed for Telegram
}

// --- P2P Chat State ---

export interface TelegramP2PChatState {
  chatId: string;
  /** Telegram user ID */
  userId: string;
  /** Display name (first_name + username) */
  displayName?: string;
  /** Last selected project (for UX continuity) */
  lastSelectedProject?: {
    directory: string;
    engineType: EngineType;
    projectId: string;
  };
  /** Pending selection state for text-based command interaction */
  pendingSelection?: TelegramPendingSelection;
  /** Temporary session for direct P2P interaction (no group creation, 2h TTL) */
  tempSession?: TelegramTempSession;
}

/** Temporary session bound to P2P chat */
export interface TelegramTempSession {
  /** CodeMux session/conversation ID */
  conversationId: string;
  /** Engine type for this session */
  engineType: EngineType;
  /** Project directory */
  directory: string;
  /** Project ID */
  projectId: string;
  /** Timestamp of last message sent or received */
  lastActiveAt: number;
  /** Current streaming session (if any) */
  streamingSession?: import("../streaming/streaming-types").StreamingSession;
  /** Message queue for serial processing */
  messageQueue: string[];
  /** Whether currently processing a message */
  processing: boolean;
}

/** Pending selection context for P2P text-based project/session selection */
export interface TelegramPendingSelection {
  type: "project" | "session";
  /** Cached project list for number→project mapping (type="project") */
  projects?: UnifiedProject[];
  /** Cached session list for number→session mapping (type="session") */
  sessions?: UnifiedSession[];
  /** Project context for session selection (type="session") */
  engineType?: EngineType;
  directory?: string;
  projectId?: string;
  projectName?: string;
}

// --- Telegram Update Types (simplified) ---

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    first_name: string;
    username?: string;
    is_bot?: boolean;
  };
  chat: {
    id: number;
    type: "private" | "group" | "supergroup" | "channel";
    title?: string;
  };
  date: number;
  text?: string;
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
  }>;
}

export interface TelegramCallbackQuery {
  id: string;
  from: {
    id: number;
    first_name: string;
    username?: string;
  };
  message?: TelegramMessage;
  data?: string;
}

// --- Command Parser Types ---

export interface ParsedCommand {
  /** Top-level command name (e.g., "project", "session", "engine") */
  command: string;
  /** Sub-command (e.g., "list", "new", "switch") */
  subcommand?: string;
  /** Remaining arguments */
  args: string[];
  /** Original raw text */
  raw: string;
}

// --- Pending Question State ---

/** Tracks a pending question awaiting user reply in a chat */
export interface PendingQuestion {
  questionId: string;
  sessionId: string;
}
