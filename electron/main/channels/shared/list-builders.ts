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
    return [
      "📋 暂无可用项目",
      "─────────────────────────",
      "请先在 CodeMux 桌面端打开项目目录并启动会话，之后即可在此渠道中使用。",
      "",
      "使用 /project 切换项目，/help 查看更多命令。",
    ].join("\n");
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

/** One-line session status notification for P2P channels. */
export function buildSessionNotification(
  projectName: string,
  engineType: string,
  sessionId: string,
): string {
  return `📋 ${projectName}（${engineType}）· ${sessionId.slice(0, 8)}`;
}

const SESSION_TITLE_MAX_LEN = 28;

/** Truncate a session title to fit within the display width. */
export function truncateTitle(title: string, maxLen = SESSION_TITLE_MAX_LEN): string {
  return title.length > maxLen ? title.slice(0, maxLen) + "…" : title;
}

/** Return a Chinese relative-time string for the given timestamp. */
export function relativeTimeZh(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}周前`;
  const months = Math.floor(days / 30);
  return `${months}月前`;
}

/**
 * Group and sort sessions for display:
 *   1. Normal sessions (no worktreeId) sorted by recency
 *   2. Worktree groups, each sorted by recency, groups ordered by most-recent session
 *
 * The returned array order matches the numbered display order.
 */
export function groupAndSortSessions(sessions: UnifiedSession[]): UnifiedSession[] {
  const byRecency = (a: UnifiedSession, b: UnifiedSession) =>
    (b.time?.updated ?? 0) - (a.time?.updated ?? 0);

  const normal = sessions.filter((s) => !s.worktreeId).sort(byRecency);

  // Group worktree sessions by worktreeId
  const wtGroups = new Map<string, UnifiedSession[]>();
  for (const s of sessions) {
    if (!s.worktreeId) continue;
    let group = wtGroups.get(s.worktreeId);
    if (!group) {
      group = [];
      wtGroups.set(s.worktreeId, group);
    }
    group.push(s);
  }

  // Sort each group internally, then sort groups by most-recent session
  const sortedGroups = [...wtGroups.entries()]
    .map(([id, group]) => ({ id, sessions: group.sort(byRecency) }))
    .sort((a, b) => (b.sessions[0].time?.updated ?? 0) - (a.sessions[0].time?.updated ?? 0));

  const result = [...normal];
  for (const g of sortedGroups) {
    result.push(...g.sessions);
  }
  return result;
}

/**
 * Build a numbered session list for text-based selection.
 *
 * Expects sessions pre-sorted by `groupAndSortSessions` — the array order
 * determines the numbering and must match what is stored in pendingSelection.
 *
 * Worktree sessions are visually grouped: when a new `worktreeId` is
 * encountered, a `🌿 {worktreeId}` section header is inserted.
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
    let currentWorktreeId: string | undefined;

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];

      // Insert worktree group header on transition
      if (s.worktreeId !== currentWorktreeId) {
        if (s.worktreeId) {
          lines.push("");
          lines.push(`🌿 ${s.worktreeId}`);
        }
        currentWorktreeId = s.worktreeId;
      }

      const title = truncateTitle(s.title || `Session ${s.id.slice(0, 8)}`);
      const engineLabel = s.engineType ? ` [${s.engineType}]` : "";
      const timeLabel = s.time?.updated ? ` (${relativeTimeZh(s.time.updated)})` : "";
      lines.push(`  ${i + 1}. ${title}${engineLabel}${timeLabel}`);
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
