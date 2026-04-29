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
  dingtalkLog: mockLogger,
}));

// Mock global fetch
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import { DingTalkTransport } from "../../../../../electron/main/channels/dingtalk/dingtalk-transport";

function makeTokenManager(token = "dt-token-123") {
  return {
    getToken: vi.fn().mockResolvedValue(token),
    invalidate: vi.fn(),
  } as any;
}

function makeRateLimiter() {
  return { consume: vi.fn().mockResolvedValue(undefined) } as any;
}

function makeOkResponse(body: unknown) {
  return {
    ok: true,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe("DingTalkTransport", () => {
  let transport: DingTalkTransport;
  let tokenManager: ReturnType<typeof makeTokenManager>;
  let rateLimiter: ReturnType<typeof makeRateLimiter>;
  const ROBOT_CODE = "robot-abc";

  beforeEach(() => {
    vi.clearAllMocks();
    tokenManager = makeTokenManager();
    rateLimiter = makeRateLimiter();
    transport = new DingTalkTransport(tokenManager, rateLimiter, ROBOT_CODE);
  });

  describe("sendText", () => {
    describe("group chat (chatId starts with 'cid')", () => {
      const groupChatId = "cidGroup1";

      it("sends to group endpoint with sampleText msgKey", async () => {
        fetchMock.mockResolvedValueOnce(
          makeOkResponse({ processQueryKey: "pqk-text-group" }),
        );

        const result = await transport.sendText(groupChatId, "Hello group");
        expect(result).toBe("pqk-text-group");

        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.dingtalk.com/v1.0/robot/groupMessages/send");
        const body = JSON.parse(opts.body);
        expect(body.robotCode).toBe(ROBOT_CODE);
        expect(body.openConversationId).toBe(groupChatId);
        expect(body.msgKey).toBe("sampleText");
        const msgParam = JSON.parse(body.msgParam);
        expect(msgParam).toEqual({ content: "Hello group" });
      });
    });

    describe("individual chat", () => {
      const userId = "user-ind-1";

      it("sends to individual endpoint with sampleText msgKey", async () => {
        fetchMock.mockResolvedValueOnce(
          makeOkResponse({ processQueryKey: "pqk-text-ind" }),
        );

        const result = await transport.sendText(userId, "Hello user");
        expect(result).toBe("pqk-text-ind");

        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend");
        const body = JSON.parse(opts.body);
        expect(body.robotCode).toBe(ROBOT_CODE);
        expect(body.userIds).toEqual([userId]);
        expect(body.msgKey).toBe("sampleText");
        const msgParam = JSON.parse(body.msgParam);
        expect(msgParam).toEqual({ content: "Hello user" });
      });
    });

    it("returns empty string and logs error on exception", async () => {
      tokenManager.getToken.mockRejectedValueOnce(new Error("token fail"));
      const result = await transport.sendText("cidABC", "test");
      expect(result).toBe("");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("returns empty string when API fails", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("bad request"),
      });
      const result = await transport.sendText("cidABC", "test");
      expect(result).toBe("");
    });
  });

  describe("updateText", () => {
    it("is a no-op (DingTalk does not support message editing)", async () => {
      await transport.updateText("some-id", "new text");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(tokenManager.getToken).not.toHaveBeenCalled();
    });
  });

  describe("deleteMessage", () => {
    it("calls group recall endpoint with the processQueryKey", async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse({}));

      await transport.deleteMessage("pqk-123");

      expect(rateLimiter.consume).toHaveBeenCalledTimes(1);
      expect(tokenManager.getToken).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.dingtalk.com/v1.0/robot/groupMessages/recall");
      const body = JSON.parse(opts.body);
      expect(body.robotCode).toBe(ROBOT_CODE);
      expect(body.processQueryKeys).toEqual(["pqk-123"]);
    });

    it("skips API call when messageId is empty", async () => {
      await transport.deleteMessage("");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("throws when recall API fails", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
      });
      await expect(transport.deleteMessage("pqk-bad")).rejects.toThrow(
        "DingTalk group recall failed",
      );
    });
  });

  describe("sendRichContent", () => {
    it("sends actionCard to group endpoint for cid chatIds", async () => {
      const cardJson = JSON.stringify({ title: "Card", text: "content" });
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({ processQueryKey: "pqk-rich-group" }),
      );

      const result = await transport.sendRichContent("cidRichGroup", cardJson);
      expect(result).toBe("pqk-rich-group");

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.dingtalk.com/v1.0/robot/groupMessages/send");
      const body = JSON.parse(opts.body);
      expect(body.msgKey).toBe("sampleActionCard");
      const msgParam = JSON.parse(body.msgParam);
      expect(msgParam).toEqual({ title: "Card", text: "content" });
    });

    it("falls back to markdown for individual chatIds", async () => {
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({ processQueryKey: "pqk-rich-ind" }),
      );

      const result = await transport.sendRichContent("user-1", "rich text");
      expect(result).toBe("pqk-rich-ind");

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend");
      const body = JSON.parse(opts.body);
      expect(body.msgKey).toBe("sampleMarkdown");
    });

    it("returns empty string on error", async () => {
      tokenManager.getToken.mockRejectedValueOnce(new Error("fail"));
      const result = await transport.sendRichContent("cidABC", "test");
      expect(result).toBe("");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("handles invalid JSON content for actionCard by using fallback", async () => {
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({ processQueryKey: "pqk-fallback" }),
      );

      const result = await transport.sendRichContent("cidABC", "not-json");
      expect(result).toBe("pqk-fallback");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const msgParam = JSON.parse(body.msgParam);
      expect(msgParam.title).toBe("CodeMux");
      expect(msgParam.text).toBe("not-json");
    });
  });

  describe("sendCard", () => {
    it("sends interactive card and returns processQueryKey", async () => {
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({ result: { processQueryKey: "card-pqk-1" } }),
      );

      const cardData = JSON.stringify({ cardTemplateId: "tpl-1" });
      const result = await transport.sendCard("cidCard", cardData);
      expect(result).toBe("card-pqk-1");

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.dingtalk.com/v1.0/im/v1.0/robot/interactiveCards/send");
    });

    it("returns empty string when API fails", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("error"),
      });

      const result = await transport.sendCard("cidCard", "{}");
      expect(result).toBe("");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("returns empty string on exception", async () => {
      fetchMock.mockRejectedValueOnce(new Error("network"));

      const result = await transport.sendCard("cidCard", "{}");
      expect(result).toBe("");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("returns empty string when response has no processQueryKey", async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse({ result: {} }));
      const result = await transport.sendCard("cidCard", "{}");
      expect(result).toBe("");
    });
  });

  describe("updateCard", () => {
    it("updates card content via PUT", async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse({}));

      const content = JSON.stringify({ cardData: { text: "updated" } });
      await transport.updateCard("card-id-1", content);

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.dingtalk.com/v1.0/im/v1.0/robot/interactiveCards");
      expect(opts.method).toBe("PUT");
    });

    it("skips when cardId is empty", async () => {
      await transport.updateCard("", "content");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("logs error when API fails", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("bad"),
      });
      await transport.updateCard("card-1", "{}");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("logs error on exception", async () => {
      fetchMock.mockRejectedValueOnce(new Error("net err"));
      await transport.updateCard("card-1", "{}");
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("finalizeCard", () => {
    it("sends PUT with completed status", async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse({}));

      await transport.finalizeCard("card-fin-1");

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.dingtalk.com/v1.0/im/v1.0/robot/interactiveCards");
      expect(opts.method).toBe("PUT");
      const body = JSON.parse(opts.body);
      expect(body.processQueryKey).toBe("card-fin-1");
      expect(body.cardData).toEqual({ status: "completed" });
    });

    it("skips when cardId is empty", async () => {
      await transport.finalizeCard("");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("logs error on exception", async () => {
      fetchMock.mockRejectedValueOnce(new Error("net"));
      await transport.finalizeCard("card-1");
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("sendMessageToUser", () => {
    it("sends to individual endpoint", async () => {
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({ processQueryKey: "pqk-user-msg" }),
      );

      const result = await transport.sendMessageToUser("uid-1", "sampleText", "hello");
      expect(result).toBe("pqk-user-msg");
      expect(rateLimiter.consume).toHaveBeenCalledTimes(1);
    });

    it("returns empty string on error", async () => {
      tokenManager.getToken.mockRejectedValueOnce(new Error("fail"));
      const result = await transport.sendMessageToUser("uid-1", "sampleText", "hello");
      expect(result).toBe("");
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("sendMarkdown", () => {
    describe("group chat (chatId starts with 'cid')", () => {
      const groupChatId = "cidXYZ123";

      it("sends to group endpoint with sampleMarkdown msgKey", async () => {
        fetchMock.mockResolvedValueOnce(
          makeOkResponse({ processQueryKey: "pqk-group-1" }),
        );

        const result = await transport.sendMarkdown(groupChatId, "# Group Title");
        expect(result).toBe("pqk-group-1");

        // Verify correct endpoint
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.dingtalk.com/v1.0/robot/groupMessages/send");
        expect(opts.method).toBe("POST");

        // Verify auth header
        expect(opts.headers["x-acs-dingtalk-access-token"]).toBe("dt-token-123");

        // Verify body structure
        const body = JSON.parse(opts.body);
        expect(body.robotCode).toBe(ROBOT_CODE);
        expect(body.openConversationId).toBe(groupChatId);
        expect(body.msgKey).toBe("sampleMarkdown");

        // Verify msgParam contains markdown title and text
        const msgParam = JSON.parse(body.msgParam);
        expect(msgParam).toEqual({ title: "CodeMux", text: "# Group Title" });
      });

      it("returns empty string when API responds with error", async () => {
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve("internal error"),
        });

        const result = await transport.sendMarkdown(groupChatId, "test");
        expect(result).toBe("");
        expect(mockLogger.error).toHaveBeenCalled();
      });
    });

    describe("individual chat (chatId does not start with 'cid')", () => {
      const userId = "user-456";

      it("sends to individual endpoint with sampleMarkdown msgKey", async () => {
        fetchMock.mockResolvedValueOnce(
          makeOkResponse({ processQueryKey: "pqk-ind-1" }),
        );

        const result = await transport.sendMarkdown(userId, "**bold** content");
        expect(result).toBe("pqk-ind-1");

        // Verify correct endpoint
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend");
        expect(opts.method).toBe("POST");

        // Verify body structure for individual
        const body = JSON.parse(opts.body);
        expect(body.robotCode).toBe(ROBOT_CODE);
        expect(body.userIds).toEqual([userId]);
        expect(body.msgKey).toBe("sampleMarkdown");

        const msgParam = JSON.parse(body.msgParam);
        expect(msgParam).toEqual({ title: "CodeMux", text: "**bold** content" });
      });

      it("returns empty string when API responds with error", async () => {
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 403,
          text: () => Promise.resolve("forbidden"),
        });

        const result = await transport.sendMarkdown(userId, "test");
        expect(result).toBe("");
      });
    });

    it("consumes rate limiter token before sending", async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse({ processQueryKey: "pqk" }));
      await transport.sendMarkdown("cidABC", "test");
      expect(rateLimiter.consume).toHaveBeenCalledTimes(1);
    });

    it("fetches token from tokenManager", async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse({ processQueryKey: "pqk" }));
      await transport.sendMarkdown("cidABC", "test");
      expect(tokenManager.getToken).toHaveBeenCalledTimes(1);
    });

    it("returns empty string and logs when an exception is thrown", async () => {
      tokenManager.getToken.mockRejectedValueOnce(new Error("token fetch failed"));
      const result = await transport.sendMarkdown("cidABC", "test");
      expect(result).toBe("");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("returns empty string when response has no processQueryKey", async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse({}));
      const result = await transport.sendMarkdown("cidABC", "test");
      expect(result).toBe("");
    });
  });
});
