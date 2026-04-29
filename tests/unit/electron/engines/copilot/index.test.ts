import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Hoisted mocks — must run before any imports
// ============================================================================

const {
  writeFileSyncMock,
  unlinkSyncMock,
  mkdtempSyncMock,
  rmdirSyncMock,
  resolvePlatformCliMock,
  readConfigModelMock,
  timeIdMock,
  mockClientInstance,
  mockSessionBase,
  CopilotClientConstructor,
} = vi.hoisted(() => {
  let _idCounter = 0;

  const timeIdMock = vi.fn((prefix: string) => `${prefix}-${++_idCounter}`);

  const mockSessionBase = {
    sessionId: "sdk-session-1",
    // Must use function() so vi.fn() works as a constructor when needed.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    on: vi.fn(function() { return vi.fn(); }),
    send: vi.fn(async function() {}),
    abort: vi.fn(async function() {}),
    disconnect: vi.fn(async function() {}),
    getMessages: vi.fn(async function() { return []; }),
    rpc: {
      model: { switchTo: vi.fn(async function() {}) },
      mode: { set: vi.fn(async function() {}) },
      skills: { list: vi.fn(async function() { return { skills: [] }; }) },
      commands: { handlePendingCommand: vi.fn(async function() {}) },
    },
  };

  const mockClientInstance = {
    start: vi.fn(async function() {}),
    stop: vi.fn(async function() {}),
    ping: vi.fn(async function() {}),
    getStatus: vi.fn(async function() { return { version: "1.0.0" }; }),
    getAuthStatus: vi.fn(async function() {
      return { isAuthenticated: true, login: "user@example.com" };
    }),
    listSessions: vi.fn(async function() { return []; }),
    createSession: vi.fn(async function() {
      return { ...mockSessionBase, sessionId: "sdk-session-1" };
    }),
    resumeSession: vi.fn(async function() {
      return { ...mockSessionBase, sessionId: "sdk-session-1" };
    }),
    deleteSession: vi.fn(async function() {}),
    listModels: vi.fn(async function() { return []; }),
    getState: vi.fn(function() { return "connected"; }),
  };

  // Must use function() (not arrow) so it can be called with `new`.
  const CopilotClientConstructor = vi.fn(function() { return mockClientInstance; });

  return {
    writeFileSyncMock: vi.fn(),
    unlinkSyncMock: vi.fn(),
    mkdtempSyncMock: vi.fn(function() { return "/tmp/codemux-img-abc"; }),
    rmdirSyncMock: vi.fn(),
    resolvePlatformCliMock: vi.fn(function() { return "/usr/local/bin/copilot"; }),
    readConfigModelMock: vi.fn(function() { return undefined; }),
    timeIdMock,
    mockClientInstance,
    mockSessionBase,
    CopilotClientConstructor,
  };
});

// ============================================================================
// Module mocks
// ============================================================================

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    writeFileSync: writeFileSyncMock,
    unlinkSync: unlinkSyncMock,
    mkdtempSync: mkdtempSyncMock,
    rmdirSync: rmdirSyncMock,
  };
});

vi.mock("../../../../../electron/main/services/logger", () => ({
  copilotLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../../../../electron/main/engines/copilot/config", () => ({
  DEFAULT_MODES: [
    { id: "autopilot", label: "Autopilot", description: "Fully autonomous" },
    { id: "interactive", label: "Interactive", description: "Interactive" },
    { id: "plan", label: "Plan", description: "Plan before executing" },
  ],
  readConfigModel: readConfigModelMock,
  resolvePlatformCli: resolvePlatformCliMock,
}));

vi.mock("../../../../../electron/main/utils/id-gen", () => ({
  timeId: timeIdMock,
}));

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: CopilotClientConstructor,
  CopilotSession: vi.fn(),
}));

// ============================================================================
// Import the module under test (after mocks are set up)
// ============================================================================

import { CopilotSdkAdapter } from "../../../../../electron/main/engines/copilot/index";

// ============================================================================
// Helpers
// ============================================================================

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Build a minimal MessageBuffer for testing */
function makeBuffer(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    messageId: "msg-1",
    sessionId,
    parts: [] as any[],
    textAccumulator: "",
    textPartId: null as string | null,
    reasoningAccumulator: "",
    reasoningPartId: null as string | null,
    startTime: 1000,
    ...overrides,
  };
}

