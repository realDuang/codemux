// ============================================================================
// WeChat iLink Message Renderer
// Plain-text rendering only — iLink does not support markdown or rich content.
// Messages are truncated to 4096 chars to match Telegram's safe limit.
// ============================================================================

import type { MessageRenderer, RenderedMessage } from "../streaming/message-renderer";

const MAX_MESSAGE_CHARS = 4096;
const TRUNCATION_NOTICE = "\n\n...（内容已截断，请在 CodeMux 中查看完整回复）";

export class WeixinIlinkRenderer implements MessageRenderer {
  /**
   * Streaming updates are not visible (batch mode), but the controller still
   * calls renderStreamingUpdate when transitioning segments. Return text as-is.
   */
  renderStreamingUpdate(textBuffer: string): string {
    if (!textBuffer) return "🤔 思考中...";
    return this.truncate(textBuffer);
  }

  /** Format the final reply when an assistant message completes. */
  renderFinalReply(content: string, toolSummary?: string, title?: string): RenderedMessage {
    const parts: string[] = [];
    if (title) parts.push(`【${title}】\n`);
    parts.push(content);
    if (toolSummary) parts.push(toolSummary);
    return { type: "text", content: this.truncate(parts.join("\n")) };
  }

  /** Truncate to fit iLink's safe message size. */
  truncate(text: string): string {
    if (text.length <= MAX_MESSAGE_CHARS) return text;
    const target = MAX_MESSAGE_CHARS - TRUNCATION_NOTICE.length;
    return text.slice(0, target) + TRUNCATION_NOTICE;
  }
}
