/**
 * Auth API Proxy Plugin for Electron-Vite
 *
 * This plugin proxies all auth/device related API requests to Electron's
 * internal Auth API server, ensuring a single source of truth for device data.
 */

import http from "http";
import os from "os";
import type { IncomingMessage, ServerResponse } from "http";
import type { Plugin, ViteDevServer } from "vite";
import { sendJson, isLocalRequest } from "../shared/http-utils";
import { AUTH_API_PORT, WEB_PORT } from "../shared/ports";
import { isLocalGatewayRequest, isRemoteAccessRequestAllowed } from "../shared/remote-access-policy";
import type { RemoteAccessStatus } from "../shared/remote-access";

// Electron's internal Auth API server port (imported from shared/ports)

const virtualInterfacePatterns = [
  /^docker/i, /^br-/i, /^veth/i, /^vEthernet/i,
  /^vmnet/i, /^VMware/i, /^VirtualBox/i, /^vboxnet/i,
  /^Hyper-V/i, /^Default Switch/i, /^WSL/i,
  /^tun/i, /^tap/i, /^singbox/i, /^sing-box/i, /^clash/i, /^utun/i,
  /^tailscale/i, /^ZeroTier/i, /^zt/i,
  /^wg/i, /^wireguard/i, /^ham/i, /^Hamachi/i, /^npcap/i, /^lo/i,
];

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
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

/**
 * Proxy a request to Electron's Auth API server
 */
export function proxyToAuthApi(
  req: IncomingMessage,
  res: ServerResponse,
  targetPath?: string
): void {
  const path = targetPath || req.url || "/";

  // Collect request body if present
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const forwarded = req.headers["x-forwarded-for"];
    const forwardedChain = Array.isArray(forwarded) ? forwarded.join(", ") : forwarded;
    const peer = req.socket.remoteAddress || "unknown";
    const hostCount = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "host").length;
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: AUTH_API_PORT,
      path: path,
      method: req.method,
      headers: {
        ...req.headers,
        // Preserve the external authority and every hop used by local-auth checks.
        host: hostCount > 1 ? "" : req.headers.host ?? "",
        "x-forwarded-for": forwardedChain === undefined ? peer : `${forwardedChain}, ${peer}`,
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.statusCode = proxyRes.statusCode || 500;

      // Copy response headers
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value) res.setHeader(key, value);
      }

      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      console.error("[Auth Proxy] Failed to connect to Auth API:", err.message);
      sendJson(res, {
        error: "Auth service unavailable. Make sure Electron main process is running.",
        details: err.message
      }, 503);
    });

    if (body) {
      proxyReq.write(body);
    }
    proxyReq.end();
  });

  req.on("error", (err) => {
    console.error("[Auth Proxy] Request error:", err);
    sendJson(res, { error: "Request failed" }, 500);
  });
}

export interface AuthProxyPluginOptions {
  defaultPort?: number;
}

/** Fetch admission policy from the main process without caching mode changes. */
export function getElectronRemoteAccessStatus(): Promise<RemoteAccessStatus> {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: "127.0.0.1",
      port: AUTH_API_PORT,
      path: "/api/remote-access",
      timeout: 2000,
    }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error("Remote access policy unavailable.");
          resolve(JSON.parse(body) as RemoteAccessStatus);
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Remote access policy timed out.")));
    request.on("error", reject);
  });
}

export async function isElectronRemoteRequestAllowed(req: IncomingMessage, gateway = false): Promise<boolean> {
  if (gateway ? isLocalGatewayRequest(req) : isLocalRequest(req)) return true;
  try {
    return isRemoteAccessRequestAllowed(req, await getElectronRemoteAccessStatus(), gateway);
  } catch {
    return false;
  }
}

/** Preserve peer and authority when the gateway is behind Vite's loopback proxy. */
export function preserveProxyRequestIdentity(proxyReq: http.ClientRequest, req: IncomingMessage): void {
  const hostCount = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "host").length;
  proxyReq.setHeader("host", hostCount > 1 ? "" : req.headers.host ?? "");
  const forwarded = req.headers["x-forwarded-for"];
  const chain = Array.isArray(forwarded) ? forwarded.join(", ") : forwarded;
  const peer = req.socket.remoteAddress || "unknown";
  proxyReq.setHeader("x-forwarded-for", chain === undefined ? peer : `${chain}, ${peer}`);
}

export function createAuthProxyPlugin(options: AuthProxyPluginOptions = {}): Plugin {
  const { defaultPort = WEB_PORT } = options;

  return {
    name: "auth-api-proxy",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (pathname === "/api/remote-access/status" && req.method === "GET") {
          proxyToAuthApi(req, res);
          return;
        }
        if (!await isElectronRemoteRequestAllowed(req)) {
          sendJson(res, { error: "Remote access is disabled for this entry point." }, 403);
          return;
        }
        next();
      });
      // ====================================================================
      // Proxy auth, admin, device, and channel API requests to Electron's
      // internal Auth API server
      // ====================================================================
      server.middlewares.use((req, res, next) => {
        const url = req.url || "";

        // List of API paths that should be proxied to Electron's Auth API
        const authApiPaths = [
          "/opencode-api",
          "/api/auth/",
          "/api/admin/",
          "/api/devices",
          "/api/settings/",
          "/api/remote-access",
          "/api/tunnel",
          "/api/channels",
          "/api/system/log",
        ];

        const shouldProxy = authApiPaths.some(p => url.startsWith(p));

        if (shouldProxy) {
          proxyToAuthApi(req, res);
          return;
        }

        next();
      });

      // ====================================================================
      // System: Get system info
      // GET /api/system/info
      // ====================================================================
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/api/system/info" || req.method !== "GET") {
          next();
          return;
        }

        sendJson(res, {
          localIp: getLocalIp(),
          port: defaultPort,
        });
      });

      // ====================================================================

      // System: Check if request is from localhost
      // GET /api/system/is-local
      // ====================================================================
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/api/system/is-local" || req.method !== "GET") {
          next();
          return;
        }

        const isLocal = isLocalRequest(req);
        sendJson(res, { isLocal });
      });

    },
  };
}
