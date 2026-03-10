import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";
import { EngineManager } from "../../electron/main/gateway/engine-manager";
import { conversationStore } from "../../electron/main/services/conversation-store";
import { EngineAdapter } from "../../electron/main/engines/engine-adapter";
import { timeId } from "../../electron/main/utils/id-gen";
import type { EngineType, UnifiedPart, TextPart } from "../../src/types/unified";

// --- Mocks ---

vi.mock("../../electron/main/services/conversation-store", () => {
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

vi.mock("../../electron/main/services/logger", () => ({
  engineManagerLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../electron/main/utils/id-gen", () => ({
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

  describe("Adapter Registration", () => {
    it("registers an adapter", () => {
      engineManager.registerAdapter(adapterA);
      expect(engineManager.getAdapter(adapterA.engineType)).toBe(adapterA);
    });

    it("throws for duplicate engine type", () => {
      engineManager.registerAdapter(adapterA);
      expect(() => engineManager.registerAdapter(adapterA)).toThrow(/already registered/);
    });

    it("returns undefined for unregistered adapter", () => {
      expect(engineManager.getAdapter("unknown" as any)).toBeUndefined();
    });
  });

  describe("Project-Engine Bindings", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("stores and retrieves binding with normalized path", () => {
      engineManager.setProjectEngine("C:\\path\\to\\project", adapterA.engineType);
      expect(engineManager.getProjectEngine("C:/path/to/project")).toBe(adapterA.engineType);
      expect(engineManager.getProjectEngine("C:\\path\\to\\project")).toBe(adapterA.engineType);
    });

    it("throws when setting binding for unregistered engine", () => {
      expect(() => engineManager.setProjectEngine("/path", "unknown" as any)).toThrow(/No adapter registered/);
    });

    it("returns all project bindings", () => {
      engineManager.setProjectEngine("/path/1", adapterA.engineType);
      const bindings = engineManager.getProjectBindings();
      expect(bindings.get("/path/1")).toBe(adapterA.engineType);
    });

    it("loads multiple bindings at once", () => {
      engineManager.loadProjectBindings({ "/path/2": adapterA.engineType });
      expect(engineManager.getProjectEngine("/path/2")).toBe(adapterA.engineType);
    });
  });

  describe("Lifecycle", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
      engineManager.registerAdapter(adapterB);
    });

    it("starts all adapters", async () => {
      await engineManager.startAll();
      expect(adapterA.start).toHaveBeenCalled();
      expect(adapterB.start).toHaveBeenCalled();
    });

    it("stops all adapters", async () => {
      await engineManager.stopAll();
      expect(adapterA.stop).toHaveBeenCalled();
      expect(adapterB.stop).toHaveBeenCalled();
    });

    it("starts a specific engine", async () => {
      await engineManager.startEngine(adapterA.engineType);
      expect(adapterA.start).toHaveBeenCalled();
    });

    it("stops a specific engine", async () => {
      await engineManager.stopEngine(adapterA.engineType);
      expect(adapterA.stop).toHaveBeenCalled();
    });

    it("startAll() doesn't throw if one adapter fails", async () => {
      adapterA.start.mockRejectedValue(new Error("Fail"));
      await expect(engineManager.startAll()).resolves.not.toThrow();
      expect(adapterB.start).toHaveBeenCalled();
    });
  });

  describe("Engine Info", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("lists info from all adapters", () => {
      const info = engineManager.listEngines();
      expect(info).toHaveLength(1);
      expect(info[0].type).toBe(adapterA.engineType);
    });

    it("returns info for specific engine", () => {
      const info = engineManager.getEngineInfo(adapterA.engineType);
      expect(info.type).toBe(adapterA.engineType);
    });
  });

  describe("Sessions", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("creates a session in store", async () => {
      const mockConv = { id: "conv1", engineType: adapterA.engineType, directory: "/dir", title: "Chat" };
      (conversationStore.create as any).mockReturnValue(mockConv);

      const session = await engineManager.createSession(adapterA.engineType, "/dir");
      expect(conversationStore.create).toHaveBeenCalledWith({ engineType: adapterA.engineType, directory: "/dir" });
      expect(session.id).toBe("conv1");
    });

    it("throws for unregistered engine during createSession", async () => {
      await expect(engineManager.createSession("unknown" as any, "/dir")).rejects.toThrow();
    });

    it("gets session from store", async () => {
      (conversationStore.get as any).mockReturnValue({ id: "conv1", engineType: adapterA.engineType });
      const session = await engineManager.getSession("conv1");
      expect(session?.id).toBe("conv1");
    });

    it("deletes session from store and cleans up engine", async () => {
      const mockConv = { id: "conv1", engineType: adapterA.engineType, engineSessionId: "engine-s1" };
      (conversationStore.get as any).mockReturnValue(mockConv);

      await engineManager.deleteSession("conv1");
      expect(adapterA.deleteSession).toHaveBeenCalledWith("engine-s1");
      expect(conversationStore.delete).toHaveBeenCalledWith("conv1");
    });

    it("handles missing conversation gracefully during deleteSession", async () => {
      (conversationStore.get as any).mockReturnValue(null);
      await expect(engineManager.deleteSession("missing")).resolves.not.toThrow();
    });

    it("lists sessions by engine type", async () => {
      (conversationStore.list as any).mockReturnValue([{ id: "conv1", engineType: adapterA.engineType }]);
      const sessions = await engineManager.listSessions(adapterA.engineType);
      expect(sessions).toHaveLength(1);
      expect(conversationStore.list).toHaveBeenCalledWith({ engineType: adapterA.engineType });
    });

    it("lists sessions by directory", async () => {
      (conversationStore.list as any).mockReturnValue([{ id: "conv1", engineType: adapterA.engineType }]);
      const sessions = await engineManager.listSessions("/some/dir");
      expect(sessions).toHaveLength(1);
      expect(conversationStore.list).toHaveBeenCalledWith({ directory: "/some/dir" });
    });

    it("deletes project and its sessions", async () => {
      const conv1 = { id: "c1", engineType: "opencode", directory: "/dir1", engineSessionId: "es1" };
      (conversationStore.list as any).mockReturnValue([conv1]);
      (conversationStore.listMessages as any).mockReturnValue([{ id: "m1" }]);
      
      await engineManager.deleteProject("opencode-/dir1");
      
      expect(adapterA.deleteSession).toHaveBeenCalledWith("es1");
      expect(conversationStore.delete).toHaveBeenCalledWith("c1");
    });

    it("renames session in store", async () => {
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

    it("lazy creates engine session on first send", async () => {
      adapterA.createSession.mockResolvedValue({ id: "engine-s1", engineMeta: {} } as any);
      await engineManager.sendMessage("conv1", [{ type: "text", text: "hello" }]);
      expect(adapterA.createSession).toHaveBeenCalledWith("/dir", undefined);
      expect(conversationStore.setEngineSession).toHaveBeenCalledWith("conv1", "engine-s1", expect.any(Object));
    });

    it("re-uses existing engine session", async () => {
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

    it("persists user message manually", async () => {
      await engineManager.sendMessage("conv1", [{ type: "text", text: "hello" }]);
      expect(conversationStore.appendMessage).toHaveBeenCalledWith("conv1", expect.objectContaining({ role: "user" }));
    });

    it("clears engine session if stale", async () => {
      adapterA.sendMessage.mockResolvedValue({ staleSession: true } as any);
      await engineManager.sendMessage("conv1", [{ type: "text", text: "hello" }]);
      expect(conversationStore.clearEngineSession).toHaveBeenCalledWith("conv1");
    });

    it("cancels message via adapter", async () => {
      (conversationStore.get as any).mockReturnValue({
        id: "conv1",
        engineType: adapterA.engineType,
        directory: "/dir",
        engineSessionId: "engine-s1"
      });
      await engineManager.cancelMessage("conv1");
      expect(adapterA.cancelMessage).toHaveBeenCalledWith("engine-s1", "/dir");
    });

    it("lists messages from store", async () => {
      (conversationStore.listMessages as any).mockReturnValue([{ id: "m1", role: "user", parts: [], time: {} }]);
      const messages = await engineManager.listMessages("conv1");
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("m1");
    });

    it("gets message steps from store", async () => {
      await engineManager.getMessageSteps("conv1", "m1");
      expect(conversationStore.getSteps).toHaveBeenCalledWith("conv1", "m1");
    });
  });

  describe("Models and Modes", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.get as any).mockReturnValue({ id: "conv1", engineType: adapterA.engineType, engineSessionId: "s1" });
    });

    it("delegates listModels to adapter", async () => {
      await engineManager.listModels(adapterA.engineType);
      expect(adapterA.listModels).toHaveBeenCalled();
    });

    it("delegates setModel to adapter", async () => {
      await engineManager.setModel("conv1", "gpt-4");
      expect(adapterA.setModel).toHaveBeenCalledWith("s1", "gpt-4");
    });

    it("delegates getModes to adapter", () => {
      engineManager.getModes(adapterA.engineType);
      expect(adapterA.getModes).toHaveBeenCalled();
    });

    it("delegates setMode to adapter", async () => {
      await engineManager.setMode("conv1", "fast");
      expect(adapterA.setMode).toHaveBeenCalledWith("s1", "fast");
    });
  });

  describe("Permissions and Questions", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("routes replyPermission to correct engine", async () => {
      // Simulate permission.asked event to populate map
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
    });

    it("throws if no engine binding found for permission", async () => {
      await expect(engineManager.replyPermission("unknown", {} as any)).rejects.toThrow(/No engine binding/);
    });

    it("routes replyQuestion to correct engine", async () => {
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
    });

    it("routes rejectQuestion to correct engine", async () => {
      adapterA.emit("question.asked", {
        question: {
          id: "q1",
          sessionId: "engine-s1",
          engineType: adapterA.engineType,
          questions: []
        } as any
      });
      
      await engineManager.rejectQuestion("q1");
      expect(adapterA.rejectQuestion).toHaveBeenCalledWith("q1", "engine-s1");
    });
  });

  describe("Event Forwarding", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv1" });
      (conversationStore.get as any).mockReturnValue({ id: "conv1", title: "New session" });
    });

    it("buffers text parts on message.part.updated", () => {
      const part = { id: "p1", type: "text", text: "hi", sessionId: "engine-s1", messageId: "m1" } as any;
      const eventSpy = vi.fn();
      engineManager.on("message.part.updated", eventSpy);

      adapterA.emit("message.part.updated", { sessionId: "engine-s1", messageId: "m1", part });
      
      expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "conv1",
        part: expect.objectContaining({ sessionId: "conv1" })
      }));
    });

    it("buffers step parts on message.part.updated", () => {
      const part = { id: "p1", type: "reasoning", content: "thinking", sessionId: "engine-s1", messageId: "m1" } as any;
      const eventSpy = vi.fn();
      engineManager.on("message.part.updated", eventSpy);

      adapterA.emit("message.part.updated", { sessionId: "engine-s1", messageId: "m1", part });
      
      expect(eventSpy).toHaveBeenCalled();
    });

    it("persists assistant message on message.updated when completed", () => {
      (conversationStore.listMessages as any).mockReturnValue([]);
      const message = {
        id: "m1",
        sessionId: "engine-s1",
        role: "assistant",
        time: { created: 1, completed: 2 },
        parts: [{ id: "p1", type: "text", text: "done", sessionId: "engine-s1", messageId: "m1" } as any]
      } as any;
      
      adapterA.emit("message.updated", { sessionId: "engine-s1", message });
      
      expect(conversationStore.appendMessage).toHaveBeenCalledWith("conv1", expect.objectContaining({ id: "m1" }));
    });

    it("updates existing assistant message on message.updated", () => {
      (conversationStore.listMessages as any).mockReturnValue([{ id: "m1" }]);
      const message = {
        id: "m1",
        sessionId: "engine-s1",
        role: "assistant",
        time: { created: 1, completed: 2 },
        parts: [{ id: "p1", type: "text", text: "updated", sessionId: "engine-s1", messageId: "m1" } as any]
      } as any;
      
      adapterA.emit("message.updated", { sessionId: "engine-s1", message });
      
      expect(conversationStore.updateMessage).toHaveBeenCalledWith("conv1", "m1", expect.objectContaining({ id: "m1" }));
    });

    it("skips persisting incomplete assistant message", () => {
      const message = {
        id: "m1",
        sessionId: "engine-s1",
        role: "assistant",
        time: { created: 1 },
        parts: []
      } as any;
      
      adapterA.emit("message.updated", { sessionId: "engine-s1", message });
      expect(conversationStore.appendMessage).not.toHaveBeenCalled();
    });

    it("persists session title update on session.updated", () => {
      adapterA.emit("session.updated", {
        session: { id: "engine-s1", title: "Real Title", engineType: adapterA.engineType } as any
      });
      expect(conversationStore.rename).toHaveBeenCalledWith("conv1", "Real Title");
    });

    it("tracks permissionId to engine mapping on permission.asked", () => {
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
      // Tested via replyPermission calling adapterA
    });
  });

  describe("Store Integration", () => {
    it("initFromStore rebuilds maps", () => {
      (conversationStore.list as any).mockReturnValue([
        { id: "c1", engineType: "opencode", directory: "/dir1", engineSessionId: "es1" }
      ]);
      engineManager.initFromStore();
      
      expect(engineManager.getProjectEngine("/dir1")).toBe("opencode");
    });

    it("listAllSessions returns all from store", () => {
      (conversationStore.list as any).mockReturnValue([{ id: "c1", engineType: "opencode", time: {created: 1} }]);
      const all = engineManager.listAllSessions();
      expect(all).toHaveLength(1);
    });

    it("listAllProjects returns derived projects", () => {
      (conversationStore.deriveProjects as any).mockReturnValue([{ id: "p1" }]);
      const projects = engineManager.listAllProjects();
      expect(projects).toHaveLength(1);
    });
  });
});
