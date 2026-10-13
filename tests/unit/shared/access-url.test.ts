import { describe, expect, it } from "vitest";
import { normalizeAccessUrl } from "../../../shared/access-url";
import { isValidSharedSettingValue } from "../../../shared/settings-keys";

describe("Access URLs", () => {
  describe("normalizeAccessUrl", () => {
    it.each([
      ["", ""],
      ["  ", ""],
      [" http://192.168.31.123:18233/ ", "http://192.168.31.123:18233"],
      ["HTTPS://CODEMUX.EXAMPLE.COM:443/", "https://codemux.example.com"],
      ["http://[::1]:8233", "http://[::1]:8233"],
    ])("normalizes %j to %j", (input, expected) => {
      expect(normalizeAccessUrl(input)).toBe(expected);
    });

    it.each([
      "codemux.example.com", "ftp://example.com", "javascript:alert(1)",
      "https://user:secret@example.com", "https://example.com/codemux",
      "https://example.com?token=secret", "https://example.com/#chat",
      "http://example.com:99999", "https://exa mple.com", "https://exam\nple.com",
      "https:\\example.com", `https://${"a".repeat(2048)}.com`,
    ])("rejects unsupported entry %j", (input) => {
      expect(() => normalizeAccessUrl(input)).toThrow();
    });
  });

  describe("isValidSharedSettingValue", () => {
    it("accepts only normalized access URLs or an empty value to clear", () => {
      expect(isValidSharedSettingValue("customAccessUrl", "http://192.168.31.123:18233")).toBe(true);
      expect(isValidSharedSettingValue("customAccessUrl", "")).toBe(true);
      expect(isValidSharedSettingValue("customAccessUrl", "https://example.com/path")).toBe(false);
      expect(isValidSharedSettingValue("customAccessUrl", " https://example.com/ ")).toBe(false);
      expect(isValidSharedSettingValue("customAccessUrl", { url: "https://example.com" })).toBe(false);
    });
  });
});
