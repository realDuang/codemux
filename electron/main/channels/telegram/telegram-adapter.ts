// ============================================================================
// Telegram Channel Adapter
// Connects a Telegram bot to CodeMux via Gateway WebSocket.
// Architecture: P2P (private chat) is primary, group chats supported when
// bot is added to an existing group by the user.
//
// Telegram specifics:
//   - Bot API via HTTPS: https://api.telegram.org/bot<token>/METHOD
//   - Webhook (production) or Long Polling (dev fallback)
//   - sendMessage: max 4096 chars, MarkdownV2/HTML
//   - editMessageText: update bot's own messages (streaming)
//   - sendMessageDraft: Bot API 9.3+ native streaming (private chats)
//   - InlineKeyboardMarkup for buttons (permissions/questions)
//   - Callback queries for button clicks
//   - Rate limit: 30 msgs/sec (free tier)
//   - Bot CANNOT create groups — binds to existing group chats
// ============================================================================

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
import { BaseSessionMapper } from "../base-session-mapper";
import { createStreamingSession, type StreamingSession } from "../streaming/streaming-types";
import { TelegramTransport } from "./telegram-transport";
import { TelegramRenderer } from "./telegram-renderer";
import { didConfigValuesChange, mergeDefinedConfig } from "../config-utils";
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
import { handleSessionOpsCommand, type SessionContext } from "../shared/session-commands";
import {
  DEFAULT_TELEGRAM_CONFIG,
  TEMP_SESSION_TTL_MS,
  type TelegramConfig,
  type TelegramGroupBinding,
  type TelegramTempSession,
  type TelegramPendingSelection,
  type TelegramUpdate,
  type TelegramMessage,
  type TelegramCallbackQuery,
} from "./telegram-types";
import type {
  EngineType,
  UnifiedPart,
  UnifiedMessage,
  UnifiedPermission,
  UnifiedQuestion,
} from "../../../../src/types/unified";
import { channelLog } from "../../services/logger";
import type { WebhookServer, WebhookRequest, WebhookResponse } from "../webhook-server";

const LOG_PREFIX = "[Telegram]";

// ============================================================================
// Telegram Session Mapper (uses BaseSessionMapper with TelegramGroupBinding)
// ============================================================================

class TelegramSessionMapper extends BaseSessionMapper<TelegramGroupBinding> {
  constructor() {
    super("telegram");
  }
}

// ============================================================================
// Telegram Adapter
// ============================================================================

export class TelegramAdapter extends ChannelAdapter {
  readonly channelType = "telegram";

  // --- State ---
  private status: ChannelStatus = "stopped";
  private error?: string;
  private config: TelegramConfig = { ...DEFAULT_TELEGRAM_CONFIG };

  // --- Internal ---
  private gatewayClient: GatewayWsClient | null = null;
  private sessionMapper = new TelegramSessionMapper();
  // Telegram: 30 msgs/sec free tier, allow bursts of 10
  private rateLimiter = new TokenBucket(10, 30);

  // --- Streaming Architecture ---
  private transport: TelegramTransport | null = null;
  private renderer = new TelegramRenderer();
  private streamingController: StreamingController | null = null;

  // --- Webhook / Polling ---
  private webhookServer: WebhookServer | null = null;
  private pollingActive = false;
  private pollingOffset = 0;
  private pollingAbortController: AbortController | null = null;
  private pollingLoopPromise: Promise<void> | null = null;
  private pollingGeneration = 0;
  private botUsername = "";

  /**
   * Telegram capabilities:
   *   - supportsMessageUpdate: true (editMessageText for bot's own messages)
   *   - supportsMessageDelete: true (deleteMessage for bot's own messages)
   *   - supportsRichContent: true (InlineKeyboard buttons)
   *   - maxMessageBytes: ~16KB (4096 chars × ~4 bytes)
   */
  private static readonly CAPABILITIES: ChannelCapabilities = {
    supportsMessageUpdate: true,
    supportsMessageDelete: true,
    supportsRichContent: true,
    maxMessageBytes: 16_384,
  };
  private static readonly POLLING_RETRY_DELAY_MS = 5_000;

