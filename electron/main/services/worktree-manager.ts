/**
 * Core worktree management service.
 * Handles git worktree creation, listing, removal, and merging.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import log from "electron-log/main";
import { getWorktreesPath } from "./app-paths";
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

export interface MergeWorktreeOptions {
  targetBranch?: string;
  mode?: "merge" | "squash" | "rebase";
  message?: string;
}

class WorktreeManager {
  private worktreeBase: string | null = null;
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    this.worktreeBase = getWorktreesPath();
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
    // Use the last segment of the repo directory as the project identifier
    // e.g. "/Users/user/workspace/codemux" → "codemux"
    const normalized = repoDir.replace(/\\/g, "/").replace(/\/+$/, "");
    const name = normalized.split("/").filter(Boolean).pop();
    if (!name) {
      throw new Error(`Cannot determine project name for ${repoDir}`);
    }
    return name;
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

  /**
   * Update target branch to point at worktree branch.
   * If target is the currently checked-out branch in repoDir, use `git merge`.
   * Otherwise use `git fetch .` for a safe fast-forward without checkout.
   */
  private async updateTargetBranch(
    repoDir: string,
    sourceBranch: string,
    targetBranch: string,
    mergeMessage: string,
  ): Promise<{ ok: boolean; stderr: string }> {
    // Check if target is the current branch in the main repo
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
    const currentBranch = head.code === 0 ? head.stdout : "";

    if (currentBranch === targetBranch) {
      // Target is checked out — merge directly in the main repo
      const result = await git(["merge", "--ff-only", sourceBranch], repoDir);
      if (result.code === 0) return { ok: true, stderr: "" };
      // ff-only failed, try with merge commit
      const result2 = await git(["merge", "--no-ff", "-m", mergeMessage, sourceBranch], repoDir);
      return { ok: result2.code === 0, stderr: result2.stderr };
    }

    // Target is NOT checked out — safe to use fetch
    const ff = await git(["fetch", ".", `${sourceBranch}:${targetBranch}`], repoDir);
    return { ok: ff.code === 0, stderr: ff.stderr };
  }

  async merge(
    repoDir: string,
    worktreeName: string,
    options?: MergeWorktreeOptions,
  ): Promise<MergeResult> {
    this.ensureInit();
    const projectId = await this.resolveProjectId(repoDir);
    const info = worktreeStore.get(projectId, worktreeName);
    if (!info) {
      return { success: false, message: `Worktree not found: ${worktreeName}` };
    }

    const target = options?.targetBranch || (await this.detectMainBranch(repoDir));
    const mode = options?.mode || "merge";
    const message = options?.message || `Merge ${info.branch} into ${target}`;

    wtLog.info(`Merging ${info.branch} into ${target} (mode: ${mode})`);

    if (mode === "rebase") {
      const rebase = await git(["rebase", target], info.directory);
      if (rebase.code !== 0) {
        await git(["rebase", "--abort"], info.directory);
        return { success: false, message: `Rebase failed: ${rebase.stderr}` };
      }
      const upd = await this.updateTargetBranch(repoDir, info.branch, target, message);
      if (upd.ok) {
        return { success: true, message: `Successfully rebased ${info.branch} onto ${target}` };
      }
      return { success: false, message: `Fast-forward after rebase failed: ${upd.stderr}` };
    }

    if (mode === "squash") {
      const squashMerge = await git(["merge", "--squash", target], info.directory);
      if (squashMerge.code !== 0) {
        const status = await git(["diff", "--name-only", "--diff-filter=U"], info.directory);
        const conflicts = status.stdout.split("\n").filter(Boolean);
        if (conflicts.length > 0) {
          await git(["reset", "--merge"], info.directory);
          return { success: false, conflicts, message: `Squash merge conflict in ${conflicts.length} file(s)` };
        }
        return { success: false, message: `Squash merge failed: ${squashMerge.stderr}` };
      }
      await git(["commit", "-m", message], info.directory);
      const upd = await this.updateTargetBranch(repoDir, info.branch, target, message);
      if (upd.ok) {
        return { success: true, message: `Successfully squash-merged ${info.branch} into ${target}` };
      }
      return { success: false, message: `Update target after squash failed: ${upd.stderr}` };
    }

    // Default: regular merge
    // Try fast-forward first
    const upd = await this.updateTargetBranch(repoDir, info.branch, target, message);
    if (upd.ok) {
      return { success: true, message: `Successfully merged ${info.branch} into ${target}` };
    }

    // Fast-forward failed — merge target INTO worktree, then update target
    const wtMerge = await git(["merge", "--no-ff", "-m", message, target], info.directory);
    if (wtMerge.code === 0) {
      const retry = await this.updateTargetBranch(repoDir, info.branch, target, message);
      if (retry.ok) {
        return { success: true, message: `Successfully merged ${info.branch} into ${target}` };
      }
    }

    // Check for merge conflicts
    const status = await git(["diff", "--name-only", "--diff-filter=U"], info.directory);
    const conflicts = status.stdout.split("\n").filter(Boolean);
    if (conflicts.length > 0) {
      await git(["merge", "--abort"], info.directory);
      return { success: false, conflicts, message: `Merge conflict in ${conflicts.length} file(s)` };
    }

    return { success: false, message: `Merge failed: ${upd.stderr || wtMerge.stderr}` };
  }

  getWorktreeByName(projectId: string, name: string): WorktreeInfo | undefined {
    return worktreeStore.get(projectId, name);
  }

  getWorktreeByDirectory(directory: string): WorktreeInfo | undefined {
    return worktreeStore.findByDirectory(directory);
  }
}

export const worktreeManager = new WorktreeManager();
