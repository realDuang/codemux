import { describe, expect, it } from "vitest";
import type { MessagePromptContent } from "../../../../../src/types/unified";

/**
 * Tests for image content conversion logic in each engine adapter.
 *
 * These tests verify the transformation of MessagePromptContent[] with image
 * entries into each engine's SDK-specific format, without instantiating
 * actual adapter classes or SDK clients.
 */

const TEXT_CONTENT: MessagePromptContent = { type: "text", text: "Describe this image" };
const IMAGE_CONTENT: MessagePromptContent = {
  type: "image",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  mimeType: "image/png",
};

describe("OpenCode image content conversion", () => {
  function convertToOpenCodeParts(content: MessagePromptContent[]) {
    // Mirrors the logic in opencode/index.ts sendMessage
    const parts: Array<
      | { type: "text"; text: string }
      | { type: "file"; mime: string; url: string; filename?: string }
    > = [];
    for (const c of content) {
      if (c.type === "text" && c.text) {
        parts.push({ type: "text", text: c.text });
      } else if (c.type === "image" && c.data) {
        const mime = c.mimeType ?? "image/png";
        parts.push({
          type: "file",
          mime,
          url: `data:${mime};base64,${c.data}`,
          filename: "image.png",
        });
      }
    }
    if (parts.length === 0) {
      parts.push({ type: "text", text: "" });
    }
    return parts;
  }

  it("converts text-only content", () => {
    const parts = convertToOpenCodeParts([TEXT_CONTENT]);
    expect(parts).toEqual([{ type: "text", text: "Describe this image" }]);
  });

  it("converts image content to FilePartInput format", () => {
    const parts = convertToOpenCodeParts([TEXT_CONTENT, IMAGE_CONTENT]);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "Describe this image" });
    expect(parts[1]).toMatchObject({
      type: "file",
      mime: "image/png",
      filename: "image.png",
    });
    expect((parts[1] as any).url).toMatch(/^data:image\/png;base64,/);
  });

  it("defaults mimeType to image/png when missing", () => {
    const noMime: MessagePromptContent = { type: "image", data: "abc123" };
    const parts = convertToOpenCodeParts([noMime]);
    expect(parts[0]).toMatchObject({ type: "file", mime: "image/png" });
    expect((parts[0] as any).url).toBe("data:image/png;base64,abc123");
  });

  it("falls back to empty text when content is empty", () => {
    const parts = convertToOpenCodeParts([]);
    expect(parts).toEqual([{ type: "text", text: "" }]);
  });
});

describe("Claude image content conversion", () => {
  function convertToClaudeMessage(content: MessagePromptContent[]) {
    // Mirrors the logic in claude/index.ts sendMessage
    const textContent = content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const imageContents = content.filter((c) => c.type === "image" && c.data);
    const hasImages = imageContents.length > 0;

    if (!hasImages) return textContent;

    const contentBlocks: Array<{ type: string; [key: string]: any }> = [];
    if (textContent.trim()) {
      contentBlocks.push({ type: "text", text: textContent });
    }
    for (const img of imageContents) {
      contentBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mimeType ?? "image/png",
          data: img.data!,
        },
      });
    }
    return {
      type: "user",
      message: { role: "user", content: contentBlocks },
      parent_tool_use_id: null,
      session_id: "",
    };
  }

  it("returns plain string for text-only content", () => {
    const result = convertToClaudeMessage([TEXT_CONTENT]);
    expect(result).toBe("Describe this image");
  });

  it("returns SDKUserMessage for content with images", () => {
    const result = convertToClaudeMessage([TEXT_CONTENT, IMAGE_CONTENT]) as any;
    expect(result.type).toBe("user");
    expect(result.message.role).toBe("user");
    expect(result.message.content).toHaveLength(2);
    expect(result.message.content[0]).toEqual({ type: "text", text: "Describe this image" });
    expect(result.message.content[1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    });
    expect(result.message.content[1].source.data).toBeTruthy();
  });

  it("handles image-only content (no text)", () => {
    const result = convertToClaudeMessage([IMAGE_CONTENT]) as any;
    expect(result.type).toBe("user");
    expect(result.message.content).toHaveLength(1);
    expect(result.message.content[0].type).toBe("image");
  });

  it("handles multiple images", () => {
    const jpeg: MessagePromptContent = { type: "image", data: "jpegdata", mimeType: "image/jpeg" };
    const result = convertToClaudeMessage([TEXT_CONTENT, IMAGE_CONTENT, jpeg]) as any;
    expect(result.message.content).toHaveLength(3);
    expect(result.message.content[1].source.media_type).toBe("image/png");
    expect(result.message.content[2].source.media_type).toBe("image/jpeg");
  });
});

describe("Copilot image content conversion", () => {
  function buildCopilotAttachments(content: MessagePromptContent[]) {
    // Mirrors the logic in copilot/index.ts sendMessage — returns attachment descriptors
    // (actual file writing is not tested here, only the mapping logic)
    const imageContents = content.filter((c) => c.type === "image" && c.data);
    const attachments: Array<{ type: "file"; path: string; displayName?: string }> = [];

    for (const img of imageContents) {
      const ext = img.mimeType?.split("/")[1] ?? "png";
      attachments.push({
        type: "file",
        path: `/tmp/codemux-img-test/image.${ext}`,
        displayName: `image.${ext}`,
      });
    }
    return attachments;
  }

  it("returns empty attachments for text-only content", () => {
    const attachments = buildCopilotAttachments([TEXT_CONTENT]);
    expect(attachments).toEqual([]);
  });

  it("creates file attachment for image content", () => {
    const attachments = buildCopilotAttachments([TEXT_CONTENT, IMAGE_CONTENT]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      type: "file",
      displayName: "image.png",
    });
    expect(attachments[0].path).toMatch(/\.png$/);
  });

  it("uses correct extension from mimeType", () => {
    const jpeg: MessagePromptContent = { type: "image", data: "data", mimeType: "image/jpeg" };
    const webp: MessagePromptContent = { type: "image", data: "data", mimeType: "image/webp" };
    const attachments = buildCopilotAttachments([jpeg, webp]);
    expect(attachments[0].path).toMatch(/\.jpeg$/);
    expect(attachments[1].path).toMatch(/\.webp$/);
  });

  it("defaults to png extension when mimeType is missing", () => {
    const noMime: MessagePromptContent = { type: "image", data: "data" };
    const attachments = buildCopilotAttachments([noMime]);
    expect(attachments[0].path).toMatch(/\.png$/);
  });
});
