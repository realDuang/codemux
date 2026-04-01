import type { IncomingMessage, ServerResponse } from "http";
import { parseBody, sendJson, requireAuth } from "./http-utils";

interface SettingsRouteStore {
  getDefaultEngine(): string;
  saveDefaultEngine(engineType: string): void;
}

export async function handleSettingsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  authStore: Parameters<typeof requireAuth>[2],
  settingsStore: SettingsRouteStore,
): Promise<boolean> {
  if (pathname === "/api/settings/default-engine" && req.method === "GET") {
    if (!requireAuth(req, res, authStore)) return true;
    sendJson(res, { defaultEngine: settingsStore.getDefaultEngine() });
    return true;
  }

  if (pathname === "/api/settings/default-engine" && req.method === "PUT") {
    if (!requireAuth(req, res, authStore)) return true;
    try {
      const body = await parseBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        sendJson(res, { error: "Invalid request body" }, 400);
        return true;
      }
      const defaultEngine = (body as { defaultEngine?: unknown }).defaultEngine;
      if (typeof defaultEngine !== "string" || defaultEngine.trim().length === 0) {
        sendJson(res, { error: "defaultEngine is required" }, 400);
        return true;
      }

      settingsStore.saveDefaultEngine(defaultEngine.trim());
      sendJson(res, { success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bad request";
      sendJson(res, { error: message }, message === "Invalid JSON" ? 400 : 500);
    }
    return true;
  }

  return false;
}
