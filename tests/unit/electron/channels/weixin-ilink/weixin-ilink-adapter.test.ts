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

  describe("logout", () => {
    it("exposes CLEARED_CREDENTIALS static with empty botToken/accountId", () => {
      expect(WeixinIlinkAdapter.CLEARED_CREDENTIALS).toEqual({
        botToken: "",
        accountId: "",
      });
    });

    it("from stopped state: clears bindings and credentials without calling stop()", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "stopped";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "tk", accountId: "acct" };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      const clearSpy = vi.spyOn(adapter.sessionMapper, "clearAllBindings");

      await adapter.logout();

      expect(adapter.stop).not.toHaveBeenCalled();
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(adapter.config.botToken).toBe("");
      expect(adapter.config.accountId).toBe("");
    });

    it("from running state: stops the adapter then wipes bindings + credentials", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "running";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "tk", accountId: "acct" };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      const clearSpy = vi.spyOn(adapter.sessionMapper, "clearAllBindings");

      await adapter.logout();

      expect(adapter.stop).toHaveBeenCalledTimes(1);
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(adapter.config.botToken).toBe("");
      expect(adapter.config.accountId).toBe("");
    });
  });

  describe("handleSessionExpired", () => {
    it("calls logout, transitions to error, emits status.changed and auth.expired", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "running";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "tk", accountId: "acct" };
      adapter.stop = vi.fn().mockResolvedValue(undefined);

      const events: Array<{ name: string; payload: any }> = [];
      adapter.on("status.changed", (s: any) => events.push({ name: "status.changed", payload: s }));
      adapter.on("auth.expired", (p: any) => events.push({ name: "auth.expired", payload: p }));

      await adapter.handleSessionExpired();

      expect(adapter.stop).toHaveBeenCalled();
      expect(adapter.status).toBe("error");
      expect(adapter.error).toMatch(/expired/i);
      // First emission must be status.changed("error"), then auth.expired
      const statusEvt = events.find((e) => e.name === "status.changed");
      const authEvt = events.find((e) => e.name === "auth.expired");
      expect(statusEvt?.payload).toBe("error");
      expect(authEvt?.payload.clearOptions).toEqual(
        WeixinIlinkAdapter.CLEARED_CREDENTIALS,
      );
      expect(authEvt?.payload.reason).toMatch(/expired/i);
    });

    it("still emits auth.expired even if logout() throws", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "running";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "tk", accountId: "acct" };
      adapter.stop = vi.fn().mockRejectedValue(new Error("stop failed"));

      const handler = vi.fn();
      adapter.on("auth.expired", handler);

      await adapter.handleSessionExpired();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(adapter.status).toBe("error");
    });
  });
});
