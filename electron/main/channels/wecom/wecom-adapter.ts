// ============================================================================
// WeCom Channel Adapter
// Connects WeCom (企业微信) to CodeMux via Gateway WebSocket.
// Architecture: P2P (user:userId) = entry point, Group (group:chatId) = session.
//
// WeCom specifics:
// - Messages received via HTTP callback (encrypted XML, AES-CBC)
// - Messages CANNOT be edited → uses BATCH mode (no streaming updates)
// - Rate limit: 30/min per member, 1000/hour per member
// - Max message size: 2048 bytes (text/markdown)
// - Supports message recall (delete) but not edit
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
import { TokenManager } from "../streaming/token-manager";
import { TokenBucket } from "../streaming/rate-limiter";
import { createStreamingSession, type StreamingSession } from "../streaming/streaming-types";
import { BaseSessionMapper, type BaseGroupBinding, type BaseTempSession, type BasePendingSelection, type PersistedBinding } from "../base-session-mapper";
import type { WebhookServer, WebhookRequest, WebhookResponse } from "../webhook-server";
import { WeComCrypto } from "./wecom-crypto";
import { WeComTransport } from "./wecom-transport";
import { WeComRenderer } from "./wecom-renderer";
import {
  parseCommand,
  buildHelpText,
  buildGroupHelpText,
  buildProjectListText,
  buildSessionListText,
  buildQuestionText,
  buildHistoryEntries,
} from "./wecom-command-parser";
import {
  DEFAULT_WECOM_CONFIG,
  TEMP_SESSION_TTL_MS,
  type WeComConfig,
  type WeComGroupBinding,
  type WeComIncomingMessage,
} from "./wecom-types";
import type {
  EngineType,
  UnifiedPart,
  UnifiedMessage,
  UnifiedPermission,
  UnifiedQuestion,
} from "../../../../src/types/unified";
import { channelLog } from "../../services/logger";

// ============================================================================
// XML Parsing Helper
// ============================================================================

/** Simple regex-based XML parser for WeCom callback messages */
function parseXml(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>|<(\w+)>(.*?)<\/\3>/gs;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const key = match[1] || match[3];
    const value = match[2] || match[4];
    if (key && value !== undefined) result[key] = value;
  }
  return result;
}

// ============================================================================
// WeCom Session Mapper
// ============================================================================

/** Serializable subset of WeComGroupBinding for disk persistence */
interface WeComPersistedBinding extends PersistedBinding {
  ownerUserId: string;
}

class WeComSessionMapper extends BaseSessionMapper<WeComGroupBinding> {
  protected override deserializeBinding(item: PersistedBinding): WeComGroupBinding {
    const base = super.deserializeBinding(item);
    return {
      ...base,
      ownerUserId: (item as WeComPersistedBinding).ownerUserId ?? "",
    };
  }

  protected override serializeBinding(binding: WeComGroupBinding): PersistedBinding {
    return {
      ...super.serializeBinding(binding),
      ownerUserId: binding.ownerUserId,
    };
  }
}

// ============================================================================
// WeCom Adapter
// ============================================================================

export class WeComAdapter extends ChannelAdapter {
  readonly channelType = "wecom";

  // --- State ---
  private status: ChannelStatus = "stopped";
  private error?: string;
  private config: WeComConfig = { ...DEFAULT_WECOM_CONFIG };

  // --- Internal ---
  private gatewayClient: GatewayWsClient | null = null;
  private sessionMapper = new WeComSessionMapper("wecom");
  private rateLimiter = new TokenBucket(5, 0.5); // 5 burst, 0.5/sec (30/min)

  // --- Streaming Architecture ---
  private tokenManager: TokenManager | null = null;
  private transport: WeComTransport | null = null;
  private renderer = new WeComRenderer();
  private streamingController: StreamingController | null = null;
  private crypto: WeComCrypto | null = null;

  // --- Webhook ---
  private webhookServer: WebhookServer | null = null;
  private static readonly WEBHOOK_PATH = "/webhook/wecom";

