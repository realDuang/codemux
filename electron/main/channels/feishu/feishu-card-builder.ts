// ============================================================================
// Feishu Card Builder
// Builds display-only message card JSON for Feishu bot responses.
// Architecture: One Group = One Session
// NOTE: Interactive cards (buttons) are NOT supported with WSClient (长连接).
// All interaction is done via text commands.
// ============================================================================

import type { EngineType } from "../../../../src/types/unified";

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
