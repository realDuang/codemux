// ============================================================================
// Shared Command Parser — Unified slash-command parsing for all IM channels.
//
// Behavior is identical across channels. The only channel-specific quirk is
// stripping a "@botname" suffix from the command (Telegram convention) — that
// stripping is harmless to apply universally, so we always do it.
// ============================================================================

import type { ParsedCommand } from "./command-types";

const COMMAND_PREFIX = "/";

/** Sub-commands recognised for a given top-level command. */
const SUBCOMMANDS: Record<string, Set<string>> = {
  // /model list  — list available models
  // /model <id>  — switch model (handled as args, not subcommand)
  model: new Set(["list"]),
};

/**
 * Parse a text message into a command structure. Returns null if not a command.
 *
 *   "/help"            → { command: "help", args: [], raw: "/help" }
 *   "/help@MyBot"      → { command: "help", args: [], raw: "/help@MyBot" }
 *   "/model list"      → { command: "model", subcommand: "list", args: [], raw: "..." }
 *   "/model gpt-4o"    → { command: "model", args: ["gpt-4o"], raw: "..." }
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) return null;

  const parts = trimmed.slice(COMMAND_PREFIX.length).split(/\s+/);
  if (parts.length === 0 || !parts[0]) return null;

  // Strip Telegram-style @botname suffix (harmless on other channels)
  const command = parts[0].replace(/@\S+$/, "").toLowerCase();
  if (!command) return null;

  const rest = parts.slice(1);

  const knownSubs = SUBCOMMANDS[command];
  if (knownSubs && rest.length > 0) {
    const subcommand = rest[0].toLowerCase();
    if (knownSubs.has(subcommand)) {
      return { command, subcommand, args: rest.slice(1), raw: trimmed };
    }
  }

  return { command, args: rest, raw: trimmed };
}
