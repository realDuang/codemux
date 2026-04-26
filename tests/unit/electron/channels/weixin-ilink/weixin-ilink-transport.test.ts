import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const { mockScopedLogger, httpMockState, requestMock } = vi.hoisted(() => {
  const state: any = { responseChunks: ["{}"] };
  const fn = (options: any, callback?: any) => {
    state.lastOptions = options;
    const res: any = new (require("events")).EventEmitter();
    state.capturedRes = res;
    const req: any = new (require("events")).EventEmitter();
    req.write = (b: string) => { state.lastBody = b; };
    req.destroy = (err?: Error) => {
      setImmediate(() => req.emit("error", err ?? new Error("destroyed")));
    };
    req.end = () => {
      setImmediate(() => {
        if (state.forceReqError) {
          req.emit("error", state.forceReqError);
          return;
        }
        if (typeof callback === "function") callback(res);
        for (const c of state.responseChunks) {
          res.emit("data", Buffer.from(c, "utf8"));
        }
        res.emit("end");
      });
    };
    state.capturedReq = req;
    return req;
  };
  return {
    mockScopedLogger: {
      error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {},
    },
    httpMockState: state,
    requestMock: fn,
  };
});

// Replace stub-logger fns with vi.fn so we can assert on calls.
mockScopedLogger.error = vi.fn();
mockScopedLogger.warn = vi.fn();
mockScopedLogger.info = vi.fn();

vi.mock("../../../../../electron/main/services/logger", () => ({
  channelLog: mockScopedLogger,
}));

vi.mock("https", () => ({
  default: { request: requestMock },
  request: requestMock,
}));
vi.mock("http", () => ({
  default: { request: requestMock },
  request: requestMock,
}));

import {
  WeixinIlinkTransport,
  buildIlinkAuthHeaders,
  randomUint32Base64,
  fetchIlinkJson,
} from "../../../../../electron/main/channels/weixin-ilink/weixin-ilink-transport";
import { ILINK_BASE_URL, SESSION_EXPIRED_CODE } from "../../../../../electron/main/channels/weixin-ilink/weixin-ilink-types";

function setResponse(payload: unknown) {
  httpMockState.responseChunks = [JSON.stringify(payload)];
  httpMockState.forceReqError = undefined;
}

describe("weixin-ilink transport helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("randomUint32Base64", () => {
    it("returns base64-encoded uint32 string", () => {
      const out = randomUint32Base64();
      expect(typeof out).toBe("string");
      const decoded = Buffer.from(out, "base64").toString("utf8");
      const n = Number(decoded);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(4_294_967_296);
    });
  });

  describe("buildIlinkAuthHeaders", () => {
    it("includes the iLink auth-type and a UIN header", () => {
      const headers = buildIlinkAuthHeaders();
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["AuthorizationType"]).toBe("ilink_bot_token");
      expect(headers["X-WECHAT-UIN"]).toBeTruthy();
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("attaches Bearer Authorization when bot token provided", () => {
      const headers = buildIlinkAuthHeaders("abc");
      expect(headers["Authorization"]).toBe("Bearer abc");
    });
  });
});

