import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage } from "node:http";

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
  resolveConversationId: vi.fn((id: string) => id),
  getConversationIds: vi.fn((id: string) => [id]),
  isConversationAlias: vi.fn(() => false),
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
import type { RemoteAccessStatus } from "../../../../shared/remote-access";
import { isLocalGatewayRequest, isRemoteAccessRequestAllowed } from "../../../../shared/remote-access-policy";

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
    getSessionSharing: vi.fn(() => ({ enabled: false, available: true })),
    setSessionSharing: vi.fn(async () => ({ enabled: true, available: true })),
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => ({ id: "sess-1" })),
    getSession: vi.fn(async () => ({ id: "sess-1" })),
    deleteSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => ({ success: true })),
    setSessionArchived: vi.fn(async () => {}),
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
    getPending: vi.fn(async () => ({ questions: [], permissions: [] })),
    listProjects: vi.fn(async () => []),
    listCatalogs: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    reorderProjects: vi.fn(async () => {}),
    setSessionProject: vi.fn(async () => {}),
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
    terminate: vi.fn(),
    ping: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    once: vi.fn((event: string, handler: (...args: any[]) => void) => {
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
function createTestHarness(options?: ConstructorParameters<typeof GatewayServer>[1]): TestHarness {
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
    mockConversationStore.resolveConversationId.mockImplementation((id: string) => id);
    mockConversationStore.getConversationIds.mockImplementation((id: string) => [id]);
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

  describe("remote access policy", () => {
    function request(host: string, origin?: string, remoteAddress = "192.168.31.2"): IncomingMessage {
      return {
        url: "/ws",
        headers: { host, ...(origin !== undefined ? { origin } : {}) },
        rawHeaders: ["Host", host, ...(origin !== undefined ? ["Origin", origin] : [])],
        socket: { remoteAddress },
      } as IncomingMessage;
    }

    const remoteRequest = () => request("codemux.example:18233", "http://codemux.example:18233");
    const localRequest = () => request("127.0.0.1:4200", "http://localhost:8233", "127.0.0.1");

    function verifyUpgrade(req: IncomingMessage): boolean {
      const done = vi.fn();
      lastWssConstructorArgs.verifyClient({ req }, done);
      return done.mock.calls[0]?.[0] === true;
    }

    it("rejects disabled remote upgrades before authentication on both listeners", () => {
      const engineManager = createMockEngineManager();
      const authValidator = vi.fn(() => true);
      const server = new GatewayServer(engineManager as any, {
        authValidator,
        requestValidator: (req) => isRemoteAccessRequestAllowed(req, { mode: "off", url: "" }, true),
      });
      for (const options of [{ port: 0 }, { server: {} as any, path: "/ws" }]) {
        server.start(options);
        const rejected = vi.fn();
        lastWssConstructorArgs.verifyClient({ req: remoteRequest() }, rejected);
        expect(rejected).toHaveBeenCalledWith(false, 403, "Remote access disabled");
        expect(verifyUpgrade(localRequest())).toBe(true);
        expect(authValidator).not.toHaveBeenCalled();
        server.stop();
      }
    });

    it("fails closed when the admission validator throws", () => {
      const { connect } = createTestHarness({ requestValidator: () => { throw new Error("Unavailable policy"); } });
      expect(verifyUpgrade(remoteRequest())).toBe(false);
      const ws = connect(remoteRequest());
      expect(ws.close).toHaveBeenCalledWith(4003, "Remote access disabled");
      expect(ws.on).not.toHaveBeenCalled();
    });

    it("immediately withdraws authenticated and unauthenticated remote sockets while preserving local clients", async () => {
      let status: Pick<RemoteAccessStatus, "mode" | "url"> = { mode: "custom", url: "http://codemux.example:18233" };
      const { server, connect, sendMessage, engineManager } = createTestHarness({
        authValidator: (token) => token === "device-token",
        requestValidator: (req) => isRemoteAccessRequestAllowed(req, status, true),
      });
      const remote = connect(remoteRequest());
      await sendMessage(remote, { type: "auth", token: "device-token", requestId: "auth" });
      mockRandomUUID.mockReturnValueOnce("remote-pending");
      const pending = connect(remoteRequest());
      mockRandomUUID.mockReturnValueOnce("local-client");
      const local = connect(localRequest());
      await sendMessage(local, { type: "auth", token: "device-token", requestId: "auth" });
      remote.send.mockClear();
      status = { mode: "off", url: "" };

      server.revalidateClients();
      expect(remote.close).toHaveBeenCalledWith(4003, "Remote access disabled");
      expect(pending.close).toHaveBeenCalledWith(4003, "Remote access disabled");
      expect(local.close).not.toHaveBeenCalled();
      await sendMessage(remote, { type: GatewayRequestType.ENGINE_LIST, requestId: "remote", payload: {} });
      expect(engineManager.listEngines).not.toHaveBeenCalled();
      expect(remote.send).not.toHaveBeenCalled();
      await sendMessage(local, { type: GatewayRequestType.ENGINE_LIST, requestId: "local", payload: {} });
      expect(engineManager.listEngines).toHaveBeenCalledOnce();
    });

    it("disconnects the previous entry when switching providers or changing the custom origin", () => {
      let status: Pick<RemoteAccessStatus, "mode" | "url"> = { mode: "custom", url: "http://codemux.example:18233" };
      const { server, connect } = createTestHarness({ requestValidator: (req) => isRemoteAccessRequestAllowed(req, status, true) });
      const remote = connect(remoteRequest());
      status = { mode: "cloudflare", url: "https://codemux.trycloudflare.com" };
      server.revalidateClients();
      expect(remote.close).toHaveBeenCalledWith(4003, "Remote access disabled");
      expect(verifyUpgrade(remoteRequest())).toBe(false);
      expect(verifyUpgrade(request("codemux.trycloudflare.com", "https://codemux.trycloudflare.com"))).toBe(true);
      status = { mode: "custom", url: "http://new.example:18233" };
      expect(verifyUpgrade(remoteRequest())).toBe(false);
    });

    it("rechecks policy before auth frames, broadcasts, and idle keepalive", async () => {
      let allowed = true;
      const validator = vi.fn(() => true);
      const { connect, sendMessage, engineManager } = createTestHarness({ authValidator: validator, requestValidator: () => allowed });
      const remote = connect(remoteRequest());
      await sendMessage(remote, { type: "auth", token: "device-token", requestId: "auth" });
      mockRandomUUID.mockReturnValueOnce("waiting-client");
      const waiting = connect(remoteRequest());
      remote.send.mockClear();
      validator.mockClear();
      allowed = false;
      await sendMessage(waiting, { type: "auth", token: "device-token", requestId: "auth" });
      expect(validator).not.toHaveBeenCalled();
      expect(waiting.send).not.toHaveBeenCalled();
      engineManager.emit("message.updated", { sessionId: "s1", message: { id: "m1" } });
      expect(remote.send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(30_000);
      expect(remote.ping).not.toHaveBeenCalled();
      expect(waiting.ping).not.toHaveBeenCalled();
      expect(remote.close).toHaveBeenCalledWith(4003, "Remote access disabled");
      expect(waiting.close).toHaveBeenCalledWith(4003, "Remote access disabled");
    });

    it("drops a pending response when access is disabled before completion", async () => {
      let allowed = true;
      const { connect, sendMessage, engineManager } = createTestHarness({ requestValidator: () => allowed });
      const remote = connect(remoteRequest());
      let finish!: (message: { id: string }) => void;
      engineManager.sendMessage.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      const pending = sendMessage(remote, {
        type: GatewayRequestType.MESSAGE_SEND,
        requestId: "r1",
        payload: { sessionId: "s1", content: [{ type: "text", text: "hello" }] },
      });
      allowed = false;
      finish({ id: "result" });
      await pending;
      expect(remote.send).not.toHaveBeenCalled();
      expect(remote.close).toHaveBeenCalledWith(4003, "Remote access disabled");
    });

    it("provides the original handshake request when validating private channel tokens", async () => {
      const { connect, sendMessage } = createTestHarness({
        authValidator: (token, req) => token === "internal-token" && req.headers.origin === undefined && isLocalGatewayRequest(req),
      });
      const internalReq = request("127.0.0.1:4200", undefined, "127.0.0.1");
      internalReq.url = "/ws?token=internal-token";
      const channel = connect(internalReq);
      await sendMessage(channel, { type: GatewayRequestType.ENGINE_LIST, requestId: "r1", payload: {} });
      expect(channel.send).toHaveBeenCalled();
      mockRandomUUID.mockReturnValueOnce("local-browser");
      const browser = connect(localRequest());
      await sendMessage(browser, { type: "auth", token: "internal-token", requestId: "auth" });
      expect(browser.close).toHaveBeenCalledWith(4001, "Unauthorized");
      mockRandomUUID.mockReturnValueOnce("remote-channel");
      const remote = connect(request("codemux.example:18233"));
      await sendMessage(remote, { type: "auth", token: "internal-token", requestId: "auth" });
      expect(remote.close).toHaveBeenCalledWith(4001, "Unauthorized");
    });
  });

  // =========================================================================
  // handleMessage - auth flow
  // =========================================================================

  describe("handleMessage - auth flow", () => {
    it("acknowledges the client handshake when authentication is explicitly disabled", async () => {
      const { connect, sendMessage } = createTestHarness();
      const ws = connect();
      await sendMessage(ws, { type: "auth", token: "test-token", requestId: "auth-1" });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
        type: "response", requestId: "auth-1", payload: { authenticated: true },
      }));
      expect(ws.close).not.toHaveBeenCalled();
    });

    it("rejects commands after a query-authenticated device is revoked", async () => {
      let authorized = true;
      const { connect, sendMessage, engineManager } = createTestHarness({
        authValidator: (token) => authorized && token === "device-token",
      });
      const ws = connect({ url: "/ws?token=device-token" });
      authorized = false;

      await sendMessage(ws, { type: GatewayRequestType.ENGINE_LIST, requestId: "r1", payload: {} });

      expect(engineManager.listEngines).not.toHaveBeenCalled();
      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized");
    });

    it("rejects broadcasts after a first-frame authenticated device is revoked", async () => {
      let authorized = true;
      const { connect, sendMessage, engineManager } = createTestHarness({
        authValidator: (token) => authorized && token === "device-token",
      });
      const ws = connect();
      await sendMessage(ws, { type: "auth", token: "device-token", requestId: "auth" });
      ws.send.mockClear();
      authorized = false;

      engineManager.emit("message.updated", { sessionId: "s1", message: { id: "m1" } });

      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized");
    });

    it("drops a pending command response if its device is revoked before completion", async () => {
      let authorized = true;
      const { connect, sendMessage, engineManager } = createTestHarness({ authValidator: () => authorized });
      const ws = connect({ url: "/ws?token=device-token" });
      let finish!: (message: { id: string }) => void;
      engineManager.sendMessage.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      const pending = sendMessage(ws, {
        type: GatewayRequestType.MESSAGE_SEND,
        requestId: "r1",
        payload: { sessionId: "s1", content: [{ type: "text", text: "hello" }] },
      });
      authorized = false;
      finish({ id: "result" });
      await pending;

      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized");
    });

    it("closes revoked idle devices during the keepalive check", () => {
      let authorized = true;
      const { connect } = createTestHarness({ authValidator: () => authorized });
      const ws = connect({ url: "/ws?token=device-token" });
      authorized = false;

      vi.advanceTimersByTime(30_000);

      expect(ws.ping).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized");
    });

    it("blocks private terminal output after device revocation", async () => {
      let authorized = true;
      const { connect } = createTestHarness({ authValidator: () => authorized });
      const ws = connect({ url: "/ws?token=device-token" });
      authorized = false;
      const { getTerminalService } = await import("../../../../electron/main/services/terminal-service");

      getTerminalService().emit("data", { terminalId: "term-1", ownerClientId: "test-client-id", data: "private output" });

      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized");
    });

    it("fails closed when token validation throws", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness({
        authValidator: () => { throw new Error("Store unavailable"); },
      });
      const ws = connect({ url: "/ws?token=device-token" });

      await sendMessage(ws, { type: "auth", token: "device-token" });

      expect(engineManager.listEngines).not.toHaveBeenCalled();
      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized");
    });

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
    it("routes sharing settings through the unified engine and rejects invalid switches", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();
      await sendMessage(ws, { type: GatewayRequestType.ENGINE_SHARING_GET, requestId: "get", payload: { engineType: "codex-desktop" } });
      await sendMessage(ws, { type: GatewayRequestType.ENGINE_SHARING_SET, requestId: "set", payload: { engineType: "codex-desktop", enabled: true } });
      expect(engineManager.getSessionSharing).toHaveBeenCalledExactlyOnceWith("codex");
      expect(engineManager.setSessionSharing).toHaveBeenCalledExactlyOnceWith("codex", true);
      for (const enabled of ["true", 1, null, undefined]) {
        await sendMessage(ws, { type: GatewayRequestType.ENGINE_SHARING_SET, requestId: "invalid", payload: { engineType: "codex", enabled } });
        expect(JSON.parse(ws.send.mock.calls.at(-1)![0]).error.code).toBe("INVALID_PARAMS");
      }
      expect(engineManager.setSessionSharing).toHaveBeenCalledTimes(1);
    });

    it("canonicalizes saved bindings before routing while preserving alias deletion", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      mockConversationStore.resolveConversationId.mockImplementation((id) => id === "old-conv" ? "canonical-conv" : id);
      const ws = connect();
      await sendMessage(ws, { type: GatewayRequestType.MESSAGE_SEND, requestId: "send", payload: { sessionId: "old-conv", content: [] } });
      await sendMessage(ws, { type: GatewayRequestType.PENDING_LIST, requestId: "pending", payload: { sessionId: "old-conv" } });
      await sendMessage(ws, { type: GatewayRequestType.SESSION_DELETE, requestId: "delete", payload: { sessionId: "old-conv" } });
      await sendMessage(ws, { type: GatewayRequestType.SESSION_CREATE, requestId: "create", payload: { engineType: "codex-desktop", directory: "/cwd", projectId: "catalog:codex-desktop:source:project" } });
      expect(engineManager.sendMessage.mock.calls[0][0]).toBe("canonical-conv");
      expect(engineManager.getPending).toHaveBeenCalledWith("canonical-conv");
      expect(engineManager.deleteSession).toHaveBeenCalledExactlyOnceWith("old-conv");
      expect(engineManager.createSession).toHaveBeenCalledExactlyOnceWith("codex", "/cwd", undefined, "catalog:codex:source:project");
    });
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

    it.each([true, false])("SESSION_ARCHIVE delegates archived=%s", async (archived) => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();
      await sendMessage(ws, { type: GatewayRequestType.SESSION_ARCHIVE, requestId: "archive", payload: { sessionId: "s1", archived } });
      expect(engineManager.setSessionArchived).toHaveBeenCalledWith("s1", archived);
    });

    it.each([{}, { sessionId: "s1", archived: "true" }, { sessionId: "", archived: true }])("SESSION_ARCHIVE rejects invalid payloads", async (payload) => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();
      await sendMessage(ws, { type: GatewayRequestType.SESSION_ARCHIVE, requestId: "archive", payload });
      expect(engineManager.setSessionArchived).not.toHaveBeenCalled();
      expect(JSON.parse(ws.send.mock.calls[0][0]).error.code).toBe("INVALID_PARAMS");
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

    it("SESSION_CONFIG_UPDATE rejects invalid reasoning effort and service tier values", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();

      // Authenticate the connection so requests are processed
      ws.authenticated = true;

      // Invalid reasoningEffort
      await sendMessage(ws, {
        type: GatewayRequestType.SESSION_CONFIG_UPDATE,
        requestId: "r2",
        payload: {
          sessionId: "sess-1",
          config: { reasoningEffort: "bogus" },
        },
      });
      expect(ws.send).toHaveBeenCalled();
      const resp1 = JSON.parse(ws.send.mock.calls[ws.send.mock.calls.length - 1][0]);
      expect(resp1.error?.code).toBe("INVALID_REASONING_EFFORT");
      expect(engineManager.updateSessionConfig).not.toHaveBeenCalled();

      ws.send.mockClear();

      // Invalid serviceTier
      await sendMessage(ws, {
        type: GatewayRequestType.SESSION_CONFIG_UPDATE,
        requestId: "r3",
        payload: {
          sessionId: "sess-1",
          config: { serviceTier: "invalid" },
        },
      });
      const resp2 = JSON.parse(ws.send.mock.calls[ws.send.mock.calls.length - 1][0]);
      expect(resp2.error?.code).toBe("INVALID_SERVICE_TIER");
      expect(engineManager.updateSessionConfig).not.toHaveBeenCalled();
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

    it("CATALOG_LIST returns mapped projects and sessions including empty sources", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();
      const catalogs = [
        { sourceId: "source-a", engineType: "codex-desktop", revision: "1", complete: true, projects: [], sessions: [] },
        { sourceId: "source-b", engineType: "other-engine", revision: "2", complete: true,
          projects: [{ id: "catalog-project-b", catalogProjectId: "native-project", directory: "/repo" }],
          sessions: [{ id: "codemux-conversation", projectId: "catalog-project-b" }] },
      ];
      engineManager.listCatalogs.mockReturnValue(catalogs);
      await sendMessage(ws, { type: GatewayRequestType.CATALOG_LIST, requestId: "catalog" });
      expect(engineManager.listCatalogs).toHaveBeenCalledOnce();
      expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({ type: "response", requestId: "catalog", payload: catalogs });
    });

    it("PROJECT_CREATE forwards the source and roots and returns the confirmed stable project", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();
      const payload = { sourceId: "source-a", name: "New project", roots: ["/repo", "/another-root"] };
      const confirmed = { id: "catalog-project-a", name: payload.name, directory: "/repo", roots: payload.roots, catalogProjectId: "native-a" };
      engineManager.createProject.mockResolvedValue(confirmed);
      await sendMessage(ws, { type: GatewayRequestType.PROJECT_CREATE, requestId: "create-project", payload });
      expect(engineManager.createProject).toHaveBeenCalledExactlyOnceWith("source-a", { name: payload.name, roots: payload.roots });
      expect(JSON.parse(ws.send.mock.calls[0][0]).payload).toEqual(confirmed);
    });

    it("PROJECT_UPDATE preserves omitted fields and delegates with the stable project ID", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();
      const patch = { name: "Renamed project" };
      engineManager.updateProject.mockResolvedValue({ id: "catalog-project-a", ...patch });
      await sendMessage(ws, { type: GatewayRequestType.PROJECT_UPDATE, requestId: "update-project", payload: { projectId: "catalog-project-a", patch } });
      expect(engineManager.updateProject).toHaveBeenCalledExactlyOnceWith("catalog-project-a", patch);
      expect(JSON.parse(ws.send.mock.calls[0][0]).payload).toEqual({ id: "catalog-project-a", ...patch });
    });

    it("PROJECT_REORDER preserves the requested stable ID order and confirms completion", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();
      const projectIds = ["catalog-project-b", "catalog-project-a"];
      await sendMessage(ws, { type: GatewayRequestType.PROJECT_REORDER, requestId: "reorder", payload: { sourceId: "source-a", projectIds } });
      expect(engineManager.reorderProjects).toHaveBeenCalledExactlyOnceWith("source-a", projectIds);
      expect(JSON.parse(ws.send.mock.calls[0][0]).payload).toEqual({ success: true });
    });

    it.each(["catalog-project-a", null])("SESSION_PROJECT_SET preserves assignment %s without changing the directory", async (projectId) => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();
      await sendMessage(ws, { type: GatewayRequestType.SESSION_PROJECT_SET, requestId: "assign", payload: { sessionId: "codemux-conversation", projectId } });
      expect(engineManager.setSessionProject).toHaveBeenCalledExactlyOnceWith("codemux-conversation", projectId);
      expect(engineManager.createSession).not.toHaveBeenCalled();
      expect(engineManager.setProjectEngine).not.toHaveBeenCalled();
    });

    it.each(["catalog-project-a", null])("SESSION_CREATE forwards explicit project assignment %s as the fourth argument", async (projectId) => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();
      await sendMessage(ws, { type: GatewayRequestType.SESSION_CREATE, requestId: "create", payload: { engineType: "codex-desktop", directory: "/cwd", projectId } });
      expect(engineManager.createSession).toHaveBeenCalledExactlyOnceWith("codex", "/cwd", undefined, projectId);
    });

    it.each([
      { type: GatewayRequestType.PROJECT_CREATE, payload: { sourceId: "s", name: "", roots: ["/repo"] }, method: "createProject" },
      { type: GatewayRequestType.PROJECT_CREATE, payload: { sourceId: "s", name: "Name", roots: "/repo" }, method: "createProject" },
      { type: GatewayRequestType.PROJECT_UPDATE, payload: { projectId: "p", patch: {} }, method: "updateProject" },
      { type: GatewayRequestType.PROJECT_UPDATE, payload: { projectId: "p", patch: { roots: [42] } }, method: "updateProject" },
      { type: GatewayRequestType.PROJECT_UPDATE, payload: { projectId: "p", patch: { directory: "/changed" } }, method: "updateProject" },
      { type: GatewayRequestType.PROJECT_REORDER, payload: { sourceId: "s", projectIds: ["p", "p"] }, method: "reorderProjects" },
      { type: GatewayRequestType.SESSION_PROJECT_SET, payload: { sessionId: "s" }, method: "setSessionProject" },
      { type: GatewayRequestType.SESSION_PROJECT_SET, payload: { sessionId: "s", projectId: false }, method: "setSessionProject" },
      { type: GatewayRequestType.SESSION_CREATE, payload: { directory: "/cwd", projectId: 1 }, method: "createSession" },
      { type: GatewayRequestType.PROJECT_DELETE, payload: { projectId: "" }, method: "deleteProject" },
    ])("rejects malformed $type before calling $method", async ({ type, payload, method }) => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();
      await sendMessage(ws, { type, requestId: "invalid", payload });
      expect(engineManager[method as keyof typeof engineManager]).not.toHaveBeenCalled();
      expect(JSON.parse(ws.send.mock.calls[0][0]).error.code).toBe("INVALID_PARAMS");
    });

    it("does not report project deletion success when the native empty-project check rejects it", async () => {
      const { connect, sendMessage, engineManager } = createTestHarness();
      const ws = connect();
      engineManager.deleteProject.mockRejectedValue(new Error("The project contains conversations"));
      await sendMessage(ws, { type: GatewayRequestType.PROJECT_DELETE, requestId: "delete", payload: { projectId: "catalog-project-a" } });
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.error).toBeDefined();
      expect(response.payload?.success).not.toBe(true);
      expect(engineManager.deleteProject).toHaveBeenCalledExactlyOnceWith("catalog-project-a");
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
    it("adds alias metadata once without changing canonical or native interaction identities", () => {
      const { connect, engineManager } = createTestHarness();
      mockConversationStore.getConversationIds.mockImplementation((id) => id === "canonical" ? [id, "old-cli", "old-desktop"] : [id]);
      const ws = connect();
      engineManager.emit("message.updated", { sessionId: "canonical", message: { id: "native-message", sessionId: "canonical", parts: [] } });
      engineManager.emit("question.replied", { sessionId: "canonical", questionId: "native-question", answers: [["Yes"]] });
      engineManager.emit("permission.replied", { sessionId: "canonical", permissionId: "native-permission", optionId: "allow_once" });
      const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw).payload);
      expect(payloads).toHaveLength(3);
      expect(payloads.every((payload) => payload.sessionId === "canonical")).toBe(true);
      expect(payloads.map((payload) => payload.conversationAliases)).toEqual(Array(3).fill(["old-cli", "old-desktop"]));
      expect(payloads[0].message.id).toBe("native-message");
      expect(payloads[1].questionId).toBe("native-question");
      expect(payloads[2].permissionId).toBe("native-permission");
    });

    it("retains removal aliases after the conversation was removed from storage", () => {
      const { connect, engineManager } = createTestHarness();
      const ws = connect();
      engineManager.emit("session.removed", { sessionId: "canonical", conversationAliases: ["old-conv"], title: "Excluded" });
      expect(JSON.parse(ws.send.mock.calls[0][0]).payload).toEqual({ sessionId: "canonical", conversationAliases: ["old-conv"] });
    });
    it("broadcasts only mapped removal identity to currently authorized clients", () => {
      let authorized = true;
      const { connect, engineManager } = createTestHarness({ authValidator: (token) => token === "valid" && authorized });
      mockRandomUUID.mockReturnValueOnce("removed-auth");
      const ws = connect({ url: "/ws?token=valid" });
      mockRandomUUID.mockReturnValueOnce("removed-unauth");
      const unauthenticated = connect({ url: "/ws" });
      engineManager.emit("session.removed", { sessionId: "codemux-conversation", title: "Must not leak", archived: true });
      expect(ws.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
        type: GatewayNotificationType.SESSION_REMOVED, payload: { sessionId: "codemux-conversation" },
      }));
      expect(unauthenticated.send).not.toHaveBeenCalled();
      ws.send.mockClear();
      authorized = false;
      engineManager.emit("session.removed", { sessionId: "codemux-conversation" });
      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized");
    });

    it("forwards message removal without changing its session identity", () => {
      const { connect, engineManager } = createTestHarness();
      const ws = connect();
      const payload = { sessionId: "s1", messageId: "m1" };
      engineManager.emit("message.removed", payload);

      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: GatewayNotificationType.MESSAGE_REMOVED, payload }));
    });

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

    it("broadcasts catalog snapshots unchanged only while the device remains authorized", () => {
      let authorized = true;
      const { connect, engineManager } = createTestHarness({ authValidator: (token) => token === "catalog-token" && authorized });
      const ws = connect({ url: "/ws?token=catalog-token" });
      const snapshot = { sourceId: "source-a", revision: "2", complete: true, engineType: "codex-desktop",
        projects: [{ id: "catalog-project-a", catalogProjectId: "native-project-a", directory: "/root" }],
        sessions: [{ id: "codemux-conversation-a", projectId: "catalog-project-a" }] };
      engineManager.emit("catalog.updated", snapshot);
      expect(ws.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: GatewayNotificationType.CATALOG_UPDATED, payload: snapshot }));
      ws.send.mockClear();
      authorized = false;
      engineManager.emit("catalog.updated", snapshot);
      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized");
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
