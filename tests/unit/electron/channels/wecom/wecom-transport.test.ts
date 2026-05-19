import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
  silly: vi.fn(),
}));

vi.mock("../../../../../electron/main/services/logger", () => ({
  channelLog: mockLogger,
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import { WeComTransport } from "../../../../../electron/main/channels/wecom/wecom-transport";

function makeTokenManager(token = "wecom-token") {
  return {
    getToken: vi.fn().mockResolvedValue(token),
    invalidate: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeRateLimiter() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { consume: vi.fn().mockResolvedValue(undefined) } as any;
}

function okJson(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) };
}

function okBinary(bytes: number, headers: Record<string, string> = {}) {
  const buf = new Uint8Array(bytes);
  return {
    ok: true,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: () => Promise.resolve(buf.buffer),
  };
}

describe("WeComTransport", () => {
  let transport: WeComTransport;
  let tokenManager: ReturnType<typeof makeTokenManager>;
  let rateLimiter: ReturnType<typeof makeRateLimiter>;
  const AGENT_ID = 1000002;

  beforeEach(() => {
    vi.clearAllMocks();
    tokenManager = makeTokenManager();
    rateLimiter = makeRateLimiter();
    transport = new WeComTransport(tokenManager, rateLimiter, AGENT_ID);
  });

  describe("sendText", () => {
    it("dispatches to user when target uses 'user:' prefix", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 0, errmsg: "ok", msgid: "m-user-1" }));
      const id = await transport.sendText("user:alice", "hi");
      expect(id).toBe("m-user-1");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=wecom-token");
      expect(JSON.parse(init.body)).toEqual({
        touser: "alice",
        msgtype: "text",
        agentid: AGENT_ID,
        text: { content: "hi" },
      });
    });

    it("dispatches to user when target has no prefix (default)", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 0, errmsg: "ok", msgid: "m-default" }));
      const id = await transport.sendText("bob", "yo");
      expect(id).toBe("m-default");
      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body).touser).toBe("bob");
    });

    it("dispatches to group when target uses 'group:' prefix", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 0, errmsg: "ok" }));
      const id = await transport.sendText("group:g1", "hello");
      expect(id).toMatch(/^group_g1_\d+$/);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=wecom-token");
      expect(JSON.parse(init.body)).toEqual({
        chatid: "g1",
        msgtype: "text",
        text: { content: "hello" },
      });
    });

    it("returns empty string and logs when API returns non-zero errcode (user)", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 40001, errmsg: "bad token" }));
      const id = await transport.sendText("user:u1", "x");
      expect(id).toBe("");
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("bad token"));
    });

    it("returns empty string and logs when API returns non-zero errcode (group)", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 40031, errmsg: "invalid chat" }));
      const id = await transport.sendText("group:g2", "x");
      expect(id).toBe("");
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("invalid chat"));
    });

    it("returns empty string when fetch throws (user)", async () => {
      fetchMock.mockRejectedValueOnce(new Error("network down"));
      const id = await transport.sendText("user:u1", "x");
      expect(id).toBe("");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("returns empty string when fetch throws (group)", async () => {
      fetchMock.mockRejectedValueOnce(new Error("network down"));
      const id = await transport.sendText("group:g1", "x");
      expect(id).toBe("");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("falls back to empty msgid when API omits one", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 0, errmsg: "ok" }));
      const id = await transport.sendText("user:u1", "x");
      expect(id).toBe("");
    });

    it("consumes rate limiter and fetches access token", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 0, errmsg: "ok", msgid: "m1" }));
      await transport.sendText("user:u", "x");
      expect(rateLimiter.consume).toHaveBeenCalledTimes(1);
      expect(tokenManager.getToken).toHaveBeenCalledTimes(1);
    });
  });

  describe("updateText", () => {
    it("is a no-op (WeCom messages are immutable)", async () => {
      await expect(transport.updateText("m1", "new")).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("sendRichContent / sendMarkdown", () => {
    it("sendRichContent posts markdown to user endpoint", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 0, errmsg: "ok", msgid: "md-1" }));
      const id = await transport.sendRichContent("user:u1", "# hello");
      expect(id).toBe("md-1");
      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({
        touser: "u1",
        msgtype: "markdown",
        agentid: AGENT_ID,
        markdown: { content: "# hello" },
      });
    });

    it("sendRichContent posts markdown to group endpoint", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 0, errmsg: "ok" }));
      const id = await transport.sendRichContent("group:g1", "# hi");
      expect(id).toMatch(/^group_g1_\d+$/);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain("/appchat/send");
      expect(JSON.parse(init.body)).toEqual({
        chatid: "g1",
        msgtype: "markdown",
        markdown: { content: "# hi" },
      });
    });

    it("sendMarkdown delegates to sendRichContent", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 0, errmsg: "ok", msgid: "md-2" }));
      const id = await transport.sendMarkdown("user:u1", "# yo");
      expect(id).toBe("md-2");
    });
  });

  describe("deleteMessage", () => {
    it("calls /message/recall with msgid", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 0, errmsg: "ok" }));
      await transport.deleteMessage("msg-1");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        "https://qyapi.weixin.qq.com/cgi-bin/message/recall?access_token=wecom-token",
      );
      expect(JSON.parse(init.body)).toEqual({ msgid: "msg-1" });
    });

    it("is a no-op when messageId is empty", async () => {
      await transport.deleteMessage("");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("throws when API returns non-zero errcode", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 40001, errmsg: "expired" }));
      await expect(transport.deleteMessage("msg-9")).rejects.toThrow(/expired/);
    });
  });

  describe("createGroup", () => {
    it("returns the chatid created by WeCom", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 0, errmsg: "ok", chatid: "g-new" }));
      const id = await transport.createGroup("Team", "owner", ["a", "b"]);
      expect(id).toBe("g-new");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain("/appchat/create");
      expect(JSON.parse(init.body)).toEqual({
        name: "Team",
        owner: "owner",
        userlist: ["a", "b"],
      });
    });

    it("includes optional chatid when passed", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 0, errmsg: "ok", chatid: "g-fixed" }));
      const id = await transport.createGroup("Team", "owner", ["a"], "g-fixed");
      expect(id).toBe("g-fixed");
      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body).chatid).toBe("g-fixed");
    });

    it("returns null on error", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 50001, errmsg: "bad members" }));
      const id = await transport.createGroup("Team", "owner", ["a"]);
      expect(id).toBeNull();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("returns null when fetch throws", async () => {
      fetchMock.mockRejectedValueOnce(new Error("boom"));
      const id = await transport.createGroup("Team", "owner", ["a"]);
      expect(id).toBeNull();
    });

    it("returns null when chatid is missing in success response", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 0, errmsg: "ok" }));
      const id = await transport.createGroup("Team", "owner", ["a"]);
      expect(id).toBeNull();
    });
  });

  describe("updateGroup", () => {
    it("returns true on success", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 0, errmsg: "ok" }));
      const ok = await transport.updateGroup("g1", { name: "New", add_user_list: ["c"] });
      expect(ok).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain("/appchat/update");
      expect(JSON.parse(init.body)).toEqual({
        chatid: "g1",
        name: "New",
        add_user_list: ["c"],
      });
    });

    it("returns false on non-zero errcode", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ errcode: 40031, errmsg: "no such chat" }));
      const ok = await transport.updateGroup("g1", { name: "n" });
      expect(ok).toBe(false);
    });

    it("returns false when fetch throws", async () => {
      fetchMock.mockRejectedValueOnce(new Error("net"));
      const ok = await transport.updateGroup("g1", { name: "n" });
      expect(ok).toBe(false);
    });
  });

  describe("downloadImageFromUrl", () => {
    it("returns a Buffer when fetch succeeds", async () => {
      fetchMock.mockResolvedValueOnce(okBinary(128, { "content-length": "128" }));
      const buf = await transport.downloadImageFromUrl("https://cdn/img.jpg", 1024);
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf!.length).toBe(128);
    });

    it("returns null when HTTP status is not ok", async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
      const buf = await transport.downloadImageFromUrl("https://cdn/missing", 1024);
      expect(buf).toBeNull();
    });

    it("returns null when content-length exceeds limit", async () => {
      fetchMock.mockResolvedValueOnce(okBinary(0, { "content-length": "999999" }));
      const buf = await transport.downloadImageFromUrl("https://cdn/big", 1024);
      expect(buf).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("999999"));
    });

    it("returns null when actual body exceeds limit (no content-length header)", async () => {
      fetchMock.mockResolvedValueOnce(okBinary(2048));
      const buf = await transport.downloadImageFromUrl("https://cdn/img.jpg", 1024);
      expect(buf).toBeNull();
    });

    it("returns null when fetch throws", async () => {
      fetchMock.mockRejectedValueOnce(new Error("dns"));
      const buf = await transport.downloadImageFromUrl("https://cdn/img.jpg", 1024);
      expect(buf).toBeNull();
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});
