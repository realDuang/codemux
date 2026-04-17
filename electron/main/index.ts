import { app, BrowserWindow } from "electron";
import { shellEnvSync } from "shell-env";
import { mainLog } from "./services/logger";
import { unwatchAll } from "./services/file-service";
// dev restart trigger

// Load the user's full login-shell environment for packaged macOS/Linux apps.
// GUI-launched apps inherit a minimal environment from launchd, missing vars
// defined in ~/.zshrc / ~/.bashrc (e.g. PATH, ANTHROPIC_API_KEY).
// shell-env spawns a login shell to capture the complete env.
// On Windows this is a no-op (returns process.env as-is).
try {
  Object.assign(process.env, shellEnvSync());
} catch {
  // Non-fatal: if shell-env fails (e.g. non-standard shell), continue with
  // the existing environment. PATH and other vars may be incomplete.
}

// Catch uncaught exceptions from child process stdio (EPIPE, etc.)
// Without this, Electron shows an error dialog and the app becomes unstable.
process.on("uncaughtException", (err) => {
  // EPIPE occurs when writing to a child process whose stdin is already closed
  // (e.g. engine CLI exits before SDK finishes writing). Safe to suppress.
  if ((err as NodeJS.ErrnoException).code === "EPIPE") {
    mainLog.warn("Suppressed EPIPE error:", err.message);
    return;
  }
  mainLog.error("Uncaught exception:", err);
  // Non-EPIPE uncaught exceptions leave the process in undefined state — exit gracefully
  app.exit(1);
});
import { createWindow, getMainWindow } from "./window-manager";
import { registerIpcHandlers } from "./ipc-handlers";
import { deviceStore } from "./services/device-store";
import { conversationStore } from "./services/conversation-store";
import { authApiServer } from "./services/auth-api-server";
import { productionServer } from "./services/production-server";
import { EngineManager } from "./gateway/engine-manager";
import { GatewayServer } from "./gateway/ws-server";
import { OpenCodeAdapter } from "./engines/opencode";
import { CopilotSdkAdapter } from "./engines/copilot";
import { ClaudeCodeAdapter } from "./engines/claude";
import { ChannelManager } from "./channels/channel-manager";
import { WebhookServer } from "./channels/webhook-server";
import { FeishuAdapter } from "./channels/feishu/feishu-adapter";
import { DingTalkAdapter } from "./channels/dingtalk/dingtalk-adapter";
import { TelegramAdapter } from "./channels/telegram/telegram-adapter";
import { WeComAdapter } from "./channels/wecom/wecom-adapter";
import { TeamsAdapter } from "./channels/teams/teams-adapter";
import { updateManager } from "./services/update-manager";
import { trayManager } from "./services/tray-manager";
import { scheduledTaskService } from "./services/scheduled-task-service";
import { ensureDefaultWorkspace } from "./services/default-workspace";
import { GATEWAY_PORT, OPENCODE_PORT, WEBHOOK_PORT, WEB_PORT } from "../../shared/ports";

// --- Gateway singleton instances ---
const engineManager = new EngineManager();
const gatewayServer = new GatewayServer(engineManager);

// Register engine adapters
const openCodeAdapter = new OpenCodeAdapter({ port: OPENCODE_PORT });
const copilotAdapter = new CopilotSdkAdapter();
const claudeAdapter = new ClaudeCodeAdapter();
engineManager.registerAdapter(openCodeAdapter);
engineManager.registerAdapter(copilotAdapter);
engineManager.registerAdapter(claudeAdapter);

// Export for IPC handlers
export { engineManager, gatewayServer };

// --- Channel Manager ---
const channelManager = new ChannelManager();
const webhookServer = new WebhookServer(WEBHOOK_PORT);
channelManager.setWebhookServer(webhookServer);

// Register all channel adapters
channelManager.registerAdapter(new FeishuAdapter());
channelManager.registerAdapter(new DingTalkAdapter());
channelManager.registerAdapter(new TelegramAdapter());
channelManager.registerAdapter(new WeComAdapter());
channelManager.registerAdapter(new TeamsAdapter());

// Export for IPC handlers
export { channelManager };

// Gateway WS port — imported from shared/ports

