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
  feishuLog: mockLogger,
}));

import { FeishuTransport } from "../../../../../electron/main/channels/feishu/feishu-transport";

function makeRateLimiter() {
  return { consume: vi.fn().mockResolvedValue(undefined) } as any;
}

function makeLarkClient(messageId = "msg-001") {
  return {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({
          data: { message_id: messageId },
        }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    },
  } as any;
}

describe("FeishuTransport", () => {
  let transport: FeishuTransport;
  let rateLimiter: ReturnType<typeof makeRateLimiter>;
  let larkClient: ReturnType<typeof makeLarkClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiter = makeRateLimiter();
    larkClient = makeLarkClient("msg-200");
    transport = new FeishuTransport(larkClient, rateLimiter, mockLogger as any);
  });

  describe("sendMarkdown", () => {
    it("wraps markdown in a card JSON and calls sendRichContent", async () => {
      const result = await transport.sendMarkdown("chat-1", "**bold** text");
      expect(result).toBe("msg-200");

      // Verify lark client was called with interactive msg_type and card content
      expect(larkClient.im.message.create).toHaveBeenCalledTimes(1);
      const callArgs = larkClient.im.message.create.mock.calls[0][0];
      expect(callArgs.params.receive_id_type).toBe("chat_id");
      expect(callArgs.data.receive_id).toBe("chat-1");
      expect(callArgs.data.msg_type).toBe("interactive");

      // The content should be JSON with elements containing markdown tag
      const content = JSON.parse(callArgs.data.content);
      expect(content).toEqual({
        elements: [{ tag: "markdown", content: "**bold** text" }],
      });
    });

    it("passes through the exact markdown string in the card element", async () => {
      const md = "# Title\n- item 1\n- item 2\n\n```js\nconsole.log('hi');\n```";
      await transport.sendMarkdown("chat-2", md);

      const callArgs = larkClient.im.message.create.mock.calls[0][0];
      const content = JSON.parse(callArgs.data.content);
      expect(content.elements[0].content).toBe(md);
      expect(content.elements[0].tag).toBe("markdown");
    });

    it("returns empty string when lark client returns no message_id", async () => {
      larkClient.im.message.create.mockResolvedValue({ data: {} });
      const result = await transport.sendMarkdown("chat-1", "test");
      expect(result).toBe("");
    });

    it("returns empty string when lark client throws", async () => {
      larkClient.im.message.create.mockRejectedValue(new Error("api error"));
      const result = await transport.sendMarkdown("chat-1", "test");
      expect(result).toBe("");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("consumes rate limiter token", async () => {
      await transport.sendMarkdown("chat-1", "test");
      expect(rateLimiter.consume).toHaveBeenCalledTimes(1);
    });

    it("delegates to sendRichContent internally", async () => {
      const spy = vi.spyOn(transport, "sendRichContent");
      await transport.sendMarkdown("chat-3", "hello");

      expect(spy).toHaveBeenCalledTimes(1);
      const cardArg = spy.mock.calls[0][1];
      const parsed = JSON.parse(cardArg);
      expect(parsed).toEqual({
        elements: [{ tag: "markdown", content: "hello" }],
      });
    });
  });
});
