// ============================================================================
// Shared Command Types — Unified across all IM channel adapters.
//
// All channels (Telegram, Feishu, DingTalk, WeCom, Teams, WeChat iLink) share
// the same command surface so users get identical behavior regardless of IM.
// ============================================================================

/** A parsed slash-command from inbound text. */
export interface ParsedCommand {
  /** Top-level command word (lower-case, no leading slash, @botname stripped). */
  command: string;
  /** Optional sub-command (e.g. "list" in "/model list"). */
  subcommand?: string;
  /** Remaining tokens after command (and subcommand if matched). */
  args: string[];
  /** Original raw text (trimmed). */
  raw: string;
}

/** Capability flags describing what a given chat context supports. */
export interface CommandCapabilities {
  /** Class A: project/session navigation (only meaningful in P2P). */
  navigation: boolean;
  /** Class B: current-session ops (cancel/status/mode/model/history). */
  sessionOps: boolean;
  /** Class C: help/start are always true; included for symmetry. */
  general: boolean;
}

/** Convenience: full P2P capability set. */
export const P2P_CAPABILITIES: CommandCapabilities = {
  navigation: true,
  sessionOps: true,
  general: true,
};

/** Convenience: group capability set (B + C only — group binding == session). */
export const GROUP_CAPABILITIES: CommandCapabilities = {
  navigation: false,
  sessionOps: true,
  general: true,
};

/** All commands recognised by the unified parser. */
export const KNOWN_COMMANDS = [
  // Class A — navigation (P2P only)
  "project",
  "new",
  "switch",
  // Class B — current-session ops
  "cancel",
  "status",
  "mode",
  "model",
  "history",
  // Class C — general
  "help",
  "start",
] as const;

export type CommandName = (typeof KNOWN_COMMANDS)[number];
