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

  // --- Optional extended capabilities ---

  /**
   * Send a streaming draft message (e.g., Telegram sendMessageDraft).
   * Used for platforms with native streaming support instead of edit-in-place.
   * Returns a draft/message ID, or empty string on failure.
   */
  sendDraft?(chatId: string, text: string): Promise<string>;

  /**
   * Update a streaming draft with new content.
   * For platforms like Telegram where drafts are updated differently from regular messages.
   */
  updateDraft?(draftId: string, text: string): Promise<void>;

  /**
   * Finalize a streaming draft (mark as complete, convert to regular message).
   */
  finalizeDraft?(chatId: string, draftId: string): Promise<void>;

  /**
   * Send an interactive card (e.g., DingTalk AI Card).
   * Returns a card instance ID for subsequent updates.
   */
  sendCard?(chatId: string, cardData: string): Promise<string>;

  /**
   * Update an interactive card's content (e.g., DingTalk AI Card streaming update).
   */
  updateCard?(cardId: string, content: string): Promise<void>;

  /**
   * Finalize an interactive card (mark streaming complete).
   */
  finalizeCard?(cardId: string): Promise<void>;
}
