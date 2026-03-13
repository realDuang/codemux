// ============================================================================
// Streaming Types — Shared types for streaming session management
// Used by StreamingController and all channel adapters.
// ============================================================================

/** Configuration for streaming behavior */
export interface StreamingConfig {
  /** Throttle interval (ms) between message update API calls */
  throttleMs: number;
}

/** State for a single streaming (in-progress) message */
export interface StreamingSession {
  /** Platform-specific message ID for the current streaming message */
  platformMessageId: string;
  /** CodeMux conversation (session) ID */
  conversationId: string;
  /** CodeMux message ID */
  messageId: string;
  /** Platform chat/channel ID — needed for creating new segment messages */
  chatId: string;
  /** Accumulated text content (text parts are cumulative, not incremental) */
  textBuffer: string;
  /** Current text part ID — used to detect segment transitions */
  currentTextPartId?: string;
  /** Timestamp of last update API call */
  lastPatchTime: number;
  /** Pending throttle timer */
  patchTimer: ReturnType<typeof setTimeout> | null;
  /** Whether the message is completed */
  completed: boolean;
  /** Whether sendFinalReply has already been called (prevents duplicate cards) */
  finalReplySent: boolean;
  /** Tool call counts for summary (normalizedToolName → count) */
  toolCounts: Map<string, number>;
  /** Session title (updated dynamically when session.updated fires) */
  sessionTitle?: string;
}

/** Create a new StreamingSession with default values */
export function createStreamingSession(
  chatId: string,
  conversationId: string,
  platformMessageId: string,
): StreamingSession {
  return {
    platformMessageId,
    conversationId,
    messageId: "",
    chatId,
    textBuffer: "",
    lastPatchTime: Date.now(),
    patchTimer: null,
    completed: false,
    finalReplySent: false,
    toolCounts: new Map(),
  };
}
