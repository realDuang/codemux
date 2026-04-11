// ============================================================================
// OpenCode Adapter — Comprehensive Unit Tests
// ============================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mock variables ---

const {
  mockCreateOpencodeClient,
  mockCreateOpencodeServer,
  mockFetchVersion,
  mockKillOrphanedProcess,
  mockConvertSession,
  mockConvertMessage,
  mockConvertPart,
  mockConvertProviders,
} = vi.hoisted(() => ({
  mockCreateOpencodeClient: vi.fn(),
  mockCreateOpencodeServer: vi.fn(),
  mockFetchVersion: vi.fn(),
  mockKillOrphanedProcess: vi.fn(),
  mockConvertSession: vi.fn(),
  mockConvertMessage: vi.fn(),
  mockConvertPart: vi.fn(),
  mockConvertProviders: vi.fn(),
}));

// --- Module mocks ---

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: mockCreateOpencodeClient,
}));

vi.mock("../../../../../electron/main/engines/opencode/server", () => ({
  createOpencodeServer: mockCreateOpencodeServer,
  fetchVersion: mockFetchVersion,
  killOrphanedProcess: mockKillOrphanedProcess,
  createStreamErrorHandler: vi.fn(() => vi.fn()),
}));

vi.mock("../../../../../electron/main/services/logger", () => ({
  openCodeLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../../../../electron/main/engines/opencode/converters", () => ({
  convertSession: mockConvertSession,
  convertMessage: mockConvertMessage,
  convertPart: mockConvertPart,
  convertProviders: mockConvertProviders,
}));

import { OpenCodeAdapter } from "../../../../../electron/main/engines/opencode/index";

// --- Helper factories ---

