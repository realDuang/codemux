import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock variables
// ---------------------------------------------------------------------------

const mockRandomUUID = vi.hoisted(() => vi.fn(() => "test-client-id"));

const mockOnFileChange = vi.hoisted(() => vi.fn());
const mockUnwatchAll = vi.hoisted(() => vi.fn());
const mockListDirectory = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockGetGitStatus = vi.hoisted(() => vi.fn());
const mockGetGitDiff = vi.hoisted(() => vi.fn());
const mockWatchDirectory = vi.hoisted(() => vi.fn());
const mockUnwatchDirectory = vi.hoisted(() => vi.fn());

const mockGatewayLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockLog = vi.hoisted(() => ({
  scope: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

const mockConversationStore = vi.hoisted(() => ({
  list: vi.fn(() => []),
  get: vi.fn(),
}));

const mockScheduledTaskService = vi.hoisted(() => ({
  on: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  runNow: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

/** Captured event handlers for each mock WebSocketServer instance */
let wssHandlers: Record<string, (...args: any[]) => void>;

const MockWebSocketServerInstance = vi.hoisted(() => ({
  on: vi.fn(),
  close: vi.fn(),
  address: vi.fn(),
}));

/** Tracks the most recent args passed to the WebSocketServer constructor. */
let lastWssConstructorArgs: any = undefined;

vi.mock("ws", () => {
  const OPEN = 1;
  const CLOSED = 3;
  // Use a regular function so it works with `new`
  function MockWebSocketServer(options: any) {
    lastWssConstructorArgs = options;
    wssHandlers = {};
    MockWebSocketServerInstance.on.mockImplementation(
      (event: string, handler: (...args: any[]) => void) => {
        wssHandlers[event] = handler;
      },
    );
    return MockWebSocketServerInstance;
  }
  return {
    WebSocketServer: MockWebSocketServer,
    WebSocket: { OPEN, CLOSED },
  };
});

vi.mock("crypto", () => ({
  randomUUID: mockRandomUUID,
}));

vi.mock("../../../../electron/main/gateway/engine-manager", () => ({
  EngineManager: vi.fn(),
}));

vi.mock("../../../../electron/main/services/file-service", () => ({
  onFileChange: mockOnFileChange,
  unwatchAll: mockUnwatchAll,
  listDirectory: mockListDirectory,
  readFile: mockReadFile,
  getGitStatus: mockGetGitStatus,
  getGitDiff: mockGetGitDiff,
  watchDirectory: mockWatchDirectory,
  unwatchDirectory: mockUnwatchDirectory,
}));

vi.mock("../../../../electron/main/services/logger", () => ({
  gatewayLog: mockGatewayLog,
  default: mockLog,
}));

vi.mock("../../../../electron/main/services/conversation-store", () => ({
  conversationStore: mockConversationStore,
}));

vi.mock("../../../../electron/main/services/scheduled-task-service", () => ({
  scheduledTaskService: mockScheduledTaskService,
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks are established
// ---------------------------------------------------------------------------

import { GatewayServer } from "../../../../electron/main/gateway/ws-server";
import {
  GatewayRequestType,
  GatewayNotificationType,
} from "../../../../src/types/unified";
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock EngineManager with all needed methods and event-emitter API. */
function createMockEngineManager() {
  const handlers: Record<string, ((...args: any[]) => void)[]> = {};
  return {
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    emit: (event: string, ...args: any[]) => {
      for (const h of handlers[event] ?? []) h(...args);
    },
    _handlers: handlers,
    listEngines: vi.fn(() => [{ type: "claude" }]),
    getEngineInfo: vi.fn(() => ({
      type: "claude",
      capabilities: { imageAttachment: true },
    })),
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => ({ id: "sess-1" })),
    getSession: vi.fn(async () => ({ id: "sess-1" })),
    deleteSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => ({ success: true })),
    sendMessage: vi.fn(async () => ({ id: "msg-1" })),
    cancelMessage: vi.fn(async () => {}),
    listMessages: vi.fn(async () => []),
    getMessageSteps: vi.fn(async () => []),
    listModels: vi.fn(async () => ({ models: [] })),
    setModel: vi.fn(async () => {}),
    setMode: vi.fn(async () => {}),
    updateSessionConfig: vi.fn(async () => {}),
    replyPermission: vi.fn(async () => {}),
    replyQuestion: vi.fn(async () => {}),
    rejectQuestion: vi.fn(async () => {}),
    listProjects: vi.fn(async () => []),
    setProjectEngine: vi.fn(),
    listAllSessions: vi.fn(() => []),
    listAllProjects: vi.fn(() => []),
    deleteProject: vi.fn(async () => {}),
    importPreview: vi.fn(async () => []),
    importExecute: vi.fn(async () => ({ imported: 0 })),
    listCommands: vi.fn(async () => []),
    invokeCommand: vi.fn(async () => ({})),
  };
}

/** Create a mock WebSocket client. */
function createMockWs(readyState = WebSocket.OPEN) {
  const handlers: Record<string, ((...args: any[]) => void)[]> = {};
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
    ping: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    /** Trigger a registered event on this mock ws. */
    _trigger(event: string, ...args: any[]) {
      for (const h of handlers[event] ?? []) h(...args);
    },
    _handlers: handlers,
  };
}

interface TestHarness {
  server: GatewayServer;
  engineManager: ReturnType<typeof createMockEngineManager>;
  /** Simulate a new client connecting. Returns the mock ws and helpers. */
  connect: (req?: any) => ReturnType<typeof createMockWs>;
  /** Simulate a message from a connected client. */
  sendMessage: (ws: ReturnType<typeof createMockWs>, data: unknown) => Promise<void>;
}

/**
 * Create a fully-mocked GatewayServer ready for testing.
 * Starts the server so the WSS connection handler is wired up.
 */
function createTestHarness(options?: {
  authValidator?: (token: string) => boolean;
}): TestHarness {
  const engineManager = createMockEngineManager();
  const server = new GatewayServer(engineManager as any, options);

  // Start so that WSS handlers are registered
  server.start({ port: 0 });

  const connect = (req?: any) => {
    const ws = createMockWs();
    const defaultReq = { url: "/" };
    wssHandlers["connection"]?.(ws, req ?? defaultReq);
    return ws;
  };

  const sendMessage = async (ws: ReturnType<typeof createMockWs>, data: unknown) => {
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    // handleMessage is async -- call the message handler and await it
    const msgHandler = ws._handlers["message"]?.[0];
    if (msgHandler) {
      await msgHandler(Buffer.from(raw));
    }
  };

  return { server, engineManager, connect, sendMessage };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GatewayServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    wssHandlers = {};
    lastWssConstructorArgs = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe("constructor", () => {
    it("subscribes to engine events", () => {
      const engineManager = createMockEngineManager();
      new GatewayServer(engineManager as any);

      const subscribedEvents = engineManager.on.mock.calls.map(
        (call: any[]) => call[0],
      );
      expect(subscribedEvents).toContain("message.part.updated");
      expect(subscribedEvents).toContain("message.updated");
      expect(subscribedEvents).toContain("session.updated");
      expect(subscribedEvents).toContain("session.created");
      expect(subscribedEvents).toContain("permission.asked");
      expect(subscribedEvents).toContain("permission.replied");
      expect(subscribedEvents).toContain("question.asked");
      expect(subscribedEvents).toContain("question.replied");
      expect(subscribedEvents).toContain("status.changed");
      expect(subscribedEvents).toContain("message.queued");
      expect(subscribedEvents).toContain("message.queued.consumed");
      expect(subscribedEvents).toContain("session.import.progress");
      expect(subscribedEvents).toContain("commands.changed");
    });

    it("subscribes to scheduled task service events", () => {
      const engineManager = createMockEngineManager();
      new GatewayServer(engineManager as any);

      const subscribedEvents = mockScheduledTaskService.on.mock.calls.map(
        (call: any[]) => call[0],
      );
      expect(subscribedEvents).toContain("task.fired");
      expect(subscribedEvents).toContain("task.failed");
      expect(subscribedEvents).toContain("tasks.changed");
    });

    it("registers file change handler via onFileChange", () => {
      const engineManager = createMockEngineManager();
      new GatewayServer(engineManager as any);

      expect(mockOnFileChange).toHaveBeenCalledOnce();
      expect(typeof mockOnFileChange.mock.calls[0][0]).toBe("function");
    });

    it("stores authValidator when provided", () => {
      const validator = vi.fn(() => true);
      const engineManager = createMockEngineManager();
      const server = new GatewayServer(engineManager as any, {
        authValidator: validator,
      });

      // The validator is stored internally; we verify its effect in auth tests
      expect(server).toBeDefined();
    });
  });

  // =========================================================================
  // start()
  // =========================================================================

  describe("start()", () => {
    it("throws if already started", () => {
      const { server } = createTestHarness();
      expect(() => server.start({ port: 9999 })).toThrow(
        "Gateway server already started",
      );
    });

    it("creates WebSocketServer with port option", () => {
      const engineManager = createMockEngineManager();
      const server = new GatewayServer(engineManager as any);
      server.start({ port: 4567 });

      expect(lastWssConstructorArgs).toEqual(
        expect.objectContaining({ port: 4567, maxPayload: 20 * 1024 * 1024 }),
      );
    });

    it("creates WebSocketServer with server option", () => {
      const engineManager = createMockEngineManager();
      const server = new GatewayServer(engineManager as any);
      const httpServer = {} as any;
      server.start({ server: httpServer, path: "/ws" });

      expect(lastWssConstructorArgs).toEqual(
        expect.objectContaining({
          server: httpServer,
          path: "/ws",
          maxPayload: 20 * 1024 * 1024,
        }),
      );
    });

    it("registers connection and error handlers on WSS", () => {
      const engineManager = createMockEngineManager();
      const server = new GatewayServer(engineManager as any);
      server.start({ port: 0 });

      expect(MockWebSocketServerInstance.on).toHaveBeenCalledWith(
        "connection",
        expect.any(Function),
      );
      expect(MockWebSocketServerInstance.on).toHaveBeenCalledWith(
        "error",
        expect.any(Function),
      );
    });

    it("sets up a ping interval that pings OPEN clients", () => {
      const { connect } = createTestHarness();
      const ws = connect();

      // Advance 30s to trigger the ping interval
      vi.advanceTimersByTime(30_000);

      expect(ws.ping).toHaveBeenCalled();
    });

    it("ping interval skips clients that are not OPEN", () => {
      const { server, engineManager } = createTestHarness();

      // Connect a client, then change its readyState to CLOSED
      const ws = createMockWs(3); // WebSocket.CLOSED = 3
      wssHandlers["connection"]?.(ws, { url: "/" });

      vi.advanceTimersByTime(30_000);

      expect(ws.ping).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // stop()
  // =========================================================================

  describe("stop()", () => {
    it("calls unwatchAll", () => {
      const { server } = createTestHarness();
      server.stop();

      expect(mockUnwatchAll).toHaveBeenCalled();
    });

    it("clears ping interval", () => {
      const { server, connect } = createTestHarness();
      const ws = connect();
      server.stop();

      // After stop, advancing timers should NOT trigger more pings
      ws.ping.mockClear();
      vi.advanceTimersByTime(60_000);
      expect(ws.ping).not.toHaveBeenCalled();
    });

    it("closes all connected clients with code 1001", () => {
      const { server, connect } = createTestHarness();
      const ws1 = connect();
      mockRandomUUID.mockReturnValueOnce("client-2");
      const ws2 = connect();

      server.stop();

      expect(ws1.close).toHaveBeenCalledWith(1001, "Server shutting down");
      expect(ws2.close).toHaveBeenCalledWith(1001, "Server shutting down");
    });

    it("closes the WebSocketServer", () => {
      const { server } = createTestHarness();
      server.stop();

      expect(MockWebSocketServerInstance.close).toHaveBeenCalled();
    });

    it("is safe to call stop when not started", () => {
      const engineManager = createMockEngineManager();
      const server = new GatewayServer(engineManager as any);

      // Should not throw
      expect(() => server.stop()).not.toThrow();
    });
  });

  // =========================================================================
  // getPort()
  // =========================================================================

  describe("getPort()", () => {
    it("returns port from WSS address", () => {
      const { server } = createTestHarness();
      MockWebSocketServerInstance.address.mockReturnValue({ port: 8080 });

      expect(server.getPort()).toBe(8080);
    });

    it("returns undefined when WSS is not started", () => {
      const engineManager = createMockEngineManager();
      const server = new GatewayServer(engineManager as any);

      expect(server.getPort()).toBeUndefined();
    });

    it("returns undefined when address returns a string", () => {
      const { server } = createTestHarness();
      MockWebSocketServerInstance.address.mockReturnValue("some-string");

      expect(server.getPort()).toBeUndefined();
    });
  });

  // =========================================================================
  // handleConnection
  // =========================================================================

  describe("handleConnection", () => {
    it("creates a client with auto-authentication when no validator", () => {
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      // Client should be auto-authenticated, so sending a normal request should work
      // (won't get 4001 close)
      expect(ws.close).not.toHaveBeenCalled();
    });

    it("registers message, close, and error handlers on ws", () => {
      const { connect } = createTestHarness();
      const ws = connect();

      expect(ws.on).toHaveBeenCalledWith("message", expect.any(Function));
      expect(ws.on).toHaveBeenCalledWith("close", expect.any(Function));
      expect(ws.on).toHaveBeenCalledWith("error", expect.any(Function));
    });

    it("removes client from map on close", async () => {
      const { server, connect, sendMessage } = createTestHarness();
      const ws = connect();

      // Trigger close event
      ws._trigger("close");

      // Now if we broadcast, nothing should be sent to this ws
      ws.send.mockClear();
      // Trigger a file change to force a broadcast
      const fileChangeHandler = mockOnFileChange.mock.calls[0][0];
      fileChangeHandler({ type: "change", path: "/a.txt" });

      expect(ws.send).not.toHaveBeenCalled();
    });

    it("authenticates via query string token when validator present", async () => {
      const validator = vi.fn((token: string) => token === "valid-token");
      const { connect, sendMessage } = createTestHarness({
        authValidator: validator,
      });

      const ws = connect({ url: "/?token=valid-token" });

      // Client should be authenticated; send a request and verify it works
      await sendMessage(ws, {
        type: GatewayRequestType.ENGINE_LIST,
        requestId: "r1",
        payload: {},
      });

      expect(ws.close).not.toHaveBeenCalledWith(4001, "Unauthorized");
      expect(ws.send).toHaveBeenCalled();
    });

    it("does not authenticate with invalid query string token", async () => {
      const validator = vi.fn((token: string) => token === "valid-token");
      const { connect, sendMessage } = createTestHarness({
        authValidator: validator,
      });

      const ws = connect({ url: "/?token=bad-token" });

      // Client is NOT authenticated; sending a non-auth message should close the ws
      await sendMessage(ws, {
        type: GatewayRequestType.ENGINE_LIST,
        requestId: "r1",
        payload: {},
      });

      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized");
    });

    it("client remains unauthenticated when no token in query string", async () => {
      const validator = vi.fn(() => false);
      const { connect, sendMessage } = createTestHarness({
        authValidator: validator,
      });

      const ws = connect({ url: "/" });

      await sendMessage(ws, {
        type: GatewayRequestType.ENGINE_LIST,
        requestId: "r1",
        payload: {},
      });

      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized");
    });
  });

  // =========================================================================
  // handleMessage - auth flow
  // =========================================================================

  describe("handleMessage - auth flow", () => {
    it("authenticates via auth message with valid token", async () => {
      const validator = vi.fn((token: string) => token === "secret");
      const { connect, sendMessage } = createTestHarness({
        authValidator: validator,
      });

      const ws = connect({ url: "/" }); // No token in URL -> unauthenticated

      await sendMessage(ws, {
        type: "auth",
        token: "secret",
        requestId: "auth-1",
      });

      // Should receive auth success response
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "response",
          requestId: "auth-1",
          payload: { authenticated: true },
        }),
      );
      expect(ws.close).not.toHaveBeenCalled();
    });

    it("closes connection with 4001 when auth message has invalid token", async () => {
      const validator = vi.fn((token: string) => token === "secret");
      const { connect, sendMessage } = createTestHarness({
        authValidator: validator,
      });

      const ws = connect({ url: "/" });

      await sendMessage(ws, {
        type: "auth",
        token: "wrong",
        requestId: "auth-1",
      });

      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized");
    });

    it("closes connection with 4001 when unauthenticated client sends non-auth message", async () => {
      const validator = vi.fn(() => false);
      const { connect, sendMessage } = createTestHarness({
        authValidator: validator,
      });

      const ws = connect({ url: "/" });

      await sendMessage(ws, {
        type: GatewayRequestType.ENGINE_LIST,
        requestId: "r1",
        payload: {},
      });

      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized");
    });

    it("closes connection with 4001 when unauthenticated client sends invalid JSON", async () => {
      const validator = vi.fn(() => false);
      const { connect, sendMessage } = createTestHarness({
        authValidator: validator,
      });

      const ws = connect({ url: "/" });

      await sendMessage(ws, "not-valid-json{{{");

      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized");
    });

    it("after auth succeeds, subsequent requests are processed normally", async () => {
      const validator = vi.fn((token: string) => token === "secret");
      const { connect, sendMessage, engineManager } = createTestHarness({
        authValidator: validator,
      });

      const ws = connect({ url: "/" });

      // First authenticate
      await sendMessage(ws, { type: "auth", token: "secret", requestId: "auth-1" });
      ws.send.mockClear();

      // Now send a normal request
      await sendMessage(ws, {
        type: GatewayRequestType.ENGINE_LIST,
        requestId: "r2",
        payload: {},
      });

      expect(engineManager.listEngines).toHaveBeenCalled();
      expect(ws.send).toHaveBeenCalled();
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.requestId).toBe("r2");
    });
  });

  // =========================================================================
  // handleMessage - request parsing
  // =========================================================================

  describe("handleMessage - request parsing", () => {
    it("responds with PARSE_ERROR for invalid JSON", async () => {
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, "this is not json!!!");

      expect(ws.send).toHaveBeenCalledOnce();
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response).toEqual({
        type: "response",
        requestId: "",
        payload: null,
        error: { code: "PARSE_ERROR", message: "Invalid JSON" },
      });
    });
  });

  // =========================================================================
  // handleMessage - LOG_SEND (fire-and-forget)
  // =========================================================================

  describe("handleMessage - LOG_SEND", () => {
    it("does not send any response for LOG_SEND requests", async () => {
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.LOG_SEND,
        requestId: "log-1",
        payload: { level: "info", args: ["hello"] },
      });

      expect(ws.send).not.toHaveBeenCalled();
    });

    it("forwards log to scoped renderer logger", async () => {
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.LOG_SEND,
        requestId: "log-1",
        payload: { level: "warn", args: ["test warning"] },
      });

      expect(mockLog.scope).toHaveBeenCalledWith("renderer");
    });
  });

  // =========================================================================
  // routeRequest - major types
  // =========================================================================

  describe("routeRequest - major types", () => {
    it("ENGINE_LIST delegates to engineManager.listEngines", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.ENGINE_LIST,
        requestId: "r1",
        payload: {},
      });

      expect(engineManager.listEngines).toHaveBeenCalled();
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.requestId).toBe("r1");
      expect(response.payload).toEqual([{ type: "claude" }]);
    });

    it("ENGINE_CAPABILITIES delegates to engineManager.getEngineInfo", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.ENGINE_CAPABILITIES,
        requestId: "r1",
        payload: { engineType: "claude" },
      });

      expect(engineManager.getEngineInfo).toHaveBeenCalledWith("claude");
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload).toEqual({ imageAttachment: true });
    });

    it("SESSION_CREATE delegates with correct params", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.SESSION_CREATE,
        requestId: "r1",
        payload: {
          engineType: "claude",
          directory: "/projects/test",
          worktreeId: "wt-1",
        },
      });

      expect(engineManager.createSession).toHaveBeenCalledWith(
        "claude",
        "/projects/test",
        "wt-1",
      );
    });

    it("SESSION_GET delegates with sessionId", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.SESSION_GET,
        requestId: "r1",
        payload: { sessionId: "sess-1" },
      });

      expect(engineManager.getSession).toHaveBeenCalledWith("sess-1");
    });

    it("SESSION_DELETE delegates with sessionId", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.SESSION_DELETE,
        requestId: "r1",
        payload: { sessionId: "sess-1" },
      });

      expect(engineManager.deleteSession).toHaveBeenCalledWith("sess-1");
    });

    it("SESSION_RENAME delegates with sessionId and title", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.SESSION_RENAME,
        requestId: "r1",
        payload: { sessionId: "sess-1", title: "New Title" },
      });

      expect(engineManager.renameSession).toHaveBeenCalledWith(
        "sess-1",
        "New Title",
      );
    });

    it("SESSION_LIST delegates with engineType", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.SESSION_LIST,
        requestId: "r1",
        payload: { engineType: "claude" },
      });

      expect(engineManager.listSessions).toHaveBeenCalledWith("claude");
    });

    it("SESSION_LIST_ALL delegates to engineManager.listAllSessions", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.SESSION_LIST_ALL,
        requestId: "r1",
        payload: {},
      });

      expect(engineManager.listAllSessions).toHaveBeenCalled();
    });

    it("MESSAGE_SEND delegates with correct params", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.MESSAGE_SEND,
        requestId: "r1",
        payload: {
          sessionId: "sess-1",
          content: "Hello",
          mode: "agent",
          modelId: "opus",
          reasoningEffort: "high",
        },
      });

      expect(engineManager.sendMessage).toHaveBeenCalledWith(
        "sess-1",
        "Hello",
        { mode: "agent", modelId: "opus", reasoningEffort: "high" },
      );
    });

    it("MESSAGE_CANCEL delegates with sessionId", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.MESSAGE_CANCEL,
        requestId: "r1",
        payload: { sessionId: "sess-1" },
      });

      expect(engineManager.cancelMessage).toHaveBeenCalledWith("sess-1");
    });

    it("MESSAGE_LIST delegates with sessionId", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.MESSAGE_LIST,
        requestId: "r1",
        payload: { sessionId: "sess-1" },
      });

      expect(engineManager.listMessages).toHaveBeenCalledWith("sess-1");
    });

    it("MESSAGE_STEPS delegates with sessionId and messageId", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.MESSAGE_STEPS,
        requestId: "r1",
        payload: { sessionId: "sess-1", messageId: "msg-1" },
      });

      expect(engineManager.getMessageSteps).toHaveBeenCalledWith(
        "sess-1",
        "msg-1",
      );
    });

    it("MODEL_LIST delegates with engineType", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.MODEL_LIST,
        requestId: "r1",
        payload: { engineType: "claude" },
      });

      expect(engineManager.listModels).toHaveBeenCalledWith("claude");
    });

    it("MODEL_SET delegates with sessionId and modelId", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.MODEL_SET,
        requestId: "r1",
        payload: { sessionId: "sess-1", modelId: "opus-4" },
      });

      expect(engineManager.setModel).toHaveBeenCalledWith("sess-1", "opus-4");
    });

    it("MODE_SET delegates with sessionId and modeId", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.MODE_SET,
        requestId: "r1",
        payload: { sessionId: "sess-1", modeId: "plan" },
      });

      expect(engineManager.setMode).toHaveBeenCalledWith("sess-1", "plan");
    });

    it("SESSION_CONFIG_UPDATE delegates with sessionId and config patch", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.SESSION_CONFIG_UPDATE,
        requestId: "r1",
        payload: {
          sessionId: "sess-1",
          config: { reasoningEffort: "high", serviceTier: "fast" },
        },
      });

      expect(engineManager.updateSessionConfig).toHaveBeenCalledWith("sess-1", {
        reasoningEffort: "high",
        serviceTier: "fast",
      });
    });

    it("SESSION_CONFIG_UPDATE strips invalid reasoning effort and service tier values", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.SESSION_CONFIG_UPDATE,
        requestId: "r2",
        payload: {
          sessionId: "sess-1",
          config: { reasoningEffort: "bogus", serviceTier: "invalid" },
        },
      });

      expect(engineManager.updateSessionConfig).toHaveBeenCalledWith("sess-1", {
        reasoningEffort: undefined,
        serviceTier: undefined,
      });
    });

    it("PERMISSION_REPLY delegates with permissionId and optionId", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.PERMISSION_REPLY,
        requestId: "r1",
        payload: { permissionId: "perm-1", optionId: "allow" },
      });

      expect(engineManager.replyPermission).toHaveBeenCalledWith("perm-1", {
        optionId: "allow",
      });
    });

    it("QUESTION_REPLY delegates with questionId and answers", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.QUESTION_REPLY,
        requestId: "r1",
        payload: { questionId: "q-1", answers: [["yes"]] },
      });

      expect(engineManager.replyQuestion).toHaveBeenCalledWith("q-1", [
        ["yes"],
      ]);
    });

    it("QUESTION_REJECT delegates with questionId", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.QUESTION_REJECT,
        requestId: "r1",
        payload: { questionId: "q-1" },
      });

      expect(engineManager.rejectQuestion).toHaveBeenCalledWith("q-1");
    });

    it("PROJECT_LIST delegates with engineType", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.PROJECT_LIST,
        requestId: "r1",
        payload: { engineType: "claude" },
      });

      expect(engineManager.listProjects).toHaveBeenCalledWith("claude");
    });

    it("PROJECT_SET_ENGINE delegates and returns success", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.PROJECT_SET_ENGINE,
        requestId: "r1",
        payload: { directory: "/proj", engineType: "claude" },
      });

      expect(engineManager.setProjectEngine).toHaveBeenCalledWith(
        "/proj",
        "claude",
      );
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload).toEqual({ success: true });
    });

    it("PROJECT_LIST_ALL delegates to engineManager.listAllProjects", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.PROJECT_LIST_ALL,
        requestId: "r1",
        payload: {},
      });

      expect(engineManager.listAllProjects).toHaveBeenCalled();
    });

    it("PROJECT_DELETE delegates and returns success", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.PROJECT_DELETE,
        requestId: "r1",
        payload: { projectId: "proj-1" },
      });

      expect(engineManager.deleteProject).toHaveBeenCalledWith("proj-1");
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload).toEqual({ success: true });
    });

    it("IMPORT_LEGACY_PROJECTS returns imported: 0", async () => {
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.IMPORT_LEGACY_PROJECTS,
        requestId: "r1",
        payload: {},
      });

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload).toEqual({ imported: 0 });
    });

    it("SESSION_IMPORT_PREVIEW delegates with engineType and limit", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.SESSION_IMPORT_PREVIEW,
        requestId: "r1",
        payload: { engineType: "claude", limit: 10 },
      });

      expect(engineManager.importPreview).toHaveBeenCalledWith("claude", 10);
    });

    it("SESSION_IMPORT_EXECUTE delegates with engineType and sessions", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      const sessions = [{ id: "s1" }];
      await sendMessage(ws, {
        type: GatewayRequestType.SESSION_IMPORT_EXECUTE,
        requestId: "r1",
        payload: { engineType: "claude", sessions },
      });

      expect(engineManager.importExecute).toHaveBeenCalledWith(
        "claude",
        sessions,
      );
    });

    it("COMMAND_LIST delegates with engineType and sessionId", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.COMMAND_LIST,
        requestId: "r1",
        payload: { engineType: "claude", sessionId: "sess-1" },
      });

      expect(engineManager.listCommands).toHaveBeenCalledWith(
        "claude",
        "sess-1",
      );
    });

    it("COMMAND_INVOKE delegates with correct params", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.COMMAND_INVOKE,
        requestId: "r1",
        payload: {
          sessionId: "sess-1",
          commandName: "/help",
          args: "topic",
          mode: "agent",
          modelId: "opus",
          reasoningEffort: "medium",
        },
      });

      expect(engineManager.invokeCommand).toHaveBeenCalledWith(
        "sess-1",
        "/help",
        "topic",
        { mode: "agent", modelId: "opus", reasoningEffort: "medium" },
      );
    });
  });

  // =========================================================================
  // routeRequest - file service
  // =========================================================================

  describe("routeRequest - file service", () => {
    it("FILE_LIST delegates to fileService.listDirectory", async () => {
      mockListDirectory.mockResolvedValue([{ name: "file.txt" }]);
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.FILE_LIST,
        requestId: "r1",
        payload: { directory: "/proj", rootDirectory: "/proj" },
      });

      expect(mockListDirectory).toHaveBeenCalledWith("/proj", "/proj");
    });

    it("FILE_LIST uses directory as rootDirectory when rootDirectory is missing", async () => {
      mockListDirectory.mockResolvedValue([]);
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.FILE_LIST,
        requestId: "r1",
        payload: { directory: "/proj" },
      });

      expect(mockListDirectory).toHaveBeenCalledWith("/proj", "/proj");
    });

    it("FILE_READ delegates to fileService.readFile", async () => {
      mockReadFile.mockResolvedValue({ content: "hello" });
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.FILE_READ,
        requestId: "r1",
        payload: { path: "/proj/file.txt", directory: "/proj" },
      });

      expect(mockReadFile).toHaveBeenCalledWith("/proj/file.txt", "/proj");
    });

    it("FILE_GIT_STATUS delegates to fileService.getGitStatus", async () => {
      mockGetGitStatus.mockResolvedValue({ files: [] });
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.FILE_GIT_STATUS,
        requestId: "r1",
        payload: { directory: "/proj" },
      });

      expect(mockGetGitStatus).toHaveBeenCalledWith("/proj");
    });

    it("FILE_GIT_DIFF delegates to fileService.getGitDiff", async () => {
      mockGetGitDiff.mockResolvedValue("diff content");
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.FILE_GIT_DIFF,
        requestId: "r1",
        payload: { directory: "/proj", path: "file.txt" },
      });

      expect(mockGetGitDiff).toHaveBeenCalledWith("/proj", "file.txt");
    });

    it("FILE_WATCH delegates to fileService.watchDirectory", async () => {
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.FILE_WATCH,
        requestId: "r1",
        payload: { directory: "/proj" },
      });

      expect(mockWatchDirectory).toHaveBeenCalledWith("/proj");
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload).toEqual({ success: true });
    });

    it("FILE_UNWATCH delegates to fileService.unwatchDirectory", async () => {
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.FILE_UNWATCH,
        requestId: "r1",
        payload: { directory: "/proj" },
      });

      expect(mockUnwatchDirectory).toHaveBeenCalledWith("/proj");
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload).toEqual({ success: true });
    });
  });

  // =========================================================================
  // routeRequest - scheduled tasks
  // =========================================================================

  describe("routeRequest - scheduled tasks", () => {
    it("SCHEDULED_TASK_LIST delegates to scheduledTaskService.list", async () => {
      mockScheduledTaskService.list.mockReturnValue([]);
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.SCHEDULED_TASK_LIST,
        requestId: "r1",
        payload: {},
      });

      expect(mockScheduledTaskService.list).toHaveBeenCalled();
    });

    it("SCHEDULED_TASK_GET delegates with id", async () => {
      mockScheduledTaskService.get.mockReturnValue({ id: "task-1" });
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.SCHEDULED_TASK_GET,
        requestId: "r1",
        payload: { id: "task-1" },
      });

      expect(mockScheduledTaskService.get).toHaveBeenCalledWith("task-1");
    });

    it("SCHEDULED_TASK_CREATE delegates with payload", async () => {
      const taskPayload = { name: "test", cron: "* * * * *" };
      mockScheduledTaskService.create.mockReturnValue({ id: "new-task" });
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.SCHEDULED_TASK_CREATE,
        requestId: "r1",
        payload: taskPayload,
      });

      expect(mockScheduledTaskService.create).toHaveBeenCalledWith(taskPayload);
    });

    it("SCHEDULED_TASK_UPDATE delegates with payload", async () => {
      const taskPayload = { id: "task-1", name: "updated" };
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.SCHEDULED_TASK_UPDATE,
        requestId: "r1",
        payload: taskPayload,
      });

      expect(mockScheduledTaskService.update).toHaveBeenCalledWith(taskPayload);
    });

    it("SCHEDULED_TASK_DELETE delegates with id and returns success", async () => {
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.SCHEDULED_TASK_DELETE,
        requestId: "r1",
        payload: { id: "task-1" },
      });

      expect(mockScheduledTaskService.delete).toHaveBeenCalledWith("task-1");
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload).toEqual({ success: true });
    });

    it("SCHEDULED_TASK_RUN_NOW delegates with id", async () => {
      mockScheduledTaskService.runNow.mockReturnValue({ started: true });
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.SCHEDULED_TASK_RUN_NOW,
        requestId: "r1",
        payload: { id: "task-1" },
      });

      expect(mockScheduledTaskService.runNow).toHaveBeenCalledWith("task-1");
    });
  });

  // =========================================================================
  // routeRequest - unknown type
  // =========================================================================

  describe("routeRequest - unknown type", () => {
    it("responds with UNKNOWN_REQUEST error for unknown request type", async () => {
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: "some.unknown.type",
        requestId: "r1",
        payload: {},
      });

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.error).toEqual({
        code: "UNKNOWN_REQUEST",
        message: "Unknown request type: some.unknown.type",
      });
    });
  });

  // =========================================================================
  // routeRequest - error handling
  // =========================================================================

  describe("routeRequest - error handling", () => {
    it("returns error response when engine method throws", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      engineManager.listEngines.mockImplementation(() => {
        throw new Error("Engine down");
      });

      await sendMessage(ws, {
        type: GatewayRequestType.ENGINE_LIST,
        requestId: "r1",
        payload: {},
      });

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.error).toEqual({
        code: "INTERNAL_ERROR",
        message: "Engine down",
      });
      expect(response.payload).toBeNull();
    });

    it("preserves custom error code from thrown error", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      engineManager.getSession.mockImplementation(() => {
        throw Object.assign(new Error("Not found"), {
          code: "SESSION_NOT_FOUND",
        });
      });

      await sendMessage(ws, {
        type: GatewayRequestType.SESSION_GET,
        requestId: "r1",
        payload: { sessionId: "nonexistent" },
      });

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.error.code).toBe("SESSION_NOT_FOUND");
      expect(response.error.message).toBe("Not found");
    });

    it("returns INTERNAL_ERROR and 'Unknown error' when error has no message", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      engineManager.deleteSession.mockImplementation(() => {
        throw {};
      });

      await sendMessage(ws, {
        type: GatewayRequestType.SESSION_DELETE,
        requestId: "r1",
        payload: { sessionId: "sess-1" },
      });

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.error).toEqual({
        code: "INTERNAL_ERROR",
        message: "Unknown error",
      });
    });

    it("handles async rejection from engine methods", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      engineManager.sendMessage.mockRejectedValue(
        new Error("Timeout sending message"),
      );

      await sendMessage(ws, {
        type: GatewayRequestType.MESSAGE_SEND,
        requestId: "r1",
        payload: { sessionId: "sess-1", content: "Hello" },
      });

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.error.code).toBe("INTERNAL_ERROR");
      expect(response.error.message).toBe("Timeout sending message");
    });
  });

  // =========================================================================
  // broadcast
  // =========================================================================

  describe("broadcast", () => {
    it("sends notification to all authenticated OPEN clients", () => {
      const { connect } = createTestHarness();
      mockRandomUUID.mockReturnValueOnce("c1");
      const ws1 = connect();
      mockRandomUUID.mockReturnValueOnce("c2");
      const ws2 = connect();

      // Trigger a file change to cause a broadcast
      const fileChangeHandler = mockOnFileChange.mock.calls[0][0];
      fileChangeHandler({ type: "change", path: "/a.txt" });

      const expected = JSON.stringify({
        type: GatewayNotificationType.FILE_CHANGED,
        payload: { type: "change", path: "/a.txt" },
      });
      expect(ws1.send).toHaveBeenCalledWith(expected);
      expect(ws2.send).toHaveBeenCalledWith(expected);
    });

    it("skips non-authenticated clients", () => {
      const validator = vi.fn((token: string) => token === "valid");
      const { connect } = createTestHarness({ authValidator: validator });

      // Connect authenticated client
      mockRandomUUID.mockReturnValueOnce("c-auth");
      const wsAuth = connect({ url: "/?token=valid" });

      // Connect unauthenticated client
      mockRandomUUID.mockReturnValueOnce("c-unauth");
      const wsUnauth = connect({ url: "/" });

      // Trigger broadcast
      const fileChangeHandler = mockOnFileChange.mock.calls[0][0];
      fileChangeHandler({ type: "change", path: "/b.txt" });

      expect(wsAuth.send).toHaveBeenCalled();
      expect(wsUnauth.send).not.toHaveBeenCalled();
    });

    it("skips clients whose ws is not OPEN", () => {
      const { server } = createTestHarness();

      // Connect a client with CLOSED readyState
      const closedWs = createMockWs(3); // WebSocket.CLOSED
      wssHandlers["connection"]?.(closedWs, { url: "/" });

      // Trigger broadcast
      const fileChangeHandler = mockOnFileChange.mock.calls[0][0];
      fileChangeHandler({ type: "change", path: "/c.txt" });

      expect(closedWs.send).not.toHaveBeenCalled();
    });

    it("broadcasts engine events via subscribeToEngineEvents", () => {
      const { connect, engineManager } = createTestHarness();
      const ws = connect();

      // Emit an engine event
      engineManager.emit("message.updated", { id: "msg-1", text: "hi" });

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: GatewayNotificationType.MESSAGE_UPDATED,
          payload: { id: "msg-1", text: "hi" },
        }),
      );
    });

    it("broadcasts session.created events", () => {
      const { connect, engineManager } = createTestHarness();
      const ws = connect();

      engineManager.emit("session.created", { id: "sess-new" });

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: GatewayNotificationType.SESSION_CREATED,
          payload: { id: "sess-new" },
        }),
      );
    });

    it("broadcasts permission.asked events", () => {
      const { connect, engineManager } = createTestHarness();
      const ws = connect();

      engineManager.emit("permission.asked", { permissionId: "p-1" });

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: GatewayNotificationType.PERMISSION_ASKED,
          payload: { permissionId: "p-1" },
        }),
      );
    });

    it("broadcasts scheduled task events", () => {
      // scheduledTaskService.on is called during construction.
      // Find the handler for "task.fired" and invoke it.
      const { connect } = createTestHarness();
      const ws = connect();

      const taskFiredCall = mockScheduledTaskService.on.mock.calls.find(
        (call: any[]) => call[0] === "task.fired",
      );
      expect(taskFiredCall).toBeDefined();
      const taskFiredHandler = taskFiredCall![1];
      taskFiredHandler({ taskId: "t-1" });

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: GatewayNotificationType.SCHEDULED_TASK_FIRED,
          payload: { taskId: "t-1" },
        }),
      );
    });
  });

  // =========================================================================
  // sendToClient
  // =========================================================================

  describe("sendToClient", () => {
    it("sends response when ws is OPEN", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      await sendMessage(ws, {
        type: GatewayRequestType.ENGINE_LIST,
        requestId: "r1",
        payload: {},
      });

      expect(ws.send).toHaveBeenCalledOnce();
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.type).toBe("response");
      expect(response.requestId).toBe("r1");
    });

    it("does not send when ws is not OPEN", async () => {
      const { server, engineManager } = createTestHarness();

      // Connect a client with CLOSED readyState
      const ws = createMockWs(3); // CLOSED
      wssHandlers["connection"]?.(ws, { url: "/" });

      // Try sending a request -- the response should not be sent
      const msgHandler = ws._handlers["message"]?.[0];
      if (msgHandler) {
        await msgHandler(
          Buffer.from(
            JSON.stringify({
              type: GatewayRequestType.ENGINE_LIST,
              requestId: "r1",
              payload: {},
            }),
          ),
        );
      }

      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // WSS error handler
  // =========================================================================

  describe("WSS error handler", () => {
    it("logs error via gatewayLog.error", () => {
      createTestHarness();

      const errorHandler = wssHandlers["error"];
      expect(errorHandler).toBeDefined();

      const testError = new Error("test WSS error");
      errorHandler(testError);

      expect(mockGatewayLog.error).toHaveBeenCalledWith(
        "WebSocket server error:",
        testError,
      );
    });
  });
});
