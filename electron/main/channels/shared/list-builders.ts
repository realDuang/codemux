// ============================================================================
// Shared List/Question/History Builders — used by every channel for selection
// menus and question display. Plain text only (consistent cross-platform).
// ============================================================================

import type {
  UnifiedMessage,
  UnifiedProject,
  UnifiedSession,
} from "../../../../src/types/unified";

/** Build a numbered project list for text-based selection. */
export function buildProjectListText(projects: UnifiedProject[]): string {
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

/**
 * Build a numbered session list for text-based selection. Top 9 by recency.
 *
 * `newHint` controls how to instruct the user to create a new session:
 *   - default ("/new"): show "使用 /new 创建新会话" — the cross-channel norm
 *   - "keyword": show 'or reply "new"' — used by group-bind flows where /new
 *     isn't part of the in-group command set
 */
export function buildSessionListText(
  sessions: UnifiedSession[],
  projectName: string,
  options: { newHint?: "command" | "keyword" } = {},
): string {
  const newHint = options.newHint ?? "command";
  const createHint =
    newHint === "keyword"
      ? '回复 "new" 创建新会话'
      : "使用 /new 创建新会话";

  const lines: string[] = [
    `📋 会话列表 — ${projectName}`,
    "─────────────────────────",
  ];

  if (sessions.length > 0) {
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
    lines.push("─────────────────────────");
    lines.push(`回复数字以打开会话，或${createHint}。`);
  } else {
    lines.push(`暂无已有会话。${createHint}。`);
  }

  return lines.join("\n");
}

/** Build a question prompt with numbered options. */
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

/** Build history entries from conversation messages, one per message. */
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
