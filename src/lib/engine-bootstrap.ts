import { gateway, type GatewayNotificationHandlers } from "./gateway-api";
import { logger } from "./logger";
import {
  isEngineEnabled,
  restoreDefaultEngine,
  restoreEnabledEngines,
  restoreEngineModelSelections,
  restoreReasoningEfforts,
  restoreServiceTiers,
  setConfigStore,
} from "../stores/config";
import type { EngineInfo } from "../types/unified";

export async function ensureGatewayInitialized(
  handlers?: GatewayNotificationHandlers,
): Promise<void> {
  if (gateway.isInitialized) {
    if (handlers) {
      gateway.setHandlers(handlers);
    }
    return;
  }

  await gateway.init(handlers);
}

export async function refreshEngineConfigState(): Promise<EngineInfo[]> {
  const engines = await gateway.listEngines();

  setConfigStore("engines", engines);
  restoreEnabledEngines();
  restoreDefaultEngine();

  const runningEngine = engines.find(
    (engine) => engine.status === "running" && isEngineEnabled(engine.type),
  );
  if (runningEngine) {
    setConfigStore("currentEngineType", runningEngine.type);
  }

  const runningEnginesForModels = engines.filter(
    (engine) => engine.status === "running" && isEngineEnabled(engine.type),
  );

  await Promise.all(
    runningEnginesForModels.map(async (engine) => {
      try {
        const modelResult = await gateway.listModels(engine.type);
        if (modelResult.models.length > 0) {
          setConfigStore("engineModels", engine.type, modelResult.models);
        }
      } catch (error) {
        logger.debug(
          "[EngineBootstrap] Failed to load models for engine:",
          engine.type,
          error,
        );
      }
    }),
  );

  restoreEngineModelSelections();
  restoreReasoningEfforts();
  restoreServiceTiers();
  return engines;
}
