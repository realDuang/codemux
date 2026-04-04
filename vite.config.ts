import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";

import os from "os";
import type { IncomingMessage } from "http";
import { tunnelManager } from "./scripts/tunnel-manager";
import { deviceStore } from "./scripts/device-store";
import type { DeviceInfo } from "./shared/device-store-types";
import { sendJson, parseBody, extractBearerToken, getClientIp, isLocalhost, getLocalIp } from "./shared/http-utils";
import { handleAuthRoutes, handleSettingsRoutes } from "./shared/auth-route-handlers";
import { loadSettings as loadStandaloneSettings, saveSettings as saveStandaloneSettings } from "./scripts/settings-store";

// ============================================================================
// Helper Functions
// ============================================================================

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url || "", `http://localhost:8234`);
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

export default defineConfig({
  plugins: [
    tailwindcss(),
    solid(),
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
          const reqUrl = new URL(req.url || "", `http://localhost:8234`);
          const pathname = reqUrl.pathname;
          if (!pathname.startsWith("/api/settings/")) {
            next();
            return;
          }
          const handled = await handleSettingsRoutes(req, res, pathname, deviceStore, {
            loadSettings: loadStandaloneSettings,
            saveSettings: saveStandaloneSettings,
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
            port: 8234,
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
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/api/tunnel")) {
            next();
            return;
          }

          try {
            if (req.url === "/api/tunnel/start" && req.method === "POST") {
              const info = await tunnelManager.start(8234);
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
      },
    },
  ],
  server: {
    port: 8234,
    host: true,
    allowedHosts: true,
    proxy: {
      "/ws": {
        target: "http://localhost:4200",
        ws: true,
      },
      "/opencode-api/global/event": {
        target: "http://localhost:4096",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/opencode-api/, ""),
        timeout: 0,
      },
      "/opencode-api": {
        target: "http://localhost:4096",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/opencode-api/, ""),
      },
      // Proxy webhook endpoints to the WebhookServer
      "/api/messages": {
        target: "http://localhost:4098",
        changeOrigin: true,
      },
      "/webhook": {
        target: "http://localhost:4098",
        changeOrigin: true,
      },
    },
  },
});