/** Build a mock session with all rpc stubs */
function makeMockSession(sessionId = "s1") {
  return {
    sessionId,
    on: vi.fn(() => vi.fn()),
    send: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getMessages: vi.fn(async () => []),
    rpc: {
      model: { switchTo: vi.fn(async () => {}) },
      mode: { set: vi.fn(async () => {}) },
      skills: { list: vi.fn(async () => ({ skills: [] })) },
      commands: { handlePendingCommand: vi.fn(async () => {}) },
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("CopilotSdkAdapter", () => {
  let adapter: CopilotSdkAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset time-id counter on each test by resetting the mock implementation
    let _cnt = 0;
    timeIdMock.mockImplementation((prefix: string) => `${prefix}-${++_cnt}`);
    adapter = new CopilotSdkAdapter({ cliPath: "/usr/local/bin/copilot" });
  });

  // ============================================================================
  // A. Lifecycle
  // ============================================================================

  describe("start()", () => {
    it("creates a CopilotClient, starts it, pings, and transitions to running", async () => {
      await adapter.start();
      expect(mockClientInstance.start).toHaveBeenCalledTimes(1);
      expect(mockClientInstance.ping).toHaveBeenCalledTimes(1);
      expect(adapter.getStatus()).toBe("running");
    });

    it("captures version and auth info", async () => {
      await adapter.start();
      const info = adapter.getInfo();
      expect(info.version).toBe("1.0.0");
      expect(info.authenticated).toBe(true);
      expect(info.authMessage).toBe("user@example.com");
    });

    it("sets status to error and throws when client.ping fails", async () => {
      CopilotClientConstructor.mockImplementationOnce(function() {
        return {
          ...mockClientInstance,
          ping: vi.fn(async function() { throw new Error("ping failed"); }),
        };
      });
      const failAdapter = new CopilotSdkAdapter({ cliPath: "/usr/local/bin/copilot" });
      await expect(failAdapter.start()).rejects.toThrow("ping failed");
      expect(failAdapter.getStatus()).toBe("error");
      expect(failAdapter.getInfo().errorMessage).toBe("ping failed");
    });

    it("is a no-op when already running", async () => {
      await adapter.start();
      const callsBefore = mockClientInstance.start.mock.calls.length;
      await adapter.start();
      expect(mockClientInstance.start.mock.calls.length).toBe(callsBefore);
    });

    it("throws when no CLI path can be resolved", async () => {
      resolvePlatformCliMock.mockReturnValueOnce(undefined);
      const noCLI = new CopilotSdkAdapter(); // no cliPath option
      await expect(noCLI.start()).rejects.toThrow("No platform-native Copilot CLI binary");
    });

    it("continues when getStatus fails but still sets running", async () => {
      mockClientInstance.getStatus.mockRejectedValueOnce(new Error("version unavailable"));
      await adapter.start();
      expect(adapter.getStatus()).toBe("running");
      expect(adapter.getInfo().version).toBeUndefined();
    });

    it("continues when getAuthStatus fails", async () => {
      mockClientInstance.getAuthStatus.mockRejectedValueOnce(new Error("auth error"));
      await adapter.start();
      expect(adapter.getStatus()).toBe("running");
      expect(adapter.getInfo().authenticated).toBeUndefined();
    });
  });

  describe("stop()", () => {
    it("is a no-op when already stopped", async () => {
      await expect(adapter.stop()).resolves.toBeUndefined();
      expect(adapter.getStatus()).toBe("stopped");
    });

    it("disconnects all active sessions, calls client.stop, clears state", async () => {
      await adapter.start();
      const sess = makeMockSession("s1");
      const unsub = vi.fn();
      (adapter as any).activeSessions.set("s1", sess);
      (adapter as any).sessionUnsubscribers.set("s1", unsub);

      await adapter.stop();

      expect(unsub).toHaveBeenCalledTimes(1);
      expect(sess.disconnect).toHaveBeenCalledTimes(1);
      expect(mockClientInstance.stop).toHaveBeenCalledTimes(1);
      expect((adapter as any).activeSessions.size).toBe(0);
      expect((adapter as any).client).toBeNull();
      expect(adapter.getStatus()).toBe("stopped");
    });

    it("rejects all pending permissions with user-not-available", async () => {
      await adapter.start();
      const resolve = vi.fn();
      (adapter as any).pendingPermissions.set("p1", {
        resolve,
        permission: { id: "p1", sessionId: "s1" },
      });

      await adapter.stop();

      expect(resolve).toHaveBeenCalledWith({
        kind: "user-not-available",
      });
      expect((adapter as any).pendingPermissions.size).toBe(0);
    });

    it("rejects all pending questions with empty answer", async () => {
      await adapter.start();
      const resolve = vi.fn();
      (adapter as any).pendingQuestions.set("q1", {
        resolve,
        question: { id: "q1", sessionId: "s1" },
      });

      await adapter.stop();

      expect(resolve).toHaveBeenCalledWith({ answer: "", wasFreeform: true });
      expect((adapter as any).pendingQuestions.size).toBe(0);
    });

    it("continues even if session.disconnect throws", async () => {
      await adapter.start();
      const sess = makeMockSession("s1");
      sess.disconnect.mockRejectedValue(new Error("disconnect error"));
      (adapter as any).activeSessions.set("s1", sess);

      await expect(adapter.stop()).resolves.toBeUndefined();
      expect(adapter.getStatus()).toBe("stopped");
    });
  });

  describe("healthCheck()", () => {
    it("returns false when client is null", async () => {
      expect(await adapter.healthCheck()).toBe(false);
    });

    it("returns true when ping succeeds", async () => {
      await adapter.start();
      expect(await adapter.healthCheck()).toBe(true);
    });

    it("returns false when ping throws", async () => {
      await adapter.start();
      mockClientInstance.ping.mockRejectedValueOnce(new Error("offline"));
      expect(await adapter.healthCheck()).toBe(false);
    });
  });

  describe("getInfo()", () => {
    it("returns correct engine type, name, and capabilities", async () => {
      await adapter.start();
      const info = adapter.getInfo();
      expect(info.type).toBe("copilot");
      expect(info.name).toBe("GitHub Copilot");
      expect(info.capabilities.messageEnqueue).toBe(true);
      expect(info.capabilities.slashCommands).toBe(true);
      expect(info.capabilities.imageAttachment).toBe(true);
      expect(info.capabilities.permissionAlways).toBe(true);
    });

    it("includes errorMessage only when status is error", async () => {
      (adapter as any).status = "error";
      (adapter as any).lastError = "boot failed";
      expect(adapter.getInfo().errorMessage).toBe("boot failed");

      (adapter as any).status = "running";
      expect(adapter.getInfo().errorMessage).toBeUndefined();
    });
  });

  describe("hasSession()", () => {
    it("always returns true regardless of session state", () => {
      expect(adapter.hasSession("any-id")).toBe(true);
      expect(adapter.hasSession("unknown-id")).toBe(true);
    });
  });

  // ============================================================================
  // B. Session Management
  // ============================================================================

  describe("createSession()", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("creates a session and emits session.created", async () => {
      const created: any[] = [];
      adapter.on("session.created", (e) => created.push(e));

      const session = await adapter.createSession("/repo");

      expect(session.engineType).toBe("copilot");
      expect(session.directory).toBe("/repo");
      expect(created).toHaveLength(1);
      expect(created[0].session.directory).toBe("/repo");
    });

    it("normalises Windows-style directory separators in the returned session", async () => {
      mockClientInstance.createSession.mockResolvedValueOnce({
        ...mockSessionBase,
        sessionId: "sess-win",
      });
      const session = await adapter.createSession("C:\\Users\\repo");
      expect(session.directory).toBe("C:/Users/repo");
    });

    it("injects CODEMUX_IDENTITY_PROMPT as appended system message", async () => {
      await adapter.createSession("/repo");
      expect(mockClientInstance.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          systemMessage: expect.objectContaining({ mode: "append" }),
        }),
      );
    });

    it("subscribes to session events after creation", async () => {
      const newSess = { ...mockSessionBase, sessionId: "s-new", on: vi.fn(() => vi.fn()) };
      mockClientInstance.createSession.mockResolvedValueOnce(newSess);

      await adapter.createSession("/repo");

      expect(newSess.on).toHaveBeenCalledTimes(1);
    });

    it("fetches initial skills to populate cachedCommands before returning", async () => {
      const fetchSpy = vi.spyOn(adapter as any, "fetchSkills").mockResolvedValue(undefined);
      await adapter.createSession("/repo");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("stores the session in activeSessions and sessionModes maps", async () => {
      const newSess = { ...mockSessionBase, sessionId: "stored-1" };
      mockClientInstance.createSession.mockResolvedValueOnce(newSess);

      await adapter.createSession("/repo");

      expect((adapter as any).activeSessions.has("stored-1")).toBe(true);
      expect((adapter as any).sessionModes.get("stored-1")).toBe("autopilot");
    });
  });

  describe("deleteSession()", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("unsubscribes, disconnects, and removes session from all maps", async () => {
      const sess = makeMockSession("s1");
      const unsub = vi.fn();
      (adapter as any).activeSessions.set("s1", sess);
      (adapter as any).sessionUnsubscribers.set("s1", unsub);
      (adapter as any).sessionModes.set("s1", "autopilot");
      (adapter as any).sessionDirectories.set("s1", "/repo");
      (adapter as any).sessionTodos.set("s1", new Map());
      (adapter as any).messageHistory.set("s1", []);
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1"));

      await adapter.deleteSession("s1");

      expect(unsub).toHaveBeenCalledTimes(1);
      expect(sess.disconnect).toHaveBeenCalledTimes(1);
      expect((adapter as any).activeSessions.has("s1")).toBe(false);
      expect((adapter as any).sessionModes.has("s1")).toBe(false);
      expect((adapter as any).sessionDirectories.has("s1")).toBe(false);
      expect((adapter as any).sessionTodos.has("s1")).toBe(false);
      expect((adapter as any).messageHistory.has("s1")).toBe(false);
      expect((adapter as any).messageBuffers.has("s1")).toBe(false);
    });

    it("calls client.deleteSession even when the session is not active in memory", async () => {
      await adapter.deleteSession("ghost-session");
      expect(mockClientInstance.deleteSession).toHaveBeenCalledWith("ghost-session");
    });
  });

  describe("ensureActiveSession()", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("returns existing session without calling resumeSession", async () => {
      const existing = makeMockSession("s1");
      (adapter as any).activeSessions.set("s1", existing);

      const result = await (adapter as any).ensureActiveSession("s1");

      expect(result).toBe(existing);
      expect(mockClientInstance.resumeSession).not.toHaveBeenCalled();
    });

    it("resumes session from SDK when not in activeSessions", async () => {
      const resumed = { ...mockSessionBase, sessionId: "s1" };
      mockClientInstance.resumeSession.mockResolvedValueOnce(resumed);

      const result = await (adapter as any).ensureActiveSession("s1", "/repo");

      expect(mockClientInstance.resumeSession).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ workingDirectory: "/repo", streaming: true }),
      );
      expect(result).toBe(resumed);
      expect((adapter as any).activeSessions.has("s1")).toBe(true);
    });

    it("falls back to createSession when resume returns a 'not found' error", async () => {
      mockClientInstance.resumeSession.mockRejectedValueOnce(new Error("Session not found"));
      const created = { ...mockSessionBase, sessionId: "s-new" };
      mockClientInstance.createSession.mockResolvedValueOnce(created);

      const result = await (adapter as any).ensureActiveSession("s1", "/repo");

      expect(mockClientInstance.createSession).toHaveBeenCalledTimes(1);
      expect(result).toBe(created);
    });

    it("re-throws errors that are not 'not found'", async () => {
      mockClientInstance.resumeSession.mockRejectedValueOnce(new Error("network error"));

      await expect((adapter as any).ensureActiveSession("s1", "/repo")).rejects.toThrow("network error");
    });

    it("evicts all cached sessions when client state is not 'connected'", async () => {
      mockClientInstance.getState.mockReturnValueOnce("disconnected");
      const evictSpy = vi.spyOn(adapter as any, "evictAllSessions");
      (adapter as any).activeSessions.set("s1", makeMockSession("s1"));

      await (adapter as any).ensureActiveSession("s1", "/repo");

      expect(evictSpy).toHaveBeenCalledTimes(1);
    });

    it("includes reasoning effort in the resume config when set", async () => {
      (adapter as any).sessionReasoningEfforts.set("s1", "max");
      (adapter as any).currentModelId = "gpt-4o";

      await (adapter as any).ensureActiveSession("s1", "/repo");

      expect(mockClientInstance.resumeSession).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ reasoningEffort: "xhigh" }),
      );
    });
  });

  describe("evictStaleSession()", () => {
    it("removes session from activeSessions, calls unsub, removes from sessionUnsubscribers", () => {
      const unsub = vi.fn();
      (adapter as any).activeSessions.set("s1", makeMockSession("s1"));
      (adapter as any).sessionUnsubscribers.set("s1", unsub);

      (adapter as any).evictStaleSession("s1");

      expect((adapter as any).activeSessions.has("s1")).toBe(false);
      expect(unsub).toHaveBeenCalledTimes(1);
      expect((adapter as any).sessionUnsubscribers.has("s1")).toBe(false);
    });

    it("is safe when session has no subscriber", () => {
      (adapter as any).activeSessions.set("s1", makeMockSession("s1"));

      expect(() => (adapter as any).evictStaleSession("s1")).not.toThrow();
      expect((adapter as any).activeSessions.has("s1")).toBe(false);
    });
  });

  // ============================================================================
  // C. Message Flow
  // ============================================================================

  describe("sendMessage()", () => {
    let sess: ReturnType<typeof makeMockSession>;

    beforeEach(async () => {
      await adapter.start();
      sess = makeMockSession("s1");
      (adapter as any).activeSessions.set("s1", sess);
      (adapter as any).sessionDirectories.set("s1", "/repo");
    });

    it("normal path: creates buffer, emits user message, resolves to assistant message on idle", async () => {
      const updates: any[] = [];
      adapter.on("message.updated", (e) => updates.push(e));

      const sendPromise = adapter.sendMessage("s1", [{ type: "text", text: "hello" }]);
      await flushMicrotasks();

      // Simulate session going idle
      (adapter as any).handleSessionIdle("s1");
      const msg = await sendPromise;

      expect(msg.role).toBe("assistant");
      expect(msg.sessionId).toBe("s1");

      const userUpdate = updates.find((u) => u.message?.role === "user");
      expect(userUpdate?.message.parts[0].text).toBe("hello");
    });

    it("queue path: emits message.queued when idleResolvers already exist", async () => {
      const queued: any[] = [];
      adapter.on("message.queued", (e) => queued.push(e));

      // Seed one existing resolver to mark session as busy
      (adapter as any).idleResolvers.set("s1", [vi.fn()]);

      const sendPromise = adapter.sendMessage("s1", [{ type: "text", text: "enqueued msg" }]);
      await flushMicrotasks();

      expect(queued).toHaveLength(1);
      expect(queued[0].sessionId).toBe("s1");
      expect(queued[0].queuePosition).toBe(1);

      // Cleanup – avoid dangling promise
      (adapter as any).idleResolvers.delete("s1");
      (adapter as any).pendingUserMessages.delete("s1");
      sendPromise.catch(() => {}); // swallow rejection
    });

    it("writes a temp file for each image attachment", async () => {
      mkdtempSyncMock.mockReturnValue("/tmp/codemux-img-test");

      const sendPromise = adapter.sendMessage("s1", [
        { type: "image", data: Buffer.from("img").toString("base64"), mimeType: "image/png" },
      ]);
      await flushMicrotasks();
      (adapter as any).handleSessionIdle("s1");
      await sendPromise;

      expect(mkdtempSyncMock).toHaveBeenCalledTimes(1);
      expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    });

    it("uses placeholder text when only an image is sent", async () => {
      mkdtempSyncMock.mockReturnValue("/tmp/codemux-img-test");

      const sendPromise = adapter.sendMessage("s1", [
        { type: "image", data: Buffer.from("img").toString("base64"), mimeType: "image/png" },
      ]);
      await flushMicrotasks();
      (adapter as any).handleSessionIdle("s1");
      await sendPromise;

      expect(sess.send).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "Describe this image." }),
      );
    });

    it("switches model when modelId changes between calls", async () => {
      (adapter as any).currentModelId = "old-model";

      const sendPromise = adapter.sendMessage(
        "s1",
        [{ type: "text", text: "hi" }],
        { modelId: "new-model" },
      );
      await flushMicrotasks();
      (adapter as any).handleSessionIdle("s1");
      await sendPromise;

      expect(sess.rpc.model.switchTo).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: "new-model" }),
      );
    });

    it("sets the session mode via rpc when mode changes", async () => {
      (adapter as any).sessionModes.set("s1", "autopilot");

      const sendPromise = adapter.sendMessage(
        "s1",
        [{ type: "text", text: "hi" }],
        { mode: "plan" },
      );
      await flushMicrotasks();
      (adapter as any).handleSessionIdle("s1");
      await sendPromise;

      expect(sess.rpc.mode.set).toHaveBeenCalledWith({ mode: "plan" });
    });

    it("updates reasoning effort and switches model config when effort changes", async () => {
      (adapter as any).currentModelId = "gpt-4o";

      const sendPromise = adapter.sendMessage(
        "s1",
        [{ type: "text", text: "hi" }],
        { reasoningEffort: "max" },
      );
      await flushMicrotasks();
      (adapter as any).handleSessionIdle("s1");
      await sendPromise;

      expect((adapter as any).sessionReasoningEfforts.get("s1")).toBe("max");
      expect(sess.rpc.model.switchTo).toHaveBeenCalledWith({ modelId: "gpt-4o", reasoningEffort: "xhigh" });
    });

    it("clears reasoning effort when null is passed", async () => {
      (adapter as any).currentModelId = "gpt-4o";
      (adapter as any).sessionReasoningEfforts.set("s1", "high");

      const sendPromise = adapter.sendMessage(
        "s1",
        [{ type: "text", text: "hi" }],
        { reasoningEffort: null },
      );
      await flushMicrotasks();
      (adapter as any).handleSessionIdle("s1");
      await sendPromise;

      expect((adapter as any).sessionReasoningEfforts.has("s1")).toBe(false);
    });
  });

  describe("cancelMessage()", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("aborts the active SDK session", async () => {
      const sess = makeMockSession("s1");
      (adapter as any).activeSessions.set("s1", sess);

      await adapter.cancelMessage("s1");

      expect(sess.abort).toHaveBeenCalledTimes(1);
    });

    it("resolves pending permissions for the session with reject", async () => {
      const sess = makeMockSession("s1");
      (adapter as any).activeSessions.set("s1", sess);
      const resolve = vi.fn();
      (adapter as any).pendingPermissions.set("p1", {
        resolve,
        permission: { id: "p1", sessionId: "s1" },
      });

      await adapter.cancelMessage("s1");

      expect(resolve).toHaveBeenCalledWith({ kind: "reject" });
      expect((adapter as any).pendingPermissions.has("p1")).toBe(false);
    });

    it("resolves pending questions for the session with empty answer", async () => {
      const sess = makeMockSession("s1");
      (adapter as any).activeSessions.set("s1", sess);
      const resolve = vi.fn();
      (adapter as any).pendingQuestions.set("q1", {
        resolve,
        question: { id: "q1", sessionId: "s1" },
      });

      await adapter.cancelMessage("s1");

      expect(resolve).toHaveBeenCalledWith({ answer: "", wasFreeform: false });
    });

    it("marks buffer with Cancelled error and resolves idle resolvers", async () => {
      const sess = makeMockSession("s1");
      (adapter as any).activeSessions.set("s1", sess);
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1", { textAccumulator: "partial" }));
      const resolver = vi.fn();
      (adapter as any).idleResolvers.set("s1", [resolver]);

      await adapter.cancelMessage("s1");

      expect(resolver).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Cancelled" }),
      );
      expect((adapter as any).idleResolvers.has("s1")).toBe(false);
    });

    it("is a no-op when no active session exists", async () => {
      await expect(adapter.cancelMessage("non-existent")).resolves.toBeUndefined();
    });
  });

  // ============================================================================
  // D. Event Handling
  // ============================================================================

  describe("handleSessionEvent() routing", () => {
    it("routes each known event type to the correct handler", () => {
      const handlers = {
        handleMessageDelta: vi.spyOn(adapter as any, "handleMessageDelta").mockImplementation(() => {}),
        handleAssistantMessage: vi.spyOn(adapter as any, "handleAssistantMessage").mockImplementation(() => {}),
        handleToolStart: vi.spyOn(adapter as any, "handleToolStart").mockImplementation(() => {}),
        handleToolComplete: vi.spyOn(adapter as any, "handleToolComplete").mockImplementation(() => {}),
        handleSessionIdle: vi.spyOn(adapter as any, "handleSessionIdle").mockImplementation(() => {}),
        handleTitleChanged: vi.spyOn(adapter as any, "handleTitleChanged").mockImplementation(() => {}),
        handleSessionError: vi.spyOn(adapter as any, "handleSessionError").mockImplementation(() => {}),
        handleModelChange: vi.spyOn(adapter as any, "handleModelChange").mockImplementation(() => {}),
        handleModeChanged: vi.spyOn(adapter as any, "handleModeChanged").mockImplementation(() => {}),
        handleUsage: vi.spyOn(adapter as any, "handleUsage").mockImplementation(() => {}),
        handleAbort: vi.spyOn(adapter as any, "handleAbort").mockImplementation(() => {}),
      };

      const eventTypes = [
        ["assistant.message_delta", handlers.handleMessageDelta],
        ["assistant.message", handlers.handleAssistantMessage],
        ["tool.execution_start", handlers.handleToolStart],
        ["tool.execution_complete", handlers.handleToolComplete],
        ["session.idle", handlers.handleSessionIdle],
        ["session.title_changed", handlers.handleTitleChanged],
        ["session.error", handlers.handleSessionError],
        ["session.model_change", handlers.handleModelChange],
        ["session.mode_changed", handlers.handleModeChanged],
        ["assistant.usage", handlers.handleUsage],
        ["abort", handlers.handleAbort],
      ] as const;

      for (const [type, handler] of eventTypes) {
        (adapter as any).handleSessionEvent("s1", { type, data: {} });
        expect(handler).toHaveBeenCalledTimes(1);
      }
    });

    it("does not throw on unknown event type", () => {
      expect(() => {
        (adapter as any).handleSessionEvent("s1", { type: "totally.unknown", data: {} });
      }).not.toThrow();
    });
  });

  describe("handleMessageDelta()", () => {
    it("accumulates text and emits message.part.updated", () => {
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1"));

      (adapter as any).handleMessageDelta("s1", { deltaContent: "Hello " });
      (adapter as any).handleMessageDelta("s1", { deltaContent: "world" });

      const buf = (adapter as any).messageBuffers.get("s1");
      expect(buf.textAccumulator).toBe("Hello world");
      expect(partUpdates).toHaveLength(2);
      expect(partUpdates[1].part.text).toBe("Hello world");
      expect(partUpdates[1].part.type).toBe("text");
    });

    it("suppresses emission until non-whitespace content arrives (leading trim)", () => {
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1"));

      (adapter as any).handleMessageDelta("s1", { deltaContent: "\n\n  " });
      expect(partUpdates).toHaveLength(0);

      (adapter as any).handleMessageDelta("s1", { deltaContent: "actual content" });
      expect(partUpdates).toHaveLength(1);
      expect(partUpdates[0].part.text).toBe("actual content");
    });

    it("creates a new buffer if none exists for the session", () => {
      (adapter as any).handleMessageDelta("s1", { deltaContent: "text" });
      expect((adapter as any).messageBuffers.has("s1")).toBe(true);
    });

    it("only trims once: subsequent deltas starting with whitespace are kept", () => {
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1"));

      (adapter as any).handleMessageDelta("s1", { deltaContent: "first" });
      (adapter as any).handleMessageDelta("s1", { deltaContent: "\n  more" });

      const buf = (adapter as any).messageBuffers.get("s1");
      expect(buf.textAccumulator).toBe("first\n  more");
    });
  });

  describe("handleAssistantMessage()", () => {
    it("is a no-op when a buffer already exists (streaming takes precedence)", () => {
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1", {
        textAccumulator: "streaming",
        textPartId: "p1",
      }));

      (adapter as any).handleAssistantMessage("s1", { content: "non-streaming" });

      expect(partUpdates).toHaveLength(0);
    });

    it("creates a buffer and sets content when no buffer exists", () => {
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      (adapter as any).handleAssistantMessage("s1", { content: "non-streaming message" });

      const buf = (adapter as any).messageBuffers.get("s1");
      expect(buf).toBeDefined();
      expect(buf.textAccumulator).toBe("non-streaming message");
      expect(partUpdates).toHaveLength(1);
    });
  });

  describe("handleToolStart()", () => {
    it("creates a tool part in the buffer and emits message.part.updated", () => {
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1"));

      (adapter as any).handleToolStart("s1", {
        toolCallId: "t1",
        toolName: "bash",
        arguments: { command: "ls -la" },
      });

      const buf = (adapter as any).messageBuffers.get("s1");
      expect(buf.parts).toHaveLength(1);
      expect(buf.parts[0].type).toBe("tool");
      expect(buf.parts[0].state.status).toBe("running");
      expect(partUpdates).toHaveLength(1);
    });

    it("extracts task_complete summary as text, skips tool part creation", () => {
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1"));

      (adapter as any).handleToolStart("s1", {
        toolCallId: "tc-1",
        toolName: "task_complete",
        arguments: { summary: "All done!" },
      });

      const buf = (adapter as any).messageBuffers.get("s1");
      expect(buf.textAccumulator).toBe("All done!");
      expect(buf.parts.filter((p: any) => p.type === "tool")).toHaveLength(0);
      expect((adapter as any).taskCompleteCallIds.has("tc-1")).toBe(true);
    });

    it("handles sql tool with todos query via applySqlTodoChanges", () => {
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1"));
      const applySpy = vi.spyOn(adapter as any, "applySqlTodoChanges");

      (adapter as any).handleToolStart("s1", {
        toolCallId: "sql-1",
        toolName: "sql",
        arguments: { query: "INSERT INTO todos (id,title,status) VALUES ('t1','fix','pending')" },
      });

      expect(applySpy).toHaveBeenCalledTimes(1);
    });

    it("flushes any accumulated text before creating a tool part", () => {
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1", {
        textAccumulator: "some text",
        textPartId: "p-existing",
      }));

      (adapter as any).handleToolStart("s1", {
        toolCallId: "t1",
        toolName: "bash",
        arguments: { command: "echo hi" },
      });

      const buf = (adapter as any).messageBuffers.get("s1");
      // Text was flushed into parts as a text part
      const textPart = buf.parts.find((p: any) => p.type === "text");
      expect(textPart?.text).toBe("some text");
    });
  });

  describe("handleToolComplete()", () => {
    it("marks the matching tool part as completed", () => {
      const toolPart: any = {
        id: "p1", messageId: "msg-1", sessionId: "s1", type: "tool", callId: "t1",
        state: { status: "running", input: {}, time: { start: Date.now() - 100 } },
      };
      (adapter as any).toolCallParts.set("t1", toolPart);
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1", { parts: [toolPart] }));

      (adapter as any).handleToolComplete("s1", {
        toolCallId: "t1",
        success: true,
        result: { content: "output text" },
      });

      expect(toolPart.state.status).toBe("completed");
      expect(toolPart.state.output).toBe("output text");
      expect((adapter as any).toolCallParts.has("t1")).toBe(false);
    });

    it("marks the tool part as error when success is false", () => {
      const toolPart: any = {
        id: "p2", messageId: "msg-1", sessionId: "s1", type: "tool", callId: "t2",
        state: { status: "running", input: {}, time: { start: Date.now() } },
      };
      (adapter as any).toolCallParts.set("t2", toolPart);
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1", { parts: [toolPart] }));

      (adapter as any).handleToolComplete("s1", {
        toolCallId: "t2",
        success: false,
        error: { message: "Permission denied" },
      });

      expect(toolPart.state.status).toBe("error");
      expect(toolPart.state.error).toBe("Permission denied");
    });

    it("ignores task_complete call ids (marks them as deleted, no part update)", () => {
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));
      (adapter as any).taskCompleteCallIds.add("tc-1");

      (adapter as any).handleToolComplete("s1", { toolCallId: "tc-1", success: true });

      expect(partUpdates).toHaveLength(0);
      expect((adapter as any).taskCompleteCallIds.has("tc-1")).toBe(false);
    });

    it("attaches detailedContent as diff property when present", () => {
      const toolPart: any = {
        id: "p3", messageId: "msg-1", sessionId: "s1", type: "tool", callId: "t3",
        state: { status: "running", input: {}, time: { start: Date.now() } },
      };
      (adapter as any).toolCallParts.set("t3", toolPart);
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1", { parts: [toolPart] }));

      (adapter as any).handleToolComplete("s1", {
        toolCallId: "t3",
        success: true,
        result: { content: "", detailedContent: "@@ diff @@" },
      });

      expect(toolPart.diff).toBe("@@ diff @@");
    });
  });

  describe("handleSessionIdle()", () => {
    it("finalizes buffer, resolves all idle resolvers, and cleans up", () => {
      const updates: any[] = [];
      adapter.on("message.updated", (e) => updates.push(e));
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1", {
        textAccumulator: "final answer",
        textPartId: "p1",
      }));
      const resolver = vi.fn();
      (adapter as any).idleResolvers.set("s1", [resolver]);

      (adapter as any).handleSessionIdle("s1");

      expect(resolver).toHaveBeenCalledTimes(1);
      expect(resolver.mock.calls[0][0].role).toBe("assistant");
      expect((adapter as any).idleResolvers.has("s1")).toBe(false);
      expect((adapter as any).messageBuffers.has("s1")).toBe(false);
      expect(updates.some((u) => u.message.role === "assistant")).toBe(true);
    });

    it("emits deferred user messages and message.queued.consumed for each queued item", () => {
      const updates: any[] = [];
      const consumed: any[] = [];
      adapter.on("message.updated", (e) => updates.push(e));
      adapter.on("message.queued.consumed", (e) => consumed.push(e));
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1"));
      const resolver = vi.fn();
      (adapter as any).idleResolvers.set("s1", [resolver]);
      const userMsg = { id: "user-msg-1", role: "user", sessionId: "s1", parts: [] };
      (adapter as any).pendingUserMessages.set("s1", [userMsg]);

      (adapter as any).handleSessionIdle("s1");

      expect(consumed).toHaveLength(1);
      expect(consumed[0].messageId).toBe("user-msg-1");
      const userUpdate = updates.find((u) => u.message?.role === "user");
      expect(userUpdate).toBeDefined();
      expect((adapter as any).pendingUserMessages.has("s1")).toBe(false);
    });

    it("resolves multiple idle resolvers with the same final message", () => {
      const r1 = vi.fn();
      const r2 = vi.fn();
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1"));
      (adapter as any).idleResolvers.set("s1", [r1, r2]);

      (adapter as any).handleSessionIdle("s1");

      expect(r1).toHaveBeenCalledTimes(1);
      expect(r2).toHaveBeenCalledTimes(1);
      expect(r1.mock.calls[0][0]).toEqual(r2.mock.calls[0][0]);
    });
  });

  // ============================================================================
  // E. Permission Handling
  // ============================================================================

  describe("handlePermissionRequest()", () => {
    it("auto-approves in autopilot mode without emitting", async () => {
      const permEvents: any[] = [];
      adapter.on("permission.asked", (e) => permEvents.push(e));
      (adapter as any).sessionModes.set("s1", "autopilot");

      const result = await (adapter as any).handlePermissionRequest(
        { kind: "write", toolCallId: "t1" },
        { sessionId: "s1" },
      );

      expect(result).toEqual({ kind: "approve-once" });
      expect(permEvents).toHaveLength(0);
    });

    it("auto-approves for kinds in allowedAlwaysKinds", async () => {
      (adapter as any).sessionModes.set("s1", "interactive");
      (adapter as any).allowedAlwaysKinds.set("s1", new Set(["read"]));

      const result = await (adapter as any).handlePermissionRequest(
        { kind: "read", toolCallId: "t1" },
        { sessionId: "s1" },
      );

      expect(result).toEqual({ kind: "approve-once" });
    });

    it("emits permission.asked in non-autopilot mode and waits for reply", async () => {
      const permEvents: any[] = [];
      adapter.on("permission.asked", (e) => permEvents.push(e));
      (adapter as any).sessionModes.set("s1", "interactive");

      const requestPromise = (adapter as any).handlePermissionRequest(
        { kind: "write", toolCallId: "t1", title: "Write to file" },
        { sessionId: "s1" },
      );
      await Promise.resolve();

      expect(permEvents).toHaveLength(1);
      const perm = permEvents[0].permission;
      expect(perm.kind).toBe("edit"); // "write" maps to "edit"
      expect(perm.options).toHaveLength(3);
      expect(perm.options.map((o: any) => o.id)).toEqual(["allow_once", "allow_always", "reject_once"]);

      const pending = (adapter as any).pendingPermissions.get(perm.id);
      pending.resolve({ kind: "approve-once" });

      await expect(requestPromise).resolves.toEqual({ kind: "approve-once" });
    });

    it("uses PermissionPromptRequest details from permission.requested events", async () => {
      const permEvents: any[] = [];
      adapter.on("permission.asked", (e) => permEvents.push(e));
      (adapter as any).sessionModes.set("s1", "interactive");

      const requestPromise = (adapter as any).handlePermissionRequest(
        { kind: "write", toolCallId: "tool-write-1" },
        { sessionId: "s1" },
      );
      (adapter as any).handleSessionEvent("s1", {
        type: "permission.requested",
        data: {
          requestId: "permission-request-1",
          permissionRequest: { kind: "write", toolCallId: "tool-write-1" },
          promptRequest: {
            canOfferSessionApproval: true,
            diff: "@@ -1 +1 @@\n-old\n+new",
            fileName: "src/app.ts",
            intention: "Update the app entry point",
            kind: "write",
            toolCallId: "tool-write-1",
          },
        },
      });
      await Promise.resolve();

      expect(permEvents).toHaveLength(1);
      const perm = permEvents[0].permission;
      expect(perm.title).toBe("Update the app entry point");
      expect(perm.kind).toBe("edit");
      expect(perm.toolName).toBe("edit");
      expect(perm.diff).toBe("@@ -1 +1 @@\n-old\n+new");
      expect(perm.details).toEqual([{ label: "File", value: "src/app.ts", mono: true }]);
      expect(perm.options.map((o: any) => o.id)).toEqual(["allow_once", "allow_always", "reject_once"]);

      await adapter.replyPermission(perm.id, { optionId: "allow_always" });
      await expect(requestPromise).resolves.toEqual({
        kind: "approve-for-session",
        approval: { kind: "write" },
      });
    });

    it("omits allow_always when promptRequest cannot offer session approval", async () => {
      const permEvents: any[] = [];
      adapter.on("permission.asked", (e) => permEvents.push(e));
      (adapter as any).sessionModes.set("s1", "interactive");

      const requestPromise = (adapter as any).handlePermissionRequest(
        { kind: "read", toolCallId: "tool-read-1" },
        { sessionId: "s1" },
      );
      (adapter as any).handleSessionEvent("s1", {
        type: "permission.requested",
        data: {
          requestId: "permission-request-2",
          permissionRequest: { kind: "read", toolCallId: "tool-read-1" },
          promptRequest: {
            intention: "Inspect package metadata",
            kind: "read",
            path: "package.json",
            toolCallId: "tool-read-1",
          },
        },
      });
      await Promise.resolve();

      const perm = permEvents[0].permission;
      expect(perm.title).toBe("Inspect package metadata");
      expect(perm.kind).toBe("read");
      expect(perm.details).toEqual([{ label: "Path", value: "package.json", mono: true }]);
      expect(perm.options.map((o: any) => o.id)).toEqual(["allow_once", "reject_once"]);

      const pending = (adapter as any).pendingPermissions.get(perm.id);
      pending.resolve({ kind: "approve-once" });
      await expect(requestPromise).resolves.toEqual({ kind: "approve-once" });
    });

    it("maps 'read' kind to 'read', 'shell' to 'edit', unknown to 'other'", async () => {
      const permEvents: any[] = [];
      adapter.on("permission.asked", (e) => permEvents.push(e));
      (adapter as any).sessionModes.set("s1", "interactive");

      for (const [kind, expected] of [["read", "read"], ["shell", "edit"], ["unknown", "other"]] as const) {
        (adapter as any).handlePermissionRequest({ kind, toolCallId: `t-${kind}` }, { sessionId: "s1" });
      }
      await Promise.resolve();

      expect(permEvents[0].permission.kind).toBe("read");
      expect(permEvents[1].permission.kind).toBe("edit");
      expect(permEvents[2].permission.kind).toBe("other");
    });
  });

  describe("replyPermission()", () => {
    it("resolves with approve-once for allow_once", async () => {
      const resolve = vi.fn();
      (adapter as any).pendingPermissions.set("p1", {
        resolve,
        permission: { id: "p1", sessionId: "s1" },
        sdkKind: "write",
      });

      await adapter.replyPermission("p1", { optionId: "allow_once" });

      expect(resolve).toHaveBeenCalledWith({ kind: "approve-once" });
      expect((adapter as any).pendingPermissions.has("p1")).toBe(false);
    });

    it("resolves with approve-once AND persists kind to allowedAlwaysKinds for fallback allow_always", async () => {
      const resolve = vi.fn();
      (adapter as any).pendingPermissions.set("p1", {
        resolve,
        permission: { id: "p1", sessionId: "s1" },
        sdkKind: "shell",
      });

      await adapter.replyPermission("p1", { optionId: "allow_always" });

      expect(resolve).toHaveBeenCalledWith({ kind: "approve-once" });
      expect((adapter as any).allowedAlwaysKinds.get("s1")?.has("shell")).toBe(true);
    });

    it("resolves with reject for reject_once", async () => {
      const resolve = vi.fn();
      (adapter as any).pendingPermissions.set("p1", {
        resolve,
        permission: { id: "p1", sessionId: "s1" },
        sdkKind: "write",
      });

      await adapter.replyPermission("p1", { optionId: "reject_once" });

      expect(resolve).toHaveBeenCalledWith({ kind: "reject" });
    });

    it("emits permission.replied with the correct optionId", async () => {
      const replied: any[] = [];
      adapter.on("permission.replied", (e) => replied.push(e));
      const resolve = vi.fn();
      (adapter as any).pendingPermissions.set("p1", {
        resolve,
        permission: { id: "p1", sessionId: "s1" },
        sdkKind: "write",
      });

      await adapter.replyPermission("p1", { optionId: "allow_once" });

      expect(replied).toHaveLength(1);
      expect(replied[0]).toEqual({ permissionId: "p1", optionId: "allow_once" });
    });

    it("is a no-op when permissionId is unknown", async () => {
      await expect(adapter.replyPermission("unknown", { optionId: "allow_once" })).resolves.toBeUndefined();
    });
  });

  describe("handleUserInputRequest()", () => {
    it("emits question.asked and resolves when answered", async () => {
      const questions: any[] = [];
      adapter.on("question.asked", (e) => questions.push(e));

      const requestPromise = (adapter as any).handleUserInputRequest(
        { question: "Pick env", choices: ["prod", "staging"], allowFreeform: false },
        { sessionId: "s1" },
      );

      expect(questions).toHaveLength(1);
      const q = questions[0].question;
      expect(q.questions[0].question).toBe("Pick env");
      expect(q.questions[0].options).toHaveLength(2);
      expect(q.questions[0].custom).toBe(false);

      (adapter as any).pendingQuestions.get(q.id).resolve({ answer: "prod", wasFreeform: false });

      const result = await requestPromise;
      expect(result.answer).toBe("prod");
    });

    it("truncates long question text to a 30-character header with ellipsis", () => {
      const questions: any[] = [];
      adapter.on("question.asked", (e) => questions.push(e));

      (adapter as any).handleUserInputRequest(
        { question: "This is a very long question that exceeds thirty characters" },
        { sessionId: "s1" },
      );

      const header = questions[0].question.questions[0].header;
      expect(header.length).toBeLessThanOrEqual(30);
      expect(header.endsWith("...")).toBe(true);
    });

    it("uses the full question text as header when ≤30 chars", () => {
      const questions: any[] = [];
      adapter.on("question.asked", (e) => questions.push(e));

      (adapter as any).handleUserInputRequest(
        { question: "Short question" },
        { sessionId: "s1" },
      );

      expect(questions[0].question.questions[0].header).toBe("Short question");
    });
  });

  // ============================================================================
  // F. Todo SQL Parsing
  // ============================================================================

  describe("applySqlTodoChanges()", () => {
    it("parses INSERT INTO todos and stores todo entries", () => {
      (adapter as any).applySqlTodoChanges(
        "s1",
        `INSERT INTO todos (id, title, status) VALUES ('t1', 'Fix bug', 'pending'), ('t2', 'Write tests', 'in_progress');`,
      );

      const todos = (adapter as any).sessionTodos.get("s1");
      expect(todos.size).toBe(2);
      expect(todos.get("t1")).toEqual({ id: "t1", title: "Fix bug", status: "pending" });
      expect(todos.get("t2")).toEqual({ id: "t2", title: "Write tests", status: "in_progress" });
    });

    it("parses UPDATE todos SET status WHERE id = ... ", () => {
      (adapter as any).sessionTodos.set("s1", new Map([
        ["t1", { id: "t1", title: "Fix bug", status: "pending" }],
      ]));

      (adapter as any).applySqlTodoChanges("s1", `UPDATE todos SET status = 'done' WHERE id = 't1'`);

      expect((adapter as any).sessionTodos.get("s1").get("t1").status).toBe("done");
    });

    it("parses UPDATE todos SET status WHERE id IN (...)", () => {
      (adapter as any).sessionTodos.set("s1", new Map([
        ["t1", { id: "t1", title: "A", status: "pending" }],
        ["t2", { id: "t2", title: "B", status: "pending" }],
      ]));

      (adapter as any).applySqlTodoChanges("s1", `UPDATE todos SET status = 'completed' WHERE id IN ('t1', 't2')`);

      const todos = (adapter as any).sessionTodos.get("s1");
      expect(todos.get("t1").status).toBe("completed");
      expect(todos.get("t2").status).toBe("completed");
    });

    it("updates ALL todos when UPDATE has no WHERE clause", () => {
      (adapter as any).sessionTodos.set("s1", new Map([
        ["t1", { id: "t1", title: "A", status: "pending" }],
        ["t2", { id: "t2", title: "B", status: "in_progress" }],
      ]));

      (adapter as any).applySqlTodoChanges("s1", `UPDATE todos SET status = 'done'`);

      const todos = (adapter as any).sessionTodos.get("s1");
      for (const t of todos.values()) expect(t.status).toBe("done");
    });

    it("initializes the todos map for a new session", () => {
      (adapter as any).applySqlTodoChanges(
        "new-s",
        `INSERT INTO todos (id, title, status) VALUES ('t1', 'Task', 'pending')`,
      );
      expect((adapter as any).sessionTodos.has("new-s")).toBe(true);
    });
  });

  describe("getTodosArray()", () => {
    it("returns empty array when session has no todos", () => {
      expect((adapter as any).getTodosArray("s1")).toEqual([]);
    });

    it("maps 'done' status to 'completed'", () => {
      (adapter as any).sessionTodos.set("s1", new Map([
        ["t1", { id: "t1", title: "Fix bug", status: "done" }],
        ["t2", { id: "t2", title: "Write test", status: "in_progress" }],
        ["t3", { id: "t3", title: "Deploy", status: "pending" }],
      ]));

      const result = (adapter as any).getTodosArray("s1");
      expect(result).toEqual([
        { content: "Fix bug", status: "completed" },
        { content: "Write test", status: "in_progress" },
        { content: "Deploy", status: "pending" },
      ]);
    });
  });

  describe("emitTodoPart()", () => {
    it("emits message.part.updated with a todo tool part", () => {
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));
      (adapter as any).sessionTodos.set("s1", new Map([
        ["t1", { id: "t1", title: "Fix bug", status: "pending" }],
      ]));
      const buffer = makeBuffer("s1");

      (adapter as any).emitTodoPart("s1", buffer, "sql-1", "running");

      expect(partUpdates).toHaveLength(1);
      expect(partUpdates[0].part.normalizedTool).toBe("todo");
      expect(partUpdates[0].part.state.status).toBe("running");
      expect(partUpdates[0].part.state.input.todos[0].content).toBe("Fix bug");
    });

    it("does not emit when todos array is empty", () => {
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      (adapter as any).emitTodoPart("s1", makeBuffer("s1"), "sql-1", "running");

      expect(partUpdates).toHaveLength(0);
    });

    it("updates existing todo part in place on subsequent calls", () => {
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));
      (adapter as any).sessionTodos.set("s1", new Map([
        ["t1", { id: "t1", title: "Fix bug", status: "pending" }],
      ]));
      const buffer = makeBuffer("s1");

      (adapter as any).emitTodoPart("s1", buffer, "sql-1", "running");
      (adapter as any).emitTodoPart("s1", buffer, "sql-1", "completed");

      expect(buffer.parts).toHaveLength(1);
      expect(buffer.parts[0].state.status).toBe("completed");
    });
  });

  // ============================================================================
  // G. Buffer Management
  // ============================================================================

  describe("getOrCreateBuffer()", () => {
    it("creates a new buffer with correct defaults when none exists", () => {
      const buf = (adapter as any).getOrCreateBuffer("s1");
      expect(buf.sessionId).toBe("s1");
      expect(buf.parts).toEqual([]);
      expect(buf.textAccumulator).toBe("");
      expect(buf.textPartId).toBeNull();
      expect((adapter as any).messageBuffers.has("s1")).toBe(true);
    });

    it("returns the existing buffer when one is already set", () => {
      const existing = makeBuffer("s1", { textAccumulator: "existing" });
      (adapter as any).messageBuffers.set("s1", existing);

      expect((adapter as any).getOrCreateBuffer("s1")).toBe(existing);
    });
  });

  describe("flushTextAccumulator()", () => {
    it("moves accumulated text into the parts array and resets accumulators", () => {
      const buffer = makeBuffer("s1", { textAccumulator: "Hello world", textPartId: "p1" });

      (adapter as any).flushTextAccumulator(buffer, "s1");

      expect(buffer.textAccumulator).toBe("");
      expect(buffer.textPartId).toBeNull();
      expect(buffer.parts).toHaveLength(1);
      expect(buffer.parts[0].text).toBe("Hello world");
    });

    it("does nothing when textAccumulator is empty", () => {
      const buffer = makeBuffer("s1");

      (adapter as any).flushTextAccumulator(buffer, "s1");

      expect(buffer.parts).toHaveLength(0);
    });

    it("does nothing when textPartId is null even if text is present", () => {
      const buffer = makeBuffer("s1", { textAccumulator: "orphaned text", textPartId: null });

      (adapter as any).flushTextAccumulator(buffer, "s1");

      expect(buffer.parts).toHaveLength(0);
    });
  });

  describe("finalizeBuffer()", () => {
    it("returns null when no buffer exists", () => {
      expect((adapter as any).finalizeBuffer("non-existent")).toBeNull();
    });

    it("flushes text, emits message.updated, appends to history, removes buffer", () => {
      const updates: any[] = [];
      adapter.on("message.updated", (e) => updates.push(e));
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1", {
        textAccumulator: "final text",
        textPartId: "p1",
      }));

      const msg = (adapter as any).finalizeBuffer("s1");

      expect(msg).not.toBeNull();
      expect(msg.role).toBe("assistant");
      expect((adapter as any).messageBuffers.has("s1")).toBe(false);
      expect(updates).toHaveLength(1);

      const history = (adapter as any).messageHistory.get("s1");
      expect(history).toBeDefined();
      expect(history.some((m: any) => m.id === msg.id)).toBe(true);
    });
  });

  describe("bufferToMessage()", () => {
    it("includes tokens, cost, costUnit, and modelId from buffer", () => {
      const buffer = makeBuffer("s1", {
        tokens: { input: 10, output: 20 },
        cost: 0.5,
        costUnit: "premium_requests",
        modelId: "copilot-gpt-4o",
      });

      const msg = (adapter as any).bufferToMessage(buffer, true);

      expect(msg.tokens).toEqual({ input: 10, output: 20 });
      expect(msg.cost).toBe(0.5);
      expect(msg.costUnit).toBe("premium_requests");
      expect(msg.modelId).toBe("copilot-gpt-4o");
    });

    it("sets completed time only when completed=true", () => {
      const buffer = makeBuffer("s1");

      const incomplete = (adapter as any).bufferToMessage(buffer, false);
      expect(incomplete.time.completed).toBeUndefined();

      const complete = (adapter as any).bufferToMessage(buffer, true);
      expect(complete.time.completed).toBeDefined();
    });

    it("falls back to currentModelId when buffer has no modelId", () => {
      (adapter as any).currentModelId = "fallback-model";
      const msg = (adapter as any).bufferToMessage(makeBuffer("s1"), true);
      expect(msg.modelId).toBe("fallback-model");
    });

    it("includes workingDirectory from sessionDirectories", () => {
      (adapter as any).sessionDirectories.set("s1", "/repo");
      const msg = (adapter as any).bufferToMessage(makeBuffer("s1"), true);
      expect(msg.workingDirectory).toBe("/repo");
    });
  });

  // ============================================================================
  // H. Model & Mode
  // ============================================================================

  describe("toSdkReasoningEffort()", () => {
    it("maps 'max' to 'xhigh'", () => {
      expect((adapter as any).toSdkReasoningEffort("max")).toBe("xhigh");
    });

    it.each([["high", "high"], ["medium", "medium"], ["low", "low"]])(
      "passes '%s' through unchanged",
      (input, expected) => {
        expect((adapter as any).toSdkReasoningEffort(input)).toBe(expected);
      },
    );
  });

  describe("isSessionExpiredError()", () => {
    it.each([
      "Session not found",
      "connection reset",
      "disposed",
      "closed",
      "EPIPE broken",
      "not running",
    ])("returns true for message containing '%s'", (msg) => {
      expect((adapter as any).isSessionExpiredError(new Error(msg))).toBe(true);
    });

    it("returns false for unrelated error messages", () => {
      expect((adapter as any).isSessionExpiredError(new Error("Unknown error"))).toBe(false);
      expect((adapter as any).isSessionExpiredError(new Error("timeout"))).toBe(false);
    });

    it("handles non-Error objects by converting to string", () => {
      expect((adapter as any).isSessionExpiredError("connection lost")).toBe(true);
      expect((adapter as any).isSessionExpiredError("something else")).toBe(false);
    });
  });

  describe("buildModelSwitchConfig()", () => {
    it("includes reasoningEffort in xhigh form when session has 'max' effort", () => {
      (adapter as any).sessionReasoningEfforts.set("s1", "max");
      const config = (adapter as any).buildModelSwitchConfig("s1", "gpt-4o");
      expect(config).toEqual({ modelId: "gpt-4o", reasoningEffort: "xhigh" });
    });

    it("omits reasoningEffort when session has no effort configured", () => {
      const config = (adapter as any).buildModelSwitchConfig("s1", "gpt-4o");
      expect(config).toEqual({ modelId: "gpt-4o" });
      expect("reasoningEffort" in config).toBe(false);
    });

    it("passes through 'high' effort without transformation", () => {
      (adapter as any).sessionReasoningEfforts.set("s1", "high");
      const config = (adapter as any).buildModelSwitchConfig("s1", "gpt-4o");
      expect(config.reasoningEffort).toBe("high");
    });
  });

  describe("setReasoningEffort()", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("stores reasoning effort and calls model.switchTo on active session", async () => {
      (adapter as any).currentModelId = "gpt-4o";
      const sess = makeMockSession("s1");
      (adapter as any).activeSessions.set("s1", sess);

      await adapter.setReasoningEffort("s1", "high");

      expect((adapter as any).sessionReasoningEfforts.get("s1")).toBe("high");
      expect(sess.rpc.model.switchTo).toHaveBeenCalledWith({ modelId: "gpt-4o", reasoningEffort: "high" });
    });

    it("clears effort and removes reasoningEffort from switch config when set to null", async () => {
      (adapter as any).currentModelId = "gpt-4o";
      (adapter as any).sessionReasoningEfforts.set("s1", "max");
      const sess = makeMockSession("s1");
      (adapter as any).activeSessions.set("s1", sess);

      await adapter.setReasoningEffort("s1", null);

      expect((adapter as any).sessionReasoningEfforts.has("s1")).toBe(false);
      expect(sess.rpc.model.switchTo).toHaveBeenCalledWith({ modelId: "gpt-4o" });
    });

    it("does not call model.switchTo when no currentModelId is set", async () => {
      (adapter as any).currentModelId = null;
      const sess = makeMockSession("s1");
      (adapter as any).activeSessions.set("s1", sess);

      await adapter.setReasoningEffort("s1", "medium");

      expect(sess.rpc.model.switchTo).not.toHaveBeenCalled();
    });
  });

  describe("getReasoningEffort()", () => {
    it("returns the stored effort for a session", () => {
      (adapter as any).sessionReasoningEfforts.set("s1", "medium");
      expect(adapter.getReasoningEffort("s1")).toBe("medium");
    });

    it("returns null when no effort is stored", () => {
      expect(adapter.getReasoningEffort("unknown")).toBeNull();
    });
  });

  // ============================================================================
  // I. Commands & Skills
  // ============================================================================

  describe("fetchSkills()", () => {
    it("caches user-invocable commands and emits commands.changed", async () => {
      const commandEvents: any[] = [];
      adapter.on("commands.changed", (e) => commandEvents.push(e));
      const sess = {
        rpc: {
          skills: {
            list: vi.fn(async () => ({
              skills: [
                { name: "fix", description: "Fix issues", userInvocable: true, source: "project" },
                { name: "internal", description: "Internal", userInvocable: false },
              ],
            })),
          },
        },
      };

      await (adapter as any).fetchSkills(sess);

      // userInvocable: false filtered out (source code: filter s.userInvocable !== false)
      // Actually re-reading: .filter((s: any) => s.userInvocable !== false) keeps userInvocable:true and undefined
      // "internal" has userInvocable:false so it is filtered OUT
      const cached = (adapter as any).cachedCommands;
      expect(cached.find((c: any) => c.name === "fix")).toBeDefined();
      expect(cached.find((c: any) => c.name === "internal")).toBeUndefined();
      expect(commandEvents).toHaveLength(1);
      expect(commandEvents[0].engineType).toBe("copilot");
    });

    it("handles skills returned as a flat array (not wrapped in {skills})", async () => {
      const sess = {
        rpc: {
          skills: {
            list: vi.fn(async () => [{ name: "cmd1", description: "Cmd 1" }]),
          },
        },
      };

      await (adapter as any).fetchSkills(sess);

      expect((adapter as any).cachedCommands).toHaveLength(1);
      expect((adapter as any).cachedCommands[0].name).toBe("cmd1");
    });

    it("swallows errors and logs a warning", async () => {
      const sess = {
        rpc: {
          skills: { list: vi.fn(async () => { throw new Error("RPC failed"); }) },
        },
      };

      await expect((adapter as any).fetchSkills(sess)).resolves.toBeUndefined();
    });
  });

  describe("listCommands()", () => {
    it("returns cached commands immediately when cache is populated", async () => {
      (adapter as any).cachedCommands = [{ name: "fix", description: "Fix" }];

      const result = await adapter.listCommands("s1");

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("fix");
    });

    it("fetches skills from active session when cache is empty", async () => {
      await adapter.start();
      const sess = {
        rpc: {
          skills: {
            list: vi.fn(async () => ({
              skills: [{ name: "cmd", description: "Cmd", userInvocable: true }],
            })),
          },
        },
      };
      (adapter as any).activeSessions.set("s1", sess);

      const result = await adapter.listCommands("s1");

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("cmd");
    });

    it("uses the first active session when no sessionId is provided", async () => {
      await adapter.start();
      const sess = {
        rpc: {
          skills: {
            list: vi.fn(async () => ({
              skills: [{ name: "fallback-cmd", description: "" }],
            })),
          },
        },
      };
      (adapter as any).activeSessions.set("s1", sess);

      await adapter.listCommands(); // no sessionId

      expect((adapter as any).cachedCommands[0].name).toBe("fallback-cmd");
    });

    it("returns empty array when cache is empty and no active sessions", async () => {
      const result = await adapter.listCommands();
      expect(result).toEqual([]);
    });
  });

  describe("handleCommandExecute()", () => {
    it("calls handlePendingCommand on the active session with the requestId", async () => {
      await adapter.start();
      const sess = makeMockSession("s1");
      (adapter as any).activeSessions.set("s1", sess);

      await (adapter as any).handleCommandExecute("s1", {
        requestId: "req-1",
        command: "/fix",
        commandName: "fix",
        args: "",
      });

      expect(sess.rpc.commands.handlePendingCommand).toHaveBeenCalledWith({ requestId: "req-1" });
    });

    it("swallows errors when handlePendingCommand fails", async () => {
      await adapter.start();
      const sess = makeMockSession("s1");
      sess.rpc.commands.handlePendingCommand.mockRejectedValue(new Error("rpc error"));
      (adapter as any).activeSessions.set("s1", sess);

      await expect(
        (adapter as any).handleCommandExecute("s1", { requestId: "req-1", command: "/fix", commandName: "fix", args: "" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("handleCommandsChanged()", () => {
    it("updates cachedCommands and emits commands.changed", () => {
      const events: any[] = [];
      adapter.on("commands.changed", (e) => events.push(e));

      (adapter as any).handleCommandsChanged("s1", {
        commands: [
          { name: "fix", description: "Fix" },
          { name: "test", description: "Test" },
        ],
      });

      expect((adapter as any).cachedCommands).toHaveLength(2);
      expect(events).toHaveLength(1);
      expect(events[0].commands.map((c: any) => c.name)).toEqual(["fix", "test"]);
    });

    it("is a no-op when commands data is not an array", () => {
      const events: any[] = [];
      adapter.on("commands.changed", (e) => events.push(e));

      (adapter as any).handleCommandsChanged("s1", { commands: null });

      expect(events).toHaveLength(0);
    });
  });

  describe("handleSkillsLoaded()", () => {
    it("updates cachedCommands filtering out non-user-invocable skills", () => {
      (adapter as any).handleSkillsLoaded("s1", {
        skills: [
          { name: "fix", description: "Fix", userInvocable: true, source: "project" },
          { name: "internal", description: "Internal", userInvocable: false },
        ],
      });

      const commands = (adapter as any).cachedCommands;
      expect(commands.map((c: any) => c.name)).toEqual(["fix"]);
    });

    it("emits commands.changed after updating", () => {
      const events: any[] = [];
      adapter.on("commands.changed", (e) => events.push(e));

      (adapter as any).handleSkillsLoaded("s1", {
        skills: [{ name: "deploy", description: "Deploy", userInvocable: true }],
      });

      expect(events).toHaveLength(1);
    });
  });

  // ============================================================================
  // J. Additional event handlers
  // ============================================================================

  describe("handleTitleChanged()", () => {
    it("emits session.updated with the new title", () => {
      const updates: any[] = [];
      adapter.on("session.updated", (e) => updates.push(e));

      (adapter as any).handleTitleChanged("s1", { title: "New Title" });

      expect(updates).toHaveLength(1);
      expect(updates[0].session.id).toBe("s1");
      expect(updates[0].session.title).toBe("New Title");
    });

    it("ignores the event when title is absent", () => {
      const updates: any[] = [];
      adapter.on("session.updated", (e) => updates.push(e));

      (adapter as any).handleTitleChanged("s1", {});

      expect(updates).toHaveLength(0);
    });
  });

  describe("handleModelChange()", () => {
    it("updates currentModelId when newModel is present", () => {
      (adapter as any).handleModelChange("s1", { newModel: "gpt-4o-mini" });
      expect((adapter as any).currentModelId).toBe("gpt-4o-mini");
    });

    it("leaves currentModelId unchanged when newModel is absent", () => {
      (adapter as any).currentModelId = "existing";
      (adapter as any).handleModelChange("s1", {});
      expect((adapter as any).currentModelId).toBe("existing");
    });
  });

  describe("handleModeChanged()", () => {
    it("updates session mode map when newMode is provided", () => {
      (adapter as any).handleModeChanged("s1", { newMode: "interactive" });
      expect((adapter as any).sessionModes.get("s1")).toBe("interactive");
    });

    it("leaves mode unchanged when newMode is absent", () => {
      (adapter as any).sessionModes.set("s1", "autopilot");
      (adapter as any).handleModeChanged("s1", {});
      expect((adapter as any).sessionModes.get("s1")).toBe("autopilot");
    });
  });

  describe("handleUsage()", () => {
    it("updates buffer tokens, cost, costUnit, and modelId from usage event", () => {
      const buffer = makeBuffer("s1");
      (adapter as any).messageBuffers.set("s1", buffer);

      (adapter as any).handleUsage("s1", {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        cost: 2,
        model: "gpt-4o",
      });

      expect(buffer.tokens).toEqual({ input: 100, output: 50, cache: { read: 20, write: 10 } });
      expect((buffer as any).cost).toBe(2);
      expect((buffer as any).costUnit).toBe("premium_requests");
      expect((buffer as any).modelId).toBe("gpt-4o");
    });

    it("omits cache field when cacheRead/cacheWrite are both zero", () => {
      const buffer = makeBuffer("s1");
      (adapter as any).messageBuffers.set("s1", buffer);

      (adapter as any).handleUsage("s1", { inputTokens: 5, outputTokens: 3 });

      expect(buffer.tokens?.cache).toBeUndefined();
    });

    it("is a no-op when no buffer exists for the session", () => {
      expect(() => {
        (adapter as any).handleUsage("no-buffer", { inputTokens: 1, outputTokens: 1 });
      }).not.toThrow();
    });
  });

  describe("handleSessionError()", () => {
    it("sets error on buffer, finalizes it, and resolves idle resolvers", () => {
      const resolver = vi.fn();
      (adapter as any).messageBuffers.set("s1", makeBuffer("s1"));
      (adapter as any).idleResolvers.set("s1", [resolver]);

      (adapter as any).handleSessionError("s1", { message: "Something went wrong" });

      expect(resolver).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Something went wrong" }),
      );
    });
  });
});
