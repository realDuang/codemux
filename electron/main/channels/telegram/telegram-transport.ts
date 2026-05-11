// ============================================================================
// Telegram Message Transport
// Implements MessageTransport for Telegram Bot API via HTTPS fetch.
// Handles rate limiting and all Telegram message API calls.
//
// API Reference: https://core.telegram.org/bots/api
//   - sendMessage: max 4096 chars, supports MarkdownV2/HTML
//   - editMessageText: edit bot's own messages
//   - deleteMessage: delete bot's own messages
//   - sendMessageDraft: Bot API 9.3+ native streaming output
// ============================================================================

import type { MessageTransport } from "../streaming/message-transport";
import type { TokenBucket } from "../streaming/rate-limiter";
import { channelLog } from "../../services/logger";

const LOG_PREFIX = "[Telegram]";

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error
    && (error as { name?: unknown }).name === "AbortError";
}

export class TelegramTransport implements MessageTransport {
  constructor(
    private botToken: string,
    private rateLimiter: TokenBucket,
  ) {}

  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }

  // =========================================================================
  // MessageTransport Interface
  // =========================================================================

  /**
   * Send a text message to a Telegram chat.
   * Tries MarkdownV2 first; falls back to plain text on parse errors.
   * Returns message_id as string, or empty string on failure.
   */
  async sendText(chatId: string, text: string): Promise<string> {
    try {
      await this.rateLimiter.consume();

      // Try MarkdownV2 first
      const mdResult = await this.callApi("sendMessage", {
        chat_id: chatId,
        text: escapeMarkdownV2(text),
        parse_mode: "MarkdownV2",
      });

      if (mdResult?.result?.message_id) {
        return String(mdResult.result.message_id);
      }

      // Fallback: send without parse_mode
      const plainResult = await this.callApi("sendMessage", {
        chat_id: chatId,
        text,
      });

      return plainResult?.result?.message_id
        ? String(plainResult.result.message_id)
        : "";
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to send text message:`, err);
      return "";
    }
  }

  /**
   * Send a markdown-formatted message using HTML parse mode.
   * Converts standard markdown (**bold**, `code`) to Telegram HTML (<b>, <code>).
   * Falls back to plain text on parse error.
   */
  async sendMarkdown(chatId: string, markdown: string): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const html = markdownToTelegramHtml(markdown);
      const result = await this.callApi("sendMessage", {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
      });
      if (result?.result?.message_id) {
        return String(result.result.message_id);
      }
      // Fallback: send as plain text
      const plainResult = await this.callApi("sendMessage", {
        chat_id: chatId,
        text: markdown,
      });
      return plainResult?.result?.message_id
        ? String(plainResult.result.message_id)
        : "";
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to send markdown message:`, err);
      return "";
    }
  }

  /**
   * Update an existing message with new text content via editMessageText.
   * The messageId format is "chatId:messageId" to carry both pieces of info.
   */
  async updateText(messageId: string, text: string): Promise<void> {
    const { chatId, msgId } = this.parseMessageId(messageId);
    if (!chatId || !msgId) return;

    try {
      // Try MarkdownV2 first
      const mdResult = await this.callApi("editMessageText", {
        chat_id: chatId,
        message_id: Number(msgId),
        text: escapeMarkdownV2(text),
        parse_mode: "MarkdownV2",
      });

      if (mdResult?.ok) return;

      // Fallback: plain text
      await this.callApi("editMessageText", {
        chat_id: chatId,
        message_id: Number(msgId),
        text,
      });
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to update message ${messageId}:`, err);
    }
  }

  /**
   * Delete a message by its compound messageId ("chatId:messageId").
   */
  async deleteMessage(messageId: string): Promise<void> {
    const { chatId, msgId } = this.parseMessageId(messageId);
    if (!chatId || !msgId) return;

    await this.rateLimiter.consume();
    await this.callApi("deleteMessage", {
      chat_id: chatId,
      message_id: Number(msgId),
    });
  }

  /**
   * Send rich content as a message with InlineKeyboardMarkup.
   * Content is a JSON string with { text, reply_markup } structure.
   */
  async sendRichContent(chatId: string, content: string): Promise<string> {
    try {
      await this.rateLimiter.consume();
      let parsed: { text?: string; reply_markup?: unknown };
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = { text: content };
      }

      const result = await this.callApi("sendMessage", {
        chat_id: chatId,
        text: parsed.text || content,
        reply_markup: parsed.reply_markup,
      });

      return result?.result?.message_id
        ? String(result.result.message_id)
        : "";
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to send rich content:`, err);
      return "";
    }
  }

  // =========================================================================
  // Extended Capabilities (sendMessageDraft for native streaming)
  // =========================================================================

  /**
   * Send a streaming draft message (Bot API 9.3+).
   * Shows as "typing" with live text in the user's chat (private chats only).
   * Returns message_id as compound ID, or empty string on failure.
   */
  async sendDraft(chatId: string, text: string): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const result = await this.callApi("sendMessageDraft", {
        chat_id: chatId,
        text,
      });

      if (result?.result?.message_id) {
        return this.composeMessageId(chatId, String(result.result.message_id));
      }
      return "";
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to send draft:`, err);
      return "";
    }
  }

  /**
   * Update a streaming draft with new content.
   */
  async updateDraft(draftId: string, text: string): Promise<void> {
    const { chatId, msgId } = this.parseMessageId(draftId);
    if (!chatId || !msgId) return;

    try {
      await this.callApi("sendMessageDraft", {
        chat_id: chatId,
        text,
        message_id: Number(msgId),
      });
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to update draft ${draftId}:`, err);
    }
  }

  /**
   * Finalize a streaming draft (stop typing indicator, convert to regular message).
   */
  async finalizeDraft(chatId: string, draftId: string): Promise<void> {
    const { msgId } = this.parseMessageId(draftId);
    if (!msgId) return;

    try {
      await this.callApi("sendMessageDraft", {
        chat_id: chatId,
        text: "",
        message_id: Number(msgId),
        finalize: true,
      });
    } catch (err) {
      channelLog.verbose(`${LOG_PREFIX} Draft finalize returned error (may be expected):`, err);
    }
  }

  // =========================================================================
  // Telegram-Specific Methods (not part of MessageTransport interface)
  // =========================================================================

  /**
   * Answer a callback query (button click acknowledgment).
   * Must be called within 10 seconds of receiving the callback.
   */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await this.callApi("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text,
      });
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to answer callback query:`, err);
    }
  }

  /**
   * Send a message with an inline keyboard.
   * Returns compound message ID or empty string on failure.
   */
  async sendMessageWithKeyboard(
    chatId: string,
    text: string,
    keyboard: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<string> {
    try {
      await this.rateLimiter.consume();
      const result = await this.callApi("sendMessage", {
        chat_id: chatId,
        text,
        reply_markup: {
          inline_keyboard: keyboard,
        },
      });

      if (result?.result?.message_id) {
        return this.composeMessageId(chatId, String(result.result.message_id));
      }
      return "";
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to send message with keyboard:`, err);
      return "";
    }
  }

  /**
   * Set the webhook URL for receiving updates.
   */
  async setWebhook(url: string, secretToken?: string): Promise<boolean> {
    try {
      const params: Record<string, unknown> = { url };
      if (secretToken) {
        params.secret_token = secretToken;
      }
      const result = await this.callApi("setWebhook", params);
      return result?.ok === true;
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to set webhook:`, err);
      return false;
    }
  }

  /**
   * Delete the webhook (switch to long polling mode).
   */
  async deleteWebhook(): Promise<boolean> {
    try {
      const result = await this.callApi("deleteWebhook", {});
      return result?.ok === true;
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to delete webhook:`, err);
      return false;
    }
  }

  /**
   * Get updates via long polling.
   */
  async getUpdates(offset?: number, timeout = 30, signal?: AbortSignal): Promise<any[]> {
    try {
      const params: Record<string, unknown> = { timeout };
      if (offset !== undefined) {
        params.offset = offset;
      }
      const result = await this.callApi("getUpdates", params, signal);
      return result?.result || [];
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      channelLog.error(`${LOG_PREFIX} Failed to get updates:`, err);
      return [];
    }
  }

  /**
   * Get bot info (for extracting bot username).
   */
  async getMe(): Promise<{ id: number; username?: string } | null> {
    try {
      const result = await this.callApi("getMe", {});
      return result?.result || null;
    } catch (err) {
      channelLog.error(`${LOG_PREFIX} Failed to get bot info:`, err);
      return null;
    }
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  /**
   * Call a Telegram Bot API method via POST.
   */
  private async callApi(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any> {
    const res = await fetch(this.apiUrl(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });

    if (!res.ok) {
      const body = await res.text();
      channelLog.error(`${LOG_PREFIX} API ${method} failed: ${res.status} ${body}`);
      return { ok: false };
    }

    return res.json();
  }

  /**
   * Compose a compound message ID: "chatId:messageId".
   * This is needed because editMessageText and deleteMessage require both.
   */
  composeMessageId(chatId: string, messageId: string): string {
    return `${chatId}:${messageId}`;
  }

  /**
   * Parse a compound message ID back into chatId and messageId.
   */
  private parseMessageId(compoundId: string): { chatId: string; msgId: string } {
    const colonIdx = compoundId.indexOf(":");
    if (colonIdx === -1) {
      return { chatId: "", msgId: compoundId };
    }
    return {
      chatId: compoundId.slice(0, colonIdx),
      msgId: compoundId.slice(colonIdx + 1),
    };
  }
}

// ============================================================================
// MarkdownV2 Escaping
// ============================================================================

/**
 * Escape special characters for Telegram MarkdownV2 format.
 * Characters that must be escaped: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Convert standard markdown to Telegram HTML format.
 * Handles **bold** → <b>bold</b> and `code` → <code>code</code>.
 * Escapes HTML entities to prevent injection.
 */
export function markdownToTelegramHtml(md: string): string {
  // 1. Escape HTML entities
  let html = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // 2. Convert **bold** → <b>bold</b>
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // 3. Convert `code` → <code>code</code>
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  return html;
}
