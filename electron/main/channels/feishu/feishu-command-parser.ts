// ============================================================================
// Feishu Command Parser
// Parses slash commands from Feishu user messages.
// Supports: /help, /status, /project, /cancel, /mode, /model, /history
// ============================================================================

import type { ParsedCommand } from "./feishu-types";
import type { UnifiedMessage } from "../../../../src/types/unified";

/** Command prefix character */
const COMMAND_PREFIX = "/";

/**
 * Parse a text message into a command structure.
 * Returns null if the message is not a command.
 *
 * Format: /command [subcommand] [args...]
 * Examples:
 *   "/project list"      → { command: "project", subcommand: "list", args: [] }
 *   "/session new"       → { command: "session", subcommand: "new", args: [] }
 *   "/engine opencode"   → { command: "engine", args: ["opencode"] }
 *   "/model claude-sonnet-4-20250514" → { command: "model", args: ["claude-sonnet-4-20250514"] }
 *   "/cancel"            → { command: "cancel", args: [] }
 *   "/help"              → { command: "help", args: [] }
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) {
    return null;
  }

  const parts = trimmed.slice(COMMAND_PREFIX.length).split(/\s+/);
  if (parts.length === 0 || !parts[0]) {
    return null;
  }

  const command = parts[0].toLowerCase();
  const rest = parts.slice(1);

  // Commands that have sub-commands
  const COMMANDS_WITH_SUBCOMMANDS = new Set(["project", "session", "engine", "model"]);

  if (COMMANDS_WITH_SUBCOMMANDS.has(command) && rest.length > 0) {
    const subcommand = rest[0].toLowerCase();
    // Known sub-commands for each command type
    const knownSubcommands: Record<string, Set<string>> = {
      project: new Set(["list", "switch"]),
      session: new Set(["list", "new", "switch", "delete"]),
      engine: new Set(["list"]),
      model: new Set(["list"]),
    };

    if (knownSubcommands[command]?.has(subcommand)) {
      return {
        command,
        subcommand,
        args: rest.slice(1),
        raw: trimmed,
      };
    }
  }

  // No subcommand match: treat remaining parts as args
  return {
    command,
    args: rest,
    raw: trimmed,
  };
}

/**
 * Build the P2P-scoped help text message.
 * Shown in direct messages with the bot.
 */
export function buildHelpText(): string {
  return [
    "📋 CodeMux Bot — 私聊命令",
    "─────────────────────────",
    "/project — 查看项目列表",
    "/help — 显示此帮助",
    "",
    "直接发送消息即可与 AI 对话。",
    "回复数字可从列表中选择。",
  ].join("\n");
}

/**
 * Build the group-scoped help text message.
 * Shown inside session group chats.
 */
export function buildGroupHelpText(): string {
  return [
    "📋 **会话命令**",
    "",
    "`/cancel` — 取消当前正在运行的消息",
    "`/status` — 查看会话信息",
    "`/mode <agent|plan|build>` — 切换模式",
    "`/model list` — 查看可用模型",
    "`/model <id>` — 按 ID 切换模型",
    "`/history` — 查看会话历史记录",
    "`/help` — 显示此帮助",
    "",
    "发送任意文本即可与 AI 助手对话。",
  ].join("\n");
}

/**
 * Build a numbered project list for text-based selection.
 * Projects are grouped by engine type with sequential numbering.
 */
export function buildProjectListText(
  projects: import("../../../../src/types/unified").UnifiedProject[],
): string {
  if (projects.length === 0) {
    return "📋 未找到项目。请先在 CodeMux 中启动一个会话。";
  }

  // Group projects by engine type
  const grouped = new Map<string, typeof projects>();
  for (const p of projects) {
    const key = p.engineType;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(p);
  }

  const lines: string[] = ["📋 项目列表", "─────────────────────────"];
  let index = 1;

  for (const [engineType, engineProjects] of grouped) {
    lines.push(`[${engineType.toUpperCase()}]`);
    for (const p of engineProjects) {
      const name = p.name || p.directory.split(/[\\/]/).pop() || p.directory;
      lines.push(`  ${index}. ${name}`);
      index++;
    }
  }

  lines.push("─────────────────────────");
  lines.push("回复数字以选择项目。");

  return lines.join("\n");
}

/**
 * Build a numbered session list for text-based selection.
 * Shows "new" option first, then existing sessions sorted by update time.
 */
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

    // Sort by updated time descending, limit to 9
    const sorted = [...sessions].sort(
      (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
    );
    const limited = sorted.slice(0, 9);

    for (let i = 0; i < limited.length; i++) {
      const s = limited[i];
      const title = s.title || `Session ${s.id.slice(0, 8)}`;
      lines.push(`  ${i + 1}. ${title}`);
    }
  }

  lines.push("─────────────────────────");
  lines.push('回复数字以打开会话，或回复 "new" 创建新会话。');

  return lines.join("\n");
}

/**
 * Build question text with numbered options for text-based reply.
 */
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
  lines.push("回复消息以回答（可直接输入自定义回复）。");

  return lines.join("\n");
}

/** Max characters per message entry in history display */
const HISTORY_ENTRY_MAX_CHARS = 500;

/** A single history entry for display as an individual Feishu message */
export interface HistoryEntry {
  emoji: string;
  text: string;
}

/**
 * Build history entries from conversation messages.
 * Each message becomes a separate entry with emoji prefix.
 * Uses 👤 for user messages, 🤖 for assistant messages.
 */
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
