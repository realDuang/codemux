import { app, BrowserWindow } from "electron";
import { createWindow, getMainWindow } from "./window-manager";
import { registerIpcHandlers } from "./ipc-handlers";
import { deviceStore } from "./services/device-store";
import { authApiServer } from "./services/auth-api-server";
import { productionServer } from "./services/production-server";
import { EngineManager } from "./gateway/engine-manager";
import { GatewayServer } from "./gateway/ws-server";
import { OpenCodeAdapter } from "./engines/opencode-adapter";
import { CopilotAdapter } from "./engines/copilot-adapter";
// Claude Code adapter disabled — waiting for ACP protocol support
// import { ClaudeAdapter } from "./engines/claude-adapter";

// --- Gateway singleton instances ---
const engineManager = new EngineManager();
const gatewayServer = new GatewayServer(engineManager);

// Register engine adapters
const openCodeAdapter = new OpenCodeAdapter({ port: 4096 });
const copilotAdapter = new CopilotAdapter();
engineManager.registerAdapter(openCodeAdapter);
engineManager.registerAdapter(copilotAdapter);

// Export for IPC handlers
export { engineManager, gatewayServer };

// Gateway WS port
const GATEWAY_PORT = 4200;

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

// Track if we're already quitting to prevent double cleanup
let isQuitting = false;

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // Initialize DeviceStore (needs to be after app ready)
    deviceStore.init();

    // Register IPC handlers
    registerIpcHandlers();

    // In dev mode, start internal Auth API server
    // Vite middleware will proxy requests to this server
    if (!app.isPackaged) {
      try {
        await authApiServer.start();
      } catch (err) {
        console.error("[Main] Failed to start Auth API server:", err);
      }
    } else {
      // In production mode, start the production HTTP server
      // This is required for Cloudflare Tunnel to work
      try {
        const port = await productionServer.start(5173);
        console.log(`[Main] Production server started on port ${port}`);
      } catch (err) {
        console.error("[Main] Failed to start Production server:", err);
      }
    }

    // Start Gateway WebSocket server
    try {
      if (app.isPackaged && productionServer.isRunning()) {
        // In production: attach to production server for single-port access through Cloudflare Tunnel
        const httpServer = productionServer.getServer();
        if (httpServer) {
          gatewayServer.start({ server: httpServer, path: "/ws" });
          console.log("[Main] Gateway server attached to production server at /ws");
        } else {
          gatewayServer.start({ port: GATEWAY_PORT });
          console.log(`[Main] Gateway server started on port ${GATEWAY_PORT}`);
        }
      } else {
        // In dev: standalone port
        gatewayServer.start({ port: GATEWAY_PORT });
        console.log(`[Main] Gateway server started on port ${GATEWAY_PORT}`);
      }
    } catch (err) {
      console.error("[Main] Failed to start Gateway server:", err);
    }

    // Start all engine adapters (non-blocking, don't delay window creation)
    const engines = [
      ["OpenCode", openCodeAdapter],
      ["Copilot", copilotAdapter],
    ] as const;
    for (const [name, adapter] of engines) {
      (adapter as any).start().then(
        () => console.log(`[Main] ${name} engine started`),
        (err: any) => console.error(`[Main] Failed to start ${name} engine:`, err?.message ?? err),
      );
    }

    // Create main window
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  // On non-macOS platforms, quit when all windows are closed
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  // Cleanup before app quits
  app.on("will-quit", async (event) => {
    if (isQuitting) return;
    isQuitting = true;

    event.preventDefault();

    try {
      await Promise.all([
        authApiServer.stop(),
        engineManager.stopAll(),
        productionServer.stop(),
        (() => { gatewayServer.stop(); })(),
      ]);
    } catch (err) {
      console.error("[Main] Cleanup error:", err);
    }

    app.exit(0);
  });
}
