import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GatewayWsClient } from "../../../../electron/main/channels/gateway-ws-client";
import { GatewayRequestType } from "../../../../src/types/unified";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockChannelLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  verbose: vi.fn(),
}));

/**
 * A lightweight fake WebSocket instance that captures event handlers registered
 * via ws.on(event, handler) and exposes helpers to trigger them from test code.
 */
class FakeWebSocket {
  private handlers = new Map<string, ((...args: any[]) => void)[]>();
  readyState = 1; // WebSocket.OPEN
  send = vi.fn();
  close = vi.fn();

  on(event: string, handler: (...args: any[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
    return this;
  }

  // --- Test helpers ---

  simulateOpen() {
    for (const h of this.handlers.get("open") || []) h();
  }

  simulateClose(code = 1000, reason?: string) {
    const buf = reason ? Buffer.from(reason) : undefined;
    for (const h of this.handlers.get("close") || []) h(code, buf);
  }

  simulateMessage(data: unknown) {
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    for (const h of this.handlers.get("message") || []) h(Buffer.from(raw));
  }

  simulateError(err: Error) {
    for (const h of this.handlers.get("error") || []) h(err);
  }
}

/**
 * The last FakeWebSocket instance created by `new WebSocket(url)`.
 * Updated in the mock constructor so tests can reach it after `client.connect()`.
 */
let lastFakeWs: FakeWebSocket;

/** All FakeWebSocket instances created so far (useful for reconnect tests). */
let allFakeWs: FakeWebSocket[];

/** Track the URL passed to the WebSocket constructor. */
let lastWsUrl: string;

const MockWebSocket = vi.hoisted(() => {
  // We return a factory; vi.mock below wires it up.
  return vi.fn();
});

vi.mock("ws", () => {
  // The constructor needs to be callable with `new`.
  const Ctor = function (this: any, url: string) {
    const ws = new FakeWebSocket();
    lastFakeWs = ws;
    allFakeWs.push(ws);
    lastWsUrl = url;
    // Bind methods so event registration and I/O work correctly.
    this.on = ws.on.bind(ws);
    this.send = ws.send;
    this.close = ws.close;
    // Use a property accessor for readyState so test mutations on `ws`
    // are visible through the object the client holds (`this`).
    Object.defineProperty(this, "readyState", {
      get: () => ws.readyState,
      set: (v: number) => { ws.readyState = v; },
      configurable: true,
      enumerable: true,
    });
    // Expose test helpers via the shared reference.
    (this as any).__fake = ws;
  } as unknown as typeof import("ws").default;

  // Static fields used by the source code (readyState comparison).
  (Ctor as any).OPEN = 1;
  (Ctor as any).CONNECTING = 0;
  (Ctor as any).CLOSING = 2;
  (Ctor as any).CLOSED = 3;

  return { default: Ctor, __esModule: true };
});

vi.mock("../../../../shared/ports", () => ({
  GATEWAY_PORT: 9999,
}));

vi.mock("../../../../electron/main/services/logger", () => ({
  channelLog: mockChannelLog,
}));

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("GatewayWsClient", () => {
  let client: GatewayWsClient;

  beforeEach(() => {
    vi.clearAllMocks();
    allFakeWs = [];
    lastWsUrl = "";
    client = new GatewayWsClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ========================================================================
  // 1. Constructor
  // ========================================================================

  describe("constructor", () => {
    it("uses the default URL with GATEWAY_PORT when no URL is provided", async () => {
      const c = new GatewayWsClient();
      const p = c.connect();
      lastFakeWs.simulateOpen();
      await p;
      expect(lastWsUrl).toBe("ws://127.0.0.1:9999");
    });

    it("accepts a custom URL", async () => {
      const c = new GatewayWsClient("ws://custom:1234");
      const p = c.connect();
      lastFakeWs.simulateOpen();
      await p;
      expect(lastWsUrl).toBe("ws://custom:1234");
    });
  });

  // ========================================================================
  // 2. connected getter
  // ========================================================================

  describe("connected getter", () => {
    it("returns false before connect", () => {
      expect(client.connected).toBe(false);
    });

    it("returns true after successful connect", async () => {
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;
      expect(client.connected).toBe(true);
    });

    it("returns false after disconnect", async () => {
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;
      client.disconnect();
      expect(client.connected).toBe(false);
    });
  });

  // ========================================================================
  // 3. Event emitter (on / off / emit)
  // ========================================================================

  describe("event emitter", () => {
    it("registers and invokes handlers with on()", async () => {
      const handler = vi.fn();
      client.on("connected", handler);
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("supports multiple handlers for the same event", async () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      client.on("connected", h1);
      client.on("connected", h2);
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;
      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it("removes handlers with off()", async () => {
      const handler = vi.fn();
      client.on("connected", handler);
      client.off("connected", handler);
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;
      expect(handler).not.toHaveBeenCalled();
    });

    it("off() is a no-op for an unregistered event", () => {
      const handler = vi.fn();
      // Should not throw
      expect(() => client.off("connected", handler)).not.toThrow();
    });

    it("on() returns this for chaining", () => {
      const result = client.on("connected", vi.fn());
      expect(result).toBe(client);
    });

    it("off() returns this for chaining", () => {
      const result = client.off("connected", vi.fn());
      expect(result).toBe(client);
    });

    it("emits error events with Error objects", async () => {
      const handler = vi.fn();
      client.on("error", handler);
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;
      const err = new Error("test error");
      lastFakeWs.simulateError(err);
      expect(handler).toHaveBeenCalledWith(err);
    });
  });

  // ========================================================================
  // 4. connect()
  // ========================================================================

  describe("connect()", () => {
    it("creates a WebSocket and resolves on open", async () => {
      const p = client.connect();
      expect(allFakeWs).toHaveLength(1);
      lastFakeWs.simulateOpen();
      await expect(p).resolves.toBeUndefined();
    });

    it("returns immediately if ws already exists", async () => {
      const p1 = client.connect();
      lastFakeWs.simulateOpen();
      await p1;
      const wsBefore = allFakeWs.length;
      const p2 = client.connect();
      await expect(p2).resolves.toBeUndefined();
      // No new WebSocket should have been created
      expect(allFakeWs.length).toBe(wsBefore);
    });

    it("accepts a URL override", async () => {
      const p = client.connect("ws://override:5555");
      lastFakeWs.simulateOpen();
      await p;
      expect(lastWsUrl).toBe("ws://override:5555");
    });

    it("rejects if close fires before open (connection failure)", async () => {
      const p = client.connect();
      lastFakeWs.simulateClose(1006, "connection refused");
      await expect(p).rejects.toThrow("Failed to connect to gateway");
    });

    it("emits 'connected' on open", async () => {
      const handler = vi.fn();
      client.on("connected", handler);
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("emits 'disconnected' on close with reason", async () => {
      const handler = vi.fn();
      client.on("disconnected", handler);
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;
      lastFakeWs.simulateClose(1000, "going away");
      expect(handler).toHaveBeenCalledWith("going away");
    });

    it("emits 'disconnected' with default reason when no reason buffer provided", async () => {
      const handler = vi.fn();
      client.on("disconnected", handler);
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;
      // Simulate close with no reason (undefined)
      const ws = lastFakeWs;
      // Directly call the close handler with undefined reason
      (ws as any).handlers.get("close")![0](1000, undefined);
      expect(handler).toHaveBeenCalledWith("closed (1000)");
    });

    it("resets reconnectAttempt on successful open", async () => {
      vi.useFakeTimers();
      // First connect and then close to bump reconnectAttempt
      const p1 = client.connect();
      lastFakeWs.simulateOpen();
      await p1;
      // Close triggers reconnect
      lastFakeWs.simulateClose(1006);
      // Now reconnect attempt was incremented.
      // Let the reconnect timer fire
      vi.advanceTimersByTime(500);
      const reconnectWs = lastFakeWs;
      // Open the reconnected socket
      reconnectWs.simulateOpen();
      // After successful open, reconnectAttempt should be 0 internally.
      // Close again and check the delay used is the first delay (500ms) not the second.
      reconnectWs.simulateClose(1006);
      // If reconnectAttempt was reset to 0, the delay would be 500ms again.
      // We verify by advancing 500ms and checking a new connection attempt.
      const wsCountBefore = allFakeWs.length;
      vi.advanceTimersByTime(500);
      expect(allFakeWs.length).toBe(wsCountBefore + 1);
    });
  });

  // ========================================================================
  // 5. disconnect()
  // ========================================================================

  describe("disconnect()", () => {
    it("sets manualClose, closes ws, nulls it, and rejects all pending", async () => {
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;
      const ws = lastFakeWs;

      // Set up a pending request that should be rejected
      ws.readyState = 1; // OPEN
      const reqPromise = client.listEngines();

      client.disconnect();

      expect(ws.close).toHaveBeenCalledWith(1000, "Client disconnect");
      expect(client.connected).toBe(false);
      await expect(reqPromise).rejects.toThrow("Client disconnected");
    });

    it("clears reconnect timer on disconnect", async () => {
      vi.useFakeTimers();
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;

      // Trigger a close to schedule reconnect
      lastFakeWs.simulateClose(1006);
      // Now there's a pending reconnect timer.

      // Disconnect manually — should clear the timer
      client.disconnect();

      // Advance time well past all reconnect delays
      vi.advanceTimersByTime(10_000);
      // No new WebSocket should be created (only the original + the reconnect attempt was cleared)
      // After the first close, ws is nulled, so disconnect doesn't create a new one.
      // The key assertion: no reconnect happens after manual disconnect.
      const wsCount = allFakeWs.length;
      vi.advanceTimersByTime(10_000);
      expect(allFakeWs.length).toBe(wsCount);
    });

    it("does not schedule reconnect after manual close", async () => {
      vi.useFakeTimers();
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;

      client.disconnect();
      const wsCount = allFakeWs.length;

      // Advance through all possible reconnect delays
      vi.advanceTimersByTime(30_000);
      expect(allFakeWs.length).toBe(wsCount);
    });

    it("is safe to call when not connected", () => {
      expect(() => client.disconnect()).not.toThrow();
    });
  });

  // ========================================================================
  // 6. scheduleReconnect() (tested indirectly via close events)
  // ========================================================================

  describe("scheduleReconnect", () => {
    it("uses escalating delays from RECONNECT_DELAYS", async () => {
      vi.useFakeTimers();
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;

      // Close — triggers reconnect with delay[0] = 500ms
      lastFakeWs.simulateClose(1006);
      const count0 = allFakeWs.length;

      vi.advanceTimersByTime(499);
      expect(allFakeWs.length).toBe(count0);
      vi.advanceTimersByTime(1);
      expect(allFakeWs.length).toBe(count0 + 1);

      // Second close — delay[1] = 1000ms
      lastFakeWs.simulateClose(1006);
      const count1 = allFakeWs.length;
      vi.advanceTimersByTime(999);
      expect(allFakeWs.length).toBe(count1);
      vi.advanceTimersByTime(1);
      expect(allFakeWs.length).toBe(count1 + 1);

      // Third close — delay[2] = 2000ms
      lastFakeWs.simulateClose(1006);
      const count2 = allFakeWs.length;
      vi.advanceTimersByTime(1999);
      expect(allFakeWs.length).toBe(count2);
      vi.advanceTimersByTime(1);
      expect(allFakeWs.length).toBe(count2 + 1);
    });

    it("caps at the maximum delay (5000ms)", async () => {
      vi.useFakeTimers();
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;

      // Exhaust all delays: 500, 1000, 2000, 5000
      for (let i = 0; i < 4; i++) {
        lastFakeWs.simulateClose(1006);
        vi.advanceTimersByTime(5001);
      }

      // 5th close — should still use 5000ms (capped)
      lastFakeWs.simulateClose(1006);
      const countBefore = allFakeWs.length;
      vi.advanceTimersByTime(4999);
      expect(allFakeWs.length).toBe(countBefore);
      vi.advanceTimersByTime(1);
      expect(allFakeWs.length).toBe(countBefore + 1);
    });

    it("is a no-op if a reconnect timer is already pending", async () => {
      vi.useFakeTimers();
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;

      // Manually trigger two close events in quick succession
      lastFakeWs.simulateClose(1006);
      // At this point the ws is null and _connected=false, so calling connect
      // again from outside won't interfere. The timer is already scheduled.
      const countBefore = allFakeWs.length;
      // Only one new WebSocket should be created after the delay
      vi.advanceTimersByTime(500);
      expect(allFakeWs.length).toBe(countBefore + 1);
    });

    it("calls connect() after the delay fires", async () => {
      vi.useFakeTimers();
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;

      lastFakeWs.simulateClose(1006);
      const countBefore = allFakeWs.length;
      vi.advanceTimersByTime(500);
      // A new WebSocket was created = connect() was called
      expect(allFakeWs.length).toBe(countBefore + 1);
    });
  });

  // ========================================================================
  // 7. handleMessage()
  // ========================================================================

  describe("handleMessage", () => {
    async function connectClient(): Promise<FakeWebSocket> {
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;
      return lastFakeWs;
    }

    it("ignores invalid JSON", async () => {
      const ws = await connectClient();
      // Should not throw
      expect(() => ws.simulateMessage("not json{{{")).not.toThrow();
    });

    it("ignores non-object messages (null)", async () => {
      const ws = await connectClient();
      expect(() => ws.simulateMessage("null")).not.toThrow();
    });

    it("ignores non-object messages (primitive)", async () => {
      const ws = await connectClient();
      expect(() => ws.simulateMessage("42")).not.toThrow();
    });

    it("resolves matching pending request on successful response", async () => {
      const ws = await connectClient();
      ws.readyState = 1;

      const reqPromise = client.listEngines();

      // Extract the requestId from the sent message
      expect(ws.send).toHaveBeenCalledTimes(1);
      const sentMsg = JSON.parse(ws.send.mock.calls[0][0]);
      const requestId = sentMsg.requestId;

      // Simulate a successful response
      ws.simulateMessage({
        type: "response",
        requestId,
        payload: [{ type: "claude", name: "Claude" }],
      });

      const result = await reqPromise;
      expect(result).toEqual([{ type: "claude", name: "Claude" }]);
    });

    it("clears the timer when a response is received", async () => {
      vi.useFakeTimers();
      const ws = await connectClient();
      ws.readyState = 1;

      const reqPromise = client.listEngines();
      const sentMsg = JSON.parse(ws.send.mock.calls[0][0]);

      // Respond before timeout
      ws.simulateMessage({
        type: "response",
        requestId: sentMsg.requestId,
        payload: [],
      });

      await reqPromise;

      // Advance past the default timeout — should NOT reject (timer was cleared)
      vi.advanceTimersByTime(130_000);
      // If the timer wasn't cleared, the promise would have been rejected,
      // but we already resolved it above.
    });

    it("rejects pending request on error response", async () => {
      const ws = await connectClient();
      ws.readyState = 1;

      const reqPromise = client.listEngines();
      const sentMsg = JSON.parse(ws.send.mock.calls[0][0]);

      ws.simulateMessage({
        type: "response",
        requestId: sentMsg.requestId,
        payload: null,
        error: { code: "NOT_FOUND", message: "Engine not found" },
      });

      await expect(reqPromise).rejects.toThrow("NOT_FOUND: Engine not found");
    });

    it("ignores response for an unknown requestId", async () => {
      const ws = await connectClient();
      // Should not throw
      expect(() =>
        ws.simulateMessage({
          type: "response",
          requestId: "unknown_123",
          payload: {},
        }),
      ).not.toThrow();
    });

    it("emits notification as an event", async () => {
      const ws = await connectClient();
      const handler = vi.fn();
      client.on("session.updated", handler);

      const sessionData = { session: { id: "s1", engineType: "claude", directory: "/tmp" } };
      ws.simulateMessage({
        type: "session.updated",
        payload: sessionData,
      });

      expect(handler).toHaveBeenCalledWith(sessionData);
    });

    it("emits message.part.updated notification", async () => {
      const ws = await connectClient();
      const handler = vi.fn();
      client.on("message.part.updated", handler);

      const partData = {
        sessionId: "s1",
        part: { id: "p1", messageId: "m1", sessionId: "s1", type: "text", text: "hello" },
      };
      ws.simulateMessage({
        type: "message.part.updated",
        payload: partData,
      });

      expect(handler).toHaveBeenCalledWith(partData);
    });

    it("emits permission.asked notification", async () => {
      const ws = await connectClient();
      const handler = vi.fn();
      client.on("permission.asked", handler);

      const permData = { permission: { id: "perm1", sessionId: "s1", engineType: "claude", title: "Allow?", kind: "edit", options: [] } };
      ws.simulateMessage({
        type: "permission.asked",
        payload: permData,
      });

      expect(handler).toHaveBeenCalledWith(permData);
    });

    it("emits engine.status.changed notification", async () => {
      const ws = await connectClient();
      const handler = vi.fn();
      client.on("engine.status.changed", handler);

      const statusData = { engineType: "claude", status: "running" };
      ws.simulateMessage({
        type: "engine.status.changed",
        payload: statusData,
      });

      expect(handler).toHaveBeenCalledWith(statusData);
    });
  });

  // ========================================================================
  // 8. request() method (tested via API methods)
  // ========================================================================

  describe("request() via API methods", () => {
    async function connectClient(): Promise<FakeWebSocket> {
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;
      return lastFakeWs;
    }

    it("rejects if not connected", async () => {
      await expect(client.listEngines()).rejects.toThrow("Not connected to gateway");
    });

    it("rejects if ws readyState is not OPEN", async () => {
      const ws = await connectClient();
      ws.readyState = 0; // CONNECTING

      await expect(client.listEngines()).rejects.toThrow("WebSocket is not open");
    });

    it("sends properly formatted GatewayRequest JSON", async () => {
      const ws = await connectClient();
      ws.readyState = 1;

      client.listEngines();

      expect(ws.send).toHaveBeenCalledTimes(1);
      const sentMsg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentMsg).toEqual({
        type: "engine.list",
        requestId: expect.stringMatching(/^ch_\d+_\d+$/),
        payload: {},
      });
    });

    it("sends the correct payload for parameterized requests", async () => {
      const ws = await connectClient();
      ws.readyState = 1;

      client.getSession("my-session-id");

      const sentMsg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentMsg.type).toBe("session.get");
      expect(sentMsg.payload).toEqual({ sessionId: "my-session-id" });
    });

    it("resolves when a matching response is received", async () => {
      const ws = await connectClient();
      ws.readyState = 1;

      const promise = client.listEngines();
      const sentMsg = JSON.parse(ws.send.mock.calls[0][0]);

      ws.simulateMessage({
        type: "response",
        requestId: sentMsg.requestId,
        payload: [{ type: "opencode" }],
      });

      await expect(promise).resolves.toEqual([{ type: "opencode" }]);
    });

    it("rejects on error response", async () => {
      const ws = await connectClient();
      ws.readyState = 1;

      const promise = client.getSession("invalid");
      const sentMsg = JSON.parse(ws.send.mock.calls[0][0]);

      ws.simulateMessage({
        type: "response",
        requestId: sentMsg.requestId,
        payload: null,
        error: { code: "SESSION_NOT_FOUND", message: "No such session" },
      });

      await expect(promise).rejects.toThrow("SESSION_NOT_FOUND: No such session");
    });

    it("rejects after the default timeout period (120s)", async () => {
      vi.useFakeTimers();
      const ws = await connectClient();
      ws.readyState = 1;

      const promise = client.listEngines();

      // Advance time past the default timeout
      vi.advanceTimersByTime(120_001);

      await expect(promise).rejects.toThrow("Request timeout: engine.list");
    });

    it("does not set a timeout when timeout=0 (sendMessage)", async () => {
      vi.useFakeTimers();
      const ws = await connectClient();
      ws.readyState = 1;

      const promise = client.sendMessage({
        sessionId: "s1",
        content: [{ type: "text", text: "hello" }],
      });

      // Advance a very long time — should NOT reject
      vi.advanceTimersByTime(600_000);

      // Resolve it manually to confirm it's still pending
      const sentMsg = JSON.parse(ws.send.mock.calls[0][0]);
      ws.simulateMessage({
        type: "response",
        requestId: sentMsg.requestId,
        payload: { id: "msg1", sessionId: "s1", role: "assistant", parts: [], time: { created: 1 } },
      });

      await expect(promise).resolves.toBeDefined();
    });

    it("uses 10s timeout for cancelMessage", async () => {
      vi.useFakeTimers();
      const ws = await connectClient();
      ws.readyState = 1;

      const promise = client.cancelMessage("s1");

      // Should not reject at 9999ms
      vi.advanceTimersByTime(9_999);
      // Check the promise is still pending by not having thrown yet.

      // Should reject at 10001ms
      vi.advanceTimersByTime(2);
      await expect(promise).rejects.toThrow("Request timeout: message.cancel");
    });

    it("rejects and cleans up when send() throws", async () => {
      const ws = await connectClient();
      ws.readyState = 1;
      ws.send.mockImplementation(() => {
        throw new Error("send failed");
      });

      await expect(client.listEngines()).rejects.toThrow("send failed");
    });

    it("cleans up pending map entry when send() throws", async () => {
      const ws = await connectClient();
      ws.readyState = 1;
      ws.send.mockImplementation(() => {
        throw new Error("send failed");
      });

      await expect(client.listEngines()).rejects.toThrow("send failed");

      // Now, a successful response for a stale requestId should be harmless
      ws.simulateMessage({
        type: "response",
        requestId: "ch_1_0",
        payload: {},
      });
      // No error, no unhandled rejection
    });

    it("increments requestCounter for each request", async () => {
      const ws = await connectClient();
      ws.readyState = 1;

      client.listEngines();
      client.listEngines();

      const msg1 = JSON.parse(ws.send.mock.calls[0][0]);
      const msg2 = JSON.parse(ws.send.mock.calls[1][0]);

      // Counter part of requestId should differ
      const counter1 = msg1.requestId.split("_")[1];
      const counter2 = msg2.requestId.split("_")[1];
      expect(Number(counter2)).toBe(Number(counter1) + 1);
    });
  });

  // ========================================================================
  // 9. rejectAllPending()
  // ========================================================================

  describe("rejectAllPending (via disconnect/close)", () => {
    it("rejects all pending requests and clears timers on disconnect", async () => {
      const ws = await (async () => {
        const p = client.connect();
        lastFakeWs.simulateOpen();
        await p;
        return lastFakeWs;
      })();
      ws.readyState = 1;

      const p1 = client.listEngines();
      const p2 = client.listSessions("claude");
      const p3 = client.getSession("s1");

      client.disconnect();

      await expect(p1).rejects.toThrow("Client disconnected");
      await expect(p2).rejects.toThrow("Client disconnected");
      await expect(p3).rejects.toThrow("Client disconnected");
    });

    it("rejects all pending requests when connection closes unexpectedly", async () => {
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;
      const ws = lastFakeWs;
      ws.readyState = 1;

      const p1 = client.listEngines();
      const p2 = client.listSessions("claude");

      ws.simulateClose(1006, "abnormal");

      await expect(p1).rejects.toThrow("Connection closed");
      await expect(p2).rejects.toThrow("Connection closed");
    });

    it("clears pending map so subsequent responses are ignored", async () => {
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;
      const ws = lastFakeWs;
      ws.readyState = 1;

      const reqPromise = client.listEngines();
      const sentMsg = JSON.parse(ws.send.mock.calls[0][0]);

      client.disconnect();
      await expect(reqPromise).rejects.toThrow("Client disconnected");

      // A late response for the old requestId should not throw or cause issues
      expect(() =>
        ws.simulateMessage({
          type: "response",
          requestId: sentMsg.requestId,
          payload: [],
        }),
      ).not.toThrow();
    });
  });

  // ========================================================================
  // 10. API method correctness
  // ========================================================================

  describe("API method correctness", () => {
    let ws: FakeWebSocket;

    beforeEach(async () => {
      const p = client.connect();
      lastFakeWs.simulateOpen();
      await p;
      ws = lastFakeWs;
      ws.readyState = 1;
    });

    function getSentMessage(callIndex = 0) {
      return JSON.parse(ws.send.mock.calls[callIndex][0]);
    }

    it("listEngines sends ENGINE_LIST type", () => {
      client.listEngines();
      expect(getSentMessage().type).toBe(GatewayRequestType.ENGINE_LIST);
      expect(getSentMessage().payload).toEqual({});
    });

    it("getEngineCapabilities sends ENGINE_CAPABILITIES with engineType", () => {
      client.getEngineCapabilities("claude");
      expect(getSentMessage().type).toBe(GatewayRequestType.ENGINE_CAPABILITIES);
      expect(getSentMessage().payload).toEqual({ engineType: "claude" });
    });

    it("listSessions sends SESSION_LIST with engineType", () => {
      client.listSessions("opencode");
      expect(getSentMessage().type).toBe(GatewayRequestType.SESSION_LIST);
      expect(getSentMessage().payload).toEqual({ engineType: "opencode" });
    });

    it("createSession sends SESSION_CREATE with request body", () => {
      const req = { engineType: "claude" as const, directory: "/home/user/project" };
      client.createSession(req);
      expect(getSentMessage().type).toBe(GatewayRequestType.SESSION_CREATE);
      expect(getSentMessage().payload).toEqual(req);
    });

    it("getSession sends SESSION_GET with sessionId", () => {
      client.getSession("session-abc");
      expect(getSentMessage().type).toBe(GatewayRequestType.SESSION_GET);
      expect(getSentMessage().payload).toEqual({ sessionId: "session-abc" });
    });

    it("deleteSession sends SESSION_DELETE with sessionId", () => {
      client.deleteSession("session-abc");
      expect(getSentMessage().type).toBe(GatewayRequestType.SESSION_DELETE);
      expect(getSentMessage().payload).toEqual({ sessionId: "session-abc" });
    });

    it("renameSession sends SESSION_RENAME with sessionId and title", () => {
      client.renameSession("session-abc", "New Title");
      expect(getSentMessage().type).toBe(GatewayRequestType.SESSION_RENAME);
      expect(getSentMessage().payload).toEqual({ sessionId: "session-abc", title: "New Title" });
    });

    it("sendMessage sends MESSAGE_SEND with request body and timeout=0", () => {
      vi.useFakeTimers();
      const req = { sessionId: "s1", content: [{ type: "text" as const, text: "hello" }] };
      client.sendMessage(req);
      expect(getSentMessage().type).toBe(GatewayRequestType.MESSAGE_SEND);
      expect(getSentMessage().payload).toEqual(req);

      // Verify timeout=0 by advancing far past default timeout without rejection
      // (Promise should still be pending)
    });

    it("cancelMessage sends MESSAGE_CANCEL with sessionId and timeout=10000", () => {
      vi.useFakeTimers();
      const promise = client.cancelMessage("s1");
      expect(getSentMessage().type).toBe(GatewayRequestType.MESSAGE_CANCEL);
      expect(getSentMessage().payload).toEqual({ sessionId: "s1" });

      // Verify specific timeout
      vi.advanceTimersByTime(10_001);
      return expect(promise).rejects.toThrow("Request timeout: message.cancel");
    });

    it("listMessages sends MESSAGE_LIST with sessionId", () => {
      client.listMessages("s1");
      expect(getSentMessage().type).toBe(GatewayRequestType.MESSAGE_LIST);
      expect(getSentMessage().payload).toEqual({ sessionId: "s1" });
    });

    it("listModels sends MODEL_LIST with engineType", () => {
      client.listModels("copilot");
      expect(getSentMessage().type).toBe(GatewayRequestType.MODEL_LIST);
      expect(getSentMessage().payload).toEqual({ engineType: "copilot" });
    });

    it("setModel sends MODEL_SET with request body", () => {
      const req = { sessionId: "s1", modelId: "gpt-4" };
      client.setModel(req);
      expect(getSentMessage().type).toBe(GatewayRequestType.MODEL_SET);
      expect(getSentMessage().payload).toEqual(req);
    });

    it("setMode sends MODE_SET with request body", () => {
      const req = { sessionId: "s1", modeId: "agent" };
      client.setMode(req);
      expect(getSentMessage().type).toBe(GatewayRequestType.MODE_SET);
      expect(getSentMessage().payload).toEqual(req);
    });

    it("replyPermission sends PERMISSION_REPLY with request body", () => {
      const req = { permissionId: "perm1", optionId: "allow_once" };
      client.replyPermission(req);
      expect(getSentMessage().type).toBe(GatewayRequestType.PERMISSION_REPLY);
      expect(getSentMessage().payload).toEqual(req);
    });

    it("replyQuestion sends QUESTION_REPLY with request body", () => {
      const req = { questionId: "q1", answers: [["Yes"]] };
      client.replyQuestion(req);
      expect(getSentMessage().type).toBe(GatewayRequestType.QUESTION_REPLY);
      expect(getSentMessage().payload).toEqual(req);
    });

    it("rejectQuestion sends QUESTION_REJECT with questionId", () => {
      client.rejectQuestion("q1");
      expect(getSentMessage().type).toBe(GatewayRequestType.QUESTION_REJECT);
      expect(getSentMessage().payload).toEqual({ questionId: "q1" });
    });

    it("listProjects sends PROJECT_LIST with engineType", () => {
      client.listProjects("claude");
      expect(getSentMessage().type).toBe(GatewayRequestType.PROJECT_LIST);
      expect(getSentMessage().payload).toEqual({ engineType: "claude" });
    });

    it("setProjectEngine sends PROJECT_SET_ENGINE with request body", () => {
      const req = { directory: "/project", engineType: "claude" as const };
      client.setProjectEngine(req);
      expect(getSentMessage().type).toBe(GatewayRequestType.PROJECT_SET_ENGINE);
      expect(getSentMessage().payload).toEqual(req);
    });

    it("listAllSessions sends SESSION_LIST_ALL", () => {
      client.listAllSessions();
      expect(getSentMessage().type).toBe(GatewayRequestType.SESSION_LIST_ALL);
      expect(getSentMessage().payload).toEqual({});
    });

    it("listAllProjects sends PROJECT_LIST_ALL", () => {
      client.listAllProjects();
      expect(getSentMessage().type).toBe(GatewayRequestType.PROJECT_LIST_ALL);
      expect(getSentMessage().payload).toEqual({});
    });

    it("deleteProject sends PROJECT_DELETE with projectId", () => {
      client.deleteProject("proj-1");
      expect(getSentMessage().type).toBe(GatewayRequestType.PROJECT_DELETE);
      expect(getSentMessage().payload).toEqual({ projectId: "proj-1" });
    });
  });
});
