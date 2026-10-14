import { randomBytes } from "node:crypto";
import os from "node:os";
import { runtimeHost } from "#runtime-host";
import packageJson from "../package.json";
import { ServiceRuntime } from "../shared/service-runtime";
import { HostManagementController, type HostSystemInfo } from "../shared/host-management";
import type { HostRuntimeStatus } from "../shared/host-control-types";
import { GATEWAY_PORT, OPENCODE_PORT, WEBHOOK_PORT, WEB_PORT } from "../shared/ports";
import { isLocalGatewayRequest } from "../shared/remote-access-policy";
import { EngineManager } from "../electron/main/gateway/engine-manager";
import { GatewayServer } from "../electron/main/gateway/ws-server";
import { OpenCodeAdapter } from "../electron/main/engines/opencode";
import { CopilotSdkAdapter } from "../electron/main/engines/copilot";
import { ClaudeCodeAdapter } from "../electron/main/engines/claude";
import { CodexAdapter } from "../electron/main/engines/codex";
import { createCodexDesktopSharing } from "../electron/main/engines/codex/desktop-sharing";
import { CodexDesktopCatalog } from "../electron/main/engines/codex/desktop-catalog";
import { getOrCreateCodexCatalogEnrollment } from "../electron/main/engines/codex/desktop-catalog-enrollment";
import { ChannelManager } from "../electron/main/channels/channel-manager";
import { WebhookServer } from "../electron/main/channels/webhook-server";
import { FeishuAdapter } from "../electron/main/channels/feishu/feishu-adapter";
import { DingTalkAdapter } from "../electron/main/channels/dingtalk/dingtalk-adapter";
import { TelegramAdapter } from "../electron/main/channels/telegram/telegram-adapter";
import { WeComAdapter } from "../electron/main/channels/wecom/wecom-adapter";
import { TeamsAdapter } from "../electron/main/channels/teams/teams-adapter";
import { WeixinIlinkAdapter } from "../electron/main/channels/weixin-ilink/weixin-ilink-adapter";
import { deviceStore } from "../electron/main/services/device-store";
import { conversationStore } from "../electron/main/services/conversation-store";
import { authApiServer } from "../electron/main/services/auth-api-server";
import { productionServer } from "../electron/main/services/production-server";
import { remoteAccessManager, setRemoteAccessPort, stopRemoteAccessTunnel } from "../electron/main/services/remote-access-manager";
import { scheduledTaskService } from "../electron/main/services/scheduled-task-service";
import { ensureDefaultWorkspace } from "../electron/main/services/default-workspace";
import { getTerminalService } from "../electron/main/services/terminal-service";
import { unwatchAll } from "../electron/main/services/file-service";
import { worktreeStore } from "../electron/main/services/worktree-store";
import { orchestratorService } from "../electron/main/services/orchestrator-service";
import { tunnelManager } from "../electron/main/services/tunnel-manager";
import { getQrCode, pollQrStatus } from "../electron/main/channels/weixin-ilink/weixin-ilink-qr-flow";
import { getLogFilePath, getFileLogLevel, setFileLogLevel, loadSettings, saveSettings, mainLog } from "../electron/main/services/logger";