  /** WeCom supports message delete (recall) but NOT edit */
  private static readonly CAPABILITIES: ChannelCapabilities = {
    supportsMessageUpdate: false,
    supportsMessageDelete: true,
    supportsRichContent: true,
    maxMessageBytes: 2048,
  };

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async start(config: ChannelConfig): Promise<void> {
    if (this.status === "running") {
      channelLog.warn("[WeCom] Adapter already running, stopping first");
      await this.stop();
    }

    this.status = "starting";
    this.error = undefined;
    this.emit("status.changed", this.status);

    this.config = {
      ...DEFAULT_WECOM_CONFIG,
      ...(config.options as unknown as Partial<WeComConfig>),
    };

    if (!this.config.corpId || !this.config.corpSecret) {
      this.status = "error";
      this.error = "Missing corpId or corpSecret";
      this.emit("status.changed", this.status);
      throw new Error("WeCom corpId and corpSecret are required");
    }

    if (!this.config.callbackToken || !this.config.callbackEncodingAESKey) {
      this.status = "error";
      this.error = "Missing callbackToken or callbackEncodingAESKey";
      this.emit("status.changed", this.status);
      throw new Error("WeCom callbackToken and callbackEncodingAESKey are required");
    }

    try {
      // 1. Create crypto handler
      this.crypto = new WeComCrypto(
        this.config.callbackToken,
        this.config.callbackEncodingAESKey,
        this.config.corpId,
      );

      // 2. Create token manager (access_token auto-refresh)
      const { corpId, corpSecret } = this.config;
      this.tokenManager = new TokenManager(async () => {
        const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
        const res = await fetch(url);
        const data = (await res.json()) as {
          errcode: number;
          errmsg: string;
          access_token: string;
          expires_in: number;
        };
        if (data.errcode !== 0) {
          throw new Error(`WeCom gettoken failed: ${data.errmsg}`);
        }
        return { token: data.access_token, expiresInSeconds: data.expires_in };
      });

      // 3. Create transport and streaming controller
      this.transport = new WeComTransport(
        this.tokenManager,
        this.rateLimiter,
        this.config.agentId,
      );
      this.streamingController = new StreamingController(
        this.transport,
        this.renderer,
        { throttleMs: 0 }, // Not used in batch mode
        WeComAdapter.CAPABILITIES,
      );

      // 4. Register webhook route (requires WebhookServer instance passed via config)
      this.webhookServer = (config.options as any)?._webhookServer as WebhookServer | undefined ?? null;
      if (this.webhookServer) {
        this.webhookServer.registerRoute(
          WeComAdapter.WEBHOOK_PATH,
          (req) => this.handleWebhook(req),
        );
      }

      // 5. Connect to local Gateway
      this.gatewayClient = new GatewayWsClient(this.config.gatewayUrl);
      await this.gatewayClient.connect();
      channelLog.info("[WeCom] Gateway WS client connected");

      // 6. Restore persisted group bindings
      this.sessionMapper.loadBindings();

      // 7. Subscribe to Gateway notifications
      this.subscribeGatewayEvents();

      this.status = "running";
      this.emit("status.changed", this.status);
      this.emit("connected");
      channelLog.info("[WeCom] Adapter started successfully");
    } catch (err) {
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.emit("status.changed", this.status);
      channelLog.error("[WeCom] Failed to start adapter:", err);
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
    channelLog.info("[WeCom] Stopping adapter...");

    // Clean up streaming timers
    this.sessionMapper.cleanup();

    // Unregister webhook
    if (this.webhookServer) {
      this.webhookServer.unregisterRoute(WeComAdapter.WEBHOOK_PATH);
      this.webhookServer = null;
    }

    // Disconnect Gateway WS
    if (this.gatewayClient) {
      this.gatewayClient.disconnect();
      this.gatewayClient = null;
    }

    this.crypto = null;
    this.tokenManager = null;
    this.transport = null;
    this.streamingController = null;

    this.status = "stopped";
    this.error = undefined;
    this.emit("status.changed", this.status);
    this.emit("disconnected", "stopped");
    channelLog.info("[WeCom] Adapter stopped");
  }

  getInfo(): ChannelInfo {
    return {
      type: this.channelType,
      name: "WeCom Bot",
      status: this.status,
      error: this.error,
    };
  }

  async updateConfig(config: Partial<ChannelConfig>): Promise<void> {
    const wasRunning = this.status === "running";
    const newOptions = config.options as Partial<WeComConfig> | undefined;

    if (newOptions) {
      this.config = { ...this.config, ...newOptions };
    }

    // If credentials changed while running, restart
    if (wasRunning && newOptions && (newOptions.corpId || newOptions.corpSecret)) {
      channelLog.info("[WeCom] Credentials changed, restarting adapter");
      await this.stop();
      const fullConfig: ChannelConfig = {
        type: "wecom",
        name: "WeCom Bot",
        enabled: true,
        options: this.config as unknown as Record<string, unknown>,
      };
      await this.start(fullConfig);
    }
  }

  // =========================================================================
  // Gateway Event Subscriptions
  // =========================================================================

  private subscribeGatewayEvents(): void {
    if (!this.gatewayClient) return;

    this.gatewayClient.on("message.part.updated", (data) => {
      this.handlePartUpdated(data.sessionId, data.part);
    });

    this.gatewayClient.on("message.updated", (data) => {
      this.handleMessageCompleted(data.sessionId, data.message);
    });

    this.gatewayClient.on("permission.asked", (data) => {
      this.handlePermissionAsked(data.permission);
    });

    this.gatewayClient.on("question.asked", (data) => {
      this.handleQuestionAsked(data.question);
    });

    this.gatewayClient.on("session.updated", (data) => {
      this.handleSessionUpdated(data.session);
    });
  }

  // =========================================================================
  // Webhook Handler
  // =========================================================================

  private async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    // GET: URL verification
    if (req.method === "GET") {
      return this.handleUrlVerification(req);
    }

    // POST: Incoming message
    if (req.method === "POST") {
      return this.handleIncomingMessage(req);
    }

    return { status: 405, body: "Method Not Allowed" };
  }

