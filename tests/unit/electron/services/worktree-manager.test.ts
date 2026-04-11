import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockExecFile = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());
const mockCreateSlug = vi.hoisted(() => vi.fn());
const mockSlugify = vi.hoisted(() => vi.fn());

const mockWorktreeStore = vi.hoisted(() => ({
  init: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  findByDirectory: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: mockExecFile }));
vi.mock("node:fs", () => ({
  default: { existsSync: mockExistsSync, mkdirSync: mockMkdirSync },
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
}));
vi.mock("node:fs/promises", () => ({
  default: { rm: mockRm },
  rm: mockRm,
}));
vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/mock/userData") },
}));
vi.mock("electron-log/main", () => ({
  default: {
    scope: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));
vi.mock("../../../../electron/main/services/slug", () => ({
  createSlug: mockCreateSlug,
  slugify: mockSlugify,
}));
vi.mock("../../../../electron/main/services/worktree-store", () => ({
  worktreeStore: mockWorktreeStore,
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks registered)
// ---------------------------------------------------------------------------

import { worktreeManager } from "../../../../electron/main/services/worktree-manager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate execFile callback with given result */
function mockGitResult(result: {
  stdout?: string;
  stderr?: string;
  code?: number;
}): void {
  mockExecFile.mockImplementationOnce(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (
        error: Error | null,
        stdout: string | undefined,
        stderr: string | undefined,
      ) => void,
    ) => {
      if (result.code && result.code !== 0) {
        const err = new Error("git error") as Error & { status: number };
        err.status = result.code;
        cb(err, result.stdout ?? "", result.stderr ?? "");
      } else {
        cb(null, result.stdout ?? "", result.stderr ?? "");
      }
    },
  );
}

function mockGitSuccess(stdout = ""): void {
  mockGitResult({ stdout, code: 0 });
}

function mockGitFailure(stderr = "", code = 1): void {
  mockGitResult({ stderr, code });
}

const REPO_DIR = "/home/user/workspace/my-project";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Reset singleton internal state
  (worktreeManager as any).initialized = false;
  (worktreeManager as any).worktreeBase = null;
  // Default: directory does not exist → mkdirSync will be called
  mockExistsSync.mockReturnValue(false);
  mockRm.mockResolvedValue(undefined);
  mockCreateSlug.mockReturnValue("brave-cabin");
  mockSlugify.mockImplementation((s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =========================================================================
// resolveProjectId
// =========================================================================

describe("resolveProjectId", () => {
  it("extracts last segment from Unix path", async () => {
    const id = await worktreeManager.resolveProjectId("/home/user/workspace/my-project");
    expect(id).toBe("my-project");
  });

  it("handles trailing slashes", async () => {
    const id = await worktreeManager.resolveProjectId("/home/user/workspace/my-project///");
    expect(id).toBe("my-project");
  });

  it("handles Windows-style backslashes", async () => {
    const id = await worktreeManager.resolveProjectId("C:\\Users\\user\\workspace\\my-project");
    expect(id).toBe("my-project");
  });

  it("throws for empty/root path", async () => {
    await expect(worktreeManager.resolveProjectId("/")).rejects.toThrow(
      "Cannot determine project name",
    );
  });
});

// =========================================================================
// detectMainBranch
// =========================================================================

describe("detectMainBranch", () => {
  it("returns branch from symbolic-ref when available", async () => {
    mockGitSuccess("refs/remotes/origin/main");
    const branch = await worktreeManager.detectMainBranch(REPO_DIR);
    expect(branch).toBe("main");
  });

  it("falls back to 'main' when symbolic-ref fails and main exists", async () => {
    mockGitFailure(); // symbolic-ref fails
    mockGitSuccess(); // show-ref for "main" succeeds
    const branch = await worktreeManager.detectMainBranch(REPO_DIR);
    expect(branch).toBe("main");
  });

  it("falls back to 'master' when main does not exist", async () => {
    mockGitFailure(); // symbolic-ref fails
    mockGitFailure(); // show-ref for "main" fails
    mockGitSuccess(); // show-ref for "master" succeeds
    const branch = await worktreeManager.detectMainBranch(REPO_DIR);
    expect(branch).toBe("master");
  });

  it("falls back to 'develop' when main and master don't exist", async () => {
    mockGitFailure(); // symbolic-ref fails
    mockGitFailure(); // main fails
    mockGitFailure(); // master fails
    mockGitSuccess(); // develop succeeds
    const branch = await worktreeManager.detectMainBranch(REPO_DIR);
    expect(branch).toBe("develop");
  });

  it("falls back to current branch when no common names exist", async () => {
    mockGitFailure(); // symbolic-ref
    mockGitFailure(); // main
    mockGitFailure(); // master
    mockGitFailure(); // develop
    mockGitSuccess("feature/my-branch"); // rev-parse HEAD
    const branch = await worktreeManager.detectMainBranch(REPO_DIR);
    expect(branch).toBe("feature/my-branch");
  });

  it("falls back to 'main' as last resort", async () => {
    mockGitFailure(); // symbolic-ref
    mockGitFailure(); // main
    mockGitFailure(); // master
    mockGitFailure(); // develop
    mockGitFailure(); // rev-parse HEAD
    const branch = await worktreeManager.detectMainBranch(REPO_DIR);
    expect(branch).toBe("main");
  });

  it("ignores empty symbolic-ref output", async () => {
    mockGitResult({ stdout: "", code: 0 }); // symbolic-ref returns empty
    mockGitSuccess(); // show-ref for "main" succeeds
    const branch = await worktreeManager.detectMainBranch(REPO_DIR);
    expect(branch).toBe("main");
  });
});

// =========================================================================
// listBranches
// =========================================================================

describe("listBranches", () => {
  it("returns parsed branch list on success", async () => {
    mockGitSuccess("main\nfeature/foo\nfix/bar");
    const branches = await worktreeManager.listBranches(REPO_DIR);
    expect(branches).toEqual(["main", "feature/foo", "fix/bar"]);
  });

  it("returns empty array on failure", async () => {
    mockGitFailure();
    const branches = await worktreeManager.listBranches(REPO_DIR);
    expect(branches).toEqual([]);
  });

  it("filters out empty lines", async () => {
    mockGitSuccess("main\n\ndev\n");
    const branches = await worktreeManager.listBranches(REPO_DIR);
    expect(branches).toEqual(["main", "dev"]);
  });
});

// =========================================================================
// create
// =========================================================================

describe("create", () => {
  beforeEach(() => {
    // findCandidate needs: existsSync (directory), git show-ref (branch)
    mockExistsSync.mockReturnValue(false); // directory doesn't exist
  });

  it("creates worktree successfully", async () => {
    // detectMainBranch: symbolic-ref
    mockGitSuccess("refs/remotes/origin/main");
    // findCandidate: show-ref for branch → not found (good)
    mockGitFailure();
    // git worktree add → success
    mockGitSuccess();

    const result = await worktreeManager.create(REPO_DIR);

    expect(result.status).toBe("ready");
    expect(result.projectId).toBe("my-project");
    expect(result.baseBranch).toBe("main");
    expect(result.branch).toBe("codemux/brave-cabin");
    expect(mockWorktreeStore.add).toHaveBeenCalledOnce();
    expect(mockWorktreeStore.update).toHaveBeenCalledWith(
      "my-project",
      "brave-cabin",
      { status: "ready" },
    );
  });

  it("uses custom baseBranch when provided", async () => {
    // findCandidate: show-ref → not found
    mockGitFailure();
    // git worktree add → success
    mockGitSuccess();

    const result = await worktreeManager.create(REPO_DIR, {
      baseBranch: "develop",
    });

    expect(result.baseBranch).toBe("develop");
    // Verify git worktree add was called with the custom baseBranch
    const worktreeAddCall = mockExecFile.mock.calls.find(
      (c: any[]) => Array.isArray(c[1]) && c[1].includes("worktree"),
    );
    expect(worktreeAddCall![1]).toContain("develop");
  });

  it("uses slugified custom name", async () => {
    mockSlugify.mockReturnValue("my-feature");
    // detectMainBranch: symbolic-ref
    mockGitSuccess("refs/remotes/origin/main");
    // findCandidate: show-ref → not found
    mockGitFailure();
    // git worktree add
    mockGitSuccess();

    const result = await worktreeManager.create(REPO_DIR, {
      name: "My Feature!",
    });

    expect(result.name).toBe("my-feature");
    expect(result.branch).toBe("codemux/my-feature");
    expect(mockSlugify).toHaveBeenCalledWith("My Feature!");
  });

  it("cleans up and re-throws on git worktree add failure", async () => {
    // detectMainBranch
    mockGitSuccess("refs/remotes/origin/main");
    // findCandidate: show-ref → not found
    mockGitFailure();
    // git worktree add → failure
    mockGitFailure("fatal: cannot create worktree");

    await expect(worktreeManager.create(REPO_DIR)).rejects.toThrow(
      "git worktree add failed",
    );

    expect(mockWorktreeStore.update).toHaveBeenCalledWith(
      "my-project",
      "brave-cabin",
      { status: "error" },
    );
    expect(mockRm).toHaveBeenCalled();
  });

  it("skips existing directories during findCandidate", async () => {
    // First name attempt: directory exists
    mockExistsSync.mockReturnValueOnce(false); // ensureInit base dir
    mockExistsSync.mockReturnValueOnce(true); // first candidate directory exists
    mockExistsSync.mockReturnValueOnce(false); // second candidate directory doesn't exist

    mockCreateSlug.mockReturnValueOnce("brave-cabin");
    mockCreateSlug.mockReturnValueOnce("calm-moon");

    // detectMainBranch
    mockGitSuccess("refs/remotes/origin/main");
    // findCandidate: second attempt show-ref → not found
    mockGitFailure();
    // git worktree add → success
    mockGitSuccess();

    const result = await worktreeManager.create(REPO_DIR);
    expect(result.name).toBe("calm-moon");
  });

  it("skips existing branches during findCandidate", async () => {
    mockCreateSlug.mockReturnValueOnce("brave-cabin");
    mockCreateSlug.mockReturnValueOnce("calm-moon");

    // detectMainBranch
    mockGitSuccess("refs/remotes/origin/main");
    // findCandidate: first show-ref → branch exists
    mockGitSuccess();
    // findCandidate: second show-ref → not found
    mockGitFailure();
    // git worktree add → success
    mockGitSuccess();

    const result = await worktreeManager.create(REPO_DIR);
    expect(result.name).toBe("calm-moon");
  });
});

// =========================================================================
// list
// =========================================================================

describe("list", () => {
  it("delegates to worktreeStore.list with resolved projectId", async () => {
    const fakeList = [
      { name: "brave-cabin", projectId: "my-project" },
    ];
    mockWorktreeStore.list.mockReturnValue(fakeList);

    const result = await worktreeManager.list(REPO_DIR);

    expect(result).toBe(fakeList);
    expect(mockWorktreeStore.list).toHaveBeenCalledWith("my-project");
  });
});

// =========================================================================
// remove
// =========================================================================

describe("remove", () => {
  it("returns false when worktree not found", async () => {
    mockWorktreeStore.get.mockReturnValue(undefined);
    const result = await worktreeManager.remove(REPO_DIR, "nonexistent");
    expect(result).toBe(false);
  });

  it("removes worktree successfully", async () => {
    const info = {
      name: "brave-cabin",
      branch: "codemux/brave-cabin",
      directory: "/mock/userData/worktrees/my-project/brave-cabin",
      projectId: "my-project",
    };
    mockWorktreeStore.get.mockReturnValue(info);

    // git worktree remove → success
    mockGitSuccess();
    // git branch -D → success
    mockGitSuccess();

    const result = await worktreeManager.remove(REPO_DIR, "brave-cabin");

    expect(result).toBe(true);
    expect(mockRm).toHaveBeenCalledWith(info.directory, {
      recursive: true,
      force: true,
    });
    expect(mockWorktreeStore.remove).toHaveBeenCalledWith(
      "my-project",
      "brave-cabin",
    );
  });

  it("continues removal even if git worktree remove fails", async () => {
    const info = {
      name: "broken",
      branch: "codemux/broken",
      directory: "/mock/userData/worktrees/my-project/broken",
      projectId: "my-project",
    };
    mockWorktreeStore.get.mockReturnValue(info);

    // git worktree remove → failure
    mockGitFailure("error: failed to remove");
    // git branch -D → success
    mockGitSuccess();

    const result = await worktreeManager.remove(REPO_DIR, "broken");

    expect(result).toBe(true);
    expect(mockWorktreeStore.remove).toHaveBeenCalledWith(
      "my-project",
      "broken",
    );
  });
});

// =========================================================================
// merge — rebase mode
// =========================================================================

describe("merge - rebase mode", () => {
  const worktreeInfo = {
    name: "feature-wt",
    branch: "codemux/feature-wt",
    directory: "/mock/userData/worktrees/my-project/feature-wt",
    baseBranch: "main",
    projectId: "my-project",
  };

  beforeEach(() => {
    mockWorktreeStore.get.mockReturnValue(worktreeInfo);
  });

  it("returns failure when worktree not found", async () => {
    mockWorktreeStore.get.mockReturnValue(undefined);
    const result = await worktreeManager.merge(REPO_DIR, "nonexistent", {
      mode: "rebase",
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("succeeds with rebase + fast-forward", async () => {
    // detectMainBranch
    mockGitSuccess("refs/remotes/origin/main");
    // rebase → success
    mockGitSuccess();
    // updateTargetBranch: rev-parse HEAD → current branch is "main"
    mockGitSuccess("main");
    // merge --ff-only → success
    mockGitSuccess();

    const result = await worktreeManager.merge(REPO_DIR, "feature-wt", {
      mode: "rebase",
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("rebased");
  });

  it("aborts on rebase failure", async () => {
    // detectMainBranch
    mockGitSuccess("refs/remotes/origin/main");
    // rebase → failure
    mockGitFailure("CONFLICT");
    // rebase --abort → success
    mockGitSuccess();

    const result = await worktreeManager.merge(REPO_DIR, "feature-wt", {
      mode: "rebase",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Rebase failed");
  });

  it("reports failure when updateTargetBranch fails after successful rebase", async () => {
    // detectMainBranch
    mockGitSuccess("refs/remotes/origin/main");
    // rebase → success
    mockGitSuccess();
    // updateTargetBranch: rev-parse HEAD
    mockGitSuccess("main");
    // merge --ff-only → failure
    mockGitFailure("not possible");
    // merge --no-ff → failure
    mockGitFailure("conflict");

    const result = await worktreeManager.merge(REPO_DIR, "feature-wt", {
      mode: "rebase",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Fast-forward after rebase failed");
  });
});

// =========================================================================
// merge — squash mode
// =========================================================================

describe("merge - squash mode", () => {
  const worktreeInfo = {
    name: "feature-wt",
    branch: "codemux/feature-wt",
    directory: "/mock/userData/worktrees/my-project/feature-wt",
    baseBranch: "main",
    projectId: "my-project",
  };

  beforeEach(() => {
    mockWorktreeStore.get.mockReturnValue(worktreeInfo);
  });

  it("succeeds with squash merge", async () => {
    // detectMainBranch
    mockGitSuccess("refs/remotes/origin/main");
    // merge --squash → success
    mockGitSuccess();
    // commit → success
    mockGitSuccess();
    // updateTargetBranch: rev-parse HEAD
    mockGitSuccess("main");
    // merge --ff-only → success
    mockGitSuccess();

    const result = await worktreeManager.merge(REPO_DIR, "feature-wt", {
      mode: "squash",
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("squash-merged");
  });

  it("reports conflicts in squash mode", async () => {
    // detectMainBranch
    mockGitSuccess("refs/remotes/origin/main");
    // merge --squash → failure
    mockGitFailure("CONFLICT");
    // diff --name-only (conflict files)
    mockGitSuccess("file1.ts\nfile2.ts");
    // reset --merge
    mockGitSuccess();

    const result = await worktreeManager.merge(REPO_DIR, "feature-wt", {
      mode: "squash",
    });

    expect(result.success).toBe(false);
    expect(result.conflicts).toEqual(["file1.ts", "file2.ts"]);
    expect(result.message).toContain("2 file(s)");
  });

  it("reports non-conflict squash failure", async () => {
    // detectMainBranch
    mockGitSuccess("refs/remotes/origin/main");
    // merge --squash → failure
    mockGitFailure("some error");
    // diff --name-only → no conflicts
    mockGitSuccess("");

    const result = await worktreeManager.merge(REPO_DIR, "feature-wt", {
      mode: "squash",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Squash merge failed");
  });

  it("reports failure when updateTargetBranch fails after squash", async () => {
    // detectMainBranch
    mockGitSuccess("refs/remotes/origin/main");
    // merge --squash → success
    mockGitSuccess();
    // commit → success
    mockGitSuccess();
    // updateTargetBranch: rev-parse HEAD
    mockGitSuccess("develop"); // target not checked out
    // fetch → failure
    mockGitFailure("failed");

    const result = await worktreeManager.merge(REPO_DIR, "feature-wt", {
      mode: "squash",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Update target after squash failed");
  });
});

// =========================================================================
// merge — default (merge) mode
// =========================================================================

describe("merge - default merge mode", () => {
  const worktreeInfo = {
    name: "feature-wt",
    branch: "codemux/feature-wt",
    directory: "/mock/userData/worktrees/my-project/feature-wt",
    baseBranch: "main",
    projectId: "my-project",
  };

  beforeEach(() => {
    mockWorktreeStore.get.mockReturnValue(worktreeInfo);
  });

  it("succeeds with fast-forward", async () => {
    // detectMainBranch
    mockGitSuccess("refs/remotes/origin/main");
    // updateTargetBranch: rev-parse HEAD → target checked out
    mockGitSuccess("main");
    // merge --ff-only → success
    mockGitSuccess();

    const result = await worktreeManager.merge(REPO_DIR, "feature-wt");

    expect(result.success).toBe(true);
    expect(result.message).toContain("Successfully merged");
  });

  it("succeeds when fast-forward fails but merge in worktree works", async () => {
    // detectMainBranch
    mockGitSuccess("refs/remotes/origin/main");
    // updateTargetBranch (first): rev-parse HEAD → not checked out
    mockGitSuccess("develop");
    // fetch → failure (not fast-forward)
    mockGitFailure("not fast-forward");
    // merge --no-ff in worktree → success
    mockGitSuccess();
    // updateTargetBranch (retry): rev-parse HEAD
    mockGitSuccess("develop");
    // fetch → success
    mockGitSuccess();

    const result = await worktreeManager.merge(REPO_DIR, "feature-wt");

    expect(result.success).toBe(true);
  });

  it("detects merge conflicts and aborts", async () => {
    // detectMainBranch
    mockGitSuccess("refs/remotes/origin/main");
    // updateTargetBranch: rev-parse HEAD → checked out
    mockGitSuccess("main");
    // merge --ff-only → failure
    mockGitFailure();
    // merge --no-ff → also failure
    mockGitFailure();
    // merge --no-ff in worktree → failure
    mockGitFailure("CONFLICT");
    // diff --name-only → conflict files
    mockGitSuccess("src/index.ts\nsrc/main.ts");
    // merge --abort
    mockGitSuccess();

    const result = await worktreeManager.merge(REPO_DIR, "feature-wt");

    expect(result.success).toBe(false);
    expect(result.conflicts).toEqual(["src/index.ts", "src/main.ts"]);
  });

  it("uses custom targetBranch and message", async () => {
    // No detectMainBranch call since targetBranch is provided
    // updateTargetBranch: rev-parse HEAD → target checked out
    mockGitSuccess("develop");
    // merge --ff-only → success
    mockGitSuccess();

    const result = await worktreeManager.merge(REPO_DIR, "feature-wt", {
      targetBranch: "develop",
      message: "Custom merge message",
    });

    expect(result.success).toBe(true);
  });

  it("uses fetch for non-checked-out target branch (fast-forward)", async () => {
    // detectMainBranch
    mockGitSuccess("refs/remotes/origin/main");
    // updateTargetBranch: rev-parse HEAD → different branch
    mockGitSuccess("develop");
    // fetch . source:target → success
    mockGitSuccess();

    const result = await worktreeManager.merge(REPO_DIR, "feature-wt");

    expect(result.success).toBe(true);
    // Verify fetch was called
    const fetchCall = mockExecFile.mock.calls.find(
      (c: any[]) => Array.isArray(c[1]) && c[1].includes("fetch"),
    );
    expect(fetchCall).toBeTruthy();
  });

  it("falls back to --no-ff merge when --ff-only fails on checked-out branch", async () => {
    // detectMainBranch
    mockGitSuccess("refs/remotes/origin/main");
    // updateTargetBranch: rev-parse HEAD → checked out
    mockGitSuccess("main");
    // merge --ff-only → failure
    mockGitFailure();
    // merge --no-ff → success
    mockGitSuccess();

    const result = await worktreeManager.merge(REPO_DIR, "feature-wt");

    expect(result.success).toBe(true);
  });
});

// =========================================================================
// getWorktreeByName / getWorktreeByDirectory
// =========================================================================

describe("getWorktreeByName", () => {
  it("delegates to worktreeStore.get", () => {
    const info = { name: "test", projectId: "proj" };
    mockWorktreeStore.get.mockReturnValue(info);

    const result = worktreeManager.getWorktreeByName("proj", "test");
    expect(result).toBe(info);
    expect(mockWorktreeStore.get).toHaveBeenCalledWith("proj", "test");
  });
});

describe("getWorktreeByDirectory", () => {
  it("delegates to worktreeStore.findByDirectory", () => {
    const info = { name: "test", directory: "/some/path" };
    mockWorktreeStore.findByDirectory.mockReturnValue(info);

    const result = worktreeManager.getWorktreeByDirectory("/some/path");
    expect(result).toBe(info);
    expect(mockWorktreeStore.findByDirectory).toHaveBeenCalledWith(
      "/some/path",
    );
  });
});

// =========================================================================
// ensureInit
// =========================================================================

describe("init / ensureInit", () => {
  it("initializes worktreeBase and creates directory if needed", () => {
    mockExistsSync.mockReturnValue(false);
    worktreeManager.init();

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("worktrees"),
      { recursive: true },
    );
    expect(mockWorktreeStore.init).toHaveBeenCalledOnce();
  });

  it("skips directory creation if it already exists", () => {
    mockExistsSync.mockReturnValue(true);
    worktreeManager.init();

    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockWorktreeStore.init).toHaveBeenCalledOnce();
  });

  it("only initializes once", () => {
    mockExistsSync.mockReturnValue(false);
    worktreeManager.init();
    worktreeManager.init();

    expect(mockWorktreeStore.init).toHaveBeenCalledOnce();
  });
});
