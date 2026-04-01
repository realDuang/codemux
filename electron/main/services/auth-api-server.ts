import http from "http";
import { deviceStore } from "./device-store";
import { authLog, getLogFilePath, getFileLogLevel, setFileLogLevel } from "./logger";
import { sendJson } from "../../../shared/http-utils";
import { handleAuthRoutes, handleLogRoutes, handleSettingsRoutes } from "../../../shared/auth-route-handlers";
import { AUTH_API_PORT } from "../../../shared/ports";
import { loadSettings, saveSettings, replaceSettings } from "./logger";

// ============================================================================
// Internal Auth API Server
// This server handles all device/auth related API requests.
// In development, Vite proxies requests here. In production, Electron handles
// everything via IPC, so this server is only used in development.
// ============================================================================

class AuthApiServer {
  private server: http.Server | null = null;

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        // Handle CORS preflight
        if (req.method === "OPTIONS") {
          sendJson(res, {});
          return;
        }

        const url = new URL(req.url || "", `http://localhost:${AUTH_API_PORT}`);
        const pathname = url.pathname;

        try {
          await this.handleRequest(req, res, pathname, url);
        } catch (err) {
          authLog.error("Error:", err);
          sendJson(res, { error: "Internal server error" }, 500);
        }
      });

      this.server.listen(AUTH_API_PORT, "127.0.0.1", () => {
        resolve();
      });

      this.server.on("error", (err) => {
        authLog.error("Server error:", err);
        reject(err);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  getPort(): number {
    return AUTH_API_PORT;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    url: URL
  ) {
    // Auth + device + admin routes
    const handled = await handleAuthRoutes(req, res, pathname, url, deviceStore, {
      defaultDeviceName: "Local Browser",
      defaultPlatform: "web",
      defaultBrowser: "Unknown",
      includeDeviceInResponse: false,
    });
    if (handled) return;

    // Log API routes (localhost only)
    const logHandled = await handleLogRoutes(req, res, pathname, {
      getLogFilePath,
      getFileLogLevel,
      setFileLogLevel,
    });
    if (logHandled) return;

    const settingsHandled = await handleSettingsRoutes(req, res, pathname, deviceStore, {
      loadSettings,
      saveSettings,
      replaceSettings,
    });
    if (settingsHandled) return;

    // Not found
    sendJson(res, { error: "Not found" }, 404);
  }
}

export const authApiServer = new AuthApiServer();