  /** Handle GET request for callback URL verification */
  private handleUrlVerification(req: WebhookRequest): WebhookResponse {
    if (!this.crypto) {
      return { status: 500, body: "Crypto not initialized" };
    }

    const { msg_signature, timestamp, nonce, echostr } = req.query;
    if (!msg_signature || !timestamp || !nonce || !echostr) {
      return { status: 400, body: "Missing required parameters" };
    }

    const plaintext = this.crypto.verifyUrl(msg_signature, timestamp, nonce, echostr);
    if (plaintext === null) {
      channelLog.error("[WeCom] URL verification failed");
      return { status: 403, body: "Verification failed" };
    }

    channelLog.info("[WeCom] URL verification successful");
    return {
      status: 200,
      headers: { "Content-Type": "text/plain" },
      body: plaintext,
    };
  }

  /** Handle POST request with encrypted XML message */
  private async handleIncomingMessage(req: WebhookRequest): Promise<WebhookResponse> {
    if (!this.crypto) {
      return { status: 500, body: "Crypto not initialized" };
    }

    const { msg_signature, timestamp, nonce } = req.query;
    if (!msg_signature || !timestamp || !nonce) {
      return { status: 400, body: "Missing required parameters" };
    }

    // Parse the outer XML to extract <Encrypt> element
    const outerXml = req.rawBody.toString("utf-8");
    const outerParsed = parseXml(outerXml);
    const encryptedContent = outerParsed["Encrypt"];
    if (!encryptedContent) {
      return { status: 400, body: "Missing Encrypt element" };
    }

    // Decrypt the message
    const decryptedXml = this.crypto.decryptMessage(
      msg_signature,
      timestamp,
      nonce,
      encryptedContent,
    );
    if (decryptedXml === null) {
      channelLog.error("[WeCom] Message decryption failed");
      return { status: 403, body: "Decryption failed" };
    }

    // Parse decrypted XML into message fields
    const fields = parseXml(decryptedXml);
    const incoming: WeComIncomingMessage = {
      toUserName: fields["ToUserName"] ?? "",
      fromUserName: fields["FromUserName"] ?? "",
      createTime: parseInt(fields["CreateTime"] ?? "0", 10),
      msgType: fields["MsgType"] ?? "",
      content: fields["Content"],
      msgId: fields["MsgId"] ?? "",
      agentId: parseInt(fields["AgentID"] ?? "0", 10),
    };

    // Process asynchronously, respond immediately to WeCom
    void this.processIncomingMessage(incoming).catch((err) => {
      channelLog.error("[WeCom] Error processing message:", err);
    });

    return { status: 200, body: "success" };
  }