/** Construct one host per process, after acquiring ownership of its data directory. */
export function createServiceHost(
  webMode: "static" | "dev-proxy",
  getSystemInfo: () => HostSystemInfo = () => ({
    platform: process.platform,
    arch: process.arch,
    version: packageJson.version,
    userDataPath: runtimeHost.paths.userDataPath,
    homePath: os.homedir(),
    isPackaged: runtimeHost.isPackaged,
  }),
) {
  const engineManager = new EngineManager();
  const internalGatewayToken = randomBytes(32).toString("hex");
  const gatewayServer = new GatewayServer(engineManager, {
    authValidator: (token, req) => token === internalGatewayToken
      ? req.headers.origin === undefined && isLocalGatewayRequest(req)
      : deviceStore.verifyToken(token).valid,
    requestValidator: req => remoteAccessManager.isRequestAllowed(req, true),
  });
  const unsubscribePolicy = remoteAccessManager.subscribe(() => gatewayServer.revalidateClients());
  const codexAdapter = new CodexAdapter();
  // Opt-in until the private Desktop protocol has a supported compatibility contract.
  const desktopSharingEnabled = process.env.CODEMUX_CODEX_DESKTOP_BRIDGE !== undefined
    ? process.env.CODEMUX_CODEX_DESKTOP_BRIDGE === "1"
    : loadSettings().codexDesktopBridgeEnabled === true;
  const codexDesktopSharing = desktopSharingEnabled
    ? createCodexDesktopSharing({
      listCandidates: (limit) => codexAdapter.listHistoricalSessions(limit),
      listModelCatalog: async () => { await codexAdapter.start(); return codexAdapter.listModels(); },
      renameStoredThread: (threadId, title) => codexAdapter.renameStoredThread(threadId, title),
      readStoredThread: (threadId) => codexAdapter.readStoredThread(threadId, { activeOnly: true }),
      archiveStoredThread: (threadId) => codexAdapter.archiveStoredThread(threadId),
      unarchiveStoredThread: (threadId) => codexAdapter.unarchiveStoredThread(threadId),
      catalogFactory: () => {
        const enrollment = getOrCreateCodexCatalogEnrollment(runtimeHost.paths.userDataPath);
        return new CodexDesktopCatalog({
          ...enrollment,
          client: codexAdapter.createDesktopCatalogClient(),
          previouslyAdmittedThreadIds: conversationStore.list({ engineType: "codex-desktop" })
            .filter((conversation) => conversation.catalogSourceId === enrollment.sourceId && conversation.engineSessionId)
            .map((conversation) => conversation.engineSessionId!),
          onError: (error) => mainLog.warn("Codex catalog refresh failed:", error.message),
        });
      },
    })
    : null;
  const engines = [
    ["OpenCode", new OpenCodeAdapter({ port: OPENCODE_PORT })],
    ["Copilot", new CopilotSdkAdapter()],
    ["Claude", new ClaudeCodeAdapter()],
    ["Codex", codexAdapter],
    ...(codexDesktopSharing ? [["Codex Desktop", codexDesktopSharing.adapter] as const] : []),
  ] as const;
  for (const [, adapter] of engines) engineManager.registerAdapter(adapter);

  const channelManager = new ChannelManager();
  const webhookServer = new WebhookServer(WEBHOOK_PORT);
  channelManager.setWebhookServer(webhookServer);
  channelManager.registerAdapter(new FeishuAdapter());
  channelManager.registerAdapter(new DingTalkAdapter());
  channelManager.registerAdapter(new TelegramAdapter());
  channelManager.registerAdapter(new WeComAdapter());
  channelManager.registerAdapter(new TeamsAdapter());
  channelManager.registerAdapter(new WeixinIlinkAdapter());

  const runtime = new ServiceRuntime({
    webMode,
    webPort: WEB_PORT,
    gatewayPort: GATEWAY_PORT,
    internalGatewayToken,
    ensureDefaultWorkspace,
    deviceStore,
    conversationStore,
    engineManager,
    engines,
    scheduledTaskService,
    authApiServer,
    productionServer,
    remoteAccessManager,
    setRemoteAccessPort,
    stopRemoteAccessTunnel,
    gatewayServer,
    closeGateway: () => gatewayServer.close(),
    channelManager,
    webhookServer,
    unwatchAll,
    destroyTerminals: () => getTerminalService().destroyAll(),
    log: mainLog,
  });

  const getGatewayUrl = () => webMode === "static" && productionServer.isRunning()
    ? `ws://127.0.0.1:${productionServer.getPort()}/ws`
    : `ws://127.0.0.1:${GATEWAY_PORT}`;
  const management = new HostManagementController({
    getSystemInfo,
    getNetworkInterfaces: os.networkInterfaces,
    getGatewayUrl,
    deviceStore,
    tunnelManager,
    remoteAccessManager,
    productionServer,
    logging: { getPath: getLogFilePath, getLevel: getFileLogLevel, setLevel: setFileLogLevel },
    settings: { load: loadSettings, save: saveSettings },
    channelManager,
    ilink: { getQrCode, pollQrStatus },
    isStartupReady: () => runtime.isStartupReady(),
  });

  function getStatus(): HostRuntimeStatus {
    const ready = runtime.isStartupReady();
    const listening = gatewayServer.getPort() !== undefined;
    return {
      pid: process.pid,
      phase: runtime.isStopping() ? "stopping" : ready ? "ready" : "starting",
      ready,
      dataPath: runtimeHost.paths.userDataPath,
      webPort: webMode === "static"
        ? productionServer.getServer()?.listening ? productionServer.getPort() : null
        : listening ? WEB_PORT : null,
      gatewayUrl: listening ? getGatewayUrl() : null,
    };
  }

  return {
    runtime,
    management,
    getStatus,
    engineManager,
    gatewayServer,
    channelManager,
    productionServer,
    async stop() {
      try {
        await runtime.stop();
      } finally {
        // The shared adapter detaches followers; the service also owns a private runtime.
        await codexDesktopSharing?.stop();
      }
      // Stop-time engine events may enqueue their final persistence writes.
      await engineManager.flushPendingState();
      await conversationStore.flushAll();
      await worktreeStore.flush();
      orchestratorService.flush();
      unsubscribePolicy();
    },
  };
}

export type ServiceHost = ReturnType<typeof createServiceHost>;
