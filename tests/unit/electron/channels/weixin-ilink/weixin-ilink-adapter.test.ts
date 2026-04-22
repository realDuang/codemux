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
  weixinIlinkLog: mockScopedLogger,
  getDefaultEngineFromSettings: vi.fn(() => "opencode"),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/mock/userData"),
  },
}));

import { WeixinIlinkAdapter } from "../../../../../electron/main/channels/weixin-ilink/weixin-ilink-adapter";
import { DEFAULT_WEIXIN_ILINK_CONFIG } from "../../../../../electron/main/channels/weixin-ilink/weixin-ilink-types";

describe("WeixinIlinkAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getInfo", () => {
    it("reports stopped status with long-poll mode by default", () => {
      const adapter = new WeixinIlinkAdapter();
      const info = adapter.getInfo();
      expect(info.type).toBe("weixin-ilink");
      expect(info.status).toBe("stopped");
      expect(info.stats?.mode).toBe("long-poll");
      expect(info.stats?.connected).toBe(false);
    });
  });

  describe("start", () => {
    it("rejects when no botToken is configured", async () => {
      const adapter = new WeixinIlinkAdapter();
      await expect(
        adapter.start({
          type: "weixin-ilink",
          name: "WeChat iLink Bot",
          enabled: true,
          options: { ...DEFAULT_WEIXIN_ILINK_CONFIG },
        }),
      ).rejects.toThrow(/botToken/);
      expect(adapter.getInfo().status).toBe("error");
    });
  });

  describe("stop", () => {
    it("aborts the in-flight long-poll and cleans up state", async () => {
      const adapter = new WeixinIlinkAdapter() as any;

      const getUpdates = vi.fn(
        (_buf: string, signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
              { once: true },
            );
          }),
      );

      adapter.status = "running";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "token", accountId: "acct" };
      adapter.transport = {
        getUpdates,
      };
      adapter.gatewayClient = { disconnect: vi.fn() };
      adapter.streamingController = {};

      adapter.pollingActive = true;
      adapter.pollingGeneration = 1;
      const ac = new AbortController();
      adapter.pollAbortController = ac;
      adapter.pollingLoopPromise = adapter.pollingLoop(1, ac.signal);

      await Promise.resolve();
      await expect(adapter.stop()).resolves.toBeUndefined();

      expect(getUpdates).toHaveBeenCalled();
      expect(adapter.pollAbortController).toBeNull();
      expect(adapter.transport).toBeNull();
      expect(adapter.gatewayClient).toBeNull();
      expect(adapter.streamingController).toBeNull();
      expect(adapter.getInfo().status).toBe("stopped");
    });
  });

  describe("updateConfig", () => {
    it("restarts when botToken changes", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "running";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "old" };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn().mockResolvedValue(undefined);

      await adapter.updateConfig({ options: { botToken: "new" } });

      expect(adapter.stop).toHaveBeenCalledTimes(1);
      expect(adapter.start).toHaveBeenCalledTimes(1);
    });

    it("restarts when accountId changes", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "running";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "token", accountId: "a" };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn().mockResolvedValue(undefined);

      await adapter.updateConfig({ options: { accountId: "b" } });
      expect(adapter.stop).toHaveBeenCalledTimes(1);
      expect(adapter.start).toHaveBeenCalledTimes(1);
    });

    it("does not restart when only autoApprovePermissions changes", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "running";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "token" };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn().mockResolvedValue(undefined);

      await adapter.updateConfig({ options: { autoApprovePermissions: false } });
      expect(adapter.stop).not.toHaveBeenCalled();
      expect(adapter.start).not.toHaveBeenCalled();
    });

    it("does not restart when adapter is not running, even if token changes", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "stopped";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "old" };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn().mockResolvedValue(undefined);

      await adapter.updateConfig({ options: { botToken: "new" } });
      expect(adapter.stop).not.toHaveBeenCalled();
      expect(adapter.start).not.toHaveBeenCalled();
      expect(adapter.config.botToken).toBe("new");
    });
  });
});
