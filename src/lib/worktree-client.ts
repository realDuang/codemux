import { WorktreeInfo } from "../stores/session";
import { Auth } from "./auth";

const BASE_URL = "/api/worktree";

async function request<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const token = Auth.getToken();
  if (!token) {
    throw new Error("Not authenticated");
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || "Request failed");
  }

  return response.json();
}

export const worktreeClient = {
  async create(projectPath: string, branchName: string, sessionId: string): Promise<WorktreeInfo> {
    return request<WorktreeInfo>("/create", { projectPath, branchName, sessionId });
  },

  async merge(
    worktreePath: string,
    projectPath: string,
    options?: { squash?: boolean; commitMessage?: string }
  ): Promise<{ success: boolean; message: string }> {
    return request("/merge", {
      worktreePath,
      projectPath,
      squash: options?.squash ?? true,
      commitMessage: options?.commitMessage,
    });
  },

  async push(
    worktreePath: string,
    newBranchName?: string
  ): Promise<{ success: boolean; remoteBranch: string }> {
    return request("/push", { worktreePath, newBranchName });
  },

  async abandon(worktreePath: string, projectPath: string): Promise<{ success: boolean }> {
    return request("/abandon", { worktreePath, projectPath });
  },

  async list(projectPath: string): Promise<{ worktrees: WorktreeInfo[] }> {
    return request("/list", { projectPath });
  },

  async getInfo(worktreePath: string): Promise<WorktreeInfo | null> {
    return request("/info", { worktreePath });
  },

  async cleanup(projectPath: string): Promise<{ cleaned: number }> {
    return request("/cleanup", { projectPath });
  },
};
