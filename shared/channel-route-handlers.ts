import type { IncomingMessage, ServerResponse } from "http";
import { parseBody, sendJson, requireAuth } from "./http-utils";

interface ChannelManagerRoutes {
  listChannels(): unknown[];
  getConfig(type: string): unknown | undefined;
  updateConfig(type: string, updates: Record<string, unknown>): Promise<void>;
  startChannel(type: string): Promise<void>;
  stopChannel(type: string): Promise<void>;
  getStatus(type: string): unknown | undefined;
}

/** Keys whose values are treated as secrets and redacted in GET responses. */
const SECRET_KEY_PATTERN = /secret|password|token|aeskey/i;

/**
 * Redact secret fields: replace non-empty string values with "" and collect
 * their names into a `secretsConfigured` array so the frontend knows which
 * secrets are already set.
 */
function redactSecrets(obj: unknown): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const result: Record<string, unknown> = {};
  const configured: string[] = [];

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key) && typeof value === "string") {
      result[key] = "";
      if (value.length > 0) configured.push(key);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactSecrets(value);
    } else {
      result[key] = value;
    }
  }

  if (configured.length > 0) {
    result.secretsConfigured = configured;
  }
  return result;
}

/**
 * Strip empty-string secret fields from an update payload so they don't
 * overwrite existing values. Non-secret empty strings are kept as-is.
 */
function stripEmptySecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_KEY_PATTERN.test(key) && value === "") {
      continue; // empty secret = "keep existing"
    }
    if (key === "secretsConfigured") {
      continue; // strip metadata field that the frontend may echo back
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = stripEmptySecrets(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function getChannelType(pathname: string, suffix = ""): string | null {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^/api/channels/([a-z0-9-]+)${escapedSuffix}$`);
  return pathname.match(regex)?.[1] ?? null;
}

function sendChannelError(res: ServerResponse, error: unknown): true {
  const message = error instanceof Error ? error.message : "Channel operation failed";
  const status = /not found/i.test(message) ? 404 : 500;
  sendJson(res, { error: message }, status);
  return true;
}

export async function handleChannelRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  authStore: Parameters<typeof requireAuth>[2],
  channelManager: ChannelManagerRoutes,
): Promise<boolean> {
  if (pathname === "/api/channels" && req.method === "GET") {
    if (!requireAuth(req, res, authStore)) return true;
    sendJson(res, channelManager.listChannels());
    return true;
  }

  const configType = getChannelType(pathname);
  if (configType && req.method === "GET") {
    if (!requireAuth(req, res, authStore)) return true;
    const config = channelManager.getConfig(configType);
    sendJson(res, config ? redactSecrets(config) : null);
    return true;
  }

  if (configType && req.method === "PUT") {
    if (!requireAuth(req, res, authStore)) return true;
    try {
      const updates = await parseBody(req);
      if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
        sendJson(res, { error: "Invalid request body" }, 400);
        return true;
      }
      const cleaned = stripEmptySecrets(updates as Record<string, unknown>);
      await channelManager.updateConfig(configType, cleaned);
      sendJson(res, { success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bad request";
      const status = message === "Invalid JSON" ? 400 : /not found/i.test(message) ? 404 : 500;
      sendJson(res, { error: message }, status);
    }
    return true;
  }

  const startType = getChannelType(pathname, "/start");
  if (startType && req.method === "POST") {
    if (!requireAuth(req, res, authStore)) return true;
    try {
      await channelManager.startChannel(startType);
      sendJson(res, { success: true });
    } catch (error) {
      return sendChannelError(res, error);
    }
    return true;
  }

  const stopType = getChannelType(pathname, "/stop");
  if (stopType && req.method === "POST") {
    if (!requireAuth(req, res, authStore)) return true;
    try {
      await channelManager.stopChannel(stopType);
      sendJson(res, { success: true });
    } catch (error) {
      return sendChannelError(res, error);
    }
    return true;
  }

  const statusType = getChannelType(pathname, "/status");
  if (statusType && req.method === "GET") {
    if (!requireAuth(req, res, authStore)) return true;
    sendJson(res, channelManager.getStatus(statusType) ?? null);
    return true;
  }

  return false;
}
