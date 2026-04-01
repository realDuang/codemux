import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TELEGRAM_CONFIG } from "../../../../../electron/main/channels/telegram/telegram-types";

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
  telegramLog: mockScopedLogger,
  getDefaultEngineFromSettings: vi.fn(() => "opencode"),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/mock/userData"),
  },
}));

import { TelegramAdapter } from "../../../../../electron/main/channels/telegram/telegram-adapter";

describe("TelegramAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("stop", () => {
    it("aborts in-flight long polling before shutdown completes", async () => {
      const adapter = new TelegramAdapter() as any;
      const getUpdates = vi.fn((_offset?: number, _timeout?: number, signal?: AbortSignal) => new Promise((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      }));

      adapter.status = "running";
      adapter.config = { ...DEFAULT_TELEGRAM_CONFIG, botToken: "token" };
      adapter.transport = {
        getUpdates,
        deleteWebhook: vi.fn().mockResolvedValue(true),
      };
      adapter.pollingActive = true;
      adapter.pollingGeneration = 1;
      adapter.pollingAbortController = new AbortController();
      adapter.pollingLoopPromise = adapter.pollingLoop(1, adapter.pollingAbortController.signal);

      await Promise.resolve();
      await expect(adapter.stop()).resolves.toBeUndefined();

      expect(getUpdates).toHaveBeenCalledWith(undefined, 30, expect.any(AbortSignal));
      expect(adapter.pollingAbortController).toBeNull();
      expect(adapter.transport).toBeNull();
      expect(adapter.status).toBe("stopped");
    });
  });

  describe("updateConfig", () => {
    it("restarts when webhook delivery settings change", async () => {
      const adapter = new TelegramAdapter() as any;
      adapter.status = "running";
      adapter.config = {
        ...DEFAULT_TELEGRAM_CONFIG,
        botToken: "token",
        webhookUrl: "",
        webhookSecretToken: "",
      };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn().mockResolvedValue(undefined);

      await adapter.updateConfig({
        options: {
          webhookUrl: "https://example.com/webhook/telegram",
          webhookSecretToken: "secret",
        },
      });

      expect(adapter.stop).toHaveBeenCalledTimes(1);
      expect(adapter.start).toHaveBeenCalledTimes(1);
    });

    it("does not restart when the same bot token is re-saved", async () => {
      const adapter = new TelegramAdapter() as any;
      adapter.status = "running";
      adapter.config = {
        ...DEFAULT_TELEGRAM_CONFIG,
        botToken: "token",
      };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn().mockResolvedValue(undefined);

      await adapter.updateConfig({
        options: {
          botToken: "token",
        },
      });

      expect(adapter.stop).not.toHaveBeenCalled();
      expect(adapter.start).not.toHaveBeenCalled();
    });
  });
});
