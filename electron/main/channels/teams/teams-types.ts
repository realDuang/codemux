// ============================================================================
// Microsoft Teams Channel Types
// Type definitions for the Teams bot channel adapter.
// Architecture: P2P (personal chat) is the primary interaction mode.
// Group/channel chats supported when bot is added — bot cannot create teams.
//
// Bot Framework REST API — no botbuilder SDK dependency.
// Auth: Azure AD App Registration (App ID + App Password).
// ============================================================================

import type { EngineType, UnifiedProject, UnifiedSession } from "../../../../src/types/unified";
import type { BaseGroupBinding } from "../base-session-mapper";

// Re-export shared streaming types for convenience
export type { StreamingSession } from "../streaming/streaming-types";
export { createStreamingSession } from "../streaming/streaming-types";

// --- Teams Configuration ---

export interface TeamsConfig {
  /** Azure AD App Registration client ID */
  microsoftAppId: string;
  /** Azure AD App Registration client secret */
  microsoftAppPassword: string;
  /** Azure AD tenant ID (required for SingleTenant bots) */
  tenantId: string;
  /** Auto-approve all permission requests from engines */
  autoApprovePermissions: boolean;
  /** Throttle interval (ms) for streaming message updates */
  streamingThrottleMs: number;
  /** Skip JWT validation in dev mode (default: false) */
  skipAuth: boolean;
  /** Gateway WebSocket URL */
  gatewayUrl: string;
}

export const DEFAULT_TEAMS_CONFIG: TeamsConfig = {
  microsoftAppId: "",
  microsoftAppPassword: "",
  tenantId: "",
  autoApprovePermissions: true,
  streamingThrottleMs: 1500,
  skipAuth: false,
  gatewayUrl: "ws://127.0.0.1:4200",
};

/** TTL for temporary P2P sessions (2 hours in ms) */
export const TEMP_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// --- Group Binding ---

/**
 * Binding between a Teams conversation and a CodeMux session.
 * Teams bots cannot create teams/channels — bindings are created when the bot
 * receives a message in an existing group or channel where it has been added.
 */
export interface TeamsGroupBinding extends BaseGroupBinding {
  /** Teams service URL for this conversation (needed for API calls) */
  serviceUrl: string;
}

// --- P2P Chat State ---

export interface TeamsP2PChatState {
  chatId: string;
  /** Teams user AAD object ID or bot framework ID */
  userId: string;
  /** Display name */
  displayName?: string;
  /** Last selected project (for UX continuity) */
  lastSelectedProject?: {
    directory: string;
    engineType: EngineType;
    projectId: string;
  };
  /** Pending selection state for text-based command interaction */
  pendingSelection?: TeamsPendingSelection;
  /** Temporary session for direct P2P interaction (no group creation, 2h TTL) */
  tempSession?: TeamsTempSession;
}

/** Temporary session bound to P2P chat */
export interface TeamsTempSession {
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
export interface TeamsPendingSelection {
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

// --- Bot Framework Activity Types (simplified — only fields we use) ---

/** Bot Framework Activity */
export interface TeamsActivity {
  /** Activity type: "message", "conversationUpdate", "invoke", "event" */
  type: string;
  /** Activity ID */
  id: string;
  /** ISO timestamp */
  timestamp: string;
  /** Service URL for API callbacks (e.g., "https://smba.trafficmanager.net/amer/") */
  serviceUrl: string;
  /** Channel identifier — always "msteams" */
  channelId: string;
  /** Sender info */
  from: { id: string; name?: string; aadObjectId?: string };
  /** Conversation context */
  conversation: {
    id: string;
    conversationType?: "personal" | "groupChat" | "channel";
    tenantId?: string;
    isGroup?: boolean;
  };
  /** Bot (recipient) info */
  recipient: { id: string; name?: string };
  /** Message text content */
  text?: string;
  /** Text format (e.g., "plain", "markdown") */
  textFormat?: string;
  /** Attachments (e.g., Adaptive Cards) */
  attachments?: Array<{ contentType: string; content: unknown }>;
  /** Entities (e.g., @mentions) */
  entities?: Array<{
    type: string;
    mentioned?: { id: string; name: string };
    text?: string;
  }>;
  /** Channel-specific data */
  channelData?: Record<string, unknown>;
  /** Reply-to activity ID */
  replyToId?: string;
  /** Value from Adaptive Card Action.Submit */
  value?: unknown;
  /** Members added (for conversationUpdate) */
  membersAdded?: Array<{ id: string; name?: string }>;
  /** Members removed (for conversationUpdate) */
  membersRemoved?: Array<{ id: string; name?: string }>;
}

/** Conversation reference for proactive messaging */
export interface TeamsConversationReference {
  serviceUrl: string;
  conversationId: string;
  botId: string;
  tenantId?: string;
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

// --- Persisted Binding Extension ---

export interface TeamsPersistedBinding {
  chatId: string;
  conversationId: string;
  engineType: string;
  directory: string;
  projectId: string;
  createdAt: number;
  serviceUrl: string;
}
