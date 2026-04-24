// ============================================================================
// DingTalk Channel Adapter
// Connects DingTalk robot to CodeMux via Gateway WebSocket.
// Architecture: One Group = One Session (same pattern as Feishu adapter)
// P2P chat = entry point (project selection), Group chat = session interaction.
//
// DingTalk specifics:
//   - Uses Stream mode (WebSocket) for receiving events
//   - Robot sends messages via REST API (robot/groupMessages, robot/oToMessages)
//   - Supports ActionCard for rich content
//   - access_token via appKey + appSecret (2h expiry, uses TokenManager)
//   - Rate limit: 20 msgs/min for group robot (~0.33/sec)
//
// NOTE: Stream mode SDK integration is stubbed — the adapter structure is
// complete, but actual DingTalk stream connection requires the DingTalk
// Stream SDK to be integrated later.
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
import { BaseSessionMapper, type PersistedBinding } from "../base-session-mapper";
import { createStreamingSession, type StreamingSession } from "../streaming/streaming-types";
import { didConfigValuesChange, mergeDefinedConfig } from "../config-utils";
import { DingTalkTransport } from "./dingtalk-transport";
import { DingTalkRenderer } from "./dingtalk-renderer";
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
  DEFAULT_DINGTALK_CONFIG,
  TEMP_SESSION_TTL_MS,
  type DingTalkConfig,
  type DingTalkGroupBinding,
  type DingTalkTempSession,
  type DingTalkPendingSelection,
  type DingTalkMessageEvent,
} from "./dingtalk-types";
import type {
  EngineType,
  UnifiedPart,
  UnifiedMessage,
  UnifiedPermission,
  UnifiedQuestion,
} from "../../../../src/types/unified";
import { dingtalkLog } from "../../services/logger";

// ============================================================================
// DingTalk Session Mapper (extends BaseSessionMapper with ownerUserId)
// ============================================================================

class DingTalkSessionMapper extends BaseSessionMapper<DingTalkGroupBinding> {
  constructor() {
    super("dingtalk");
  }

  /** Persist ownerUserId in serialized bindings */
  protected override serializeBinding(binding: DingTalkGroupBinding): PersistedBinding {
    return {
      ...super.serializeBinding(binding),
      ownerUserId: binding.ownerUserId,
    };
  }

  /** Restore ownerUserId from persisted bindings */
  protected override deserializeBinding(item: PersistedBinding): DingTalkGroupBinding {
    const base = super.deserializeBinding(item);
    return {
      ...base,
      ownerUserId: (item.ownerUserId as string) || "",
    };
  }
}

// ============================================================================
// DingTalk Adapter
// ============================================================================

export class DingTalkAdapter extends ChannelAdapter {
  readonly channelType = "dingtalk";

  // --- State ---
  private status: ChannelStatus = "stopped";
  private error?: string;
  private config: DingTalkConfig = { ...DEFAULT_DINGTALK_CONFIG };

  // --- Internal ---
  private gatewayClient: GatewayWsClient | null = null;
  private sessionMapper = new DingTalkSessionMapper();
  // DingTalk group robot: 20 msgs/min ≈ 0.33/sec, allow bursts of 5
  private rateLimiter = new TokenBucket(5, 0.33);

  // --- Streaming Architecture ---
  private tokenManager: TokenManager | null = null;
  private transport: DingTalkTransport | null = null;
  private renderer = new DingTalkRenderer();
  private streamingController: StreamingController | null = null;

  /**
   * DingTalk capabilities:
   *   - supportsMessageUpdate: false (regular robot messages cannot be edited)
   *   - supportsMessageDelete: true (robot messages can be recalled)
   *   - supportsRichContent: true (ActionCard supported)
   *   - maxMessageBytes: 20KB for robot messages
   */
  private static readonly CAPABILITIES: ChannelCapabilities = {
    supportsMessageUpdate: false,
    supportsMessageDelete: true,
    supportsRichContent: true,
    maxMessageBytes: 20_000,
  };

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async start(config: ChannelConfig): Promise<void> {
    if (this.status === "running") {
      dingtalkLog.warn("DingTalk adapter already running, stopping first");
      await this.stop();
    }

    this.status = "starting";
    this.error = undefined;
    this.emit("status.changed", this.status);

    // Merge config
    this.config = mergeDefinedConfig(
      DEFAULT_DINGTALK_CONFIG,
      config.options as Partial<DingTalkConfig> | undefined,
    );

    if (!this.config.appKey || !this.config.appSecret) {
      this.status = "error";
      this.error = "Missing appKey or appSecret";
      this.emit("status.changed", this.status);
      throw new Error("DingTalk appKey and appSecret are required");
    }

    if (!this.config.robotCode) {
      this.status = "error";
      this.error = "Missing robotCode";
      this.emit("status.changed", this.status);
      throw new Error("DingTalk robotCode is required");
    }

    try {
      // 1. Create TokenManager for access_token auto-refresh
      this.tokenManager = new TokenManager(async () => {
        const res = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appKey: this.config.appKey,
            appSecret: this.config.appSecret,
          }),
        });

