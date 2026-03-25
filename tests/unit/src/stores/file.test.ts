import { describe, it, expect } from "vitest";
import {
  getGitStatusLabel,
  getGitStatusColor,
  getFileGitStatus,
  setFileStore,
  fileStore,
  togglePanel,
  openPanel,
  closePanel,
  setPanelWidth,
  setTreeWidth,
  setActiveFileTab,
} from "../../../../src/stores/file";

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
      const entries = [
        { path: "src/main.ts", status: "modified" as const, added: 5, removed: 2 },
        { path: "README.md", status: "untracked" as const, added: 10 },
      ];
      setFileStore("gitStatus", entries);
      setFileStore("gitStatusByPath", Object.fromEntries(entries.map((e) => [e.path, e])));

      const result = getFileGitStatus("src/main.ts");
      expect(result).toBeDefined();
      expect(result!.path).toBe("src/main.ts");
      expect(result!.status).toBe("modified");
      expect(result!.added).toBe(5);
      expect(result!.removed).toBe(2);
    });

    it("returns undefined for paths not in gitStatus", () => {
      const entries = [
        { path: "src/main.ts", status: "modified" as const },
      ];
      setFileStore("gitStatus", entries);
      setFileStore("gitStatusByPath", Object.fromEntries(entries.map((e) => [e.path, e])));

      const result = getFileGitStatus("nonexistent.ts");
      expect(result).toBeUndefined();
    });

    it("returns undefined when gitStatus is empty", () => {
      setFileStore("gitStatus", []);
      setFileStore("gitStatusByPath", {});
      const result = getFileGitStatus("any-file.ts");
      expect(result).toBeUndefined();
    });
  });

  describe("gitStatusByPath lookup", () => {
    it("provides O(1) lookup by path after git status loads", () => {
      const entries = [
        { path: "src/a.ts", status: "modified" as const, added: 1, removed: 0 },
        { path: "src/b.ts", status: "added" as const, added: 10 },
        { path: "lib/c.ts", status: "deleted" as const, removed: 5 },
        { path: "README.md", status: "untracked" as const },
      ];
      setFileStore("gitStatus", entries);
      setFileStore(
        "gitStatusByPath",
        Object.fromEntries(entries.map((e) => [e.path, e])),
      );

      expect(getFileGitStatus("src/a.ts")?.status).toBe("modified");
      expect(getFileGitStatus("src/b.ts")?.status).toBe("added");
      expect(getFileGitStatus("lib/c.ts")?.status).toBe("deleted");
      expect(getFileGitStatus("README.md")?.status).toBe("untracked");
      expect(getFileGitStatus("nonexistent")).toBeUndefined();
    });
  });

  describe("panel state", () => {
    it("togglePanel flips panelOpen", () => {
      setFileStore("panelOpen", false);
      expect(fileStore.panelOpen).toBe(false);
      togglePanel();
      expect(fileStore.panelOpen).toBe(true);
      togglePanel();
      expect(fileStore.panelOpen).toBe(false);
    });

    it("openPanel sets panelOpen to true", () => {
      setFileStore("panelOpen", false);
      openPanel();
      expect(fileStore.panelOpen).toBe(true);
      // Calling again is idempotent
      openPanel();
      expect(fileStore.panelOpen).toBe(true);
    });

    it("closePanel sets panelOpen to false", () => {
      setFileStore("panelOpen", true);
      closePanel();
      expect(fileStore.panelOpen).toBe(false);
    });
  });

  describe("panel dimensions", () => {
    it("setPanelWidth clamps to [300, 1200]", () => {
      setPanelWidth(100);
      expect(fileStore.panelWidth).toBe(300);
      setPanelWidth(2000);
      expect(fileStore.panelWidth).toBe(1200);
      setPanelWidth(600);
      expect(fileStore.panelWidth).toBe(600);
    });

    it("setTreeWidth clamps to [120, 400]", () => {
      setTreeWidth(50);
      expect(fileStore.treeWidth).toBe(120);
      setTreeWidth(999);
      expect(fileStore.treeWidth).toBe(400);
      setTreeWidth(250);
      expect(fileStore.treeWidth).toBe(250);
    });
  });

  describe("tab state", () => {
    it("setActiveFileTab switches between files and changes", () => {
      setActiveFileTab("files");
      expect(fileStore.activeTab).toBe("files");
      setActiveFileTab("changes");
      expect(fileStore.activeTab).toBe("changes");
    });
  });
});
