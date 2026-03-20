import { describe, it, expect, beforeEach, vi } from "vitest";
import { EngineManager } from "../../../../electron/main/gateway/engine-manager";
import { conversationStore } from "../../../../electron/main/services/conversation-store";
import { EngineAdapter } from "../../../../electron/main/engines/engine-adapter";
import type { EngineType } from "../../../../src/types/unified";

// --- Mocks ---

vi.mock("../../../../electron/main/services/conversation-store", () => {
  const store = {
    get: vi.fn(),
    list: vi.fn(() => []),
    create: vi.fn(),
    delete: vi.fn(),
    rename: vi.fn(),
    update: vi.fn(),
    listMessages: vi.fn(() => []),
    appendMessage: vi.fn(),
    updateMessage: vi.fn(),
    getSteps: vi.fn(() => []),
    getAllSteps: vi.fn(() => null),
    saveSteps: vi.fn(),
    setEngineSession: vi.fn(),
    clearEngineSession: vi.fn(),
    findByEngineSession: vi.fn(() => null),
    deriveProjects: vi.fn(() => []),
    flushAll: vi.fn(),
  };
  return { conversationStore: store };
});

vi.mock("../../../../electron/main/services/logger", () => ({
  engineManagerLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  getDefaultEngineFromSettings: vi.fn(() => "opencode"),
}));

vi.mock("../../../../electron/main/services/default-workspace", () => ({
  getDefaultWorkspacePath: vi.fn(() => "/mock/userData/workspace"),
}));

vi.mock("../../../../electron/main/utils/id-gen", () => ({
  timeId: vi.fn((prefix: string) => `${prefix}_test123`),
}));

class MockEngineAdapter extends EngineAdapter {
  readonly engineType: EngineType;
  constructor(type: EngineType) {
    super();
    this.engineType = type;
  }
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  healthCheck = vi.fn(async () => true);
  getStatus = vi.fn(() => "running" as any);
  getInfo = vi.fn(() => ({ type: this.engineType, status: "running", version: "1.0" }) as any);
  getCapabilities = vi.fn(() => ({}) as any);
  getAuthMethods = vi.fn(() => []);
  hasSession = vi.fn(() => true);
  listSessions = vi.fn(async () => []);
  createSession = vi.fn(async (dir: string) => ({
    id: "engine-session-1",
    engineType: this.engineType,
    directory: dir,
    title: "Test",
    time: { created: Date.now(), updated: Date.now() },
  }) as any);
  getSession = vi.fn(async () => null);
  deleteSession = vi.fn(async () => {});
  sendMessage = vi.fn(async () => ({
    id: "msg-1",
    sessionId: "engine-session-1",
    role: "assistant",
    time: { created: Date.now() },
    parts: [],
  }) as any);
  cancelMessage = vi.fn(async () => {});
  listMessages = vi.fn(async () => []);
  listModels = vi.fn(async () => ({ models: [] }) as any);
  setModel = vi.fn(async () => {});
  getModes = vi.fn(() => []);
  setMode = vi.fn(async () => {});
  replyPermission = vi.fn(async () => {});
  replyQuestion = vi.fn(async () => {});
  rejectQuestion = vi.fn(async () => {});
  listProjects = vi.fn(async () => []);
}

