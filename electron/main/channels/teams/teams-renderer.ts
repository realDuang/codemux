// ============================================================================
// Teams Message Renderer
// Implements MessageRenderer for Microsoft Teams.
// Formats engine output as markdown for streaming updates and Adaptive Cards
// for final replies.
//
// Teams message size limit: ~80KB
// Adaptive Card schema version: 1.5
// ============================================================================

import type { MessageRenderer, RenderedMessage } from "../streaming/message-renderer";

/** Maximum message size in bytes (~80KB) */
const MAX_MESSAGE_BYTES = 80_000;
const TRUNCATION_NOTICE = "\n\n...（内容已截断，请在 CodeMux 中查看完整回复）";

export class TeamsRenderer implements MessageRenderer {
  /**
   * Format text buffer for a streaming (in-progress) update.
   * Teams supports message editing, so we show accumulated text with a "thinking" indicator.
   */
  renderStreamingUpdate(textBuffer: string): string {
    if (!textBuffer) {
      return "🤔 思考中...";
    }
    return this.truncate(textBuffer + "\n\n_⏳ 思考中..._");
  }

  /**
   * Format the final reply when a message completes.
   * Returns a rich Adaptive Card with title, content, and optional tool summary.
   */
  renderFinalReply(
    content: string,
    toolSummary?: string,
    title?: string,
  ): RenderedMessage {
    const bodyBlocks: Record<string, unknown>[] = [];

    if (title) {
      bodyBlocks.push({
        type: "TextBlock",
        text: title,
        weight: "bolder",
        size: "medium",
        wrap: true,
      });
    }

    bodyBlocks.push({
      type: "TextBlock",
      text: this.truncate(content),
      wrap: true,
    });

    if (toolSummary) {
      bodyBlocks.push({
        type: "TextBlock",
        text: toolSummary,
        isSubtle: true,
        separator: true,
        wrap: true,
      });
    }

    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.5",
      body: bodyBlocks,
    };

    return { type: "rich", content: JSON.stringify(card) };
  }

  /**
   * Truncate text to fit Teams' ~80KB message size limit.
   */
  truncate(text: string): string {
    const bytes = Buffer.byteLength(text, "utf-8");
    if (bytes <= MAX_MESSAGE_BYTES) {
      return text;
    }

    // Binary search for a safe cut point in characters
    let lo = 0;
    let hi = text.length;
    const targetBytes = MAX_MESSAGE_BYTES - Buffer.byteLength(TRUNCATION_NOTICE, "utf-8");

    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (Buffer.byteLength(text.slice(0, mid), "utf-8") <= targetBytes) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    return text.slice(0, lo) + TRUNCATION_NOTICE;
  }

  // =========================================================================
  // Adaptive Card Builders (Teams-specific)
  // =========================================================================

  /**
   * Build an Adaptive Card with Action.Submit buttons for permission requests.
   */
  buildPermissionCard(
    title: string,
    options: Array<{ id: string; label: string }>,
    permissionId: string,
  ): Record<string, unknown> {
    return {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.5",
      body: [
        {
          type: "TextBlock",
          text: `🔐 ${title}`,
          weight: "bolder",
          wrap: true,
        },
      ],
      actions: options.map((o) => ({
        type: "Action.Submit",
        title: o.label || o.id,
        data: { action: "perm", permissionId, optionId: o.id },
      })),
    };
  }

  /**
   * Build an Adaptive Card with Input.ChoiceSet for question responses.
   */
  buildQuestionCard(
    questionText: string,
    options: Array<{ id: string; label: string }>,
    questionId: string,
  ): Record<string, unknown> {
    return {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.5",
      body: [
        {
          type: "TextBlock",
          text: `📋 ${questionText}`,
          weight: "bolder",
          wrap: true,
        },
        {
          type: "Input.ChoiceSet",
          id: "selectedOption",
          style: "expanded",
          choices: options.map((o) => ({
            title: o.label,
            value: o.label,
          })),
        },
      ],
      actions: [
        {
          type: "Action.Submit",
          title: "提交",
          data: { action: "question", questionId },
        },
      ],
    };
  }
}
