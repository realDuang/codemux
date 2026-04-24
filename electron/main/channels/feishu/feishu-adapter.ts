// ============================================================================
// Feishu / Lark Channel Adapter
// Connects Feishu (Lark) bot to CodeMux via Gateway WebSocket.
// Architecture: One Group = One Session
// P2P chat = entry point (project selection), Group chat = session interaction.
// ============================================================================

import * as lark from "@larksuiteoapi/node-sdk";
import {
  ChannelAdapter,
  type ChannelConfig,
  type ChannelInfo,
  type ChannelCapabilities,
  type ChannelStatus,
} from "../channel-adapter";
import { GatewayWsClient } from "../gateway-ws-client";
import { StreamingController } from "../streaming/streaming-controller";
import { TokenBucket } from "../streaming/rate-limiter";
import { createStreamingSession, type StreamingSession } from "../streaming/streaming-types";
import { FeishuTransport } from "./feishu-transport";
import { FeishuRenderer } from "./feishu-renderer";
import { FeishuSessionMapper } from "./feishu-session-mapper";
import { parseCommand } from "../shared/command-parser";
import { P2P_CAPABILITIES, GROUP_CAPABILITIES } from "../shared/command-types";
import { buildHelpText } from "../shared/help-text-builder";
import {
  buildProjectListText,
  buildSessionListText,
  buildQuestionText,
  buildSessionNotification,
  groupAndSortSessions,
} from "../shared/list-builders";
import {
  handleSessionOpsCommand,
  type SessionContext,
} from "../shared/session-commands";
import {
  buildGroupWelcomeCard,
} from "./feishu-card-builder";
import {
  DEFAULT_FEISHU_CONFIG,
  TEMP_SESSION_TTL_MS,
  type FeishuConfig,
  type GroupBinding,
  type TempSession,
  type FeishuMessageEvent,
  type FeishuBotMenuEvent,
  type FeishuChatDisbandedEvent,
  type FeishuBotRemovedEvent,
  type FeishuUserRemovedEvent,
} from "./feishu-types";
import {
  formatFeishuStartupError,
  getLarkDomain,
  normalizeFeishuPlatform,
} from "./feishu-platform";
import type {
  EngineType,
  UnifiedPart,
  UnifiedMessage,
  UnifiedPermission,
  UnifiedQuestion,
} from "../../../../src/types/unified";
import {
  getFeishuChannelLog,
  type ScopedLogger,
} from "../../services/logger";

interface WsStartupMonitor {
  readyPromise: Promise<void>;
  cancel: () => void;
  markStartResolved: () => void;
  logger: {
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    trace: (...args: unknown[]) => void;
  };
}

// ============================================================================
// Feishu Adapter
// ============================================================================

export class FeishuAdapter extends ChannelAdapter {
  readonly channelType = "feishu";

  // --- State ---
  private status: ChannelStatus = "stopped";
  private error?: string;
  private config: FeishuConfig = { ...DEFAULT_FEISHU_CONFIG };

  // --- SDK instances ---
  private larkClient: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;

  // --- Internal ---
  private gatewayClient: GatewayWsClient | null = null;
  private sessionMapper = new FeishuSessionMapper();
  private rateLimiter = new TokenBucket(5, 5); // 5 tokens, 5/sec refill

  // --- Streaming Architecture ---
  private transport: FeishuTransport | null = null;
  private renderer = new FeishuRenderer();
  private streamingController: StreamingController | null = null;

  /** Feishu supports message update, delete, and rich content (interactive cards) */
  private static readonly CAPABILITIES: ChannelCapabilities = {
    supportsMessageUpdate: true,
    supportsMessageDelete: true,
    supportsRichContent: true,
    maxMessageBytes: 28_000,
  };

  // Verified against @larksuiteoapi/node-sdk@1.42.0. Re-check these markers after
  // SDK upgrades because the SDK does not expose structured websocket lifecycle hooks.
  private static readonly WS_READY_LOG = "ws client ready";
  private static readonly WS_STARTUP_FAILURE_MARKERS = ["system busy", "PingInterval"] as const;
  private static readonly WS_STARTUP_TIMEOUT_MS = 30_000;
  private static readonly CONFIG_RESTART_COOLDOWN_MS = 1_000;
  private static readonly CONFIG_RESTART_RETRY_DELAY_MS = 2_000;

  private get channelLog(): ScopedLogger {
    return getFeishuChannelLog(this.config.platform);
  }