  // =========================================================================
  // Message Processing
  // =========================================================================

  private async processIncomingMessage(msg: WeComIncomingMessage): Promise<void> {
    // Skip non-text messages
    if (msg.msgType !== "text") {
      channelLog.verbose(`[WeCom] Ignoring non-text message type: ${msg.msgType}`);
      return;
    }

    // Deduplication
    if (this.sessionMapper.isDuplicate(msg.msgId)) {
      channelLog.verbose(`[WeCom] Skipping duplicate message: ${msg.msgId}`);
      return;
    }

    const userId = msg.fromUserName;
    const text = (msg.content ?? "").trim();
    if (!text) return;

    channelLog.info(`[WeCom] Message from ${userId}: ${text.slice(0, 100)}`);

    // WeCom doesn't have native P2P vs group distinction in callback;
    // we use our userId-based P2P state to determine routing.
    // If the userId matches a known group binding member, route to group handling.
    // Otherwise, treat as P2P message.
    const chatId = `user:${userId}`;

    // Check if user has an active group context
    // For WeCom, all callback messages come to the same endpoint.
    // We always treat callback messages as P2P (user→bot direct messages).
    // Group chat interactions happen when the bot sends to a group.
    this.sessionMapper.getOrCreateP2PChat(chatId, userId);
    await this.handleP2PMessage(chatId, userId, text);
  }

  // =========================================================================
  // P2P Message Handling
  // =========================================================================

  private async handleP2PMessage(chatId: string, userId: string, text: string): Promise<void> {
    // 1. Check for slash commands
    const command = parseCommand(text);
    if (command) {
      this.sessionMapper.clearPendingSelection(chatId);
      await this.handleP2PCommand(chatId, command);
      return;
    }

    // 2. Check for pending question
    const pendingQ = this.sessionMapper.getPendingQuestion(chatId);
    if (pendingQ && this.gatewayClient) {
      this.sessionMapper.clearPendingQuestion(chatId);
      await this.gatewayClient.replyQuestion({
        questionId: pendingQ.questionId,
        answers: [[text]],
      });
      channelLog.info(`[WeCom] Replied to question ${pendingQ.questionId}`);
      return;
    }

    // 3. Check for pending selection
    const pending = this.sessionMapper.getPendingSelection(chatId);
    if (pending) {
      const handled = await this.handlePendingSelection(chatId, userId, text, pending);
      if (handled) return;
    }

    // 4. Active temp session?
    const tempSession = this.sessionMapper.getTempSession(chatId);
    if (tempSession && !this.isTempSessionExpired(tempSession)) {
      await this.enqueueP2PMessage(chatId, text);
      return;
    }

    // 5. Has lastSelectedProject → auto-create temp session
    const p2pState = this.sessionMapper.getP2PChat(chatId);
    if (p2pState?.lastSelectedProject && this.gatewayClient) {
      if (tempSession) {
        await this.cleanupExpiredTempSession(chatId);
      }
      await this.createTempSessionAndSend(chatId, p2pState.lastSelectedProject, text);
      return;
    }

    // 6. No project → show project list
    await this.showProjectList(chatId);
  }

  private async handleP2PCommand(
    chatId: string,
    command: ReturnType<typeof parseCommand>,
  ): Promise<void> {
    if (!command || !this.transport) return;

    switch (command.command) {
      case "help":
        await this.transport.sendText(chatId, buildHelpText());
        break;

      case "project":
        await this.showProjectList(chatId);
        break;

      default:
        await this.transport.sendText(
          chatId,
          "📋 此命令仅在会话群聊中可用。使用 /help 查看可用命令。",
        );
    }
  }

