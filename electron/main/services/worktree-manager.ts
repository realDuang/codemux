/**
 * Core worktree management service.
 * Handles git worktree creation, listing, removal, and merging.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import log from "electron-log/main";
import { createSlug, slugify } from "./slug";
import { worktreeStore, type WorktreeInfo } from "./worktree-store";

const wtLog = log.scope("WorktreeManager");

const GIT_TIMEOUT = 30_000;
const MAX_NAME_ATTEMPTS = 20;
const BRANCH_PREFIX = "codemux";

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, timeout: GIT_TIMEOUT, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout?.trim() ?? "",
          stderr: stderr?.trim() ?? "",
          code: error ? (error as NodeJS.ErrnoException & { code?: number }).code
            ? -1
            : (error as { status?: number }).status ?? 1
            : 0,
        });
      },
    );
  });
}

export interface MergeResult {
  success: boolean;
  conflicts?: string[];
  message: string;
}

export interface CreateWorktreeOptions {
  name?: string;
  baseBranch?: string;
}

class WorktreeManager {
  private worktreeBase: string | null = null;
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    this.worktreeBase = path.join(app.getPath("userData"), "worktrees");
    if (!fs.existsSync(this.worktreeBase)) {
      fs.mkdirSync(this.worktreeBase, { recursive: true });
    }
    worktreeStore.init();
    this.initialized = true;
    wtLog.info(`Initialized worktree base at ${this.worktreeBase}`);
  }

  init(): void {
    this.ensureInit();
  }

  async resolveProjectId(repoDir: string): Promise<string> {
    this.ensureInit();
    const cacheFile = path.join(repoDir, ".git", "codemux-project-id");

    // Try cached value first
    try {
      const cached = fs.readFileSync(cacheFile, "utf-8").trim();
      if (cached) return cached;
    } catch {
      /* not cached */
    }

    // Resolve .git directory (could be a worktree link file)
    const dotGitPath = path.join(repoDir, ".git");
    let gitDir = repoDir;
    try {
      const stat = fs.statSync(dotGitPath);
      if (stat.isFile()) {
        // .git is a file (worktree link) — follow it to find the real git dir
        const content = fs.readFileSync(dotGitPath, "utf-8").trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (match) {
          const linked = path.resolve(repoDir, match[1]);
          const commonDir = await git(["rev-parse", "--git-common-dir"], linked);
          if (commonDir.code === 0) {
            gitDir = path.resolve(linked, commonDir.stdout);
          }
        }
      }
    } catch {
      /* use repoDir */
    }

    // Get first commit hash as project ID
    const result = await git(["rev-list", "--max-parents=0", "HEAD"], gitDir);
    if (result.code !== 0 || !result.stdout) {
      throw new Error(`Cannot determine project ID for ${repoDir}: ${result.stderr}`);
    }

    const projectId = result.stdout.split("\n")[0].substring(0, 12);

    // Cache it
    try {
      fs.writeFileSync(cacheFile, projectId, "utf-8");
    } catch {
      wtLog.warn(`Could not cache project ID to ${cacheFile}`);
    }

    return projectId;
  }

  async detectMainBranch(repoDir: string): Promise<string> {
    this.ensureInit();
    // Try symbolic-ref first
    const symRef = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], repoDir);
    if (symRef.code === 0 && symRef.stdout) {
      const branch = symRef.stdout.replace("refs/remotes/origin/", "");
      if (branch) return branch;
    }

    // Check common branch names
    for (const candidate of ["main", "master", "develop"]) {
      const check = await git(["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], repoDir);
      if (check.code === 0) return candidate;
    }

    // Fallback: current branch
    const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
    return current.code === 0 ? current.stdout : "main";
  }

  async listBranches(repoDir: string): Promise<string[]> {
    this.ensureInit();
    const result = await git(["branch", "--format=%(refname:short)"], repoDir);
    if (result.code !== 0) return [];
    return result.stdout.split("\n").filter(Boolean);
  }

  private async findCandidate(
    projectId: string,
    repoDir: string,
    baseName?: string,
  ): Promise<{ name: string; branch: string; directory: string }> {
    const root = path.join(this.worktreeBase!, projectId);

    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
      const name = baseName
        ? attempt === 0
          ? slugify(baseName)
          : `${slugify(baseName)}-${createSlug()}`
        : createSlug();

      const branch = `${BRANCH_PREFIX}/${name}`;
      const directory = path.join(root, name);

      // Check if directory already exists
      if (fs.existsSync(directory)) continue;

      // Check if branch already exists
      const branchCheck = await git(
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        repoDir,
      );
      if (branchCheck.code === 0) continue;

      return { name, branch, directory };
    }

    throw new Error(`Failed to generate unique worktree name after ${MAX_NAME_ATTEMPTS} attempts`);
  }

  async create(repoDir: string, options?: CreateWorktreeOptions): Promise<WorktreeInfo> {
    this.ensureInit();
    const projectId = await this.resolveProjectId(repoDir);
    const baseBranch = options?.baseBranch || (await this.detectMainBranch(repoDir));
    const candidate = await this.findCandidate(projectId, repoDir, options?.name);

    wtLog.info(
      `Creating worktree: ${candidate.name} (branch: ${candidate.branch}) from ${baseBranch}`,
    );

    const info: WorktreeInfo = {
      name: candidate.name,
      branch: candidate.branch,
      directory: candidate.directory,
      baseBranch,
      projectId,
      createdAt: Date.now(),
      status: "pending",
    };

    worktreeStore.add(info);

    try {
      // Create the worktree with a new branch from baseBranch
      const result = await git(
        ["worktree", "add", "-b", candidate.branch, candidate.directory, baseBranch],
        repoDir,
      );

      if (result.code !== 0) {
        throw new Error(`git worktree add failed: ${result.stderr}`);
      }

      worktreeStore.update(projectId, candidate.name, { status: "ready" });
      wtLog.info(`Worktree created: ${candidate.directory}`);

      return { ...info, status: "ready" };
    } catch (err) {
      worktreeStore.update(projectId, candidate.name, { status: "error" });
      // Cleanup on failure
      try {
        await fsp.rm(candidate.directory, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  async list(repoDir: string): Promise<WorktreeInfo[]> {
    this.ensureInit();
    const projectId = await this.resolveProjectId(repoDir);
    return worktreeStore.list(projectId);
  }

  async remove(repoDir: string, worktreeName: string): Promise<boolean> {
    this.ensureInit();
    const projectId = await this.resolveProjectId(repoDir);
    const info = worktreeStore.get(projectId, worktreeName);
    if (!info) {
      wtLog.warn(`Worktree not found: ${worktreeName} in project ${projectId}`);
      return false;
    }

    wtLog.info(`Removing worktree: ${worktreeName} at ${info.directory}`);

    // Remove git worktree
    const removeResult = await git(
      ["worktree", "remove", "--force", info.directory],
      repoDir,
    );

    if (removeResult.code !== 0) {
      wtLog.warn(`git worktree remove failed: ${removeResult.stderr}, cleaning up manually`);
    }

    // Force-clean the directory
    try {
      await fsp.rm(info.directory, { recursive: true, force: true });
    } catch {
      /* directory may already be gone */
    }

    // Delete the branch
    await git(["branch", "-D", info.branch], repoDir);

    // Remove from store
    worktreeStore.remove(projectId, worktreeName);

    wtLog.info(`Worktree removed: ${worktreeName}`);
    return true;
  }

  async merge(
    repoDir: string,
    worktreeName: string,
    targetBranch?: string,
  ): Promise<MergeResult> {
    this.ensureInit();
    const projectId = await this.resolveProjectId(repoDir);
    const info = worktreeStore.get(projectId, worktreeName);
    if (!info) {
      return { success: false, message: `Worktree not found: ${worktreeName}` };
    }

    const target = targetBranch || (await this.detectMainBranch(repoDir));

    wtLog.info(`Merging ${info.branch} into ${target}`);

    // Switch to target branch
    const checkout = await git(["checkout", target], repoDir);
    if (checkout.code !== 0) {
      return { success: false, message: `Failed to checkout ${target}: ${checkout.stderr}` };
    }

    // Merge
    const mergeResult = await git(["merge", "--no-ff", info.branch], repoDir);

    if (mergeResult.code !== 0) {
      // Check for merge conflicts
      const status = await git(["diff", "--name-only", "--diff-filter=U"], repoDir);
      const conflicts = status.stdout.split("\n").filter(Boolean);

      if (conflicts.length > 0) {
        // Abort the merge to leave repo in clean state
        await git(["merge", "--abort"], repoDir);
        return {
          success: false,
          conflicts,
          message: `Merge conflict in ${conflicts.length} file(s)`,
        };
      }

      return { success: false, message: `Merge failed: ${mergeResult.stderr}` };
    }

    return {
      success: true,
      message: `Successfully merged ${info.branch} into ${target}`,
    };
  }

  getWorktreeByName(projectId: string, name: string): WorktreeInfo | undefined {
    return worktreeStore.get(projectId, name);
  }

  getWorktreeByDirectory(directory: string): WorktreeInfo | undefined {
    return worktreeStore.findByDirectory(directory);
  }
}

export const worktreeManager = new WorktreeManager();
