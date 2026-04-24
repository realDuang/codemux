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

import {
  TelegramTransport,
  markdownToTelegramHtml,
} from "../../../../../electron/main/channels/telegram/telegram-transport";

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

describe("TelegramTransport", () => {
  let transport: TelegramTransport;
  let rateLimiter: ReturnType<typeof makeRateLimiter>;
  const BOT_TOKEN = "123:ABC";

  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiter = makeRateLimiter();
    transport = new TelegramTransport(BOT_TOKEN, rateLimiter);
  });

  describe("sendMarkdown", () => {
    it("converts markdown to HTML and sends with parse_mode HTML", async () => {
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({ ok: true, result: { message_id: 42 } }),
      );

      const result = await transport.sendMarkdown("chat-1", "**hello** `code`");
      expect(result).toBe("42");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
      expect(opts.method).toBe("POST");

      const body = JSON.parse(opts.body);
      expect(body.chat_id).toBe("chat-1");
      expect(body.parse_mode).toBe("HTML");
      // The text should be HTML-converted
      expect(body.text).toBe("<b>hello</b> <code>code</code>");
    });

    it("falls back to plain text when HTML send returns no message_id", async () => {
      // First call (HTML) returns no message_id
      fetchMock
        .mockResolvedValueOnce(makeOkResponse({ ok: false }))
        // Second call (plain text) succeeds
        .mockResolvedValueOnce(
          makeOkResponse({ ok: true, result: { message_id: 99 } }),
        );

      const result = await transport.sendMarkdown("chat-1", "**bold**");
      expect(result).toBe("99");

      // Verify second call is plain text (no parse_mode)
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(secondBody.text).toBe("**bold**");
      expect(secondBody.parse_mode).toBeUndefined();
    });

    it("returns empty string when both HTML and plain text fallback fail", async () => {
      fetchMock
        .mockResolvedValueOnce(makeOkResponse({ ok: false }))
        .mockResolvedValueOnce(makeOkResponse({ ok: true, result: {} }));

      const result = await transport.sendMarkdown("chat-1", "test");
      expect(result).toBe("");
    });

    it("returns empty string and logs error on exception", async () => {
      fetchMock.mockRejectedValueOnce(new Error("network error"));

      const result = await transport.sendMarkdown("chat-1", "test");
      expect(result).toBe("");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("consumes rate limiter token", async () => {
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({ ok: true, result: { message_id: 1 } }),
      );
      await transport.sendMarkdown("chat-1", "test");
      expect(rateLimiter.consume).toHaveBeenCalledTimes(1);
    });

    it("escapes HTML entities in markdown before conversion", async () => {
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({ ok: true, result: { message_id: 10 } }),
      );

      await transport.sendMarkdown("chat-1", "a < b & c > d");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // HTML entities should be escaped
      expect(body.text).toBe("a &lt; b &amp; c &gt; d");
    });
  });
});

describe("markdownToTelegramHtml", () => {
  it("converts **bold** to <b> tags", () => {
    expect(markdownToTelegramHtml("**hello**")).toBe("<b>hello</b>");
  });

  it("converts `code` to <code> tags", () => {
    expect(markdownToTelegramHtml("`snippet`")).toBe("<code>snippet</code>");
  });

  it("handles mixed bold and code", () => {
    expect(markdownToTelegramHtml("**bold** and `code`")).toBe(
      "<b>bold</b> and <code>code</code>",
    );
  });

  it("escapes HTML entities before conversion", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toBe(
      "a &lt; b &amp; c &gt; d",
    );
  });

  it("escapes HTML entities inside bold text", () => {
    expect(markdownToTelegramHtml("**<script>**")).toBe(
      "<b>&lt;script&gt;</b>",
    );
  });

  it("returns plain text unchanged when no markdown syntax", () => {
    expect(markdownToTelegramHtml("just text")).toBe("just text");
  });

  it("handles multiple bold segments", () => {
    expect(markdownToTelegramHtml("**a** then **b**")).toBe(
      "<b>a</b> then <b>b</b>",
    );
  });

  it("handles multiple code segments", () => {
    expect(markdownToTelegramHtml("`x` and `y`")).toBe(
      "<code>x</code> and <code>y</code>",
    );
  });
});
