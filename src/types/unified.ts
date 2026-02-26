// ============================================================================
// Unified Type System for Multi-Agent-Engine Platform
// Engine-agnostic types used across frontend, gateway, and adapters.
// ============================================================================

// --- Engine ---

export type EngineType = "opencode" | "copilot" | "claude" | (string & {});

export type EngineStatus = "stopped" | "starting" | "running" | "error";

export interface EngineInfo {
  type: EngineType;
  name: string;
  version?: string;
  status: EngineStatus;
  capabilities: EngineCapabilities;
  authMethods?: AuthMethod[];
}

export interface EngineCapabilities {
  /** OpenCode uses Provider→Model hierarchy; ACP engines use flat list */
  providerModelHierarchy: boolean;
  /** Whether modes can change per session (ACP true, OpenCode static) */
  dynamicModes: boolean;
  /** Whether in-flight message cancellation is supported */
  messageCancellation: boolean;
  /** Whether "always allow" permission option is available */
  permissionAlways: boolean;
  /** Whether image attachments are supported in prompts */
  imageAttachment: boolean;
  /** Whether session history can be loaded */
  loadSession: boolean;
  /** Whether session listing is supported */
  listSessions: boolean;
  /** Available agent modes */
  availableModes: AgentMode[];
}

export interface AuthMethod {
  id: string;
  name: string;
  description: string;
  meta?: Record<string, unknown>;
}

// --- Mode ---

export interface AgentMode {
  /** Mode identifier. Full URI for ACP engines, short string for OpenCode */
  id: string;
  /** Human-readable label (e.g., "Agent", "Plan", "Build") */
  label: string;
  /** Optional description */
  description?: string;
}

// --- Model ---

export interface UnifiedModelInfo {
  modelId: string;
  name: string;
  description?: string;
  engineType: EngineType;
  /** Only populated for OpenCode (provider hierarchy) */
  providerId?: string;
  /** Only populated for OpenCode */
  providerName?: string;
  /** Engine-specific metadata (e.g., Copilot's copilotUsage/copilotEnablement) */
  meta?: Record<string, unknown>;
  /** Cost info (OpenCode provides this) */
  cost?: {
    input: number;
    output: number;
    cache?: { read: number; write: number };
  };
  /** Model capabilities */
  capabilities?: {
    temperature?: boolean;
    reasoning?: boolean;
    attachment?: boolean;
    toolcall?: boolean;
  };
}

// --- Session ---

export interface UnifiedSession {
  id: string;
  engineType: EngineType;
  directory: string;
  title?: string;
  parentId?: string;
  /** Resolved project ID — populated by SessionStore from (directory, engineType) */
  projectId?: string;
  time: {
    created: number;
    updated: number;
  };
  /** Engine-specific data (OpenCode: projectID, slug, summary, compacting, etc.) */
  engineMeta?: Record<string, unknown>;
}

// --- Message ---

export type MessageRole = "user" | "assistant";

export interface UnifiedMessage {
  /** ULID for OpenCode; synthetic UUID for ACP engines */
  id: string;
  sessionId: string;
  role: MessageRole;
  time: {
    created: number;
    completed?: number;
  };
  parts: UnifiedPart[];
  /** Token usage */
  tokens?: {
    input: number;
    output: number;
    cache?: { read: number; write: number };
    reasoning?: number;
  };
  cost?: number;
  modelId?: string;
  providerId?: string;
  mode?: string;
  error?: string;
  /** Engine-specific data (OpenCode: path, agent, system, summary flag) */
  engineMeta?: Record<string, unknown>;
}

// --- Part (discriminated union) ---

interface PartBase {
  /** Part ID: ULID for OpenCode, synthetic UUID for ACP */
  id: string;
  messageId: string;
  sessionId: string;
}

export interface TextPart extends PartBase {
  type: "text";
  text: string;
  synthetic?: boolean;
}

export interface ReasoningPart extends PartBase {
  type: "reasoning";
  text: string;
}

export interface FilePart extends PartBase {
  type: "file";
  mime: string;
  filename: string;
  url: string;
}

export interface StepStartPart extends PartBase {
  type: "step-start";
}

export interface StepFinishPart extends PartBase {
  type: "step-finish";
}

export interface SnapshotPart extends PartBase {
  type: "snapshot";
  files: string[];
}

export interface PatchPart extends PartBase {
  type: "patch";
  content: string;
  path: string;
}

export type ToolState =
  | { status: "pending"; input?: unknown; time?: { start: number } }
  | {
      status: "running";
      input: unknown;
      time: { start: number };
    }
  | {
      status: "completed";
      input: unknown;
      output: unknown;
      title?: string;
      time: { start: number; end: number; duration: number };
      metadata?: unknown;
    }
  | {
      status: "error";
      input: unknown;
      output?: unknown;
      error: string;
      time: { start: number; end: number; duration: number };
    };

export type NormalizedToolName =
  | "shell"
  | "read"
  | "write"
  | "edit"
  | "grep"
  | "glob"
  | "list"
  | "web_fetch"
  | "task"
  | "todo"
  | "sql"
  | "unknown";

