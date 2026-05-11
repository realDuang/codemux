import { describe, expect, it } from "vitest";
import { WeixinIlinkRenderer } from "../../../../../electron/main/channels/weixin-ilink/weixin-ilink-renderer";

describe("WeixinIlinkRenderer", () => {
  const renderer = new WeixinIlinkRenderer();

  describe("renderStreamingUpdate", () => {
    it("returns thinking placeholder when buffer is empty", () => {
      expect(renderer.renderStreamingUpdate("")).toBe("🤔 思考中...");
    });

    it("returns the buffer untouched when within size limit", () => {
      expect(renderer.renderStreamingUpdate("hello")).toBe("hello");
    });

    it("truncates long streaming buffers", () => {
      const out = renderer.renderStreamingUpdate("x".repeat(5000));
      expect(out.length).toBeLessThanOrEqual(4096);
      expect(out).toContain("内容已截断");
    });
  });

  describe("renderFinalReply", () => {
    it("returns plain text payload", () => {
      const result = renderer.renderFinalReply("Hello world");
      expect(result.type).toBe("text");
      expect(result.content).toBe("Hello world");
    });

    it("prepends a title block when provided", () => {
      const result = renderer.renderFinalReply("body", undefined, "Title");
      expect(result.content.startsWith("【Title】")).toBe(true);
      expect(result.content).toContain("body");
    });

    it("appends tool summary when provided", () => {
      const result = renderer.renderFinalReply("body", "tool: ran 3 commands");
      expect(result.content).toContain("body");
      expect(result.content).toContain("tool: ran 3 commands");
    });

    it("truncates very large final replies", () => {
      const result = renderer.renderFinalReply("y".repeat(5000));
      expect(result.content.length).toBeLessThanOrEqual(4096);
      expect(result.content).toContain("内容已截断");
    });
  });

  describe("truncate", () => {
    it("returns text unchanged if it fits", () => {
      expect(renderer.truncate("short")).toBe("short");
    });

    it("appends truncation notice when too long", () => {
      const out = renderer.truncate("a".repeat(5000));
      expect(out.length).toBeLessThanOrEqual(4096);
      expect(out.endsWith("CodeMux 中查看完整回复）")).toBe(true);
    });
  });
});
