import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock electron's app module before importing the store
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/codemux-test"),
  },
}));

vi.mock("electron-log/main", () => ({
  default: {
    scope: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
  },
}));

import fs from "fs";
import fsp from "fs/promises";
import { WorktreeStore, type WorktreeInfo } from "../../../../electron/main/services/worktree-store";

function makeWorktree(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    name: "brave-cabin",
    branch: "codemux/brave-cabin",
    directory: "/tmp/codemux-test/worktrees/abc123/brave-cabin",
    baseBranch: "main",
    projectId: "abc123",
    createdAt: Date.now(),
    status: "ready",
    ...overrides,
  };
}

describe("WorktreeStore", () => {
  let store: WorktreeStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new WorktreeStore();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    store.init();
  });

  describe("CRUD operations", () => {
    it("add and list worktrees for a project", () => {
      const wt = makeWorktree();
      store.add(wt);

      const list = store.list("abc123");
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("brave-cabin");
    });

    it("get worktree by name", () => {
      store.add(makeWorktree());
      const wt = store.get("abc123", "brave-cabin");
      expect(wt).toBeDefined();
      expect(wt!.branch).toBe("codemux/brave-cabin");
    });

    it("returns undefined for missing worktree", () => {
      expect(store.get("abc123", "nonexistent")).toBeUndefined();
    });

    it("update worktree status", () => {
      store.add(makeWorktree({ status: "pending" }));
      store.update("abc123", "brave-cabin", { status: "ready" });
      expect(store.get("abc123", "brave-cabin")!.status).toBe("ready");
    });

    it("remove worktree", () => {
      store.add(makeWorktree());
      const deleted = store.remove("abc123", "brave-cabin");
      expect(deleted).toBe(true);
      expect(store.list("abc123")).toHaveLength(0);
    });

    it("remove nonexistent returns false", () => {
      expect(store.remove("abc123", "nonexistent")).toBe(false);
    });

    it("supports multiple projects", () => {
      store.add(makeWorktree({ projectId: "p1", name: "a" }));
      store.add(makeWorktree({ projectId: "p2", name: "b" }));
      expect(store.list("p1")).toHaveLength(1);
      expect(store.list("p2")).toHaveLength(1);
    });
  });

  describe("findByDirectory", () => {
    it("finds worktree by normalized directory", () => {
      store.add(makeWorktree());
      const found = store.findByDirectory("/tmp/codemux-test/worktrees/abc123/brave-cabin");
      expect(found).toBeDefined();
      expect(found!.name).toBe("brave-cabin");
    });

    it("handles trailing slashes", () => {
      store.add(makeWorktree());
      const found = store.findByDirectory("/tmp/codemux-test/worktrees/abc123/brave-cabin/");
      expect(found).toBeDefined();
    });

    it("returns undefined for unknown directory", () => {
      expect(store.findByDirectory("/unknown/path")).toBeUndefined();
    });
  });

  describe("persistence", () => {
    it("flush triggers atomic write", async () => {
      store.add(makeWorktree());
      await store.flush();
      expect(fsp.writeFile).toHaveBeenCalled();
      expect(fsp.rename).toHaveBeenCalled();
    });
  });
});
