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

  describe("sendText", () => {
    it("sends text message with msg_type text", async () => {
      const result = await transport.sendText("chat-t1", "Hello Feishu");
      expect(result).toBe("msg-200");

      expect(larkClient.im.message.create).toHaveBeenCalledTimes(1);
      const callArgs = larkClient.im.message.create.mock.calls[0][0];
      expect(callArgs.params.receive_id_type).toBe("chat_id");
      expect(callArgs.data.receive_id).toBe("chat-t1");
      expect(callArgs.data.msg_type).toBe("text");
      const content = JSON.parse(callArgs.data.content);
      expect(content).toEqual({ text: "Hello Feishu" });
    });

    it("consumes rate limiter", async () => {
      await transport.sendText("chat-t1", "test");
      expect(rateLimiter.consume).toHaveBeenCalledTimes(1);
    });

    it("returns empty string when lark client returns no message_id", async () => {
      larkClient.im.message.create.mockResolvedValue({ data: {} });
      const result = await transport.sendText("chat-t1", "test");
      expect(result).toBe("");
    });

    it("returns empty string and logs error on exception", async () => {
      larkClient.im.message.create.mockRejectedValue(new Error("send failed"));
      const result = await transport.sendText("chat-t1", "test");
      expect(result).toBe("");
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("updateText", () => {
    it("updates an existing message", async () => {
      await transport.updateText("msg-100", "Updated text");

      expect(larkClient.im.message.update).toHaveBeenCalledTimes(1);
      const callArgs = larkClient.im.message.update.mock.calls[0][0];
      expect(callArgs.path.message_id).toBe("msg-100");
      expect(callArgs.data.msg_type).toBe("text");
      const content = JSON.parse(callArgs.data.content);
      expect(content).toEqual({ text: "Updated text" });
    });

    it("consumes rate limiter", async () => {
      await transport.updateText("msg-100", "test");
      expect(rateLimiter.consume).toHaveBeenCalledTimes(1);
    });

    it("skips when messageId is empty", async () => {
      await transport.updateText("", "test");
      expect(larkClient.im.message.update).not.toHaveBeenCalled();
    });

    it("logs error on exception", async () => {
      larkClient.im.message.update.mockRejectedValue(new Error("update failed"));
      await transport.updateText("msg-100", "test");
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("deleteMessage", () => {
    it("deletes message by message_id", async () => {
      await transport.deleteMessage("msg-del-1");

      expect(larkClient.im.message.delete).toHaveBeenCalledTimes(1);
      const callArgs = larkClient.im.message.delete.mock.calls[0][0];
      expect(callArgs.path.message_id).toBe("msg-del-1");
    });

    it("consumes rate limiter", async () => {
      await transport.deleteMessage("msg-del-1");
      expect(rateLimiter.consume).toHaveBeenCalledTimes(1);
    });

    it("skips when messageId is empty", async () => {
      await transport.deleteMessage("");
      expect(larkClient.im.message.delete).not.toHaveBeenCalled();
    });
  });

  describe("sendRichContent", () => {
    it("sends interactive card with given JSON", async () => {
      const cardJson = JSON.stringify({ elements: [{ tag: "div", text: "test" }] });
      const result = await transport.sendRichContent("chat-r1", cardJson);
      expect(result).toBe("msg-200");

      const callArgs = larkClient.im.message.create.mock.calls[0][0];
      expect(callArgs.data.msg_type).toBe("interactive");
      expect(callArgs.data.content).toBe(cardJson);
    });

    it("returns empty string when lark client returns no message_id", async () => {
      larkClient.im.message.create.mockResolvedValue({ data: {} });
      const result = await transport.sendRichContent("chat-r1", "{}");
      expect(result).toBe("");
    });

    it("returns empty string and logs error on exception", async () => {
      larkClient.im.message.create.mockRejectedValue(new Error("card failed"));
      const result = await transport.sendRichContent("chat-r1", "{}");
      expect(result).toBe("");
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("sendMessageTo", () => {
    it("sends message with custom receive_id_type", async () => {
      const result = await transport.sendMessageTo("open-id-1", "open_id", "text", '{"text":"hi"}');
      expect(result).toBe("msg-200");

      const callArgs = larkClient.im.message.create.mock.calls[0][0];
      expect(callArgs.params.receive_id_type).toBe("open_id");
      expect(callArgs.data.receive_id).toBe("open-id-1");
      expect(callArgs.data.msg_type).toBe("text");
      expect(callArgs.data.content).toBe('{"text":"hi"}');
    });

    it("returns empty string on error", async () => {
      larkClient.im.message.create.mockRejectedValue(new Error("fail"));
      const result = await transport.sendMessageTo("id-1", "chat_id", "text", "{}");
      expect(result).toBe("");
      expect(mockLogger.error).toHaveBeenCalled();
    });
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

      // The content should be JSON with elements containing markdown tag and wide_screen_mode config
      const content = JSON.parse(callArgs.data.content);
      expect(content).toEqual({
        config: { wide_screen_mode: true },
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
        config: { wide_screen_mode: true },
        elements: [{ tag: "markdown", content: "hello" }],
      });
    });
  });

  describe("downloadMessageImage", () => {
    function attachMessageResource(client: any, stream: AsyncIterable<unknown>): void {
      client.im.messageResource = {
        get: vi.fn().mockResolvedValue({
          getReadableStream: () => stream,
        }),
      };
    }

    async function* streamOf(chunks: Buffer[]) {
      for (const c of chunks) yield c;
    }

    it("returns concatenated buffer for a valid download", async () => {
      const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      attachMessageResource(larkClient, streamOf([data.subarray(0, 4), data.subarray(4)]));
      const result = await transport.downloadMessageImage("m1", "img_1", 1024);
      expect(result?.equals(data)).toBe(true);
    });

    it("passes correct params and path to the SDK", async () => {
      attachMessageResource(larkClient, streamOf([Buffer.from([0])]));
      await transport.downloadMessageImage("msg-x", "key-y", 999);
      expect(larkClient.im.messageResource.get).toHaveBeenCalledWith({
        params: { type: "image" },
        path: { message_id: "msg-x", file_key: "key-y" },
      });
    });

    it("returns null and warns when the stream exceeds maxBytes", async () => {
      const big = Buffer.alloc(100, 1);
      attachMessageResource(larkClient, streamOf([big]));
      const result = await transport.downloadMessageImage("m1", "img_big", 10);
      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalled();
      const msg = mockLogger.warn.mock.calls[0][0] as string;
      expect(msg).toContain("img_big");
      expect(msg).toContain("10");
    });

    it("destroys the stream when oversized", async () => {
      const destroy = vi.fn();
      const stream: any = (async function* () {
        yield Buffer.alloc(100, 1);
      })();
      stream.destroy = destroy;
      larkClient.im.messageResource = {
        get: vi.fn().mockResolvedValue({ getReadableStream: () => stream }),
      };
      await transport.downloadMessageImage("m1", "k", 5);
      expect(destroy).toHaveBeenCalled();
    });

    it("converts ArrayBuffer chunks to Buffer", async () => {
      const arrBuf = new Uint8Array([1, 2, 3]).buffer;
      attachMessageResource(larkClient, streamOf([arrBuf as any]));
      const result = await transport.downloadMessageImage("m1", "img", 100);
      expect(result?.equals(Buffer.from([1, 2, 3]))).toBe(true);
    });

    it("returns null and logs error when SDK throws", async () => {
      larkClient.im.messageResource = {
        get: vi.fn().mockRejectedValue(new Error("network down")),
      };
      const result = await transport.downloadMessageImage("m1", "k", 100);
      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("consumes a rate limiter token before downloading", async () => {
      attachMessageResource(larkClient, streamOf([Buffer.from([0])]));
      await transport.downloadMessageImage("m1", "k", 100);
      expect(rateLimiter.consume).toHaveBeenCalledTimes(1);
    });

    it("returns empty buffer when stream yields nothing", async () => {
      attachMessageResource(larkClient, streamOf([]));
      const result = await transport.downloadMessageImage("m1", "k", 100);
      expect(result?.length).toBe(0);
    });
  });
});
