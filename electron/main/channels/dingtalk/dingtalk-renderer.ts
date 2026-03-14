// ============================================================================
// DingTalk Message Renderer
// Implements MessageRenderer for DingTalk.
// Formats engine output as DingTalk markdown or ActionCard JSON.
// ============================================================================

import type { MessageRenderer, RenderedMessage } from "../streaming/message-renderer";

/** Maximum DingTalk message size in bytes (~20KB for robot messages) */
const MAX_MESSAGE_BYTES = 20_000;
const TRUNCATION_NOTICE = "\n\n...（内容已截断，请在 CodeMux 中查看完整回复）";

export class DingTalkRenderer implements MessageRenderer {
  /**
   * Format text buffer for a streaming (in-progress) update.
   * Shows "思考中..." indicator with a preview of accumulated text.
   */
  renderStreamingUpdate(textBuffer: string): string {
    if (!textBuffer) {
      return "🤔 思考中...";
    }
    return textBuffer + "\n\n_思考中..._";
  }

  /**
   * Format the final reply when a message completes.
   * Returns an ActionCard-style rich message with markdown content.
   */
  renderFinalReply(content: string, toolSummary?: string, title?: string): RenderedMessage {
    const cardTitle = title || "CodeMux";
    let cardText = this.truncate(content);

    if (toolSummary) {
      cardText += `\n\n---\n${toolSummary}`;
    }

    const actionCard = JSON.stringify({
      title: cardTitle,
      text: cardText,
      singleTitle: "CodeMux",
      singleURL: "",
    });

    return { type: "rich", content: actionCard };
  }

  /**
   * Truncate text to fit DingTalk message size limit (~20KB).
   */
  truncate(text: string): string {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(text);

    if (bytes.length <= MAX_MESSAGE_BYTES) {
      return text;
    }

    const noticeBytes = encoder.encode(TRUNCATION_NOTICE).length;
    const targetBytes = MAX_MESSAGE_BYTES - noticeBytes;

    // Iteratively shrink to find the right truncation point
    let truncateAt = Math.floor(targetBytes / 3);
    while (encoder.encode(text.slice(0, truncateAt)).length > targetBytes && truncateAt > 0) {
      truncateAt = Math.floor(truncateAt * 0.9);
    }

    return text.slice(0, truncateAt) + TRUNCATION_NOTICE;
  }
}
