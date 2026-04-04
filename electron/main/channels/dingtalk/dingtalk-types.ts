// ============================================================================
// DingTalk Channel Types
// Type definitions for the DingTalk bot channel adapter.
// Architecture: One Group Chat = One CodeMux Session (same as Feishu adapter)
// ============================================================================

import type { EngineType, UnifiedProject, UnifiedSession } from "../../../../src/types/unified";
import type { BaseGroupBinding } from "../base-session-mapper";

// Re-export shared streaming types for convenience
export type { StreamingSession } from "../streaming/streaming-types";
export { createStreamingSession } from "../streaming/streaming-types";
import { GATEWAY_PORT } from "../../../../shared/ports";

// --- DingTalk Configuration ---

export interface DingTalkConfig {
  /** DingTalk Open Platform App Key */
  appKey: string;
  /** DingTalk Open Platform App Secret */
  appSecret: string;
  /** Robot code (robotCode) for sending messages */
  robotCode: string;
  /** Use Stream mode (WebSocket) for receiving events (recommended) */
  useStreamMode: boolean;
  /** Auto-approve all permission requests from engines */
  autoApprovePermissions: boolean;
  /** Throttle interval (ms) for streaming message updates */
  streamingThrottleMs: number;
  /** Gateway WebSocket URL */
  gatewayUrl: string;
}

export const DEFAULT_DINGTALK_CONFIG: DingTalkConfig = {
  appKey: "",
  appSecret: "",
  robotCode: "",
  useStreamMode: true,
  autoApprovePermissions: true,
  streamingThrottleMs: 1500,
  gatewayUrl: `ws://127.0.0.1:${GATEWAY_PORT}`,
};

/** TTL for temporary P2P sessions (2 hours in ms) */
export const TEMP_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// --- Group Binding (One Group = One Session) ---

/** Binding between a DingTalk group and a CodeMux session */
export interface DingTalkGroupBinding extends BaseGroupBinding {
  /** DingTalk user ID of the person who initiated this group */
  ownerUserId: string;
}

// --- P2P Chat State ---

/** P2P chat state — entry point and optional temporary session */
export interface DingTalkP2PChatState {
  chatId: string;
  /** DingTalk staff ID or sender ID */
  userId: string;
  /** Sender nick for display */
  senderNick?: string;
  /** Last selected project (for UX continuity) */
  lastSelectedProject?: {
    directory: string;
    engineType?: EngineType;
    projectId: string;
  };
  /** Pending selection state for text-based command interaction */
  pendingSelection?: DingTalkPendingSelection;
  /** Temporary session for direct P2P interaction (no group creation, 2h TTL) */
  tempSession?: DingTalkTempSession;
}

/** Temporary session bound to P2P chat */
export interface DingTalkTempSession {
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
export interface DingTalkPendingSelection {
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

// --- DingTalk Message Event ---

/** DingTalk message event from Stream callback */
export interface DingTalkMessageEvent {
  /** DingTalk conversation ID */
  conversationId: string;
  /** Corp ID of the chatbot */
  chatbotCorpId?: string;
  /** User ID of the chatbot */
  chatbotUserId: string;
  /** Unique message ID */
  msgId: string;
  /** Display name of the sender */
  senderNick: string;
  /** Whether the sender is an admin */
  isAdmin?: boolean;
  /** Sender staff ID (enterprise internal user) */
  senderStaffId?: string;
  /** Session webhook expiration time (for webhook-based replies) */
  sessionWebhookExpiredTime?: number;
  /** Message creation timestamp */
  createAt?: number;
  /** Corp ID of the sender */
  senderCorpId?: string;
  /** Conversation type: "1" = individual, "2" = group */
  conversationType: "1" | "2";
  /** Users @mentioned in the message */
  atUsers?: Array<{ dingtalkId: string; staffId?: string }>;
  /** Group chat ID (only present in group messages) */
  chatId?: string;
  /** Whether the bot is in the @mention list */
  isInAtList?: boolean;
  /** Text content of the message */
  text: { content: string };
  /** Message type (e.g., "text") */
  msgtype: string;
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
