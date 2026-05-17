import { describe, expect, it } from "vitest";
import {
  buildPromptContent,
  detectImageMime,
  parseFeishuMessageContent,
  stripFeishuMentions,
  type ParsedContentPart,
} from "../../../../../electron/main/channels/feishu/feishu-content-parser";

describe("stripFeishuMentions", () => {
  it.each([
    ["@_user_1 hello", " hello"],
    ["hi @_user_42 there @_user_3", "hi  there "],
    ["plain text", "plain text"],
    ["@_user_", "@_user_"],
    ["@_user_12abc", "abc"],
  ])("strips %j → %j", (input, expected) => {
    expect(stripFeishuMentions(input)).toBe(expected);
  });
});

describe("parseFeishuMessageContent", () => {
  describe("text message", () => {
    it("extracts text from JSON content", () => {
      const result = parseFeishuMessageContent("text", JSON.stringify({ text: "hello" }));
      expect(result).toEqual({
        text: "hello",
        parts: [{ type: "text", text: "hello" }],
      });
    });

    it("strips mentions and trims whitespace", () => {
      const result = parseFeishuMessageContent(
        "text",
        JSON.stringify({ text: "  @_user_1 hello @_user_2  " }),
      );
      expect(result.text).toBe("hello");
      expect(result.parts).toEqual([{ type: "text", text: "hello" }]);
    });

    it("returns empty when text reduces to nothing after mention strip", () => {
      const result = parseFeishuMessageContent(
        "text",
        JSON.stringify({ text: "@_user_1 @_user_2   " }),
      );
      expect(result).toEqual({ text: "", parts: [] });
    });

    it("falls back to raw content when JSON.parse fails", () => {
      const result = parseFeishuMessageContent("text", "raw plain string");
      expect(result.text).toBe("raw plain string");
      expect(result.parts).toEqual([{ type: "text", text: "raw plain string" }]);
    });

    it("returns empty when text field missing or not a string", () => {
      expect(parseFeishuMessageContent("text", JSON.stringify({}))).toEqual({
        text: "",
        parts: [],
      });
      expect(parseFeishuMessageContent("text", JSON.stringify({ text: 123 }))).toEqual({
        text: "",
        parts: [],
      });
    });
  });

  describe("image message", () => {
    it("extracts image_key", () => {
      const result = parseFeishuMessageContent(
        "image",
        JSON.stringify({ image_key: "img_abc" }),
      );
      expect(result).toEqual({
        text: "",
        parts: [{ type: "image-key", imageKey: "img_abc" }],
      });
    });

    it("returns empty when image_key missing", () => {
      expect(parseFeishuMessageContent("image", JSON.stringify({}))).toEqual({
        text: "",
        parts: [],
      });
    });

    it("returns empty on malformed JSON", () => {
      expect(parseFeishuMessageContent("image", "not json")).toEqual({
        text: "",
        parts: [],
      });
    });

    it("ignores non-string image_key values", () => {
      expect(
        parseFeishuMessageContent("image", JSON.stringify({ image_key: 42 })),
      ).toEqual({ text: "", parts: [] });
    });
  });

  describe("post message", () => {
    it("includes title as first text part", () => {
      const result = parseFeishuMessageContent(
        "post",
        JSON.stringify({
          title: "My Post",
          content: [[{ tag: "text", text: "body" }]],
        }),
      );
      expect(result.parts).toEqual([
        { type: "text", text: "My Post" },
        { type: "text", text: "body" },
      ]);
      expect(result.text).toBe("My Post\nbody");
    });

    it("preserves order of text and images within a row", () => {
      const result = parseFeishuMessageContent(
        "post",
        JSON.stringify({
          content: [[
            { tag: "text", text: "before " },
            { tag: "img", image_key: "img_1" },
            { tag: "text", text: " after" },
          ]],
        }),
      );
      expect(result.parts).toEqual([
        { type: "text", text: "before" },
        { type: "image-key", imageKey: "img_1" },
        { type: "text", text: "after" },
      ]);
    });

    it("handles multiple rows preserving order", () => {
      const result = parseFeishuMessageContent(
        "post",
        JSON.stringify({
          content: [
            [{ tag: "text", text: "row1" }],
            [{ tag: "img", image_key: "img_a" }],
            [{ tag: "text", text: "row3" }],
          ],
        }),
      );
      expect(result.parts).toEqual([
        { type: "text", text: "row1" },
        { type: "image-key", imageKey: "img_a" },
        { type: "text", text: "row3" },
      ]);
    });

    it("renders links as markdown when href present", () => {
      const result = parseFeishuMessageContent(
        "post",
        JSON.stringify({
          content: [[{ tag: "a", text: "GitHub", href: "https://github.com" }]],
        }),
      );
      expect(result.parts).toEqual([
        { type: "text", text: "[GitHub](https://github.com)" },
      ]);
    });

    it("renders link without href as plain text", () => {
      const result = parseFeishuMessageContent(
        "post",
        JSON.stringify({
          content: [[{ tag: "a", text: "GitHub" }]],
        }),
      );
      expect(result.parts).toEqual([{ type: "text", text: "GitHub" }]);
    });

    it("renders at mentions with @user_name", () => {
      const result = parseFeishuMessageContent(
        "post",
        JSON.stringify({
          content: [[
            { tag: "text", text: "hi " },
            { tag: "at", user_name: "alice" },
          ]],
        }),
      );
      expect(result.parts).toEqual([{ type: "text", text: "hi @alice" }]);
    });

    it("renders code_inline with backticks", () => {
      const result = parseFeishuMessageContent(
        "post",
        JSON.stringify({
          content: [[{ tag: "code_inline", text: "npm run dev" }]],
        }),
      );
      expect(result.parts).toEqual([{ type: "text", text: "`npm run dev`" }]);
    });

    it("ignores unknown tags", () => {
      const result = parseFeishuMessageContent(
        "post",
        JSON.stringify({
          content: [[
            { tag: "text", text: "keep " },
            { tag: "media", url: "x" },
            { tag: "text", text: "this" },
          ]],
        }),
      );
      expect(result.parts).toEqual([{ type: "text", text: "keep this" }]);
    });

    it("skips img element without image_key", () => {
      const result = parseFeishuMessageContent(
        "post",
        JSON.stringify({
          content: [[
            { tag: "text", text: "no img" },
            { tag: "img" },
          ]],
        }),
      );
      expect(result.parts).toEqual([{ type: "text", text: "no img" }]);
    });

    it("returns empty on malformed JSON", () => {
      expect(parseFeishuMessageContent("post", "garbage")).toEqual({
        text: "",
        parts: [],
      });
    });

    it("returns empty when content array missing", () => {
      expect(
        parseFeishuMessageContent("post", JSON.stringify({ title: "" })),
      ).toEqual({ text: "", parts: [] });
    });

    it("skips rows that are not arrays", () => {
      const result = parseFeishuMessageContent(
        "post",
        JSON.stringify({
          content: ["bad row", [{ tag: "text", text: "good" }]],
        }),
      );
      expect(result.parts).toEqual([{ type: "text", text: "good" }]);
    });

    it("strips @_user_N mentions from post text parts", () => {
      const result = parseFeishuMessageContent(
        "post",
        JSON.stringify({
          content: [[{ tag: "text", text: "@_user_1 hello" }]],
        }),
      );
      expect(result.parts).toEqual([{ type: "text", text: "hello" }]);
    });
  });

  describe("unsupported message types", () => {
    it.each(["audio", "video", "sticker", "file", "system", ""])(
      "returns empty for %s",
      (type) => {
        expect(parseFeishuMessageContent(type, JSON.stringify({}))).toEqual({
          text: "",
          parts: [],
        });
      },
    );
  });
});

