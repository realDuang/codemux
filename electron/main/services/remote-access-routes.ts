import type { IncomingMessage, ServerResponse } from "node:http";
import { isLocalRequest, parseBody, sendJson } from "../../../shared/http-utils";
import { remoteAccessManager } from "./remote-access-manager";

export async function handleRemoteAccessRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname === "/api/remote-access/status" && req.method === "GET") {
    sendJson(res, { mode: remoteAccessManager.getStatus().mode });
    return true;
  }
  if (!pathname.startsWith("/api/remote-access") && !pathname.startsWith("/api/tunnel")) return false;
  if (!isLocalRequest(req)) {
    sendJson(res, { error: "Local access only" }, 403);
    return true;
  }
  try {
    if (pathname === "/api/remote-access" && req.method === "GET") {
      sendJson(res, remoteAccessManager.getStatus());
    } else if (pathname === "/api/remote-access" && req.method === "PATCH") {
      sendJson(res, await remoteAccessManager.update(await parseBody(req)));
    } else if (pathname === "/api/tunnel/status" && req.method === "GET") {
      sendJson(res, remoteAccessManager.getStatus().tunnel);
    } else if (pathname === "/api/tunnel/start" && req.method === "POST") {
      const body = await parseBody(req);
      const status = await remoteAccessManager.update({
        mode: "cloudflare",
        ...(body.tunnelConfig === undefined ? {} : { tunnelConfig: body.tunnelConfig }),
      });
      sendJson(res, status.tunnel);
    } else if (pathname === "/api/tunnel/stop" && req.method === "POST") {
      if (remoteAccessManager.getStatus().mode === "cloudflare") await remoteAccessManager.update({ mode: "off" });
      sendJson(res, { success: true });
    } else {
      sendJson(res, { error: "Not found" }, 404);
    }
  } catch (error) {
    sendJson(res, { error: error instanceof Error ? error.message : "Remote access update failed" }, 400);
  }
  return true;
}
