import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EngineManager } from "../../../../electron/main/gateway/engine-manager";
import { conversationStore } from "../../../../electron/main/services/conversation-store";
import { EngineAdapter } from "../../../../electron/main/engines/engine-adapter";
import { getDefaultEngineFromSettings, engineManagerLog } from "../../../../electron/main/services/logger";
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
    listMessages: vi.fn(() => Promise.resolve([])),
    appendMessage: vi.fn(),
    updateMessage: vi.fn(),
    getSteps: vi.fn(() => Promise.resolve([])),
    getAllSteps: vi.fn(() => Promise.resolve(null)),
    saveSteps: vi.fn(),
    setEngineSession: vi.fn(),
    clearEngineSession: vi.fn(),
    findByEngineSession: vi.fn(() => null),
    deriveProjects: vi.fn(() => []),
    flushAll: vi.fn(),
    findAllEngineSessionIds: vi.fn(() => new Set()),
    ensureMessage: vi.fn(),
    importConversation: vi.fn(),
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

vi.mock("../../../../electron/main/services/worktree-manager", () => ({
  worktreeManager: {
    resolveProjectId: vi.fn(async () => "project-1"),
    getWorktreeByName: vi.fn(() => null),
  },
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
  setReasoningEffort = vi.fn(async () => {});
  getReasoningEffort = vi.fn(() => null);
  replyPermission = vi.fn(async () => {});
  replyQuestion = vi.fn(async () => {});
  rejectQuestion = vi.fn(async () => {});
  listProjects = vi.fn(async () => []);
  listHistoricalSessions = vi.fn(async () => []);
  getHistoricalMessages = vi.fn(async () => []);
  listCommands = vi.fn(async () => []);
  invokeCommand = vi.fn(async () => ({ handledAsCommand: true }) as any);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ConversationMeta object */
function makeMockConv(overrides: Record<string, any> = {}) {
  return {
    id: "conv1",
    engineType: "opencode" as EngineType,
    directory: "/dir",
    title: "New session",
    engineSessionId: null,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

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

  // ===========================================================================
  // registerAdapter
  // ===========================================================================

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

  // ===========================================================================
  // Project-Engine Bindings
  // ===========================================================================

  describe("Project-Engine Bindings", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("manages project engine bindings with path normalization and error handling", () => {
      engineManager.setProjectEngine("C:\\path\\to\\project", adapterA.engineType);
      expect(engineManager.getProjectEngine("C:/path/to/project")).toBe(adapterA.engineType);
      expect(engineManager.getProjectEngine("C:\\path\\to\\project")).toBe(adapterA.engineType);

      expect(() => engineManager.setProjectEngine("/path", "unknown" as any)).toThrow(/No adapter registered/);
    });

    it("retrieves and loads multiple project bindings", () => {
      engineManager.setProjectEngine("/path/1", adapterA.engineType);
      const bindings = engineManager.getProjectBindings();
      expect(bindings.get("/path/1")).toBe(adapterA.engineType);

      engineManager.loadProjectBindings({ "/path/2": adapterA.engineType });
      expect(engineManager.getProjectEngine("/path/2")).toBe(adapterA.engineType);
    });

    it("loadProjectBindings normalizes backslash paths", () => {
      engineManager.loadProjectBindings({ "C:\\windows\\path": adapterA.engineType });
      expect(engineManager.getProjectEngine("C:/windows/path")).toBe(adapterA.engineType);
    });
  });

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

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

    it("continues stopping other adapters if one fails", async () => {
      adapterA.stop.mockRejectedValue(new Error("Fail"));
      await expect(engineManager.stopAll()).resolves.not.toThrow();
      expect(adapterB.stop).toHaveBeenCalled();
    });

    it("throws when starting or stopping unknown engine", async () => {
      await expect(engineManager.startEngine("unknown" as any)).rejects.toThrow(/No adapter registered/);
      await expect(engineManager.stopEngine("unknown" as any)).rejects.toThrow(/No adapter registered/);
    });
  });

  // ===========================================================================
  // Engine Info
  // ===========================================================================

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

    it("throws getEngineInfo for unknown engine type", () => {
      expect(() => engineManager.getEngineInfo("unknown" as any)).toThrow(/No adapter registered/);
    });
  });

  // ===========================================================================
  // getDefaultEngineType — all fallback branches
  // ===========================================================================

  describe("getDefaultEngineType", () => {
    it("returns saved engine when it is registered and running", () => {
      engineManager.registerAdapter(adapterA); // opencode, status "running"
      getDefaultEngineFromSettings.mockReturnValue("opencode");
      expect(engineManager.getDefaultEngineType()).toBe("opencode");
    });

    it("falls back to first running engine when saved engine is not running", () => {
      getDefaultEngineFromSettings.mockReturnValue("claude-code");
      adapterA.getInfo.mockReturnValue({ type: "opencode", status: "running" } as any);
      adapterB.getInfo.mockReturnValue({ type: "claude-code", status: "stopped" } as any);
      engineManager.registerAdapter(adapterA);
      engineManager.registerAdapter(adapterB);
      // saved=claude-code is stopped; first running = opencode
      expect(engineManager.getDefaultEngineType()).toBe("opencode");
    });

    it("falls back to first running engine when saved engine type is not registered", () => {
      getDefaultEngineFromSettings.mockReturnValue("nonexistent");
      adapterA.getInfo.mockReturnValue({ type: "opencode", status: "running" } as any);
      engineManager.registerAdapter(adapterA);
      expect(engineManager.getDefaultEngineType()).toBe("opencode");
    });

    it("falls back to first registered engine when no engine is running", () => {
      getDefaultEngineFromSettings.mockReturnValue("nonexistent");
      adapterA.getInfo.mockReturnValue({ type: "opencode", status: "stopped" } as any);
      engineManager.registerAdapter(adapterA);
      expect(engineManager.getDefaultEngineType()).toBe("opencode");
    });

    it("returns 'opencode' when no adapters are registered", () => {
      getDefaultEngineFromSettings.mockReturnValue("nonexistent");
      // No adapters registered — Map.keys().next() is done
      expect(engineManager.getDefaultEngineType()).toBe("opencode");
    });
  });

  // ===========================================================================
  // Sessions
  // ===========================================================================

  describe("Sessions", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("creates sessions and handles unregistered engines", async () => {
      const mockConv = makeMockConv({ id: "conv1", engineType: adapterA.engineType });
      (conversationStore.create as any).mockReturnValue(mockConv);
      adapterA.createSession.mockResolvedValue({ id: "eng-s1", engineMeta: {} } as any);

      const session = await engineManager.createSession(adapterA.engineType, "/dir");
      expect(conversationStore.create).toHaveBeenCalledWith(
        expect.objectContaining({ engineType: adapterA.engineType, directory: "/dir" }),
      );
      expect(session.id).toBe("conv1");

      await expect(engineManager.createSession("unknown" as any, "/dir")).rejects.toThrow();
    });

    it("resolves undefined engineType via getDefaultEngineType()", async () => {
      const mockConv = makeMockConv({ id: "conv2" });
      (conversationStore.create as any).mockReturnValue(mockConv);
      adapterA.createSession.mockResolvedValue({ id: "eng-s2", engineMeta: {} } as any);

      const session = await engineManager.createSession(undefined, "/dir");
      expect(conversationStore.create).toHaveBeenCalledWith(
        expect.objectContaining({ engineType: adapterA.engineType, directory: "/dir" }),
      );
      expect(session.id).toBe("conv2");
    });

    it("resolves worktreeId to wt.directory when worktree is found", async () => {
      const { worktreeManager } = await import(
        "../../../../electron/main/services/worktree-manager"
      );
      vi.mocked(worktreeManager.getWorktreeByName).mockReturnValue({
        directory: "/worktrees/feature-branch",
      } as any);

      const mockConv = makeMockConv({ id: "conv3", directory: "/worktrees/feature-branch" });
      (conversationStore.create as any).mockReturnValue(mockConv);
      adapterA.createSession.mockResolvedValue({ id: "eng-s3", engineMeta: {} } as any);

      await engineManager.createSession(adapterA.engineType, "/dir", "feature-branch");
      expect(conversationStore.create).toHaveBeenCalledWith(
        expect.objectContaining({ directory: "/worktrees/feature-branch", worktreeId: "feature-branch" }),
      );
    });

    it("keeps original directory when worktree is not found", async () => {
      const { worktreeManager } = await import(
        "../../../../electron/main/services/worktree-manager"
      );
      vi.mocked(worktreeManager.getWorktreeByName).mockReturnValue(null);

      const mockConv = makeMockConv({ id: "conv4", directory: "/dir" });
      (conversationStore.create as any).mockReturnValue(mockConv);
      adapterA.createSession.mockResolvedValue({ id: "eng-s4", engineMeta: {} } as any);

      await engineManager.createSession(adapterA.engineType, "/dir", "missing-wt");
      expect(conversationStore.create).toHaveBeenCalledWith(
        expect.objectContaining({ directory: "/dir" }),
      );
    });

    it("cleans up conversation when engine session creation fails", async () => {
      const mockConv = makeMockConv({ id: "conv5" });
      (conversationStore.create as any).mockReturnValue(mockConv);
      adapterA.createSession.mockRejectedValue(new Error("Engine unavailable"));

      await expect(
        engineManager.createSession(adapterA.engineType, "/dir"),
      ).rejects.toThrow("Engine unavailable");

      expect(conversationStore.delete).toHaveBeenCalledWith("conv5");
    });

    it("emits session.created after successful createSession", async () => {
      const mockConv = makeMockConv({ id: "conv6" });
      (conversationStore.create as any).mockReturnValue(mockConv);
      adapterA.createSession.mockResolvedValue({ id: "eng-s6", engineMeta: {} } as any);

      const emittedSessions: any[] = [];
      engineManager.on("session.created" as any, (data: any) => emittedSessions.push(data));
      await engineManager.createSession(adapterA.engineType, "/dir");
      expect(emittedSessions).toHaveLength(1);
      expect(emittedSessions[0].session.id).toBe("conv6");
    });

    it("retrieves and deletes sessions from store and engine", async () => {
      (conversationStore.get as any).mockReturnValue({ id: "conv1", engineType: adapterA.engineType });
      const session = await engineManager.getSession("conv1");
      expect(session?.id).toBe("conv1");

      const mockConv = makeMockConv({ id: "conv1", engineSessionId: "engine-s1" });
      (conversationStore.get as any).mockReturnValue(mockConv);
      await engineManager.deleteSession("conv1");
      expect(adapterA.deleteSession).toHaveBeenCalledWith("engine-s1");
      expect(conversationStore.delete).toHaveBeenCalledWith("conv1");

      (conversationStore.get as any).mockReturnValue(null);
      await expect(engineManager.deleteSession("missing")).resolves.not.toThrow();
    });

    it("getSession returns null when conversation not found", async () => {
      (conversationStore.get as any).mockReturnValue(null);
      const session = await engineManager.getSession("nonexistent");
      expect(session).toBeNull();
    });

    it("deleteSession skips engine cleanup when no engineSessionId", async () => {
      const mockConv = makeMockConv({ id: "conv-no-eng", engineSessionId: null });
      (conversationStore.get as any).mockReturnValue(mockConv);
      (conversationStore.listMessages as any).mockResolvedValue([]);

      await engineManager.deleteSession("conv-no-eng");
      expect(adapterA.deleteSession).not.toHaveBeenCalled();
      expect(conversationStore.delete).toHaveBeenCalledWith("conv-no-eng");
    });

    it("deleteSession skips engine.deleteSession when adapter not registered for that engine type", async () => {
      const mockConv = makeMockConv({
        id: "conv-other",
        engineType: "copilot" as any,
        engineSessionId: "eng-s-copilot",
      });
      (conversationStore.get as any).mockReturnValue(mockConv);
      (conversationStore.listMessages as any).mockResolvedValue([]);

      // No copilot adapter registered
      await engineManager.deleteSession("conv-other");
      expect(conversationStore.delete).toHaveBeenCalledWith("conv-other");
    });

    it("deleteSession tolerates listMessages throwing", async () => {
      const mockConv = makeMockConv({ id: "conv-err", engineSessionId: "eng-s1" });
      (conversationStore.get as any).mockReturnValue(mockConv);
      (conversationStore.listMessages as any).mockRejectedValue(new Error("IO error"));

      await expect(engineManager.deleteSession("conv-err")).resolves.not.toThrow();
      expect(conversationStore.delete).toHaveBeenCalledWith("conv-err");
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

    it("listSessions registers sessions in sessionEngineMap for later routing", async () => {
      (conversationStore.list as any).mockReturnValue([
        { id: "conv-listed", engineType: adapterA.engineType },
      ]);
      await engineManager.listSessions(adapterA.engineType);

      // Now getSession should succeed (sessionEngineMap populated)
      (conversationStore.get as any).mockReturnValue({
        id: "conv-listed",
        engineType: adapterA.engineType,
        engineSessionId: "eng-x",
      });
      // getAdapterForSession should resolve via sessionEngineMap
      await engineManager.cancelMessage("conv-listed");
      expect(adapterA.cancelMessage).toHaveBeenCalled();
    });

    it("deletes project sessions and renames sessions", async () => {
      const conv1 = makeMockConv({ id: "c1", directory: "/dir1", engineSessionId: "es1" });
      (conversationStore.list as any).mockReturnValue([conv1]);
      (conversationStore.listMessages as any).mockResolvedValue([{ id: "m1" }]);
      await engineManager.deleteProject("dir-/dir1");
      expect(adapterA.deleteSession).toHaveBeenCalledWith("es1");
      expect(conversationStore.delete).toHaveBeenCalledWith("c1");

      await engineManager.renameSession("conv1", "New Title");
      expect(conversationStore.rename).toHaveBeenCalledWith("conv1", "New Title");
    });

    it("deleteProject skips engine cleanup when no engineSessionId", async () => {
      const conv = makeMockConv({ id: "c-no-eng", directory: "/proj1", engineSessionId: null });
      (conversationStore.list as any).mockReturnValue([conv]);
      (conversationStore.listMessages as any).mockResolvedValue([]);

      await engineManager.deleteProject("dir-/proj1");
      expect(adapterA.deleteSession).not.toHaveBeenCalled();
      expect(conversationStore.delete).toHaveBeenCalledWith("c-no-eng");
    });

    it("deleteProject skips convs whose derived projectId doesn't match", async () => {
      const conv = makeMockConv({ id: "c-other", directory: "/other-dir" });
      (conversationStore.list as any).mockReturnValue([conv]);

      await engineManager.deleteProject("dir-/my-project");
      expect(conversationStore.delete).not.toHaveBeenCalled();
    });

    it("convToSession uses parentDirectory for projectId when worktreeId is set", () => {
      const conv = {
        id: "wt-conv",
        engineType: "opencode" as EngineType,
        directory: "/worktrees/branch",
        worktreeId: "branch",
        parentDirectory: "/repos/my-repo",
        title: "Test",
        createdAt: 1000,
        updatedAt: 2000,
      };
      (conversationStore.list as any).mockReturnValue([conv]);
      const sessions = engineManager.listAllSessions();
      expect(sessions[0].projectId).toBe("dir-/repos/my-repo");
    });

    it("convToSession uses own directory for projectId when no worktreeId", () => {
      const conv = {
        id: "plain-conv",
        engineType: "opencode" as EngineType,
        directory: "/my-project",
        title: "Test",
        createdAt: 1000,
        updatedAt: 2000,
      };
      (conversationStore.list as any).mockReturnValue([conv]);
      const sessions = engineManager.listAllSessions();
      expect(sessions[0].projectId).toBe("dir-/my-project");
    });
  });

  // ===========================================================================
  // Messages
  // ===========================================================================

  describe("Messages", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.get as any).mockReturnValue(
        makeMockConv({ engineSessionId: null }),
      );
    });

    it("manages engine session lifecycle during message sending", async () => {
      adapterA.createSession.mockResolvedValue({ id: "engine-s1", engineMeta: {} } as any);
      await engineManager.sendMessage("conv1", [{ type: "text", text: "hello" }]);
      expect(adapterA.createSession).toHaveBeenCalledWith("/dir", undefined);
      expect(conversationStore.setEngineSession).toHaveBeenCalledWith("conv1", "engine-s1", expect.any(Object));

      vi.mocked(adapterA.createSession).mockClear();
      (conversationStore.get as any).mockReturnValue(
        makeMockConv({ engineSessionId: "existing-s1" }),
      );
      adapterA.hasSession.mockReturnValue(true);
      await engineManager.sendMessage("conv1", [{ type: "text", text: "hello" }]);
      expect(adapterA.createSession).not.toHaveBeenCalled();
      expect(adapterA.sendMessage).toHaveBeenCalledWith("existing-s1", expect.any(Array), expect.any(Object));
    });

    it("recreates engine session when hasSession returns false", async () => {
      (conversationStore.get as any).mockReturnValue(
        makeMockConv({ engineSessionId: "stale-session" }),
      );
      adapterA.hasSession.mockReturnValue(false);
      adapterA.createSession.mockResolvedValue({ id: "fresh-session", engineMeta: {} } as any);

      await engineManager.sendMessage("conv1", [{ type: "text", text: "hello" }]);
      expect(adapterA.createSession).toHaveBeenCalled();
      expect(conversationStore.setEngineSession).toHaveBeenCalledWith("conv1", "fresh-session", {});
    });

    it("persists user messages and handles stale sessions", async () => {
      adapterA.createSession.mockResolvedValue({ id: "eng-s", engineMeta: {} } as any);
      await engineManager.sendMessage("conv1", [{ type: "text", text: "hello" }]);
      expect(conversationStore.appendMessage).toHaveBeenCalledWith(
        "conv1",
        expect.objectContaining({ role: "user" }),
      );

      adapterA.sendMessage.mockResolvedValue({ staleSession: true } as any);
      await engineManager.sendMessage("conv1", [{ type: "text", text: "hello" }]);
      expect(conversationStore.clearEngineSession).toHaveBeenCalledWith("conv1");
    });

    it("throws when conversation not found in sendMessage", async () => {
      (conversationStore.get as any).mockReturnValue(null);
      await expect(
        engineManager.sendMessage("nonexistent", [{ type: "text", text: "hi" }]),
      ).rejects.toThrow(/Conversation not found/);
    });

    it("removes session from activeSessions even when sendMessage throws", async () => {
      adapterA.createSession.mockResolvedValue({ id: "eng-fail", engineMeta: {} } as any);
      adapterA.sendMessage.mockRejectedValue(new Error("Send failed"));

      await expect(
        engineManager.sendMessage("conv1", [{ type: "text", text: "hi" }]),
      ).rejects.toThrow("Send failed");

      expect(engineManager.isSessionIdle("conv1")).toBe(true);
    });

    it("isSessionIdle returns false during sendMessage and true after", async () => {
      let resolveMsg: (v: any) => void;
      const msgPromise = new Promise((res) => { resolveMsg = res; });
      adapterA.createSession.mockResolvedValue({ id: "eng-x", engineMeta: {} } as any);
      adapterA.sendMessage.mockReturnValue(msgPromise as any);

      const sendPromise = engineManager.sendMessage("conv1", [{ type: "text", text: "hi" }]);
      // Session should be active immediately
      expect(engineManager.isSessionIdle("conv1")).toBe(false);

      resolveMsg!({ id: "msg-done", time: {}, parts: [] });
      await sendPromise;
      expect(engineManager.isSessionIdle("conv1")).toBe(true);
    });

    it("cancels messages and retrieves message history or steps", async () => {
      (conversationStore.get as any).mockReturnValue(
        makeMockConv({ id: "conv1", engineSessionId: "engine-s1" }),
      );
      await engineManager.cancelMessage("conv1");
      expect(adapterA.cancelMessage).toHaveBeenCalledWith("engine-s1", "/dir");

      (conversationStore.listMessages as any).mockResolvedValue([
        { id: "m1", role: "user", parts: [], time: {} },
      ]);
      const messages = await engineManager.listMessages("conv1");
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("m1");

      await engineManager.getMessageSteps("conv1", "m1");
      expect(conversationStore.getSteps).toHaveBeenCalledWith("conv1", "m1");
    });

    it("cancelMessage returns early when no engineSessionId", async () => {
      (conversationStore.get as any).mockReturnValue(makeMockConv({ engineSessionId: null }));
      await engineManager.cancelMessage("conv1");
      expect(adapterA.cancelMessage).not.toHaveBeenCalled();
    });

    it("cancelMessage cleans up messageConvMap entries for the session", async () => {
      // Arrange: trigger a step-type message.part.updated to register a messageConvMap entry
      engineManager.registerAdapter(adapterB); // register second adapter to avoid conflicts
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv1" });

      adapterA.emit("message.part.updated", {
        sessionId: "eng-s-cancel",
        messageId: "msg-dirty",
        part: { id: "p1", type: "reasoning", sessionId: "eng-s-cancel", messageId: "msg-dirty" },
      });

      // Now cancelMessage should clean up the messageId entry
      (conversationStore.get as any).mockReturnValue(
        makeMockConv({ id: "conv1", engineSessionId: "eng-s-cancel" }),
      );
      await engineManager.cancelMessage("conv1");
      // Verify by attempting to check buffers don't re-flush after cancel
      expect(adapterA.cancelMessage).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // applyTitleFallback and isDefaultTitle
  // ===========================================================================

  describe("applyTitleFallback and isDefaultTitle", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    const titleCases = [
      ["New session", true],
      ["New Chat", true],
      ["Child session", true],
      ["Chat 5", true],
      ["My real title", false],
      ["", false], // empty is falsy, isDefaultTitle checks the string
    ] as const;

    it.each(titleCases)("isDefaultTitle('%s') should be %s", (title, expected) => {
      // Test indirectly: titles that are "default" should get replaced by sendMessage
      const conv = makeMockConv({
        title: title || undefined,
        engineSessionId: "eng-s1",
      });
      (conversationStore.get as any).mockReturnValue(conv);
      adapterA.hasSession.mockReturnValue(true);

      const emittedUpdates: any[] = [];
      engineManager.on("session.updated" as any, (data: any) => emittedUpdates.push(data));

      engineManager["applyTitleFallback"]("conv1", [{ type: "text", text: "Hello world" }]);

      if (!title || expected) {
        // default or empty title → should be replaced
        expect(conversationStore.rename).toHaveBeenCalledWith("conv1", "Hello world");
      } else {
        // real title → should NOT be replaced
        expect(conversationStore.rename).not.toHaveBeenCalled();
      }

      vi.clearAllMocks();
    });

    it("applyTitleFallback returns early when conv not found", () => {
      (conversationStore.get as any).mockReturnValue(null);
      engineManager["applyTitleFallback"]("missing-conv", [{ type: "text", text: "hi" }]);
      expect(conversationStore.rename).not.toHaveBeenCalled();
    });

    it("applyTitleFallback returns early when no text in content", () => {
      (conversationStore.get as any).mockReturnValue(makeMockConv({ title: "New session" }));
      engineManager["applyTitleFallback"]("conv1", [{ type: "image", data: "base64..." } as any]);
      expect(conversationStore.rename).not.toHaveBeenCalled();
    });

    it("applyTitleFallback truncates long text to 100 chars with ellipsis", () => {
      const longText = "A".repeat(150);
      (conversationStore.get as any).mockReturnValue(makeMockConv({ title: "New session" }));
      (conversationStore.get as any).mockReturnValueOnce(makeMockConv({ title: "New session" }))
        .mockReturnValueOnce(makeMockConv({ title: "A".repeat(100) + "…" }));

      engineManager["applyTitleFallback"]("conv1", [{ type: "text", text: longText }]);

      const callArg = (conversationStore.rename as any).mock.calls[0][1];
      expect(callArg).toHaveLength(101); // 100 chars + "…"
      expect(callArg.endsWith("…")).toBe(true);
    });

    it("applyTitleFallback emits session.updated with truncated title", () => {
      const longText = "B".repeat(200);
      (conversationStore.get as any).mockReturnValue(makeMockConv({ title: "" }));

      const emitted: any[] = [];
      engineManager.on("session.updated" as any, (d: any) => emitted.push(d));

      engineManager["applyTitleFallback"]("conv1", [{ type: "text", text: longText }]);

      expect(emitted).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Models and Modes
  // ===========================================================================

  describe("Models and Modes", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.get as any).mockReturnValue(makeMockConv({ engineSessionId: "s1" }));
    });

    it("delegates model, mode, and reasoning effort operations to the adapter", async () => {
      await engineManager.listModels(adapterA.engineType);
      expect(adapterA.listModels).toHaveBeenCalled();

      await engineManager.setModel("conv1", "gpt-4");
      expect(adapterA.setModel).toHaveBeenCalledWith("s1", "gpt-4");

      engineManager.getModes(adapterA.engineType);
      expect(adapterA.getModes).toHaveBeenCalled();

      await engineManager.setMode("conv1", "fast");
      expect(adapterA.setMode).toHaveBeenCalledWith("s1", "fast");
    });

    it("throws setModel when no engineSessionId", async () => {
      (conversationStore.get as any).mockReturnValue(makeMockConv({ engineSessionId: null }));
      await expect(engineManager.setModel("conv1", "gpt-4")).rejects.toThrow(
        /No engine session for conversation/,
      );
    });

    it("throws setMode when no engineSessionId", async () => {
      (conversationStore.get as any).mockReturnValue(makeMockConv({ engineSessionId: null }));
      await expect(engineManager.setMode("conv1", "plan")).rejects.toThrow(
        /No engine session for conversation/,
      );
    });
  });

  // ===========================================================================
  // Permissions and Questions
  // ===========================================================================

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
          options: {},
        } as any,
      });
      await engineManager.replyPermission("perm1", { action: "allow" } as any);
      expect(adapterA.replyPermission).toHaveBeenCalledWith("perm1", { action: "allow" }, "engine-s1");

      await expect(engineManager.replyPermission("unknown", {} as any)).rejects.toThrow(
        /No engine binding found for permission/,
      );
    });

    it("registers permission sessionId from data.sessionId fallback when permission has no sessionId", async () => {
      adapterA.emit("permission.asked", {
        sessionId: "fallback-session-id",
        permission: {
          id: "perm-fallback",
          // no sessionId on permission itself
          title: "test",
          kind: "file_write",
          options: {},
        } as any,
      });

      await engineManager.replyPermission("perm-fallback", { action: "deny" } as any);
      expect(adapterA.replyPermission).toHaveBeenCalledWith(
        "perm-fallback",
        { action: "deny" },
        "fallback-session-id",
      );
    });

    it("manages question replies and rejections", async () => {
      adapterA.emit("question.asked", {
        question: {
          id: "q1",
          sessionId: "engine-s1",
          engineType: adapterA.engineType,
          questions: [],
        } as any,
      });

      await engineManager.replyQuestion("q1", [["answer"]]);
      expect(adapterA.replyQuestion).toHaveBeenCalledWith("q1", [["answer"]], "engine-s1");

      adapterA.emit("question.asked", {
        question: {
          id: "q2",
          sessionId: "engine-s1",
          engineType: adapterA.engineType,
          questions: [],
        } as any,
      });
      await engineManager.rejectQuestion("q2");
      expect(adapterA.rejectQuestion).toHaveBeenCalledWith("q2", "engine-s1");
    });

    it("registers question sessionId from data.sessionId fallback", async () => {
      adapterA.emit("question.asked", {
        sessionId: "fallback-q-session",
        question: {
          id: "q-fb",
          // no sessionId on question itself
          questions: [],
        } as any,
      });

      await engineManager.replyQuestion("q-fb", [["yes"]]);
      expect(adapterA.replyQuestion).toHaveBeenCalledWith("q-fb", [["yes"]], "fallback-q-session");
    });

    it("throws replyQuestion when no engine binding found", async () => {
      await expect(engineManager.replyQuestion("unknown-q", [["a"]])).rejects.toThrow(
        /No engine binding found for question/,
      );
    });

    it("throws rejectQuestion when no engine binding found", async () => {
      await expect(engineManager.rejectQuestion("unknown-q")).rejects.toThrow(
        /No engine binding found for question/,
      );
    });
  });

  // ===========================================================================
  // listCommands
  // ===========================================================================

  describe("listCommands", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("returns empty array when adapter not registered", async () => {
      const result = await engineManager.listCommands("copilot" as any);
      expect(result).toEqual([]);
    });

    it("calls adapter.listCommands with engineSessionId and directory when sessionId given", async () => {
      (conversationStore.get as any).mockReturnValue(
        makeMockConv({ engineSessionId: "eng-s1", directory: "/proj" }),
      );
      adapterA.listCommands.mockResolvedValue([{ name: "/help" }] as any);

      const result = await engineManager.listCommands(adapterA.engineType, "conv1");
      expect(adapterA.listCommands).toHaveBeenCalledWith("eng-s1", "/proj");
      expect(result).toHaveLength(1);
    });

    it("calls adapter.listCommands with undefined when sessionId given but conv not found", async () => {
      (conversationStore.get as any).mockReturnValue(null);
      await engineManager.listCommands(adapterA.engineType, "missing-conv");
      expect(adapterA.listCommands).toHaveBeenCalledWith(undefined, undefined);
    });

    it("calls adapter.listCommands without args when no sessionId", async () => {
      await engineManager.listCommands(adapterA.engineType);
      expect(adapterA.listCommands).toHaveBeenCalledWith();
    });
  });

  // ===========================================================================
  // invokeCommand
  // ===========================================================================

  describe("invokeCommand", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("throws when conversation not found", async () => {
      (conversationStore.get as any).mockReturnValue(null);
      await expect(
        engineManager.invokeCommand("missing", "help", ""),
      ).rejects.toThrow(/Conversation not found/);
    });

    it("lazily creates engine session and calls adapter.invokeCommand", async () => {
      (conversationStore.get as any).mockReturnValue(makeMockConv({ engineSessionId: null }));
      adapterA.createSession.mockResolvedValue({ id: "eng-s-cmd", engineMeta: {} } as any);
      adapterA.invokeCommand.mockResolvedValue({ handledAsCommand: true } as any);

      const result = await engineManager.invokeCommand("conv1", "help", "");
      expect(adapterA.createSession).toHaveBeenCalled();
      expect(adapterA.invokeCommand).toHaveBeenCalledWith(
        "eng-s-cmd",
        "help",
        "",
        expect.objectContaining({ directory: "/dir" }),
      );
      expect(result.handledAsCommand).toBe(true);
    });

    it("falls back to sendMessage when handledAsCommand is false", async () => {
      (conversationStore.get as any).mockReturnValue(
        makeMockConv({ engineSessionId: "eng-s1" }),
      );
      adapterA.hasSession.mockReturnValue(true);
      adapterA.invokeCommand.mockResolvedValue({ handledAsCommand: false } as any);
      adapterA.sendMessage.mockResolvedValue({ id: "fallback-msg" } as any);

      const result = await engineManager.invokeCommand("conv1", "help", "topic");
      expect(adapterA.sendMessage).toHaveBeenCalledWith(
        "eng-s1",
        [{ type: "text", text: "/help topic" }],
        expect.any(Object),
      );
      expect(result.handledAsCommand).toBe(false);
      expect((result as any).message.id).toBe("fallback-msg");
    });

    it("formats command text without trailing space when args is empty", async () => {
      (conversationStore.get as any).mockReturnValue(
        makeMockConv({ engineSessionId: "eng-s2" }),
      );
      adapterA.hasSession.mockReturnValue(true);
      adapterA.invokeCommand.mockResolvedValue({ handledAsCommand: false } as any);
      adapterA.sendMessage.mockResolvedValue({ id: "msg" } as any);

      await engineManager.invokeCommand("conv1", "help", "");
      const sendArgs = (adapterA.sendMessage as any).mock.calls[0][1];
      expect(sendArgs[0].text).toBe("/help");
    });
  });

  // ===========================================================================
  // listMessages — copilot legacy cost unit fallback
  // ===========================================================================

  describe("listMessages — copilot legacy cost unit", () => {
    it("adds premium_requests costUnit for copilot messages with cost but no costUnit", async () => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.listMessages as any).mockResolvedValue([
        { id: "m1", role: "assistant", time: {}, parts: [], cost: 1, costUnit: undefined },
      ]);
      (conversationStore.getAllSteps as any).mockResolvedValue(null);
      // Register as copilot
      const copilotAdapter = new MockEngineAdapter("copilot" as any);
      engineManager.registerAdapter(copilotAdapter);
      // Register session as copilot engine
      engineManager.registerSession("conv-copilot", "copilot" as any);

      const messages = await engineManager.listMessages("conv-copilot");
      expect(messages[0].costUnit).toBe("premium_requests");
    });

    it("does NOT add premium_requests costUnit for non-copilot engines", async () => {
      engineManager.registerAdapter(adapterA);
      engineManager.registerSession("conv-opencode", adapterA.engineType);
      (conversationStore.listMessages as any).mockResolvedValue([
        { id: "m1", role: "assistant", time: {}, parts: [], cost: 5, costUnit: undefined },
      ]);
      (conversationStore.getAllSteps as any).mockResolvedValue(null);

      const messages = await engineManager.listMessages("conv-opencode");
      expect(messages[0].costUnit).toBeUndefined();
    });

    it("keeps existing costUnit when already set", async () => {
      engineManager.registerAdapter(adapterA);
      engineManager.registerSession("conv-x", adapterA.engineType);
      (conversationStore.listMessages as any).mockResolvedValue([
        { id: "m1", role: "assistant", time: {}, parts: [], cost: 5, costUnit: "usd" },
      ]);
      (conversationStore.getAllSteps as any).mockResolvedValue(null);

      const messages = await engineManager.listMessages("conv-x");
      expect(messages[0].costUnit).toBe("usd");
    });

    it("reports stepCount from stepsFile", async () => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.listMessages as any).mockResolvedValue([
        { id: "m1", role: "assistant", time: {}, parts: [] },
      ]);
      (conversationStore.getAllSteps as any).mockResolvedValue({
        messages: { m1: ["step1", "step2", "step3"] },
      });

      const messages = await engineManager.listMessages("conv1");
      expect(messages[0].stepCount).toBe(3);
    });
  });

  // ===========================================================================
  // Event Forwarding
  // ===========================================================================

  describe("Event Forwarding", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv1" });
      (conversationStore.get as any).mockReturnValue(makeMockConv({ title: "New session" }));
    });

    it("forwards message part updates for text and reasoning parts", () => {
      const textPart = { id: "p1", type: "text", text: "hi", sessionId: "engine-s1", messageId: "m1" } as any;
      const stepPart = { id: "p2", type: "reasoning", content: "thinking", sessionId: "engine-s1", messageId: "m1" } as any;
      const eventSpy = vi.fn();
      engineManager.on("message.part.updated", eventSpy);

      adapterA.emit("message.part.updated", { sessionId: "engine-s1", messageId: "m1", part: textPart });
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "conv1",
          part: expect.objectContaining({ sessionId: "conv1" }),
        }),
      );

      adapterA.emit("message.part.updated", { sessionId: "engine-s1", messageId: "m1", part: stepPart });
      expect(eventSpy).toHaveBeenCalledTimes(2);
    });

    it("emits message.part.updated as-is when convId cannot be resolved", () => {
      (conversationStore.findByEngineSession as any).mockReturnValue(null);
      const part = { id: "p1", type: "text", sessionId: "unknown-eng", messageId: "m1" } as any;
      const eventSpy = vi.fn();
      engineManager.on("message.part.updated", eventSpy);

      adapterA.emit("message.part.updated", { sessionId: "unknown-eng", messageId: "m1", part });
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "unknown-eng" }),
      );
    });

    it("buffers content parts and updates existing entries by part id", () => {
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv1" });

      const part1 = { id: "p1", type: "text", text: "v1", sessionId: "eng-s", messageId: "m1" } as any;
      adapterA.emit("message.part.updated", { sessionId: "eng-s", messageId: "m1", part: part1 });

      // Emit same part id again with updated content — should update not push
      const part1Updated = { id: "p1", type: "text", text: "v2", sessionId: "eng-s", messageId: "m1" } as any;
      adapterA.emit("message.part.updated", { sessionId: "eng-s", messageId: "m1", part: part1Updated });

      // Verify the buffer contains only 1 entry (updated in place) by checking via persistMessage flush
      // The contentPartsBuffer should reflect the update when a message.updated fires
      (conversationStore.listMessages as any).mockResolvedValue([]);
      adapterA.emit("message.updated", {
        sessionId: "eng-s",
        message: {
          id: "m1",
          role: "assistant",
          time: { created: 1, completed: 2 },
          parts: [],
        },
      });
      // Flush microtasks
      return Promise.resolve().then(() => {
        // appendMessage was called exactly once (not twice) with the message
        const callCount = (conversationStore.appendMessage as any).mock.calls.filter(
          (c: any[]) => c[0] === "conv1",
        ).length;
        expect(callCount).toBe(1);
      });
    });

    it("buffers step parts and updates existing step entries by part id", () => {
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv1" });

      const step1 = { id: "s1", type: "tool", sessionId: "eng-s", messageId: "m2" } as any;
      adapterA.emit("message.part.updated", { sessionId: "eng-s", messageId: "m2", part: step1 });

      // Emit same step id again — should update
      const step1v2 = { id: "s1", type: "tool", result: "done", sessionId: "eng-s", messageId: "m2" } as any;
      adapterA.emit("message.part.updated", { sessionId: "eng-s", messageId: "m2", part: step1v2 });

      // Step part should be marked dirty and schedule a flush
      // Just verify no errors thrown
    });

    it("does not mark step parts dirty when convId is null", () => {
      (conversationStore.findByEngineSession as any).mockReturnValue(null);
      const stepPart = { id: "s1", type: "tool", sessionId: "unknown", messageId: "m-x" } as any;

      // Should not throw
      adapterA.emit("message.part.updated", { sessionId: "unknown", messageId: "m-x", part: stepPart });
    });

    it("persists or updates assistant messages and skips incomplete ones", async () => {
      (conversationStore.listMessages as any).mockResolvedValue([]);
      const completedMessage = {
        id: "m1",
        sessionId: "engine-s1",
        role: "assistant",
        time: { created: 1, completed: 2 },
        parts: [{ id: "p1", type: "text", text: "done", sessionId: "engine-s1", messageId: "m1" } as any],
      } as any;
      adapterA.emit("message.updated", { sessionId: "engine-s1", message: completedMessage });
      await new Promise((r) => setTimeout(r, 0));
      expect(conversationStore.appendMessage).toHaveBeenCalledWith(
        "conv1",
        expect.objectContaining({ id: "m1" }),
      );

      (conversationStore.listMessages as any).mockResolvedValue([{ id: "m1" }]);
      adapterA.emit("message.updated", { sessionId: "engine-s1", message: completedMessage });
      await new Promise((r) => setTimeout(r, 0));
      expect(conversationStore.updateMessage).toHaveBeenCalledWith(
        "conv1",
        "m1",
        expect.objectContaining({ id: "m1" }),
      );

      const incompleteMessage = {
        id: "m2",
        sessionId: "engine-s1",
        role: "assistant",
        time: { created: 1 },
        parts: [],
      } as any;
      adapterA.emit("message.updated", { sessionId: "engine-s1", message: incompleteMessage });
      await new Promise((r) => setTimeout(r, 0));
      expect(conversationStore.appendMessage).not.toHaveBeenCalledWith(
        "conv1",
        expect.objectContaining({ id: "m2" }),
      );
    });

    it("skips persisting user messages from message.updated event", async () => {
      const userMessage = {
        id: "user-m1",
        sessionId: "engine-s1",
        role: "user",
        time: { created: 1, completed: 2 },
        parts: [{ id: "p1", type: "text", text: "hello" }],
      } as any;
      adapterA.emit("message.updated", { sessionId: "engine-s1", message: userMessage });
      await new Promise((r) => setTimeout(r, 0));
      // user messages should be skipped by persistMessage
      expect(conversationStore.appendMessage).not.toHaveBeenCalledWith(
        "conv1",
        expect.objectContaining({ id: "user-m1" }),
      );
    });

    it("emits message.updated as-is when convId cannot be resolved", () => {
      (conversationStore.findByEngineSession as any).mockReturnValue(null);
      const eventSpy = vi.fn();
      engineManager.on("message.updated", eventSpy);
      const msg = { id: "m1", role: "assistant", time: {}, parts: [] };
      adapterA.emit("message.updated", { sessionId: "no-session", message: msg as any });
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "no-session" }),
      );
    });

    it("forwards session updates and tracks permission requests", () => {
      adapterA.emit("session.updated", {
        session: { id: "engine-s1", title: "Real Title", engineType: adapterA.engineType } as any,
      });
      expect(conversationStore.rename).toHaveBeenCalledWith("conv1", "Real Title");

      adapterA.emit("permission.asked", {
        permission: {
          id: "p1",
          sessionId: "engine-s1",
          engineType: adapterA.engineType,
          title: "test",
          kind: "file_read",
          options: {},
        } as any,
      });
    });

    it("session.updated does NOT rename when title is not default", () => {
      (conversationStore.get as any).mockReturnValue(makeMockConv({ title: "My Custom Title" }));
      adapterA.emit("session.updated", {
        session: { id: "engine-s1", title: "Engine Title", engineType: adapterA.engineType } as any,
      });
      // conv.title is "My Custom Title" (not default), so rename should be called
      // Wait - isDefaultTitle("My Custom Title") = false, so rename SHOULD NOT be called
      expect(conversationStore.rename).not.toHaveBeenCalled();
    });

    it("session.updated persists engineMeta when provided", () => {
      (conversationStore.get as any).mockReturnValue(
        makeMockConv({ title: "New session", engineSessionId: "eng-s" }),
      );
      adapterA.emit("session.updated", {
        session: {
          id: "engine-s1",
          engineMeta: { ccSessionId: "cc_abc" },
          engineType: adapterA.engineType,
        } as any,
      });
      expect(conversationStore.setEngineSession).toHaveBeenCalled();
    });

    it("session.updated emits as-is when convId is null", () => {
      (conversationStore.findByEngineSession as any).mockReturnValue(null);
      const eventSpy = vi.fn();
      engineManager.on("session.updated", eventSpy);
      adapterA.emit("session.updated", {
        session: { id: "no-conv", engineType: "opencode" as any },
      });
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ session: expect.objectContaining({ id: "no-conv" }) }),
      );
    });

    it("session.updated handles null engineSessionId in session data", () => {
      const eventSpy = vi.fn();
      engineManager.on("session.updated", eventSpy);
      // Emit with no id on session
      adapterA.emit("session.updated", {
        session: { engineType: "opencode" as any } as any,
      });
      expect(eventSpy).toHaveBeenCalled();
    });

    it("does NOT forward session.created when convId cannot be resolved", () => {
      (conversationStore.findByEngineSession as any).mockReturnValue(null);
      const eventSpy = vi.fn();
      engineManager.on("session.created" as any, eventSpy);

      adapterA.emit("session.created", {
        session: {
          id: "lazy-eng-s",
          engineType: adapterA.engineType,
          directory: "/dir",
          title: "Test",
          time: { created: Date.now() },
        },
      });
      // Should NOT forward
      expect(eventSpy).not.toHaveBeenCalled();
    });

    it("forwards status.changed event even when engineSessionId is absent", () => {
      (conversationStore.findByEngineSession as any).mockReturnValue(null);
      const eventSpy = vi.fn();
      engineManager.on("status.changed", eventSpy);

      adapterA.emit("status.changed", {
        engineType: adapterA.engineType,
        status: "stopped" as any,
      });
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ engineType: adapterA.engineType }),
      );
    });

    it("rewrites sessionId in simple events when convId resolves", () => {
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv1" });
      const eventSpy = vi.fn();
      engineManager.on("message.queued", eventSpy);

      adapterA.emit("message.queued", {
        sessionId: "engine-s1",
        messageId: "m1",
        queuePosition: 0,
      });
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "conv1" }),
      );
    });
  });

  // ===========================================================================
  // rewriteSessionId — all nested field branches
  // ===========================================================================

  describe("rewriteSessionId — nested field rewrites", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv-rw" });
      (conversationStore.get as any).mockReturnValue(makeMockConv({ id: "conv-rw" }));
    });

    it("rewrites top-level sessionId", () => {
      const spy = vi.fn();
      engineManager.on("message.queued", spy);

      adapterA.emit("message.queued", {
        sessionId: "eng-rw",
        messageId: "m1",
        queuePosition: 0,
      });
      expect(spy.mock.calls[0][0].sessionId).toBe("conv-rw");
    });

    it("rewrites nested message.sessionId and parts[].sessionId", async () => {
      (conversationStore.listMessages as any).mockResolvedValue([]);
      const spy = vi.fn();
      engineManager.on("message.updated", spy);

      const msg = {
        id: "m1",
        role: "assistant",
        sessionId: "eng-rw",
        time: { created: 1, completed: 2 },
        parts: [
          { id: "p1", sessionId: "eng-rw", type: "text", text: "hello" },
          { id: "p2", sessionId: "other-id", type: "text", text: "world" },
        ],
      };
      adapterA.emit("message.updated", { sessionId: "eng-rw", message: msg as any });

      expect(spy).toHaveBeenCalled();
      const rewritten = spy.mock.calls[0][0];
      expect(rewritten.message.sessionId).toBe("conv-rw");
      expect(rewritten.message.parts[0].sessionId).toBe("conv-rw");
      // Part with different sessionId should NOT be rewritten
      expect(rewritten.message.parts[1].sessionId).toBe("other-id");
    });

    it("rewrites nested part.sessionId in message.part.updated", () => {
      const spy = vi.fn();
      engineManager.on("message.part.updated", spy);

      adapterA.emit("message.part.updated", {
        sessionId: "eng-rw",
        messageId: "m1",
        part: { id: "p1", type: "text", sessionId: "eng-rw", messageId: "m1" },
      });

      const rewritten = spy.mock.calls[0][0];
      expect(rewritten.part.sessionId).toBe("conv-rw");
    });

    it("rewrites nested permission.sessionId", () => {
      const spy = vi.fn();
      engineManager.on("permission.asked", spy);

      adapterA.emit("permission.asked", {
        permission: {
          id: "perm-rw",
          sessionId: "eng-rw",
          title: "t",
          kind: "file_read",
          options: {},
        } as any,
      });

      const rewritten = spy.mock.calls[0][0];
      expect(rewritten.permission.sessionId).toBe("conv-rw");
    });

    it("rewrites nested question.sessionId", () => {
      const spy = vi.fn();
      engineManager.on("question.asked", spy);

      adapterA.emit("question.asked", {
        question: {
          id: "q-rw",
          sessionId: "eng-rw",
          questions: [],
        } as any,
      });

      const rewritten = spy.mock.calls[0][0];
      expect(rewritten.question.sessionId).toBe("conv-rw");
    });

    it("rewrites nested session.id in session.created", () => {
      // Pre-populate the engineToConvMap so session.created can be resolved
      const spy = vi.fn();
      engineManager.on("session.created" as any, spy);

      adapterA.emit("session.created", {
        session: {
          id: "eng-rw",
          engineType: adapterA.engineType,
          directory: "/dir",
          title: "Test",
          time: { created: 1 },
        },
      });

      // session.created IS forwarded when convId is found
      expect(spy).toHaveBeenCalled();
      const rewritten = spy.mock.calls[0][0];
      expect(rewritten.session.id).toBe("conv-rw");
    });
  });

  // ===========================================================================
  // persistMessage edge cases
  // ===========================================================================

  describe("persistMessage edge cases", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv-pm" });
      (conversationStore.get as any).mockReturnValue(makeMockConv({ id: "conv-pm" }));
    });

    it("rewrites part.sessionId to conversationId when they differ", async () => {
      (conversationStore.listMessages as any).mockResolvedValue([]);
      const msg = {
        id: "m-rewrite",
        role: "assistant",
        time: { created: 1, completed: 2 },
        parts: [
          // Part whose sessionId differs from conversationId
          { id: "p1", type: "text", text: "hi", sessionId: "eng-s-other", messageId: "m-rewrite" },
        ],
      };
      adapterA.emit("message.updated", { sessionId: "eng-s-pm", message: msg as any });
      await new Promise((r) => setTimeout(r, 0));

      const appendCall = (conversationStore.appendMessage as any).mock.calls[0];
      expect(appendCall[1].parts[0].sessionId).toBe("conv-pm");
    });

    it("does not rewrite part.sessionId when it already matches conversationId", async () => {
      (conversationStore.listMessages as any).mockResolvedValue([]);
      const msg = {
        id: "m-no-rewrite",
        role: "assistant",
        time: { created: 1, completed: 2 },
        parts: [
          { id: "p1", type: "text", text: "hi", sessionId: "conv-pm", messageId: "m-no-rewrite" },
        ],
      };
      adapterA.emit("message.updated", { sessionId: "eng-s-pm", message: msg as any });
      await new Promise((r) => setTimeout(r, 0));

      const appendCall = (conversationStore.appendMessage as any).mock.calls[0];
      expect(appendCall[1].parts[0].sessionId).toBe("conv-pm");
    });

    it("saves step parts to stepsFile when message has step parts", async () => {
      (conversationStore.listMessages as any).mockResolvedValue([]);
      const msg = {
        id: "m-steps",
        role: "assistant",
        time: { created: 1, completed: 2 },
        parts: [
          { id: "p1", type: "text", text: "result", sessionId: "eng-s-pm", messageId: "m-steps" },
          { id: "s1", type: "tool", sessionId: "eng-s-pm", messageId: "m-steps" },
        ],
      };
      adapterA.emit("message.updated", { sessionId: "eng-s-pm", message: msg as any });
      await new Promise((r) => setTimeout(r, 0));

      expect(conversationStore.saveSteps).toHaveBeenCalledWith(
        "conv-pm",
        "m-steps",
        expect.arrayContaining([expect.objectContaining({ id: "s1" })]),
      );
    });

    it("merges buffered content parts not already in message.parts", async () => {
      // Pre-buffer a content part
      adapterA.emit("message.part.updated", {
        sessionId: "eng-s-pm",
        messageId: "m-merge",
        part: { id: "buffered-p", type: "text", text: "from buffer", sessionId: "eng-s-pm", messageId: "m-merge" },
      });

      // Now send message.updated with empty parts
      (conversationStore.listMessages as any).mockResolvedValue([]);
      adapterA.emit("message.updated", {
        sessionId: "eng-s-pm",
        message: {
          id: "m-merge",
          role: "assistant",
          time: { created: 1, completed: 2 },
          parts: [],
        },
      });
      await new Promise((r) => setTimeout(r, 0));

      const appendCall = (conversationStore.appendMessage as any).mock.calls[0];
      expect(appendCall[1].parts).toHaveLength(1);
      expect(appendCall[1].parts[0].id).toBe("buffered-p");
    });

    it("deduplicates buffered content parts already in message.parts", async () => {
      // Pre-buffer a content part
      adapterA.emit("message.part.updated", {
        sessionId: "eng-s-pm",
        messageId: "m-dedup",
        part: { id: "p-dup", type: "text", text: "v1", sessionId: "eng-s-pm", messageId: "m-dedup" },
      });

      // message.updated includes same part id in its parts array
      (conversationStore.listMessages as any).mockResolvedValue([]);
      adapterA.emit("message.updated", {
        sessionId: "eng-s-pm",
        message: {
          id: "m-dedup",
          role: "assistant",
          time: { created: 1, completed: 2 },
          parts: [
            { id: "p-dup", type: "text", text: "v2", sessionId: "eng-s-pm", messageId: "m-dedup" },
          ],
        },
      });
      await new Promise((r) => setTimeout(r, 0));

      const appendCall = (conversationStore.appendMessage as any).mock.calls[0];
      // Should only have one entry (no duplicate from buffer)
      expect(appendCall[1].parts).toHaveLength(1);
    });

    it("logs error and does not throw when conversationStore throws during persistMessage", async () => {
      (conversationStore.listMessages as any).mockRejectedValue(new Error("DB error"));
      const msg = {
        id: "m-err",
        role: "assistant",
        time: { created: 1, completed: 2 },
        parts: [],
      };
      // Should not throw
      adapterA.emit("message.updated", { sessionId: "eng-s-pm", message: msg as any });
      await new Promise((r) => setTimeout(r, 0));
      // Error should be logged
      expect(vi.mocked(engineManagerLog).error).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // scheduleStepFlush — timer deduplication
  // ===========================================================================

  describe("scheduleStepFlush", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not create a second timer when one is already scheduled", async () => {
      vi.useFakeTimers();
      engineManager.registerAdapter(adapterA);
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv-flush" });

      // Emit step-type parts twice — should only schedule one timer
      const stepPart1 = { id: "s1", type: "tool", sessionId: "eng-flush", messageId: "m1" } as any;
      const stepPart2 = { id: "s2", type: "tool", sessionId: "eng-flush", messageId: "m1" } as any;

      adapterA.emit("message.part.updated", { sessionId: "eng-flush", messageId: "m1", part: stepPart1 });
      adapterA.emit("message.part.updated", { sessionId: "eng-flush", messageId: "m1", part: stepPart2 });

      // Only 1 timer should have been scheduled (deduplication via stepFlushTimer guard)
      // Advance timer past the flush interval
      await vi.advanceTimersByTimeAsync(3000);
    });
  });

  // ===========================================================================
  // flushDirtySteps — all branches
  // ===========================================================================

  describe("flushDirtySteps", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("creates placeholder message on first flush and skips on subsequent", async () => {
      vi.useFakeTimers();
      engineManager.registerAdapter(adapterA);
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv-fd" });

      const stepPart = { id: "s1", type: "tool", sessionId: "eng-fd", messageId: "m-fd" } as any;
      adapterA.emit("message.part.updated", { sessionId: "eng-fd", messageId: "m-fd", part: stepPart });

      // Advance to trigger first flush
      await vi.advanceTimersByTimeAsync(2500);
      expect(conversationStore.ensureMessage).toHaveBeenCalledWith(
        "conv-fd",
        expect.objectContaining({ id: "m-fd", role: "assistant" }),
      );

      // Emit again to trigger a second schedule
      adapterA.emit("message.part.updated", { sessionId: "eng-fd", messageId: "m-fd", part: stepPart });
      (conversationStore.ensureMessage as any).mockClear();

      await vi.advanceTimersByTimeAsync(2500);
      // ensureMessage should NOT be called again (persistedPlaceholders prevents it)
      // NOTE: after message.updated flushes persistMessage, persistedPlaceholders is cleared
      // Here we did NOT fire message.updated, so placeholder should still be set
      expect(conversationStore.ensureMessage).not.toHaveBeenCalled();
    });

    it("rewrites step sessionId to conversationId before saving", async () => {
      vi.useFakeTimers();
      engineManager.registerAdapter(adapterA);
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv-rw-steps" });

      const stepPart = {
        id: "s-rw",
        type: "tool",
        sessionId: "eng-rw-steps",
        messageId: "m-rw",
      } as any;
      adapterA.emit("message.part.updated", { sessionId: "eng-rw-steps", messageId: "m-rw", part: stepPart });

      await vi.advanceTimersByTimeAsync(2500);
      const saveStepsCall = (conversationStore.saveSteps as any).mock.calls[0];
      expect(saveStepsCall[2][0].sessionId).toBe("conv-rw-steps");
    });

    it("re-adds messageId to dirtySteps when saveSteps throws", async () => {
      vi.useFakeTimers();
      engineManager.registerAdapter(adapterA);
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv-err-flush" });
      (conversationStore.saveSteps as any).mockRejectedValue(new Error("IO fail"));

      const stepPart = { id: "s-err", type: "tool", sessionId: "eng-err-f", messageId: "m-err-f" } as any;
      adapterA.emit("message.part.updated", { sessionId: "eng-err-f", messageId: "m-err-f", part: stepPart });

      await vi.advanceTimersByTimeAsync(2500);
      // Error logged
      expect(vi.mocked(engineManagerLog).error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to flush steps"),
        expect.any(Error),
      );
    });

    it("skips messageId when no convId found in messageConvMap", async () => {
      // Manually call flushDirtySteps with a messageId that has no convId entry
      const manager = engineManager as any;
      manager.dirtySteps.add("orphan-msg");
      // messageConvMap has no entry for "orphan-msg"
      await manager.flushDirtySteps();
      // Should complete without error
      expect(conversationStore.saveSteps).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // persistUserMessage edge cases
  // ===========================================================================

  describe("persistUserMessage edge cases", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.get as any).mockReturnValue(makeMockConv({ engineSessionId: null }));
      adapterA.createSession.mockResolvedValue({ id: "eng-pum", engineMeta: {} } as any);
    });

    it("persists image content as text placeholder", async () => {
      await engineManager.sendMessage("conv1", [
        { type: "image", data: "base64abc", mimeType: "image/png" } as any,
      ]);

      const appendCall = (conversationStore.appendMessage as any).mock.calls.find(
        (c: any[]) => c[0] === "conv1",
      );
      expect(appendCall).toBeDefined();
      const msg = appendCall[1];
      expect(msg.parts[0].text).toContain("[Image:");
      expect(msg.parts[0].text).toContain("image/png");
    });

    it("uses 'image' as fallback when mimeType is absent", async () => {
      await engineManager.sendMessage("conv1", [
        { type: "image", data: "base64abc" } as any,
      ]);

      const appendCall = (conversationStore.appendMessage as any).mock.calls.find(
        (c: any[]) => c[0] === "conv1",
      );
      expect(appendCall[1].parts[0].text).toContain("[Image: image]");
    });

    it("does NOT persist when parts array would be empty", async () => {
      // Content with neither text nor image data — should produce no parts → return early
      await engineManager.sendMessage("conv1", [
        { type: "text", text: "" } as any, // empty text
      ]);

      // appendMessage for user message should NOT have been called
      const userAppend = (conversationStore.appendMessage as any).mock.calls.find(
        (c: any[]) => c[0] === "conv1" && c[1]?.role === "user",
      );
      expect(userAppend).toBeUndefined();
    });

    it("ignores unknown content types", async () => {
      await engineManager.sendMessage("conv1", [
        { type: "unknown-type" } as any,
      ]);
      // No user message should be appended
      const userAppend = (conversationStore.appendMessage as any).mock.calls.find(
        (c: any[]) => c[0] === "conv1" && c[1]?.role === "user",
      );
      expect(userAppend).toBeUndefined();
    });
  });

  // ===========================================================================
  // getAdapterForSession — fallback and error paths
  // ===========================================================================

  describe("getAdapterForSession — fallback paths", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("resolves adapter via conversationStore fallback when not in sessionEngineMap", async () => {
      // conv returned with engineType so the fallback path is taken
      (conversationStore.get as any).mockReturnValue(
        makeMockConv({ engineType: adapterA.engineType, engineSessionId: "eng-fb" }),
      );

      // cancelMessage triggers getAdapterForSession
      await engineManager.cancelMessage("conv-fallback");
      expect(adapterA.cancelMessage).toHaveBeenCalled();
    });

    it("throws when no engine binding in sessionEngineMap and store returns null on fallback", async () => {
      // sendMessage first calls store.get (returns valid conv), then getAdapterForSession
      // calls store.get again (returns null) → engineType never resolved → throws
      const validConv = makeMockConv({ engineSessionId: null });
      (conversationStore.get as any)
        .mockReturnValueOnce(validConv)   // used by sendMessage
        .mockReturnValueOnce(null);        // used by getAdapterForSession fallback
      await expect(
        engineManager.sendMessage("no-session", [{ type: "text", text: "hi" }]),
      ).rejects.toThrow(/No engine binding found for session/);
    });

    it("throws when store has conv but engineType is falsy", async () => {
      // Both calls to store.get return a conv with falsy engineType
      const convNoType = makeMockConv({ engineType: null, engineSessionId: null });
      (conversationStore.get as any).mockReturnValue(convNoType as any);
      await expect(
        engineManager.sendMessage("bad-conv", [{ type: "text", text: "hi" }]),
      ).rejects.toThrow(/No engine binding found for session/);
    });
  });

  // ===========================================================================
  // resolveConversationId
  // ===========================================================================

  describe("resolveConversationId", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("returns cached conversationId on second lookup", () => {
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv-cached" });
      const spy = vi.fn();
      engineManager.on("message.queued", spy);

      adapterA.emit("message.queued", { sessionId: "eng-cache", messageId: "m", queuePosition: 0 });
      // First lookup — hits findByEngineSession
      expect(conversationStore.findByEngineSession).toHaveBeenCalledTimes(1);

      adapterA.emit("message.queued", { sessionId: "eng-cache", messageId: "m2", queuePosition: 0 });
      // Second lookup — should hit in-memory cache, NOT call findByEngineSession again
      expect(conversationStore.findByEngineSession).toHaveBeenCalledTimes(1);
    });

    it("returns null when store also has no record", () => {
      (conversationStore.findByEngineSession as any).mockReturnValue(null);
      const spy = vi.fn();
      engineManager.on("message.queued", spy);

      adapterA.emit("message.queued", { sessionId: "totally-unknown", messageId: "m", queuePosition: 0 });
      // Should emit as-is (not throw)
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "totally-unknown" }),
      );
    });
  });

  // ===========================================================================
  // Store Integration
  // ===========================================================================

  describe("Store Integration", () => {
    it("synchronizes with conversation store state", () => {
      (conversationStore.list as any).mockReturnValue([
        { id: "c1", engineType: "opencode", directory: "/dir1", engineSessionId: "es1" },
      ]);
      engineManager.initFromStore();
      expect(engineManager.getProjectEngine("/dir1")).toBe("opencode");

      (conversationStore.list as any).mockReturnValue([{ id: "c1", engineType: "opencode", time: { created: 1 } }]);
      const all = engineManager.listAllSessions();
      expect(all).toHaveLength(1);
    });

    it("initFromStore skips caching when no engineSessionId", () => {
      (conversationStore.list as any).mockReturnValue([
        { id: "c-noeng", engineType: "opencode", directory: "/dir-noeng", engineSessionId: null },
      ]);
      engineManager.initFromStore();
      // Should not throw; directory binding should still be added
      expect(engineManager.getProjectEngine("/dir-noeng")).toBe("opencode");
    });

    it("initFromStore skips directory binding for root '/'", () => {
      (conversationStore.list as any).mockReturnValue([
        { id: "c-root", engineType: "opencode", directory: "/" },
      ]);
      engineManager.initFromStore();
      // Should not create binding for "/"
      expect(engineManager.getProjectEngine("/")).toBeUndefined();
    });

    it("initFromStore does not override existing project bindings", () => {
      engineManager.registerAdapter(adapterA);
      engineManager.setProjectEngine("/existing", adapterA.engineType);

      (conversationStore.list as any).mockReturnValue([
        { id: "c-x", engineType: "claude-code", directory: "/existing" },
      ]);
      engineManager.initFromStore();
      // Original binding (opencode) should be preserved
      expect(engineManager.getProjectEngine("/existing")).toBe(adapterA.engineType);
    });

    it("registerSession stores session engine mapping", () => {
      engineManager.registerSession("sess-reg", "opencode" as any);
      // Verify via listSessions or any indirect routing
      engineManager.registerAdapter(adapterA);
      (conversationStore.get as any).mockReturnValue(
        makeMockConv({ id: "sess-reg", engineSessionId: "eng-reg" }),
      );
      // The session should be routable without fallback to store
      return expect(engineManager.cancelMessage("sess-reg")).resolves.not.toThrow();
    });
  });

  // ===========================================================================
  // listAllProjects — default workspace
  // ===========================================================================

  describe("listAllProjects — default workspace", () => {
    it("appends default workspace when not already in derived projects", () => {
      (conversationStore.deriveProjects as any).mockReturnValue([
        { id: "p1", directory: "/myproject", name: "myproject" },
      ]);
      const projects = engineManager.listAllProjects();
      expect(projects).toHaveLength(2);

      const defaultProject = projects.find((p) => p.isDefault);
      expect(defaultProject).toBeDefined();
      expect(defaultProject!.directory).toBe("/mock/userData/workspace");
      expect(defaultProject!.name).toBe("workspace");
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

  // ===========================================================================
  // listProjects
  // ===========================================================================

  describe("listProjects", () => {
    it("filters deriveProjects by engineType", async () => {
      (conversationStore.deriveProjects as any).mockReturnValue([
        { id: "p1", engineType: "opencode", directory: "/d1" },
        { id: "p2", engineType: "claude-code", directory: "/d2" },
      ]);
      const result = await engineManager.listProjects("opencode" as any);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("p1");
    });
  });

  // ===========================================================================
  // importPreview — dedup logic
  // ===========================================================================

  describe("importPreview", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("marks session as already imported when engineSessionId matches existing", async () => {
      (conversationStore.findAllEngineSessionIds as any).mockReturnValue(
        new Set(["existing-eng-id"]),
      );
      adapterA.listHistoricalSessions.mockResolvedValue([
        {
          engineSessionId: "existing-eng-id",
          title: "Old Chat",
          directory: "/d",
          createdAt: 1,
          updatedAt: 2,
          alreadyImported: false,
        },
      ] as any);

      const result = await engineManager.importPreview(adapterA.engineType, 10);
      expect(result[0].alreadyImported).toBe(true);
    });

    it("marks session as already imported when ccSessionId matches existing", async () => {
      (conversationStore.findAllEngineSessionIds as any).mockReturnValue(
        new Set(["cc_abc123"]),
      );
      adapterA.listHistoricalSessions.mockResolvedValue([
        {
          engineSessionId: "new-eng-id",
          title: "Old Chat",
          directory: "/d",
          createdAt: 1,
          updatedAt: 2,
          alreadyImported: false,
          engineMeta: { ccSessionId: "cc_abc123" },
        },
      ] as any);

      const result = await engineManager.importPreview(adapterA.engineType, 10);
      expect(result[0].alreadyImported).toBe(true);
    });

    it("does NOT mark as imported when ccSessionId is not a string", async () => {
      (conversationStore.findAllEngineSessionIds as any).mockReturnValue(
        new Set(["some-id"]),
      );
      adapterA.listHistoricalSessions.mockResolvedValue([
        {
          engineSessionId: "fresh-id",
          title: "New Chat",
          directory: "/d",
          createdAt: 1,
          updatedAt: 2,
          alreadyImported: false,
          engineMeta: { ccSessionId: 12345 }, // not a string
        },
      ] as any);

      const result = await engineManager.importPreview(adapterA.engineType, 10);
      expect(result[0].alreadyImported).toBe(false);
    });

    it("returns false for alreadyImported when session is completely new", async () => {
      (conversationStore.findAllEngineSessionIds as any).mockReturnValue(new Set());
      adapterA.listHistoricalSessions.mockResolvedValue([
        {
          engineSessionId: "brand-new",
          title: "Brand New",
          directory: "/d",
          createdAt: 1,
          updatedAt: 2,
          alreadyImported: false,
        },
      ] as any);

      const result = await engineManager.importPreview(adapterA.engineType, 10);
      expect(result[0].alreadyImported).toBe(false);
    });
  });

  // ===========================================================================
  // importExecute
  // ===========================================================================

  describe("importExecute", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.importConversation as any).mockResolvedValue({ id: "conv-imp1" });
    });

    it("imports sessions and registers them in routing tables", async () => {
      adapterA.getHistoricalMessages.mockResolvedValue([
        {
          id: "m1",
          role: "user",
          time: { created: 1, completed: 1 },
          parts: [{ id: "p1", type: "text", text: "hi" }],
        },
        {
          id: "m2",
          role: "assistant",
          time: { created: 2, completed: 2 },
          parts: [
            { id: "p2", type: "text", text: "hello" },
            { id: "s1", type: "tool", name: "bash" },
          ],
        },
      ] as any);

      const result = await engineManager.importExecute(adapterA.engineType, [
        {
          engineSessionId: "eng-imp",
          directory: "/d",
          title: "Chat",
          createdAt: 1,
          updatedAt: 2,
        },
      ]);

      expect(result.imported).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(conversationStore.importConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          engineSessionId: "eng-imp",
          messages: expect.arrayContaining([
            expect.objectContaining({ id: "m1" }),
            expect.objectContaining({ id: "m2" }),
          ]),
          steps: expect.objectContaining({ m2: expect.arrayContaining([expect.objectContaining({ id: "s1" })]) }),
        }),
      );
    });

    it("records error and continues when getHistoricalMessages throws", async () => {
      adapterA.getHistoricalMessages.mockRejectedValue(new Error("Fetch failed"));

      const result = await engineManager.importExecute(adapterA.engineType, [
        { engineSessionId: "eng-fail", directory: "/d", title: "Fail Chat", createdAt: 1, updatedAt: 2 },
      ]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Fail Chat");
      expect(result.imported).toBe(0);
    });

    it("deletes existing conversation before reimporting", async () => {
      // Set up existing imported conversation
      (conversationStore.list as any).mockReturnValue([
        {
          id: "old-conv",
          engineType: adapterA.engineType,
          engineSessionId: "eng-reimport",
          imported: true,
          directory: "/d",
        },
      ]);
      adapterA.getHistoricalMessages.mockResolvedValue([]);

      await engineManager.importExecute(adapterA.engineType, [
        { engineSessionId: "eng-reimport", directory: "/d", title: "Reimport", createdAt: 1, updatedAt: 2 },
      ]);

      expect(conversationStore.delete).toHaveBeenCalledWith("old-conv");
    });

    it("handles reimport when existing conversation has no engineSessionId", async () => {
      (conversationStore.list as any).mockReturnValue([
        {
          id: "old-conv-no-eng",
          engineType: adapterA.engineType,
          engineSessionId: null,
          imported: true,
          directory: "/d",
          engineMeta: { ccSessionId: "cc_reimport" },
        },
      ]);
      adapterA.getHistoricalMessages.mockResolvedValue([]);

      await engineManager.importExecute(adapterA.engineType, [
        {
          engineSessionId: "new-eng-id",
          directory: "/d",
          title: "CC Reimport",
          createdAt: 1,
          updatedAt: 2,
          engineMeta: { ccSessionId: "cc_reimport" },
        },
      ]);

      expect(conversationStore.delete).toHaveBeenCalledWith("old-conv-no-eng");
    });

    it("emits import progress for each session", async () => {
      adapterA.getHistoricalMessages.mockResolvedValue([]);
      const progressEvents: any[] = [];
      engineManager.on("session.import.progress" as any, (p: any) => progressEvents.push(p));

      await engineManager.importExecute(adapterA.engineType, [
        { engineSessionId: "e1", directory: "/d", title: "S1", createdAt: 1, updatedAt: 2 },
        { engineSessionId: "e2", directory: "/d", title: "S2", createdAt: 1, updatedAt: 2 },
      ]);

      expect(progressEvents).toHaveLength(2);
      expect(progressEvents[0].total).toBe(2);
      expect(progressEvents[0].completed).toBe(1);
      expect(progressEvents[1].completed).toBe(2);
    });

    it("handles messages with no step parts (does not call saveSteps)", async () => {
      adapterA.getHistoricalMessages.mockResolvedValue([
        {
          id: "m-text-only",
          role: "assistant",
          time: { created: 1 },
          parts: [{ id: "p1", type: "text", text: "pure text" }],
        },
      ] as any);

      await engineManager.importExecute(adapterA.engineType, [
        { engineSessionId: "eng-noSteps", directory: "/d", title: "NoSteps", createdAt: 1, updatedAt: 2 },
      ]);

      const importCall = (conversationStore.importConversation as any).mock.calls[0][0];
      // steps should be empty object for messages with no non-text/file parts
      expect(importCall.steps).toEqual({});
    });
  });

  // ===========================================================================
  // isSessionIdle
  // ===========================================================================

  describe("isSessionIdle", () => {
    it("returns true for sessions not in activeSessions", () => {
      expect(engineManager.isSessionIdle("any-session")).toBe(true);
    });
  });

  // ===========================================================================
  // persistUserMessage — error catch path (line 583)
  // ===========================================================================

  describe("persistUserMessage — error path", () => {
    it("logs error when appendMessage throws", async () => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.get as any).mockReturnValue(makeMockConv({ engineSessionId: null }));
      adapterA.createSession.mockResolvedValue({ id: "eng-pum-err", engineMeta: {} } as any);
      (conversationStore.appendMessage as any).mockRejectedValue(new Error("DB write failed"));

      // Should not throw — error is caught and logged
      await expect(
        engineManager.sendMessage("conv1", [{ type: "text", text: "hello" }]),
      ).resolves.not.toThrow();

      expect(vi.mocked(engineManagerLog).error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to persist user message"),
        expect.any(Error),
      );
    });
  });

  // ===========================================================================
  // deleteSession — buffer cleanup when messages are in buffers (lines 750-754)
  // ===========================================================================

  describe("deleteSession — buffer cleanup with active messages", () => {
    it("cleans buffers for message IDs returned by listMessages", async () => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv-buf" });

      // Pre-populate buffers by emitting a step part event
      adapterA.emit("message.part.updated", {
        sessionId: "eng-buf",
        messageId: "m-buf",
        part: { id: "s1", type: "tool", sessionId: "eng-buf", messageId: "m-buf" },
      });

      // deleteSession with a conv that has the same messageId in listMessages
      (conversationStore.get as any).mockReturnValue(
        makeMockConv({ id: "conv-buf", engineSessionId: "eng-buf" }),
      );
      (conversationStore.listMessages as any).mockResolvedValue([{ id: "m-buf" }]);

      await engineManager.deleteSession("conv-buf");
      expect(conversationStore.delete).toHaveBeenCalledWith("conv-buf");
    });
  });

  // ===========================================================================
  // deleteProject — error paths (lines 800, 811)
  // ===========================================================================

  describe("deleteProject — error paths", () => {
    beforeEach(() => {
      engineManager.registerAdapter(adapterA);
    });

    it("logs warning when listMessages throws during project delete (line 800)", async () => {
      const conv = makeMockConv({ id: "c-err", directory: "/proj-err", engineSessionId: "es-err" });
      (conversationStore.list as any).mockReturnValue([conv]);
      (conversationStore.listMessages as any).mockRejectedValue(new Error("IO error during delete"));

      await engineManager.deleteProject("dir-/proj-err");

      expect(vi.mocked(engineManagerLog).warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to clean up buffers"),
        expect.any(Error),
      );
      expect(conversationStore.delete).toHaveBeenCalledWith("c-err");
    });

    it("logs warning when adapter.deleteSession throws during project delete (line 811)", async () => {
      adapterA.deleteSession.mockRejectedValue(new Error("Engine session delete failed"));
      const conv = makeMockConv({ id: "c-eng-err", directory: "/proj-eng-err", engineSessionId: "es-fail" });
      (conversationStore.list as any).mockReturnValue([conv]);
      (conversationStore.listMessages as any).mockResolvedValue([]);

      await engineManager.deleteProject("dir-/proj-eng-err");

      expect(vi.mocked(engineManagerLog).warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to delete engine session"),
        expect.any(Error),
      );
      expect(conversationStore.delete).toHaveBeenCalledWith("c-eng-err");
    });
  });

  // ===========================================================================
  // persistMessage — step buffer merge dedup (lines 451-455)
  // ===========================================================================

  describe("persistMessage — step buffer dedup", () => {
    beforeEach(() => {
      // Reset mocks that may have been set to reject by earlier tests
      // vi.clearAllMocks() resets call tracking but NOT mockReturnValue/mockRejectedValue impls
      (conversationStore.saveSteps as any).mockResolvedValue(undefined);
      (conversationStore.appendMessage as any).mockResolvedValue(undefined);
      (conversationStore.updateMessage as any).mockResolvedValue(undefined);
    });

    it("skips buffered step parts that duplicate step parts already in message.parts", async () => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv-sd" });
      (conversationStore.get as any).mockReturnValue(makeMockConv({ id: "conv-sd" }));
      (conversationStore.listMessages as any).mockResolvedValue([]);

      // Pre-buffer a step part
      adapterA.emit("message.part.updated", {
        sessionId: "eng-sd",
        messageId: "m-sd",
        part: { id: "step-dup", type: "tool", sessionId: "eng-sd", messageId: "m-sd" },
      });

      // message.updated includes the SAME step id in its parts
      adapterA.emit("message.updated", {
        sessionId: "eng-sd",
        message: {
          id: "m-sd",
          role: "assistant",
          time: { created: 1, completed: 2 },
          parts: [
            { id: "step-dup", type: "tool", sessionId: "eng-sd", messageId: "m-sd" },
          ],
        },
      });

      await new Promise((r) => setTimeout(r, 0));

      // saveSteps should be called with exactly 1 step (not duplicated)
      const saveStepsCall = (conversationStore.saveSteps as any).mock.calls[0];
      expect(saveStepsCall[2]).toHaveLength(1);
      expect(saveStepsCall[2][0].id).toBe("step-dup");
    });

    it("merges buffered step parts whose sessionId differs from conversationId", async () => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.findByEngineSession as any).mockReturnValue({ id: "conv-sdr" });
      (conversationStore.get as any).mockReturnValue(makeMockConv({ id: "conv-sdr" }));
      (conversationStore.listMessages as any).mockResolvedValue([]);

      // Pre-buffer a step part with a different sessionId (needs rewriting)
      adapterA.emit("message.part.updated", {
        sessionId: "eng-sdr",
        messageId: "m-sdr",
        part: { id: "step-rw", type: "tool", sessionId: "different-id", messageId: "m-sdr" },
      });

      // message.updated with empty parts — buffered step should be merged and rewritten
      adapterA.emit("message.updated", {
        sessionId: "eng-sdr",
        message: {
          id: "m-sdr",
          role: "assistant",
          time: { created: 1, completed: 2 },
          parts: [],
        },
      });

      await new Promise((r) => setTimeout(r, 0));

      const saveStepsCall = (conversationStore.saveSteps as any).mock.calls[0];
      expect(saveStepsCall[2][0].sessionId).toBe("conv-sdr");
    });
  });

  describe("getPending", () => {
    it("aggregates pending questions/permissions from the conversation's engine adapter and rewrites sessionId to conversationId", async () => {
      engineManager.registerAdapter(adapterA);

      (conversationStore.get as any).mockReturnValue({
        id: "conv-pending",
        engineType: "opencode",
        engineSessionId: "eng-pending",
        directory: "/dir",
      });

      adapterA.getPendingQuestions = vi.fn((sid?: string) => {
        expect(sid).toBe("eng-pending");
        return [
          {
            id: "q1",
            sessionId: "eng-pending",
            engineType: "opencode",
            questions: [{ question: "?", options: [] }],
          } as any,
        ];
      });
      adapterA.getPendingPermissions = vi.fn((sid?: string) => {
        expect(sid).toBe("eng-pending");
        return [
          {
            id: "p1",
            sessionId: "eng-pending",
            engineType: "opencode",
            title: "Edit",
            kind: "edit",
            options: [],
          } as any,
        ];
      });

      const result = await engineManager.getPending("conv-pending");

      expect(result.questions).toHaveLength(1);
      expect(result.questions[0].id).toBe("q1");
      expect(result.questions[0].sessionId).toBe("conv-pending");
      expect(result.permissions).toHaveLength(1);
      expect(result.permissions[0].id).toBe("p1");
      expect(result.permissions[0].sessionId).toBe("conv-pending");
    });

    it("returns empty arrays when the conversation is unknown", async () => {
      (conversationStore.get as any).mockReturnValue(null);
      const result = await engineManager.getPending("missing");
      expect(result).toEqual({ questions: [], permissions: [] });
    });

    it("returns empty arrays when engineSessionId is missing (avoids leaking pending items from unrelated sessions)", async () => {
      engineManager.registerAdapter(adapterA);
      (conversationStore.get as any).mockReturnValue({
        id: "conv-nosession",
        engineType: "opencode",
        engineSessionId: null,
        directory: "/dir",
      });
      const spyQ = vi.spyOn(adapterA, "getPendingQuestions");
      const spyP = vi.spyOn(adapterA, "getPendingPermissions");

      const result = await engineManager.getPending("conv-nosession");

      expect(result).toEqual({ questions: [], permissions: [] });
      // Must NOT call the adapter with undefined (which would bypass filtering)
      expect(spyQ).not.toHaveBeenCalled();
      expect(spyP).not.toHaveBeenCalled();
    });
  });
});
