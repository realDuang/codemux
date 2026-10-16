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
  toSessionInfo,
  applySessionCatalog,
  replaceListedSessions,
  buildSessionProjectView,
  visibleSessionsForEngines,
  visibleSessionsForProjectPaths,
  projectHasCatalogSessions,
  removeListedSession,
} from "../../../../src/stores/session";
import type { UnifiedSession } from "../../../../src/types/unified";
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
      catalogs: {},
      projectExpanded: {},
      sendingMap: {},
      showDefaultWorkspace: true,
      projectPathFilter: { whitelist: [], blacklist: [] },
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

  describe("visibleSessionsForProjectPaths", () => {
    const session = (id: string, directory: string, projectId = "project") => toSessionInfo({
      id, engineType: "claude", directory, projectId, time: { created: 1, updated: 2 },
    });

    it("filters a subfolder within a project while preserving selection and drafts", () => {
      const sessions = [session("keep", "/repo/public"), session("hide", "/repo/private/sub"), session("neighbor", "/repository")];
      setSessionStore("list", sessions);
      setSessionStore("current", "hide");
      setInputDraft("hide", { text: "Keep this draft" });
      const filter = { whitelist: ["/repo"], blacklist: ["/repo/private"] };
      const visible = visibleSessionsForProjectPaths(sessionStore.list, [{ id: "project", directory: "/repo" }], filter);

      expect(visible.map((item) => item.id)).toEqual(["keep"]);
      expect(visible[0]).toBe(sessionStore.list[0]);
      expect(sessionStore.list).toHaveLength(3);
      expect(sessionStore.current).toBe("hide");
      expect(getInputDraft("hide").text).toBe("Keep this draft");
      expect(visibleSessionsForProjectPaths(sessionStore.list, [], { whitelist: [], blacklist: [] })).toHaveLength(3);
    });

    it("uses project roots only when a session has no working directory", () => {
      const sessions = [session("unknown-cwd", ""), session("known-cwd", "/outside"), session("unassigned", "", "missing")];
      const projects = [{ id: "project", directory: "/root-a", roots: ["/root-a", "/root-b"] }];
      expect(visibleSessionsForProjectPaths(sessions, projects, { whitelist: ["/root-b"], blacklist: [] }).map((item) => item.id)).toEqual(["unknown-cwd"]);
      expect(visibleSessionsForProjectPaths(sessions, projects, { whitelist: [], blacklist: ["/root-a", "/root-b"] }).map((item) => item.id)).toEqual(["known-cwd", "unassigned"]);
    });

    it("respects display project membership and filters archived sessions without changing them", () => {
      const archived = { ...session("archived", "", "native"), archived: true };
      const projects = [{ id: "view", directory: "/hidden" }];
      const projectIds = new Map([["archived", "view"]]);
      expect(visibleSessionsForProjectPaths([archived], projects, { whitelist: [], blacklist: ["/hidden"] }, projectIds)).toEqual([]);
      expect(archived).toMatchObject({ archived: true, projectID: "native", directory: "" });
    });
  });

  describe("projectHasCatalogSessions", () => {
    it("retains catalog ownership when a hidden session inherits a project by directory", () => {
      const sessions = [
        toSessionInfo({ id: "local", engineType: "claude", directory: "/repo", projectId: "project", time: { created: 1, updated: 2 } }),
        toSessionInfo({ id: "native", engineType: "codex", catalogSourceId: "catalog", directory: "/repo/private", projectId: null, time: { created: 1, updated: 2 } }),
      ];
      const view = buildSessionProjectView(sessions, [{ id: "project", directory: "/repo" }]);
      const visible = visibleSessionsForProjectPaths(sessions, view.projects, { whitelist: [], blacklist: ["/repo/private"] }, view.projectIds);

      expect(visible.map((session) => session.id)).toEqual(["local"]);
      expect(sessions[1].projectID).toBeNull();
      expect(view.projectIds.get("native")).toBe("project");
      expect(projectHasCatalogSessions("project", sessions, view.projectIds)).toBe(true);
    });

    it("protects explicit catalog membership even when an archived session is absent from the display map", () => {
      const session = toSessionInfo({ id: "native", engineType: "codex", catalogSourceId: "catalog", directory: "/repo", projectId: "project", archived: true, time: { created: 1, updated: 2 } });
      expect(projectHasCatalogSessions("project", [session], new Map())).toBe(true);
    });

    it("allows local project actions when catalog sessions belong to another project", () => {
      const sessions = [
        toSessionInfo({ id: "local", engineType: "claude", directory: "/repo", projectId: "project", time: { created: 1, updated: 2 } }),
        toSessionInfo({ id: "native", engineType: "codex", catalogSourceId: "catalog", directory: "/other", projectId: "other", time: { created: 1, updated: 2 } }),
      ];
      expect(projectHasCatalogSessions("project", sessions)).toBe(false);
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

  describe("toSessionInfo", () => {
    it("keeps creation origin separate from the current executor and leaves missing provenance unknown", () => {
      const session: UnifiedSession = {
        id: "shared", engineType: "codex", title: "Shared chat", directory: "/repo",
        sourceName: "Companion", sourceUrl: "app://threads/shared", time: { created: 1, updated: 2 },
        connection: { origin: "CodeMux", executor: "Companion", shared: true, available: true, runtimeVersion: "1.2.3" },
      };
      expect(toSessionInfo(session).connection).toEqual(session.connection);
      expect(toSessionInfo({ ...session, connection: { executor: "Companion", shared: true, available: true } }).connection?.origin).toBeUndefined();
      expect(toSessionInfo({ ...session, engineType: "claude", connection: undefined }).connection).toBeUndefined();
    });
  });

  describe("applySessionCatalog", () => {
    it("updates connection availability without replacing identity, selection, or drafts", () => {
      const session: UnifiedSession = {
        id: "shared", engineType: "codex", title: "Shared chat", directory: "/repo",
        catalogSourceId: "native", catalogAvailable: true, time: { created: 1, updated: 2 },
        connection: { origin: "Companion", executor: "Companion", shared: true, available: true },
      };
      const snapshot = { sourceId: "native", complete: true, projects: [], sessions: [session] };
      applySessionCatalog({ ...snapshot, revision: "1" });
      setSessionStore("current", session.id);
      setInputDraft(session.id, { text: "Continue when connected" });
      applySessionCatalog({ ...snapshot, revision: "2", sessions: [{ ...session, connection: { ...session.connection!, shared: false, available: false } }] });
      expect(sessionStore.list).toHaveLength(1);
      expect(sessionStore.list[0].connection).toEqual({ origin: "Companion", executor: "Companion", shared: false, available: false });
      expect(sessionStore.current).toBe(session.id);
      expect(getInputDraft(session.id).text).toBe("Continue when connected");
    });
  });

  describe("session info updates", () => {
    it("removes a session from list and catalog caches without disturbing another selection", () => {
      const session = (id: string): UnifiedSession => ({ id, engineType: "codex-desktop", catalogSourceId: "native", projectId: null, directory: "/repo", time: { created: 1, updated: 2 } });
      applySessionCatalog({ sourceId: "native", revision: "1", complete: true, projects: [], sessions: [session("removed"), session("kept")] });
      setSessionStore("current", "kept");
      setInputDraft("kept", { text: "Keep this draft" });
      removeListedSession("removed");
      removeListedSession("removed");
      expect(sessionStore.list.map((item) => item.id)).toEqual(["kept"]);
      expect(sessionStore.catalogs.native.sessions.map((item) => item.id)).toEqual(["kept"]);
      expect(sessionStore.current).toBe("kept");
      expect(getInputDraft("kept").text).toBe("Keep this draft");
      removeListedSession("kept");
      expect(sessionStore.current).toBeNull();
      expect(sessionStore.list).toEqual([]);
    });

    it("hides archived conversations only for engines that request it", () => {
      const make = (id: string, engineType: UnifiedSession["engineType"], archived: boolean) => toSessionInfo({ id, engineType, archived, directory: "/repo", time: { created: 1, updated: 2 } });
      const sessions = [make("hidden", "codex-desktop", true), make("active", "codex-desktop", false), make("other-archived", "claude", true)];
      expect(visibleSessionsForEngines(sessions, new Set(["codex-desktop"])).map((session) => session.id)).toEqual(["active", "other-archived"]);
      expect(sessions).toHaveLength(3);
      expect(visibleSessionsForEngines(sessions, new Set()).map((session) => session.id)).toEqual(["hidden", "active", "other-archived"]);
    });

    it("displays unassigned catalog sessions in the existing default workspace without changing membership", () => {
      const directory = "/Users/test/Library/Application Support/codemux/workspace";
      const projects = [{ id: "default-project", directory, isDefault: true }];
      const sessions = Array.from({ length: 5 }, (_, index) => toSessionInfo({
        id: `new-${index}`, engineType: "codex-desktop", directory, projectId: null,
        catalogSourceId: "native", time: { created: 1, updated: 2 },
      }));
      const before = structuredClone(sessions);
      const view = buildSessionProjectView(sessions, projects);
      expect([...view.projectIds.values()]).toEqual(Array(5).fill("default-project"));
      expect(view.projects).toHaveLength(1);
      expect(view.displayOnlyIds.size).toBe(0);
      expect(sessions).toEqual(before);
    });

    it("uses canonical project metadata before cwd matches and leaves ordinary engine grouping unchanged", () => {
      const native = { id: "native-project", directory: "", name: "Canonical name", roots: ["/root-a", "/root-b"], catalogSourceId: "native" };
      const projects = [{ id: "existing-directory", directory: "/root-b" }];
      const catalogSession = toSessionInfo({ id: "catalog", engineType: "codex-desktop", directory: "/root-b/subdir", projectId: native.id, catalogSourceId: "native", time: { created: 1, updated: 2 } });
      const ordinary = toSessionInfo({ id: "ordinary", engineType: "claude", directory: "/root-b", time: { created: 1, updated: 2 } }, "existing-directory");
      const view = buildSessionProjectView([catalogSession, ordinary], projects, [{ sourceId: "native", revision: "1", complete: true, projects: [native], sessions: [] }]);
      expect(view.projectIds.get("catalog")).toBe("native-project");
      expect(view.projectIds.get("ordinary")).toBe("existing-directory");
      expect(view.projects.find((project) => project.id === "native-project")).toMatchObject({ name: "Canonical name", directory: "/root-a", roots: ["/root-a", "/root-b"] });
      expect(native.directory).toBe("");
      expect(catalogSession.directory).toBe("/root-b/subdir");
      expect(catalogSession.projectID).toBe("native-project");
    });

    it("matches the most specific known root and creates only display groups for unknown directories", () => {
      const session = (id: string, directory: string) => toSessionInfo({ id, engineType: "codex-desktop", directory, projectId: null, catalogSourceId: "native", time: { created: 1, updated: 2 } });
      const sessions = [session("known", "/repo/nested/src"), session("unknown", "/different/repo"), session("same-dir", "/different/repo")];
      const projects = [{ id: "outer", directory: "/repo" }, { id: "inner", directory: "/repo/nested" }];
      const view = buildSessionProjectView(sessions, projects);
      expect(view.projectIds.get("known")).toBe("inner");
      const displayId = view.projectIds.get("unknown")!;
      expect(view.displayOnlyIds.has(displayId)).toBe(true);
      expect(view.projectIds.get("same-dir")).toBe(displayId);
      expect(view.projects.find((project) => project.id === displayId)?.directory).toBe("/different/repo");
      expect(projects).toHaveLength(2);
      expect(sessions.every((item) => item.projectID === null && item.catalogSourceId === "native")).toBe(true);
    });

    it("keeps explicit catalog classification independent of directory fallback", () => {
      const session: UnifiedSession = { id: "native-session", engineType: "codex-desktop", directory: "/different/root", time: { created: 1, updated: 2 } };
      expect(toSessionInfo({ ...session, catalogSourceId: "native", projectId: null }, "dir-fallback").projectID).toBeNull();
      expect(toSessionInfo({ ...session, catalogSourceId: "native", projectId: "native-project" }, "dir-fallback").projectID).toBe("native-project");
      expect(toSessionInfo({ ...session, engineType: "claude" }, "dir-fallback").projectID).toBe("dir-fallback");
    });

    it("merges new unassigned catalog conversations without disturbing selection, drafts or other sources", () => {
      const session = (id: string, source?: string): UnifiedSession => ({
        id, engineType: source ? "codex-desktop" : "claude", catalogSourceId: source,
        catalogAvailable: source ? true : undefined, directory: "", projectId: source ? null : undefined,
        title: id, time: { created: 1, updated: 2 },
      });
      setSessionStore("list", [toSessionInfo(session("legacy")), toSessionInfo(session("other", "other-source"))]);
      applySessionCatalog({ sourceId: "native", engineType: "codex-desktop", revision: "1", complete: true, projects: [], sessions: [session("selected", "native")] });
      setSessionStore("current", "selected");
      setInputDraft("selected", { text: "Keep this draft" });
      applySessionCatalog({ sourceId: "native", engineType: "codex-desktop", revision: "2", complete: true, projects: [], sessions: [session("new-chat", "native")] });

      expect(sessionStore.list.find((item) => item.id === "new-chat")).toMatchObject({ projectID: null, directory: "", catalogSourceId: "native" });
      expect(sessionStore.list.find((item) => item.id === "selected")?.catalogAvailable).toBe(false);
      expect(sessionStore.list.find((item) => item.id === "other")?.catalogAvailable).toBe(true);
      expect(sessionStore.list.some((item) => item.id === "legacy")).toBe(true);
      expect(sessionStore.current).toBe("selected");
      expect(getInputDraft("selected").text).toBe("Keep this draft");
      expect(sessionStore.catalogs.native.engineType).toBe("codex-desktop");
    });

    it("retains empty sources and newer catalog events through an ordinary list refresh", () => {
      applySessionCatalog({ sourceId: "empty", engineType: "codex-desktop", revision: "1", complete: true, projects: [], sessions: [] });
      const current: UnifiedSession = { id: "new-chat", engineType: "codex-desktop", catalogSourceId: "native", catalogAvailable: true, title: "Latest title", directory: "/repo", projectId: null, time: { created: 1, updated: 2 } };
      applySessionCatalog({ sourceId: "native", engineType: "codex-desktop", revision: "2", complete: true, projects: [], sessions: [current] });
      replaceListedSessions([toSessionInfo({ ...current, title: "Stale title" }), toSessionInfo({ ...current, id: "legacy", engineType: "claude", catalogSourceId: undefined })]);
      expect(sessionStore.list.find((item) => item.id === "new-chat")?.title).toBe("Latest title");
      expect(sessionStore.catalogs.empty.sessions).toEqual([]);
      expect(sessionStore.list.some((item) => item.id === "legacy")).toBe(true);
    });

    it("preserves archived history, source links and drafts until explicitly restored", () => {
      setSessionStore("list", [{
        id: "shared-session", engineType: "codex-desktop", title: "Shared conversation", directory: "/repo",
        sourceUrl: "codex://threads/native-thread", sourceName: "Codex", archived: true, createdAt: "1", updatedAt: "2",
      }]);
      setInputDraft("shared-session", { text: "Continue after restoring" });

      updateSessionInfo("shared-session", { title: "Updated from Desktop" });
      expect(sessionStore.list[0]).toMatchObject({ archived: true, sourceUrl: "codex://threads/native-thread", title: "Updated from Desktop" });
      updateSessionInfo("shared-session", { archived: false });
      expect(sessionStore.list[0]).toMatchObject({ id: "shared-session", archived: false, sourceName: "Codex" });
      expect(getInputDraft("shared-session").text).toBe("Continue after restoring");
    });

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
