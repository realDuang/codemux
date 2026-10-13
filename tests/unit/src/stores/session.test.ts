import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { storeContainer } = vi.hoisted(() => {
  const storeContainer: { data: any; setter: any } = { data: {}, setter: null };
  return { storeContainer };
});

vi.mock("solid-js/store", () => ({
  reconcile: (value: unknown) => () => value,
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
  clearWebInputDrafts,
  consumeInputDraft,
  initializeWebInputDrafts,
  restoreInputDraftIfUnchanged,
  getInputDraft,
  getProjectName,
  sessionStore,
  setInputDraft,
  setSessionStore,
  updateSessionInfo,
} from "../../../../src/stores/session";
import {
  INPUT_DRAFT_STORAGE_KEY,
  MAX_STORED_INPUT_DRAFT_CHARS,
  MAX_STORED_INPUT_DRAFTS,
  persistInputDraft,
  readPersistedInputDrafts,
} from "../../../../src/lib/input-draft-storage";

function draftStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}

describe("session store", () => {
  beforeEach(() => {
    clearWebInputDrafts();
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
      inputDraftSaveFailures: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  describe("consumeInputDraft", () => {
    it("clears a submitted draft and snapshots text and attachments for recovery", () => {
      const image = { id: "image-1", name: "image.png", mimeType: "image/png", data: "abc", size: 3 };
      setInputDraft("session-1", { text: "hello", images: [image] });
      const submission = consumeInputDraft("session-1");

      expect(getInputDraft("session-1")).toEqual({ text: "", images: [] });
      image.name = "changed.png";
      expect(submission.snapshot.text).toBe("hello");
      expect(submission.snapshot.images[0].name).toBe("image.png");
    });
  });

  describe("restoreInputDraftIfUnchanged", () => {
    it("restores a failed send without touching another session", () => {
      setInputDraft("session-1", { text: "retry this" });
      setInputDraft("session-2", { text: "keep this" });
      const submission = consumeInputDraft("session-1");

      expect(restoreInputDraftIfUnchanged("session-1", submission)).toBe(true);
      expect(getInputDraft("session-1").text).toBe("retry this");
      expect(getInputDraft("session-2").text).toBe("keep this");
    });

    it("preserves newer edits and rejects a late failure from an older submission", () => {
      setInputDraft("session-1", { text: "first" });
      const first = consumeInputDraft("session-1");
      setInputDraft("session-1", { text: "second" });
      expect(restoreInputDraftIfUnchanged("session-1", first)).toBe(false);
      const second = consumeInputDraft("session-1");
      expect(restoreInputDraftIfUnchanged("session-1", first)).toBe(false);
      expect(restoreInputDraftIfUnchanged("session-1", second)).toBe(true);
      expect(getInputDraft("session-1").text).toBe("second");
    });

    it("rejects recovery from a previous authenticated device", () => {
      initializeWebInputDrafts("device-1");
      setInputDraft("session-1", { text: "old private text" });
      const submission = consumeInputDraft("session-1");
      initializeWebInputDrafts("device-2");

      expect(restoreInputDraftIfUnchanged("session-1", submission)).toBe(false);
      expect(getInputDraft("session-1")).toEqual({ text: "", images: [] });
    });
  });

  describe("initializeWebInputDrafts", () => {
    it("loads saved Web text and clears all drafts when the approved device changes", () => {
      const entries = new Map<string, string>();
      const storage = {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => entries.set(key, value),
        removeItem: (key: string) => entries.delete(key),
      };
      vi.stubGlobal("window", { localStorage: storage });
      initializeWebInputDrafts("device-1");
      setInputDraft("session-1", {
        text: "survives refresh",
        images: [{ id: "image-1", name: "image.png", mimeType: "image/png", data: "abc", size: 3 }],
      });
      // Switching through an unauthenticated in-memory scope simulates a fresh page load.
      initializeWebInputDrafts(null);
      initializeWebInputDrafts("device-1");

      expect(getInputDraft("session-1")).toEqual({ text: "survives refresh", images: [] });
      initializeWebInputDrafts("device-2");
      expect(getInputDraft("session-1")).toEqual({ text: "", images: [] });
      expect(entries.size).toBe(0);
    });

    it("keeps unsaved text editable after storage failure", () => {
      vi.stubGlobal("window", { localStorage: {
        getItem: () => null,
        setItem: () => { throw new Error("QuotaExceededError"); },
        removeItem: () => {},
      } });
      initializeWebInputDrafts("device-1");
      setInputDraft("session-1", { text: "keep in memory" });

      expect(getInputDraft("session-1").text).toBe("keep in memory");
      expect(sessionStore.inputDraftSaveFailures["session-1"]).toBe(true);
    });

    it.each([
      ["count", MAX_STORED_INPUT_DRAFTS + 1, "small draft"],
      ["size", 2, "x".repeat(300_000)],
    ] as const)("marks drafts evicted by the %s limit as unsaved", (_limit, count, text) => {
      const storage = draftStorage();
      vi.stubGlobal("window", { localStorage: storage });
      initializeWebInputDrafts("device-1");
      for (let index = 0; index < count; index++) {
        setInputDraft(`session-${index}`, { text });
      }

      expect(getInputDraft("session-0").text).toBe(text);
      expect(sessionStore.inputDraftSaveFailures["session-0"]).toBe(true);
      expect(sessionStore.inputDraftSaveFailures[`session-${count - 1}`]).toBe(false);
      expect(readPersistedInputDrafts(storage, "device-1")["session-0"]).toBeUndefined();
    });

    it("warns when restored text could not be retained in storage", () => {
      const storage = draftStorage();
      persistInputDraft(storage, "device-1", "session-1", "recovered text");
      storage.setItem = () => { throw new Error("QuotaExceededError"); };
      vi.stubGlobal("window", { localStorage: storage });
      initializeWebInputDrafts("device-1");

      expect(getInputDraft("session-1").text).toBe("recovered text");
      expect(sessionStore.inputDraftSaveFailures["session-1"]).toBe(true);
      expect(storage.getItem(INPUT_DRAFT_STORAGE_KEY)).toBeNull();
    });

    it("keeps other saved drafts valid when one draft exceeds the size limit", () => {
      const storage = draftStorage();
      vi.stubGlobal("window", { localStorage: storage });
      initializeWebInputDrafts("device-1");
      setInputDraft("saved", { text: "keep this" });
      setInputDraft("oversized", { text: "x".repeat(MAX_STORED_INPUT_DRAFT_CHARS) });

      expect(sessionStore.inputDraftSaveFailures.saved).toBe(false);
      expect(sessionStore.inputDraftSaveFailures.oversized).toBe(true);
      clearInputDraft("oversized");
      expect(sessionStore.inputDraftSaveFailures.saved).toBe(false);
      expect(sessionStore.inputDraftSaveFailures.oversized).toBe(false);
      expect(readPersistedInputDrafts(storage, "device-1")).toEqual({ saved: "keep this" });
    });

    it("leaves Electron drafts in memory and never touches its storage", () => {
      const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
      vi.stubGlobal("window", { localStorage: storage, electronAPI: {} });
      setInputDraft("session-1", { text: "desktop draft" });
      initializeWebInputDrafts("device-1");
      clearWebInputDrafts();

      expect(getInputDraft("session-1").text).toBe("desktop draft");
      expect(storage.getItem).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
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
