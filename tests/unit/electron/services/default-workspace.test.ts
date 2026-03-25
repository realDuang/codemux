import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock electron app before importing the module
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === "userData") return "/mock/userData";
      return "/mock/" + name;
    }),
  },
}));

const mkdirSyncMock = vi.fn();
vi.mock("node:fs", () => ({
  default: { mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args) },
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
}));

import { getDefaultWorkspacePath, ensureDefaultWorkspace } from "../../../../electron/main/services/default-workspace";

describe("default-workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getDefaultWorkspacePath", () => {
    it("returns path under userData/workspace", () => {
      const result = getDefaultWorkspacePath();
      // path.join normalizes separators per platform
      expect(result).toMatch(/mock[\\/]userData[\\/]workspace$/);
    });
  });

  describe("ensureDefaultWorkspace", () => {
    it("creates directory with recursive option and returns path", () => {
      const result = ensureDefaultWorkspace();
      expect(mkdirSyncMock).toHaveBeenCalledWith(
        expect.stringMatching(/workspace$/),
        { recursive: true },
      );
      expect(result).toBe(getDefaultWorkspacePath());
    });
  });
});
