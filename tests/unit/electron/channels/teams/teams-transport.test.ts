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

// Mock global fetch
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import { TeamsTransport } from "../../../../../electron/main/channels/teams/teams-transport";

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

describe("TeamsTransport", () => {
  let transport: TeamsTransport;
  let rateLimiter: ReturnType<typeof makeRateLimiter>;

  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiter = makeRateLimiter();
    // The constructor calls fetch for token — we mock that in TokenManager via the
    // fetcher callback. But since TokenManager is internal to the constructor,
    // we just need to make sure fetch is mocked for the token endpoint + API calls.
    transport = new TeamsTransport("app-id", "app-password", rateLimiter);
    transport.setServiceUrl("conv-1", "https://smba.trafficmanager.net/teams/");
  });

  function mockTokenAndApi(apiBody: unknown) {
    fetchMock
      .mockResolvedValueOnce(
        makeOkResponse({ access_token: "tok-123", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(makeOkResponse(apiBody));
  }

  describe("sendText", () => {
    it("sends text with markdown format and returns compound ID", async () => {
      mockTokenAndApi({ id: "act-1" });

      const result = await transport.sendText("conv-1", "hello teams");
      expect(result).toBe("conv-1|act-1");

      expect(rateLimiter.consume).toHaveBeenCalledTimes(1);
      const apiCall = fetchMock.mock.calls[1];
      expect(apiCall[0]).toContain("/v3/conversations/conv-1/activities");
      const body = JSON.parse(apiCall[1].body);
      expect(body.type).toBe("message");
      expect(body.text).toBe("hello teams");
      expect(body.textFormat).toBe("markdown");
    });

    it("returns empty string when API returns no id", async () => {
      mockTokenAndApi({});
      const result = await transport.sendText("conv-1", "test");
      expect(result).toBe("");
    });

    it("returns empty string when no serviceUrl is registered", async () => {
      const result = await transport.sendText("unknown-conv", "test");
      expect(result).toBe("");
    });

    it("returns empty string and logs error on exception", async () => {
      fetchMock.mockRejectedValueOnce(new Error("network"));
      const result = await transport.sendText("conv-1", "test");
      expect(result).toBe("");
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("updateText", () => {
    it("updates message via PUT with the activity id", async () => {
      mockTokenAndApi({});

      await transport.updateText("conv-1|act-5", "updated text");

      const apiCall = fetchMock.mock.calls[1];
      expect(apiCall[0]).toContain("/v3/conversations/conv-1/activities/act-5");
      expect(apiCall[1].method).toBe("PUT");
      const body = JSON.parse(apiCall[1].body);
      expect(body.text).toBe("updated text");
      expect(body.textFormat).toBe("markdown");
    });

    it("skips when messageId has no pipe separator", async () => {
      await transport.updateText("no-pipe", "text");
      // parseMessageId returns { conversationId: "", activityId: "no-pipe" }
      // so it early-returns because conversationId is empty
      // Only the token fetch might not happen
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("logs error on exception", async () => {
      fetchMock.mockRejectedValueOnce(new Error("fail"));
      await transport.updateText("conv-1|act-1", "text");
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("deleteMessage", () => {
    it("sends DELETE request for the message", async () => {
      mockTokenAndApi({});

      await transport.deleteMessage("conv-1|act-del-1");

      expect(rateLimiter.consume).toHaveBeenCalledTimes(1);
      const apiCall = fetchMock.mock.calls[1];
      expect(apiCall[0]).toContain("/v3/conversations/conv-1/activities/act-del-1");
      expect(apiCall[1].method).toBe("DELETE");
    });

    it("skips when messageId has no pipe separator", async () => {
      await transport.deleteMessage("no-pipe");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("sendRichContent", () => {
    it("sends Adaptive Card with valid JSON content", async () => {
      const card = JSON.stringify({ type: "AdaptiveCard", body: [] });
      mockTokenAndApi({ id: "act-rich-1" });

      const result = await transport.sendRichContent("conv-1", card);
      expect(result).toBe("conv-1|act-rich-1");

      const apiCall = fetchMock.mock.calls[1];
      const body = JSON.parse(apiCall[1].body);
      expect(body.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
      expect(body.attachments[0].content).toEqual({ type: "AdaptiveCard", body: [] });
    });

    it("falls back to sendText when content is not valid JSON", async () => {
      mockTokenAndApi({ id: "act-fallback" });

      const result = await transport.sendRichContent("conv-1", "plain text");
      expect(result).toBe("conv-1|act-fallback");

      const apiCall = fetchMock.mock.calls[1];
      const body = JSON.parse(apiCall[1].body);
      expect(body.text).toBe("plain text");
      expect(body.textFormat).toBe("markdown");
    });

    it("returns empty string when API returns no id", async () => {
      mockTokenAndApi({});
      const card = JSON.stringify({ type: "AdaptiveCard" });
      const result = await transport.sendRichContent("conv-1", card);
      expect(result).toBe("");
    });

    it("returns empty string on exception", async () => {
      fetchMock.mockRejectedValueOnce(new Error("net error"));
      const result = await transport.sendRichContent("conv-1", "{}");
      expect(result).toBe("");
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("composeMessageId", () => {
    it("joins conversationId and activityId with pipe", () => {
      expect(transport.composeMessageId("conv-a", "act-b")).toBe("conv-a|act-b");
    });
  });

  describe("setServiceUrl", () => {
    it("normalizes URL with trailing slash", () => {
      transport.setServiceUrl("conv-2", "https://example.com");
      // After setting, sendText should use this serviceUrl
      mockTokenAndApi({ id: "act-99" });
      return transport.sendText("conv-2", "test").then((result) => {
        expect(result).toBe("conv-2|act-99");
        const url = fetchMock.mock.calls[1][0];
        expect(url).toContain("https://example.com/v3/conversations/conv-2/activities");
      });
    });

    it("keeps trailing slash if already present", () => {
      transport.setServiceUrl("conv-3", "https://example.com/");
      mockTokenAndApi({ id: "act-100" });
      return transport.sendText("conv-3", "test").then(() => {
        const url = fetchMock.mock.calls[1][0];
        expect(url).toContain("https://example.com/v3/conversations/conv-3/activities");
      });
    });
  });

  describe("constructor", () => {
    it("creates transport with tenantId for single-tenant auth", () => {
      const t = new TeamsTransport("app-id", "app-pw", rateLimiter, "tenant-123");
      expect(t).toBeInstanceOf(TeamsTransport);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("tenant-123"),
      );
    });

    it("creates transport with botframework.com for multi-tenant auth", () => {
      const t = new TeamsTransport("app-id", "app-pw", rateLimiter);
      expect(t).toBeInstanceOf(TeamsTransport);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("botframework.com"),
      );
    });
  });

  describe("sendMarkdown", () => {
    it("delegates to sendText and returns the same compound message ID", async () => {
      // Mock token fetch (first fetch call) and API call (second fetch call)
      fetchMock
        .mockResolvedValueOnce(
          makeOkResponse({ access_token: "tok-123", expires_in: 3600 }),
        )
        .mockResolvedValueOnce(
          makeOkResponse({ id: "activity-42" }),
        );

      const result = await transport.sendMarkdown("conv-1", "**hello** world");
      expect(result).toBe("conv-1|activity-42");

      // Verify the API call used the markdown text as-is, with textFormat: "markdown"
      const apiCall = fetchMock.mock.calls[1];
      expect(apiCall[0]).toContain("/v3/conversations/conv-1/activities");
      const body = JSON.parse(apiCall[1].body);
      expect(body).toEqual({
        type: "message",
        text: "**hello** world",
        textFormat: "markdown",
      });
    });

    it("returns the same result as sendText", async () => {
      const sendTextSpy = vi.spyOn(transport, "sendText").mockResolvedValue("conv-1|act-99");
      const result = await transport.sendMarkdown("conv-1", "# heading");
      expect(sendTextSpy).toHaveBeenCalledWith("conv-1", "# heading");
      expect(result).toBe("conv-1|act-99");
    });

    it("returns empty string when sendText fails", async () => {
      const sendTextSpy = vi.spyOn(transport, "sendText").mockResolvedValue("");
      const result = await transport.sendMarkdown("conv-1", "test");
      expect(sendTextSpy).toHaveBeenCalledWith("conv-1", "test");
      expect(result).toBe("");
    });

    it("passes through the exact markdown content without transformation", async () => {
      const sendTextSpy = vi.spyOn(transport, "sendText").mockResolvedValue("id");
      const md = "- item 1\n- item 2\n\n```code```";
      await transport.sendMarkdown("conv-1", md);
      expect(sendTextSpy).toHaveBeenCalledWith("conv-1", md);
    });
  });
});
