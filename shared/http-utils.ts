import type { IncomingMessage, ServerResponse } from "http";
import { isIP } from "net";
import os from "os";
import { WEB_PORT, WEB_STANDALONE_PORT } from "./ports";

// =============================================================================
// Common HTTP utilities shared across Vite plugins, Electron servers, and tests
// =============================================================================

/**
 * Patterns for network interfaces that are likely virtual or internal (VMs, Docker, VPNs, etc.)
 */
export const virtualInterfacePatterns = [
  /^docker/i, /^br-/i, /^veth/i, /^vEthernet/i,
  /^vmnet/i, /^VMware/i, /^VirtualBox/i, /^vboxnet/i,
  /^Hyper-V/i, /^Default Switch/i, /^WSL/i,
  /^tun/i, /^tap/i, /^singbox/i, /^sing-box/i, /^clash/i, /^utun/i,
  /^tailscale/i, /^ZeroTier/i, /^zt/i,
  /^wg/i, /^wireguard/i, /^ham/i, /^Hamachi/i, /^npcap/i, /^lo/i,
];

/**
 * Get the preferred local IP address of the machine.
 * Skips virtual and internal interfaces by default, with a fallback if no physical interface is found.
 * 
 * @param osModule Optional OS module override (used in Electron production server)
 */
export function getLocalIp(osModule?: typeof import("os")): string {
  const currentOs = osModule || os;
  const interfaces = currentOs.networkInterfaces();
  let fallback: string | null = null;

  for (const name of Object.keys(interfaces)) {
    const nets = interfaces[name];
    if (!nets) continue;
    const virtual = virtualInterfacePatterns.some((p) => p.test(name));
    for (const net of nets) {
      if (net.internal || net.family !== "IPv4") continue;
      if (!virtual) return net.address;
      if (!fallback) fallback = net.address;
    }
  }
  return fallback ?? "localhost";
}

// =============================================================================
// CORS
// =============================================================================

const ALLOWED_ORIGINS = new Set([
  `http://localhost:${WEB_PORT}`,
  `http://localhost:${WEB_STANDALONE_PORT}`,
  `http://127.0.0.1:${WEB_PORT}`,
  `http://127.0.0.1:${WEB_STANDALONE_PORT}`,
]);

function getCorsOrigin(req: IncomingMessage): string {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
  return `http://localhost:${WEB_PORT}`;
}

/**
 * Send a JSON response with optional status code and CORS headers.
 */
export function sendJson(res: ServerResponse, data: unknown, status = 200, req?: IncomingMessage): void {
  const body = JSON.stringify(data);
  const origin = req ? getCorsOrigin(req) : "*";
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-opencode-directory",
  });
  res.end(body);
}

/**
 * Parse the JSON body of an incoming HTTP request.
 * Enforces a 1MB size limit to prevent abuse.
 */
export function parseBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB

    req.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Extract a Bearer token from the Authorization header.
 */
export function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

/**
 * Get a client IP for display or logging. Only loopback proxies may supply XFF.
 * Authentication must use isLocalRequest instead of this reported address.
 */
export function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (isLoopbackIp(req.socket?.remoteAddress || "") && typeof forwarded === "string") {
    const clientIp = forwarded.split(",")[0].trim();
    if (clientIp) return clientIp;
  }
  return req.socket?.remoteAddress || "unknown";
}

/**
 * Check if an IP address is localhost.
 */
export function isLocalhost(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function isLoopbackIp(ip: string): boolean {
  return isIP(ip) !== 0 && isLocalhost(ip);
}

function isLocalAuthority(value: string): boolean {
  const match = /^(\[[^\]]+\]|[^:\s/?#@\\]+)(?::(\d+))?$/.exec(value);
  if (!match || (match[2] !== undefined && Number(match[2]) > 65535)) return false;
  const host = match[1].toLowerCase();
  if (host.startsWith("[")) {
    const ip = host.slice(1, -1);
    return isIP(ip) === 6 && isLoopbackIp(ip);
  }
  return isLocalhost(host);
}

function everyHeaderValue(
  value: string | string[] | undefined,
  predicate: (value: string) => boolean,
): boolean {
  if (value === undefined) return true;
  const values = Array.isArray(value) ? value : [value];
  return values.length > 0 && values.every(entry => entry.split(",").every(part => predicate(part.trim())));
}

function isLocalForwardedEntry(entry: string): boolean {
  let hasIdentity = false;
  const names = new Set<string>();
  const valid = entry.split(";").every(parameter => {
    const match = /^\s*([a-z-]+)=(?:"([^"\\]*)"|([^"\s]+))\s*$/i.exec(parameter);
    if (!match) return false;
    const name = match[1].toLowerCase();
    if (names.has(name)) return false;
    names.add(name);
    const value = match[2] ?? match[3];
    if (name === "host") {
      hasIdentity = true;
      return isLocalAuthority(value);
    }
    if (name === "for") {
      hasIdentity = true;
      return isLoopbackIp(value) || (value.startsWith("[") && isLocalAuthority(value));
    }
    return true;
  });
  return valid && hasIdentity;
}

/**
 * Allow host access only through an unambiguous loopback endpoint. Forwarded
 * headers can deny local access, but cannot make a remote socket local.
 * A trusted loopback tunnel that strips remote identity is still a local endpoint.
 */
export function isLocalRequest(req: IncomingMessage): boolean {
  if (!isLoopbackIp(req.socket?.remoteAddress || "")) return false;
  const host = req.headers.host;
  if (typeof host !== "string" || !isLocalAuthority(host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.host.toLowerCase() !== host.toLowerCase()) return false;
    } catch {
      return false;
    }
  }
  const hostCount = req.rawHeaders?.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "host").length;
  if (hostCount !== undefined && hostCount > 1) return false;

  return everyHeaderValue(req.headers["x-forwarded-for"], isLoopbackIp)
    && everyHeaderValue(req.headers["x-real-ip"], isLoopbackIp)
    && everyHeaderValue(req.headers["x-forwarded-host"], isLocalAuthority)
    && everyHeaderValue(req.headers.forwarded, isLocalForwardedEntry);
}

// ---------------------------------------------------------------------------
// Auth guard — shared by channel, settings, and auth route handlers
// ---------------------------------------------------------------------------

interface TokenVerifier {
  verifyToken(token: string): { valid: boolean; deviceId?: string };
}

/**
 * Verify the Bearer token on an incoming request.
 * Returns the authenticated deviceId, or null after sending a 401 response.
 */
export function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  store: TokenVerifier,
): { deviceId: string } | null {
  const token = extractBearerToken(req);
  if (!token) {
    sendJson(res, { error: "Unauthorized" }, 401);
    return null;
  }
  const result = store.verifyToken(token);
  if (!result.valid || !result.deviceId) {
    sendJson(res, { error: "Invalid token" }, 401);
    return null;
  }
  return { deviceId: result.deviceId };
}
