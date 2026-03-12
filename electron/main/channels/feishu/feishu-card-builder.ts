// ============================================================================
// Feishu Card Builder
// Builds display-only message card JSON for Feishu bot responses.
// Architecture: One Group = One Session
// NOTE: Interactive cards (buttons) are NOT supported with WSClient (长连接).
// All interaction is done via text commands.
// ============================================================================

import type { EngineType } from "../../../../src/types/unified";

/** Max bytes for card content (leave room for card JSON overhead) */
const MAX_CARD_CONTENT_BYTES = 25_000;
const TRUNCATION_NOTICE = "\n\n...（内容已截断，请在 CodeMux 中查看完整回复）";

/**
 * Build a final reply card with Markdown rendering.
 * Used when a message completes to replace the plain-text streaming message.
 */
export function buildFinalReplyCard(content: string, toolSummary?: string): string {
  let cardContent = truncateCardContent(content);

  const elements: unknown[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: cardContent,
      },
    },
  ];

  if (toolSummary) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "note",
      elements: [
        { tag: "plain_text", content: toolSummary },
      ],
    });
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "CodeMux" },
      template: "blue",
    },
    elements,
  };

  return JSON.stringify(card);
}

/** Truncate content to fit within card size limit */
function truncateCardContent(text: string, maxBytes = MAX_CARD_CONTENT_BYTES): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;

  const noticeBytes = encoder.encode(TRUNCATION_NOTICE).length;
  const targetBytes = maxBytes - noticeBytes;
  let truncateAt = Math.floor(targetBytes / 3);
  while (encoder.encode(text.slice(0, truncateAt)).length > targetBytes && truncateAt > 0) {
    truncateAt = Math.floor(truncateAt * 0.9);
  }
  return text.slice(0, truncateAt) + TRUNCATION_NOTICE;
}

/**
 * Build welcome card for a newly created group chat bound to a session.
 * Shows project info, session ID, and available slash commands.
 * This is a display-only card — no action buttons.
 */
export function buildGroupWelcomeCard(
  projectName: string,
  engineType: EngineType,
  sessionId: string,
): string {
  const commands = [
    "/cancel — 取消当前正在运行的消息",
    "/status — 查看会话信息",
    "/mode — 切换模式",
    "/model — 切换模型",
    "/help — 显示可用命令",
  ].join("\n");

  const elements: unknown[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: [
          `**项目:** ${projectName}`,
          `**引擎:** ${engineType}`,
          `**会话:** ${sessionId.slice(0, 12)}...`,
          "",
          "发送消息即可开始对话。可用命令：",
          commands,
        ].join("\n"),
      },
    },
  ];

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "CodeMux 会话" },
      template: "green",
    },
    elements,
  };

  return JSON.stringify(card);
}
