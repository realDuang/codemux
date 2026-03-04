// ============================================================================
// Feishu Command Parser
// Parses slash commands from Feishu user messages.
// Supports: /help, /status, /project, /cancel, /mode, /model
// ============================================================================

import type { ParsedCommand } from "./feishu-types";

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
    "CodeMux Bot — P2P Commands",
    "─────────────────────────",
    "/project — Show project list",
    "/help — Show this help",
    "",
    "Or just send any text to see your projects.",
    "Reply with a number to select from lists.",
  ].join("\n");
}

/**
 * Build the group-scoped help text message.
 * Shown inside session group chats.
 */
export function buildGroupHelpText(): string {
  return [
    "**Session Commands**",
    "",
    "`/cancel` — Cancel the current running message",
    "`/status` — Show session info",
    "`/mode <agent|plan|build>` — Switch mode",
    "`/model list` — List available models",
    "`/model <id>` — Set model by ID",
    "`/help` — Show this help message",
    "",
    "Send any text to chat with the AI assistant.",
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
    return "No projects found. Start a session in CodeMux first.";
  }

  // Group projects by engine type
  const grouped = new Map<string, typeof projects>();
  for (const p of projects) {
    const key = p.engineType;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(p);
  }

  const lines: string[] = ["Projects", "─────────────────────────"];
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
  lines.push("Reply with a number to select a project.");

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
    `Sessions — ${projectName}`,
    "─────────────────────────",
    'Reply "new" to create a new session.',
  ];

  if (sessions.length > 0) {
    lines.push("─────────────────────────");
    lines.push("Existing sessions:");

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
  lines.push('Reply with a number to open, or "new" for a new session.');

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
    "Agent Question",
    "─────────────────────────",
    questionText,
    "─────────────────────────",
  ];

  for (let i = 0; i < options.length; i++) {
    lines.push(`  ${i + 1}. ${options[i].label}`);
  }

  lines.push("─────────────────────────");
  lines.push("Reply with a number to answer.");

  return lines.join("\n");
}