describe("EngineManager", () => {
  let engineManager: EngineManager;
  let adapterA: MockEngineAdapter;
  let adapterB: MockEngineAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    engineManager = new EngineManager();
    adapterA = new MockEngineAdapter("opencode" as any);
    adapterB = new MockEngineAdapter("claude-code" as any);
  });

  describe("registerAdapter", () => {
    it("manages adapter registration lifecycle", () => {
      // registers an adapter
      engineManager.registerAdapter(adapterA);
      expect(engineManager.getAdapter(adapterA.engineType)).toBe(adapterA);

      // throws for duplicate engine type
      expect(() => engineManager.registerAdapter(adapterA)).toThrow(/already registered/);

      // returns undefined for unregistered adapter
      expect(engineManager.getAdapter("unknown" as any)).toBeUndefined();
    });
  });

  describe("Project-Engine Bindings", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("manages project engine bindings with path normalization and error handling", () => {
      // stores and retrieves binding with normalized path
      engineManager.setProjectEngine("C:\\path\\to\\project", adapterA.engineType);
      expect(engineManager.getProjectEngine("C:/path/to/project")).toBe(adapterA.engineType);
      expect(engineManager.getProjectEngine("C:\\path\\to\\project")).toBe(adapterA.engineType);

      // throws when setting binding for unregistered engine
      expect(() => engineManager.setProjectEngine("/path", "unknown" as any)).toThrow(/No adapter registered/);
    });

    it("retrieves and loads multiple project bindings", () => {
      // returns all project bindings
      engineManager.setProjectEngine("/path/1", adapterA.engineType);
      const bindings = engineManager.getProjectBindings();
      expect(bindings.get("/path/1")).toBe(adapterA.engineType);

      // loads multiple bindings at once
      engineManager.loadProjectBindings({ "/path/2": adapterA.engineType });
      expect(engineManager.getProjectEngine("/path/2")).toBe(adapterA.engineType);
    });
  });

  describe("Lifecycle", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
      engineManager.registerAdapter(adapterB);
    });

    it("starts and stops all registered adapters", async () => {
      await engineManager.startAll();
      expect(adapterA.start).toHaveBeenCalled();
      expect(adapterB.start).toHaveBeenCalled();

      await engineManager.stopAll();
      expect(adapterA.stop).toHaveBeenCalled();
      expect(adapterB.stop).toHaveBeenCalled();
    });

    it("manages lifecycle for specific engines", async () => {
      await engineManager.startEngine(adapterA.engineType);
      expect(adapterA.start).toHaveBeenCalled();

      await engineManager.stopEngine(adapterA.engineType);
      expect(adapterA.stop).toHaveBeenCalled();
    });

    it("continues starting other adapters if one fails", async () => {
      adapterA.start.mockRejectedValue(new Error("Fail"));
      await expect(engineManager.startAll()).resolves.not.toThrow();
      expect(adapterB.start).toHaveBeenCalled();
    });
  });

  describe("Engine Info", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("retrieves info for all or specific engines", () => {
      const allInfo = engineManager.listEngines();
      expect(allInfo).toHaveLength(1);
      expect(allInfo[0].type).toBe(adapterA.engineType);

      const specificInfo = engineManager.getEngineInfo(adapterA.engineType);
      expect(specificInfo.type).toBe(adapterA.engineType);
    });
  });

  describe("Sessions", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("creates sessions and handles unregistered engines", async () => {
      const mockConv = { id: "conv1", engineType: adapterA.engineType, directory: "/dir", title: "Chat" };
      (conversationStore.create as any).mockReturnValue(mockConv);
      const session = await engineManager.createSession(adapterA.engineType, "/dir");
      expect(conversationStore.create).toHaveBeenCalledWith({ engineType: adapterA.engineType, directory: "/dir" });
      expect(session.id).toBe("conv1");

      await expect(engineManager.createSession("unknown" as any, "/dir")).rejects.toThrow();
    });

    it("retrieves and deletes sessions from store and engine", async () => {
      // gets session from store
      (conversationStore.get as any).mockReturnValue({ id: "conv1", engineType: adapterA.engineType });
      const session = await engineManager.getSession("conv1");
      expect(session?.id).toBe("conv1");

      // deletes session from store and cleans up engine
      const mockConv = { id: "conv1", engineType: adapterA.engineType, engineSessionId: "engine-s1" };
      (conversationStore.get as any).mockReturnValue(mockConv);
      await engineManager.deleteSession("conv1");
      expect(adapterA.deleteSession).toHaveBeenCalledWith("engine-s1");
      expect(conversationStore.delete).toHaveBeenCalledWith("conv1");

      // handles missing conversation gracefully during deleteSession
      (conversationStore.get as any).mockReturnValue(null);
      await expect(engineManager.deleteSession("missing")).resolves.not.toThrow();
    });

    it("lists sessions filtered by engine type or directory", async () => {
      (conversationStore.list as any).mockReturnValue([{ id: "conv1", engineType: adapterA.engineType }]);
      
      const sessionsByType = await engineManager.listSessions(adapterA.engineType);
      expect(sessionsByType).toHaveLength(1);
      expect(conversationStore.list).toHaveBeenCalledWith({ engineType: adapterA.engineType });

      const sessionsByDir = await engineManager.listSessions("/some/dir");
      expect(sessionsByDir).toHaveLength(1);
      expect(conversationStore.list).toHaveBeenCalledWith({ directory: "/some/dir" });
    });

    it("deletes project sessions and renames sessions", async () => {
      // deletes project and its sessions
      const conv1 = { id: "c1", engineType: "opencode", directory: "/dir1", engineSessionId: "es1" };
      (conversationStore.list as any).mockReturnValue([conv1]);
      (conversationStore.listMessages as any).mockReturnValue([{ id: "m1" }]);
      await engineManager.deleteProject("dir-/dir1");
      expect(adapterA.deleteSession).toHaveBeenCalledWith("es1");
      expect(conversationStore.delete).toHaveBeenCalledWith("c1");

      // renames session in store
      await engineManager.renameSession("conv1", "New Title");
      expect(conversationStore.rename).toHaveBeenCalledWith("conv1", "New Title");
    });
  });

  describe("Messages", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.get as any).mockReturnValue({
        id: "conv1",
        engineType: adapterA.engineType,
        directory: "/dir",
        engineSessionId: null
      });
    });

    it("manages engine session lifecycle during message sending", async () => {
      // lazy creates engine session on first send
      adapterA.createSession.mockResolvedValue({ id: "engine-s1", engineMeta: {} } as any);
      await engineManager.sendMessage("conv1", [{ type: "text", text: "hello" }]);
      expect(adapterA.createSession).toHaveBeenCalledWith("/dir", undefined);
      expect(conversationStore.setEngineSession).toHaveBeenCalledWith("conv1", "engine-s1", expect.any(Object));

      // re-uses existing engine session — reset mocks first to verify no new createSession call
      vi.mocked(adapterA.createSession).mockClear();
      (conversationStore.get as any).mockReturnValue({
        id: "conv1",
        engineType: adapterA.engineType,
        directory: "/dir",
        engineSessionId: "existing-s1"
      });
      adapterA.hasSession.mockReturnValue(true);
      await engineManager.sendMessage("conv1", [{ type: "text", text: "hello" }]);
      expect(adapterA.createSession).not.toHaveBeenCalled();
      expect(adapterA.sendMessage).toHaveBeenCalledWith("existing-s1", expect.any(Array), expect.any(Object));
    });

    it("persists user messages and handles stale sessions", async () => {
      // persists user message manually
      await engineManager.sendMessage("conv1", [{ type: "text", text: "hello" }]);
      expect(conversationStore.appendMessage).toHaveBeenCalledWith("conv1", expect.objectContaining({ role: "user" }));

      // clears engine session if stale
      adapterA.sendMessage.mockResolvedValue({ staleSession: true } as any);
      await engineManager.sendMessage("conv1", [{ type: "text", text: "hello" }]);
      expect(conversationStore.clearEngineSession).toHaveBeenCalledWith("conv1");
    });

    it("cancels messages and retrieves message history or steps", async () => {
      // cancels message via adapter
      (conversationStore.get as any).mockReturnValue({
        id: "conv1",
        engineType: adapterA.engineType,
        directory: "/dir",
        engineSessionId: "engine-s1"
      });
      await engineManager.cancelMessage("conv1");
      expect(adapterA.cancelMessage).toHaveBeenCalledWith("engine-s1", "/dir");

      // lists messages from store
      (conversationStore.listMessages as any).mockReturnValue([{ id: "m1", role: "user", parts: [], time: {} }]);
      const messages = await engineManager.listMessages("conv1");
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("m1");

      // gets message steps from store
      await engineManager.getMessageSteps("conv1", "m1");
      expect(conversationStore.getSteps).toHaveBeenCalledWith("conv1", "m1");
    });
  });

  describe("Models and Modes", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.get as any).mockReturnValue({ id: "conv1", engineType: adapterA.engineType, engineSessionId: "s1" });
    });

    it("delegates model and mode operations to the adapter", async () => {
      await engineManager.listModels(adapterA.engineType);
      expect(adapterA.listModels).toHaveBeenCalled();

      await engineManager.setModel("conv1", "gpt-4");
      expect(adapterA.setModel).toHaveBeenCalledWith("s1", "gpt-4");

      engineManager.getModes(adapterA.engineType);
      expect(adapterA.getModes).toHaveBeenCalled();

      await engineManager.setMode("conv1", "fast");
      expect(adapterA.setMode).toHaveBeenCalledWith("s1", "fast");
    });
  });

  describe("Permissions and Questions", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("manages permission replies and handles missing engine bindings", async () => {
      adapterA.emit("permission.asked", {
        permission: {
          id: "perm1",
          sessionId: "engine-s1",
          engineType: adapterA.engineType,
          title: "test",
          kind: "file_read",
          options: {}
        } as any
      });
      await engineManager.replyPermission("perm1", { action: "allow" } as any);
      expect(adapterA.replyPermission).toHaveBeenCalledWith("perm1", { action: "allow" }, "engine-s1");

      await expect(engineManager.replyPermission("unknown", {} as any)).rejects.toThrow(/No engine binding/);
    });

    it("manages question replies and rejections", async () => {
      adapterA.emit("question.asked", {
        question: {
          id: "q1",
          sessionId: "engine-s1",
          engineType: adapterA.engineType,
          questions: []
        } as any
      });
      
      await engineManager.replyQuestion("q1", [["answer"]]);
      expect(adapterA.replyQuestion).toHaveBeenCalledWith("q1", [["answer"]], "engine-s1");

      // Emit a new question event for rejection (q1 was already consumed by replyQuestion)
      adapterA.emit("question.asked", {
        question: {
          id: "q2",
          sessionId: "engine-s1",
          engineType: adapterA.engineType,
          questions: []
        } as any
      });
      await engineManager.rejectQuestion("q2");
      expect(adapterA.rejectQuestion).toHaveBeenCalledWith("q2", "engine-s1");
    });
  });

  describe("Event Forwarding", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv1" });
      (conversationStore.get as any).mockReturnValue({ id: "conv1", title: "New session" });
    });

    it("forwards message part updates for text and reasoning parts", () => {
      const textPart = { id: "p1", type: "text", text: "hi", sessionId: "engine-s1", messageId: "m1" } as any;
      const stepPart = { id: "p2", type: "reasoning", content: "thinking", sessionId: "engine-s1", messageId: "m1" } as any;
      const eventSpy = vi.fn();
      engineManager.on("message.part.updated", eventSpy);

      adapterA.emit("message.part.updated", { sessionId: "engine-s1", messageId: "m1", part: textPart });
      expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "conv1",
        part: expect.objectContaining({ sessionId: "conv1" })
      }));

      adapterA.emit("message.part.updated", { sessionId: "engine-s1", messageId: "m1", part: stepPart });
      expect(eventSpy).toHaveBeenCalled();
    });

    it("persists or updates assistant messages and skips incomplete ones", async () => {
      // persists assistant message on message.updated when completed
      (conversationStore.listMessages as any).mockReturnValue([]);
      const completedMessage = {
        id: "m1",
        sessionId: "engine-s1",
        role: "assistant",
        time: { created: 1, completed: 2 },
        parts: [{ id: "p1", type: "text", text: "done", sessionId: "engine-s1", messageId: "m1" } as any]
      } as any;
      adapterA.emit("message.updated", { sessionId: "engine-s1", message: completedMessage });
      // persistMessage is fire-and-forget async — wait for microtask queue to flush
      await new Promise((r) => setTimeout(r, 0));
      expect(conversationStore.appendMessage).toHaveBeenCalledWith("conv1", expect.objectContaining({ id: "m1" }));

      // updates existing assistant message on message.updated
      (conversationStore.listMessages as any).mockReturnValue([{ id: "m1" }]);
      adapterA.emit("message.updated", { sessionId: "engine-s1", message: completedMessage });
      await new Promise((r) => setTimeout(r, 0));
      expect(conversationStore.updateMessage).toHaveBeenCalledWith("conv1", "m1", expect.objectContaining({ id: "m1" }));

      // skips persisting incomplete assistant message
      const incompleteMessage = {
        id: "m2",
        sessionId: "engine-s1",
        role: "assistant",
        time: { created: 1 },
        parts: []
      } as any;
      adapterA.emit("message.updated", { sessionId: "engine-s1", message: incompleteMessage });
      await new Promise((r) => setTimeout(r, 0));
      expect(conversationStore.appendMessage).not.toHaveBeenCalledWith("conv1", expect.objectContaining({ id: "m2" }));
    });

    it("forwards session updates and tracks permission requests", () => {
      // persists session title update on session.updated
      adapterA.emit("session.updated", {
        session: { id: "engine-s1", title: "Real Title", engineType: adapterA.engineType } as any
      });
      expect(conversationStore.rename).toHaveBeenCalledWith("conv1", "Real Title");

      // tracks permissionId to engine mapping on permission.asked
      adapterA.emit("permission.asked", {
        permission: {
          id: "p1",
          sessionId: "engine-s1",
          engineType: adapterA.engineType,
          title: "test",
          kind: "file_read",
          options: {}
        } as any
      });
      // Verification of internal tracking is implicit via subsequent replyPermission success
    });
  });

  describe("Store Integration", () => {
    it("synchronizes with conversation store state", () => {
      // initFromStore rebuilds maps
      (conversationStore.list as any).mockReturnValue([
        { id: "c1", engineType: "opencode", directory: "/dir1", engineSessionId: "es1" }
      ]);
      engineManager.initFromStore();
      expect(engineManager.getProjectEngine("/dir1")).toBe("opencode");

      // listAllSessions returns all from store
      (conversationStore.list as any).mockReturnValue([{ id: "c1", engineType: "opencode", time: {created: 1} }]);
      const all = engineManager.listAllSessions();
      expect(all).toHaveLength(1);
    });
  });

  describe("listAllProjects — default workspace", () => {
    it("appends default workspace when not already in derived projects", () => {
      (conversationStore.deriveProjects as any).mockReturnValue([
        { id: "p1", directory: "/myproject", name: "myproject" },
      ]);
      const projects = engineManager.listAllProjects();
      expect(projects).toHaveLength(2);

      const defaultProject = projects.find(p => p.isDefault);
      expect(defaultProject).toBeDefined();
      expect(defaultProject!.directory).toBe("/mock/userData/workspace");
      expect(defaultProject!.name).toBe("Default Workspace");
    });

    it("marks existing project as default when directory matches", () => {
      (conversationStore.deriveProjects as any).mockReturnValue([
        { id: "p1", directory: "/mock/userData/workspace", name: "workspace" },
      ]);
      const projects = engineManager.listAllProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].isDefault).toBe(true);
    });

    it("handles backslash normalization for Windows paths", () => {
      (conversationStore.deriveProjects as any).mockReturnValue([
        { id: "p1", directory: "\\mock\\userData\\workspace", name: "workspace" },
      ]);
      const projects = engineManager.listAllProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].isDefault).toBe(true);
    });

    it("returns only default workspace when no other projects exist", () => {
      (conversationStore.deriveProjects as any).mockReturnValue([]);
      const projects = engineManager.listAllProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].isDefault).toBe(true);
    });
  });
});
