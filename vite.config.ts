import { defineConfig, mergeConfig } from "vite";
import webConfig from "./vite.web.config";

import type { IncomingMessage } from "http";
import { tunnelManager } from "./scripts/tunnel-manager";
import { remoteAccessManager } from "./scripts/remote-access-manager";
import { createRemoteAccessPlugin } from "./scripts/remote-access-plugin";
import { preserveProxyRequestIdentity } from "./scripts/auth-proxy-plugin";
import { deviceStore } from "./scripts/device-store";
import type { DeviceInfo } from "./shared/device-store-types";
import { sendJson, parseBody, getClientIp, isLocalRequest, getLocalIp, requireAuth } from "./shared/http-utils";
import { handleAuthRoutes, handleSettingsRoutes } from "./shared/auth-route-handlers";
import { loadSettings as loadStandaloneSettings, saveSettings as saveStandaloneSettings } from "./scripts/settings-store";
import { GATEWAY_PORT, OPENCODE_PORT, WEBHOOK_PORT, WEB_STANDALONE_PORT } from "./shared/ports";

// ============================================================================
// Helper Functions
// ============================================================================

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url || "", `http://localhost:${WEB_STANDALONE_PORT}`);
}

const localAuthOptions = {
  defaultDeviceName: "Localhost",
  defaultPlatform: "Unknown",
  defaultBrowser: "Unknown",
  includeDeviceInResponse: false,
};

// ============================================================================
// Vite Config
// ============================================================================

export default mergeConfig(webConfig, defineConfig({
  plugins: [
    createRemoteAccessPlugin(remoteAccessManager, () => tunnelManager.stop()),
    {
      name: "standalone-auth-api",
      configureServer(server) {
        // Handle CORS preflight
        server.middlewares.use((req, res, next) => {
          if (req.method === "OPTIONS") {
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
            res.statusCode = 204;
            res.end();
            return;
          }
          next();
        });

        // ====================================================================
        // Auth and Admin routes
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          const url = parseUrl(req);
          const pathname = url.pathname;

          // Special case for /api/auth/verify (handled uniquely in vite.config.ts)
          if (pathname === "/api/auth/verify" && req.method === "POST") {
            try {
              const body = await parseBody(req);
              const { code, device: deviceInfo } = body;

              const validCode = deviceStore.getAccessCode();
              if (code !== validCode) {
                sendJson(res, { success: false, error: "Invalid code" }, 401);
                return;
              }

              // Code is valid, create device and generate token
              const deviceId = deviceStore.generateDeviceId();
              const token = deviceStore.generateToken(deviceId);
              const clientIp = getClientIp(req);

              const device: DeviceInfo = {
                id: deviceId,
                name: deviceInfo?.name || "Unknown Device",
                platform: deviceInfo?.platform || "Unknown",
                browser: deviceInfo?.browser || "Unknown",
                createdAt: Date.now(),
                lastSeenAt: Date.now(),
                ip: clientIp,
              };

              deviceStore.addDevice(device);

              sendJson(res, { success: true, token, deviceId });
            } catch (err) {
              sendJson(res, { success: false, error: "Bad request" }, 400);
            }
            return;
          }

          const handled = await handleAuthRoutes(
            req,
            res,
            pathname,
            url,
            deviceStore,
            localAuthOptions
          );

          if (!handled) {
            next();
          }
        });

        // ====================================================================
        // Settings API
        // GET/PATCH /api/settings/shared
        // ====================================================================
        server.middlewares.use(async (req, res, next) => {
          const reqUrl = new URL(req.url || "", `http://localhost:${WEB_STANDALONE_PORT}`);
          const pathname = reqUrl.pathname;
          if (!pathname.startsWith("/api/settings/")) {
            next();
            return;
          }
          const handled = await handleSettingsRoutes(req, res, pathname, deviceStore, {
            loadSettings: loadStandaloneSettings,
            saveSettings: saveStandaloneSettings,
            getRemoteAccessStatus: () => remoteAccessManager.getStatus(),
          });
          if (!handled) {
            next();
          }
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
            port: WEB_STANDALONE_PORT,
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

        // ====================================================================
        // OpenCode's internal server is reachable only after authentication.
        // ====================================================================
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/opencode-api")) {
            next();
            return;
          }
          if (!requireAuth(req, res, deviceStore)) return;
          next();
        });
      },
    },
  ],
  server: {
    port: WEB_STANDALONE_PORT,
    // Keep the advertised access URL and the tunnel target on the same port.
    strictPort: true,
    host: true,
    allowedHosts: true,
    proxy: {
      "/ws": {
        target: `http://localhost:${GATEWAY_PORT}`,
        ws: true,
        bypass: req => remoteAccessManager.isRequestAllowed(req, true) ? undefined : false,
        configure: proxy => {
          proxy.on("proxyReq", preserveProxyRequestIdentity);
          proxy.on("proxyReqWs", preserveProxyRequestIdentity);
        },
      },
      "/opencode-api/global/event": {
        target: `http://localhost:${OPENCODE_PORT}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/opencode-api/, ""),
        timeout: 0,
      },
      "/opencode-api": {
        target: `http://localhost:${OPENCODE_PORT}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/opencode-api/, ""),
      },
      // Proxy webhook endpoints to the WebhookServer
      "/api/messages": {
        target: `http://localhost:${WEBHOOK_PORT}`,
        changeOrigin: true,
      },
      "/webhook": {
        target: `http://localhost:${WEBHOOK_PORT}`,
        changeOrigin: true,
      },
    },
  },
}));
