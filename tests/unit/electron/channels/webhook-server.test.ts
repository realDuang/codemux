import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { WebhookServer } from "../../../../electron/main/channels/webhook-server";
import type {
  WebhookHandler,
  WebhookRequest,
} from "../../../../electron/main/channels/webhook-server";

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

vi.mock("../../../../electron/main/services/logger", () => ({
  channelLog: mockChannelLog,
}));

vi.mock("../../../../shared/ports", () => ({
  WEBHOOK_PORT: 9999,
}));

// ---------------------------------------------------------------------------
// Fake http primitives
// ---------------------------------------------------------------------------

/** Captured request handler from http.createServer */
let capturedRequestHandler: (req: any, res: any) => void;

/**
 * Fake IncomingMessage — an EventEmitter that also exposes .method, .url,
 * .headers so the WebhookServer can treat it like a real request.
 */
class FakeIncomingMessage extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;

  constructor(opts: {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
  } = {}) {
    super();
    this.method = opts.method ?? "GET";
    this.url = opts.url ?? "/";
    this.headers = opts.headers ?? {};
  }

  /** Helper — push a body in one or more chunks, then signal end. */
  sendBody(data: string | Buffer): void {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    this.emit("data", buf);
    this.emit("end");
  }

  /** Helper — signal end with no body. */
  sendEmpty(): void {
    this.emit("end");
  }
}

/** Fake ServerResponse that records writeHead / end calls. */
class FakeServerResponse {
  statusCode = 0;
  headersWritten: Record<string, string> = {};
  body = "";
  ended = false;

  writeHead(status: number, headers?: Record<string, string>) {
    this.statusCode = status;
    if (headers) this.headersWritten = { ...headers };
  }

  end(body?: string | Buffer) {
    this.ended = true;
    if (body != null) {
      this.body = typeof body === "string" ? body : body.toString("utf-8");
    }
  }
}

/** The fake http.Server used across tests. */
class FakeHttpServer extends EventEmitter {
  listening = false;
  listen = vi.fn((_port: number, cb?: () => void) => {
    this.listening = true;
    if (cb) process.nextTick(cb);
  });
  close = vi.fn((cb?: () => void) => {
    this.listening = false;
    if (cb) process.nextTick(cb);
  });
}

let fakeServer: FakeHttpServer;