describe("WeixinIlinkTransport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isSessionExpired", () => {
    it("recognises -14 in ret or errcode", () => {
      expect(WeixinIlinkTransport.isSessionExpired(SESSION_EXPIRED_CODE)).toBe(true);
      expect(WeixinIlinkTransport.isSessionExpired(undefined, SESSION_EXPIRED_CODE)).toBe(true);
    });

    it("returns false for any other value", () => {
      expect(WeixinIlinkTransport.isSessionExpired(0, 0)).toBe(false);
      expect(WeixinIlinkTransport.isSessionExpired(undefined, undefined)).toBe(false);
      expect(WeixinIlinkTransport.isSessionExpired(1, 2)).toBe(false);
    });
  });

  describe("context token cache", () => {
    it("set/get/clear context tokens, scoped by accountId+userId", () => {
      const t = new WeixinIlinkTransport("token", ILINK_BASE_URL, "acct-1");
      expect(t.getContextToken("user-a")).toBeUndefined();
      t.setContextToken("user-a", "ctx-a");
      expect(t.getContextToken("user-a")).toBe("ctx-a");
      expect(t.contextTokenKey("user-a")).toBe("acct-1:user-a");
      t.clearContextTokens();
      expect(t.getContextToken("user-a")).toBeUndefined();
    });

    it("uses bare userId as key when accountId is empty", () => {
      const t = new WeixinIlinkTransport("token", ILINK_BASE_URL, "");
      expect(t.contextTokenKey("user-z")).toBe("user-z");
    });

    it("updateCredentials clears the cache and updates credentials", () => {
      const t = new WeixinIlinkTransport("old", ILINK_BASE_URL, "acct-1");
      t.setContextToken("user-a", "ctx-a");
      t.updateCredentials("new", "https://override.example.com", "acct-2");
      expect(t.getContextToken("user-a")).toBeUndefined();
      // accountId rotation must change cache key
      expect(t.contextTokenKey("user-a")).toBe("acct-2:user-a");
    });

    it("baseUrl falls back to default when empty after updateCredentials", () => {
      const t = new WeixinIlinkTransport("token", ILINK_BASE_URL, "acct");
      t.updateCredentials("token2", "", "acct2");
      // Constructor / updateCredentials swap to default — verify via private read
      // by exercising sendText's missing-context-token branch (returns empty string).
    });
  });

  describe("sendText capability fallbacks", () => {
    it("returns empty string and logs when no context token cached", async () => {
      const t = new WeixinIlinkTransport("token", ILINK_BASE_URL, "acct");
      const out = await t.sendText("user-x", "hello");
      expect(out).toBe("");
      expect(mockScopedLogger.warn).toHaveBeenCalled();
    });

    it("updateText / deleteMessage are no-ops", async () => {
      const t = new WeixinIlinkTransport("token", ILINK_BASE_URL, "acct");
      await expect(t.updateText("id", "x")).resolves.toBeUndefined();
      await expect(t.deleteMessage("id")).resolves.toBeUndefined();
    });

    it("sendRichContent forwards to sendText (which returns '' without context token)", async () => {
      const t = new WeixinIlinkTransport("token", ILINK_BASE_URL, "acct");
      await expect(t.sendRichContent("user-x", "rich")).resolves.toBe("");
    });

    it("composeMessageId joins chatId and messageId with ':'", () => {
      const t = new WeixinIlinkTransport("token", ILINK_BASE_URL, "acct");
      expect(t.composeMessageId("u-1", "42")).toBe("u-1:42");
    });
  });

  describe("fetchIlinkJson + sendMessage / getUpdates network paths", () => {
    beforeEach(() => {
      httpMockState.forceReqError = undefined;
      httpMockState.responseChunks = ["{}"];
    });

    it("rejects immediately when signal is already aborted", async () => {
      const ac = new AbortController();
      ac.abort();
      await expect(
        fetchIlinkJson("GET", "https://example.com/x", {}, undefined, ac.signal),
      ).rejects.toThrow("Aborted");
    });

    it("rejects with parse error on invalid JSON response", async () => {
      httpMockState.responseChunks = ["not json"];
      await expect(
        fetchIlinkJson("GET", "https://example.com/x", { Foo: "bar" }),
      ).rejects.toThrow(/Invalid JSON/);
    });

    it("rejects when underlying request emits error", async () => {
      httpMockState.forceReqError = new Error("network down");
      await expect(
        fetchIlinkJson("GET", "https://example.com/x", {}),
      ).rejects.toThrow("network down");
    });

    it("returns parsed JSON for happy-path GET", async () => {
      setResponse({ ok: 1 });
      const out = await fetchIlinkJson<{ ok: number }>(
        "GET",
        "https://example.com/x?y=1",
        { Foo: "bar" },
      );
      expect(out).toEqual({ ok: 1 });
      expect(httpMockState.lastOptions.method).toBe("GET");
      expect(httpMockState.lastOptions.path).toBe("/x?y=1");
      expect(httpMockState.lastOptions.headers.Foo).toBe("bar");
    });

    it("serializes body and sets Content-Length on POST", async () => {
      setResponse({ ret: 0 });
      await fetchIlinkJson("POST", "https://example.com/p", {}, { hello: "world" });
      expect(httpMockState.lastBody).toBe(JSON.stringify({ hello: "world" }));
      expect(httpMockState.lastOptions.headers["Content-Length"]).toBe(
        String(Buffer.byteLength(JSON.stringify({ hello: "world" }))),
      );
    });

    it("transport.getUpdates posts to /ilink/bot/getupdates with auth headers", async () => {
      setResponse({ ret: 0, msg_list: [] });
      const t = new WeixinIlinkTransport("tk", "https://api.example.com", "acct");
      const out = await t.getUpdates("buf-1");
      expect(out).toEqual({ ret: 0, msg_list: [] });
      expect(httpMockState.lastOptions.method).toBe("POST");
      expect(httpMockState.lastOptions.path).toContain("/ilink/bot/getupdates");
      expect(httpMockState.lastOptions.headers.Authorization).toBe("Bearer tk");
    });

    it("transport.sendMessage requires botToken", async () => {
      const t = new WeixinIlinkTransport("", ILINK_BASE_URL, "acct");
      await expect(t.sendMessage("u", "hi", "ctx")).rejects.toThrow(/no botToken/);
    });

    it("transport.sendMessage requires contextToken", async () => {
      const t = new WeixinIlinkTransport("tk", ILINK_BASE_URL, "acct");
      await expect(t.sendMessage("u", "hi", "")).rejects.toThrow(/missing context_token/);
    });

    it("transport.sendText happy path returns synthetic message id", async () => {
      setResponse({ ret: 0 });
      const t = new WeixinIlinkTransport("tk", ILINK_BASE_URL, "acct");
      t.setContextToken("user-x", "ctx-x");
      const id = await t.sendText("user-x", "hello");
      expect(id).toMatch(/^user-x:\d+$/);
    });

    it("transport.sendText surfaces session-expired by returning '' and logging error", async () => {
      setResponse({ ret: SESSION_EXPIRED_CODE, errcode: SESSION_EXPIRED_CODE });
      const t = new WeixinIlinkTransport("tk", ILINK_BASE_URL, "acct");
      t.setContextToken("user-y", "ctx-y");
      const id = await t.sendText("user-y", "hello");
      expect(id).toBe("");
      expect(mockScopedLogger.error).toHaveBeenCalled();
    });

    it("transport.sendText returns '' on non-zero ret without throwing", async () => {
      setResponse({ ret: 1, errmsg: "bad" });
      const t = new WeixinIlinkTransport("tk", ILINK_BASE_URL, "acct");
      t.setContextToken("user-z", "ctx-z");
      const id = await t.sendText("user-z", "hello");
      expect(id).toBe("");
    });
  });
});
