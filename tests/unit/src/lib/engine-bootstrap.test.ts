import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../src/lib/gateway-api", () => ({
  gateway: {
    isInitialized: false,
    init: vi.fn().mockResolvedValue(undefined),
    setHandlers: vi.fn(),
    listEngines: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue({ models: [] }),
  },
}));

vi.mock("../../../../src/stores/config", () => ({
  setConfigStore: vi.fn(),
  isEngineEnabled: vi.fn().mockReturnValue(false),
  restoreEnabledEngines: vi.fn(),
  restoreDefaultEngine: vi.fn(),
  restoreEngineModelSelections: vi.fn(),
  restoreReasoningEfforts: vi.fn(),
  restoreServiceTiers: vi.fn(),
}));

vi.mock("../../../../src/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
  },
}));

import {
  ensureGatewayInitialized,
  refreshEngineConfigState,
} from "../../../../src/lib/engine-bootstrap";
import { gateway } from "../../../../src/lib/gateway-api";
import {
  setConfigStore,
  isEngineEnabled,
  restoreEnabledEngines,
  restoreDefaultEngine,
  restoreEngineModelSelections,
  restoreReasoningEfforts,
  restoreServiceTiers,
} from "../../../../src/stores/config";
import { logger } from "../../../../src/lib/logger";

describe("engine-bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (gateway as any).isInitialized = false;
  });

  describe("ensureGatewayInitialized", () => {
    it("skips init when already initialized", async () => {
      (gateway as any).isInitialized = true;

      await ensureGatewayInitialized();

      expect(gateway.init).not.toHaveBeenCalled();
      expect(gateway.setHandlers).not.toHaveBeenCalled();
    });

    it("calls gateway.init when not initialized", async () => {
      (gateway as any).isInitialized = false;

      await ensureGatewayInitialized();

      expect(gateway.init).toHaveBeenCalledWith(undefined);
    });

    it("sets handlers when already initialized and handlers provided", async () => {
      (gateway as any).isInitialized = true;
      const handlers = { onNotification: vi.fn() };

      await ensureGatewayInitialized(handlers as any);

      expect(gateway.init).not.toHaveBeenCalled();
      expect(gateway.setHandlers).toHaveBeenCalledWith(handlers);
    });
  });

  describe("refreshEngineConfigState", () => {
    it("fetches engines, loads models for running+enabled engines, calls restore functions", async () => {
      const engines = [
        { type: "claude", status: "running" },
        { type: "codex", status: "running" },
        { type: "offline", status: "stopped" },
      ];
      vi.mocked(gateway.listEngines).mockResolvedValue(engines as any);
      vi.mocked(isEngineEnabled).mockReturnValue(true);
      vi.mocked(gateway.listModels).mockResolvedValue({
        models: [{ id: "model-1" }],
      } as any);

      const result = await refreshEngineConfigState();

      expect(gateway.listEngines).toHaveBeenCalled();
      expect(setConfigStore).toHaveBeenCalledWith("engines", engines);
      expect(restoreEnabledEngines).toHaveBeenCalled();
      expect(restoreDefaultEngine).toHaveBeenCalled();

      // Should set currentEngineType to the first running+enabled engine
      expect(setConfigStore).toHaveBeenCalledWith(
        "currentEngineType",
        "claude",
      );

      // Should load models for both running+enabled engines (claude, codex) but not stopped
      expect(gateway.listModels).toHaveBeenCalledTimes(2);
      expect(gateway.listModels).toHaveBeenCalledWith("claude");
      expect(gateway.listModels).toHaveBeenCalledWith("codex");

      // Should store fetched models
      expect(setConfigStore).toHaveBeenCalledWith("engineModels", "claude", [
        { id: "model-1" },
      ]);
      expect(setConfigStore).toHaveBeenCalledWith("engineModels", "codex", [
        { id: "model-1" },
      ]);

      expect(restoreEngineModelSelections).toHaveBeenCalled();
      expect(restoreReasoningEfforts).toHaveBeenCalled();
      expect(restoreServiceTiers).toHaveBeenCalled();

      expect(result).toBe(engines);
    });

    it("handles model loading failures gracefully", async () => {
      const engines = [{ type: "claude", status: "running" }];
      vi.mocked(gateway.listEngines).mockResolvedValue(engines as any);
      vi.mocked(isEngineEnabled).mockReturnValue(true);
      vi.mocked(gateway.listModels).mockRejectedValue(
        new Error("network error"),
      );

      const result = await refreshEngineConfigState();

      expect(logger.debug).toHaveBeenCalledWith(
        "[EngineBootstrap] Failed to load models for engine:",
        "claude",
        expect.any(Error),
      );

      // Should still call restore functions despite model loading failure
      expect(restoreEngineModelSelections).toHaveBeenCalled();
      expect(restoreReasoningEfforts).toHaveBeenCalled();
      expect(restoreServiceTiers).toHaveBeenCalled();

      expect(result).toBe(engines);
    });
  });
});
