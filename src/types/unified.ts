// ============================================================================
// Unified Type System for Multi-Agent-Engine Platform
// Engine-agnostic types used across frontend, gateway, and adapters.
// ============================================================================

// --- Engine ---

export type EngineType = "opencode" | "copilot" | "claude" | (string & {});

export type SessionActivityStatus = "idle" | "running" | "completed" | "waiting" | "error" | "cancelled";

export type EngineStatus = "stopped" | "starting" | "running" | "error";

export interface EngineInfo {
  type: EngineType;
  name: string;
  version?: string;
  status: EngineStatus;
  capabilities: EngineCapabilities;
  authMethods?: AuthMethod[];
  /** Whether the engine is authenticated (undefined = not applicable) */
  authenticated?: boolean;
  /** Human-readable auth status message (e.g. username or error) */
  authMessage?: string;
}

export interface EngineCapabilities {
  /** OpenCode uses Provider→Model hierarchy; Copilot/Claude use flat list */
  providerModelHierarchy: boolean;
  /** Whether modes can change per session (Copilot/Claude true, OpenCode static) */
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
  /** Whether the user can switch models (false when env var overrides model) */
  modelSwitchable: boolean;
  /** Whether the user can type arbitrary model IDs not in the model list */
  customModelInput: boolean;
  /** Whether the engine supports enqueuing messages while another is being processed */
  messageEnqueue: boolean;
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
  /** Mode identifier. Full URI for Copilot/Claude, short string for OpenCode */
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

/** Result of listing models — includes which model is currently active */
export interface ModelListResult {
  models: UnifiedModelInfo[];
  currentModelId?: string;
}

// --- Conversation (self-owned persistence layer) ---

export interface ConversationMeta {
  id: string;
  engineType: EngineType;
  directory: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview?: string;
  /** Volatile engine session ID for resume (engine may clear this) */
  engineSessionId?: string;
  /** Engine-specific metadata (e.g. ccSessionId, projectID) */
  engineMeta?: Record<string, unknown>;
  /** True if this conversation was imported from engine history (don't delete engine data) */
  imported?: boolean;
}

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  time: { created: number; completed?: number };
  /** Content-only parts (text, file) — steps stored separately */
  parts: Array<TextPart | FilePart>;
  tokens?: {
    input: number;
    output: number;
    cache?: { read: number; write: number };
    reasoning?: number;
  };
  cost?: number;
  /** Unit for the cost field: "usd" (default) or "premium_requests" */
  costUnit?: "usd" | "premium_requests";
  modelId?: string;
  error?: string;
}

export interface StepsFile {
  version: 1;
  conversationId: string;
  /** messageId → step parts (reasoning, tool, step-start/finish, snapshot, patch) */
  messages: Record<string, UnifiedPart[]>;
}

/** Content part types stored in main conversation file */
export type ContentPart = TextPart | FilePart;

/** Step part types stored in separate steps file */
export type StepPart =
  | ReasoningPart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart;

// --- Session ---

export interface UnifiedSession {
  id: string;
  engineType: EngineType;
  directory: string;
  title?: string;
  parentId?: string;
  /** Resolved project ID — populated by ConversationStore/EngineManager from directory */
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
  /** ULID for OpenCode; synthetic UUID for Copilot/Claude */
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
  /** Unit for the cost field: "usd" (default) or "premium_requests" */
  costUnit?: "usd" | "premium_requests";
  modelId?: string;
  providerId?: string;
  mode?: string;
  error?: string;
  /** True when the engine session is stale and should be recreated */
  staleSession?: boolean;
  /** Working directory for file path resolution (populated by adapters) */
  workingDirectory?: string;
  /** True when this message is a context-compaction summary */
  isCompaction?: boolean;
  /** Engine-specific data — avoid accessing in frontend rendering logic */
  engineMeta?: Record<string, unknown>;
  /** Number of step parts (tool, reasoning, etc.) — used for lazy loading */
  stepCount?: number;
}

// --- Part (discriminated union) ---

interface PartBase {
  /** Part ID: ULID for OpenCode, synthetic UUID for Copilot/Claude */
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
  /** File locations affected (from SDK's locations[]) */
  locations?: Array<{ path: string }>;
  /** Diff preview content (from SDK's rawOutput.detailedContent or rawInput.diff) */
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
  /** Unified kind. Copilot/Claude use: allow_once, allow_always, reject_once, reject_always */
  type: "accept_once" | "accept_always" | "reject" | "allow_once" | "allow_always" | "reject_once" | "reject_always";
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
  /** Available response options (2 for Copilot/Claude, 3 for OpenCode) */
  options: PermissionOption[];
  /** OpenCode-specific fields */
  permission?: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
}