  private isAbortError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "name" in error
      && (error as { name?: unknown }).name === "AbortError";
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async start(config: ChannelConfig): Promise<void> {
    if (this.status === "running") {
      channelLog.warn(`${LOG_PREFIX} Adapter already running, stopping first`);
      await this.stop();
    }

    this.status = "starting";
    this.error = undefined;
    this.emit("status.changed", this.status);

    // Merge config
    this.config = mergeDefinedConfig(
      DEFAULT_TELEGRAM_CONFIG,
      config.options as Partial<TelegramConfig> | undefined,
    );
    this.botUsername = "";

    if (!this.config.botToken) {
      this.status = "error";
      this.error = "Missing botToken";
      this.emit("status.changed", this.status);
      throw new Error("Telegram botToken is required");
    }

    try {
      // 1. Create transport and streaming controller
      this.transport = new TelegramTransport(this.config.botToken, this.rateLimiter);
      this.streamingController = new StreamingController(
        this.transport,
        this.renderer,
        { throttleMs: this.config.streamingThrottleMs },
        TelegramAdapter.CAPABILITIES,
      );

      // 2. Get bot info (username for @mention detection in groups)
      const botInfo = await this.transport.getMe();
      if (botInfo?.username) {
        this.botUsername = botInfo.username;
        channelLog.info(`${LOG_PREFIX} Bot username: @${this.botUsername}`);
      }

      // 3. Connect to local Gateway
      this.gatewayClient = new GatewayWsClient(this.config.gatewayUrl);
      await this.gatewayClient.connect();
      channelLog.info(`${LOG_PREFIX} Gateway WS client connected`);

      // 4. Restore persisted group bindings from disk
      this.sessionMapper.loadBindings();

      // 5. Subscribe to Gateway notifications
      this.subscribeGatewayEvents();

      // 6. Set up update receiving (webhook or long polling)
      if (this.config.webhookUrl) {
        await this.setupWebhook();
      } else {
        await this.startLongPolling();
      }

      this.status = "running";
      this.emit("status.changed", this.status);
      this.emit("connected");
      channelLog.info(`${LOG_PREFIX} Adapter started successfully`);
    } catch (err) {
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.emit("status.changed", this.status);
      channelLog.error(`${LOG_PREFIX} Failed to start adapter:`, err);
      // Clean up partial init
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
    channelLog.info(`${LOG_PREFIX} Stopping adapter...`);

    // Stop polling
    await this.stopPolling();

    // Unregister webhook route (keep webhookServer ref for restart)
    if (this.webhookServer) {
      this.webhookServer.unregisterRoute("/webhook/telegram");
    }

    // Delete webhook from Telegram servers
    if (this.transport && this.config.webhookUrl) {
      await this.transport.deleteWebhook().catch(() => {});
    }

    // Clean up streaming timers
    this.sessionMapper.cleanup();

    // Disconnect Gateway WS
    if (this.gatewayClient) {
      this.gatewayClient.disconnect();
      this.gatewayClient = null;
    }

    // Clean up instances
    this.transport = null;
    this.streamingController = null;
    this.botUsername = "";

    this.status = "stopped";
    this.error = undefined;
    this.emit("status.changed", this.status);
    this.emit("disconnected", "stopped");
    channelLog.info(`${LOG_PREFIX} Adapter stopped`);
  }

  getInfo(): ChannelInfo {
    return {
      type: this.channelType,
      name: "Telegram Bot",
      status: this.status,
      error: this.error,
      stats: {
        botUsername: this.botUsername,
        mode: this.config.webhookUrl ? "webhook" : "polling",
      },
    };
  }

  async updateConfig(config: Partial<ChannelConfig>): Promise<void> {
    const wasRunning = this.status === "running";
    const newOptions = config.options as Partial<TelegramConfig> | undefined;
    const previousConfig = { ...this.config };

    if (newOptions) {
      this.config = mergeDefinedConfig(this.config, newOptions);
    }

    const shouldRestart = wasRunning && didConfigValuesChange(
      previousConfig,
      this.config,
      ["botToken", "webhookUrl", "webhookSecretToken"],
    );

    if (shouldRestart) {
      channelLog.info(`${LOG_PREFIX} Bot connection settings changed, restarting adapter`);
      await this.stop();
      const fullConfig: ChannelConfig = {
        type: "telegram",
        name: "Telegram Bot",
        enabled: true,
        options: this.config as unknown as Record<string, unknown>,
      };
      await this.start(fullConfig);
    }
  }

  /** Set the WebhookServer instance (called by ChannelManager) */
  setWebhookServer(server: WebhookServer): void {
    this.webhookServer = server;
  }

  // ============================================================================
  // Webhook Setup
  // ============================================================================

  private async setupWebhook(): Promise<void> {
    if (!this.transport || !this.config.webhookUrl) return;

    // Register webhook route on the shared WebhookServer
    if (this.webhookServer) {
      this.webhookServer.registerRoute("/webhook/telegram", (req) =>
        this.handleWebhookRequest(req),
      );
    }

    // Tell Telegram to send updates to our webhook URL
    const success = await this.transport.setWebhook(
      this.config.webhookUrl,
      this.config.webhookSecretToken,
    );

    if (!success) {
      throw new Error("Failed to set Telegram webhook");
    }

    channelLog.info(`${LOG_PREFIX} Webhook set to ${this.config.webhookUrl}`);
  }

  private async handleWebhookRequest(req: WebhookRequest): Promise<WebhookResponse> {
    // Verify secret token if configured
    if (this.config.webhookSecretToken) {
      const headerToken = req.headers["x-telegram-bot-api-secret-token"];
      if (headerToken !== this.config.webhookSecretToken) {
        return { status: 403, body: "Forbidden" };
      }
    }

    if (req.method !== "POST") {
      return { status: 405, body: "Method Not Allowed" };
    }

    const update = req.body as TelegramUpdate;
    if (update) {
      // Process asynchronously, respond immediately
      void this.processUpdate(update);
    }

    return { status: 200, body: "OK" };
  }

  // ============================================================================
  // Long Polling
  // ============================================================================

  private async startLongPolling(): Promise<void> {
    if (!this.transport) return;

    // Delete any existing webhook to enable polling
    await this.transport.deleteWebhook();

    this.pollingActive = true;
    this.pollingOffset = 0;
    const generation = ++this.pollingGeneration;
    const abortController = new AbortController();
    this.pollingAbortController = abortController;

    channelLog.info(`${LOG_PREFIX} Starting long polling...`);

    // Start polling loop (non-blocking)
    const pollingLoopPromise = this.pollingLoop(generation, abortController.signal);
    const trackedPollingLoopPromise = pollingLoopPromise.finally(() => {
      if (this.pollingLoopPromise === trackedPollingLoopPromise) {
        this.pollingLoopPromise = null;
      }
      if (this.pollingAbortController === abortController) {
        this.pollingAbortController = null;
      }
    });
    this.pollingLoopPromise = trackedPollingLoopPromise;
  }

  private async stopPolling(): Promise<void> {
    this.pollingActive = false;
    this.pollingGeneration += 1;
    this.pollingAbortController?.abort();
    this.pollingAbortController = null;

    const pollingLoopPromise = this.pollingLoopPromise;
    this.pollingLoopPromise = null;

    if (!pollingLoopPromise) {
      return;
    }

    try {
      await pollingLoopPromise;
    } catch (error) {
      if (!this.isAbortError(error)) {
        channelLog.warn(`${LOG_PREFIX} Polling loop exited with an unexpected error during shutdown:`, error);
      }
    }
  }

  private async pollingLoop(generation: number, signal: AbortSignal): Promise<void> {
    while (this.pollingActive && this.transport && generation === this.pollingGeneration) {
      try {
        const updates = await this.transport.getUpdates(
          this.pollingOffset || undefined,
          30,
          signal,
        );

        if (!this.pollingActive || generation !== this.pollingGeneration) {
          break;
        }

        for (const update of updates) {
          if (!this.pollingActive || generation !== this.pollingGeneration) {
            break;
          }
          void this.processUpdate(update as TelegramUpdate);
          this.pollingOffset = (update as TelegramUpdate).update_id + 1;
        }
      } catch (err) {
        if (this.isAbortError(err) || !this.pollingActive || generation !== this.pollingGeneration) {
          break;
        }
        channelLog.error(`${LOG_PREFIX} Polling error:`, err);
        // Wait before retrying on error
        await new Promise((resolve) => setTimeout(resolve, TelegramAdapter.POLLING_RETRY_DELAY_MS));
        if (!this.pollingActive || generation !== this.pollingGeneration) {
          break;
        }
      }
    }
  }

  // ============================================================================
  // Update Processing
  // ============================================================================

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      await this.handleTelegramMessage(update.message);
    } else if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }

  private async handleTelegramMessage(message: TelegramMessage): Promise<void> {
    const { message_id, from, chat, text } = message;

    // Skip messages without text or from bots
    if (!text || !from || from.is_bot) return;

    // Deduplication
    const dedupKey = `${chat.id}:${message_id}`;
    if (this.sessionMapper.isDuplicate(dedupKey)) {
      channelLog.verbose(`${LOG_PREFIX} Skipping duplicate message: ${dedupKey}`);
      return;
    }

    const chatId = String(chat.id);
    const userId = String(from.id);
    const displayName = from.first_name + (from.username ? ` (@${from.username})` : "");

    channelLog.info(
      `${LOG_PREFIX} Message from ${chat.type} ` +
      `(${displayName}): ${text.slice(0, 100)}`,
    );

    if (chat.type === "private") {
      // Private (P2P) message
      const p2p = this.sessionMapper.getOrCreateP2PChat(chatId, userId);
      (p2p as any).displayName = displayName;
      this.sessionMapper.setUserIdMapping(userId, chatId);
      await this.handleP2PMessage(chatId, userId, text);
    } else if (chat.type === "group" || chat.type === "supergroup") {
      // Group message — only process if bot is mentioned or it's a command
      if (this.isBotMentioned(message) || text.startsWith("/")) {
        const content = this.stripBotMention(text);
        await this.handleGroupMessage(chatId, content);
      }
    }
  }

  /**
   * Check if the bot is mentioned in a message (via @username or bot_command entity).
   */
  private isBotMentioned(message: TelegramMessage): boolean {
    if (!message.entities || !this.botUsername) return false;

    for (const entity of message.entities) {
      if (entity.type === "mention" && message.text) {
        const mention = message.text.slice(entity.offset, entity.offset + entity.length);
        if (mention.toLowerCase() === `@${this.botUsername.toLowerCase()}`) {
          return true;
        }
      }
      if (entity.type === "bot_command") {
        return true;
      }
    }
    return false;
  }

  /**
   * Strip bot @mention from message text.
   */
  private stripBotMention(text: string): string {
    if (!this.botUsername) return text;
    return text
      .replace(new RegExp(`@${this.botUsername}\\b`, "gi"), "")
      .trim();
  }

  // ============================================================================
  // Callback Query Handling (Button Clicks)
  // ============================================================================

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    if (!query.data || !this.transport || !this.gatewayClient) return;

    const chatId = query.message?.chat?.id ? String(query.message.chat.id) : "";
    if (!chatId) return;

    // Acknowledge the callback query
    await this.transport.answerCallbackQuery(query.id);

    // Parse callback data (format: "action:param1:param2")
    const parts = query.data.split(":");
    const action = parts[0];

    switch (action) {
      case "perm": {
        // Permission reply: "perm:permissionId:optionId"
        const [, permissionId, optionId] = parts;
        if (permissionId && optionId) {
          await this.gatewayClient.replyPermission({
            permissionId,
            optionId,
          });
          channelLog.info(`${LOG_PREFIX} Permission ${permissionId} replied via button: ${optionId}`);
        }
        break;
      }
      case "question": {
        // Question reply: "question:questionId:answerText"
        const questionId = parts[1];
        const answer = parts.slice(2).join(":");
        if (questionId && answer) {
          this.sessionMapper.clearPendingQuestion(chatId);
          await this.gatewayClient.replyQuestion({
            questionId,
            answers: [[answer]],
          });
          channelLog.info(`${LOG_PREFIX} Question ${questionId} replied via button`);
        }
        break;
      }
      default:
        channelLog.verbose(`${LOG_PREFIX} Unknown callback action: ${action}`);
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

    // Permission requests
    this.gatewayClient.on("permission.asked", (data) => {
      this.handlePermissionAsked(data.permission);
    });

    // Question requests
    this.gatewayClient.on("question.asked", (data) => {
      this.handleQuestionAsked(data.question);
    });

    // Session title updates
    this.gatewayClient.on("session.updated", (data) => {
      this.handleSessionUpdated(data.session);
    });
  }

  // ============================================================================
  // P2P Message Handling (Primary Interaction Mode)
  // ============================================================================

  private async handleP2PMessage(chatId: string, userId: string, text: string): Promise<void> {
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
      channelLog.info(`${LOG_PREFIX} Replied to question ${pendingQ.questionId} with freeform answer`);
      return;
    }

    // 3. Check for pending selection (number reply or "new")
    const pending = this.sessionMapper.getPendingSelection(chatId);
    if (pending) {
      const handled = await this.handlePendingSelection(chatId, userId, text, pending);
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

  /** /new — create a new session under the last selected project. */
  private async handleP2PNewCommand(chatId: string): Promise<void> {
    if (!this.transport) return;
    const p2pState = this.sessionMapper.getP2PChat(chatId);
    if (!p2pState?.lastSelectedProject) {
      await this.transport.sendText(
        chatId,
        "📋 当前未选择项目。请先使用 /project 选择项目。",
      );
      return;
    }
    if (this.sessionMapper.getTempSession(chatId)) {
      await this.cleanupExpiredTempSession(chatId);
    }
    const project = p2pState.lastSelectedProject;
    const projectName = project.directory.split(/[\\/]/).pop() || project.directory;
    await this.createNewSessionForProject(chatId, project, projectName);
  }

  /** /switch — list existing sessions in the last selected project. */
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
    const projects = allProjects.filter(p => !p.isDefault);

    if (projects.length > 0) {
      await this.transport!.sendText(chatId, buildProjectListText(projects));
      const flatProjects = this.flattenProjectsByEngine(projects);
      this.sessionMapper.setPendingSelection(chatId, {
        type: "project",
        projects: flatProjects,
      });
    } else {
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

  /** Create a new session for a project (P2P temp session — no group creation) */
  private async createNewSessionForProject(
    chatId: string,
    project: { directory: string; engineType?: EngineType; projectId: string },
    projectName: string,
  ): Promise<void> {
    if (!this.gatewayClient) return;
    try {
      const session = await this.gatewayClient.createSession({
        engineType: project.engineType,
        directory: project.directory,
      });

      const tempSession: TelegramTempSession = {
        conversationId: session.id,
        engineType: session.engineType,
        directory: project.directory,
        projectId: project.projectId,
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: false,
      };

      this.sessionMapper.setTempSession(chatId, tempSession);

      await this.transport!.sendText(
        chatId,
        buildSessionNotification(projectName, session.engineType, session.id),
      );
    } catch (err) {
      await this.transport!.sendText(
        chatId,
        `📋 创建会话失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ============================================================================
  // P2P Temp Session Methods
  // ============================================================================

  /** Check if a temp session has expired (2h since last activity) */
  private isTempSessionExpired(temp: TelegramTempSession): boolean {
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

      const tempSession: TelegramTempSession = {
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

  /** Send a message to the engine via a P2P temp session */
  private async sendToEngineP2P(
    chatId: string,
    tempSession: TelegramTempSession,
    text: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport || !this.streamingController) {
      tempSession.processing = false;
      channelLog.error(`${LOG_PREFIX} Gateway client not connected, cannot send P2P message`);
      return;
    }

    tempSession.lastActiveAt = Date.now();

    // Telegram supports message update → streaming mode
    // Send "thinking..." placeholder
    const placeholderText = this.renderer.renderStreamingUpdate("");
    const platformMsgId = await this.transport.sendText(chatId, placeholderText);
    const compoundId = platformMsgId
      ? this.transport.composeMessageId(chatId, platformMsgId)
      : "";

    const streaming = createStreamingSession(chatId, tempSession.conversationId, compoundId);
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
        channelLog.error(`${LOG_PREFIX} P2P sendMessage failed:`, err);
        tempSession.streamingSession = undefined;
        this.transport!.sendText(
          chatId,
          `⚠️ 错误：${err instanceof Error ? err.message : String(err)}`,
        );
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
      channelLog.info(`${LOG_PREFIX} Deleted expired temp session: ${temp.conversationId}`);
    } catch {
      // Ignore deletion failures for temp sessions
    }
    this.sessionMapper.clearTempSession(chatId);
  }

  /** Return projects in display order (same order as buildProjectListText) */
  private flattenProjectsByEngine(
    projects: import("../../../../src/types/unified").UnifiedProject[],
  ): import("../../../../src/types/unified").UnifiedProject[] {
    return projects;
  }

  /** Handle a pending selection reply (number or "new") */
  private async handlePendingSelection(
    chatId: string,
    userId: string,
    text: string,
    pending: TelegramPendingSelection,
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
    pending: TelegramPendingSelection,
  ): Promise<boolean> {
    // Empty project list — clear stale pending state before re-fetching
    if (!pending.projects || pending.projects.length === 0) {
      this.sessionMapper.clearPendingSelection(chatId);
      await this.showProjectList(chatId);
      return true;
    }

    const num = parseInt(text.trim(), 10);
    if (isNaN(num) || num < 1 || num > pending.projects.length) {
      return false;
    }

    const project = pending.projects[num - 1];
    const projectName = project.name || project.directory.split(/[\\/]/).pop() || project.directory;

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
    pending: TelegramPendingSelection,
  ): Promise<boolean> {
    const trimmed = text.trim().toLowerCase();
    if (!pending.directory || !pending.projectId) {
      return false;
    }

    const num = parseInt(trimmed, 10);
    if (isNaN(num) || num < 1 || !pending.sessions || num > pending.sessions.length) {
      return false;
    }

    const session = pending.sessions[num - 1];
    this.sessionMapper.clearPendingSelection(chatId);

    // Bind the selected session as a temp session for P2P
    const tempSession: TelegramTempSession = {
      conversationId: session.id,
      engineType: session.engineType,
      directory: pending.directory,
      projectId: pending.projectId,
      lastActiveAt: Date.now(),
      messageQueue: [],
      processing: false,
    };

    this.sessionMapper.setTempSession(chatId, tempSession);
    const projectName = pending.projectName || pending.directory?.split(/[\\/]/).pop() || "";
    await this.transport!.sendText(
      chatId,
      buildSessionNotification(projectName, session.engineType, session.id),
    );
    return true;
  }

  // ============================================================================
  // Group Message Handling
  // ============================================================================

  private async handleGroupMessage(groupChatId: string, text: string): Promise<void> {
    const binding = this.sessionMapper.getGroupBinding(groupChatId);

    if (!binding) {
      // No binding yet — show help on how to bind
      const command = parseCommand(text);
      if (command?.command === "help") {
        await this.transport!.sendText(
          groupChatId,
          buildHelpText(GROUP_CAPABILITIES, { requiresMention: true }),
        );
      } else if (command?.command === "bind") {
        // /bind — show project list for group binding
        await this.showGroupProjectList(groupChatId);
      } else {
        await this.transport!.sendText(
          groupChatId,
          "📋 此群聊未绑定到 CodeMux 会话。使用 /bind 绑定项目。",
        );
      }
      return;
    }

    const command = parseCommand(text);
    if (command) {
      await this.handleGroupCommand(groupChatId, binding, command);
      return;
    }

    // Check for pending question
    const pendingQ = this.sessionMapper.getPendingQuestion(groupChatId);
    if (pendingQ && this.gatewayClient) {
      this.sessionMapper.clearPendingQuestion(groupChatId);
      await this.gatewayClient.replyQuestion({
        questionId: pendingQ.questionId,
        answers: [[text]],
      });
      channelLog.info(`${LOG_PREFIX} Replied to question ${pendingQ.questionId} with freeform answer`);
      return;
    }

    // Regular message → send to engine
    await this.sendToEngine(groupChatId, binding, text);
  }

  /** Show project list for group binding selection */
  private async showGroupProjectList(groupChatId: string): Promise<void> {
    if (!this.gatewayClient) return;

    const projects = await this.gatewayClient.listAllProjects();
    const text = buildProjectListText(projects);
    await this.transport!.sendText(groupChatId, text);

    if (projects.length > 0) {
      const flatProjects = this.flattenProjectsByEngine(projects);
      this.sessionMapper.setPendingSelection(groupChatId, {
        type: "project",
        projects: flatProjects,
      });
    }
  }

  private async handleGroupCommand(
    groupChatId: string,
    binding: TelegramGroupBinding,
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
          buildHelpText(GROUP_CAPABILITIES, { requiresMention: true }),
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
  // Send Message to Engine (Group)
  // ============================================================================

  private async sendToEngine(
    groupChatId: string,
    binding: TelegramGroupBinding,
    text: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport || !this.streamingController) return;

    // Telegram supports message update → streaming mode
    // Send "thinking..." placeholder
    const placeholderText = this.renderer.renderStreamingUpdate("");
    const platformMsgId = await this.transport.sendText(groupChatId, placeholderText);
    const compoundId = platformMsgId
      ? this.transport.composeMessageId(groupChatId, platformMsgId)
      : "";

    const streamingSession = createStreamingSession(
      groupChatId,
      binding.conversationId,
      compoundId,
    );

    // Register with placeholder key, re-key when messageId is known
    const placeholderKey = `pending_${Date.now()}`;
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
        channelLog.error(`${LOG_PREFIX} sendMessage failed:`, err);
        binding.streamingSessions.delete(placeholderKey);
        this.transport!.sendText(
          groupChatId,
          `⚠️ 错误：${err instanceof Error ? err.message : String(err)}`,
        );
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
    binding: TelegramGroupBinding,
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
    // Check both group binding and P2P temp session
    const binding = this.sessionMapper.findGroupByConversationId(permission.sessionId);
    const p2pChatId = this.sessionMapper.findP2PChatByTempConversation(permission.sessionId);
    const targetChatId = binding?.chatId || p2pChatId;

    if (!targetChatId) return;

    if (this.config.autoApprovePermissions && this.gatewayClient) {
      const acceptOption = permission.options?.find(
        (o: any) =>
          o.type?.includes("accept") ||
          o.type?.includes("allow") ||
          o.label?.toLowerCase().includes("allow"),
      );

      if (acceptOption) {
        channelLog.info(`${LOG_PREFIX} Auto-approving permission: ${permission.id}`);
        this.gatewayClient.replyPermission({
          permissionId: permission.id,
          optionId: acceptOption.id,
        });
        return;
      }
    }

    // Not auto-approved — send inline keyboard with permission options
    if (!this.transport || !permission.options || permission.options.length === 0) return;

    const keyboard = permission.options.map((o: any) => [
      {
        text: o.label || o.id,
        callback_data: `perm:${permission.id}:${o.id}`,
      },
    ]);

    const permText = `🔐 权限请求\n${permission.title || permission.id}`;
    void this.transport.sendMessageWithKeyboard(targetChatId, permText, keyboard);
  }

  private handleQuestionAsked(question: UnifiedQuestion): void {
    // Try group binding first
    const groupChatId = this.sessionMapper.findGroupByConversationId(question.sessionId)?.chatId;

    // Fallback to P2P temp session
    const targetChatId = groupChatId || this.sessionMapper.findP2PChatByTempConversation(question.sessionId);
    if (!targetChatId || !this.transport) return;

    if (question.questions && question.questions.length > 0) {
      const q = question.questions[0];
      const options = q.options.map((o, i) => ({ id: String(i), label: o.label || o.description }));

      // Send text-based question with inline keyboard buttons
      const questionText = buildQuestionText(
        q.question || "Agent 有一个问题：",
        options,
      );

      // Also provide inline keyboard for quick selection
      const keyboard = options.map((o) => [
        {
          text: o.label,
          callback_data: `question:${question.id}:${o.label}`,
        },
      ]);

      void this.transport.sendMessageWithKeyboard(targetChatId, questionText, keyboard);

      this.sessionMapper.setPendingQuestion(targetChatId, {
        questionId: question.id,
        sessionId: question.sessionId,
      });
    } else {
      void this.transport.sendText(targetChatId, "📋 Agent 提问（无选项）");
    }
  }

  private handleSessionUpdated(
    session: import("../../../../src/types/unified").UnifiedSession,
  ): void {
    // Check if this session has a bound group chat
    const binding = this.sessionMapper.findGroupByConversationId(session.id);
    if (!binding) return;

    // Update streaming session titles for any active streams
    for (const ss of binding.streamingSessions.values()) {
      if (!ss.completed) {
        ss.sessionTitle = session.title;
      }
    }

    channelLog.verbose(
      `${LOG_PREFIX} Session ${session.id} title updated to "${session.title}"`,
    );
  }
}