export interface ToolPart extends PartBase {
  type: "tool";
  /** Engine-specific tool call ID */
  callId: string;
  /** Normalized tool name for renderer dispatch */
  normalizedTool: NormalizedToolName;
  /** Original engine tool name or inferred name */
  originalTool: string;
  /** Human-readable title (e.g., "Finding files matching *.ts") */
  title: string;
  /** Operation kind for UI hints */
  kind: "read" | "edit" | "other";
  /** Tool execution state */
  state: ToolState;
  /** File locations affected (from ACP's locations[]) */
  locations?: Array<{ path: string }>;
  /** Diff preview content (from ACP's rawOutput.detailedContent or rawInput.diff) */
  diff?: string;
}

export type UnifiedPart =
  | TextPart
  | ReasoningPart
  | FilePart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | ToolPart;

// --- Permission ---

export interface PermissionOption {
  id: string;
  label: string;
  /** Unified kind. ACP uses: allow_once, allow_always, reject_once, reject_always */
  type: "accept_once" | "accept_always" | "reject" | "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface UnifiedPermission {
  id: string;
  sessionId: string;
  engineType: EngineType;
  /** Related tool call ID */
  toolCallId?: string;
  /** Permission title / description */
  title: string;
  /** Operation kind */
  kind: "read" | "edit" | "other";
  /** Diff preview for write operations */
  diff?: string;
  /** Raw input for context */
  rawInput?: unknown;
  /** Available response options (2 for ACP, 3 for OpenCode) */
  options: PermissionOption[];
  /** OpenCode-specific fields */
  permission?: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
}

export interface PermissionReply {
  optionId: string;
}

// --- Project ---

export interface UnifiedProject {
  id: string;
  directory: string;
  name?: string;
  engineType: EngineType;
  /** Engine-specific data */
  engineMeta?: Record<string, unknown>;
}

// ============================================================================
// WebSocket Gateway Protocol Types
// ============================================================================

/**
 * Client → Gateway request.
 * requestId is used to correlate with GatewayResponse.
 */
export interface GatewayRequest {
  type: string;
  payload: unknown;
  requestId: string;
}

/**
 * Gateway → Client response to a specific request.
 */
export interface GatewayResponse {
  type: "response";
  requestId: string;
  payload: unknown;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Gateway → Client push notification (no requestId).
 */
export interface GatewayNotification {
  type: string;
  payload: unknown;
}

/** Union of all gateway messages the client can receive */
export type GatewayMessage = GatewayResponse | GatewayNotification;

// --- Request type constants ---

export const GatewayRequestType = {
  // Engine
  ENGINE_LIST: "engine.list",
  ENGINE_CAPABILITIES: "engine.capabilities",

  // Session
  SESSION_LIST: "session.list",
  SESSION_CREATE: "session.create",
  SESSION_GET: "session.get",
  SESSION_DELETE: "session.delete",
  SESSION_RENAME: "session.rename",

  // Message
  MESSAGE_SEND: "message.send",
  MESSAGE_CANCEL: "message.cancel",
  MESSAGE_LIST: "message.list",

  // Model
  MODEL_LIST: "model.list",
  MODEL_SET: "model.set",

  // Mode
  MODE_SET: "mode.set",

  // Permission
  PERMISSION_REPLY: "permission.reply",

  // Project
  PROJECT_LIST: "project.list",
  PROJECT_SET_ENGINE: "project.setEngine",
  PROJECT_LIST_ALL: "project.listAll",
  PROJECT_DELETE: "project.delete",

  // Session (all engines)
  SESSION_LIST_ALL: "session.listAll",

  // Legacy migration
  IMPORT_LEGACY_PROJECTS: "import.legacyProjects",

  // Logging (renderer → main)
  LOG_SEND: "log.send",
} as const;

// --- Notification type constants ---

export const GatewayNotificationType = {
  MESSAGE_PART_UPDATED: "message.part.updated",
  MESSAGE_UPDATED: "message.updated",
  SESSION_UPDATED: "session.updated",
  SESSION_CREATED: "session.created",
  PERMISSION_ASKED: "permission.asked",
  PERMISSION_REPLIED: "permission.replied",
  ENGINE_STATUS_CHANGED: "engine.status.changed",
} as const;

// --- Request / Response payload types ---

export interface SessionCreateRequest {
  engineType: EngineType;
  directory: string;
}

export interface MessageSendRequest {
  sessionId: string;
  content: MessagePromptContent[];
  mode?: string;
  modelId?: string;
}

export interface MessagePromptContent {
  type: "text" | "image";
  text?: string;
  /** Base64 or URL for image type */
  data?: string;
}

export interface PermissionReplyRequest {
  permissionId: string;
  optionId: string;
}

export interface ProjectSetEngineRequest {
  directory: string;
  engineType: EngineType;
}

export interface ModelSetRequest {
  sessionId: string;
  modelId: string;
}

export interface ModeSetRequest {
  sessionId: string;
  modeId: string;
}
