// ============================================================================
// MessageTransport — Abstract interface for platform message I/O
// Each channel platform implements this to send, update, and delete messages.
// ============================================================================

/** Result of sending a rich content message (card, embed, etc.) */
export interface SendRichContentResult {
  /** Platform-specific message ID */
  messageId: string;
}

/**
 * Abstract interface for sending messages to a chat platform.
 * Implementations handle platform-specific API calls and rate limiting.
 */
export interface MessageTransport {
  /** Send a plain text message. Returns platform message ID, or empty string on failure. */
  sendText(chatId: string, text: string): Promise<string>;

  /** Update an existing message with new text content. */
  updateText(messageId: string, text: string): Promise<void>;

  /** Delete a message by its platform message ID. */
  deleteMessage(messageId: string): Promise<void>;

  /** Send rich content (card, embed, etc.). Returns platform message ID, or empty string on failure. */
  sendRichContent(chatId: string, content: string): Promise<string>;
}
