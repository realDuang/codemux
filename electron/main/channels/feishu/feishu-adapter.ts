// ============================================================================
// Feishu Channel Adapter
// Connects Feishu (Lark) bot to CodeMux via Gateway WebSocket.
// Architecture: One Group = One Session
// P2P chat = entry point (project selection), Group chat = session interaction.
// ============================================================================

import * as lark from "@larksuiteoapi/node-sdk";
import {
  ChannelAdapter,
  type ChannelConfig,
  type ChannelInfo,
  type ChannelStatus,
} from "../channel-adapter";
import { GatewayWsClient } from "../gateway-ws-client";
import { FeishuSessionMapper } from "./feishu-session-mapper";
import {
  parseCommand,
  buildHelpText,
  buildGroupHelpText,
  buildProjectListText,
  buildSessionListText,
  buildQuestionText,
} from "./feishu-command-parser";
import {
  buildGroupWelcomeCard,
} from "./feishu-card-builder";
import {
  formatStreamingText,
  formatToolSummaryFromCounts,
  truncateForFeishu,
} from "./feishu-message-formatter";
import {
  DEFAULT_FEISHU_CONFIG,
  TEMP_SESSION_TTL_MS,
  type FeishuConfig,
  type StreamingSession,
  type GroupBinding,
  type TempSession,
  type FeishuMessageEvent,
  type FeishuBotMenuEvent,
  type FeishuChatDisbandedEvent,
  type FeishuBotRemovedEvent,
} from "./feishu-types";
import type {
  EngineType,
  UnifiedPart,
  UnifiedMessage,
  UnifiedPermission,
  UnifiedQuestion,
} from "../../../../src/types/unified";
import { feishuLog } from "../../services/logger";

