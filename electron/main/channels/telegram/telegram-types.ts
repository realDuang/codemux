// ============================================================================
// Telegram Channel Types
// Type definitions for the Telegram bot channel adapter.
// Architecture: P2P (private chat) is the primary interaction mode.
// Group chats are supported when bot is added by user — bot cannot create groups.
// ============================================================================

import type { EngineType, MessagePromptContent, UnifiedProject, UnifiedSession } from "../../../../src/types/unified";
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

// Image limits are sourced from the shared module so frontend, channels, and
// the gateway-side persistence path stay in sync.
export {
  MAX_IMAGE_SIZE_BYTES as MAX_TELEGRAM_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE as MAX_TELEGRAM_IMAGES_PER_MESSAGE,
  MAX_TOTAL_IMAGE_BYTES as MAX_TELEGRAM_TOTAL_IMAGE_BYTES,
} from "../../../../shared/image-limits";

/**
 * A queued Telegram user message awaiting engine dispatch. Carries
 * already-built MessagePromptContent so the queue worker can call
 * sendMessage directly without re-downloading images.
 */
export interface QueuedTelegramMessage {
  /** Plain-text preview for logging only. */
  text: string;
  /** Ordered prompt content (text + image parts) sent to the engine. */
  content: MessagePromptContent[];
}

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
    engineType?: EngineType;
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
  messageQueue: QueuedTelegramMessage[];
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
  /** Caption present when the message is a photo/document carrying a description. */
  caption?: string;
  /**
   * Photo sizes (smallest → largest). We use the largest entry for fidelity.
   * Empty array when the message is not a photo.
   */
  photo?: Array<{
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
  }>;
  /**
   * Document attachment — Telegram delivers images as `document` when the
   * sender opts out of recompression (e.g. PNG with transparency). We only
   * accept ones whose `mime_type` starts with `image/`.
   */
  document?: {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
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
// (ParsedCommand moved to ../shared/command-types.ts)


// --- Pending Question State ---

/** Tracks a pending question awaiting user reply in a chat */
export interface PendingQuestion {
  questionId: string;
  sessionId: string;
}