vi.mock("http", () => ({
  default: {
    createServer: vi.fn((handler: (req: any, res: any) => void) => {
      capturedRequestHandler = handler;
      fakeServer = new FakeHttpServer();
      return fakeServer;
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helper to invoke the captured handler and wait for the async pipeline to
// finish.  Because handleRequest is async-but-fire-and-forget (void this.…),
// we give the microtask queue a chance to drain.
// ---------------------------------------------------------------------------

async function simulateRequest(
  req: FakeIncomingMessage,
  res: FakeServerResponse,
): Promise<void> {
  capturedRequestHandler(req, res);
  // Body needs to be emitted *after* the handler starts listening.
  // The caller is responsible for calling req.sendBody/sendEmpty.
  // Wait for microtasks to complete.
  await vi.waitFor(() => {
    if (!res.ended) throw new Error("response not ended yet");
  }, { timeout: 2000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebhookServer", () => {
  let server: WebhookServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new WebhookServer(12345);
  });

  afterEach(async () => {
    await server.stop();
  });

  // -----------------------------------------------------------------------
  // registerRoute / unregisterRoute
  // -----------------------------------------------------------------------

  describe("registerRoute", () => {
    it("normalizes path prefix by adding leading /", () => {
      const handler: WebhookHandler = vi.fn(async () => ({ status: 200 }));
      server.registerRoute("webhook/test", handler);

      // The internal map should store "/webhook/test"
      // Verify by registering another handler on the same normalised path —
      // it should overwrite.
      const handler2: WebhookHandler = vi.fn(async () => ({ status: 201 }));
      server.registerRoute("/webhook/test", handler2);

      // The second registration should have replaced the first.
      // We can verify indirectly through route matching later, but let's
      // also check the log messages.
      expect(mockChannelLog.info).toHaveBeenCalledWith(
        "[Webhook] Registered route: /webhook/test",
      );
    });

    it("keeps leading / when already present", () => {
      const handler: WebhookHandler = vi.fn(async () => ({ status: 200 }));
      server.registerRoute("/api/hook", handler);

      expect(mockChannelLog.info).toHaveBeenCalledWith(
        "[Webhook] Registered route: /api/hook",
      );
    });
  });

  describe("unregisterRoute", () => {
    it("removes a previously registered route", async () => {
      const handler: WebhookHandler = vi.fn(async () => ({ status: 200 }));
      server.registerRoute("/hook", handler);
      server.unregisterRoute("/hook");

      expect(mockChannelLog.info).toHaveBeenCalledWith(
        "[Webhook] Unregistered route: /hook",
      );

      // After unregistering, requests should 404.
      await server.start();
      const req = new FakeIncomingMessage({ method: "GET", url: "/hook" });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(res.statusCode).toBe(404);
    });

    it("normalizes path when unregistering", () => {
      const handler: WebhookHandler = vi.fn(async () => ({ status: 200 }));
      server.registerRoute("/hook", handler);
      server.unregisterRoute("hook"); // no leading /

      expect(mockChannelLog.info).toHaveBeenCalledWith(
        "[Webhook] Unregistered route: /hook",
      );
    });
  });

  // -----------------------------------------------------------------------
  // start / stop / isRunning / serverPort
  // -----------------------------------------------------------------------

  describe("start()", () => {
    it("creates http server and listens on configured port", async () => {
      await server.start();

      expect(fakeServer.listen).toHaveBeenCalledWith(
        12345,
        expect.any(Function),
      );
      expect(server.isRunning).toBe(true);
    });

    it("is a no-op when already started", async () => {
      await server.start();
      const firstServer = fakeServer;

      await server.start(); // second call

      // Should not have created a new server.
      expect(fakeServer).toBe(firstServer);
    });

    it("rejects if server emits an error during listen", async () => {
      // Create a fresh server (don't reuse the one from beforeEach which
      // may already be started).
      const errorServer = new WebhookServer(12345);

      // Override the mock *before* calling start so the newly-created
      // FakeHttpServer uses the error-emitting listen.
      const { default: http } = await import("http");
      const origCreateServer = vi.mocked(http.createServer);
      origCreateServer.mockImplementationOnce((handler: any) => {
        capturedRequestHandler = handler;
        const errFakeServer = new FakeHttpServer();
        errFakeServer.listen.mockImplementation((_port: number, _cb?: () => void) => {
          // Emit error instead of calling the listen callback.
          process.nextTick(() =>
            errFakeServer.emit("error", new Error("EADDRINUSE")),
          );
        });
        fakeServer = errFakeServer;
        return errFakeServer as any;
      });

      await expect(errorServer.start()).rejects.toThrow("EADDRINUSE");
    });
  });

  describe("stop()", () => {
    it("closes the server and nullifies it", async () => {
      await server.start();
      expect(server.isRunning).toBe(true);

      await server.stop();
      expect(server.isRunning).toBe(false);
    });

    it("is a no-op when not running", async () => {
      // Should not throw.
      await server.stop();
      expect(server.isRunning).toBe(false);
    });
  });

  describe("isRunning", () => {
    it("returns false initially", () => {
      expect(server.isRunning).toBe(false);
    });

    it("returns true after start", async () => {
      await server.start();
      expect(server.isRunning).toBe(true);
    });

    it("returns false after stop", async () => {
      await server.start();
      await server.stop();
      expect(server.isRunning).toBe(false);
    });
  });

  describe("serverPort", () => {
    it("returns the configured port", () => {
      expect(server.serverPort).toBe(12345);
    });

    it("uses WEBHOOK_PORT default when no port specified", () => {
      const defaultServer = new WebhookServer();
      expect(defaultServer.serverPort).toBe(9999);
    });
  });

  // -----------------------------------------------------------------------
  // handleRequest — route matching
  // -----------------------------------------------------------------------

  describe("handleRequest — route matching", () => {
    beforeEach(async () => {
      await server.start();
    });

    it("returns 404 when no routes match", async () => {
      const req = new FakeIncomingMessage({
        method: "GET",
        url: "/unknown",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(res.statusCode).toBe(404);
      expect(res.body).toBe("Not Found");
      expect(res.headersWritten["Content-Type"]).toBe("text/plain");
    });

    it("matches an exact path prefix", async () => {
      const handler: WebhookHandler = vi.fn(async () => ({
        status: 200,
        body: "ok",
      }));
      server.registerRoute("/webhook/telegram", handler);

      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/webhook/telegram",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(res.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("matches sub-path under registered prefix", async () => {
      const handler: WebhookHandler = vi.fn(async () => ({
        status: 200,
        body: "matched",
      }));
      server.registerRoute("/api", handler);

      const req = new FakeIncomingMessage({
        method: "GET",
        url: "/api/sub/path",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("matched");
    });

    it("uses longest prefix match when multiple routes match", async () => {
      const shortHandler: WebhookHandler = vi.fn(async () => ({
        status: 200,
        body: "short",
      }));
      const longHandler: WebhookHandler = vi.fn(async () => ({
        status: 200,
        body: "long",
      }));
      server.registerRoute("/webhook", shortHandler);
      server.registerRoute("/webhook/telegram", longHandler);

      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/webhook/telegram/update",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(res.body).toBe("long");
      expect(longHandler).toHaveBeenCalledTimes(1);
      expect(shortHandler).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // handleRequest — body parsing
  // -----------------------------------------------------------------------

  describe("handleRequest — body parsing", () => {
    let capturedReq: WebhookRequest | null;

    beforeEach(async () => {
      capturedReq = null;
      await server.start();

      const handler: WebhookHandler = vi.fn(async (wr) => {
        capturedReq = wr;
        return { status: 200 };
      });
      server.registerRoute("/test", handler);
    });

    it("parses JSON body when content-type is application/json", async () => {
      const jsonBody = JSON.stringify({ event: "message", text: "hello" });
      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/test",
        headers: { "content-type": "application/json" },
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendBody(jsonBody));
      await simulateRequest(req, res);

      expect(capturedReq).not.toBeNull();
      expect(capturedReq!.body).toEqual({ event: "message", text: "hello" });
      expect(capturedReq!.rawBody.toString()).toBe(jsonBody);
      expect(capturedReq!.contentType).toBe("application/json");
    });

    it("parses JSON body with charset in content-type", async () => {
      const jsonBody = JSON.stringify({ key: "value" });
      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/test",
        headers: { "content-type": "application/json; charset=utf-8" },
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendBody(jsonBody));
      await simulateRequest(req, res);

      expect(capturedReq!.body).toEqual({ key: "value" });
    });

    it("sets body to null for invalid JSON", async () => {
      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/test",
        headers: { "content-type": "application/json" },
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendBody("not valid json {{{"));
      await simulateRequest(req, res);

      expect(capturedReq!.body).toBeNull();
      expect(capturedReq!.rawBody.toString()).toBe("not valid json {{{");
    });

    it("parses URL-encoded body", async () => {
      const formBody = "username=admin&password=secret";
      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/test",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendBody(formBody));
      await simulateRequest(req, res);

      expect(capturedReq!.body).toEqual({
        username: "admin",
        password: "secret",
      });
    });

    it("leaves body as null for XML / other content types", async () => {
      const xml = "<xml><event>message</event></xml>";
      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/test",
        headers: { "content-type": "application/xml" },
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendBody(xml));
      await simulateRequest(req, res);

      expect(capturedReq!.body).toBeNull();
      expect(capturedReq!.rawBody.toString()).toBe(xml);
    });

    it("leaves body as null when no content-type header", async () => {
      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/test",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendBody("raw data"));
      await simulateRequest(req, res);

      expect(capturedReq!.body).toBeNull();
      expect(capturedReq!.rawBody.toString()).toBe("raw data");
      expect(capturedReq!.contentType).toBe("");
    });

    it("handles empty body", async () => {
      const req = new FakeIncomingMessage({
        method: "GET",
        url: "/test",
        headers: { "content-type": "application/json" },
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(capturedReq!.rawBody.length).toBe(0);
      // Empty string is not valid JSON, so body stays null.
      expect(capturedReq!.body).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // handleRequest — query params
  // -----------------------------------------------------------------------

  describe("handleRequest — query params", () => {
    let capturedReq: WebhookRequest | null;

    beforeEach(async () => {
      capturedReq = null;
      await server.start();

      const handler: WebhookHandler = vi.fn(async (wr) => {
        capturedReq = wr;
        return { status: 200 };
      });
      server.registerRoute("/test", handler);
    });

    it("parses query parameters from URL", async () => {
      const req = new FakeIncomingMessage({
        method: "GET",
        url: "/test?foo=bar&baz=42",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(capturedReq!.query).toEqual({ foo: "bar", baz: "42" });
    });

    it("returns empty query object when no params", async () => {
      const req = new FakeIncomingMessage({
        method: "GET",
        url: "/test",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(capturedReq!.query).toEqual({});
    });

    it("takes last value for duplicate query keys", async () => {
      const req = new FakeIncomingMessage({
        method: "GET",
        url: "/test?key=first&key=second",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      // The implementation iterates searchParams; for duplicates the last
      // assignment wins because it's a plain object.
      expect(capturedReq!.query.key).toBe("second");
    });
  });

  // -----------------------------------------------------------------------
  // handleRequest — body size limit
  // -----------------------------------------------------------------------

  describe("handleRequest — body size limit", () => {
    beforeEach(async () => {
      await server.start();

      const handler: WebhookHandler = vi.fn(async () => ({ status: 200 }));
      server.registerRoute("/test", handler);
    });

    it("returns 413 when body exceeds 5MB", async () => {
      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/test",
        headers: { "content-type": "application/octet-stream" },
      });
      const res = new FakeServerResponse();

      // Emit a chunk larger than 5MB.
      const oversizedChunk = Buffer.alloc(6 * 1024 * 1024); // 6MB
      process.nextTick(() => {
        req.emit("data", oversizedChunk);
        req.emit("end");
      });
      await simulateRequest(req, res);

      expect(res.statusCode).toBe(413);
      expect(res.body).toBe("Request Entity Too Large");
    });

    it("returns 413 when cumulative chunks exceed 5MB", async () => {
      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/test",
        headers: { "content-type": "application/octet-stream" },
      });
      const res = new FakeServerResponse();

      const chunkSize = 3 * 1024 * 1024; // 3MB each, total 6MB
      process.nextTick(() => {
        req.emit("data", Buffer.alloc(chunkSize));
        req.emit("data", Buffer.alloc(chunkSize));
        req.emit("end");
      });
      await simulateRequest(req, res);

      expect(res.statusCode).toBe(413);
      expect(res.body).toBe("Request Entity Too Large");
    });

    it("accepts body exactly at 5MB", async () => {
      const handler: WebhookHandler = vi.fn(async () => ({
        status: 200,
        body: "ok",
      }));
      server.registerRoute("/exact", handler);

      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/exact",
        headers: { "content-type": "application/octet-stream" },
      });
      const res = new FakeServerResponse();

      const exactChunk = Buffer.alloc(5 * 1024 * 1024); // exactly 5MB
      process.nextTick(() => {
        req.emit("data", exactChunk);
        req.emit("end");
      });
      await simulateRequest(req, res);

      expect(res.statusCode).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // handleRequest — handler response
  // -----------------------------------------------------------------------

  describe("handleRequest — handler response", () => {
    beforeEach(async () => {
      await server.start();
    });

    it("sends handler-specified status, headers, and body", async () => {
      const handler: WebhookHandler = vi.fn(async () => ({
        status: 201,
        headers: { "Content-Type": "application/json", "X-Custom": "value" },
        body: JSON.stringify({ success: true }),
      }));
      server.registerRoute("/test", handler);

      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/test",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.headersWritten["Content-Type"]).toBe("application/json");
      expect(res.headersWritten["X-Custom"]).toBe("value");
      expect(res.body).toBe(JSON.stringify({ success: true }));
    });

    it("defaults Content-Type to text/plain when handler omits it", async () => {
      const handler: WebhookHandler = vi.fn(async () => ({
        status: 200,
        body: "plain text",
      }));
      server.registerRoute("/test", handler);

      const req = new FakeIncomingMessage({
        method: "GET",
        url: "/test",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(res.headersWritten["Content-Type"]).toBe("text/plain");
    });

    it("does not override content-type when handler provides lowercase variant", async () => {
      const handler: WebhookHandler = vi.fn(async () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<h1>Hi</h1>",
      }));
      server.registerRoute("/test", handler);

      const req = new FakeIncomingMessage({
        method: "GET",
        url: "/test",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      // Should not have added an extra Content-Type header.
      expect(res.headersWritten["Content-Type"]).toBeUndefined();
      expect(res.headersWritten["content-type"]).toBe("text/html");
    });

    it("sends empty body when handler returns no body", async () => {
      const handler: WebhookHandler = vi.fn(async () => ({
        status: 204,
      }));
      server.registerRoute("/test", handler);

      const req = new FakeIncomingMessage({
        method: "DELETE",
        url: "/test",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
    });
  });

  // -----------------------------------------------------------------------
  // handleRequest — handler error
  // -----------------------------------------------------------------------

  describe("handleRequest — handler error", () => {
    beforeEach(async () => {
      await server.start();
    });

    it("returns 500 when handler throws", async () => {
      const handler: WebhookHandler = vi.fn(async () => {
        throw new Error("handler boom");
      });
      server.registerRoute("/test", handler);

      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/test",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(res.statusCode).toBe(500);
      expect(res.body).toBe("Internal Server Error");
      expect(res.headersWritten["Content-Type"]).toBe("text/plain");
    });

    it("returns 500 when handler rejects", async () => {
      const handler: WebhookHandler = vi.fn(
        () => Promise.reject(new Error("async failure")),
      );
      server.registerRoute("/test", handler);

      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/test",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(res.statusCode).toBe(500);
      expect(res.body).toBe("Internal Server Error");
    });
  });

  // -----------------------------------------------------------------------
  // handleRequest — method
  // -----------------------------------------------------------------------

  describe("handleRequest — method", () => {
    let capturedReq: WebhookRequest | null;

    beforeEach(async () => {
      capturedReq = null;
      await server.start();

      const handler: WebhookHandler = vi.fn(async (wr) => {
        capturedReq = wr;
        return { status: 200 };
      });
      server.registerRoute("/test", handler);
    });

    it("reads method from request and uppercases it", async () => {
      const req = new FakeIncomingMessage({
        method: "post",
        url: "/test",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(capturedReq!.method).toBe("POST");
    });

    it("defaults to GET when method is undefined", async () => {
      const req = new FakeIncomingMessage({ url: "/test" });
      (req as any).method = undefined;
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(capturedReq!.method).toBe("GET");
    });

    it("passes through path correctly", async () => {
      const req = new FakeIncomingMessage({
        method: "PUT",
        url: "/test/sub/resource?x=1",
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(capturedReq!.method).toBe("PUT");
      expect(capturedReq!.path).toBe("/test/sub/resource");
      expect(capturedReq!.query).toEqual({ x: "1" });
    });
  });

  // -----------------------------------------------------------------------
  // handleRequest — headers forwarding
  // -----------------------------------------------------------------------

  describe("handleRequest — headers", () => {
    let capturedReq: WebhookRequest | null;

    beforeEach(async () => {
      capturedReq = null;
      await server.start();

      const handler: WebhookHandler = vi.fn(async (wr) => {
        capturedReq = wr;
        return { status: 200 };
      });
      server.registerRoute("/test", handler);
    });

    it("forwards request headers to handler", async () => {
      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/test",
        headers: {
          "content-type": "application/json",
          "x-signature": "abc123",
          authorization: "Bearer token",
        },
      });
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendBody("{}"));
      await simulateRequest(req, res);

      expect(capturedReq!.headers["x-signature"]).toBe("abc123");
      expect(capturedReq!.headers["authorization"]).toBe("Bearer token");
    });
  });

  // -----------------------------------------------------------------------
  // handleRequest — default URL
  // -----------------------------------------------------------------------

  describe("handleRequest — default URL", () => {
    beforeEach(async () => {
      await server.start();
    });

    it("uses / when req.url is undefined", async () => {
      const handler: WebhookHandler = vi.fn(async (wr) => {
        return { status: 200, body: wr.path };
      });
      server.registerRoute("/", handler);

      const req = new FakeIncomingMessage({ method: "GET" });
      req.url = undefined as any;
      const res = new FakeServerResponse();
      process.nextTick(() => req.sendEmpty());
      await simulateRequest(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("/");
    });
  });

  // -----------------------------------------------------------------------
  // handleRequest — multiple data chunks
  // -----------------------------------------------------------------------

  describe("handleRequest — multi-chunk body", () => {
    let capturedReq: WebhookRequest | null;

    beforeEach(async () => {
      capturedReq = null;
      await server.start();

      const handler: WebhookHandler = vi.fn(async (wr) => {
        capturedReq = wr;
        return { status: 200 };
      });
      server.registerRoute("/test", handler);
    });

    it("concatenates multiple data chunks into rawBody", async () => {
      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/test",
        headers: { "content-type": "application/json" },
      });
      const res = new FakeServerResponse();

      process.nextTick(() => {
        req.emit("data", Buffer.from('{"key":'));
        req.emit("data", Buffer.from('"value"}'));
        req.emit("end");
      });
      await simulateRequest(req, res);

      expect(capturedReq!.rawBody.toString()).toBe('{"key":"value"}');
      expect(capturedReq!.body).toEqual({ key: "value" });
    });
  });

  // -----------------------------------------------------------------------
  // readBody — stream error
  // -----------------------------------------------------------------------

  describe("handleRequest — stream error", () => {
    beforeEach(async () => {
      await server.start();

      const handler: WebhookHandler = vi.fn(async () => ({ status: 200 }));
      server.registerRoute("/test", handler);
    });

    it("returns 500 when request stream emits a non-size error", async () => {
      const req = new FakeIncomingMessage({
        method: "POST",
        url: "/test",
      });
      const res = new FakeServerResponse();

      process.nextTick(() => {
        req.emit("error", new Error("connection reset"));
      });
      await simulateRequest(req, res);

      expect(res.statusCode).toBe(500);
      expect(res.body).toBe("Internal Server Error");
    });
  });
});
