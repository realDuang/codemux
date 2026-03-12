// ============================================================================
// MessageRenderer — Abstract interface for platform-specific message formatting
// Each channel platform implements this to format engine output.
// ============================================================================

/** Rendered message ready for transport */
export interface RenderedMessage {
  /** Message type: 'text' for plain text, 'rich' for cards/embeds */
  type: "text" | "rich";
  /** Formatted content string (platform-specific format) */
  content: string;
}

/**
 * Abstract interface for formatting engine output for a chat platform.
 * Implementations handle platform-specific formatting (Markdown, cards, etc.).
 */
export interface MessageRenderer {
  /** Format text buffer for a streaming (in-progress) update message. */
  renderStreamingUpdate(textBuffer: string): string;

  /**
   * Format the final reply when a message completes.
   * Returns a RenderedMessage with the appropriate type and content.
   */
  renderFinalReply(content: string, toolSummary?: string): RenderedMessage;

  /** Truncate text to fit platform message size limit. */
  truncate(text: string): string;
}