  private omitUndefinedConfig(updates: Partial<FeishuConfig>): Partial<FeishuConfig> {
    return Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    ) as Partial<FeishuConfig>;
  }

  private mergeConfig(baseConfig: FeishuConfig, updates?: Partial<FeishuConfig>): FeishuConfig {
    if (!updates) {
      return { ...baseConfig };
    }

    const normalizedUpdates = this.omitUndefinedConfig(updates);

    return {
      ...baseConfig,
      ...normalizedUpdates,
      platform:
        normalizedUpdates.platform !== undefined
          ? normalizeFeishuPlatform(normalizedUpdates.platform)
          : baseConfig.platform,
    };
  }

  private shouldRestartAfterConfigUpdate(
    previousConfig: FeishuConfig,
    updates?: Partial<FeishuConfig>,
  ): boolean {
    if (!updates) {
      return false;
    }

    const nextConfig = this.mergeConfig(previousConfig, updates);

    return (
      nextConfig.appId !== previousConfig.appId ||
      nextConfig.appSecret !== previousConfig.appSecret ||
      nextConfig.platform !== previousConfig.platform
    );
  }

  private getPlatformName(platform = this.config.platform): "Feishu" | "Lark" {
    return platform === "lark" ? "Lark" : "Feishu";
  }

  private getChannelDisplayName(platform = this.config.platform): string {
    return `${this.getPlatformName(platform)} Bot`;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isTransientConfigRestartError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("system busy");
  }

  private async restartAfterConfigUpdate(config: ChannelConfig): Promise<void> {
    await this.stop();

    // Give the previous long connection a brief cooldown before reconnecting
    // with the replacement bot credentials.
    await this.delay(FeishuAdapter.CONFIG_RESTART_COOLDOWN_MS);

    try {
      await this.start(config);
    } catch (error) {
      if (!this.isTransientConfigRestartError(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.channelLog.warn(
        `Config update restart hit a transient long-connection busy error. Waiting ${FeishuAdapter.CONFIG_RESTART_RETRY_DELAY_MS}ms and retrying once. Original error: ${message}`,
      );
      await this.delay(FeishuAdapter.CONFIG_RESTART_RETRY_DELAY_MS);
      await this.start(config);
    }
  }

  private createWsStartupMonitor(platform: "feishu" | "lark", platformConfigured: boolean): WsStartupMonitor {
    let isSettled = false;
    let hasStartResolved = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;

    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    readyPromise.catch(() => undefined);

    const settleReady = () => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeoutId);
      resolveReady();
    };

    const settleError = (message: string) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeoutId);
      rejectReady(new Error(message));
    };

    const cancel = () => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeoutId);
      resolveReady();
    };

    const markStartResolved = () => {
      hasStartResolved = true;
    };

    const normalizeLogArgs = (args: unknown[]): unknown[] => (
      args.length === 1 && Array.isArray(args[0]) ? args[0] as unknown[] : args
    );

    const stringifyLogArgs = (args: unknown[]): string => args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg instanceof Error) return arg.message;
        if (Array.isArray(arg)) return arg.join(" ");
        return String(arg);
      })
      .join(" ");

    const handleLog = (level: "error" | "warn" | "info" | "debug" | "trace", args: unknown[]) => {
      const normalizedArgs = normalizeLogArgs(args);
      const text = stringifyLogArgs(normalizedArgs);
      const isReadyLog = text.includes(FeishuAdapter.WS_READY_LOG);
      const isStartupFailure =
        this.status === "starting" && FeishuAdapter.WS_STARTUP_FAILURE_MARKERS.some((marker) => text.includes(marker));

      // The Lark SDK logger uses trace/debug/info/warn/error, while electron-log uses
      // debug/verbose/info/warn/error. Keep the readiness signal at info, downgrade
      // other SDK info chatter to verbose, and map SDK trace to debug so it is not lost.

      switch (level) {
        case "error":
          this.channelLog.error(...normalizedArgs);
          break;
        case "warn":
          this.channelLog.warn(...normalizedArgs);
          break;
        case "info":
          if (isReadyLog) {
            this.channelLog.info(...normalizedArgs);
          } else {
            this.channelLog.verbose(...normalizedArgs);
          }
          break;
        case "debug":
          this.channelLog.debug(...normalizedArgs);
          break;
        case "trace":
          this.channelLog.debug(...normalizedArgs);
          break;
      }

      if (isReadyLog) {
        settleReady();
        return;
      }

      if (isStartupFailure) {
        settleError(formatFeishuStartupError(text, platform, platformConfigured));
      }
    };

    const platformName = platform === "lark" ? "Lark" : "Feishu";
    const timeoutId = setTimeout(() => {
      if (hasStartResolved) {
        this.channelLog.warn(
          `${platformName} WSClient.start() resolved before the ready log was observed. Treating start() resolution as a weak success signal; re-check websocket log markers after upgrading @larksuiteoapi/node-sdk@1.42.0.`,
        );
        settleReady();
        return;
      }

      settleError(
        `Timed out waiting for ${platformName} websocket connection. Verify the app is self-built, long connection is enabled in the correct developer console, and the selected platform matches your tenant.`,
      );
    }, FeishuAdapter.WS_STARTUP_TIMEOUT_MS);

    return {
      readyPromise,
      cancel,
      markStartResolved,
      logger: {
        error: (...args: unknown[]) => handleLog("error", args),
        warn: (...args: unknown[]) => handleLog("warn", args),
        info: (...args: unknown[]) => handleLog("info", args),
        debug: (...args: unknown[]) => handleLog("debug", args),
        trace: (...args: unknown[]) => handleLog("trace", args),
      },
    };
  }

  // --- Lifecycle ---

  async start(config: ChannelConfig): Promise<void> {
    if (this.status === "running") {
      this.channelLog.warn(`${this.getPlatformName()} adapter already running, stopping first`);
      await this.stop();
    }

    this.status = "starting";
    this.error = undefined;
    this.emit("status.changed", this.status);

    // Merge config
    const options = (config.options as Partial<FeishuConfig> | undefined) ?? {};
    const platformConfigured = options.platform === "feishu" || options.platform === "lark";
    this.config = this.mergeConfig(DEFAULT_FEISHU_CONFIG, options);

    if (!this.config.appId || !this.config.appSecret) {
      this.status = "error";
      this.error = "Missing appId or appSecret";
      this.emit("status.changed", this.status);
      throw new Error(`${this.getPlatformName()} appId and appSecret are required`);
    }

    let wsStartup: WsStartupMonitor | null = null;

    try {
      const domain = getLarkDomain(this.config.platform);
      wsStartup = this.createWsStartupMonitor(this.config.platform, platformConfigured);

      // 1. Create Lark REST client
      this.larkClient = new lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        domain,
        disableTokenCache: false,
      });

      // 1b. Create transport and streaming controller
      this.transport = new FeishuTransport(this.larkClient, this.rateLimiter, this.channelLog);
      this.streamingController = new StreamingController(
        this.transport,
        this.renderer,
        { throttleMs: this.config.streamingThrottleMs },
        FeishuAdapter.CAPABILITIES,
      );

      // 2. Create event dispatcher for receiving messages, card actions, and lifecycle events
      const dispatcher = new lark.EventDispatcher({});
      dispatcher.register({
        "im.message.receive_v1": async (data: unknown) => {
          try {
            await this.handleFeishuMessage(data as FeishuMessageEvent);
          } catch (err) {
            this.channelLog.error(`Error handling ${this.getPlatformName()} message:`, err);
          }
        },
        "application.bot.menu_v6": async (data: unknown) => {
          try {
            await this.handleBotMenuEvent(data as FeishuBotMenuEvent);
          } catch (err) {
            this.channelLog.error("Error handling bot menu event:", err);
          }
        },
        "im.chat.disbanded_v1": async (data: unknown) => {
          try {
            await this.handleGroupDisbanded(data as FeishuChatDisbandedEvent);
          } catch (err) {
            this.channelLog.error("Error handling group disbanded event:", err);
          }
        },
        "im.chat.member.bot.deleted_v1": async (data: unknown) => {
          try {
            await this.handleBotRemovedFromGroup(data as FeishuBotRemovedEvent);
          } catch (err) {
            this.channelLog.error("Error handling bot removed event:", err);
          }
        },
        "im.chat.member.user.deleted_v1": async (data: unknown) => {
          try {
            await this.handleUserRemovedFromGroup(data as FeishuUserRemovedEvent);
          } catch (err) {
            this.channelLog.error("Error handling user removed event:", err);
          }
        },
        // Suppress warnings for events we don't handle
        "im.chat.access_event.bot_p2p_chat_entered_v1": async () => {},
        "im.message.message_read_v1": async () => {},
      });

      // 3. Connect to Feishu cloud via WebSocket
      this.wsClient = new lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        domain,
        loggerLevel: lark.LoggerLevel.info,
        logger: wsStartup.logger,
      });

      await this.wsClient.start({ eventDispatcher: dispatcher });
      wsStartup.markStartResolved();
      await wsStartup.readyPromise;
      this.channelLog.info(`${this.getPlatformName()} WSClient connected to cloud`);

      // 4. Connect to local Gateway
      this.gatewayClient = new GatewayWsClient(this.config.gatewayUrl);
      await this.gatewayClient.connect();
      this.channelLog.info("Gateway WS client connected");

      // 5. Restore persisted group bindings from disk
      this.sessionMapper.setLogger(this.channelLog);
      this.sessionMapper.loadBindings();

      // 6. Subscribe to Gateway notifications
      this.subscribeGatewayEvents();

      this.status = "running";
      this.emit("status.changed", this.status);
      this.emit("connected");
      this.channelLog.info(`${this.getPlatformName()} adapter started successfully`);
    } catch (err) {
      wsStartup?.cancel();
      const normalizedMessage = formatFeishuStartupError(err, this.config.platform, platformConfigured);
      this.status = "error";
      this.error = normalizedMessage;
      this.emit("status.changed", this.status);
      this.channelLog.error(`Failed to start ${this.getPlatformName()} adapter:`, err);
      // Clean up partial init (preserve error state)
      const savedStatus = this.status;
      const savedError = this.error;
      await this.stop().catch(() => {});
      this.status = savedStatus;
      this.error = savedError;
      this.emit("status.changed", this.status);
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.channelLog.info(`Stopping ${this.getPlatformName()} adapter...`);

    // Clean up streaming timers
    this.sessionMapper.cleanup();

    // Disconnect Gateway WS
    if (this.gatewayClient) {
      this.gatewayClient.disconnect();
      this.gatewayClient = null;
    }

    // Disconnect Feishu WSClient and stop its reconnect loop.
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch (err) {
        this.channelLog.warn(`Failed to close ${this.getPlatformName()} WSClient cleanly:`, err);
      }
      this.wsClient = null;
    }
    this.larkClient = null;
    this.transport = null;
    this.streamingController = null;

    this.status = "stopped";
    this.error = undefined;
    this.emit("status.changed", this.status);
    this.emit("disconnected", "stopped");
    this.channelLog.info(`${this.getPlatformName()} adapter stopped`);
  }

  getInfo(): ChannelInfo {
    return {
      type: this.channelType,
      name: this.getChannelDisplayName(),
      status: this.status,
      error: this.error,
    };
  }

  async updateConfig(config: Partial<ChannelConfig>): Promise<void> {
    const wasRunning = this.status === "running";
    const newOptions = config.options as Partial<FeishuConfig> | undefined;
    const previousConfig = { ...this.config };

    if (newOptions) {
      this.config = this.mergeConfig(this.config, newOptions);
    }

    const shouldRestart = wasRunning && this.shouldRestartAfterConfigUpdate(previousConfig, newOptions);

    // If credentials or platform changed while running, restart
    if (shouldRestart) {
      this.channelLog.info(`Credentials or platform changed, restarting ${this.getPlatformName()} adapter`);
      const fullConfig: ChannelConfig = {
        type: "feishu",
        name: this.getChannelDisplayName(),
        enabled: true,
        options: this.config as unknown as Record<string, unknown>,
      };
      await this.restartAfterConfigUpdate(fullConfig);
    }
  }

  // ============================================================================
  // Gateway Event Subscriptions
  // ============================================================================

  private subscribeGatewayEvents(): void {
    if (!this.gatewayClient) return;

    // Streaming content updates
    this.gatewayClient.on("message.part.updated", (data) => {
      this.handlePartUpdated(data.sessionId, data.part);
    });

    // Message completed
    this.gatewayClient.on("message.updated", (data) => {
      this.handleMessageCompleted(data.sessionId, data.message);
    });

    // Permission requests — auto-approve
    this.gatewayClient.on("permission.asked", (data) => {
      this.handlePermissionAsked(data.permission);
    });

    // Question requests
    this.gatewayClient.on("question.asked", (data) => {
      this.handleQuestionAsked(data.question);
    });

    // Session title updates — sync to Feishu group name
    this.gatewayClient.on("session.updated", (data) => {
      this.handleSessionUpdated(data.session);
    });
  }

  // ============================================================================
  // Feishu Message Handling (P2P vs Group routing)
  // ============================================================================

  private async handleFeishuMessage(event: FeishuMessageEvent): Promise<void> {
    const { message, sender } = event;
    const { chat_id, chat_type, content, message_id, message_type } = message;

    // Skip non-text messages
    if (message_type !== "text") {
      this.channelLog.verbose(`Ignoring non-text message type: ${message_type}`);
      return;
    }

    // Deduplication
    if (this.sessionMapper.isDuplicate(message_id)) {
      this.channelLog.verbose(`Skipping duplicate message: ${message_id}`);
      return;
    }

    // Parse content JSON
    let text: string;
    try {
      const parsed = JSON.parse(content);
      text = parsed.text || "";
    } catch {
      text = content;
    }

    // Strip @mentions from text (Feishu includes @_user_1 style placeholders)
    text = text.replace(/@_user_\d+/g, "").trim();
    if (!text) return;

    this.channelLog.info(`Message from ${chat_type} chat ${chat_id}: ${text.slice(0, 100)}`);

    if (chat_type === "p2p") {
      // Record open_id → chat_id mapping for bot menu events
      if (sender?.sender_id?.open_id) {
        this.sessionMapper.setOpenIdMapping(sender.sender_id.open_id, chat_id);
        this.sessionMapper.getOrCreateP2PChat(chat_id, sender.sender_id.open_id);

        // Transfer any pending selection stored by openId (from bot menu before first message)
        const pendingByOpenId = this.sessionMapper.takePendingSelectionByOpenId(sender.sender_id.open_id);
        if (pendingByOpenId) {
          this.sessionMapper.setPendingSelection(chat_id, pendingByOpenId);
          this.channelLog.info(`Transferred pending selection from openId=${sender.sender_id.open_id} to chat=${chat_id}`);
        }
      }
      await this.handleP2PMessage(chat_id, text);
    } else if (chat_type === "group") {
      // No @mention requirement — bot-owned group, all messages are for bot
      await this.handleGroupMessage(chat_id, text);
    }
  }

  // ============================================================================
  // P2P Message Handling (Entry Point Only)
  // ============================================================================

  private async handleP2PMessage(chatId: string, text: string): Promise<void> {
    // 1. Check for slash commands first
    const command = parseCommand(text);
    if (command) {
      this.sessionMapper.clearPendingSelection(chatId);
      await this.handleP2PCommand(chatId, command);
      return;
    }

    // 2. Check for pending question — treat any reply as a freeform answer
    const pendingQ = this.sessionMapper.getPendingQuestion(chatId);
    if (pendingQ && this.gatewayClient) {
      this.sessionMapper.clearPendingQuestion(chatId);
      await this.gatewayClient.replyQuestion({
        questionId: pendingQ.questionId,
        answers: [[text]],
      });
      this.channelLog.info(`Replied to question ${pendingQ.questionId} with freeform answer`);
      return;
    }

    // 3. Check for pending selection (number reply or "new")
    const pending = this.sessionMapper.getPendingSelection(chatId);
    if (pending) {
      const handled = await this.handlePendingSelection(chatId, text, pending);
      if (handled) return;
    }

    // 4. Active temp session (not expired)? → send to engine
    const tempSession = this.sessionMapper.getTempSession(chatId);
    if (tempSession && !this.isTempSessionExpired(tempSession)) {
      await this.enqueueP2PMessage(chatId, text);
      return;
    }

    // 5. Has lastSelectedProject → auto-create temp session and send
    const p2pState = this.sessionMapper.getP2PChat(chatId);
    if (p2pState?.lastSelectedProject && this.gatewayClient) {
      // Clean up expired temp session if any
      if (tempSession) {
        await this.cleanupExpiredTempSession(chatId);
      }
      await this.createTempSessionAndSend(chatId, p2pState.lastSelectedProject, text);
      return;
    }

    // 6. No project → use default workspace as fallback
    if (this.gatewayClient) {
      const allProjects = await this.gatewayClient.listAllProjects();
      const defaultProject = allProjects.find(p => p.isDefault);
      if (defaultProject) {
        // Cleanup expired temp session from a previous default-workspace round
        if (this.sessionMapper.getTempSession(chatId)) {
          await this.cleanupExpiredTempSession(chatId);
        }
        const defaultRef = {
          directory: defaultProject.directory,
          engineType: defaultProject.engineType,
          projectId: defaultProject.id,
        };
        await this.createTempSessionAndSend(chatId, defaultRef, text, "默认工作区");
        return;
      }
    }

    // 7. Fallback: show project list
    await this.showProjectList(chatId);
  }

  private async handleP2PCommand(
    chatId: string,
    command: ReturnType<typeof parseCommand>,
  ): Promise<void> {
    if (!command || !this.transport) return;

    if (this.gatewayClient) {
      const handled = await handleSessionOpsCommand(command, {
        sendText: (text) => this.transport!.sendText(chatId, text),
        gatewayClient: this.gatewayClient,
        getContext: (): SessionContext | null => {
          const t = this.sessionMapper.getTempSession(chatId);
          if (!t) return null;
          return {
            conversationId: t.conversationId,
            engineType: t.engineType,
            directory: t.directory,
          };
        },
      });
      if (handled) return;
    }

    switch (command.command) {
      case "help":
      case "start":
        await this.transport.sendText(chatId, buildHelpText(P2P_CAPABILITIES));
        break;

      case "project":
        await this.showProjectList(chatId);
        break;

      case "new":
        await this.handleP2PNewCommand(chatId);
        break;

      case "switch":
        await this.handleP2PSwitchCommand(chatId);
        break;

      default:
        await this.transport.sendText(
          chatId,
          `📋 未知命令：${command.command}。使用 /help 查看可用命令。`,
        );
    }
  }

  /** /new — create a new session under the last selected project (P2P only).
   *  Feishu can create groups, so this opens a fresh group chat for the session. */
  private async handleP2PNewCommand(chatId: string): Promise<void> {
    if (!this.transport || !this.gatewayClient) return;
    const p2pState = this.sessionMapper.getP2PChat(chatId);
    if (!p2pState?.lastSelectedProject) {
      await this.transport.sendText(
        chatId,
        "📋 当前未选择项目。请先使用 /project 选择项目。",
      );
      return;
    }
    const userOpenId = p2pState.openId;
    if (!userOpenId) {
      await this.transport.sendText(
        chatId,
        "📋 无法识别用户身份，无法创建群聊会话。",
      );
      return;
    }
    if (this.sessionMapper.getTempSession(chatId)) {
      await this.cleanupExpiredTempSession(chatId);
    }
    const project = p2pState.lastSelectedProject;
    const projectName = project.directory.split(/[\\/]/).pop() || project.directory;
    await this.createNewSessionForProject(chatId, userOpenId, project, projectName);
  }

  /** /switch — list existing sessions in the last selected project (P2P only). */
  private async handleP2PSwitchCommand(chatId: string): Promise<void> {
    if (!this.transport) return;
    const p2pState = this.sessionMapper.getP2PChat(chatId);
    if (!p2pState?.lastSelectedProject) {
      await this.transport.sendText(
        chatId,
        "📋 当前未选择项目。请先使用 /project 选择项目。",
      );
      return;
    }
    const project = p2pState.lastSelectedProject;
    const projectName = project.directory.split(/[\\/]/).pop() || project.directory;
    await this.showSessionListForProject(chatId, project, projectName);
  }

  // ============================================================================
  // P2P Selection State Machine
  // ============================================================================

  /** Show project list and enter project selection mode */
  private async showProjectList(chatId: string): Promise<void> {
    if (!this.gatewayClient) return;

    const allProjects = await this.gatewayClient.listAllProjects();
    // Filter out default workspace — users should only pick real projects
    const projects = allProjects.filter(p => !p.isDefault);

    if (projects.length > 0) {
      const text = buildProjectListText(projects);
      await this.transport!.sendText(chatId, text);
      // Flatten projects in display order (grouped by engine) for number mapping
      const flatProjects = this.flattenProjectsByEngine(projects);
      this.sessionMapper.setPendingSelection(chatId, {
        type: "project",
        projects: flatProjects,
      });
    } else {
      // No real projects — show informational message.
      // Do NOT set lastSelectedProject; let step 6 handle temp session creation
      // when the user sends a natural-language message.
      const defaultProject = allProjects.find(p => p.isDefault);
      if (defaultProject) {
        await this.transport!.sendText(chatId, buildProjectListText([]));
      } else {
        await this.transport!.sendText(chatId, buildProjectListText([]));
        this.sessionMapper.setPendingSelection(chatId, {
          type: "project",
          projects: [],
        });
      }
    }
  }

  /** Show session list for a specific project and enter session selection mode */
  private async showSessionListForProject(
    chatId: string,
    project: { directory: string; engineType?: EngineType; projectId: string },
    projectName: string,
  ): Promise<void> {
    if (!this.gatewayClient) return;
    const sessions = await this.gatewayClient.listAllSessions();
    const filtered = sessions.filter((s) => s.projectId === project.projectId);
    const sorted = groupAndSortSessions(filtered);
    const sessionText = buildSessionListText(sorted, projectName);
    await this.transport!.sendText(chatId, sessionText);

    this.sessionMapper.setPendingSelection(chatId, {
      type: "session",
      sessions: sorted,
      engineType: project.engineType,
      directory: project.directory,
      projectId: project.projectId,
      projectName,
    });
  }

  /** Create a new session for a project and open a group chat */
  private async createNewSessionForProject(
    chatId: string,
    userOpenId: string,
    project: { directory: string; engineType?: EngineType; projectId: string },
    projectName: string,
  ): Promise<void> {
    if (!this.gatewayClient) return;
    try {
      const session = await this.gatewayClient.createSession({
        engineType: project.engineType,
        directory: project.directory,
      });
      await this.createGroupForSession(
        userOpenId,
        session.id,
        session.engineType,
        project.directory,
        project.projectId,
        projectName,
        chatId,
      );
    } catch (err) {
      await this.transport!.sendText(
        chatId,
        `📋 创建会话失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Show project list from a bot menu event context (may not have chatId yet) */
  private async showProjectListFromMenu(
    openId: string,
    chatId: string | undefined,
    receiveId: string,
    receiveIdType: string,
  ): Promise<void> {
    if (!this.gatewayClient) return;
    const allProjects = await this.gatewayClient.listAllProjects();
    // Filter out default workspace — users should only pick real projects
    const projects = allProjects.filter(p => !p.isDefault);
    const text = buildProjectListText(projects);
    await this.transport!.sendMessageTo(receiveId, receiveIdType, "text", JSON.stringify({ text }));

    if (projects.length > 0) {
      const flatProjects = this.flattenProjectsByEngine(projects);
      const selection = { type: "project" as const, projects: flatProjects };
      if (chatId) {
        this.sessionMapper.setPendingSelection(chatId, selection);
      } else {
        this.sessionMapper.setPendingSelectionByOpenId(openId, selection);
      }
    }
  }

  // ============================================================================
  // P2P Temp Session Methods
  // ============================================================================

  /** Check if a temp session has expired (2h since last activity) */
  private isTempSessionExpired(temp: TempSession): boolean {
    return Date.now() - temp.lastActiveAt > TEMP_SESSION_TTL_MS;
  }

  /** Create a temp session for the given project and send the first message */
  private async createTempSessionAndSend(
    chatId: string,
    project: { directory: string; engineType?: EngineType; projectId: string },
    text: string,
    projectName?: string,
  ): Promise<void> {
    if (!this.gatewayClient) return;

    try {
      const session = await this.gatewayClient.createSession({
        engineType: project.engineType,
        directory: project.directory,
      });

      const tempSession: TempSession = {
        conversationId: session.id,
        engineType: session.engineType,
        directory: project.directory,
        projectId: project.projectId,
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: false,
      };

      this.sessionMapper.setTempSession(chatId, tempSession);
      const name = projectName || project.directory.split(/[\\/]/).pop() || project.directory;
      await this.transport!.sendText(chatId, buildSessionNotification(name, session.engineType, session.id));
      await this.enqueueP2PMessage(chatId, text);
    } catch (err) {
      await this.transport!.sendText(
        chatId,
        `📋 创建临时会话失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Enqueue a message for serial processing in the P2P temp session */
  private async enqueueP2PMessage(chatId: string, text: string): Promise<void> {
    const temp = this.sessionMapper.getTempSession(chatId);
    if (!temp) return;

    temp.messageQueue.push(text);
    if (!temp.processing) {
      await this.processP2PQueue(chatId);
    }
  }

  /** Process the next message in the P2P temp session queue */
  private async processP2PQueue(chatId: string): Promise<void> {
    const temp = this.sessionMapper.getTempSession(chatId);
    if (!temp || temp.messageQueue.length === 0) {
      if (temp) temp.processing = false;
      return;
    }

    temp.processing = true;
    const text = temp.messageQueue.shift()!;
    await this.sendToEngineP2P(chatId, temp, text);
  }

  /** Send a message to the engine via a P2P temp session (no group) */
  private async sendToEngineP2P(
    chatId: string,
    tempSession: TempSession,
    text: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport || !this.streamingController) {
      tempSession.processing = false;
      this.channelLog.error("Gateway client not connected, cannot send P2P message");
      return;
    }

    // In streaming mode: send placeholder; in batch mode: skip it
    let platformMsgId = "";
    if (!this.streamingController.isBatchMode) {
      platformMsgId = await this.transport.sendText(chatId, "🤔 思考中...");
      if (!platformMsgId) {
        this.channelLog.error("Failed to send P2P thinking message");
        await this.processP2PQueue(chatId);
        return;
      }
    }

    tempSession.lastActiveAt = Date.now();

    // Create streaming session (platformMsgId may be empty in batch mode)
    const streaming = createStreamingSession(chatId, tempSession.conversationId, platformMsgId);
    tempSession.streamingSession = streaming;

    const sendPromise = this.gatewayClient.sendMessage({
      sessionId: tempSession.conversationId,
      content: [{ type: "text", text }],
    });

    sendPromise
      .then((msg) => {
        streaming.messageId = msg.id;
      })
      .catch(async (err) => {
        this.channelLog.error("P2P sendMessage failed:", err);
        tempSession.streamingSession = undefined;
        if (platformMsgId) {
          this.transport!.updateText(
            platformMsgId,
            `⚠️ 错误：${err instanceof Error ? err.message : String(err)}`,
          );
        } else {
          this.transport!.sendText(
            chatId,
            `⚠️ 错误：${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const p2pState = this.sessionMapper.getP2PChat(chatId);
        if (p2pState?.lastSelectedProject) {
          await this.cleanupExpiredTempSession(chatId);
        }
        await this.processP2PQueue(chatId);
      });
  }

  /** Clean up an expired or invalid temp session */
  private async cleanupExpiredTempSession(chatId: string): Promise<void> {
    const temp = this.sessionMapper.getTempSession(chatId);
    if (!temp) return;

    if (temp.streamingSession?.patchTimer) {
      clearTimeout(temp.streamingSession.patchTimer);
    }
    try {
      await this.gatewayClient?.deleteSession(temp.conversationId);
      this.channelLog.info(`Deleted expired temp session: ${temp.conversationId}`);
    } catch {
      // Ignore deletion failures for temp sessions
    }
    this.sessionMapper.clearTempSession(chatId);
  }

  /** Return projects in display order, excluding default workspace */
  private flattenProjectsByEngine(
    projects: import("../../../../src/types/unified").UnifiedProject[],
  ): import("../../../../src/types/unified").UnifiedProject[] {
    return projects.filter(p => !p.isDefault);
  }

  /** Handle a pending selection reply (number or "new") */
  private async handlePendingSelection(
    chatId: string,
    text: string,
    pending: import("./feishu-types").PendingSelection,
  ): Promise<boolean> {
    if (pending.type === "project") {
      return this.handleProjectSelection(chatId, text, pending);
    }
    if (pending.type === "session") {
      return this.handleSessionSelection(chatId, text, pending);
    }
    return false;
  }

  /** Handle project number selection */
  private async handleProjectSelection(
    chatId: string,
    text: string,
    pending: import("./feishu-types").PendingSelection,
  ): Promise<boolean> {
    // Empty project list — re-fetch to check if projects are now available
    if (!pending.projects || pending.projects.length === 0) {
      await this.showProjectList(chatId);
      return true;
    }

    const num = parseInt(text.trim(), 10);
    if (isNaN(num) || num < 1 || num > pending.projects.length) {
      return false; // Not a valid number — fall through to show project list again
    }

    const project = pending.projects[num - 1];
    const projectName = project.name || project.directory.split(/[\\/]/).pop() || project.directory;

    // Save last selected project
    const projectRef = {
      directory: project.directory,
      engineType: project.engineType,
      projectId: project.id,
    };
    this.sessionMapper.setP2PLastProject(chatId, projectRef);

    await this.showSessionListForProject(chatId, projectRef, projectName);

    return true;
  }

  /** Handle session number selection. To create a new session, use /new instead. */
  private async handleSessionSelection(
    chatId: string,
    text: string,
    pending: import("./feishu-types").PendingSelection,
  ): Promise<boolean> {
    const trimmed = text.trim().toLowerCase();
    const p2pState = this.sessionMapper.getP2PChat(chatId);
    const userOpenId = p2pState?.openId;
    if (!userOpenId || !pending.directory || !pending.projectId) {
      return false;
    }

    // Number selection for existing session
    const num = parseInt(trimmed, 10);
    if (isNaN(num) || num < 1 || !pending.sessions || num > pending.sessions.length) {
      return false; // Not a valid number — fall through
    }

    const session = pending.sessions[num - 1];
    this.sessionMapper.clearPendingSelection(chatId);

    // Check if this session already has a bound group chat — if so, direct user there
    if (this.sessionMapper.hasGroupForConversation(session.id)) {
      await this.transport!.sendText(
        chatId,
        `📋 此会话已有对应的群聊，请直接在群聊中发送消息。`,
      );
      return true;
    }

    await this.createGroupForSession(
      userOpenId,
      session.id,
      session.engineType,
      pending.directory,
      pending.projectId,
      pending.projectName || "",
      chatId,
    );

    return true;
  }

  // ============================================================================
  // Group Message Handling (Session Interaction)
  // ============================================================================

  private async handleGroupMessage(groupChatId: string, text: string): Promise<void> {
    const binding = this.sessionMapper.getGroupBinding(groupChatId);
    if (!binding) {
      await this.transport!.sendText(groupChatId, "📋 此群聊未绑定到 CodeMux 会话。");
      return;
    }

    const command = parseCommand(text);
    if (command) {
      await this.handleGroupCommand(groupChatId, binding, command);
      return;
    }

    // Check for pending question — treat any reply as a freeform answer
    const pendingQ = this.sessionMapper.getPendingQuestion(groupChatId);
    if (pendingQ && this.gatewayClient) {
      this.sessionMapper.clearPendingQuestion(groupChatId);
      await this.gatewayClient.replyQuestion({
        questionId: pendingQ.questionId,
        answers: [[text]],
      });
      this.channelLog.info(`Replied to question ${pendingQ.questionId} with freeform answer`);
      return;
    }

    // Regular message → send to engine
    await this.sendToEngine(groupChatId, binding, text);
  }

  private async handleGroupCommand(
    groupChatId: string,
    binding: GroupBinding,
    command: ReturnType<typeof parseCommand>,
  ): Promise<void> {
    if (!command || !this.gatewayClient || !this.transport) return;

    const handled = await handleSessionOpsCommand(command, {
      sendText: (text) => this.transport!.sendText(groupChatId, text),
      gatewayClient: this.gatewayClient,
      getContext: (): SessionContext => ({
        conversationId: binding.conversationId,
        engineType: binding.engineType,
        directory: binding.directory,
      }),
    });
    if (handled) return;

    switch (command.command) {
      case "help":
      case "start":
        await this.transport.sendText(
          groupChatId,
          buildHelpText(GROUP_CAPABILITIES),
        );
        break;

      default:
        await this.transport.sendText(
          groupChatId,
          `📋 未知命令：${command.command}。使用 /help 查看可用命令。`,
        );
    }
  }

  // ============================================================================
  // Group Creation (Core: One Group = One Session)
  // ============================================================================

  private async createGroupForSession(
    userOpenId: string,
    conversationId: string,
    engineType: EngineType,
    directory: string,
    projectId: string,
    projectName: string,
    p2pChatId?: string,
  ): Promise<void> {
    if (!this.larkClient || !this.gatewayClient || !this.transport) return;
    // Check if session already has a group
    if (this.sessionMapper.hasGroupForConversation(conversationId)) {
      const existingChatId = this.sessionMapper.findGroupChatIdByConversationId(conversationId);
      if (p2pChatId) {
        await this.transport.sendText(
          p2pChatId,
          `Session already has a group chat. Check your Feishu groups.`,
        );
      }
      this.channelLog.warn(`Conversation ${conversationId} already has group ${existingChatId}`);
      return;
    }

    // Concurrency guard — prevent duplicate group creation from rapid clicks
    if (!this.sessionMapper.markCreating(conversationId)) {
      this.channelLog.warn(`Conversation ${conversationId} group creation already in progress`);
      return;
    }

    try {
      // Fetch session title for group name
      let sessionTitle = "New Session";
      try {
        const session = await this.gatewayClient.getSession(conversationId);
        if (session?.title) {
          sessionTitle = session.title;
        }
      } catch {
        // Use default title if session fetch fails
      }

      // Create Feishu group chat with the user
      const groupName = `[${projectName}] ${sessionTitle}`;
      const createRes = await this.larkClient.im.chat.create({
        params: { user_id_type: "open_id", set_bot_manager: true },
        data: {
          name: groupName,
          user_id_list: [userOpenId],
        },
      });

      const newChatId = (createRes as any)?.data?.chat_id;
      if (!newChatId) {
        this.channelLog.error("Failed to create group chat: no chat_id returned");
        if (p2pChatId) {
          await this.transport.sendText(p2pChatId, "Failed to create group chat. Please try again.");
        }
        return;
      }

      this.channelLog.info(`Created group chat: ${newChatId} for conversation ${conversationId}`);

      // Register group binding
      this.sessionMapper.createGroupBinding({
        chatId: newChatId,
        conversationId,
        engineType,
        directory,
        projectId,
        ownerOpenId: userOpenId,
        streamingSessions: new Map(),
        createdAt: Date.now(),
      });

      // Send welcome card to the new group
      const welcomeCard = buildGroupWelcomeCard(projectName, engineType, conversationId);
      await this.transport.sendRichContent(newChatId, welcomeCard);

      // Notify user in P2P
      if (p2pChatId) {
        await this.transport.sendText(
          p2pChatId,
          `Group created for session. Check your Feishu groups for "${groupName}".`,
        );
      }
    } catch (err) {
      this.channelLog.error("Failed to create group for session:", err);
      if (p2pChatId) {
        await this.transport.sendText(
          p2pChatId,
          `Failed to create group: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      this.sessionMapper.unmarkCreating(conversationId);
    }
  }

  // ============================================================================
  // Bot Menu Event Handling
  // ============================================================================

  private async handleBotMenuEvent(event: FeishuBotMenuEvent): Promise<void> {
    const eventKey = event.event_key;
    const openId = event.operator?.operator_id?.open_id;

    this.channelLog.info(`Bot menu event: key=${eventKey}, operator=${openId}, raw=${JSON.stringify(event).slice(0, 200)}`);

    if (!eventKey || !openId) return;

    // Resolve chat_id: try cached P2P mapping, otherwise send via open_id
    const chatId = this.sessionMapper.getChatIdByOpenId(openId);
    const receiveIdType = chatId ? "chat_id" : "open_id";
    const receiveId = chatId || openId;

    switch (eventKey) {
      case "switch_project": {
        await this.showProjectListFromMenu(openId, chatId, receiveId, receiveIdType);
        break;
      }

      case "new_session": {
        if (chatId) {
          const p2pState = this.sessionMapper.getP2PChat(chatId);
          const lastProject = p2pState?.lastSelectedProject;
          if (lastProject && this.gatewayClient) {
            const projectName =
              lastProject.directory.split(/[\\/]/).pop() || lastProject.directory;
            await this.createNewSessionForProject(chatId, openId, lastProject, projectName);
            return;
          }
        }
        await this.showProjectListFromMenu(openId, chatId, receiveId, receiveIdType);
        break;
      }

      case "switch_session": {
        if (chatId) {
          const p2pState = this.sessionMapper.getP2PChat(chatId);
          const lastProject = p2pState?.lastSelectedProject;
          if (lastProject && this.gatewayClient) {
            const projectName =
              lastProject.directory.split(/[\\/]/).pop() || lastProject.directory;
            await this.showSessionListForProject(chatId, lastProject, projectName);
            return;
          }
        }
        await this.showProjectListFromMenu(openId, chatId, receiveId, receiveIdType);
        break;
      }

      case "help": {
        await this.transport!.sendMessageTo(
          receiveId,
          receiveIdType,
          "text",
          JSON.stringify({ text: buildHelpText(P2P_CAPABILITIES) }),
        );
        break;
      }

      default:
        this.channelLog.warn(`Unknown bot menu event_key: ${eventKey}`);
    }
  }

  // ============================================================================
  // Group Lifecycle Events
  // ============================================================================

  private async handleGroupDisbanded(event: FeishuChatDisbandedEvent): Promise<void> {
    await this.cleanupGroupResources(event.chat_id, "Group disbanded");
  }

  private async handleBotRemovedFromGroup(event: FeishuBotRemovedEvent): Promise<void> {
    await this.cleanupGroupResources(event.chat_id, "Bot removed from group");
  }

  private async handleUserRemovedFromGroup(event: FeishuUserRemovedEvent): Promise<void> {
    const chatId = event.chat_id;
    if (!chatId) return;

    const binding = this.sessionMapper.getGroupBinding(chatId);
    if (!binding) return;

    // Clean up when the group owner leaves — no human user remains
    const removedOpenIds = (event.users ?? []).map(u => u.user_id?.open_id).filter(Boolean);
    if (removedOpenIds.includes(binding.ownerOpenId)) {
      await this.cleanupGroupResources(chatId, "Owner left group");
    }
  }

  private async cleanupGroupResources(chatId: string | undefined, reason: string): Promise<void> {
    if (!chatId) return;

    this.channelLog.info(`${reason}: ${chatId}`);
    const binding = this.sessionMapper.removeGroupBinding(chatId);
    if (binding && this.gatewayClient) {
      try {
        await this.gatewayClient.deleteSession(binding.conversationId);
        this.channelLog.info(`Deleted session ${binding.conversationId} after ${reason}`);
      } catch (err) {
        this.channelLog.error(`Failed to delete session ${binding.conversationId}:`, err);
      }
    }
  }

  // ============================================================================
  // Send Message to Engine
  // ============================================================================

  private async sendToEngine(
    groupChatId: string,
    binding: GroupBinding,
    text: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport || !this.streamingController) return;

    // In streaming mode: send placeholder; in batch mode: skip it
    let platformMsgId = "";
    if (!this.streamingController.isBatchMode) {
      platformMsgId = await this.transport.sendText(groupChatId, "🤔 思考中...");
      if (!platformMsgId) {
        this.channelLog.error("Failed to send initial thinking message");
        return;
      }
    }

    // Register streaming session IMMEDIATELY with placeholder key.
    // This avoids the race condition where gateway notifications arrive
    // before sendMessage() resolves (which would cause all updates to be dropped).
    const placeholderKey = `pending_${Date.now()}`;
    const streamingSession = createStreamingSession(groupChatId, binding.conversationId, platformMsgId);
    this.sessionMapper.registerStreamingSession(groupChatId, placeholderKey, streamingSession);

    // Send message to engine via Gateway (non-blocking)
    const sendPromise = this.gatewayClient.sendMessage({
      sessionId: binding.conversationId,
      content: [{ type: "text", text }],
    });

    sendPromise
      .then((msg) => {
        streamingSession.messageId = msg.id;
        binding.streamingSessions.delete(placeholderKey);
        this.sessionMapper.registerStreamingSession(groupChatId, msg.id, streamingSession);
      })
      .catch((err) => {
        this.channelLog.error("sendMessage failed:", err);
        binding.streamingSessions.delete(placeholderKey);
        if (platformMsgId) {
          this.transport!.updateText(
            platformMsgId,
            `⚠️ 错误：${err instanceof Error ? err.message : String(err)}`,
          );
        } else {
          this.transport!.sendText(
            groupChatId,
            `⚠️ 错误：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
  }

  // ============================================================================
  // Gateway Notification Handlers
  // ============================================================================

  private handlePartUpdated(conversationId: string, part: UnifiedPart): void {
    if (!this.streamingController) return;

    // Try group binding first
    const binding = this.sessionMapper.findGroupByConversationId(conversationId);
    if (binding) {
      // Find the active (non-completed) streaming session
      let streaming: StreamingSession | undefined;
      for (const ss of binding.streamingSessions.values()) {
        if (ss.conversationId === conversationId && !ss.completed) {
          streaming = ss;
          break;
        }
      }
      if (streaming) {
        this.streamingController.applyPart(streaming, part);
      }
      return;
    }

    // Try P2P temp session
    const p2pChatId = this.sessionMapper.findP2PChatByTempConversation(conversationId);
    if (p2pChatId) {
      const tempSession = this.sessionMapper.getTempSession(p2pChatId);
      if (tempSession?.streamingSession && !tempSession.streamingSession.completed) {
        this.streamingController.applyPart(tempSession.streamingSession, part);
      }
    }
  }

  private handleMessageCompleted(conversationId: string, message: UnifiedMessage): void {
    if (message.role !== "assistant") return;
    if (!message.time?.completed) return;

    // Try group binding first
    const binding = this.sessionMapper.findGroupByConversationId(conversationId);
    if (binding) {
      this.finalizeGroupStreaming(binding, conversationId, message);
      return;
    }

    // Try P2P temp session
    const p2pChatId = this.sessionMapper.findP2PChatByTempConversation(conversationId);
    if (p2pChatId) {
      void this.finalizeP2PStreaming(p2pChatId, message);
    }
  }

  /** Finalize streaming for a group binding */
  private finalizeGroupStreaming(
    binding: GroupBinding,
    conversationId: string,
    message: UnifiedMessage,
  ): void {
    let streaming = binding.streamingSessions.get(message.id);
    let streamingKey = message.id;

    if (!streaming) {
      for (const [key, ss] of binding.streamingSessions.entries()) {
        if (ss.conversationId === conversationId && !ss.completed) {
          streaming = ss;
          streamingKey = key;
          break;
        }
      }
    }

    if (!streaming || !this.streamingController) return;

    this.streamingController.finalize(streaming, message);
    binding.streamingSessions.delete(streamingKey);
  }

  /** Finalize streaming for a P2P temp session and process next queued message */
  private async finalizeP2PStreaming(chatId: string, message: UnifiedMessage): Promise<void> {
    const tempSession = this.sessionMapper.getTempSession(chatId);
    if (!tempSession?.streamingSession || !this.streamingController) return;

    const streaming = tempSession.streamingSession;
    this.streamingController.finalize(streaming, message);

    tempSession.lastActiveAt = Date.now();
    tempSession.streamingSession = undefined;

    // Process next queued message
    await this.processP2PQueue(chatId);
  }

  private handlePermissionAsked(permission: UnifiedPermission): void {
    // Try group binding
    const binding = this.sessionMapper.findGroupByConversationId(permission.sessionId);

    // Also try P2P temp session (permissions apply regardless of chat type)
    if (!binding) {
      const p2pChatId = this.sessionMapper.findP2PChatByTempConversation(permission.sessionId);
      if (!p2pChatId) return;
    }

    if (!this.config.autoApprovePermissions || !this.gatewayClient) return;

    // Auto-approve: find the first accept-type option
    const acceptOption = permission.options?.find(
      (o: any) =>
        o.type?.includes("accept") ||
        o.type?.includes("allow") ||
        o.label?.toLowerCase().includes("allow"),
    );

    if (acceptOption) {
      this.channelLog.info(`Auto-approving permission: ${permission.id}`);
      this.gatewayClient.replyPermission({
        permissionId: permission.id,
        optionId: acceptOption.id,
      });
    }
  }

  private handleQuestionAsked(question: UnifiedQuestion): void {
    // Try group binding first
    let targetChatId = this.sessionMapper.findGroupChatIdByConversationId(question.sessionId);

    // Fallback to P2P temp session
    if (!targetChatId) {
      targetChatId = this.sessionMapper.findP2PChatByTempConversation(question.sessionId);
    }
    if (!targetChatId) return;

    // For plan review questions (ExitPlanMode), flush the streaming text so
    // the user can see the full plan content before deciding to approve/reject.
    if (question.questions?.[0]?.header === "Plan Review" && this.streamingController) {
      const binding = this.sessionMapper.findGroupByConversationId(question.sessionId);
      if (binding) {
        for (const ss of binding.streamingSessions.values()) {
          if (ss.conversationId === question.sessionId && !ss.completed && ss.textBuffer) {
            void this.streamingController.flushAsIntermediateReply(ss);
            break;
          }
        }
      } else {
        // Try P2P temp session
        const p2pChatId = this.sessionMapper.findP2PChatByTempConversation(question.sessionId);
        if (p2pChatId) {
          const tempSession = this.sessionMapper.getTempSession(p2pChatId);
          if (tempSession?.streamingSession && !tempSession.streamingSession.completed && tempSession.streamingSession.textBuffer) {
            void this.streamingController.flushAsIntermediateReply(tempSession.streamingSession);
          }
        }
      }
    }

    // UnifiedQuestion has questions: QuestionInfo[], each with question text and options
    if (question.questions && question.questions.length > 0) {
      const q = question.questions[0]; // Handle first question
      const options = q.options.map((o, i) => ({ id: String(i), label: o.label || o.description }));
      const text = buildQuestionText(
        q.question || "Agent 有一个问题：",
        options,
      );
      this.transport!.sendText(targetChatId, text);

      // Store pending question so the next reply is routed as an answer
      this.sessionMapper.setPendingQuestion(targetChatId, {
        questionId: question.id,
        sessionId: question.sessionId,
      });
    } else {
      this.transport!.sendText(targetChatId, "📋 Agent 提问（无选项）");
    }
  }

  private async handleSessionUpdated(session: import("../../../../src/types/unified").UnifiedSession): Promise<void> {
    if (!this.larkClient) return;

    // Check if this session has a bound group chat
    const groupChatId = this.sessionMapper.findGroupChatIdByConversationId(session.id);
    if (!groupChatId) return;

    const binding = this.sessionMapper.getGroupBinding(groupChatId);
    if (!binding) return;

    // Skip group name update if the event carries no title (e.g. Claude engine
    // emits session.updated solely to sync engineMeta/ccSessionId, without a
    // title field — blindly falling back to "New Session" would overwrite any
    // meaningful title that was already set).
    if (!session.title) return;

    // Update streaming session titles for any active streams
    for (const ss of binding.streamingSessions.values()) {
      if (!ss.completed) {
        ss.sessionTitle = session.title;
      }
    }

    // Derive the project name from directory
    const projectName = binding.directory.split(/[\\/]/).pop() || binding.directory;

    // Build the expected group name
    const expectedGroupName = `[${projectName}] ${session.title}`;

    // Update the Feishu group chat name
    try {
      await this.rateLimiter.consume();
      await this.larkClient.im.chat.update({
        path: { chat_id: groupChatId },
        data: { name: expectedGroupName },
      });
      this.channelLog.info(`Updated group chat name: ${groupChatId} → "${expectedGroupName}"`);
    } catch (err) {
      this.channelLog.error(`Failed to update group chat name for ${groupChatId}:`, err);
    }
  }
}
