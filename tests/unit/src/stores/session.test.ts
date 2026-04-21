import { beforeEach, describe, expect, it, vi } from "vitest";

const { storeContainer } = vi.hoisted(() => {
  const storeContainer: { data: any; setter: any } = { data: {}, setter: null };
  return { storeContainer };
});

vi.mock("solid-js/store", () => ({
  createStore: vi.fn((initial: any) => {
    Object.keys(storeContainer.data).forEach((key: string) => delete storeContainer.data[key]);
    Object.assign(storeContainer.data, initial);

    storeContainer.setter = (pathOrValue: any, ...args: any[]) => {
      if (args.length === 0) {
        Object.keys(storeContainer.data).forEach((key: string) => delete storeContainer.data[key]);
        Object.assign(storeContainer.data, pathOrValue);
        return;
      }

      if (args.length === 1) {
        const value = typeof args[0] === "function" ? args[0](storeContainer.data[pathOrValue]) : args[0];
        storeContainer.data[pathOrValue] = value;
        return;
      }

      if (args.length === 2) {
        if (!storeContainer.data[pathOrValue] || typeof storeContainer.data[pathOrValue] !== "object") {
          storeContainer.data[pathOrValue] = {};
        }
        storeContainer.data[pathOrValue] = { ...storeContainer.data[pathOrValue], [args[0]]: args[1] };
        return;
      }

      if (args.length === 3 && pathOrValue === "list" && typeof args[0] === "function") {
        storeContainer.data.list = args[0](storeContainer.data.list);
      }
    };

    return [storeContainer.data, storeContainer.setter];
  }),
}));

import {
  clearInputDraft,
  getInputDraft,
  getProjectName,
  sessionStore,
  setInputDraft,
  setSessionStore,
  updateSessionInfo,
} from "../../../../src/stores/session";

describe("session store", () => {
  beforeEach(() => {
    setSessionStore({
      list: [],
      current: null,
      loading: false,
      initError: null,
      projects: [],
      projectExpanded: {},
      sendingMap: {},
      showDefaultWorkspace: true,
      worktrees: {},
      worktreeExpanded: {},
      inputDrafts: {},
    });
  });

  describe("getProjectName", () => {
    it.each([
      [{ name: "MyProject", directory: "/any/path" }, "MyProject"],
      [{ name: "", directory: "/home/user/project" }, "project"],
      [{ name: "", directory: "C:\\Users\\dev\\myapp" }, "myapp"],
      [{ name: "", directory: "/home/user/project/" }, "project"],
      [{ name: "", directory: "/" }, "Unknown"],
      [{ name: "", directory: "" }, "Unknown"],
      [{ name: "", directory: "/mixed\\separators/path" }, "path"],
    ] as [any, string][])('getProjectName(%j) returns "%s"', (project, expected) => {
      expect(getProjectName(project)).toBe(expected);
    });
  });

  describe("draft helpers", () => {
    it("returns an empty draft when a session has never been edited", () => {
      expect(getInputDraft("session-1")).toEqual({ text: "", images: [] });
    });

    it("merges partial draft updates per session", () => {
      setInputDraft("session-1", { text: "hello" });
      setInputDraft("session-1", {
        images: [{ id: "img-1", name: "cat.png", mimeType: "image/png", data: "abc", size: 3 }],
      });

      expect(getInputDraft("session-1")).toEqual({
        text: "hello",
        images: [{ id: "img-1", name: "cat.png", mimeType: "image/png", data: "abc", size: 3 }],
      });
      expect(getInputDraft("session-2")).toEqual({ text: "", images: [] });
    });

    it("clears only the targeted session draft", () => {
      setInputDraft("session-1", { text: "hello" });
      setInputDraft("session-2", { text: "world" });

      clearInputDraft("session-1");

      expect(getInputDraft("session-1")).toEqual({ text: "", images: [] });
      expect(getInputDraft("session-2")).toEqual({ text: "world", images: [] });
    });
  });

  describe("session info updates", () => {
    it("updates only the matching session info entry", () => {
      setSessionStore("list", [
        {
          id: "session-1",
          engineType: "copilot",
          title: "First",
          directory: "/repo-1",
          mode: "chat",
          createdAt: "1",
          updatedAt: "1",
        },
        {
          id: "session-2",
          engineType: "claude",
          title: "Second",
          directory: "/repo-2",
          mode: "plan",
          createdAt: "2",
          updatedAt: "2",
        },
      ]);

      updateSessionInfo("session-1", {
        mode: "agent",
        modelId: "gpt-5.4",
        reasoningEffort: "high",
        serviceTier: "fast",
      });

      expect(sessionStore.list[0]).toMatchObject({
        id: "session-1",
        mode: "agent",
        modelId: "gpt-5.4",
        reasoningEffort: "high",
        serviceTier: "fast",
      });
      expect(sessionStore.list[1]).toMatchObject({
        id: "session-2",
        mode: "plan",
      });
    });
  });
});