function createMockClient() {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ data: null, error: null }),
      list: vi.fn().mockResolvedValue({ data: [], error: null }),
      get: vi.fn().mockResolvedValue({ data: null, error: null }),
      delete: vi.fn().mockResolvedValue({ data: null, error: null }),
      messages: vi.fn().mockResolvedValue({ data: [], error: null }),
      abort: vi.fn().mockResolvedValue({ data: null, error: null }),
      promptAsync: vi.fn().mockResolvedValue({ data: null, error: null }),
      command: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    provider: {
      list: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    project: {
      list: vi.fn().mockResolvedValue({ data: [], error: null }),
    },
    command: {
      list: vi.fn().mockResolvedValue({ data: [], error: null }),
    },
    global: {
      event: vi.fn().mockResolvedValue({ stream: (async function* () {})() }),
      health: vi.fn().mockResolvedValue({ data: true }),
    },
    question: {
      reply: vi.fn().mockResolvedValue({ data: null, error: null }),
      reject: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    permission: {
      reply: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
}

function createAdapterWithClient() {
  const mockClient = createMockClient();
  mockCreateOpencodeClient.mockReturnValue(mockClient);
  const adapter = new OpenCodeAdapter({ port: 6969 });
  (adapter as any).client = mockClient;
  (adapter as any).status = "running";
  return { adapter, client: mockClient };
}

function seedSession(
  adapter: OpenCodeAdapter,
  options?: { sessionId?: string; directory?: string; title?: string },
) {
  const sessionId = options?.sessionId ?? "session-1";
  const directory = options?.directory ?? "/repo";
  const title = options?.title ?? "Test Session";
  const session = {
    id: sessionId,
    engineType: "opencode" as const,
    directory,
    title,
    time: { created: 1000, updated: 2000 },
  };
  (adapter as any).sessions.set(sessionId, session);
  return { sessionId, directory, session };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// =============================================================================
// Tests
// =============================================================================

describe("OpenCodeAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Converter mocks with dynamic implementations that mirror source behaviour
    mockConvertSession.mockImplementation((_engineType: string, sdk: any) => ({
      id: sdk.id,
      engineType: "opencode",
      directory: (sdk.directory ?? "/repo").replaceAll("\\", "/"),
      title: sdk.title ?? "Session",
      time: { created: sdk.time?.created ?? 1000, updated: sdk.time?.updated ?? 2000 },
    }));

    mockConvertMessage.mockImplementation((_engineType: string, sdk: any, _pricing?: any) => ({
      id: sdk.id ?? "msg-1",
      sessionId: sdk.sessionID ?? "session-1",
      role: sdk.role ?? "assistant",
      time: {
        created: sdk.time?.created ?? 1000,
        completed: sdk.time?.completed,
      },
      parts: [],
      error: sdk.error
        ? (typeof sdk.error === "string" ? sdk.error : sdk.error.message ?? sdk.error.name ?? "Error")
        : undefined,
    }));

    mockConvertPart.mockImplementation((_engineType: string, sdk: any) => ({
      id: sdk.id ?? "part-1",
      messageId: sdk.messageID ?? "msg-1",
      sessionId: sdk.sessionID ?? "session-1",
      type: sdk.type ?? "text",
      text: sdk.text ?? "",
    }));

    mockConvertProviders.mockReturnValue([]);

    // Server mocks
    mockKillOrphanedProcess.mockResolvedValue(undefined);
    mockCreateOpencodeServer.mockResolvedValue({
      url: "http://127.0.0.1:6969",
      close: vi.fn().mockResolvedValue(undefined),
    });
    mockFetchVersion.mockResolvedValue("opencode 0.1.0");

    // Default client factory
    mockCreateOpencodeClient.mockReturnValue(createMockClient());
  });

  // ===========================================================================
  // A. Client Management
  // ===========================================================================

  describe("Client Management", () => {
    it("ensureClient creates client lazily using currentDirectory", () => {
      const adapter = new OpenCodeAdapter({ port: 6969 });
      (adapter as any).currentDirectory = "/repo";
      const mockClient = createMockClient();
      mockCreateOpencodeClient.mockReturnValue(mockClient);

      const result = (adapter as any).ensureClient();

      expect(mockCreateOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: "http://127.0.0.1:6969", directory: "/repo" }),
      );
      expect(result).toBe(mockClient);
    });

    it("ensureClient returns the same cached instance on subsequent calls", () => {
      const adapter = new OpenCodeAdapter({ port: 6969 });
      const mockClient = createMockClient();
      mockCreateOpencodeClient.mockReturnValue(mockClient);

      const first = (adapter as any).ensureClient();
      const second = (adapter as any).ensureClient();

      expect(mockCreateOpencodeClient).toHaveBeenCalledTimes(1);
      expect(first).toBe(second);
    });

    it("ensureClient creates client without directory when currentDirectory is null", () => {
      const adapter = new OpenCodeAdapter({ port: 6969 });
      // currentDirectory is null by default

      (adapter as any).ensureClient();

      // Should be called with baseUrl only (no directory key)
      const callArg = mockCreateOpencodeClient.mock.calls[0][0];
      expect(callArg.baseUrl).toBe("http://127.0.0.1:6969");
      expect(callArg.directory).toBeUndefined();
    });

    it("switchDirectory recreates client when directory changes", () => {
      const adapter = new OpenCodeAdapter({ port: 6969 });
      const clientA = createMockClient();
      const clientB = createMockClient();
      mockCreateOpencodeClient.mockReturnValueOnce(clientA).mockReturnValueOnce(clientB);

      (adapter as any).switchDirectory("/repo-a");
      expect((adapter as any).currentDirectory).toBe("/repo-a");
      expect((adapter as any).client).toBe(clientA);

      (adapter as any).switchDirectory("/repo-b");
      expect((adapter as any).currentDirectory).toBe("/repo-b");
      expect((adapter as any).client).toBe(clientB);
    });

    it("switchDirectory no-ops when directory is unchanged and client already exists", () => {
      const adapter = new OpenCodeAdapter({ port: 6969 });
      const existingClient = createMockClient();
      (adapter as any).currentDirectory = "/repo";
      (adapter as any).client = existingClient;

      (adapter as any).switchDirectory("/repo");

      expect(mockCreateOpencodeClient).not.toHaveBeenCalled();
      expect((adapter as any).client).toBe(existingClient);
    });

    it("clientForSession creates a directory-scoped client when session has a directory", () => {
      const { adapter } = createAdapterWithClient();
      seedSession(adapter, { sessionId: "s-1", directory: "/project-a" });

      const freshClient = createMockClient();
      mockCreateOpencodeClient.mockReturnValue(freshClient);

      const result = (adapter as any).clientForSession("s-1");

      expect(mockCreateOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({ directory: "/project-a" }),
      );
      expect(result).toBe(freshClient);
    });

    it("clientForSession falls back to ensureClient when session is unknown", () => {
      const { adapter, client } = createAdapterWithClient();

      const result = (adapter as any).clientForSession("unknown-session");

      expect(result).toBe(client);
    });

    it("clientForSession falls back to ensureClient when session has no directory", () => {
      const { adapter, client } = createAdapterWithClient();
      (adapter as any).sessions.set("s-no-dir", { id: "s-no-dir", engineType: "opencode" });

      const result = (adapter as any).clientForSession("s-no-dir");

      expect(result).toBe(client);
    });
  });

  // ===========================================================================
  // B. SSE Event Dispatch
  // ===========================================================================

  describe("SSE Event Dispatch (handleSdkEvent)", () => {
    it("routes message.part.updated to handlePartUpdated", () => {
      const { adapter } = createAdapterWithClient();
      const spy = vi.spyOn(adapter as any, "handlePartUpdated");
      const part = { type: "text", id: "p-1", messageID: "m-1", sessionID: "s-1" };

      (adapter as any).handleSdkEvent({ type: "message.part.updated", properties: { part } });

      expect(spy).toHaveBeenCalledWith(part);
    });

    it("routes message.part.delta to handlePartDelta", () => {
      const { adapter } = createAdapterWithClient();
      const spy = vi.spyOn(adapter as any, "handlePartDelta");
      const props = { sessionID: "s-1", messageID: "m-1", partID: "p-1", field: "text", delta: "hi" };

      (adapter as any).handleSdkEvent({ type: "message.part.delta", properties: props });

      expect(spy).toHaveBeenCalledWith(props);
    });

    it("routes message.updated to handleMessageUpdated", () => {
      const { adapter } = createAdapterWithClient();
      const spy = vi.spyOn(adapter as any, "handleMessageUpdated");
      const info = { id: "m-1", sessionID: "s-1", role: "assistant" };

      (adapter as any).handleSdkEvent({ type: "message.updated", properties: { info } });

      expect(spy).toHaveBeenCalledWith(info);
    });

    it("routes session.updated and emits session.updated event", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("session.updated", (e) => events.push(e));
      const sdkSession = { id: "s-1", directory: "/repo", title: "My Session", time: { created: 1, updated: 2 } };

      (adapter as any).handleSdkEvent({ type: "session.updated", properties: { info: sdkSession } });

      expect(mockConvertSession).toHaveBeenCalledWith("opencode", sdkSession);
      expect(events).toHaveLength(1);
      expect(events[0].session.id).toBe("s-1");
    });

    it("routes session.created and emits session.created event", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("session.created", (e) => events.push(e));
      const sdkSession = { id: "s-new", directory: "/project", time: { created: 1, updated: 2 } };

      (adapter as any).handleSdkEvent({ type: "session.created", properties: { info: sdkSession } });

      expect(events).toHaveLength(1);
      expect(events[0].session.id).toBe("s-new");
    });

    it("routes permission.asked to handlePermissionAsked", () => {
      const { adapter } = createAdapterWithClient();
      const spy = vi.spyOn(adapter as any, "handlePermissionAsked");
      const props = { id: "perm-1", sessionID: "s-1", type: "write" };

      (adapter as any).handleSdkEvent({ type: "permission.asked", properties: props });

      expect(spy).toHaveBeenCalledWith(props);
    });

    it("routes permission.replied and emits permission.replied", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("permission.replied", (e) => events.push(e));

      (adapter as any).handleSdkEvent({
        type: "permission.replied",
        properties: { permissionID: "perm-1", response: "once" },
      });

      expect(events).toHaveLength(1);
      expect(events[0].permissionId).toBe("perm-1");
      expect(events[0].optionId).toBe("once");
    });

    it("routes question.asked to handleQuestionAsked", () => {
      const { adapter } = createAdapterWithClient();
      const spy = vi.spyOn(adapter as any, "handleQuestionAsked");
      const props = { id: "q-1", sessionID: "s-1", questions: [] };

      (adapter as any).handleSdkEvent({ type: "question.asked", properties: props });

      expect(spy).toHaveBeenCalledWith(props);
    });

    it("routes question.replied and emits question.replied with answers", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("question.replied", (e) => events.push(e));

      (adapter as any).handleSdkEvent({
        type: "question.replied",
        properties: { requestID: "q-1", answers: [["yes"]] },
      });

      expect(events).toHaveLength(1);
      expect(events[0].questionId).toBe("q-1");
      expect(events[0].answers).toEqual([["yes"]]);
    });

    it("routes question.rejected and emits question.replied with empty answers", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("question.replied", (e) => events.push(e));

      (adapter as any).handleSdkEvent({
        type: "question.rejected",
        properties: { requestID: "q-rejected" },
      });

      expect(events).toHaveLength(1);
      expect(events[0].questionId).toBe("q-rejected");
      expect(events[0].answers).toEqual([]);
    });

    it("routes session.status to handleSessionStatus", () => {
      const { adapter } = createAdapterWithClient();
      const spy = vi.spyOn(adapter as any, "handleSessionStatus");
      const props = { sessionID: "s-1", status: { type: "idle" } };

      (adapter as any).handleSdkEvent({ type: "session.status", properties: props });

      expect(spy).toHaveBeenCalledWith(props);
    });

    it("routes session.idle to handleSessionIdleEvent", () => {
      const { adapter } = createAdapterWithClient();
      const spy = vi.spyOn(adapter as any, "handleSessionIdleEvent");

      (adapter as any).handleSdkEvent({ type: "session.idle", properties: { sessionID: "s-1" } });

      expect(spy).toHaveBeenCalledWith({ sessionID: "s-1" });
    });
  });

  // ===========================================================================
  // B2. handlePartUpdated
  // ===========================================================================

  describe("handlePartUpdated", () => {
    it("skips emission for parts belonging to user messages", () => {
      const { adapter } = createAdapterWithClient();
      const emitSpy = vi.spyOn(adapter, "emit");
      (adapter as any).userMessageIds.set("session-1", new Set(["user-msg-1"]));

      (adapter as any).handlePartUpdated({
        type: "text",
        id: "part-1",
        messageID: "user-msg-1",
        sessionID: "session-1",
      });

      expect(emitSpy).not.toHaveBeenCalledWith("message.part.updated", expect.anything());
    });

    it("caches SDK parts by partID for delta accumulation", () => {
      const { adapter } = createAdapterWithClient();
      const sdkPart = { type: "text", id: "part-42", messageID: "msg-1", sessionID: "s-1", text: "Hello" };

      (adapter as any).handlePartUpdated(sdkPart);

      const cached = (adapter as any).partCache.get("part-42");
      expect(cached).toBeDefined();
      expect(cached.text).toBe("Hello");
    });

    it("emits message.part.updated with converted part and correct IDs", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("message.part.updated", (e) => events.push(e));
      const sdkPart = { type: "text", id: "p-1", messageID: "m-1", sessionID: "s-1", text: "Content" };

      (adapter as any).handlePartUpdated(sdkPart);

      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe("s-1");
      expect(events[0].messageId).toBe("m-1");
      expect(mockConvertPart).toHaveBeenCalledWith("opencode", sdkPart);
    });

    it("clears the first-event timer when the first SSE part event arrives", () => {
      const { adapter } = createAdapterWithClient();
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      const timerId = setTimeout(() => {}, 30_000);

      (adapter as any).pendingMessages.set("session-1", [{
        resolve: vi.fn(),
        messageId: null,
        assistantParts: [],
        firstEventTimer: timerId,
        promptSent: true,
      }]);

      (adapter as any).handlePartUpdated({
        type: "text",
        id: "p-1",
        messageID: "m-1",
        sessionID: "session-1",
      });

      expect(clearSpy).toHaveBeenCalledWith(timerId);
      clearSpy.mockRestore();
    });

    it("sets pending messageId when a step-start part arrives", () => {
      const { adapter } = createAdapterWithClient();
      (adapter as any).pendingMessages.set("session-1", [{
        resolve: vi.fn(),
        messageId: null,
        assistantParts: [],
        firstEventTimer: null,
        promptSent: true,
      }]);

      (adapter as any).handlePartUpdated({
        type: "step-start",
        id: "p-start",
        messageID: "msg-42",
        sessionID: "session-1",
      });

      const entry = (adapter as any).pendingMessages.get("session-1")[0];
      expect(entry.messageId).toBe("msg-42");
    });

    it("accumulates assistant parts in the pending entry", () => {
      const { adapter } = createAdapterWithClient();
      const entry = {
        resolve: vi.fn(),
        messageId: "msg-42",
        assistantParts: [] as any[],
        firstEventTimer: null,
        promptSent: true,
      };
      (adapter as any).pendingMessages.set("session-1", [entry]);

      mockConvertPart.mockReturnValue({
        id: "p-text",
        messageId: "msg-42",
        sessionId: "session-1",
        type: "text",
        text: "Hello",
      });

      (adapter as any).handlePartUpdated({
        type: "text",
        id: "p-text",
        messageID: "msg-42",
        sessionID: "session-1",
      });

      expect(entry.assistantParts).toHaveLength(1);
      expect(entry.assistantParts[0].id).toBe("p-text");
    });

    it("replaces an existing part in the pending entry when IDs match (upsert)", () => {
      const { adapter } = createAdapterWithClient();
      const existingPart = { id: "p-tool", type: "tool", messageId: "msg-1", sessionId: "s-1" };
      const entry = {
        resolve: vi.fn(),
        messageId: "msg-1",
        assistantParts: [existingPart] as any[],
        firstEventTimer: null,
        promptSent: true,
      };
      (adapter as any).pendingMessages.set("s-1", [entry]);

      mockConvertPart.mockReturnValue({
        id: "p-tool",
        type: "tool",
        messageId: "msg-1",
        sessionId: "s-1",
        updated: true,
      });

      (adapter as any).handlePartUpdated({
        type: "tool",
        id: "p-tool",
        messageID: "msg-1",
        sessionID: "s-1",
      });

      expect(entry.assistantParts).toHaveLength(1);
      expect((entry.assistantParts[0] as any).updated).toBe(true);
    });
  });

  // ===========================================================================
  // B3. handlePartDelta
  // ===========================================================================

  describe("handlePartDelta", () => {
    it("skips deltas for user message parts", () => {
      const { adapter } = createAdapterWithClient();
      const emitSpy = vi.spyOn(adapter, "emit");
      (adapter as any).userMessageIds.set("s-1", new Set(["user-msg-1"]));

      (adapter as any).handlePartDelta({
        sessionID: "s-1",
        messageID: "user-msg-1",
        partID: "p-1",
        field: "text",
        delta: "ignored delta",
      });

      expect(emitSpy).not.toHaveBeenCalledWith("message.part.updated", expect.anything());
    });

    it("skips processing when sessionID or partID is missing", () => {
      const { adapter } = createAdapterWithClient();
      const emitSpy = vi.spyOn(adapter, "emit");

      (adapter as any).handlePartDelta({ sessionID: "", messageID: "m-1", partID: "p-1", field: "text", delta: "x" });
      (adapter as any).handlePartDelta({ sessionID: "s-1", messageID: "m-1", partID: "", field: "text", delta: "x" });

      expect(emitSpy).not.toHaveBeenCalled();
    });

    it("creates a text placeholder when part is not cached yet and field is 'text'", () => {
      const { adapter } = createAdapterWithClient();

      (adapter as any).handlePartDelta({
        sessionID: "s-1",
        messageID: "m-1",
        partID: "p-new",
        field: "text",
        delta: "Hello",
      });

      const cached = (adapter as any).partCache.get("p-new");
      expect(cached).toBeDefined();
      expect(cached.type).toBe("text");
      expect(cached.text).toBe("Hello");
    });

    it("creates a reasoning placeholder when field is 'reasoning'", () => {
      const { adapter } = createAdapterWithClient();

      (adapter as any).handlePartDelta({
        sessionID: "s-1",
        messageID: "m-1",
        partID: "p-reason",
        field: "reasoning",
        delta: "Think...",
      });

      const cached = (adapter as any).partCache.get("p-reason");
      expect(cached.type).toBe("reasoning");
      expect(cached.reasoning).toBe("Think...");
    });

    it("appends delta to an already cached part field", () => {
      const { adapter } = createAdapterWithClient();
      (adapter as any).partCache.set("p-1", { type: "text", id: "p-1", text: "Hello" });

      (adapter as any).handlePartDelta({
        sessionID: "s-1",
        messageID: "m-1",
        partID: "p-1",
        field: "text",
        delta: " world",
      });

      const cached = (adapter as any).partCache.get("p-1");
      expect(cached.text).toBe("Hello world");
    });

    it("sets a new field from delta when the field doesn't exist on cached part", () => {
      const { adapter } = createAdapterWithClient();
      (adapter as any).partCache.set("p-1", { type: "text", id: "p-1" });

      (adapter as any).handlePartDelta({
        sessionID: "s-1",
        messageID: "m-1",
        partID: "p-1",
        field: "customField",
        delta: "initial",
      });

      const cached = (adapter as any).partCache.get("p-1");
      expect((cached as any).customField).toBe("initial");
    });

    it("re-emits as message.part.updated with accumulated content", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("message.part.updated", (e) => events.push(e));

      (adapter as any).handlePartDelta({
        sessionID: "s-1",
        messageID: "m-1",
        partID: "p-stream",
        field: "text",
        delta: "Streaming text",
      });

      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe("s-1");
      expect(events[0].messageId).toBe("m-1");
      expect(mockConvertPart).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // B4. handleMessageUpdated
  // ===========================================================================

  describe("handleMessageUpdated", () => {
    it("skips processing when sessionID is missing", () => {
      const { adapter } = createAdapterWithClient();
      const emitSpy = vi.spyOn(adapter, "emit");

      (adapter as any).handleMessageUpdated({ id: "msg-1", role: "assistant", time: {} });

      expect(emitSpy).not.toHaveBeenCalled();
    });

    it("tracks user message IDs per session", () => {
      const { adapter } = createAdapterWithClient();

      (adapter as any).handleMessageUpdated({ id: "user-msg-1", sessionID: "s-1", role: "user", time: {} });

      const userIds = (adapter as any).userMessageIds.get("s-1");
      expect(userIds?.has("user-msg-1")).toBe(true);
    });

    it("records the primary user message ID without emitting queued.consumed", () => {
      const { adapter } = createAdapterWithClient();
      (adapter as any).pendingMessages.set("s-1", [
        { resolve: vi.fn(), messageId: null, assistantParts: [], firstEventTimer: null, promptSent: true },
        { resolve: vi.fn(), messageId: null, assistantParts: [], firstEventTimer: null, promptSent: true },
      ]);
      const events: any[] = [];
      adapter.on("message.queued.consumed", (e) => events.push(e));

      (adapter as any).handleMessageUpdated({ id: "user-primary", sessionID: "s-1", role: "user", time: {} });

      expect((adapter as any).primaryUserMsgIds.get("s-1")).toBe("user-primary");
      expect(events).toHaveLength(0);
    });

    it("emits message.queued.consumed for a truly-queued user message", () => {
      const { adapter } = createAdapterWithClient();
      (adapter as any).pendingMessages.set("s-1", [
        { resolve: vi.fn(), messageId: null, assistantParts: [], firstEventTimer: null, promptSent: true },
        { resolve: vi.fn(), messageId: null, assistantParts: [], firstEventTimer: null, promptSent: true },
      ]);
      (adapter as any).primaryUserMsgIds.set("s-1", "user-primary");
      const consumedEvents: any[] = [];
      adapter.on("message.queued.consumed", (e) => consumedEvents.push(e));

      (adapter as any).handleMessageUpdated({ id: "user-queued", sessionID: "s-1", role: "user", time: {} });

      expect(consumedEvents).toHaveLength(1);
      expect(consumedEvents[0].sessionId).toBe("s-1");
      expect(consumedEvents[0].messageId).toBe("user-queued");
    });

    it("strips time.completed when emitting a pending assistant message", () => {
      const { adapter } = createAdapterWithClient();
      (adapter as any).pendingMessages.set("s-1", [{
        resolve: vi.fn(),
        messageId: "msg-1",
        assistantParts: [],
        firstEventTimer: null,
        promptSent: true,
      }]);
      const events: any[] = [];
      adapter.on("message.updated", (e) => events.push(e));

      (adapter as any).handleMessageUpdated({
        id: "msg-1",
        sessionID: "s-1",
        role: "assistant",
        time: { created: 1000, completed: 2000 },
      });

      expect(events).toHaveLength(1);
      expect(events[0].message.time.completed).toBeUndefined();
      expect(events[0].message.error).toBeUndefined();
    });

    it("caches the full message (with time.completed) in lastEmittedMessage", () => {
      const { adapter } = createAdapterWithClient();
      (adapter as any).pendingMessages.set("s-1", [{
        resolve: vi.fn(),
        messageId: "msg-1",
        assistantParts: [],
        firstEventTimer: null,
        promptSent: true,
      }]);

      (adapter as any).handleMessageUpdated({
        id: "msg-1",
        sessionID: "s-1",
        role: "assistant",
        time: { created: 1000, completed: 2000 },
      });

      const cached = (adapter as any).lastEmittedMessage.get("s-1");
      expect(cached).toBeDefined();
      expect(cached.time.completed).toBe(2000);
    });

    it("emits message.updated normally for assistant messages without pending entries", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("message.updated", (e) => events.push(e));

      (adapter as any).handleMessageUpdated({
        id: "msg-2",
        sessionID: "s-1",
        role: "assistant",
        time: { created: 1000 },
      });

      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe("s-1");
    });
  });

  // ===========================================================================
  // B5. handleSessionStatus + resolveSessionIdle
  // ===========================================================================

  describe("handleSessionStatus", () => {
    it("calls resolveSessionIdle when status type is 'idle'", () => {
      const { adapter } = createAdapterWithClient();
      const spy = vi.spyOn(adapter as any, "resolveSessionIdle");

      (adapter as any).handleSessionStatus({ sessionID: "s-1", status: { type: "idle" } });

      expect(spy).toHaveBeenCalledWith("s-1");
    });

    it("ignores non-idle status types", () => {
      const { adapter } = createAdapterWithClient();
      const spy = vi.spyOn(adapter as any, "resolveSessionIdle");

      (adapter as any).handleSessionStatus({ sessionID: "s-1", status: { type: "running" } });
      (adapter as any).handleSessionStatus({ sessionID: "s-1", status: { type: "error" } });

      expect(spy).not.toHaveBeenCalled();
    });

    it("ignores events with missing sessionID", () => {
      const { adapter } = createAdapterWithClient();
      const spy = vi.spyOn(adapter as any, "resolveSessionIdle");

      (adapter as any).handleSessionStatus({ status: { type: "idle" } });

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("resolveSessionIdle", () => {
    it("does nothing when no pending entries exist for the session", () => {
      const { adapter } = createAdapterWithClient();
      const emitSpy = vi.spyOn(adapter, "emit");

      (adapter as any).resolveSessionIdle("s-1");

      expect(emitSpy).not.toHaveBeenCalledWith("message.updated", expect.anything());
    });

    it("does nothing when promptSent is false (pre-prompt abort race condition)", () => {
      const { adapter } = createAdapterWithClient();
      const resolve = vi.fn();
      (adapter as any).pendingMessages.set("s-1", [{
        resolve,
        messageId: null,
        assistantParts: [],
        firstEventTimer: null,
        promptSent: false,
      }]);

      (adapter as any).resolveSessionIdle("s-1");

      expect(resolve).not.toHaveBeenCalled();
      // Entry remains because idle was ignored
      expect((adapter as any).pendingMessages.has("s-1")).toBe(true);
    });

    it("resolves all pending entries with the cached message", () => {
      const { adapter } = createAdapterWithClient();
      const resolve1 = vi.fn();
      const resolve2 = vi.fn();
      const cachedMessage = {
        id: "msg-1",
        sessionId: "s-1",
        role: "assistant",
        time: { created: 1000, completed: 2000 },
        parts: [],
      };
      (adapter as any).pendingMessages.set("s-1", [
        { resolve: resolve1, messageId: "msg-1", assistantParts: [], firstEventTimer: null, promptSent: true },
        { resolve: resolve2, messageId: null, assistantParts: [], firstEventTimer: null, promptSent: true },
      ]);
      (adapter as any).lastEmittedMessage.set("s-1", cachedMessage);

      (adapter as any).resolveSessionIdle("s-1");

      expect(resolve1).toHaveBeenCalledWith(expect.objectContaining({
        id: "msg-1",
        time: expect.objectContaining({ completed: expect.any(Number) }),
      }));
      expect(resolve2).toHaveBeenCalledWith(expect.objectContaining({ id: "msg-1" }));
    });

    it("constructs a fallback message from accumulated parts when no cached message", () => {
      const { adapter } = createAdapterWithClient();
      const resolve = vi.fn();
      const mockPart = { id: "p-1", type: "text", text: "Hello", messageId: "msg-fallback", sessionId: "s-1" };
      (adapter as any).pendingMessages.set("s-1", [{
        resolve,
        messageId: "msg-fallback",
        assistantParts: [mockPart],
        firstEventTimer: null,
        promptSent: true,
      }]);
      // No lastEmittedMessage set

      (adapter as any).resolveSessionIdle("s-1");

      expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
        id: "msg-fallback",
        role: "assistant",
        parts: [mockPart],
        time: expect.objectContaining({ completed: expect.any(Number) }),
      }));
    });

    it("clears partCache entries belonging only to the resolved session", () => {
      const { adapter } = createAdapterWithClient();
      (adapter as any).pendingMessages.set("s-1", [{
        resolve: vi.fn(),
        messageId: "msg-1",
        assistantParts: [],
        firstEventTimer: null,
        promptSent: true,
      }]);
      (adapter as any).partCache.set("p-session1", { id: "p-session1", sessionID: "s-1" });
      (adapter as any).partCache.set("p-session2", { id: "p-session2", sessionID: "s-2" });

      (adapter as any).resolveSessionIdle("s-1");

      expect((adapter as any).partCache.has("p-session1")).toBe(false);
      expect((adapter as any).partCache.has("p-session2")).toBe(true);
    });

    it("deletes pendingMessages and primaryUserMsgIds on resolution", () => {
      const { adapter } = createAdapterWithClient();
      (adapter as any).pendingMessages.set("s-1", [{
        resolve: vi.fn(),
        messageId: "msg-1",
        assistantParts: [],
        firstEventTimer: null,
        promptSent: true,
      }]);
      (adapter as any).primaryUserMsgIds.set("s-1", "user-1");

      (adapter as any).resolveSessionIdle("s-1");

      expect((adapter as any).pendingMessages.has("s-1")).toBe(false);
      expect((adapter as any).primaryUserMsgIds.has("s-1")).toBe(false);
    });

    it("emits final message.updated with time.completed after idle", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("message.updated", (e) => events.push(e));
      (adapter as any).pendingMessages.set("s-1", [{
        resolve: vi.fn(),
        messageId: "msg-1",
        assistantParts: [],
        firstEventTimer: null,
        promptSent: true,
      }]);

      (adapter as any).resolveSessionIdle("s-1");

      expect(events).toHaveLength(1);
      expect(events[0].message.time.completed).toBeDefined();
    });
  });

  // ===========================================================================
  // C. Message Management
  // ===========================================================================

  describe("sendMessage — normal path", () => {
    it("builds text parts from content", async () => {
      const { adapter, client } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);

      const promise = adapter.sendMessage(sessionId, [{ type: "text", text: "Hello world" }]);
      await flushMicrotasks();
      (adapter as any).resolveSessionIdle(sessionId);
      await promise;

      expect(client.session.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({ parts: expect.arrayContaining([{ type: "text", text: "Hello world" }]) }),
      );
    });

    it("builds file parts from image content with base64 data", async () => {
      const { adapter, client } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);

      const promise = adapter.sendMessage(sessionId, [
        { type: "image", data: "base64data", mimeType: "image/jpeg" },
      ]);
      await flushMicrotasks();
      (adapter as any).resolveSessionIdle(sessionId);
      await promise;

      expect(client.session.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          parts: expect.arrayContaining([expect.objectContaining({
            type: "file",
            mime: "image/jpeg",
            url: "data:image/jpeg;base64,base64data",
            filename: "image.png",
          })]),
        }),
      );
    });

    it("uses default image/png mime type when mimeType is not provided", async () => {
      const { adapter, client } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);

      const promise = adapter.sendMessage(sessionId, [{ type: "image", data: "abc" }]);
      await flushMicrotasks();
      (adapter as any).resolveSessionIdle(sessionId);
      await promise;

      expect(client.session.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          parts: expect.arrayContaining([expect.objectContaining({ mime: "image/png" })]),
        }),
      );
    });

    it("defaults to a single empty text part when content is empty", async () => {
      const { adapter, client } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);

      const promise = adapter.sendMessage(sessionId, []);
      await flushMicrotasks();
      (adapter as any).resolveSessionIdle(sessionId);
      await promise;

      expect(client.session.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({ parts: [{ type: "text", text: "" }] }),
      );
    });

    it("parses providerID/modelID from modelId option with slash separator", async () => {
      const { adapter, client } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);

      const promise = adapter.sendMessage(
        sessionId,
        [{ type: "text", text: "hi" }],
        { modelId: "anthropic/claude-3-5" },
      );
      await flushMicrotasks();
      (adapter as any).resolveSessionIdle(sessionId);
      await promise;

      expect(client.session.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({ model: { providerID: "anthropic", modelID: "claude-3-5" } }),
      );
    });

    it("omits model spec when modelId has no slash separator", async () => {
      const { adapter, client } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);

      const promise = adapter.sendMessage(sessionId, [{ type: "text", text: "hi" }], {
        modelId: "claude-3-5-no-provider",
      });
      await flushMicrotasks();
      (adapter as any).resolveSessionIdle(sessionId);
      await promise;

      const call = client.session.promptAsync.mock.calls[0][0];
      expect(call.model).toBeUndefined();
    });

    it("sets promptSent=true and sets up a 30s first-event timer after successful promptAsync", async () => {
      const { adapter } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);

      const promise = adapter.sendMessage(sessionId, [{ type: "text", text: "hi" }]);
      await flushMicrotasks();

      const entry = (adapter as any).pendingMessages.get(sessionId)?.[0];
      expect(entry?.promptSent).toBe(true);
      expect(entry?.firstEventTimer).not.toBeNull();

      (adapter as any).resolveSessionIdle(sessionId);
      await promise;
    });

    it("throws when promptAsync returns an error object and cleans up pending entry", async () => {
      const { adapter, client } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);
      client.session.promptAsync.mockResolvedValue({ error: "Session not found" });

      await expect(adapter.sendMessage(sessionId, [{ type: "text", text: "hi" }]))
        .rejects.toThrow("Failed to send message: Session not found");

      expect((adapter as any).pendingMessages.has(sessionId)).toBe(false);
      expect((adapter as any).primaryUserMsgIds.has(sessionId)).toBe(false);
    });

    it("passes mode option as agent field to promptAsync", async () => {
      const { adapter, client } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);

      const promise = adapter.sendMessage(sessionId, [{ type: "text", text: "hi" }], { mode: "plan" });
      await flushMicrotasks();
      (adapter as any).resolveSessionIdle(sessionId);
      await promise;

      expect(client.session.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({ agent: "plan" }),
      );
    });
  });

  describe("sendMessage — enqueue path", () => {
    it("appends to pending entries when a pending entry already exists for the session", async () => {
      const { adapter, client } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);
      const primaryResolve = vi.fn();
      (adapter as any).pendingMessages.set(sessionId, [{
        resolve: primaryResolve,
        messageId: "msg-primary",
        assistantParts: [],
        firstEventTimer: null,
        promptSent: true,
      }]);

      const promise = adapter.sendMessage(sessionId, [{ type: "text", text: "queued" }]);
      await flushMicrotasks();

      const entries = (adapter as any).pendingMessages.get(sessionId);
      expect(entries).toHaveLength(2);
      expect(entries[1].promptSent).toBe(true);

      // Does NOT call abort for the enqueue path
      expect(client.session.abort).not.toHaveBeenCalled();

      (adapter as any).resolveSessionIdle(sessionId);
      await promise;
    });

    it("emits message.queued with correct queuePosition", async () => {
      const { adapter } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);
      (adapter as any).pendingMessages.set(sessionId, [{
        resolve: vi.fn(),
        messageId: null,
        assistantParts: [],
        firstEventTimer: null,
        promptSent: true,
      }]);

      const queuedEvents: any[] = [];
      adapter.on("message.queued", (e) => queuedEvents.push(e));

      const promise = adapter.sendMessage(sessionId, [{ type: "text", text: "enqueued" }]);
      await flushMicrotasks();

      expect(queuedEvents).toHaveLength(1);
      expect(queuedEvents[0].sessionId).toBe(sessionId);
      expect(queuedEvents[0].queuePosition).toBe(1);

      (adapter as any).resolveSessionIdle(sessionId);
      await promise;
    });

    it("throws when promptAsync returns error in enqueue path", async () => {
      const { adapter, client } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);
      (adapter as any).pendingMessages.set(sessionId, [{
        resolve: vi.fn(),
        messageId: null,
        assistantParts: [],
        firstEventTimer: null,
        promptSent: true,
      }]);
      client.session.promptAsync.mockResolvedValue({ error: "busy" });

      await expect(adapter.sendMessage(sessionId, [{ type: "text", text: "hi" }]))
        .rejects.toThrow("Failed to enqueue message: busy");
    });
  });

  // ===========================================================================
  // C2. cancelMessage
  // ===========================================================================

  describe("cancelMessage", () => {
    it("calls abort on the session-scoped client", async () => {
      const { adapter } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter, { directory: "/project" });
      const freshClient = createMockClient();
      mockCreateOpencodeClient.mockReturnValue(freshClient);

      await adapter.cancelMessage(sessionId);

      expect(freshClient.session.abort).toHaveBeenCalledWith({ sessionID: sessionId });
    });

    it("resolves all pending entries immediately with a Cancelled error", async () => {
      const { adapter } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);
      const resolve1 = vi.fn();
      const resolve2 = vi.fn();
      (adapter as any).pendingMessages.set(sessionId, [
        { resolve: resolve1, messageId: "msg-primary", assistantParts: [], firstEventTimer: null, promptSent: true },
        { resolve: resolve2, messageId: null, assistantParts: [], firstEventTimer: null, promptSent: true },
      ]);

      await adapter.cancelMessage(sessionId);

      expect(resolve1).toHaveBeenCalledWith(expect.objectContaining({
        error: "Cancelled",
        role: "assistant",
        time: expect.objectContaining({ completed: expect.any(Number) }),
      }));
      expect(resolve2).toHaveBeenCalledWith(expect.objectContaining({ error: "Cancelled" }));
    });

    it("clears pendingMessages, primaryUserMsgIds, and lastEmittedMessage", async () => {
      const { adapter } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);
      (adapter as any).pendingMessages.set(sessionId, [{
        resolve: vi.fn(),
        messageId: "msg-1",
        assistantParts: [],
        firstEventTimer: null,
        promptSent: true,
      }]);
      (adapter as any).primaryUserMsgIds.set(sessionId, "user-1");
      (adapter as any).lastEmittedMessage.set(sessionId, { id: "msg-1" });

      await adapter.cancelMessage(sessionId);

      expect((adapter as any).pendingMessages.has(sessionId)).toBe(false);
      expect((adapter as any).primaryUserMsgIds.has(sessionId)).toBe(false);
      expect((adapter as any).lastEmittedMessage.has(sessionId)).toBe(false);
    });

    it("still calls abort even when no pending messages exist", async () => {
      const { adapter } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);
      const freshClient = createMockClient();
      mockCreateOpencodeClient.mockReturnValue(freshClient);

      // No pending entries
      await adapter.cancelMessage(sessionId);

      expect(freshClient.session.abort).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // D. Permission & Question Handling
  // ===========================================================================

  describe("Permission Handling", () => {
    it("handlePermissionAsked emits permission.asked with all three fixed options", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("permission.asked", (e) => events.push(e));

      (adapter as any).handlePermissionAsked({
        id: "perm-1",
        sessionID: "s-1",
        type: "write",
        callID: "call-1",
        title: "Write to file",
        metadata: { path: "/file.ts" },
        pattern: "/repo/**",
      });

      expect(events).toHaveLength(1);
      const perm = events[0].permission;
      expect(perm.id).toBe("perm-1");
      expect(perm.sessionId).toBe("s-1");
      expect(perm.permission).toBe("write");
      expect(perm.toolCallId).toBe("call-1");
      expect(perm.title).toBe("Write to file");
      expect(perm.rawInput).toEqual({ path: "/file.ts" });
      expect(perm.options.map((o: any) => o.id)).toEqual(["once", "always", "reject"]);
      expect(perm.options.map((o: any) => o.type)).toEqual(["accept_once", "accept_always", "reject"]);
    });

    it("wraps a single pattern string in an array", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("permission.asked", (e) => events.push(e));

      (adapter as any).handlePermissionAsked({ id: "p-1", sessionID: "s-1", type: "write", pattern: "/repo/**" });

      expect(events[0].permission.patterns).toEqual(["/repo/**"]);
    });

    it("passes through a pattern array unchanged", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("permission.asked", (e) => events.push(e));

      (adapter as any).handlePermissionAsked({
        id: "p-1",
        sessionID: "s-1",
        type: "write",
        pattern: ["/a/**", "/b/**"],
      });

      expect(events[0].permission.patterns).toEqual(["/a/**", "/b/**"]);
    });

    it("uses an empty patterns array when no pattern field is present", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("permission.asked", (e) => events.push(e));

      (adapter as any).handlePermissionAsked({ id: "p-1", sessionID: "s-1", type: "read" });

      expect(events[0].permission.patterns).toEqual([]);
    });

    it("falls back to data.type as title when title is absent", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("permission.asked", (e) => events.push(e));

      (adapter as any).handlePermissionAsked({ id: "p-1", sessionID: "s-1", type: "execute" });

      expect(events[0].permission.title).toBe("execute");
    });

    it("replyPermission maps 'once' to SDK reply 'once'", async () => {
      const { adapter, client } = createAdapterWithClient();

      await adapter.replyPermission("perm-1", { optionId: "once" });

      expect(client.permission.reply).toHaveBeenCalledWith({ requestID: "perm-1", reply: "once" });
    });

    it("replyPermission maps 'accept_once' to 'once'", async () => {
      const { adapter, client } = createAdapterWithClient();

      await adapter.replyPermission("perm-1", { optionId: "accept_once" });

      expect(client.permission.reply).toHaveBeenCalledWith(expect.objectContaining({ reply: "once" }));
    });

    it("replyPermission maps 'allow_once' to 'once'", async () => {
      const { adapter, client } = createAdapterWithClient();

      await adapter.replyPermission("perm-1", { optionId: "allow_once" });

      expect(client.permission.reply).toHaveBeenCalledWith(expect.objectContaining({ reply: "once" }));
    });

    it("replyPermission maps 'always' to 'always'", async () => {
      const { adapter, client } = createAdapterWithClient();

      await adapter.replyPermission("perm-1", { optionId: "always" });

      expect(client.permission.reply).toHaveBeenCalledWith(expect.objectContaining({ reply: "always" }));
    });

    it("replyPermission maps 'accept_always' to 'always'", async () => {
      const { adapter, client } = createAdapterWithClient();

      await adapter.replyPermission("perm-1", { optionId: "accept_always" });

      expect(client.permission.reply).toHaveBeenCalledWith(expect.objectContaining({ reply: "always" }));
    });

    it("replyPermission maps 'allow_always' to 'always'", async () => {
      const { adapter, client } = createAdapterWithClient();

      await adapter.replyPermission("perm-1", { optionId: "allow_always" });

      expect(client.permission.reply).toHaveBeenCalledWith(expect.objectContaining({ reply: "always" }));
    });

    it("replyPermission maps unknown optionId to 'reject'", async () => {
      const { adapter, client } = createAdapterWithClient();

      await adapter.replyPermission("perm-1", { optionId: "unknown-option" });

      expect(client.permission.reply).toHaveBeenCalledWith(expect.objectContaining({ reply: "reject" }));
    });

    it("replyPermission emits permission.replied with the original optionId", async () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("permission.replied", (e) => events.push(e));

      await adapter.replyPermission("perm-42", { optionId: "always" });

      expect(events).toHaveLength(1);
      expect(events[0].permissionId).toBe("perm-42");
      expect(events[0].optionId).toBe("always");
    });

    it("replyPermission uses session-specific client when sessionId is provided", async () => {
      const { adapter } = createAdapterWithClient();
      seedSession(adapter, { sessionId: "s-scoped", directory: "/scoped-dir" });
      const scopedClient = createMockClient();
      mockCreateOpencodeClient.mockReturnValue(scopedClient);

      await adapter.replyPermission("perm-1", { optionId: "once" }, "s-scoped");

      expect(mockCreateOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({ directory: "/scoped-dir" }),
      );
      expect(scopedClient.permission.reply).toHaveBeenCalled();
    });
  });

  describe("Question Handling", () => {
    it("handleQuestionAsked maps SDK questions with options to a UnifiedQuestion", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("question.asked", (e) => events.push(e));

      (adapter as any).handleQuestionAsked({
        id: "q-1",
        sessionID: "s-1",
        tool: { callID: "call-1" },
        questions: [{
          question: "Choose environment",
          header: "Environment",
          options: [
            { label: "dev", description: "Development" },
            { label: "prod" },
          ],
          multiple: false,
          custom: true,
        }],
      });

      expect(events).toHaveLength(1);
      const q = events[0].question;
      expect(q.id).toBe("q-1");
      expect(q.sessionId).toBe("s-1");
      expect(q.toolCallId).toBe("call-1");
      expect(q.questions).toHaveLength(1);
      expect(q.questions[0].question).toBe("Choose environment");
      expect(q.questions[0].header).toBe("Environment");
      expect(q.questions[0].options).toEqual([
        { label: "dev", description: "Development" },
        { label: "prod", description: undefined },
      ]);
      expect(q.questions[0].custom).toBe(true);
      expect(q.questions[0].multiple).toBe(false);
    });

    it("handleQuestionAsked handles missing questions array gracefully", () => {
      const { adapter } = createAdapterWithClient();
      const events: any[] = [];
      adapter.on("question.asked", (e) => events.push(e));

      (adapter as any).handleQuestionAsked({ id: "q-empty", sessionID: "s-1" });

      expect(events[0].question.questions).toEqual([]);
    });

    it("replyQuestion calls API with answers and emits question.replied", async () => {
      const { adapter, client } = createAdapterWithClient();
      seedSession(adapter, { sessionId: "s-1" });
      const events: any[] = [];
      adapter.on("question.replied", (e) => events.push(e));

      await adapter.replyQuestion("q-1", [["staging"], ["main"]], "s-1");

      expect(client.question.reply).toHaveBeenCalledWith({
        requestID: "q-1",
        answers: [["staging"], ["main"]],
      });
      expect(events[0].questionId).toBe("q-1");
      expect(events[0].answers).toEqual([["staging"], ["main"]]);
    });

    it("rejectQuestion calls API and emits question.replied with empty answers", async () => {
      const { adapter, client } = createAdapterWithClient();
      seedSession(adapter, { sessionId: "s-1" });
      const events: any[] = [];
      adapter.on("question.replied", (e) => events.push(e));

      await adapter.rejectQuestion("q-2", "s-1");

      expect(client.question.reject).toHaveBeenCalledWith({ requestID: "q-2" });
      expect(events[0].questionId).toBe("q-2");
      expect(events[0].answers).toEqual([]);
    });
  });

  // ===========================================================================
  // E. Session Management
  // ===========================================================================

  describe("Session Management", () => {
    it("createSession switches directory, calls API, caches result, and returns unified session", async () => {
      const { adapter, client } = createAdapterWithClient();
      const sdkSession = { id: "s-new", directory: "/project", title: "New", time: { created: 1, updated: 2 } };
      client.session.create.mockResolvedValue({ data: sdkSession, error: null });

      const result = await adapter.createSession("/project");

      expect((adapter as any).currentDirectory).toBe("/project");
      expect(client.session.create).toHaveBeenCalledWith({ directory: "/project" });
      expect((adapter as any).sessions.has("s-new")).toBe(true);
      expect(result.id).toBe("s-new");
    });

    it("createSession throws when API returns an error", async () => {
      const { adapter, client } = createAdapterWithClient();
      client.session.create.mockResolvedValue({ data: null, error: { message: "quota exceeded" } });

      await expect(adapter.createSession("/project")).rejects.toThrow("Failed to create session");
    });

    it("listSessions with directory calls listSessionsForDirectory for that directory only", async () => {
      const { adapter } = createAdapterWithClient();
      const freshClient = createMockClient();
      mockCreateOpencodeClient.mockReturnValue(freshClient);
      freshClient.session.list.mockResolvedValue({ data: [], error: null });

      await adapter.listSessions("/project");

      expect(freshClient.session.list).toHaveBeenCalledWith({ directory: "/project" });
    });

    it("listSessions without directory fetches projects then lists sessions per project", async () => {
      const { adapter, client } = createAdapterWithClient();
      client.project.list.mockResolvedValue({
        data: [{ id: "p-1", worktree: "/project-a", name: "Project A", icon: "" }],
        error: null,
      });
      const perProjectClient = createMockClient();
      mockCreateOpencodeClient.mockReturnValueOnce(perProjectClient);
      const sdkSessions = [{ id: "s-1", directory: "/project-a", time: { created: 1, updated: 2 } }];
      perProjectClient.session.list.mockResolvedValue({ data: sdkSessions, error: null });

      const sessions = await adapter.listSessions();

      expect(client.project.list).toHaveBeenCalled();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("s-1");
    });

    it("listSessions without directory returns empty array when no projects exist", async () => {
      const { adapter, client } = createAdapterWithClient();
      client.project.list.mockResolvedValue({ data: [], error: null });

      const sessions = await adapter.listSessions();

      expect(sessions).toEqual([]);
    });

    it("listSessions caches sessions returned from the per-project listing", async () => {
      const { adapter, client } = createAdapterWithClient();
      client.project.list.mockResolvedValue({
        data: [{ id: "p-1", worktree: "/pa", name: "PA", icon: "" }],
        error: null,
      });
      const projClient = createMockClient();
      mockCreateOpencodeClient.mockReturnValueOnce(projClient);
      projClient.session.list.mockResolvedValue({
        data: [{ id: "cached-s", directory: "/pa", time: { created: 1, updated: 2 } }],
        error: null,
      });

      await adapter.listSessions();

      expect((adapter as any).sessions.has("cached-s")).toBe(true);
    });

    it("deleteSession removes the session from cache and cleans up userMessageIds", async () => {
      const { adapter } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter, { sessionId: "s-del", directory: "/del" });
      (adapter as any).userMessageIds.set(sessionId, new Set(["user-1", "user-2"]));
      const freshClient = createMockClient();
      mockCreateOpencodeClient.mockReturnValue(freshClient);

      await adapter.deleteSession(sessionId);

      expect(freshClient.session.delete).toHaveBeenCalledWith({ sessionID: sessionId });
      expect((adapter as any).sessions.has(sessionId)).toBe(false);
      expect((adapter as any).userMessageIds.has(sessionId)).toBe(false);
    });

    it("deleteSession uses ensureClient when session has no directory", async () => {
      const { adapter, client } = createAdapterWithClient();
      // Session without directory in the cache
      (adapter as any).sessions.set("s-nodir", { id: "s-nodir", engineType: "opencode" });

      await adapter.deleteSession("s-nodir");

      expect(client.session.delete).toHaveBeenCalledWith({ sessionID: "s-nodir" });
    });
  });

  // ===========================================================================
  // F. Model Management
  // ===========================================================================

  describe("Model Management", () => {
    it("listModels converts provider data and returns model list", async () => {
      const { adapter, client } = createAdapterWithClient();
      const mockProviderData = { all: [], connected: [] };
      client.provider.list.mockResolvedValue({ data: mockProviderData, error: null });
      const mockModels = [{ modelId: "anthropic/claude-3-5", cost: undefined }];
      mockConvertProviders.mockReturnValue(mockModels);

      const result = await adapter.listModels();

      expect(client.provider.list).toHaveBeenCalled();
      expect(mockConvertProviders).toHaveBeenCalledWith("opencode", mockProviderData);
      expect(result.models).toBe(mockModels);
    });

    it("listModels caches pricing for models that have cost data", async () => {
      const { adapter, client } = createAdapterWithClient();
      client.provider.list.mockResolvedValue({ data: { all: [], connected: [] }, error: null });
      mockConvertProviders.mockReturnValue([{
        modelId: "anthropic/claude-3",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      }]);

      await adapter.listModels();

      const pricing = (adapter as any).modelPricing.get("anthropic/claude-3");
      expect(pricing).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    });

    it("listModels skips pricing caching for models without cost data", async () => {
      const { adapter, client } = createAdapterWithClient();
      client.provider.list.mockResolvedValue({ data: { all: [], connected: [] }, error: null });
      mockConvertProviders.mockReturnValue([{ modelId: "free/model", cost: undefined }]);

      await adapter.listModels();

      expect((adapter as any).modelPricing.has("free/model")).toBe(false);
    });

    it("listModels throws when provider list returns an error", async () => {
      const { adapter, client } = createAdapterWithClient();
      client.provider.list.mockResolvedValue({ data: null, error: { message: "unauthorized" } });

      await expect(adapter.listModels()).rejects.toThrow("Failed to list providers");
    });
  });

  // ===========================================================================
  // G. Lifecycle
  // ===========================================================================

  describe("Lifecycle", () => {
    it("start kills orphaned process, starts server, emits starting then running", async () => {
      const adapter = new OpenCodeAdapter({ port: 6969 });
      const client = createMockClient();
      mockCreateOpencodeClient.mockReturnValue(client);
      client.provider.list.mockResolvedValue({ data: { all: [], connected: [] }, error: null });

      const statusChanges: string[] = [];
      adapter.on("status.changed", (e) => statusChanges.push(e.status));

      await adapter.start();

      expect(mockKillOrphanedProcess).toHaveBeenCalledWith(6969);
      expect(mockCreateOpencodeServer).toHaveBeenCalled();
      expect(mockFetchVersion).toHaveBeenCalled();
      expect(statusChanges).toContain("starting");
      expect(statusChanges).toContain("running");
      expect(adapter.getStatus()).toBe("running");
    });

    it("start populates connectedProviders from the provider list", async () => {
      const adapter = new OpenCodeAdapter({ port: 6969 });
      const client = createMockClient();
      mockCreateOpencodeClient.mockReturnValue(client);
      client.provider.list.mockResolvedValue({
        data: {
          all: [
            { id: "anthropic", name: "Anthropic", models: {} },
            { id: "openai", name: "OpenAI", models: {} },
            { id: "disconnected", name: "Disconnected", models: {} },
          ],
          connected: ["anthropic", "openai"],
        },
        error: null,
      });

      await adapter.start();

      expect((adapter as any).connectedProviders).toEqual(["Anthropic", "OpenAI"]);
    });

    it("start sets error status and emits error event when server fails to start", async () => {
      const adapter = new OpenCodeAdapter({ port: 6969 });
      mockCreateOpencodeServer.mockRejectedValue(new Error("Port already in use"));

      const errorEvents: any[] = [];
      adapter.on("status.changed", (e) => errorEvents.push(e));

      await expect(adapter.start()).rejects.toThrow("Port already in use");

      expect(adapter.getStatus()).toBe("error");
      const errEvent = errorEvents.find((e) => e.status === "error");
      expect(errEvent?.error).toBe("Port already in use");
    });

    it("start is idempotent — no-ops when server already exists", async () => {
      const adapter = new OpenCodeAdapter({ port: 6969 });
      (adapter as any).server = { url: "http://127.0.0.1:6969", close: vi.fn() };

      await adapter.start();

      expect(mockCreateOpencodeServer).not.toHaveBeenCalled();
    });

    it("stop closes server, emits stopped status, nulls client", async () => {
      const adapter = new OpenCodeAdapter({ port: 6969 });
      const mockClose = vi.fn().mockResolvedValue(undefined);
      (adapter as any).server = { url: "http://127.0.0.1:6969", close: mockClose };
      (adapter as any).status = "running";
      (adapter as any).client = createMockClient();

      const statusChanges: string[] = [];
      adapter.on("status.changed", (e) => statusChanges.push(e.status));

      await adapter.stop();

      expect(mockClose).toHaveBeenCalled();
      expect(adapter.getStatus()).toBe("stopped");
      expect((adapter as any).client).toBeNull();
      expect((adapter as any).server).toBeNull();
      expect(statusChanges).toContain("stopped");
    });

    it("stop resolves all pending messages with 'Engine stopped' error", async () => {
      const adapter = new OpenCodeAdapter({ port: 6969 });
      (adapter as any).server = { url: "http://127.0.0.1:6969", close: vi.fn().mockResolvedValue(undefined) };
      (adapter as any).status = "running";

      const resolve1 = vi.fn();
      const resolve2 = vi.fn();
      (adapter as any).pendingMessages.set("s-1", [
        { resolve: resolve1, messageId: "msg-1", assistantParts: [], firstEventTimer: null, promptSent: true },
      ]);
      (adapter as any).pendingMessages.set("s-2", [
        { resolve: resolve2, messageId: null, assistantParts: [], firstEventTimer: null, promptSent: false },
      ]);

      await adapter.stop();

      expect(resolve1).toHaveBeenCalledWith(expect.objectContaining({
        error: "Engine stopped",
        role: "assistant",
      }));
      expect(resolve2).toHaveBeenCalledWith(expect.objectContaining({ error: "Engine stopped" }));
      expect((adapter as any).pendingMessages.size).toBe(0);
      expect((adapter as any).lastEmittedMessage.size).toBe(0);
    });
  });

  // ===========================================================================
  // H. Command Management
  // ===========================================================================

  describe("Command Management", () => {
    it("fetchCommands loads commands, caches them, and emits commands.changed", async () => {
      const { adapter, client } = createAdapterWithClient();
      const commandEvents: any[] = [];
      adapter.on("commands.changed", (e) => commandEvents.push(e));

      client.command.list.mockResolvedValue({
        data: [
          { name: "fix", description: "Fix issues", template: "bug description" },
          { name: "review", description: "Review code" },
        ],
        error: null,
      });

      await (adapter as any).fetchCommands();

      expect(commandEvents).toHaveLength(1);
      expect(commandEvents[0].engineType).toBe("opencode");
      expect(commandEvents[0].commands).toEqual([
        { name: "fix", description: "Fix issues", argumentHint: "<bug description>" },
        { name: "review", description: "Review code", argumentHint: undefined },
      ]);
      expect((adapter as any).cachedCommands).toHaveLength(2);
    });

    it("fetchCommands uses empty description when command description is missing", async () => {
      const { adapter, client } = createAdapterWithClient();
      client.command.list.mockResolvedValue({
        data: [{ name: "nodesc" }],
        error: null,
      });

      await (adapter as any).fetchCommands();

      expect((adapter as any).cachedCommands[0].description).toBe("");
    });

    it("fetchCommands passes currentDirectory to command.list", async () => {
      const { adapter, client } = createAdapterWithClient();
      (adapter as any).currentDirectory = "/my-project";
      client.command.list.mockResolvedValue({ data: [], error: null });

      await (adapter as any).fetchCommands();

      expect(client.command.list).toHaveBeenCalledWith({ directory: "/my-project" });
    });

    it("listCommands returns cached commands without making any API call", async () => {
      const { adapter, client } = createAdapterWithClient();
      (adapter as any).cachedCommands = [
        { name: "fix", description: "Fix issues" },
        { name: "plan", description: "Plan work" },
      ];

      const commands = await adapter.listCommands("session-1");

      expect(commands).toHaveLength(2);
      expect(commands[0].name).toBe("fix");
      expect(client.command.list).not.toHaveBeenCalled();
    });

    it("invokeCommand parses model spec and calls session.command with correct params", async () => {
      const { adapter } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter, { directory: "/project" });
      const freshClient = createMockClient();
      mockCreateOpencodeClient.mockReturnValue(freshClient);
      freshClient.session.command.mockResolvedValue({ data: null, error: null });

      const result = await adapter.invokeCommand(sessionId, "fix", "the auth bug", {
        modelId: "anthropic/claude-3",
        mode: "build",
      });

      expect(freshClient.session.command).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: sessionId,
        command: "fix",
        arguments: "the auth bug",
        agent: "build",
        model: "anthropic/claude-3",
      }));
      expect(result).toEqual({ handledAsCommand: false });
    });

    it("invokeCommand returns handledAsCommand:false gracefully when the command API returns error", async () => {
      const { adapter } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);
      const freshClient = createMockClient();
      mockCreateOpencodeClient.mockReturnValue(freshClient);
      freshClient.session.command.mockResolvedValue({ data: null, error: "command not found" });

      const result = await adapter.invokeCommand(sessionId, "missing", "");

      expect(result).toEqual({ handledAsCommand: false });
    });

    it("invokeCommand returns handledAsCommand:false gracefully when API throws", async () => {
      const { adapter } = createAdapterWithClient();
      const { sessionId } = seedSession(adapter);
      const freshClient = createMockClient();
      mockCreateOpencodeClient.mockReturnValue(freshClient);
      freshClient.session.command.mockRejectedValue(new Error("network error"));

      const result = await adapter.invokeCommand(sessionId, "broken", "args");

      expect(result).toEqual({ handledAsCommand: false });
    });
  });

  // ===========================================================================
  // Misc: getInfo, getCapabilities, healthCheck, listProjects
  // ===========================================================================

  describe("getInfo and getCapabilities", () => {
    it("getInfo reports running status with connected providers as authMessage", () => {
      const { adapter } = createAdapterWithClient();
      (adapter as any).connectedProviders = ["Anthropic", "OpenAI"];
      (adapter as any).version = "opencode 0.1.5";

      const info = adapter.getInfo();

      expect(info.type).toBe("opencode");
      expect(info.name).toBe("OpenCode");
      expect(info.version).toBe("opencode 0.1.5");
      expect(info.status).toBe("running");
      expect(info.authenticated).toBe(true);
      expect(info.authMessage).toBe("Anthropic, OpenAI");
    });

    it("getInfo reports unauthenticated when no connected providers", () => {
      const { adapter } = createAdapterWithClient();
      (adapter as any).connectedProviders = [];

      const info = adapter.getInfo();

      expect(info.authenticated).toBe(false);
      expect(info.authMessage).toBeUndefined();
    });

    it("getInfo exposes errorMessage when status is error", () => {
      const adapter = new OpenCodeAdapter();
      (adapter as any).status = "error";
      (adapter as any).lastError = "Server failed to start";

      expect(adapter.getInfo().errorMessage).toBe("Server failed to start");
    });

    it("getCapabilities returns the expected feature flags", () => {
      const { adapter } = createAdapterWithClient();
      const caps = adapter.getCapabilities();

      expect(caps.providerModelHierarchy).toBe(true);
      expect(caps.messageCancellation).toBe(true);
      expect(caps.imageAttachment).toBe(true);
      expect(caps.messageEnqueue).toBe(true);
      expect(caps.slashCommands).toBe(true);
      expect(caps.dynamicModes).toBe(false);
      expect(caps.customModelInput).toBe(false);
    });

    it("getModes returns build and plan modes", () => {
      const { adapter } = createAdapterWithClient();
      const modes = adapter.getModes();

      expect(modes.map((m) => m.id)).toEqual(["build", "plan"]);
    });

    it("getAuthMethods returns an empty array", () => {
      const { adapter } = createAdapterWithClient();
      expect(adapter.getAuthMethods()).toEqual([]);
    });
  });

  describe("healthCheck", () => {
    it("returns true when global.health responds with data", async () => {
      const { adapter, client } = createAdapterWithClient();
      client.global.health.mockResolvedValue({ data: { status: "ok" } });

      expect(await adapter.healthCheck()).toBe(true);
    });

    it("returns false when global.health throws", async () => {
      const { adapter, client } = createAdapterWithClient();
      client.global.health.mockRejectedValue(new Error("connection refused"));

      expect(await adapter.healthCheck()).toBe(false);
    });

    it("returns false when global.health returns no data", async () => {
      const { adapter, client } = createAdapterWithClient();
      client.global.health.mockResolvedValue({ data: null });

      expect(await adapter.healthCheck()).toBe(false);
    });
  });

  describe("listProjects", () => {
    it("maps worktree paths to unified format with engineType and engineMeta", async () => {
      const { adapter, client } = createAdapterWithClient();
      client.project.list.mockResolvedValue({
        data: [
          { id: "p-1", worktree: "C:\\Users\\dev\\project", name: "My Project", icon: "rocket" },
        ],
        error: null,
      });

      const projects = await adapter.listProjects();

      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe("p-1");
      expect(projects[0].directory).toBe("C:/Users/dev/project");
      expect(projects[0].name).toBe("My Project");
      expect(projects[0].engineType).toBe("opencode");
      expect(projects[0].engineMeta).toEqual({ icon: "rocket" });
    });

    it("returns empty array when API returns an error", async () => {
      const { adapter, client } = createAdapterWithClient();
      client.project.list.mockResolvedValue({ data: null, error: { message: "forbidden" } });

      const projects = await adapter.listProjects();

      expect(projects).toEqual([]);
    });

    it("returns empty array when API throws", async () => {
      const { adapter, client } = createAdapterWithClient();
      client.project.list.mockRejectedValue(new Error("network error"));

      const projects = await adapter.listProjects();

      expect(projects).toEqual([]);
    });
  });
});
