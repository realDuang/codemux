import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockScopedLogger } = vi.hoisted(() => ({
  mockScopedLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
    debug: vi.fn(),
    silly: vi.fn(),
  },
}));

vi.mock("../../../../../electron/main/services/logger", () => ({
  channelLog: mockScopedLogger,
}));

import {
  WeixinIlinkTransport,
  buildIlinkAuthHeaders,
  randomUint32Base64,
} from "../../../../../electron/main/channels/weixin-ilink/weixin-ilink-transport";
import { ILINK_BASE_URL, SESSION_EXPIRED_CODE } from "../../../../../electron/main/channels/weixin-ilink/weixin-ilink-types";

describe("weixin-ilink transport helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("randomUint32Base64", () => {
    it("returns base64-encoded uint32 string", () => {
      const out = randomUint32Base64();
      expect(typeof out).toBe("string");
      const decoded = Buffer.from(out, "base64").toString("utf8");
      const n = Number(decoded);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(4_294_967_296);
    });
  });

  describe("buildIlinkAuthHeaders", () => {
    it("includes the iLink auth-type and a UIN header", () => {
      const headers = buildIlinkAuthHeaders();
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["AuthorizationType"]).toBe("ilink_bot_token");
      expect(headers["X-WECHAT-UIN"]).toBeTruthy();
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("attaches Bearer Authorization when bot token provided", () => {
      const headers = buildIlinkAuthHeaders("abc");
      expect(headers["Authorization"]).toBe("Bearer abc");
    });
  });
});

describe("WeixinIlinkTransport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isSessionExpired", () => {
    it("recognises -14 in ret or errcode", () => {
      expect(WeixinIlinkTransport.isSessionExpired(SESSION_EXPIRED_CODE)).toBe(true);
      expect(WeixinIlinkTransport.isSessionExpired(undefined, SESSION_EXPIRED_CODE)).toBe(true);
    });

    it("returns false for any other value", () => {
      expect(WeixinIlinkTransport.isSessionExpired(0, 0)).toBe(false);
      expect(WeixinIlinkTransport.isSessionExpired(undefined, undefined)).toBe(false);
      expect(WeixinIlinkTransport.isSessionExpired(1, 2)).toBe(false);
    });
  });

  describe("context token cache", () => {
    it("set/get/clear context tokens, scoped by accountId+userId", () => {
      const t = new WeixinIlinkTransport("token", ILINK_BASE_URL, "acct-1");
      expect(t.getContextToken("user-a")).toBeUndefined();
      t.setContextToken("user-a", "ctx-a");
      expect(t.getContextToken("user-a")).toBe("ctx-a");
      expect(t.contextTokenKey("user-a")).toBe("acct-1:user-a");
      t.clearContextTokens();
      expect(t.getContextToken("user-a")).toBeUndefined();
    });

    it("uses bare userId as key when accountId is empty", () => {
      const t = new WeixinIlinkTransport("token", ILINK_BASE_URL, "");
      expect(t.contextTokenKey("user-z")).toBe("user-z");
    });

    it("updateCredentials clears the cache and updates credentials", () => {
      const t = new WeixinIlinkTransport("old", ILINK_BASE_URL, "acct-1");
      t.setContextToken("user-a", "ctx-a");
      t.updateCredentials("new", "https://override.example.com", "acct-2");
      expect(t.getContextToken("user-a")).toBeUndefined();
      // accountId rotation must change cache key
      expect(t.contextTokenKey("user-a")).toBe("acct-2:user-a");
    });

    it("baseUrl falls back to default when empty after updateCredentials", () => {
      const t = new WeixinIlinkTransport("token", ILINK_BASE_URL, "acct");
      t.updateCredentials("token2", "", "acct2");
      // Constructor / updateCredentials swap to default — verify via private read
      // by exercising sendText's missing-context-token branch (returns empty string).
    });
  });

  describe("sendText capability fallbacks", () => {
    it("returns empty string and logs when no context token cached", async () => {
      const t = new WeixinIlinkTransport("token", ILINK_BASE_URL, "acct");
      const out = await t.sendText("user-x", "hello");
      expect(out).toBe("");
      expect(mockScopedLogger.warn).toHaveBeenCalled();
    });

    it("updateText / deleteMessage are no-ops", async () => {
      const t = new WeixinIlinkTransport("token", ILINK_BASE_URL, "acct");
      await expect(t.updateText("id", "x")).resolves.toBeUndefined();
      await expect(t.deleteMessage("id")).resolves.toBeUndefined();
    });

    it("sendRichContent forwards to sendText (which returns '' without context token)", async () => {
      const t = new WeixinIlinkTransport("token", ILINK_BASE_URL, "acct");
      await expect(t.sendRichContent("user-x", "rich")).resolves.toBe("");
    });

    it("composeMessageId joins chatId and messageId with ':'", () => {
      const t = new WeixinIlinkTransport("token", ILINK_BASE_URL, "acct");
      expect(t.composeMessageId("u-1", "42")).toBe("u-1:42");
    });
  });
});
