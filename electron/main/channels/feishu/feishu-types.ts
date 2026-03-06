// ============================================================================
// Feishu Channel Types
// Type definitions for the Feishu (Lark) bot channel adapter.
// Architecture: One Group Chat = One CodeMux Session
// ============================================================================

import type { EngineType, UnifiedProject, UnifiedSession } from "../../../../src/types/unified";

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

// --- Streaming State ---

export interface StreamingSession {
  /** Feishu message ID (obtained after initial send) */
  feishuMessageId: string;
  /** CodeMux conversation ID */
  conversationId: string;
  /** CodeMux message ID */
  messageId: string;
  /** Accumulated text content (text parts are cumulative, not incremental) */
  textBuffer: string;
  /** Timestamp of last PATCH call */
  lastPatchTime: number;
  /** Pending patch timer */
  patchTimer: ReturnType<typeof setTimeout> | null;
  /** Whether the message is completed */
  completed: boolean;
  /** Tool call counts for summary (toolName → count) */
  toolCounts: Map<string, number>;
}

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

/** P2P chat state — entry point only, no engine interaction */
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
    operator_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
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
  operator_id?: {
    union_id?: string;
    user_id?: string;
    open_id?: string;
  };
  name?: string;
}

export interface FeishuBotRemovedEvent {
  chat_id?: string;
  operator_id?: {
    union_id?: string;
    user_id?: string;
    open_id?: string;
  };
  name?: string;
}