// --- Rate Limiter (Token Bucket) ---

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private capacity: number,
    private refillRate: number, // tokens per second
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  async consume(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait for next token
    const waitMs = ((1 - this.tokens) / this.refillRate) * 1000;
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitMs)));
    this.refill();
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
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

  // --- Lifecycle ---

  async start(config: ChannelConfig): Promise<void> {
    if (this.status === "running") {
      feishuLog.warn("Feishu adapter already running, stopping first");
      await this.stop();
    }

    this.status = "starting";
    this.error = undefined;
    this.emit("status.changed", this.status);

    // Merge config
    this.config = {
      ...DEFAULT_FEISHU_CONFIG,
      ...(config.options as unknown as Partial<FeishuConfig>),
    };

    if (!this.config.appId || !this.config.appSecret) {
      this.status = "error";
      this.error = "Missing appId or appSecret";
      this.emit("status.changed", this.status);
      throw new Error("Feishu appId and appSecret are required");
    }

    try {
      // 1. Create Lark REST client
      this.larkClient = new lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        disableTokenCache: false,
      });

      // 2. Create event dispatcher for receiving messages, card actions, and lifecycle events
      const dispatcher = new lark.EventDispatcher({});
      dispatcher.register({
        "im.message.receive_v1": async (data: unknown) => {
          try {
            await this.handleFeishuMessage(data as FeishuMessageEvent);
          } catch (err) {
            feishuLog.error("Error handling Feishu message:", err);
          }
        },
        "application.bot.menu_v6": async (data: unknown) => {
          try {
            await this.handleBotMenuEvent(data as FeishuBotMenuEvent);
          } catch (err) {
            feishuLog.error("Error handling bot menu event:", err);
          }
        },
        "im.chat.disbanded_v1": async (data: unknown) => {
          try {
            await this.handleGroupDisbanded(data as FeishuChatDisbandedEvent);
          } catch (err) {
            feishuLog.error("Error handling group disbanded event:", err);
          }
        },
        "im.chat.member.bot.deleted_v1": async (data: unknown) => {
          try {
            await this.handleBotRemovedFromGroup(data as FeishuBotRemovedEvent);
          } catch (err) {
            feishuLog.error("Error handling bot removed event:", err);
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
        loggerLevel: lark.LoggerLevel.warn,
      });

      await this.wsClient.start({ eventDispatcher: dispatcher });
      feishuLog.info("Feishu WSClient connected to cloud");

      // 4. Connect to local Gateway
      this.gatewayClient = new GatewayWsClient(this.config.gatewayUrl);
      await this.gatewayClient.connect();
      feishuLog.info("Gateway WS client connected");

      // 5. Restore persisted group bindings from disk
      this.sessionMapper.loadBindings();

      // 6. Subscribe to Gateway notifications
      this.subscribeGatewayEvents();

      this.status = "running";
      this.emit("status.changed", this.status);
      this.emit("connected");
      feishuLog.info("Feishu adapter started successfully");
    } catch (err) {
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.emit("status.changed", this.status);
      feishuLog.error("Failed to start Feishu adapter:", err);
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
    feishuLog.info("Stopping Feishu adapter...");

    // Clean up streaming timers
    this.sessionMapper.cleanup();

    // Disconnect Gateway WS
    if (this.gatewayClient) {
      this.gatewayClient.disconnect();
      this.gatewayClient = null;
    }

    // Disconnect Feishu WSClient
    // Note: lark.WSClient doesn't have a clean stop/close API in all versions.
    // Setting to null allows GC.
    this.wsClient = null;
    this.larkClient = null;

    this.status = "stopped";
    this.error = undefined;
    this.emit("status.changed", this.status);
    this.emit("disconnected", "stopped");
    feishuLog.info("Feishu adapter stopped");
  }

  getInfo(): ChannelInfo {
    return {
      type: this.channelType,
      name: "Feishu Bot",
      status: this.status,
      error: this.error,
    };
  }

  async updateConfig(config: Partial<ChannelConfig>): Promise<void> {
    const wasRunning = this.status === "running";
    const newOptions = config.options as Partial<FeishuConfig> | undefined;

    if (newOptions) {
      this.config = { ...this.config, ...newOptions };
    }

    // If credentials changed while running, restart
    if (wasRunning && newOptions && (newOptions.appId || newOptions.appSecret)) {
      feishuLog.info("Credentials changed, restarting Feishu adapter");
      await this.stop();
      const fullConfig: ChannelConfig = {
        type: "feishu",
        name: "Feishu Bot",
        enabled: true,
        options: this.config as unknown as Record<string, unknown>,
      };
      await this.start(fullConfig);
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
      feishuLog.verbose(`Ignoring non-text message type: ${message_type}`);
      return;
    }

    // Deduplication
    if (this.sessionMapper.isDuplicate(message_id)) {
      feishuLog.verbose(`Skipping duplicate message: ${message_id}`);
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

    feishuLog.info(`Message from ${chat_type} chat ${chat_id}: ${text.slice(0, 100)}`);

    if (chat_type === "p2p") {
      // Record open_id → chat_id mapping for bot menu events
      if (sender?.sender_id?.open_id) {
        this.sessionMapper.setOpenIdMapping(sender.sender_id.open_id, chat_id);
        this.sessionMapper.getOrCreateP2PChat(chat_id, sender.sender_id.open_id);

        // Transfer any pending selection stored by openId (from bot menu before first message)
        const pendingByOpenId = this.sessionMapper.takePendingSelectionByOpenId(sender.sender_id.open_id);
        if (pendingByOpenId) {
          this.sessionMapper.setPendingSelection(chat_id, pendingByOpenId);
          feishuLog.info(`Transferred pending selection from openId=${sender.sender_id.open_id} to chat=${chat_id}`);
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

    // 2. Check for pending selection (number reply or "new")
    const pending = this.sessionMapper.getPendingSelection(chatId);
    if (pending) {
      const handled = await this.handlePendingSelection(chatId, text, pending);
      if (handled) return;
    }

    // 3. Active temp session (not expired)? → send to engine
    const tempSession = this.sessionMapper.getTempSession(chatId);
    if (tempSession && !this.isTempSessionExpired(tempSession)) {
      await this.enqueueP2PMessage(chatId, text);
      return;
    }

    // 4. Has lastSelectedProject → auto-create temp session and send
    const p2pState = this.sessionMapper.getP2PChat(chatId);
    if (p2pState?.lastSelectedProject && this.gatewayClient) {
      // Clean up expired temp session if any
      if (tempSession) {
        await this.cleanupExpiredTempSession(chatId);
      }
      await this.createTempSessionAndSend(chatId, p2pState.lastSelectedProject, text);
      return;
    }

    // 5. No project → show project list
    await this.showProjectList(chatId);
  }

  private async handleP2PCommand(
    chatId: string,
    command: ReturnType<typeof parseCommand>,
  ): Promise<void> {
    if (!command) return;

    switch (command.command) {
      case "help":
        await this.sendTextMessage(chatId, buildHelpText());
        break;

      case "project":
        await this.showProjectList(chatId);
        break;

      default:
        await this.sendTextMessage(
          chatId,
          "📋 此命令仅在会话群聊中可用。使用 /help 查看可用命令。",
        );
    }
  }

  // ============================================================================
  // P2P Selection State Machine
  // ============================================================================

  /** Show project list and enter project selection mode */
  private async showProjectList(chatId: string): Promise<void> {
    if (!this.gatewayClient) return;

    const projects = await this.gatewayClient.listAllProjects();
    const text = buildProjectListText(projects);
    await this.sendTextMessage(chatId, text);

    if (projects.length > 0) {
      // Flatten projects in display order (grouped by engine) for number mapping
      const flatProjects = this.flattenProjectsByEngine(projects);
      this.sessionMapper.setPendingSelection(chatId, {
        type: "project",
        projects: flatProjects,
      });
    }
  }

  /** Show session list for a specific project and enter session selection mode */
  private async showSessionListForProject(
    chatId: string,
    project: { directory: string; engineType: EngineType; projectId: string },
    projectName: string,
  ): Promise<void> {
    if (!this.gatewayClient) return;
    const sessions = await this.gatewayClient.listSessions(project.engineType);
    const filtered = sessions.filter((s) => s.directory === project.directory);
    const sessionText = buildSessionListText(filtered, projectName);
    await this.sendTextMessage(chatId, sessionText);

    this.sessionMapper.setPendingSelection(chatId, {
      type: "session",
      sessions: filtered,
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
    project: { directory: string; engineType: EngineType; projectId: string },
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
        project.engineType,
        project.directory,
        project.projectId,
        projectName,
        chatId,
      );
    } catch (err) {
      await this.sendTextMessage(
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
    const projects = await this.gatewayClient.listAllProjects();
    const text = buildProjectListText(projects);
    await this.sendMessageTo(receiveId, receiveIdType, "text", JSON.stringify({ text }));

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
    project: { directory: string; engineType: EngineType; projectId: string },
    text: string,
  ): Promise<void> {
    if (!this.gatewayClient) return;

    try {
      const session = await this.gatewayClient.createSession({
        engineType: project.engineType,
        directory: project.directory,
      });

      const tempSession: TempSession = {
        conversationId: session.id,
        engineType: project.engineType,
        directory: project.directory,
        projectId: project.projectId,
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: false,
      };

      this.sessionMapper.setTempSession(chatId, tempSession);
      await this.enqueueP2PMessage(chatId, text);
    } catch (err) {
      await this.sendTextMessage(
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
    if (!this.gatewayClient) {
      // Reset processing state so future messages can still be processed
      tempSession.processing = false;
      feishuLog.error("Gateway client not connected, cannot send P2P message");
      return;
    }

    // Send initial "thinking" message
    const feishuMsgId = await this.sendTextMessage(chatId, "🤔 思考中...");
    if (!feishuMsgId) {
      feishuLog.error("Failed to send P2P thinking message");
      await this.processP2PQueue(chatId);
      return;
    }

    tempSession.lastActiveAt = Date.now();

    // Create streaming session
    const streaming: StreamingSession = {
      feishuMessageId: feishuMsgId,
      conversationId: tempSession.conversationId,
      messageId: "",
      chatId,
      textBuffer: "",
      lastPatchTime: Date.now(),
      patchTimer: null,
      completed: false,
      toolCounts: new Map(),
    };
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
        feishuLog.error("P2P sendMessage failed:", err);
        tempSession.streamingSession = undefined;
        this.patchFeishuMessage(
          feishuMsgId,
          `⚠️ 错误：${err instanceof Error ? err.message : String(err)}`,
        );
        // Session might be invalid — try recreating on next message
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
      feishuLog.info(`Deleted expired temp session: ${temp.conversationId}`);
    } catch {
      // Ignore deletion failures for temp sessions
    }
    this.sessionMapper.clearTempSession(chatId);
  }

  /** Flatten projects grouped by engine type (same order as buildProjectListText) */
  private flattenProjectsByEngine(
    projects: import("../../../../src/types/unified").UnifiedProject[],
  ): import("../../../../src/types/unified").UnifiedProject[] {
    const grouped = new Map<string, typeof projects>();
    for (const p of projects) {
      const key = p.engineType;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(p);
    }
    const flat: typeof projects = [];
    for (const engineProjects of grouped.values()) {
      flat.push(...engineProjects);
    }
    return flat;
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
    const num = parseInt(text.trim(), 10);
    if (isNaN(num) || num < 1 || !pending.projects || num > pending.projects.length) {
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

  /** Handle session number selection or "new" */
  private async handleSessionSelection(
    chatId: string,
    text: string,
    pending: import("./feishu-types").PendingSelection,
  ): Promise<boolean> {
    const trimmed = text.trim().toLowerCase();
    const p2pState = this.sessionMapper.getP2PChat(chatId);
    const userOpenId = p2pState?.openId;
    if (!userOpenId || !pending.engineType || !pending.directory || !pending.projectId) {
      return false;
    }

    if (trimmed === "new") {
      this.sessionMapper.clearPendingSelection(chatId);
      await this.createNewSessionForProject(
        chatId,
        userOpenId,
        { directory: pending.directory, engineType: pending.engineType, projectId: pending.projectId },
        pending.projectName || "",
      );
      return true;
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
      await this.sendTextMessage(
        chatId,
        `📋 此会话已有对应的群聊，请直接在群聊中发送消息。`,
      );
      return true;
    }

    await this.createGroupForSession(
      userOpenId,
      session.id,
      pending.engineType,
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
      await this.sendTextMessage(groupChatId, "📋 此群聊未绑定到 CodeMux 会话。");
      return;
    }

    const command = parseCommand(text);
    if (command) {
      await this.handleGroupCommand(groupChatId, binding, command);
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
    if (!command || !this.gatewayClient) return;

    switch (command.command) {
      case "help":
        await this.sendTextMessage(groupChatId, buildGroupHelpText());
        break;

      case "cancel":
        await this.gatewayClient.cancelMessage(binding.conversationId);
        await this.sendTextMessage(groupChatId, "📋 消息已取消。");
        break;

      case "status": {
        const projectName = binding.directory.split(/[\\/]/).pop();
        const lines = [
          "📋 **会话状态**\n",
          `项目：**${projectName}**（${binding.engineType}）`,
          `会话：\`${binding.conversationId.slice(0, 12)}...\``,
        ];
        await this.sendTextMessage(groupChatId, lines.join("\n"));
        break;
      }

      case "mode": {
        if (!command.args || command.args.length === 0) {
          await this.sendTextMessage(groupChatId, "📋 用法：/mode <agent|plan|build>");
          return;
        }
        await this.gatewayClient.setMode({
          sessionId: binding.conversationId,
          modeId: command.args[0],
        });
        await this.sendTextMessage(groupChatId, `📋 模式已切换为：**${command.args[0]}**`);
        break;
      }

      case "model": {
        if (
          command.subcommand === "list" ||
          (!command.subcommand && (!command.args || command.args.length === 0))
        ) {
          const result = await this.gatewayClient.listModels(binding.engineType);
          const lines = ["📋 模型列表", "─────────────────────────"];
          for (const m of result.models) {
            const current = m.modelId === result.currentModelId ? "（当前）" : "";
            lines.push(`  ${m.name || m.modelId}${current}`);
          }
          lines.push("─────────────────────────");
          lines.push("使用 /model <model-id> 切换模型。");
          await this.sendTextMessage(groupChatId, lines.join("\n"));
        } else if (command.args && command.args.length > 0) {
          await this.gatewayClient.setModel({
            sessionId: binding.conversationId,
            modelId: command.args[0],
          });
          await this.sendTextMessage(groupChatId, `📋 模型已切换为：**${command.args[0]}**`);
        }
        break;
      }

      default:
        await this.sendTextMessage(
          groupChatId,
          `📋 未知命令：\`${command.command}\`。使用 /help 查看可用命令。`,
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
    if (!this.larkClient || !this.gatewayClient) return;

    // Check if session already has a group
    if (this.sessionMapper.hasGroupForConversation(conversationId)) {
      const existingChatId = this.sessionMapper.findGroupChatIdByConversationId(conversationId);
      if (p2pChatId) {
        await this.sendTextMessage(
          p2pChatId,
          `Session already has a group chat. Check your Feishu groups.`,
        );
      }
      feishuLog.warn(`Conversation ${conversationId} already has group ${existingChatId}`);
      return;
    }

    // Concurrency guard — prevent duplicate group creation from rapid clicks
    if (!this.sessionMapper.markCreating(conversationId)) {
      feishuLog.warn(`Conversation ${conversationId} group creation already in progress`);
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
      const groupName = `[CodeMux][${projectName}] ${sessionTitle}`;
      const createRes = await this.larkClient.im.chat.create({
        params: { user_id_type: "open_id", set_bot_manager: true },
        data: {
          name: groupName,
          user_id_list: [userOpenId],
        },
      });

      const newChatId = (createRes as any)?.data?.chat_id;
      if (!newChatId) {
        feishuLog.error("Failed to create group chat: no chat_id returned");
        if (p2pChatId) {
          await this.sendTextMessage(p2pChatId, "Failed to create group chat. Please try again.");
        }
        return;
      }

      feishuLog.info(`Created group chat: ${newChatId} for conversation ${conversationId}`);

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
      await this.sendCardMessage(newChatId, welcomeCard);

      // Notify user in P2P
      if (p2pChatId) {
        await this.sendTextMessage(
          p2pChatId,
          `Group created for session. Check your Feishu groups for "${groupName}".`,
        );
      }
    } catch (err) {
      feishuLog.error("Failed to create group for session:", err);
      if (p2pChatId) {
        await this.sendTextMessage(
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

    feishuLog.info(`Bot menu event: key=${eventKey}, operator=${openId}, raw=${JSON.stringify(event).slice(0, 200)}`);

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
        await this.sendMessageTo(
          receiveId,
          receiveIdType,
          "text",
          JSON.stringify({ text: buildHelpText() }),
        );
        break;
      }

      default:
        feishuLog.warn(`Unknown bot menu event_key: ${eventKey}`);
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

  private async cleanupGroupResources(chatId: string | undefined, reason: string): Promise<void> {
    if (!chatId) return;

    feishuLog.info(`${reason}: ${chatId}`);
    const binding = this.sessionMapper.removeGroupBinding(chatId);
    if (binding && this.gatewayClient) {
      try {
        await this.gatewayClient.deleteSession(binding.conversationId);
        feishuLog.info(`Deleted session ${binding.conversationId} after ${reason}`);
      } catch (err) {
        feishuLog.error(`Failed to delete session ${binding.conversationId}:`, err);
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
    if (!this.gatewayClient) return;

    // Send initial "thinking" message to Feishu
    const feishuMsgId = await this.sendTextMessage(groupChatId, "🤔 思考中...");
    if (!feishuMsgId) {
      feishuLog.error("Failed to send initial thinking message");
      return;
    }

    // Register streaming session IMMEDIATELY with placeholder key.
    // This avoids the race condition where gateway notifications arrive
    // before sendMessage() resolves (which would cause all updates to be dropped).
    const placeholderKey = `pending_${Date.now()}`;
    const streamingSession: StreamingSession = {
      feishuMessageId: feishuMsgId,
      conversationId: binding.conversationId,
      messageId: "",  // will be set when sendMessage resolves
      chatId: groupChatId,
      textBuffer: "",
      lastPatchTime: Date.now(),
      patchTimer: null,
      completed: false,
      toolCounts: new Map(),
    };
    this.sessionMapper.registerStreamingSession(groupChatId, placeholderKey, streamingSession);

    // Send message to engine via Gateway (non-blocking)
    // Streaming updates come via Gateway notifications and are now captured
    // by the pre-registered streaming session above.
    const sendPromise = this.gatewayClient.sendMessage({
      sessionId: binding.conversationId,
      content: [{ type: "text", text }],
    });

    sendPromise
      .then((msg) => {
        // Re-key: remove placeholder, register with real msg.id
        // so handleMessageCompleted can find it by message.id
        streamingSession.messageId = msg.id;
        binding.streamingSessions.delete(placeholderKey);
        this.sessionMapper.registerStreamingSession(groupChatId, msg.id, streamingSession);
      })
      .catch((err) => {
        feishuLog.error("sendMessage failed:", err);
        // Clean up placeholder and show error
        binding.streamingSessions.delete(placeholderKey);
        this.patchFeishuMessage(
          feishuMsgId,
          `⚠️ 错误：${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  // ============================================================================
  // Gateway Notification Handlers
  // ============================================================================

  private handlePartUpdated(conversationId: string, part: UnifiedPart): void {
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
        this.applyPartToStreaming(streaming, part);
      }
      return;
    }

    // Try P2P temp session
    const p2pChatId = this.sessionMapper.findP2PChatByTempConversation(conversationId);
    if (p2pChatId) {
      const tempSession = this.sessionMapper.getTempSession(p2pChatId);
      if (tempSession?.streamingSession && !tempSession.streamingSession.completed) {
        this.applyPartToStreaming(tempSession.streamingSession, part);
      }
    }
  }

  /** Apply a part update to a streaming session (shared by group and P2P) */
  private applyPartToStreaming(streaming: StreamingSession, part: UnifiedPart): void {
    switch (part.type) {
      case "text":
        if (
          streaming.currentTextPartId &&
          streaming.currentTextPartId !== part.id &&
          streaming.textBuffer
        ) {
          // New text segment detected — send as a new Feishu message
          void this.transitionToNewTextSegment(streaming, part);
        } else {
          // Same segment or first segment — normal streaming
          streaming.currentTextPartId = part.id;
          streaming.textBuffer = part.text || "";
          this.scheduleStreamingPatch(streaming);
        }
        break;
      case "tool":
        if (part.normalizedTool) {
          const count = streaming.toolCounts.get(part.normalizedTool) ?? 0;
          streaming.toolCounts.set(part.normalizedTool, count + 1);
        }
        break;
      default:
        break;
    }
  }

  /**
   * Transition streaming to a new text segment:
   * finalize current Feishu message, create a new one for the new segment.
   */
  private async transitionToNewTextSegment(
    streaming: StreamingSession,
    newPart: UnifiedPart & { type: "text" },
  ): Promise<void> {
    // 1. Finalize current message (clear timer, patch with final text — no "Thinking..." suffix)
    if (streaming.patchTimer) {
      clearTimeout(streaming.patchTimer);
      streaming.patchTimer = null;
    }
    if (streaming.feishuMessageId && streaming.textBuffer) {
      this.patchFeishuMessage(streaming.feishuMessageId, truncateForFeishu(streaming.textBuffer));
    }

    // 2. Reset for new segment
    streaming.textBuffer = newPart.text || "";
    streaming.currentTextPartId = newPart.id;
    streaming.feishuMessageId = ""; // prevent patches during message creation
    streaming.lastPatchTime = Date.now();

    // 3. Create new Feishu message
    const newMsgId = await this.sendTextMessage(
      streaming.chatId,
      formatStreamingText(streaming.textBuffer),
    );

    if (newMsgId) {
      streaming.feishuMessageId = newMsgId;
      if (streaming.completed) {
        // Race: message completed while creating new Feishu message — finalize now
        const toolSummary = formatToolSummaryFromCounts(streaming.toolCounts);
        let finalText = streaming.textBuffer || "（无文本回复）";
        finalText += toolSummary;
        this.patchFeishuMessage(newMsgId, truncateForFeishu(finalText));
      } else {
        this.scheduleStreamingPatch(streaming);
      }
    } else {
      feishuLog.error("Failed to create new segment message");
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

    if (!streaming) return;

    streaming.completed = true;
    if (streaming.patchTimer) {
      clearTimeout(streaming.patchTimer);
      streaming.patchTimer = null;
    }

    if (message.error) {
      this.patchFeishuMessage(streaming.feishuMessageId, `⚠️ 错误：${message.error}`);
      binding.streamingSessions.delete(streamingKey);
      return;
    }

    const toolSummary = formatToolSummaryFromCounts(streaming.toolCounts);
    let finalText = streaming.textBuffer || "（无文本回复）";
    finalText += toolSummary;
    finalText = truncateForFeishu(finalText);

    this.patchFeishuMessage(streaming.feishuMessageId, finalText);
    binding.streamingSessions.delete(streamingKey);
  }

  /** Finalize streaming for a P2P temp session and process next queued message */
  private async finalizeP2PStreaming(chatId: string, message: UnifiedMessage): Promise<void> {
    const tempSession = this.sessionMapper.getTempSession(chatId);
    if (!tempSession?.streamingSession) return;

    const streaming = tempSession.streamingSession;
    streaming.completed = true;
    if (streaming.patchTimer) {
      clearTimeout(streaming.patchTimer);
      streaming.patchTimer = null;
    }

    tempSession.lastActiveAt = Date.now();

    if (message.error) {
      this.patchFeishuMessage(streaming.feishuMessageId, `⚠️ 错误：${message.error}`);
      tempSession.streamingSession = undefined;
      await this.processP2PQueue(chatId);
      return;
    }

    const toolSummary = formatToolSummaryFromCounts(streaming.toolCounts);
    let finalText = streaming.textBuffer || "（无文本回复）";
    finalText = `💬 ${finalText}`;
    finalText += toolSummary;
    finalText = truncateForFeishu(finalText);

    this.patchFeishuMessage(streaming.feishuMessageId, finalText);
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
      feishuLog.info(`Auto-approving permission: ${permission.id}`);
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

    // UnifiedQuestion has questions: QuestionInfo[], each with question text and options
    if (question.questions && question.questions.length > 0) {
      const q = question.questions[0]; // Handle first question
      const options = q.options.map((o, i) => ({ id: String(i), label: o.label || o.description }));
      const text = buildQuestionText(
        q.question || "Agent 有一个问题：",
        options,
      );
      this.sendTextMessage(targetChatId, text);
      // Note: Question replies via text commands are not yet implemented.
      // For now, auto-approve if possible (handled by handlePermissionAsked).
    } else {
      this.sendTextMessage(targetChatId, "📋 Agent 提问（无选项）");
    }
  }

  private async handleSessionUpdated(session: import("../../../../src/types/unified").UnifiedSession): Promise<void> {
    if (!this.larkClient) return;

    // Check if this session has a bound group chat
    const groupChatId = this.sessionMapper.findGroupChatIdByConversationId(session.id);
    if (!groupChatId) return;

    const binding = this.sessionMapper.getGroupBinding(groupChatId);
    if (!binding) return;

    // Derive the project name from directory
    const projectName = binding.directory.split(/[\\/]/).pop() || binding.directory;

    // Build the expected group name
    const newTitle = session.title || "New Session";
    const expectedGroupName = `[CodeMux][${projectName}] ${newTitle}`;

    // Update the Feishu group chat name
    try {
      await this.rateLimiter.consume();
      await this.larkClient.im.chat.update({
        path: { chat_id: groupChatId },
        data: { name: expectedGroupName },
      });
      feishuLog.info(`Updated group chat name: ${groupChatId} → "${expectedGroupName}"`);
    } catch (err) {
      feishuLog.error(`Failed to update group chat name for ${groupChatId}:`, err);
    }
  }

  // ============================================================================
  // Streaming Patch Logic
  // ============================================================================

  private scheduleStreamingPatch(streaming: StreamingSession): void {
    if (streaming.patchTimer || streaming.completed || !streaming.feishuMessageId) return;

    const elapsed = Date.now() - streaming.lastPatchTime;
    const throttleMs = this.config.streamingThrottleMs;
    const delay = Math.max(0, throttleMs - elapsed);

    streaming.patchTimer = setTimeout(() => {
      streaming.patchTimer = null;
      if (!streaming.completed) {
        streaming.lastPatchTime = Date.now();
        const text = formatStreamingText(streaming.textBuffer);
        this.patchFeishuMessage(streaming.feishuMessageId, truncateForFeishu(text));
      }
    }, delay);
  }

  // ============================================================================
  // Feishu API Helpers
  // ============================================================================

  /**
   * Send a text message to a Feishu chat.
   * Returns the Feishu message_id, or empty string on failure.
   */
  private async sendTextMessage(chatId: string, text: string): Promise<string> {
    if (!this.larkClient) return "";

    try {
      await this.rateLimiter.consume();
      const res = await this.larkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: "text",
        },
      });
      return (res as any)?.data?.message_id ?? "";
    } catch (err) {
      feishuLog.error("Failed to send text message:", err);
      return "";
    }
  }

  /**
   * Send an interactive card message to a Feishu chat.
   */
  private async sendCardMessage(chatId: string, cardJson: string): Promise<string> {
    if (!this.larkClient) return "";

    try {
      await this.rateLimiter.consume();
      const res = await this.larkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: cardJson,
          msg_type: "interactive",
        },
      });
      return (res as any)?.data?.message_id ?? "";
    } catch (err) {
      feishuLog.error("Failed to send card message:", err);
      return "";
    }
  }

  /**
   * Send a message using either chat_id or open_id as receive_id.
   */
  private async sendMessageTo(
    receiveId: string,
    receiveIdType: string,
    msgType: string,
    content: string,
  ): Promise<string> {
    if (!this.larkClient) return "";

    try {
      await this.rateLimiter.consume();
      const res = await this.larkClient.im.message.create({
        params: { receive_id_type: receiveIdType as any },
        data: {
          receive_id: receiveId,
          content,
          msg_type: msgType as any,
        },
      });
      return (res as any)?.data?.message_id ?? "";
    } catch (err) {
      feishuLog.error(`Failed to send message (${receiveIdType}=${receiveId}):`, err);
      return "";
    }
  }

  /**
   * Update (PATCH) an existing Feishu message.
   */
  private async patchFeishuMessage(messageId: string, text: string): Promise<void> {
    if (!this.larkClient || !messageId) return;

    try {
      await this.rateLimiter.consume();
      // Use im.message.update (PUT) for text messages.
      // im.message.patch (PATCH) only works for interactive card messages.
      await this.larkClient.im.message.update({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      feishuLog.error(`Failed to update message ${messageId}:`, err);
    }
  }
}
