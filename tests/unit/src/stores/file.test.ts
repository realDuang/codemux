import { describe, it, expect } from "vitest";
import { getGitStatusLabel, getGitStatusColor, getFileGitStatus, setFileStore } from "../../../../src/stores/file";

describe("file store helpers", () => {
  describe("getGitStatusLabel", () => {
    it("returns A for added files", () => {
      expect(getGitStatusLabel("added")).toBe("A");
    });
    it("returns A for untracked files", () => {
      expect(getGitStatusLabel("untracked")).toBe("A");
    });
    it("returns D for deleted files", () => {
      expect(getGitStatusLabel("deleted")).toBe("D");
    });
    it("returns M for modified files", () => {
      expect(getGitStatusLabel("modified")).toBe("M");
    });
    it("returns M for renamed files", () => {
      expect(getGitStatusLabel("renamed")).toBe("M");
    });
  });

  describe("getGitStatusColor", () => {
    it("returns green for added", () => {
      expect(getGitStatusColor("added")).toContain("green");
    });
    it("returns green for untracked", () => {
      expect(getGitStatusColor("untracked")).toContain("green");
    });
    it("returns red for deleted", () => {
      expect(getGitStatusColor("deleted")).toContain("red");
    });
    it("returns yellow for modified", () => {
      expect(getGitStatusColor("modified")).toContain("yellow");
    });
  });

  describe("getFileGitStatus", () => {
    it("returns matching GitFileStatus when gitStatus is populated", () => {
      setFileStore("gitStatus", [
        { path: "src/main.ts", status: "modified", added: 5, removed: 2 },
        { path: "README.md", status: "untracked", added: 10 },
      ]);

      const result = getFileGitStatus("src/main.ts");
      expect(result).toBeDefined();
      expect(result!.path).toBe("src/main.ts");
      expect(result!.status).toBe("modified");
      expect(result!.added).toBe(5);
      expect(result!.removed).toBe(2);
    });

    it("returns undefined for paths not in gitStatus", () => {
      setFileStore("gitStatus", [
        { path: "src/main.ts", status: "modified" },
      ]);

      const result = getFileGitStatus("nonexistent.ts");
      expect(result).toBeUndefined();
    });

    it("returns undefined when gitStatus is empty", () => {
      setFileStore("gitStatus", []);
      const result = getFileGitStatus("any-file.ts");
      expect(result).toBeUndefined();
    });
  });
});
