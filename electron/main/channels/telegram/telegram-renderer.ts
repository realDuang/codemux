// ============================================================================
// Telegram Message Renderer
// Implements MessageRenderer for Telegram.
// Formats engine output as plain text or markdown within Telegram's 4096 char limit.
// ============================================================================

import type { MessageRenderer, RenderedMessage } from "../streaming/message-renderer";

/** Maximum Telegram message length in characters */
const MAX_MESSAGE_CHARS = 4096;
const TRUNCATION_NOTICE = "\n\n...（内容已截断，请在 CodeMux 中查看完整回复）";

export class TelegramRenderer implements MessageRenderer {
  /**
   * Format text buffer for a streaming (in-progress) update.
   * Shows "思考中..." indicator with a preview of accumulated text.
   */
  renderStreamingUpdate(textBuffer: string): string {
    if (!textBuffer) {
      return "🤔 思考中...";
    }
    return this.truncate(textBuffer + "\n\n_思考中..._");
  }

  /**
   * Format the final reply when a message completes.
   * Returns a text message with markdown formatting.
   */
  renderFinalReply(content: string, toolSummary?: string, title?: string): RenderedMessage {
    const parts: string[] = [];

    if (title) {
      parts.push(`**${title}**\n`);
    }

    parts.push(content);

    if (toolSummary) {
      parts.push(toolSummary);
    }

    const fullText = this.truncate(parts.join("\n"));
    return { type: "text", content: fullText };
  }

  /**
   * Truncate text to fit Telegram's 4096 character limit.
   */
  truncate(text: string): string {
    if (text.length <= MAX_MESSAGE_CHARS) {
      return text;
    }

    const targetChars = MAX_MESSAGE_CHARS - TRUNCATION_NOTICE.length;
    return text.slice(0, targetChars) + TRUNCATION_NOTICE;
  }
}
