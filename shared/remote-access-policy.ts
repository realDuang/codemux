import type { IncomingMessage } from "node:http";
import { isLocalRequest } from "./http-utils";
import type { RemoteAccessStatus } from "./remote-access";

/** WS connections from the desktop can have a file origin or a different loopback port. */
export function isLocalGatewayRequest(req: IncomingMessage): boolean {
  const withoutOrigin = { ...req, socket: req.socket, headers: { ...req.headers, origin: undefined } } as IncomingMessage;
  if (!isLocalRequest(withoutOrigin)) return false;
  const origin = req.headers.origin;
  if (origin === undefined || origin === "null" || origin === "file://") return true;
  try {
    const parsed = new URL(origin);
    return isLocalRequest({ ...withoutOrigin, headers: { ...withoutOrigin.headers, host: parsed.host, origin } } as IncomingMessage);
  } catch {
    return false;
  }
}

/** Remote traffic must use the selected entry; device authentication is a separate check. */
export function isRemoteAccessRequestAllowed(
  req: IncomingMessage,
  status: Pick<RemoteAccessStatus, "mode" | "url">,
  gateway = false,
): boolean {
  if (gateway ? isLocalGatewayRequest(req) : isLocalRequest(req)) return true;
  if (status.mode === "off" || !status.url) return false;
  try {
    const entry = new URL(status.url);
    const host = req.headers.host;
    if (typeof host !== "string" || /[\s,/@?#\\]/.test(host)) return false;
    const authority = new URL(`${entry.protocol}//${host}`);
    if (authority.host !== entry.host) return false;
    const hostCount = req.rawHeaders?.filter((v, i) => i % 2 === 0 && v.toLowerCase() === "host").length;
    if (hostCount !== undefined && hostCount !== 1) return false;
    if (req.headers.origin !== undefined && req.headers.origin !== entry.origin) return false;
    return true;
  } catch {
    return false;
  }
}
