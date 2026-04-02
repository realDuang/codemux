import type { EngineType } from "../types/unified";
import { getEffectiveReasoningEffortForEngine } from "../stores/config";
import { gateway } from "./gateway-api";
import { logger } from "./logger";
import { notify } from "./notifications";

export async function syncReasoningEffortForSend(
  sessionId: string,
  engineType: EngineType,
  warningMessage: string,
): Promise<void> {
  const effort = getEffectiveReasoningEffortForEngine(engineType);
  try {
    await gateway.setReasoningEffort(sessionId, effort);
  } catch (error) {
    logger.warn("[SendMessage] Failed to sync reasoning effort before send:", error);
    notify(warningMessage, "warning", 5000);
  }
}
