/**
 * Claude Code session file utilities.
 * Handles reading and managing Claude Code's on-disk session/project files.
 */

import { existsSync, unlinkSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { claudeLog } from "../../services/logger";

/**
 * Map a project directory to Claude Code's folder name convention.
 * Mirrors the SDK's internal v9() function: replace all non-alphanumeric
 * chars with '-', truncate + hash if longer than 200 chars.
 */
function ccProjectFolder(directory: string): string {
  const MAX_PREFIX = 200;
  const sanitized = directory.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_PREFIX) return sanitized;
  // Simple string hash matching SDK's iq() fallback
  let hash = 0;
  for (let i = 0; i < directory.length; i++) {
    hash = ((hash << 5) - hash + directory.charCodeAt(i)) | 0;
  }
  return `${sanitized.slice(0, MAX_PREFIX)}-${(hash >>> 0).toString(36)}`;
}

/**
 * Get the Claude Code config directory (respects CLAUDE_CONFIG_DIR env var).
 */
function ccConfigDir(): string {
  return (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
}

/**
 * Find the Claude Code projects directory for a given workspace directory.
 * Handles the fallback logic for long paths where the hash suffix may differ.
 */
function findCCProjectDir(directory: string): string | null {
  const projectsDir = join(ccConfigDir(), "projects");
  if (!existsSync(projectsDir)) return null;

  const folderName = ccProjectFolder(directory);
  const exactPath = join(projectsDir, folderName);
  if (existsSync(exactPath)) return exactPath;

  // Fallback for long paths: match by prefix
  if (folderName.length > 200) {
    const prefix = folderName.slice(0, 200);
    try {
      const entries = readdirSync(projectsDir, { withFileTypes: true });
      const match = entries.find(e => e.isDirectory() && e.name.startsWith(prefix + "-"));
      if (match) return join(projectsDir, match.name);
    } catch { /* ignore */ }
  }

  return null;
}

/**
 * Delete a Claude Code .jsonl session file from disk.
 */
export function deleteCCSessionFile(ccSessionId: string, directory: string): void {
  const projectDir = findCCProjectDir(directory);
  if (!projectDir) return;

  const sessionFile = join(projectDir, `${ccSessionId}.jsonl`);
  try {
    if (existsSync(sessionFile)) {
      unlinkSync(sessionFile);
      claudeLog.info(`[Claude] Deleted CC session file: ${sessionFile}`);
    }
  } catch (err) {
    claudeLog.warn(`[Claude] Failed to delete CC session file ${sessionFile}:`, err);
  }
}

/**
 * Read a Claude Code .jsonl session file and extract uuid→timestamp mapping.
 * The SDK's getSessionMessages() strips the timestamp field, so we read
 * the raw file to recover per-message timestamps for history display.
 */
export function readJsonlTimestamps(
  ccSessionId: string,
  directory: string,
): Map<string, number> {
  const timestamps = new Map<string, number>();
  const projectDir = findCCProjectDir(directory);
  if (!projectDir) return timestamps;

  const sessionFile = join(projectDir, `${ccSessionId}.jsonl`);
  if (!existsSync(sessionFile)) return timestamps;

  try {
    const content = readFileSync(sessionFile, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.uuid && entry.timestamp) {
          timestamps.set(entry.uuid, new Date(entry.timestamp).getTime());
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch (err) {
    claudeLog.warn(`[Claude] Failed to read timestamps from ${sessionFile}:`, err);
  }

  return timestamps;
}
