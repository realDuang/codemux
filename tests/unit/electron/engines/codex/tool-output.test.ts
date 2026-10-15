import { describe, expect, it } from "vitest";
import { MAX_IMAGE_SIZE_BYTES, MAX_IMAGES_PER_MESSAGE } from "../../../../../shared/image-limits";
import { extractCodexToolOutput } from "../../../../../electron/main/engines/codex/tool-output";

const base = { id: "tool-1", messageId: "message-1", sessionId: "session-1" };
const png = "iVBORw0KGgo=";
const image = { type: "image", mimeType: "image/png", data: png };

function mcp(content: unknown[], structuredContent?: unknown) {
  return { type: "mcpToolCall", result: { content, structuredContent } };
}

describe("extractCodexToolOutput", () => {
  it("retains tool text and structured values while extracting MCP images", () => {
    const result = extractCodexToolOutput(mcp([
      { type: "text", text: "  Original output\n" }, image, { type: "text", text: "Done." },
    ], { rows: 3, data: "ordinary text", ok: true }), base);

    expect(result.output).toBe('  Original output\n\nDone.\n{\n  "rows": 3,\n  "data": "ordinary text",\n  "ok": true\n}');
    expect(result.attachments).toEqual([{
      ...base, id: "tool-1:attachment:1", type: "file", mime: "image/png",
      filename: "image-2.png", url: `data:image/png;base64,${png}`,
    }]);
    expect(result.output).not.toContain(png);
  });

  it("extracts dynamic output images without treating ordinary text as encoded images", () => {
    const result = extractCodexToolOutput({ type: "dynamicToolCall", contentItems: [
      { type: "inputText", text: png },
      { type: "inputImage", imageUrl: `data:image/png;base64,${png}` },
      { type: "inputImage", imageUrl: "https://example.com/render" },
    ] }, base);

    expect(result.output).toBe(png);
    expect(result.attachments.map((part) => part.url)).toEqual([
      `data:image/png;base64,${png}`, "https://example.com/render",
    ]);
  });

  it("reads function call output tags and excludes encrypted model state", () => {
    const result = extractCodexToolOutput({ type: "functionCallOutput", output: [
      { type: "input_text", text: "A tool reply" },
      { type: "input_image", image_url: `data:image/png;base64,${png}`, detail: "original" },
      { type: "encrypted_content", encrypted_content: "opaque-model-state" },
      { type: "input_image", file_id: "file-123" },
    ] }, base);

    expect(result.output).toContain("A tool reply");
    expect(result.output).toContain("file-123");
    expect(result.output).not.toContain("opaque-model-state");
    expect(result.output).not.toContain(png);
    expect(result.attachments).toMatchObject([{ id: "tool-1:attachment:1", url: `data:image/png;base64,${png}` }]);
    expect(extractCodexToolOutput({ type: "functionCallOutput", output: "plain tool reply" }, base)).toEqual({ output: "plain tool reply", attachments: [] });
  });

  it("preserves linked and embedded resources without exposing embedded binary text", () => {
    const result = extractCodexToolOutput(mcp([
      { type: "resource_link", uri: "https://example.com/report.pdf", name: "Report", mimeType: "application/pdf" },
      { type: "resource", resource: { uri: "memory://notes", text: "Source notes", mimeType: "text/plain" } },
      { type: "resource", resource: { uri: "memory://plot", blob: png, mimeType: "image/png" } },
    ]), base);

    expect(result.output).toBe("Source notes\nmemory://notes");
    expect(result.attachments).toMatchObject([
      { id: "tool-1:attachment:0", filename: "Report", url: "https://example.com/report.pdf" },
      { id: "tool-1:attachment:2", filename: "plot", url: `data:image/png;base64,${png}` },
    ]);
  });

  it("uses generated image paths without exposing file URLs to the renderer", () => {
    const result = extractCodexToolOutput({
      type: "imageGeneration", savedPath: "/workspace/output.png", result: png, revisedPrompt: "A blue square",
    }, base);

    expect(result).toEqual({ output: "/workspace/output.png", attachments: [{
      ...base, id: "tool-1:attachment:0", type: "file", filename: "output.png",
      mime: "image/png", url: "", sourcePath: "/workspace/output.png",
    }] });
    expect(extractCodexToolOutput({ type: "imageGeneration", result: png }, base)).toEqual({ output: png, attachments: [] });
  });

  it.each([
    "javascript:alert(1)", "file:///tmp/image.png", "http://example.com/image.png",
    "https://user:password@example.com/image.png", "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,not an image", "data:text/html;base64,PHNjcmlwdD4=",
  ])("rejects unsafe or malformed image URLs: %s", (imageUrl) => {
    expect(extractCodexToolOutput({ type: "dynamicToolCall", contentItems: [{ type: "inputImage", imageUrl }] }, base).attachments).toEqual([]);
  });

  it("bounds decoded image size and count using the existing shared limits", () => {
    const largeImage = { ...image, data: "A".repeat(Math.ceil(MAX_IMAGE_SIZE_BYTES / 3) * 4 + 4) };
    const result = extractCodexToolOutput(mcp([largeImage, ...Array(MAX_IMAGES_PER_MESSAGE + 2).fill(image)]), base);

    expect(result.attachments).toHaveLength(MAX_IMAGES_PER_MESSAGE);
    expect(result.attachments[0].id).toBe("tool-1:attachment:1");
    expect(result.output).not.toContain(largeImage.data);
  });

  it("redacts media fields in structured output while keeping readable unknown blocks", () => {
    const result = extractCodexToolOutput(mcp([
      { type: "audio", mimeType: "audio/wav", data: "YWJj" },
      { type: "future", summary: "New result" }, 42,
    ], { preview: image, url: `data:image/png;base64,${png}` }), base);

    expect(result.output).toContain("New result");
    expect(result.output).toContain("42");
    expect(result.output).toContain("[binary content omitted]");
    expect(result.output).not.toContain("YWJj");
    expect(result.output).not.toContain(png);
  });

  it("retains unrelated output and leaves pending results empty", () => {
    expect(extractCodexToolOutput({ type: "other", result: { ok: true } }, base)).toEqual({ output: { ok: true }, attachments: [] });
    expect(extractCodexToolOutput(mcp([]), base)).toEqual({ output: "", attachments: [] });
    expect(extractCodexToolOutput(null, base)).toEqual({ output: undefined, attachments: [] });
  });
});
