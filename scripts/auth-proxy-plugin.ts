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

// Electron's internal Auth API server port (must match auth-api-server.ts)
const AUTH_API_PORT = 4097;

function sendJson(res: ServerResponse, data: any, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

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

function isLocalhost(ip: string): boolean {
  const normalizedIp = ip.replace(/^::ffff:/, "");
  return (
    normalizedIp === "127.0.0.1" ||
    normalizedIp === "::1" ||
    normalizedIp === "localhost"
  );
}

/**
 * Proxy a request to Electron's Auth API server
 */
function proxyToAuthApi(
  req: IncomingMessage,
  res: ServerResponse,
  targetPath?: string
): void {
  const path = targetPath || req.url || "/";

  // Collect request body if present
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: AUTH_API_PORT,
      path: path,
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${AUTH_API_PORT}`,
        // Forward client IP for logging
        "x-forwarded-for": getClientIp(req),
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

export interface TunnelInfo {
  url: string;
  status: "starting" | "running" | "stopped" | "error";
  startTime?: number;
  error?: string;
}

interface TunnelManagerInterface {
  start(port: number): Promise<TunnelInfo>;
  stop(): Promise<void>;
  getInfo(): TunnelInfo;
}

export interface AuthProxyPluginOptions {
  tunnelManager?: TunnelManagerInterface;
  defaultPort?: number;
}

export function createAuthProxyPlugin(options: AuthProxyPluginOptions = {}): Plugin {
  const { tunnelManager, defaultPort = 5173 } = options;

  return {
    name: "auth-api-proxy",
    configureServer(server: ViteDevServer) {
      // ====================================================================
      // Proxy all /api/auth/* and /api/admin/* and /api/devices/* requests
      // to Electron's internal Auth API server
      // ====================================================================
      server.middlewares.use((req, res, next) => {
        const url = req.url || "";

        // List of API paths that should be proxied to Electron's Auth API
        const authApiPaths = [
          "/api/auth/",
          "/api/admin/",
          "/api/devices",
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

        const clientIp = getClientIp(req);
        const isLocal = isLocalhost(clientIp);
        sendJson(res, { isLocal });
      });

      // ====================================================================
      // Tunnel Management APIs
      // ====================================================================
      if (tunnelManager) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/api/tunnel")) {
            next();
            return;
          }

          try {
            if (req.url === "/api/tunnel/start" && req.method === "POST") {
              const info = await tunnelManager.start(defaultPort);
              sendJson(res, info);
              return;
            }

            if (req.url === "/api/tunnel/stop" && req.method === "POST") {
              await tunnelManager.stop();
              sendJson(res, { success: true });
              return;
            }

            if (req.url === "/api/tunnel/status" && req.method === "GET") {
              const info = tunnelManager.getInfo();
              sendJson(res, info);
              return;
            }

            sendJson(res, { error: "Not found" }, 404);
          } catch (error: any) {
            console.error("[API Error]", error);
            sendJson(res, { error: error.message }, 500);
          }
        });
      }
    },
  };
}