        if (!res.ok) {
          throw new Error(`DingTalk token fetch failed: ${res.status} ${await res.text()}`);
        }

        const data = (await res.json()) as { accessToken: string; expireIn: number };
        dingtalkLog.info(`Access token obtained, expires in ${data.expireIn}s`);
        return { token: data.accessToken, expiresInSeconds: data.expireIn };
      });

      // Eagerly fetch the first token to verify credentials
      await this.tokenManager.getToken();

      // 2. Create transport and streaming controller
      this.transport = new DingTalkTransport(
        this.tokenManager,
        this.rateLimiter,
        this.config.robotCode,
      );
      this.streamingController = new StreamingController(
        this.transport,
        this.renderer,
        { throttleMs: this.config.streamingThrottleMs },
        DingTalkAdapter.CAPABILITIES,
      );

      // 3. Connect to local Gateway
      this.gatewayClient = new GatewayWsClient(this.config.gatewayUrl);
      await this.gatewayClient.connect();
      dingtalkLog.info("Gateway WS client connected");

      // 4. Restore persisted group bindings from disk
      this.sessionMapper.loadBindings();

      // 5. Subscribe to Gateway notifications
      this.subscribeGatewayEvents();

      // 6. Start DingTalk Stream mode for receiving events
      if (this.config.useStreamMode) {
        this.startStreamMode();
      }

      this.status = "running";
      this.emit("status.changed", this.status);
      this.emit("connected");
      dingtalkLog.info("DingTalk adapter started successfully");
    } catch (err) {
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.emit("status.changed", this.status);
      dingtalkLog.error("Failed to start DingTalk adapter:", err);
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
    dingtalkLog.info("Stopping DingTalk adapter...");

    // Clean up streaming timers
    this.sessionMapper.cleanup();

    // Disconnect Gateway WS
    if (this.gatewayClient) {
      this.gatewayClient.disconnect();
      this.gatewayClient = null;
    }

    // Clean up SDK instances
    this.tokenManager = null;
    this.transport = null;
    this.streamingController = null;

    this.status = "stopped";
    this.error = undefined;
    this.emit("status.changed", this.status);
    this.emit("disconnected", "stopped");
    dingtalkLog.info("DingTalk adapter stopped");
  }

  getInfo(): ChannelInfo {
    return {
      type: this.channelType,
      name: "DingTalk Bot",
      status: this.status,
      error: this.error,
    };
  }

  async updateConfig(config: Partial<ChannelConfig>): Promise<void> {
    const wasRunning = this.status === "running";
    const newOptions = config.options as Partial<DingTalkConfig> | undefined;
    const previousConfig = { ...this.config };

    if (newOptions) {
      this.config = mergeDefinedConfig(this.config, newOptions);
    }

    const shouldRestart = wasRunning && didConfigValuesChange(
      previousConfig,
      this.config,
      ["appKey", "appSecret", "robotCode", "useStreamMode"],
    );

    if (shouldRestart) {
      dingtalkLog.info("Connection settings changed, restarting DingTalk adapter");
      await this.stop();
      const fullConfig: ChannelConfig = {
        type: "dingtalk",
        name: "DingTalk Bot",
        enabled: true,
        options: this.config as unknown as Record<string, unknown>,
      };
      await this.start(fullConfig);
    }
  }

  // ============================================================================
  // DingTalk Stream Mode (STUB)
  // ============================================================================

  /**
   * Start DingTalk Stream mode for receiving events.
   *
   * STUB: The actual DingTalk Stream SDK integration is deferred.
   * When integrated, this will establish a WebSocket connection to DingTalk's
   * stream endpoint and register callback handlers for message events.
   *
   * To integrate, install the DingTalk Stream SDK and replace this stub with:
   *   const client = new DingTalkStreamClient({ ... });
   *   client.registerCallbackListener('/v1.0/im/bot/messages/get', handler);
   *   client.start();
   */
  private startStreamMode(): void {
    dingtalkLog.warn(
      "DingTalk Stream mode requires the DingTalk Stream SDK to be integrated. " +
      "Message receiving is not active. To test, call handleDingTalkMessage() directly.",
    );
  }

  // ============================================================================
  // Public Message Handler (for external integration)
  // ============================================================================

  /**
   * Handle an incoming DingTalk message event.
   * This is the public entry point for DingTalk Stream SDK callbacks
   * or webhook-based event delivery.
   *
   * @param event - DingTalk message event data
   */
  async handleDingTalkMessage(event: DingTalkMessageEvent): Promise<void> {
    const { msgId, conversationType, text, senderStaffId, chatId, senderNick } = event;

    // Skip non-text messages
    if (event.msgtype !== "text") {
      dingtalkLog.verbose(`Ignoring non-text message type: ${event.msgtype}`);
      return;
    }

    // Deduplication
    if (this.sessionMapper.isDuplicate(msgId)) {
      dingtalkLog.verbose(`Skipping duplicate message: ${msgId}`);
      return;
    }

    // Extract text content and strip @mentions
    let content = (text?.content || "").trim();
    if (!content) return;

    const senderId = senderStaffId || event.chatbotUserId;

    dingtalkLog.info(
      `Message from ${conversationType === "1" ? "P2P" : "group"} ` +
      `(${senderNick}): ${content.slice(0, 100)}`,
    );

    if (conversationType === "1") {
      // Individual (P2P) message
      // For P2P, use the DingTalk conversationId as the chat identifier
      const p2pChatId = event.conversationId;
      this.sessionMapper.getOrCreateP2PChat(p2pChatId, senderId);
      await this.handleP2PMessage(p2pChatId, senderId, content);
    } else if (conversationType === "2" && chatId) {
      // Group message — chatId is the openConversationId
      await this.handleGroupMessage(chatId, content);
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

    // Session title updates
    this.gatewayClient.on("session.updated", (data) => {
      this.handleSessionUpdated(data.session);
    });
  }

  // ============================================================================
  // P2P Message Handling (Entry Point Only)
  // ============================================================================

  private async handleP2PMessage(chatId: string, senderId: string, text: string): Promise<void> {
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
      dingtalkLog.info(`Replied to question ${pendingQ.questionId} with freeform answer`);
      return;
    }

    // 3. Check for pending selection (number reply or "new")
    const pending = this.sessionMapper.getPendingSelection(chatId);
    if (pending) {
      const handled = await this.handlePendingSelection(chatId, senderId, text, pending);
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

  /** /new — create a new session under the last selected project (P2P only).
   *  DingTalk can create scene groups, so this opens a fresh group for the session. */
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
    const ownerUserId = p2pState.userId;
    if (!ownerUserId) {
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
    await this.createNewSessionForProject(chatId, ownerUserId, project, projectName);
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

  /** Create a new session for a project and create a scene group */
  private async createNewSessionForProject(
    chatId: string,
    ownerUserId: string,
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
        ownerUserId,
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

  // ============================================================================
  // P2P Temp Session Methods
  // ============================================================================

  /** Check if a temp session has expired (2h since last activity) */
  private isTempSessionExpired(temp: DingTalkTempSession): boolean {
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

      const tempSession: DingTalkTempSession = {
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
    tempSession: DingTalkTempSession,
    text: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport || !this.streamingController) {
      tempSession.processing = false;
      dingtalkLog.error("Gateway client not connected, cannot send P2P message");
      return;
    }

    // DingTalk doesn't support message update → batch mode (no placeholder)
    tempSession.lastActiveAt = Date.now();

    // Create streaming session (empty platformMsgId in batch mode)
    const streaming = createStreamingSession(chatId, tempSession.conversationId, "");
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
        dingtalkLog.error("P2P sendMessage failed:", err);
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
      dingtalkLog.info(`Deleted expired temp session: ${temp.conversationId}`);
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
    senderId: string,
    text: string,
    pending: DingTalkPendingSelection,
  ): Promise<boolean> {
    if (pending.type === "project") {
      return this.handleProjectSelection(chatId, text, pending);
    }
    if (pending.type === "session") {
      return this.handleSessionSelection(chatId, senderId, text, pending);
    }
    return false;
  }

  /** Handle project number selection */
  private async handleProjectSelection(
    chatId: string,
    text: string,
    pending: DingTalkPendingSelection,
  ): Promise<boolean> {
    // Empty project list — re-fetch to check if projects are now available
    if (!pending.projects || pending.projects.length === 0) {
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
    senderId: string,
    text: string,
    pending: DingTalkPendingSelection,
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

    if (this.sessionMapper.hasGroupForConversation(session.id)) {
      await this.transport!.sendText(
        chatId,
        "📋 此会话已有对应的群聊，请直接在群聊中发送消息。",
      );
      return true;
    }

    await this.createGroupForSession(
      senderId,
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
      dingtalkLog.info(`Replied to question ${pendingQ.questionId} with freeform answer`);
      return;
    }

    // Regular message → send to engine
    await this.sendToEngine(groupChatId, binding, text);
  }

  private async handleGroupCommand(
    groupChatId: string,
    binding: DingTalkGroupBinding,
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
  // Group Creation (Scene Group — 场景群)
  // ============================================================================

  private async createGroupForSession(
    ownerUserId: string,
    conversationId: string,
    engineType: EngineType,
    directory: string,
    projectId: string,
    projectName: string,
    p2pChatId?: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport || !this.tokenManager) return;

    // Check if session already has a group
    if (this.sessionMapper.hasGroupForConversation(conversationId)) {
      if (p2pChatId) {
        await this.transport.sendText(
          p2pChatId,
          "📋 此会话已有对应的群聊，请查看钉钉群列表。",
        );
      }
      dingtalkLog.warn(`Conversation ${conversationId} already has a group`);
      return;
    }

    // Concurrency guard
    if (!this.sessionMapper.markCreating(conversationId)) {
      dingtalkLog.warn(`Conversation ${conversationId} group creation already in progress`);
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

      const groupName = `[${projectName}] ${sessionTitle}`;
      const token = await this.tokenManager.getToken();

      // Create DingTalk scene group (场景群) via REST API
      const newChatId = await this.transport.createSceneGroup(
        token,
        groupName,
        ownerUserId,
        [ownerUserId],
      );

      if (!newChatId) {
        dingtalkLog.error("Failed to create scene group: no openConversationId returned");
        if (p2pChatId) {
          await this.transport.sendText(p2pChatId, "📋 创建群聊失败，请重试。");
        }
        return;
      }

      dingtalkLog.info(`Created scene group: ${newChatId} for conversation ${conversationId}`);

      // Register group binding
      this.sessionMapper.createGroupBinding({
        chatId: newChatId,
        conversationId,
        engineType,
        directory,
        projectId,
        ownerUserId,
        streamingSessions: new Map(),
        createdAt: Date.now(),
      });

      // Send welcome message to the new group
      const welcomeText = [
        "📋 **CodeMux 会话**",
        "",
        `**项目:** ${projectName}`,
        `**引擎:** ${engineType}`,
        `**会话:** ${conversationId}`,
        "",
        "发送消息即可开始对话。可用命令：",
        "/cancel — 取消当前正在运行的消息",
        "/status — 查看会话信息",
        "/mode — 切换模式",
        "/model — 切换模型",
        "/history — 查看会话历史记录",
        "/help — 显示可用命令",
      ].join("\n");
      await this.transport.sendText(newChatId, welcomeText);

      // Notify user in P2P
      if (p2pChatId) {
        await this.transport.sendText(
          p2pChatId,
          `📋 已为会话创建群聊，请查看钉钉群列表中的"${groupName}"。`,
        );
      }
    } catch (err) {
      dingtalkLog.error("Failed to create group for session:", err);
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

  // ============================================================================
  // Send Message to Engine
  // ============================================================================

  private async sendToEngine(
    groupChatId: string,
    binding: DingTalkGroupBinding,
    text: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport || !this.streamingController) return;

    // DingTalk batch mode (no message update) — no placeholder message
    // Register streaming session immediately with placeholder key
    const placeholderKey = `pending_${Date.now()}`;
    const streamingSession = createStreamingSession(groupChatId, binding.conversationId, "");
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
        dingtalkLog.error("sendMessage failed:", err);
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
    binding: DingTalkGroupBinding,
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
      dingtalkLog.info(`Auto-approving permission: ${permission.id}`);
      this.gatewayClient.replyPermission({
        permissionId: permission.id,
        optionId: acceptOption.id,
      });
    }
  }

  private handleQuestionAsked(question: UnifiedQuestion): void {
    // Try group binding first
    const groupChatId = this.sessionMapper.findGroupByConversationId(question.sessionId)?.chatId;

    // Fallback to P2P temp session
    const targetChatId = groupChatId || this.sessionMapper.findP2PChatByTempConversation(question.sessionId);
    if (!targetChatId) return;

    if (question.questions && question.questions.length > 0) {
      const q = question.questions[0];
      const options = q.options.map((o, i) => ({ id: String(i), label: o.label || o.description }));
      const text = buildQuestionText(
        q.question || "Agent 有一个问题：",
        options,
      );
      this.transport!.sendText(targetChatId, text);

      this.sessionMapper.setPendingQuestion(targetChatId, {
        questionId: question.id,
        sessionId: question.sessionId,
      });
    } else {
      this.transport!.sendText(targetChatId, "📋 Agent 提问（无选项）");
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

    // DingTalk scene groups support renaming via API, but the current
    // transport doesn't implement it. Group name update can be added
    // when the DingTalk Stream SDK is integrated.
    dingtalkLog.verbose(
      `Session ${session.id} title updated to "${session.title}" (group rename not implemented)`,
    );
  }
}