  // =========================================================================
  // P2P Selection State Machine
  // =========================================================================

  private async showProjectList(chatId: string): Promise<void> {
    if (!this.gatewayClient || !this.transport) return;

    const projects = await this.gatewayClient.listAllProjects();
    const text = buildProjectListText(projects);
    await this.transport.sendText(chatId, text);

    if (projects.length > 0) {
      const flatProjects = this.flattenProjectsByEngine(projects);
      this.sessionMapper.setPendingSelection(chatId, {
        type: "project",
        projects: flatProjects,
      });
    }
  }

  private async showSessionListForProject(
    chatId: string,
    project: { directory: string; engineType: EngineType; projectId: string },
    projectName: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport) return;
    const sessions = await this.gatewayClient.listSessions(project.engineType);
    const filtered = sessions.filter((s) => s.directory === project.directory);
    const sessionText = buildSessionListText(filtered, projectName);
    await this.transport.sendText(chatId, sessionText);

    this.sessionMapper.setPendingSelection(chatId, {
      type: "session",
      sessions: filtered,
      engineType: project.engineType,
      directory: project.directory,
      projectId: project.projectId,
      projectName,
    });
  }

  private async createNewSessionForProject(
    chatId: string,
    userId: string,
    project: { directory: string; engineType: EngineType; projectId: string },
    projectName: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport) return;
    try {
      const session = await this.gatewayClient.createSession({
        engineType: project.engineType,
        directory: project.directory,
      });
      await this.createGroupForSession(
        userId,
        session.id,
        project.engineType,
        project.directory,
        project.projectId,
        projectName,
        chatId,
      );
    } catch (err) {
      await this.transport.sendText(
        chatId,
        `📋 创建会话失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async handlePendingSelection(
    chatId: string,
    userId: string,
    text: string,
    pending: BasePendingSelection,
  ): Promise<boolean> {
    if (pending.type === "project") {
      return this.handleProjectSelection(chatId, text, pending);
    }
    if (pending.type === "session") {
      return this.handleSessionSelection(chatId, userId, text, pending);
    }
    return false;
  }

  private async handleProjectSelection(
    chatId: string,
    text: string,
    pending: BasePendingSelection,
  ): Promise<boolean> {
    const num = parseInt(text.trim(), 10);
    if (isNaN(num) || num < 1 || !pending.projects || num > pending.projects.length) {
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

  private async handleSessionSelection(
    chatId: string,
    userId: string,
    text: string,
    pending: BasePendingSelection,
  ): Promise<boolean> {
    const trimmed = text.trim().toLowerCase();
    if (!pending.engineType || !pending.directory || !pending.projectId) {
      return false;
    }

    if (trimmed === "new") {
      this.sessionMapper.clearPendingSelection(chatId);
      await this.createNewSessionForProject(
        chatId,
        userId,
        { directory: pending.directory, engineType: pending.engineType, projectId: pending.projectId },
        pending.projectName || "",
      );
      return true;
    }

    const num = parseInt(trimmed, 10);
    if (isNaN(num) || num < 1 || !pending.sessions || num > pending.sessions.length) {
      return false;
    }

    const session = pending.sessions[num - 1];
    this.sessionMapper.clearPendingSelection(chatId);

    if (this.sessionMapper.hasGroupForConversation(session.id)) {
      await this.transport!.sendText(
        chatId,
        "📋 此会话已有对应的群聊，请直接在群聊中发送消息。",
      );
      return true;
    }

    await this.createGroupForSession(
      userId,
      session.id,
      pending.engineType,
      pending.directory,
      pending.projectId,
      pending.projectName || "",
      chatId,
    );

    return true;
  }

  // =========================================================================
  // P2P Temp Session Methods
  // =========================================================================

  private isTempSessionExpired(temp: BaseTempSession): boolean {
    return Date.now() - temp.lastActiveAt > TEMP_SESSION_TTL_MS;
  }

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

      const tempSession: BaseTempSession = {
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
      await this.transport!.sendText(
        chatId,
        `📋 创建临时会话失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async enqueueP2PMessage(chatId: string, text: string): Promise<void> {
    const temp = this.sessionMapper.getTempSession(chatId);
    if (!temp) return;

    temp.messageQueue.push(text);
    if (!temp.processing) {
      await this.processP2PQueue(chatId);
    }
  }

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

  private async sendToEngineP2P(
    chatId: string,
    tempSession: BaseTempSession,
    text: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport || !this.streamingController) {
      tempSession.processing = false;
      channelLog.error("[WeCom] Gateway client not connected, cannot send P2P message");
      return;
    }

    // Batch mode: send thinking placeholder as a new message
    const platformMsgId = await this.transport.sendText(chatId, "🤔 思考中...");

    tempSession.lastActiveAt = Date.now();

    // Create streaming session (in batch mode, platformMsgId is used for potential recall)
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
        channelLog.error("[WeCom] P2P sendMessage failed:", err);
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

  private async cleanupExpiredTempSession(chatId: string): Promise<void> {
    const temp = this.sessionMapper.getTempSession(chatId);
    if (!temp) return;

    if (temp.streamingSession?.patchTimer) {
      clearTimeout(temp.streamingSession.patchTimer);
    }
    try {
      await this.gatewayClient?.deleteSession(temp.conversationId);
      channelLog.info(`[WeCom] Deleted expired temp session: ${temp.conversationId}`);
    } catch {
      // Ignore deletion failures for temp sessions
    }
    this.sessionMapper.clearTempSession(chatId);
  }

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

  // =========================================================================
  // Group Chat Management
  // =========================================================================

  /** Handle messages sent to a group chat (via group:chatId target) */
  async handleGroupMessage(groupChatId: string, text: string): Promise<void> {
    const binding = this.sessionMapper.getGroupBinding(groupChatId);
    if (!binding) {
      await this.transport!.sendText(`group:${groupChatId}`, "📋 此群聊未绑定到 CodeMux 会话。");
      return;
    }

    const command = parseCommand(text);
    if (command) {
      await this.handleGroupCommand(`group:${groupChatId}`, binding, command);
      return;
    }

    // Check for pending question
    const pendingQ = this.sessionMapper.getPendingQuestion(`group:${groupChatId}`);
    if (pendingQ && this.gatewayClient) {
      this.sessionMapper.clearPendingQuestion(`group:${groupChatId}`);
      await this.gatewayClient.replyQuestion({
        questionId: pendingQ.questionId,
        answers: [[text]],
      });
      channelLog.info(`[WeCom] Replied to question ${pendingQ.questionId}`);
      return;
    }

    // Regular message → send to engine
    await this.sendToEngine(`group:${groupChatId}`, binding, text);
  }

  private async handleGroupCommand(
    chatTarget: string,
    binding: WeComGroupBinding,
    command: ReturnType<typeof parseCommand>,
  ): Promise<void> {
    if (!command || !this.gatewayClient || !this.transport) return;

    switch (command.command) {
      case "help":
        await this.transport.sendText(chatTarget, buildGroupHelpText());
        break;

      case "cancel":
        await this.gatewayClient.cancelMessage(binding.conversationId);
        await this.transport.sendText(chatTarget, "📋 消息已取消。");
        break;

      case "status": {
        const projectName = binding.directory.split(/[\\/]/).pop();
        const lines = [
          "📋 会话状态\n",
          `项目：${projectName}（${binding.engineType}）`,
          `会话：${binding.conversationId}`,
        ];
        await this.transport.sendText(chatTarget, lines.join("\n"));
        break;
      }

      case "mode": {
        if (!command.args || command.args.length === 0) {
          await this.transport.sendText(chatTarget, "📋 用法：/mode <agent|plan|build>");
          return;
        }
        await this.gatewayClient.setMode({
          sessionId: binding.conversationId,
          modeId: command.args[0],
        });
        await this.transport.sendText(chatTarget, `📋 模式已切换为：${command.args[0]}`);
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
          await this.transport.sendText(chatTarget, lines.join("\n"));
        } else if (command.args && command.args.length > 0) {
          await this.gatewayClient.setModel({
            sessionId: binding.conversationId,
            modelId: command.args[0],
          });
          await this.transport.sendText(chatTarget, `📋 模型已切换为：${command.args[0]}`);
        }
        break;
      }

      case "history": {
        const messages = await this.gatewayClient.listMessages(binding.conversationId);
        const entries = buildHistoryEntries(messages);
        if (entries.length === 0) {
          await this.transport.sendText(chatTarget, "📋 暂无会话历史记录。");
        } else {
          await this.transport.sendText(chatTarget, "📋 会话历史");
          for (const entry of entries) {
            await this.transport.sendText(chatTarget, `${entry.emoji} ${entry.text}`);
          }
        }
        break;
      }

      default:
        await this.transport.sendText(
          chatTarget,
          `📋 未知命令：${command.command}。使用 /help 查看可用命令。`,
        );
    }
  }

  // =========================================================================
  // Group Creation
  // =========================================================================

  private async createGroupForSession(
    userId: string,
    conversationId: string,
    engineType: EngineType,
    directory: string,
    projectId: string,
    projectName: string,
    p2pChatId?: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport) return;

    if (this.sessionMapper.hasGroupForConversation(conversationId)) {
      if (p2pChatId) {
        await this.transport.sendText(
          p2pChatId,
          "📋 此会话已有对应的群聊。",
        );
      }
      return;
    }

    if (!this.sessionMapper.markCreating(conversationId)) {
      channelLog.warn(`[WeCom] Conversation ${conversationId} group creation already in progress`);
      return;
    }

    try {
      // Fetch session title
      let sessionTitle = "New Session";
      try {
        const session = await this.gatewayClient.getSession(conversationId);
        if (session?.title) {
          sessionTitle = session.title;
        }
      } catch {
        // Use default title
      }

      // Create WeCom group chat
      const groupName = `[${projectName}] ${sessionTitle}`;
      const newChatId = await this.transport.createGroup(
        groupName,
        userId,
        [userId],
      );

      if (!newChatId) {
        channelLog.error("[WeCom] Failed to create group chat: no chatid returned");
        if (p2pChatId) {
          await this.transport.sendText(p2pChatId, "📋 创建群聊失败，请重试。");
        }
        return;
      }

      channelLog.info(`[WeCom] Created group chat: ${newChatId} for conversation ${conversationId}`);

      // Register group binding
      this.sessionMapper.createGroupBinding({
        chatId: newChatId,
        conversationId,
        engineType,
        directory,
        projectId,
        ownerUserId: userId,
        streamingSessions: new Map(),
        createdAt: Date.now(),
      });

      // Send welcome message to the new group
      const welcomeText = [
        `📋 CodeMux 会话群`,
        `─────────────────────────`,
        `项目：${projectName}`,
        `引擎：${engineType}`,
        `会话：${conversationId.slice(0, 8)}...`,
        `─────────────────────────`,
        `发送消息即可与 AI 助手对话。`,
        `使用 /help 查看可用命令。`,
      ].join("\n");
      await this.transport.sendText(`group:${newChatId}`, welcomeText);

      // Notify user in P2P
      if (p2pChatId) {
        await this.transport.sendText(
          p2pChatId,
          `📋 已创建群聊「${groupName}」，请在企业微信中查看。`,
        );
      }
    } catch (err) {
      channelLog.error("[WeCom] Failed to create group for session:", err);
      if (p2pChatId) {
        await this.transport.sendText(
          p2pChatId,
          `📋 创建群聊失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      this.sessionMapper.unmarkCreating(conversationId);
    }
  }

  // =========================================================================
  // Send Message to Engine
  // =========================================================================

  private async sendToEngine(
    chatTarget: string,
    binding: WeComGroupBinding,
    text: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport || !this.streamingController) return;

    // Batch mode: send thinking placeholder
    const platformMsgId = await this.transport.sendText(chatTarget, "🤔 思考中...");

    // Register streaming session with placeholder key
    const placeholderKey = `pending_${Date.now()}`;
    const streamingSession = createStreamingSession(chatTarget, binding.conversationId, platformMsgId);
    this.sessionMapper.registerStreamingSession(binding.chatId, placeholderKey, streamingSession);

    const sendPromise = this.gatewayClient.sendMessage({
      sessionId: binding.conversationId,
      content: [{ type: "text", text }],
    });

    sendPromise
      .then((msg) => {
        streamingSession.messageId = msg.id;
        binding.streamingSessions.delete(placeholderKey);
        this.sessionMapper.registerStreamingSession(binding.chatId, msg.id, streamingSession);
      })
      .catch((err) => {
        channelLog.error("[WeCom] sendMessage failed:", err);
        binding.streamingSessions.delete(placeholderKey);
        this.transport!.sendText(
          chatTarget,
          `⚠️ 错误：${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  // =========================================================================
  // Gateway Notification Handlers
  // =========================================================================

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

  private finalizeGroupStreaming(
    binding: WeComGroupBinding,
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
    const binding = this.sessionMapper.findGroupByConversationId(permission.sessionId);
    if (!binding) {
      const p2pChatId = this.sessionMapper.findP2PChatByTempConversation(permission.sessionId);
      if (!p2pChatId) return;
    }

    if (!this.config.autoApprovePermissions || !this.gatewayClient) return;

    const acceptOption = permission.options?.find(
      (o: any) =>
        o.type?.includes("accept") ||
        o.type?.includes("allow") ||
        o.label?.toLowerCase().includes("allow"),
    );

    if (acceptOption) {
      channelLog.info(`[WeCom] Auto-approving permission: ${permission.id}`);
      this.gatewayClient.replyPermission({
        permissionId: permission.id,
        optionId: acceptOption.id,
      });
    }
  }

  private handleQuestionAsked(question: UnifiedQuestion): void {
    // Try group binding first
    let targetChatId: string | undefined;
    const groupChatId = this.sessionMapper.findGroupByConversationId(question.sessionId)?.chatId;
    if (groupChatId) {
      targetChatId = `group:${groupChatId}`;
    }

    // Fallback to P2P temp session
    if (!targetChatId) {
      targetChatId = this.sessionMapper.findP2PChatByTempConversation(question.sessionId);
    }
    if (!targetChatId || !this.transport) return;

    if (question.questions && question.questions.length > 0) {
      const q = question.questions[0];
      const options = q.options.map((o, i) => ({ id: String(i), label: o.label || o.description }));
      const text = buildQuestionText(
        q.question || "Agent 有一个问题：",
        options,
      );
      this.transport.sendText(targetChatId, text);

      this.sessionMapper.setPendingQuestion(targetChatId, {
        questionId: question.id,
        sessionId: question.sessionId,
      });
    } else {
      this.transport.sendText(targetChatId, "📋 Agent 提问（无选项）");
    }
  }

  private async handleSessionUpdated(
    session: import("../../../../src/types/unified").UnifiedSession,
  ): Promise<void> {
    if (!this.transport) return;

    const binding = this.sessionMapper.findGroupByConversationId(session.id);
    if (!binding) return;

    // Update streaming session titles
    for (const ss of binding.streamingSessions.values()) {
      if (!ss.completed) {
        ss.sessionTitle = session.title;
      }
    }

    // Update WeCom group chat name
    const projectName = binding.directory.split(/[\\/]/).pop() || binding.directory;
    const newTitle = session.title || "New Session";
    const expectedGroupName = `[${projectName}] ${newTitle}`;

    try {
      await this.rateLimiter.consume();
      await this.transport.updateGroup(binding.chatId, { name: expectedGroupName });
      channelLog.info(`[WeCom] Updated group chat name: ${binding.chatId} → "${expectedGroupName}"`);
    } catch (err) {
      channelLog.error(`[WeCom] Failed to update group chat name for ${binding.chatId}:`, err);
    }
  }
}
