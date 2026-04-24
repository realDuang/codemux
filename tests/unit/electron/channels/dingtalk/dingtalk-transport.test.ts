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
