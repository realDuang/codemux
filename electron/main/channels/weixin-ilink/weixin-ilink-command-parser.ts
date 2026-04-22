// ============================================================================
// WeChat iLink Command Parser
// Parses slash commands from inbound user messages.
//
// iLink-specific differences vs Telegram:
//   - No @botname suffix (private 1:1 chats only — no group disambiguation)
//   - No /bind command (no group binding model — all chats are P2P)
//   - All chats are P2P → only P2P-relevant commands are recognized:
//       /help, /start, /project, /cancel, /status, /mode, /model, /history
// ============================================================================

import type { ParsedCommand } from "./weixin-ilink-types";
import type { UnifiedMessage } from "../../../../src/types/unified";

const COMMAND_PREFIX = "/";

/**
 * Parse a text message into a command structure. Returns null if not a command.
 *
 *   "/help"            → { command: "help", args: [] }
 *   "/project list"    → { command: "project", subcommand: "list", args: [] }
 *   "/model gpt-4o"    → { command: "model", args: ["gpt-4o"] }
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) return null;

  const parts = trimmed.slice(COMMAND_PREFIX.length).split(/\s+/);
  if (parts.length === 0 || !parts[0]) return null;

  const command = parts[0].toLowerCase();
  if (!command) return null;

  const rest = parts.slice(1);

  const COMMANDS_WITH_SUBCOMMANDS = new Set(["project", "session", "engine", "model"]);
  if (COMMANDS_WITH_SUBCOMMANDS.has(command) && rest.length > 0) {
    const subcommand = rest[0].toLowerCase();
    const knownSubcommands: Record<string, Set<string>> = {
      project: new Set(["list", "switch"]),
      session: new Set(["list", "new", "switch", "delete"]),
      engine: new Set(["list"]),
      model: new Set(["list"]),
    };
    if (knownSubcommands[command]?.has(subcommand)) {
      return { command, subcommand, args: rest.slice(1), raw: trimmed };
    }
  }

  return { command, args: rest, raw: trimmed };
}

export function buildHelpText(): string {
  return [
    "📋 CodeMux iLink — 命令",
    "─────────────────────────",
    "/project — 查看项目列表",
    "/cancel — 取消当前正在运行的消息",
    "/status — 查看会话信息",
    "/mode <agent|plan|build> — 切换模式",
    "/model list — 查看可用模型",
    "/model <id> — 按 ID 切换模型",
    "/history — 查看会话历史记录",
    "/help — 显示此帮助",
    "",
    "直接发送消息即可与 AI 对话。",
    "回复数字可从列表中选择。",
  ].join("\n");
}

export function buildProjectListText(
  projects: import("../../../../src/types/unified").UnifiedProject[],
): string {
  if (projects.length === 0) {
    return "📋 未找到项目。请先在 CodeMux 中启动一个会话。";
  }
  const lines: string[] = ["📋 项目列表", "─────────────────────────"];
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    const name = p.name || p.directory.split(/[\\/]/).pop() || p.directory;
    lines.push(`  ${i + 1}. ${name}`);
  }
  lines.push("─────────────────────────");
  lines.push("回复数字以选择项目。");
  return lines.join("\n");
}

export function buildSessionListText(
  sessions: import("../../../../src/types/unified").UnifiedSession[],
  projectName: string,
): string {
  const lines: string[] = [
    `📋 会话列表 — ${projectName}`,
    "─────────────────────────",
    '回复 "new" 创建新会话。',
  ];

  if (sessions.length > 0) {
    lines.push("─────────────────────────");
    lines.push("已有会话：");
    const sorted = [...sessions].sort(
      (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
    );
    const limited = sorted.slice(0, 9);
    for (let i = 0; i < limited.length; i++) {
      const s = limited[i];
      const title = s.title || `Session ${s.id.slice(0, 8)}`;
      const engineLabel = s.engineType ? ` [${s.engineType}]` : "";
      lines.push(`  ${i + 1}. ${title}${engineLabel}`);
    }
  }

  lines.push("─────────────────────────");
  lines.push('回复数字以打开会话，或回复 "new" 创建新会话。');
  return lines.join("\n");
}

export function buildQuestionText(
  questionText: string,
  options: Array<{ id: string; label: string }>,
): string {
  const lines: string[] = [
    "📋 Agent 提问",
    "─────────────────────────",
    questionText,
    "─────────────────────────",
  ];
  for (let i = 0; i < options.length; i++) {
    lines.push(`  ${i + 1}. ${options[i].label}`);
  }
  lines.push("─────────────────────────");
  lines.push("回复消息以回答（可直接输入自定义回复，或回复对应数字选择）。");
  return lines.join("\n");
}

const HISTORY_ENTRY_MAX_CHARS = 500;

export interface HistoryEntry {
  emoji: string;
  text: string;
}

export function buildHistoryEntries(messages: UnifiedMessage[]): HistoryEntry[] {
  if (messages.length === 0) return [];
  const entries: HistoryEntry[] = [];
  for (const msg of messages) {
    const textParts = msg.parts.filter((p) => p.type === "text");
    const content = textParts.map((p) => p.text).join("\n").trim();
    if (!content) continue;
    const emoji = msg.role === "user" ? "👤" : "🤖";
    const truncated =
      content.length > HISTORY_ENTRY_MAX_CHARS
        ? content.slice(0, HISTORY_ENTRY_MAX_CHARS) + "..."
        : content;
    entries.push({ emoji, text: truncated });
  }
  return entries;
}
