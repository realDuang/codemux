// ============================================================================
// Feishu Channel Types
// Type definitions for the Feishu (Lark) bot channel adapter.
// Architecture: One Group Chat = One CodeMux Session
// ============================================================================

import type { EngineType, UnifiedProject, UnifiedSession } from "../../../../src/types/unified";
import type { StreamingSession } from "../streaming/streaming-types";

// Re-export shared types for backward compatibility
export type { StreamingSession } from "../streaming/streaming-types";
export { createStreamingSession } from "../streaming/streaming-types";

// --- Feishu Configuration ---

export interface FeishuConfig {
  /** Feishu Open Platform App ID */
  appId: string;
  /** Feishu Open Platform App Secret */
  appSecret: string;
  /** Auto-approve all permission requests from engines */
  autoApprovePermissions: boolean;
  /** Throttle interval (ms) for streaming message PATCH updates */
  streamingThrottleMs: number;
  /** Gateway WebSocket URL */
  gatewayUrl: string;
}

export const DEFAULT_FEISHU_CONFIG: FeishuConfig = {
  appId: "",
  appSecret: "",
  autoApprovePermissions: true,
  streamingThrottleMs: 1500,
  gatewayUrl: "ws://127.0.0.1:4200",
};

/** TTL for temporary P2P sessions (2 hours in ms) */
export const TEMP_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// --- Streaming State ---

// StreamingSession is now defined in ../streaming/streaming-types.ts
// and re-exported above for backward compatibility.

// --- Group Binding (One Group = One Session) ---

/** Binding between a Feishu group chat and a CodeMux session */
export interface GroupBinding {
  /** Feishu group chat_id */
  chatId: string;
  /** Bound CodeMux conversation ID */
  conversationId: string;
  /** Engine type for this session */
  engineType: EngineType;
  /** Project directory */
  directory: string;
  /** Project ID */
  projectId: string;
  /** User's open_id who initiated this group */
  ownerOpenId: string;
  /** Map of CodeMux messageId → StreamingSession */
  streamingSessions: Map<string, StreamingSession>;
  /** Timestamp when binding was created */
  createdAt: number;
}

// --- P2P Chat State (Entry Point Only) ---

/** P2P chat state — entry point and optional temporary session */
export interface P2PChatState {
  chatId: string;
  /** open_id of the user in this P2P chat */
  openId: string;
  /** Last selected project (for UX continuity) */
  lastSelectedProject?: {
    directory: string;
    engineType: EngineType;
    projectId: string;
  };
  /** Pending selection state for text-based command interaction */
  pendingSelection?: PendingSelection;
  /** Temporary session for direct P2P interaction (no group creation, 2h TTL) */
  tempSession?: TempSession;
}

/** Temporary session bound to P2P chat (no group creation, 2h TTL) */
export interface TempSession {
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
  streamingSession?: StreamingSession;
  /** Message queue for serial processing */
  messageQueue: string[];
  /** Whether currently processing a message */
  processing: boolean;
  /** Whether the usage hint has been shown for this temp session */
  hintShown?: boolean;
}

/** Pending selection context for P2P text-based project/session selection */
export interface PendingSelection {
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

// --- Pending Question State ---

/** Tracks a pending question awaiting user reply in a chat */
export interface PendingQuestion {
  questionId: string;
  sessionId: string;
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

// --- Feishu Shared Types ---

/** Shared Feishu Open Platform user identifier shape */
export interface FeishuUserId {
  union_id?: string;
  user_id?: string;
  open_id?: string;
}

// --- Feishu Bot Menu Event Data ---

export interface FeishuBotMenuEvent {
  event_id?: string;
  event_type?: string;
  app_id?: string;
  /** The event_key configured for this menu item in developer console */
  event_key?: string;
  /** Operator (user who clicked the menu) */
  operator?: {
    operator_name?: string;
    operator_id?: FeishuUserId;
  };
  timestamp?: number;
  tenant_key?: string;
}

// --- Feishu Message Event Data ---

export interface FeishuMessageEvent {
  message: {
    chat_id: string;
    chat_type: "group" | "p2p";
    content: string;
    message_id: string;
    message_type: string;
    mentions?: Array<{
      id: { open_id: string; union_id?: string };
      key: string;
      name: string;
    }>;
  };
  sender: {
    sender_id: {
      open_id: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
  };
}

// --- Feishu Group Lifecycle Events ---

export interface FeishuChatDisbandedEvent {
  chat_id?: string;
  operator_id?: FeishuUserId;
  name?: string;
}

export interface FeishuBotRemovedEvent {
  chat_id?: string;
  operator_id?: FeishuUserId;
  name?: string;
}

export interface FeishuUserRemovedEvent {
  chat_id?: string;
  operator_id?: FeishuUserId;
  users?: Array<{
    name?: string;
    tenant_key?: string;
    user_id?: FeishuUserId;
  }>;
}