export interface PermissionReply {
  optionId: string;
}

// --- Question ---

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionInfo {
  /** The full question text */
  question: string;
  /** Short label (max 30 chars) */
  header: string;
  /** Available choices */
  options: QuestionOption[];
  /** Allow selecting multiple options */
  multiple?: boolean;
  /** Allow typing a custom answer (default: true) */
  custom?: boolean;
}

export interface UnifiedQuestion {
  id: string;
  sessionId: string;
  engineType: EngineType;
  /** Related tool call ID */
  toolCallId?: string;
  /** The questions to ask the user */
  questions: QuestionInfo[];
  metadata?: Record<string, unknown>;
}

export interface QuestionReplyRequest {
  questionId: string;
  /** Each element is the selected labels for the corresponding question */
  answers: string[][];
}

// --- Project ---

export interface UnifiedProject {
  id: string;
  directory: string;
  name?: string;
  /** Engine type — optional. Projects are engine-agnostic (sessions carry their own engineType). */
  engineType?: EngineType;
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
  MESSAGE_STEPS: "message.steps",

  // Model
  MODEL_LIST: "model.list",
  MODEL_SET: "model.set",

  // Mode
  MODE_GET: "mode.get",
  MODE_SET: "mode.set",

  // Permission
  PERMISSION_REPLY: "permission.reply",

  // Question
  QUESTION_REPLY: "question.reply",
  QUESTION_REJECT: "question.reject",

  // Project
  PROJECT_LIST: "project.list",
  PROJECT_SET_ENGINE: "project.setEngine",
  PROJECT_LIST_ALL: "project.listAll",
  PROJECT_DELETE: "project.delete",

  // Session (all engines)
  SESSION_LIST_ALL: "session.listAll",

  // Legacy migration
  IMPORT_LEGACY_PROJECTS: "import.legacyProjects",

  // Session import (from engine history)
  SESSION_IMPORT_PREVIEW: "session.import.preview",
  SESSION_IMPORT_EXECUTE: "session.import.execute",

  // Logging (renderer → main)
  LOG_SEND: "log.send",

  // Git
  GIT_STATUS: "git.status",
  GIT_FILE_DIFF: "git.fileDiff",
} as const;

// --- Notification type constants ---

export const GatewayNotificationType = {
  MESSAGE_PART_UPDATED: "message.part.updated",
  MESSAGE_UPDATED: "message.updated",
  SESSION_UPDATED: "session.updated",
  SESSION_CREATED: "session.created",
  PERMISSION_ASKED: "permission.asked",
  PERMISSION_REPLIED: "permission.replied",
  QUESTION_ASKED: "question.asked",
  QUESTION_REPLIED: "question.replied",
  QUESTION_REJECTED: "question.rejected",
  ENGINE_STATUS_CHANGED: "engine.status.changed",
  MESSAGE_QUEUED: "message.queued",
  MESSAGE_QUEUED_CONSUMED: "message.queued.consumed",
  SESSION_IMPORT_PROGRESS: "session.import.progress",
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
  /** Base64-encoded image data (without data: prefix) for image type */
  data?: string;
  /** MIME type for image (e.g. "image/png", "image/jpeg") */
  mimeType?: string;
}

/** Image attachment from the frontend, carried through gateway to adapters */
export interface ImageAttachment {
  /** Unique ID for this attachment */
  id: string;
  /** Display file name */
  name: string;
  /** MIME type (image/png, image/jpeg, image/gif, image/webp) */
  mimeType: string;
  /** Base64-encoded image data (without data: prefix) */
  data: string;
  /** Original file size in bytes (before base64 encoding) */
  size: number;
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

// --- Session Import types ---

export interface ImportableSession {
  engineSessionId: string;
  title: string;
  directory: string;
  createdAt: number;
  updatedAt: number;
  alreadyImported: boolean;
  engineMeta?: Record<string, unknown>;
}

export interface SessionImportPreviewRequest {
  engineType: EngineType;
  limit: number; // 10, 50, 100, or 0 for all
}

export interface SessionImportExecuteRequest {
  engineType: EngineType;
  sessions: Array<{
    engineSessionId: string;
    directory: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    engineMeta?: Record<string, unknown>;
  }>;
}

// --- Git types ---

export type GitFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

export interface GitFileChange {
  path: string;
  status: GitFileStatus;
  oldPath?: string;
  insertions?: number;
  deletions?: number;
}

export interface GitStatusResponse {
  isGitRepo: boolean;
  branch?: string;
  files: GitFileChange[];
}

export interface GitFileDiffResponse {
  diff: string;
  language: string;
}

export interface SessionImportProgress {
  total: number;
  completed: number;
  currentTitle: string;
  errors: string[];
}

export interface SessionImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}
