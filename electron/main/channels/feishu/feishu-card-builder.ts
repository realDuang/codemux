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
    "/cancel — Cancel current request",
    "/status — Show session status",
    "/mode — Switch agent mode",
    "/model — Switch model",
    "/help — Show available commands",
  ].join("\n");

  const elements: unknown[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: [
          `**Project:** ${projectName}`,
          `**Engine:** ${engineType}`,
          `**Session:** ${sessionId.slice(0, 12)}...`,
          "",
          "Send a message to start coding. Available commands:",
          commands,
        ].join("\n"),
      },
    },
  ];

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "CodeMux Session" },
      template: "green",
    },
    elements,
  };

  return JSON.stringify(card);
}