describe("detectImageMime", () => {
  it("detects PNG via 8-byte signature", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(detectImageMime(buf)).toBe("image/png");
  });

  it("detects JPEG via 3-byte signature", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    expect(detectImageMime(buf)).toBe("image/jpeg");
  });

  it.each([
    ["GIF87a", [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]],
    ["GIF89a", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  ])("detects %s as image/gif", (_name, bytes) => {
    expect(detectImageMime(Buffer.from(bytes))).toBe("image/gif");
  });

  it("detects WebP (RIFF...WEBP)", () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // size (don't care)
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]);
    expect(detectImageMime(buf)).toBe("image/webp");
  });

  it("returns null for unknown format", () => {
    expect(detectImageMime(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });

  it("returns null for tiny buffers below signature length", () => {
    expect(detectImageMime(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(detectImageMime(Buffer.from([]))).toBeNull();
  });

  it("returns null when GIF bytes are not GIF87a or GIF89a", () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x35, 0x61]); // GIF85a
    expect(detectImageMime(buf)).toBeNull();
  });

  it("returns null when RIFF header lacks WEBP signature", () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x41, 0x56, 0x49, 0x20, // AVI (not WEBP)
    ]);
    expect(detectImageMime(buf)).toBeNull();
  });
});

describe("buildPromptContent", () => {
  it("returns empty when no parts", () => {
    expect(buildPromptContent([], new Map())).toEqual([]);
  });

  it("joins consecutive text parts with newline", () => {
    const parts: ParsedContentPart[] = [
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ];
    expect(buildPromptContent(parts, new Map())).toEqual([
      { type: "text", text: "one\ntwo" },
    ]);
  });

  it("preserves text/image/text ordering", () => {
    const parts: ParsedContentPart[] = [
      { type: "text", text: "before" },
      { type: "image-key", imageKey: "img_1" },
      { type: "text", text: "after" },
    ];
    const data = new Map([
      ["img_1", { data: "AAA", mimeType: "image/png" }],
    ]);
    expect(buildPromptContent(parts, data)).toEqual([
      { type: "text", text: "before" },
      { type: "image", data: "AAA", mimeType: "image/png" },
      { type: "text", text: "after" },
    ]);
  });

  it("drops image parts whose data is missing from the map", () => {
    const parts: ParsedContentPart[] = [
      { type: "text", text: "hi" },
      { type: "image-key", imageKey: "missing" },
      { type: "text", text: "bye" },
    ];
    expect(buildPromptContent(parts, new Map())).toEqual([
      { type: "text", text: "hi\nbye" },
    ]);
  });

  it("skips empty/whitespace-only text parts", () => {
    const parts: ParsedContentPart[] = [
      { type: "text", text: "   " },
      { type: "text", text: "real" },
      { type: "text", text: "" },
    ];
    expect(buildPromptContent(parts, new Map())).toEqual([
      { type: "text", text: "real" },
    ]);
  });

  it("emits multiple images in order with correct interleaved text", () => {
    const parts: ParsedContentPart[] = [
      { type: "image-key", imageKey: "a" },
      { type: "text", text: "middle" },
      { type: "image-key", imageKey: "b" },
    ];
    const data = new Map([
      ["a", { data: "DA", mimeType: "image/jpeg" }],
      ["b", { data: "DB", mimeType: "image/png" }],
    ]);
    expect(buildPromptContent(parts, data)).toEqual([
      { type: "image", data: "DA", mimeType: "image/jpeg" },
      { type: "text", text: "middle" },
      { type: "image", data: "DB", mimeType: "image/png" },
    ]);
  });
});
