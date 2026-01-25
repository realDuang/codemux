import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

const WORKTREE_BASE_DIR = path.join(os.homedir(), ".opencode", "worktrees");

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseBranch: string;
  status: "active" | "merged" | "pushed" | "abandoned";
  createdAt: string;
  ahead?: number;
  behind?: number;
  hasUncommitted?: boolean;
}

export interface WorktreeCreateOptions {
  projectPath: string;
  branchName: string;
  sessionId: string;
}

export interface WorktreeMergeOptions {
  worktreePath: string;
  projectPath: string;
  squash?: boolean;
  commitMessage?: string;
}

export interface WorktreePushOptions {
  worktreePath: string;
  newBranchName?: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
}

function getProjectName(projectPath: string): string {
  return path.basename(projectPath);
}

async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd });
  return stdout.trim();
}

async function getGitStatus(worktreePath: string, baseBranch: string): Promise<{
  ahead: number;
  behind: number;
  hasUncommitted: boolean;
}> {
  try {
    const { stdout: statusOutput } = await execAsync("git status --porcelain", { cwd: worktreePath });
    const hasUncommitted = statusOutput.trim().length > 0;

    await execAsync("git fetch origin", { cwd: worktreePath }).catch(() => {});

    const { stdout: aheadBehind } = await execAsync(
      `git rev-list --left-right --count HEAD...origin/${baseBranch}`,
      { cwd: worktreePath }
    ).catch(() => ({ stdout: "0\t0" }));

    const [ahead, behind] = aheadBehind.trim().split("\t").map(Number);

    return { ahead: ahead || 0, behind: behind || 0, hasUncommitted };
  } catch {
    return { ahead: 0, behind: 0, hasUncommitted: false };
  }
}

export const worktreeService = {
  async create(options: WorktreeCreateOptions): Promise<WorktreeInfo> {
    const { projectPath, branchName, sessionId } = options;
    const projectName = getProjectName(projectPath);
    const taskSlug = slugify(branchName);

    const worktreeDir = path.join(WORKTREE_BASE_DIR, projectName, taskSlug);
    const fullBranchName = `opencode-remote/${taskSlug}`;

    if (!fs.existsSync(path.dirname(worktreeDir))) {
      fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
    }

    const baseBranch = await getCurrentBranch(projectPath);

    await execAsync(
      `git worktree add -b "${fullBranchName}" "${worktreeDir}"`,
      { cwd: projectPath }
    );

    const info: WorktreeInfo = {
      path: worktreeDir,
      branch: fullBranchName,
      baseBranch,
      status: "active",
      createdAt: new Date().toISOString(),
      ahead: 0,
      behind: 0,
      hasUncommitted: false,
    };

    const metadataPath = path.join(worktreeDir, ".opencode-worktree.json");
    fs.writeFileSync(metadataPath, JSON.stringify({ ...info, sessionId }, null, 2));

    return info;
  },

  async merge(options: WorktreeMergeOptions): Promise<{ success: boolean; message: string }> {
    const { worktreePath, projectPath, squash = true, commitMessage } = options;

    const metadataPath = path.join(worktreePath, ".opencode-worktree.json");
    if (!fs.existsSync(metadataPath)) {
      throw new Error("Worktree metadata not found");
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    const { branch, baseBranch } = metadata;

    const { stdout: statusOutput } = await execAsync("git status --porcelain", { cwd: worktreePath });
    if (statusOutput.trim().length > 0) {
      throw new Error("Worktree has uncommitted changes. Please commit or stash them first.");
    }

    await execAsync(`git checkout ${baseBranch}`, { cwd: projectPath });

    if (squash) {
      await execAsync(`git merge --squash ${branch}`, { cwd: projectPath });
      const message = commitMessage || `Squash merge from ${branch}`;
      await execAsync(`git commit -m "${message}"`, { cwd: projectPath });
    } else {
      await execAsync(`git merge ${branch}`, { cwd: projectPath });
    }

    await execAsync(`git worktree remove "${worktreePath}"`, { cwd: projectPath });
    await execAsync(`git branch -D ${branch}`, { cwd: projectPath });

    return { success: true, message: `Successfully merged ${branch} into ${baseBranch}` };
  },

  async push(options: WorktreePushOptions): Promise<{ success: boolean; remoteBranch: string }> {
    const { worktreePath, newBranchName } = options;

    const metadataPath = path.join(worktreePath, ".opencode-worktree.json");
    if (!fs.existsSync(metadataPath)) {
      throw new Error("Worktree metadata not found");
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    const currentBranch = metadata.branch;

    if (newBranchName && newBranchName !== currentBranch) {
      await execAsync(`git branch -m ${currentBranch} ${newBranchName}`, { cwd: worktreePath });
      metadata.branch = newBranchName;
      metadata.status = "pushed";
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    }

    const remoteBranch = newBranchName || currentBranch;
    await execAsync(`git push -u origin ${remoteBranch}`, { cwd: worktreePath });

    return { success: true, remoteBranch };
  },

  async abandon(worktreePath: string, projectPath: string): Promise<{ success: boolean }> {
    const metadataPath = path.join(worktreePath, ".opencode-worktree.json");
    let branch: string | undefined;

    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
      branch = metadata.branch;
    }

    await execAsync(`git worktree remove --force "${worktreePath}"`, { cwd: projectPath });

    if (branch) {
      await execAsync(`git branch -D ${branch}`, { cwd: projectPath }).catch(() => {});
    }

    return { success: true };
  },

  async list(projectPath: string): Promise<WorktreeInfo[]> {
    const projectName = getProjectName(projectPath);
    const projectWorktreeDir = path.join(WORKTREE_BASE_DIR, projectName);

    if (!fs.existsSync(projectWorktreeDir)) {
      return [];
    }

    const entries = fs.readdirSync(projectWorktreeDir, { withFileTypes: true });
    const worktrees: WorktreeInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const worktreePath = path.join(projectWorktreeDir, entry.name);
      const metadataPath = path.join(worktreePath, ".opencode-worktree.json");

      if (!fs.existsSync(metadataPath)) continue;

      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
        const gitStatus = await getGitStatus(worktreePath, metadata.baseBranch);

        worktrees.push({
          ...metadata,
          ...gitStatus,
        });
      } catch {
        continue;
      }
    }

    return worktrees;
  },

  async getInfo(worktreePath: string): Promise<WorktreeInfo | null> {
    const metadataPath = path.join(worktreePath, ".opencode-worktree.json");

    if (!fs.existsSync(metadataPath)) {
      return null;
    }

    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
      const gitStatus = await getGitStatus(worktreePath, metadata.baseBranch);

      return { ...metadata, ...gitStatus };
    } catch {
      return null;
    }
  },

  async cleanup(projectPath: string): Promise<{ cleaned: number }> {
    const { stdout } = await execAsync("git worktree list --porcelain", { cwd: projectPath });
    const lines = stdout.split("\n");

    let cleaned = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("worktree ")) {
        const wtPath = line.substring(9);
        if (wtPath.includes(".opencode/worktrees") && !fs.existsSync(wtPath)) {
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      await execAsync("git worktree prune", { cwd: projectPath });
    }

    return { cleaned };
  },
};