// Startup readiness tracking
let startupReady = false;
export function isStartupReady(): boolean {
  return startupReady;
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

// Track if we're already quitting to prevent double cleanup
let isQuitting = false;

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // Ensure default workspace directory exists
    ensureDefaultWorkspace();

    // Initialize DeviceStore (needs to be after app ready)
    deviceStore.init();

    // Initialize ConversationStore (needs to be after app ready, before engines start)
    conversationStore.init();

    // Rebuild engine routing tables from persisted ConversationStore data
    engineManager.initFromStore();

    // Initialize scheduled task service (persistent desktop-level scheduled tasks)
    scheduledTaskService.init(engineManager);

    // Initialize agent team service (cross-engine orchestration)
    const { agentTeamService } = await import("./services/agent-team");
    agentTeamService.init(engineManager);

    // Register IPC handlers
    registerIpcHandlers();

    // In dev mode, start internal Auth API server
    // Vite middleware will proxy requests to this server
    if (!app.isPackaged) {
      try {
        await authApiServer.start();
      } catch (err) {
        mainLog.error("Failed to start Auth API server:", err);
      }
    } else {
      // In production mode, start the production HTTP server
      // This is required for Cloudflare Tunnel to work
      try {
        const port = await productionServer.start(WEB_PORT);
        mainLog.info(`Production server started on port ${port}`);
      } catch (err) {
        mainLog.error("Failed to start Production server:", err);
      }
    }

    // Start Gateway WebSocket server
    try {
      if (app.isPackaged && productionServer.isRunning()) {
        // In production: attach to production server for single-port access through Cloudflare Tunnel
        const httpServer = productionServer.getServer();
        if (httpServer) {
          gatewayServer.start({ server: httpServer, path: "/ws" });
          mainLog.info("Gateway server attached to production server at /ws");
        } else {
          gatewayServer.start({ port: GATEWAY_PORT });
          mainLog.info(`Gateway server started on port ${GATEWAY_PORT}`);
        }
      } else {
        // In dev: standalone port
        gatewayServer.start({ port: GATEWAY_PORT });
        mainLog.info(`Gateway server started on port ${GATEWAY_PORT}`);
      }
    } catch (err) {
      mainLog.error("Failed to start Gateway server:", err);
    }

    // Start all engine adapters (non-blocking, don't delay window creation)
    const enginePromises: Promise<void>[] = [];
    const engines = [
      ["OpenCode", openCodeAdapter],
      ["Copilot", copilotAdapter],
      ["Claude", claudeAdapter],
    ] as const;
    for (const [name, adapter] of engines) {
      const p = (adapter as any).start().then(
        () => mainLog.info(`${name} engine started successfully`),
        (err: any) => mainLog.error(`${name} engine failed to start:`, err?.message ?? err),
      );
      enginePromises.push(p);
    }

    // Create main window
    const isHiddenStart = process.argv.includes("--hidden");
    createWindow(isHiddenStart);

    // Initialize system tray
    trayManager.init();

    // Initialize auto-updater (only in packaged mode)
    if (app.isPackaged) {
      updateManager.init();
    }

    // Mark startup as ready once all engines have settled (success or failure)
    Promise.allSettled(enginePromises).then(async () => {
      mainLog.info("All engines settled");

      const gatewayUrl = app.isPackaged && productionServer.isRunning()
        ? `ws://127.0.0.1:${WEB_PORT}/ws`
        : `ws://127.0.0.1:${GATEWAY_PORT}`;

      channelManager.setRuntimeOptions({ gatewayUrl });

      try {
        // Start the shared webhook HTTP server for channels that need it
        // (Telegram, WeCom, Teams). Feishu and DingTalk use platform WSClient.
        await webhookServer.start();
        mainLog.info(`Webhook server started on port ${webhookServer.serverPort}`);
      } catch (err) {
        mainLog.error("Failed to start channel webhook server:", err);
      }

      // Initialize channels (after engines are ready and gateway is running)
      try {
        await channelManager.initFromConfig({ gatewayUrl });
      } catch (err) {
        mainLog.error("Failed to initialize channels:", err);
      }

      // Mark startup ready AFTER channels are initialized so the renderer
      // sees final channel statuses when it (re-)polls on startup:ready.
      startupReady = true;
      mainLog.info("All engines and channels settled, startup ready");
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("startup:ready");
      }
    });

    app.on("activate", () => {
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      } else if (BrowserWindow.getAllWindows().length === 0) {
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

    // When installing an update, the updater needs the normal quit flow to
    // complete (e.g. Squirrel.Mac swaps the app bundle and relaunches).
    // Only do synchronous cleanup and let the quit proceed without
    // preventDefault.
    if (updateManager.isInstallingUpdate()) {
      trayManager.destroy();
      await conversationStore.flushAll();
      await scheduledTaskService.shutdown();
      gatewayServer.stop();
      return;
    }

    event.preventDefault();

    try {
      trayManager.destroy();

      // Stop native file watchers early — @parcel/watcher uses NAPI threadsafe
      // functions that must be torn down before Node.js module cleanup begins.
      unwatchAll();

      // Flush conversation store before quit
      await conversationStore.flushAll();

      await Promise.all([
        authApiServer.stop(),
        channelManager.stopAll(),
        webhookServer.stop(),
        engineManager.stopAll(),
        productionServer.stop(),
        scheduledTaskService.shutdown(),
      ]);

      gatewayServer.stop();
    } catch (err) {
      mainLog.error("Cleanup error:", err);
    }

    app.exit(0);
  });
}
