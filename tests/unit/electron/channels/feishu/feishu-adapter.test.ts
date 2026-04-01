import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FEISHU_CONFIG } from "../../../../../electron/main/channels/feishu/feishu-types";

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
  feishuLog: mockScopedLogger,
  larkLog: mockScopedLogger,
  channelLog: mockScopedLogger,
  getDefaultEngineFromSettings: vi.fn(() => "opencode"),
  getFeishuChannelLog: vi.fn(() => mockScopedLogger),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/mock/userData"),
  },
}));

import { FeishuAdapter } from "../../../../../electron/main/channels/feishu/feishu-adapter";

describe("FeishuAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe("mergeConfig", () => {
    it("merges defined fields while preserving existing values for undefined updates", () => {
      const adapter = new FeishuAdapter() as any;
      const baseConfig = {
        ...DEFAULT_FEISHU_CONFIG,
        appId: "app-1",
        appSecret: "secret-1",
        gatewayUrl: "ws://127.0.0.1:4200",
      };

      const merged = adapter.mergeConfig(baseConfig, {
        appId: undefined,
        appSecret: "secret-2",
        gatewayUrl: undefined,
        platform: "lark",
      });

      expect(merged.appId).toBe("app-1");
      expect(merged.appSecret).toBe("secret-2");
      expect(merged.gatewayUrl).toBe("ws://127.0.0.1:4200");
      expect(merged.platform).toBe("lark");
    });
  });

  describe("getInfo", () => {
    it("uses the selected platform in the channel display name", () => {
      const adapter = new FeishuAdapter() as any;
      adapter.config = { ...DEFAULT_FEISHU_CONFIG, platform: "lark" };

      expect(adapter.getInfo().name).toBe("Lark Bot");
    });
  });

  describe("updateConfig", () => {
    it("retries once after a transient busy error when restarting with new credentials", async () => {
      vi.useFakeTimers();
      const adapter = new FeishuAdapter() as any;
      adapter.status = "running";
      adapter.config = {
        ...DEFAULT_FEISHU_CONFIG,
        platform: "lark",
        appId: "old-app",
        appSecret: "old-secret",
      };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn()
        .mockRejectedValueOnce(new Error("Failed to connect to Lark long connection. Original error: [ws] code: 1000040345, system busy"))
        .mockResolvedValueOnce(undefined);

      const updatePromise = adapter.updateConfig({
        options: {
          appId: "new-app",
          appSecret: "new-secret",
        },
      });

      await vi.runAllTimersAsync();

      await expect(updatePromise).resolves.toBeUndefined();
      expect(adapter.stop).toHaveBeenCalledTimes(1);
      expect(adapter.start).toHaveBeenCalledTimes(2);
      expect(mockScopedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("retrying once"),
      );
    });

    it("does not retry non-transient restart failures", async () => {
      vi.useFakeTimers();
      const adapter = new FeishuAdapter() as any;
      adapter.status = "running";
      adapter.config = {
        ...DEFAULT_FEISHU_CONFIG,
        platform: "lark",
        appId: "old-app",
        appSecret: "old-secret",
      };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn().mockRejectedValueOnce(new Error("invalid app credentials"));

      const updatePromise = adapter.updateConfig({
        options: {
          appId: "new-app",
          appSecret: "new-secret",
        },
      });
      const rejection = expect(updatePromise).rejects.toThrow("invalid app credentials");

      await vi.runAllTimersAsync();

      await rejection;
      expect(adapter.stop).toHaveBeenCalledTimes(1);
      expect(adapter.start).toHaveBeenCalledTimes(1);
    });
  });

  describe("createWsStartupMonitor", () => {
    it("maps SDK trace/info logs onto electron-log levels without dropping them", () => {
      const adapter = new FeishuAdapter() as any;
      adapter.config = { ...DEFAULT_FEISHU_CONFIG, platform: "lark" };
      adapter.status = "starting";

      const monitor = adapter.createWsStartupMonitor("lark", true);
      monitor.logger.trace("trace message");
      monitor.logger.info("background reconnect info");
      monitor.logger.info("ws client ready");

      expect(mockScopedLogger.debug).toHaveBeenCalledWith("trace message");
      expect(mockScopedLogger.verbose).toHaveBeenCalledWith("background reconnect info");
      expect(mockScopedLogger.info).toHaveBeenCalledWith("ws client ready");
    });

    it("falls back to WSClient.start() resolution if the ready log never appears", async () => {
      vi.useFakeTimers();
      const adapter = new FeishuAdapter() as any;
      adapter.config = { ...DEFAULT_FEISHU_CONFIG, platform: "lark" };

      const monitor = adapter.createWsStartupMonitor("lark", true);
      const readyPromise = monitor.readyPromise;
      monitor.markStartResolved();

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(readyPromise).resolves.toBeUndefined();
      expect(mockScopedLogger.warn).toHaveBeenCalledWith(expect.stringContaining("weak success signal"));
    });

    it("still rejects if startup neither resolves nor emits a ready log", async () => {
      vi.useFakeTimers();
      const adapter = new FeishuAdapter() as any;
      adapter.config = { ...DEFAULT_FEISHU_CONFIG, platform: "feishu" };

      const monitor = adapter.createWsStartupMonitor("feishu", true);
      const readyPromise = monitor.readyPromise;

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(readyPromise).rejects.toThrow("Timed out waiting for Feishu websocket connection");
    });
  });
});
