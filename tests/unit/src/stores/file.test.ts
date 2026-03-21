import { describe, it, expect } from "vitest";
import { getGitStatusLabel, getGitStatusColor } from "../../../../src/stores/file";

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
});
