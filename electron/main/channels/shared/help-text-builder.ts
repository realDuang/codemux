// ============================================================================
// Shared Help Text Builder — Generates command list driven by capabilities.
// One source of truth for command documentation across all channels.
// ============================================================================

import type { CommandCapabilities } from "./command-types";

/** Footer text describing how to address the bot in this context. */
export interface HelpFooter {
  /** True if user must @mention or use /command (e.g., Telegram/Teams group). */
  requiresMention: boolean;
}

/**
 * Build the help text for a chat context. Output is plain text (no Markdown)
 * to ensure consistent rendering across all IM platforms.
 */
export function buildHelpText(
  capabilities: CommandCapabilities,
  footer: HelpFooter = { requiresMention: false },
): string {
  const lines: string[] = ["📋 CodeMux Bot — 命令", "─────────────────────────"];

  if (capabilities.navigation) {
    lines.push("/project — 切换项目");
    lines.push("/new — 在当前项目下创建新会话");
    lines.push("/switch — 切换到当前项目下的其他会话");
  }

  if (capabilities.sessionOps) {
    lines.push("/status — 查看当前会话信息");
    lines.push("/cancel — 取消正在运行的消息");
    lines.push("/mode <agent|plan|build> — 切换模式");
    lines.push("/model [list|<id>] — 列出/切换模型");
    lines.push("/history — 查看会话历史");
  }

  if (capabilities.general) {
    lines.push("/help — 显示此帮助");
  }

  lines.push("");
  if (footer.requiresMention) {
    lines.push("在群聊中 @我 或使用 /command 与 AI 对话。");
  } else {
    lines.push("直接发送消息即可与 AI 对话。");
  }
  lines.push("回复数字可从列表中选择。");

  return lines.join("\n");
}

/**
 * Build a short welcome / first-contact message. Sent once per chat (e.g. when
 * a new P2P chat is detected, or when a group is created).
 */
export function buildWelcomeText(): string {
  return [
    "👋 欢迎使用 CodeMux！",
    "输入 /help 查看可用命令，或直接发送消息开始对话。",
  ].join("\n");
}
