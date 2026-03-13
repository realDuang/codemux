// ============================================================================
// Feishu Message Renderer
// Implements MessageRenderer for Feishu (Lark).
// Formats engine output as Feishu text or interactive cards.
// ============================================================================

import type { MessageRenderer, RenderedMessage } from "../streaming/message-renderer";
import { buildFinalReplyCard } from "./feishu-card-builder";
import {
  formatStreamingText,
  truncateForFeishu,
} from "./feishu-message-formatter";

export class FeishuRenderer implements MessageRenderer {
  renderStreamingUpdate(textBuffer: string): string {
    return formatStreamingText(textBuffer);
  }

  renderFinalReply(content: string, toolSummary?: string, title?: string): RenderedMessage {
    const cardJson = buildFinalReplyCard(content, toolSummary || undefined, title);
    return { type: "rich", content: cardJson };
  }

  truncate(text: string): string {
    return truncateForFeishu(text);
  }
}
