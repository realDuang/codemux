/**
 * Git service for querying repository status and file diffs.
 * Uses child_process.execFile to avoid adding external dependencies.
 */

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);

const MAX_DIFF_SIZE = 512 * 1024; // 512KB per file diff

export type GitFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

export interface GitFileChange {
  path: string;
  status: GitFileStatus;
  oldPath?: string;
  insertions?: number;
  deletions?: number;
}

export interface GitStatusResult {
  isGitRepo: boolean;
  branch?: string;
  files: GitFileChange[];
}

/**
 * Parse `git status --porcelain=v1` output into structured file changes.
 *
 *   XY PATH
 *   XY ORIG -> PATH  (for renames)
 *
 * X = index status, Y = worktree status.
 * We report the "most significant" status (index takes priority).
 */
function parseStatusLine(line: string): GitFileChange | null {
  if (line.length < 4) return null;

  const x = line[0]; // index status
  const y = line[1]; // worktree status
  const rawPath = line.slice(3);

  let path = rawPath;
  let oldPath: string | undefined;

  // Handle renames: "R  old -> new"
  const renameMatch = rawPath.match(/^(.+?) -> (.+)$/);
  if (renameMatch) {
    oldPath = renameMatch[1];
    path = renameMatch[2];
  }

  const status = resolveStatus(x, y);
  if (!status) return null;

  return { path, status, oldPath };
}

function resolveStatus(x: string, y: string): GitFileStatus | null {
  // Untracked
  if (x === "?" && y === "?") return "untracked";
  // Added (new file in index or worktree)
  if (x === "A") return "added";
  // Deleted
  if (x === "D" || y === "D") return "deleted";
  // Renamed
  if (x === "R") return "renamed";
  // Modified (index or worktree)
  if (x === "M" || y === "M") return "modified";
  // Copied (treat as added)
  if (x === "C") return "added";
  // Unmerged or other — treat as modified
  if (x !== " " || y !== " ") return "modified";

  return null;
}

/**
 * Parse `git diff --numstat` output to get insertion/deletion counts.
 * Format: "insertions\tdeletions\tfilepath"
 * Binary files show "-\t-\tfilepath"
 */
function parseNumstat(output: string): Map<string, { ins: number; del: number }> {
  const stats = new Map<string, { ins: number; del: number }>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length >= 3) {
      const ins = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
      const del = parts[1] === "-" ? 0 : parseInt(parts[1], 10);
      const filePath = parts.slice(2).join("\t"); // file path may contain tabs
      stats.set(filePath, { ins, del });
    }
  }
  return stats;
}

async function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFile("git", args, {
    cwd,
    maxBuffer: 5 * 1024 * 1024, // 5MB
    timeout: 10_000,
    windowsHide: true,
  });
}

export class GitService {
  /** Check whether a directory is inside a git repository. */
  async isGitRepo(directory: string): Promise<boolean> {
    try {
      await git(["rev-parse", "--is-inside-work-tree"], directory);
      return true;
    } catch {
      return false;
    }
  }

  /** Get current branch name. */
  async getBranch(directory: string): Promise<string | undefined> {
    try {
      const { stdout } = await git(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        directory,
      );
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get file change status for the working tree.
   * Combines `git status --porcelain` with `git diff --numstat` for stats.
   */
  async getStatus(directory: string): Promise<GitStatusResult> {
    const isRepo = await this.isGitRepo(directory);
    if (!isRepo) {
      return { isGitRepo: false, files: [] };
    }

    const [statusResult, branchResult, numstatResult] = await Promise.all([
      git(["status", "--porcelain=v1"], directory).catch(() => ({
        stdout: "",
        stderr: "",
      })),
      this.getBranch(directory),
      git(["diff", "--numstat", "HEAD"], directory).catch(() => ({
        stdout: "",
        stderr: "",
      })),
    ]);

    const files: GitFileChange[] = [];
    const stats = parseNumstat(numstatResult.stdout);

    for (const line of statusResult.stdout.split("\n")) {
      if (!line) continue;
      const change = parseStatusLine(line);
      if (!change) continue;

      // Merge numstat data
      const stat = stats.get(change.path);
      if (stat) {
        change.insertions = stat.ins;
        change.deletions = stat.del;
      }

      files.push(change);
    }

    // Sort: added → modified → renamed → deleted → untracked
    const statusOrder: Record<GitFileStatus, number> = {
      added: 0,
      modified: 1,
      renamed: 2,
      deleted: 3,
      untracked: 4,
    };
    files.sort(
      (a, b) => statusOrder[a.status] - statusOrder[b.status] || a.path.localeCompare(b.path),
    );

    return {
      isGitRepo: true,
      branch: branchResult,
      files,
    };
  }

  /**
   * Get unified diff for a single file.
   * Handles tracked (git diff HEAD) and untracked files (full content).
   */
  async getFileDiff(
    directory: string,
    filePath: string,
    isUntracked = false,
  ): Promise<string> {
    try {
      if (isUntracked) {
        // For untracked files, generate a diff showing the full file as added
        const { stdout } = await git(
          ["diff", "--no-index", "--", "/dev/null", filePath],
          directory,
        );
        return stdout.slice(0, MAX_DIFF_SIZE);
      }

      const { stdout } = await git(
        ["diff", "HEAD", "--", filePath],
        directory,
      );

      // If no diff from HEAD, try staged diff
      if (!stdout.trim()) {
        const { stdout: stagedDiff } = await git(
          ["diff", "--cached", "--", filePath],
          directory,
        );
        return stagedDiff.slice(0, MAX_DIFF_SIZE);
      }

      return stdout.slice(0, MAX_DIFF_SIZE);
    } catch {
      return "";
    }
  }
}

export const gitService = new GitService();
