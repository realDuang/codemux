// ============================================================================
// WeCom Message Renderer
// Implements MessageRenderer for WeCom (企业微信).
// Formats engine output using WeCom's limited markdown subset.
// Supported: **bold**, [link](url), `code`, > quote, <font color="info">
// Max message size: 2048 bytes.
// ============================================================================

import type { MessageRenderer, RenderedMessage } from "../streaming/message-renderer";

/** WeCom markdown message size limit (bytes) */
const MAX_MESSAGE_BYTES = 2048;

/** Truncation notice appended when content exceeds limit */
const TRUNCATION_NOTICE = "\n\n> <font color=\"comment\">...（内容已截断，请在 CodeMux 中查看完整回复）</font>";

export class WeComRenderer implements MessageRenderer {
  /**
   * Format text buffer for a streaming (in-progress) update message.
   * Not actively used in batch mode, but required by the interface.
   */
  renderStreamingUpdate(textBuffer: string): string {
    return textBuffer + "\n\n> <font color=\"info\">思考中...</font>";
  }

  /**
   * Format the final reply when a message completes.
   * Uses WeCom markdown format.
   */
  renderFinalReply(content: string, toolSummary?: string, title?: string): RenderedMessage {
    const parts: string[] = [];

    if (title) {
      parts.push(`**${title}**\n`);
    }

    // Convert standard markdown to WeCom-compatible subset
    parts.push(this.convertToWeComMarkdown(content));

    if (toolSummary) {
      parts.push(toolSummary);
    }

    const markdown = parts.join("\n");
    const truncated = this.truncate(markdown);

    return { type: "rich", content: truncated };
  }

  /** Truncate text to fit WeCom's 2048 byte limit. */
  truncate(text: string): string {
    const buf = Buffer.from(text, "utf-8");
    if (buf.length <= MAX_MESSAGE_BYTES) {
      return text;
    }

    const noticeBuf = Buffer.from(TRUNCATION_NOTICE, "utf-8");
    const maxContentBytes = MAX_MESSAGE_BYTES - noticeBuf.length;

    // Find a safe truncation point (don't split multi-byte chars)
    let truncateAt = maxContentBytes;
    while (truncateAt > 0 && (buf[truncateAt] & 0xc0) === 0x80) {
      truncateAt--;
    }

    return buf.subarray(0, truncateAt).toString("utf-8") + TRUNCATION_NOTICE;
  }

  /**
   * Convert standard markdown to WeCom-compatible subset.
   * WeCom supports: **bold**, [link](url), `code`, > quote
   * Does NOT support: code block language hints, headers (#), italic, images
   */
  private convertToWeComMarkdown(text: string): string {
    return (
      text
        // Remove code block language identifiers (```js → ```)
        .replace(/```\w+\n/g, "```\n")
        // Convert headers to bold text
        .replace(/^#{1,6}\s+(.+)$/gm, "**$1**")
        // Remove image syntax (WeCom markdown doesn't support images)
        .replace(/!\[.*?\]\(.*?\)/g, "")
        // Keep bold, links, inline code, quotes as-is (WeCom supports these)
    );
  }
}
