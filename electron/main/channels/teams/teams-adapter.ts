// ============================================================================
// Microsoft Teams Channel Adapter
// Connects a Teams bot to CodeMux via Gateway WebSocket.
// Architecture: P2P (personal chat) is primary, group/channel chats supported
// when bot is added to an existing group — bot cannot create teams/channels.
//
// Teams specifics:
//   - Bot Framework REST API via fetch (no botbuilder SDK)
//   - Webhook: HTTP POST to /api/messages
//   - Auth: Azure AD App Registration (App ID + App Password)
//   - Activities: "message", "conversationUpdate", "invoke"
//   - Message update via PUT (streaming edit-in-place)
//   - Message delete via DELETE
//   - Rich content via Adaptive Cards (v1.5)
//   - @mentions in channels/groups via <at>BotName</at> tags
//   - Activities must be processed within 15s (respond 200/202 fast)
//   - Message size limit ~80KB
// ============================================================================

import {
  ChannelAdapter,
  type ChannelConfig,
  type ChannelInfo,
  type ChannelCapabilities,
  type ChannelStatus,
  type WebhookMeta,
} from "../channel-adapter";
import { GatewayWsClient } from "../gateway-ws-client";
import { StreamingController } from "../streaming/streaming-controller";
import { TokenBucket } from "../streaming/rate-limiter";
import { BaseSessionMapper, type PersistedBinding } from "../base-session-mapper";
import { createStreamingSession, type StreamingSession } from "../streaming/streaming-types";
import { didConfigValuesChange, mergeDefinedConfig } from "../config-utils";
import { TeamsTransport } from "./teams-transport";
import { TeamsRenderer } from "./teams-renderer";
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
  DEFAULT_TEAMS_CONFIG,
  TEMP_SESSION_TTL_MS,
  type TeamsConfig,
  type TeamsGroupBinding,
  type TeamsTempSession,
  type TeamsPendingSelection,
  type TeamsActivity,
  type TeamsConversationReference,
  type TeamsPersistedBinding,
} from "./teams-types";
import type {
  EngineType,
  UnifiedPart,
  UnifiedMessage,
  UnifiedPermission,
  UnifiedQuestion,
} from "../../../../src/types/unified";
import { channelLog } from "../../services/logger";
import type { WebhookServer, WebhookRequest, WebhookResponse } from "../webhook-server";

const LOG_PREFIX = "[Teams]";

// ============================================================================
// Teams Session Mapper (extends BaseSessionMapper with TeamsGroupBinding)
// ============================================================================

class TeamsSessionMapper extends BaseSessionMapper<TeamsGroupBinding> {
  constructor() {
    super("teams");
  }

  /** Override to persist serviceUrl for group bindings */
  protected serializeBinding(binding: TeamsGroupBinding): PersistedBinding {
    return {
      ...super.serializeBinding(binding),
      serviceUrl: binding.serviceUrl,
    };
  }

  /** Override to restore serviceUrl from persisted data */
  protected deserializeBinding(item: PersistedBinding): TeamsGroupBinding {
    const base = super.deserializeBinding(item);
    return {
      ...base,
      serviceUrl: (item as unknown as TeamsPersistedBinding).serviceUrl || "",
    };
  }
}

// ============================================================================
// Teams Adapter
// ============================================================================

export class TeamsAdapter extends ChannelAdapter {
  readonly channelType = "teams";

  override getWebhookMeta(): WebhookMeta {
    return { path: "/api/messages", platformConfigGuide: "channel.teamsWebhookGuide" };
  }

  // --- State ---
  private status: ChannelStatus = "stopped";
  private error?: string;
  private config: TeamsConfig = { ...DEFAULT_TEAMS_CONFIG };

  // --- Internal ---
  private gatewayClient: GatewayWsClient | null = null;
  private sessionMapper = new TeamsSessionMapper();
  // Teams: conservative rate limit — 1 msg/sec burst of 5
  private rateLimiter = new TokenBucket(5, 1);

  // --- Streaming Architecture ---
  private transport: TeamsTransport | null = null;
  private renderer = new TeamsRenderer();
  private streamingController: StreamingController | null = null;

  // --- Webhook ---
  private webhookServer: WebhookServer | null = null;

  // --- Conversation References (for proactive messaging) ---
  private conversationRefs = new Map<string, TeamsConversationReference>();

  /**
   * Teams capabilities:
   *   - supportsMessageUpdate: true (PUT activity for bot's own messages)
   *   - supportsMessageDelete: true (DELETE activity for bot's own messages)
   *   - supportsRichContent: true (Adaptive Cards v1.5)
   *   - maxMessageBytes: ~80KB
   */
  private static readonly CAPABILITIES: ChannelCapabilities = {
    supportsMessageUpdate: true,
    supportsMessageDelete: true,
    supportsRichContent: true,
    maxMessageBytes: 80_000,
  };

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
      DEFAULT_TEAMS_CONFIG,
      config.options as Partial<TeamsConfig> | undefined,
    );

    channelLog.info(
      `${LOG_PREFIX} Config: appId=${this.config.microsoftAppId}, tenantId=${this.config.tenantId || "(none)"}`,
    );

    if (!this.config.microsoftAppId || !this.config.microsoftAppPassword) {
      this.status = "error";
      this.error = "Missing microsoftAppId or microsoftAppPassword";
      this.emit("status.changed", this.status);
      throw new Error("Teams microsoftAppId and microsoftAppPassword are required");
    }

    try {
      // 1. Create transport and streaming controller
      this.transport = new TeamsTransport(
        this.config.microsoftAppId,
        this.config.microsoftAppPassword,
        this.rateLimiter,
        this.config.tenantId || undefined,
      );
      this.streamingController = new StreamingController(
        this.transport,
        this.renderer,
        { throttleMs: this.config.streamingThrottleMs },
        TeamsAdapter.CAPABILITIES,
      );

      // 2. Connect to local Gateway
      this.gatewayClient = new GatewayWsClient(this.config.gatewayUrl);
      await this.gatewayClient.connect();
      channelLog.info(`${LOG_PREFIX} Gateway WS client connected`);

      // 3. Restore persisted group bindings from disk
      this.sessionMapper.loadBindings();

      // Restore serviceUrls for persisted bindings
      this.restoreServiceUrls();

      // 4. Subscribe to Gateway notifications
      this.subscribeGatewayEvents();

      // 5. Register webhook route on the shared WebhookServer
      if (this.webhookServer) {
        this.webhookServer.registerRoute("/api/messages", (req) =>
          this.handleWebhookRequest(req),
        );
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

    // Unregister webhook route (keep webhookServer ref for restart)
    if (this.webhookServer) {
      this.webhookServer.unregisterRoute("/api/messages");
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
    this.conversationRefs.clear();

    this.status = "stopped";
    this.error = undefined;
    this.emit("status.changed", this.status);
    this.emit("disconnected", "stopped");
    channelLog.info(`${LOG_PREFIX} Adapter stopped`);
  }

  getInfo(): ChannelInfo {
    return {
      type: this.channelType,
      name: "Microsoft Teams Bot",
      status: this.status,
      error: this.error,
      stats: {
        activeConversations: this.conversationRefs.size,
      },
    };
  }

  async updateConfig(config: Partial<ChannelConfig>): Promise<void> {
    const wasRunning = this.status === "running";
    const newOptions = config.options as Partial<TeamsConfig> | undefined;
    const previousConfig = { ...this.config };

    if (newOptions) {
      this.config = mergeDefinedConfig(this.config, newOptions);
    }

    const shouldRestart = wasRunning && didConfigValuesChange(
      previousConfig,
      this.config,
      ["microsoftAppId", "microsoftAppPassword", "tenantId"],
    );

    if (shouldRestart) {
      channelLog.info(`${LOG_PREFIX} Credentials or tenant changed, restarting adapter`);
      await this.stop();
      const fullConfig: ChannelConfig = {
        type: "teams",
        name: "Microsoft Teams Bot",
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
  // Webhook Handler
  // ============================================================================

  private async handleWebhookRequest(
    req: WebhookRequest,
  ): Promise<WebhookResponse> {
    if (req.method !== "POST") {
      return { status: 405, body: "Method Not Allowed" };
    }

    // Auth validation
    if (!this.config.skipAuth) {
      const authHeader =
        req.headers["authorization"] || req.headers["Authorization"];
      if (!authHeader || typeof authHeader !== "string") {
        channelLog.warn(
          `${LOG_PREFIX} Missing Authorization header. ` +
          "Set skipAuth=true for dev mode, or configure proper auth for production.",
        );
        return { status: 401, body: "Unauthorized" };
      }
      if (!authHeader.startsWith("Bearer ")) {
        return { status: 401, body: "Invalid Authorization header format" };
      }
      // Basic format check only — full JWT validation would require a JWT library.
      // For production, consider adding proper JWT verification.
      channelLog.verbose(
        `${LOG_PREFIX} Authorization header present (basic format check only)`,
      );
    }

    const activity = req.body as TeamsActivity;
    if (!activity || !activity.type) {
      return { status: 400, body: "Invalid activity" };
    }

    // MUST respond quickly (within 15s) — process asynchronously
    void this.processActivity(activity);

    return { status: 202, body: "" };
  }

  // ============================================================================
  // Activity Processing
  // ============================================================================

  private async processActivity(activity: TeamsActivity): Promise<void> {
    // Store serviceUrl for this conversation
    if (activity.serviceUrl && activity.conversation?.id) {
      this.transport?.setServiceUrl(
        activity.conversation.id,
        activity.serviceUrl,
      );

      // Store conversation reference for proactive messaging
      this.conversationRefs.set(activity.conversation.id, {
        serviceUrl: activity.serviceUrl,
        conversationId: activity.conversation.id,
        botId: activity.recipient?.id || this.config.microsoftAppId,
        tenantId: activity.conversation.tenantId,
      });
    }

    switch (activity.type) {
      case "message":
        await this.handleMessage(activity);
        break;
      case "conversationUpdate":
        await this.handleConversationUpdate(activity);
        break;
      case "invoke":
        await this.handleInvoke(activity);
        break;
      default:
        channelLog.verbose(
          `${LOG_PREFIX} Ignoring activity type: ${activity.type}`,
        );
    }
  }

  // ============================================================================
  // Message Handling
  // ============================================================================

  private async handleMessage(activity: TeamsActivity): Promise<void> {
    const { from, conversation, text } = activity;

    // Skip messages without text or from the bot itself
    if (!text || !from) return;
    if (from.id === activity.recipient?.id) return;

    // Deduplication
    const dedupKey = `${conversation.id}:${activity.id}`;
    if (this.sessionMapper.isDuplicate(dedupKey)) {
      channelLog.verbose(`${LOG_PREFIX} Skipping duplicate message: ${dedupKey}`);
      return;
    }

    const chatId = conversation.id;
    const userId = from.aadObjectId || from.id;
    const displayName = from.name || userId;
    const convType = conversation.conversationType || "personal";

    channelLog.info(
      `${LOG_PREFIX} Message from ${convType} ` +
      `(${displayName}): ${text.slice(0, 100)}`,
    );

    if (convType === "personal") {
      // Personal (P2P) message
      const p2p = this.sessionMapper.getOrCreateP2PChat(chatId, userId);
      (p2p as any).displayName = displayName;
      this.sessionMapper.setUserIdMapping(userId, chatId);
      await this.handleP2PMessage(chatId, userId, text);
    } else {
      // Group or channel message
      const botId = activity.recipient?.id || this.config.microsoftAppId;
      const hasMention = this.isBotMentioned(activity, botId);
      const isCommand = text.trim().startsWith("/");
      const hasPending = !!this.sessionMapper.getPendingSelection(chatId);
      const hasPendingQuestion = !!this.sessionMapper.getPendingQuestion(chatId);

      if (hasMention || isCommand || hasPending || hasPendingQuestion) {
        const content = this.stripMentions(text);
        await this.handleGroupMessage(chatId, content, activity.serviceUrl);
      }
    }
  }

  /**
   * Check if the bot is @mentioned in a Teams activity.
   */
  private isBotMentioned(activity: TeamsActivity, botId: string): boolean {
    if (!activity.entities) return false;

    for (const entity of activity.entities) {
      if (
        entity.type === "mention" &&
        entity.mentioned?.id === botId
      ) {
        return true;
      }
    }
    return false;
  }

  // ============================================================================
  // Conversation Update Handling
  // ============================================================================

  private async handleConversationUpdate(
    activity: TeamsActivity,
  ): Promise<void> {
    const botId = activity.recipient?.id || this.config.microsoftAppId;

    // Bot added to conversation — send welcome message
    if (activity.membersAdded?.some((m) => m.id === botId)) {
      const chatId = activity.conversation.id;
      channelLog.info(`${LOG_PREFIX} Bot added to conversation: ${chatId}`);

      if (this.transport) {
        this.transport.setServiceUrl(chatId, activity.serviceUrl);
        await this.transport.sendMarkdown(
          chatId,
          "👋 你好！我是 CodeMux Bot。\n\n" +
          "使用 `/help` 查看可用命令，或直接发送消息开始对话。",
        );
      }
    }

    // Bot removed from conversation — clean up bindings
    if (activity.membersRemoved?.some((m) => m.id === botId)) {
      const chatId = activity.conversation.id;
      channelLog.info(`${LOG_PREFIX} Bot removed from conversation: ${chatId}`);
      this.sessionMapper.removeGroupBinding(chatId);
      this.conversationRefs.delete(chatId);
    }
  }

  // ============================================================================
  // Invoke Handling (Adaptive Card Action.Submit)
  // ============================================================================

  private async handleInvoke(activity: TeamsActivity): Promise<void> {
    if (!this.gatewayClient || !activity.value) return;

    const value = activity.value as Record<string, unknown>;
    const action = value.action as string;
    const chatId = activity.conversation.id;

    switch (action) {
      case "perm": {
        // Permission reply
        const permissionId = value.permissionId as string;
        const optionId = value.optionId as string;
        if (permissionId && optionId) {
          await this.gatewayClient.replyPermission({ permissionId, optionId });
          channelLog.info(
            `${LOG_PREFIX} Permission ${permissionId} replied via card: ${optionId}`,
          );
        }
        break;
      }
      case "question": {
        // Question reply from Adaptive Card Input.ChoiceSet
        const questionId = value.questionId as string;
        const selectedOption = value.selectedOption as string;
        if (questionId && selectedOption) {
          this.sessionMapper.clearPendingQuestion(chatId);
          await this.gatewayClient.replyQuestion({
            questionId,
            answers: [[selectedOption]],
          });
          channelLog.info(
            `${LOG_PREFIX} Question ${questionId} replied via card: ${selectedOption}`,
          );
        }
        break;
      }
      default:
        channelLog.verbose(`${LOG_PREFIX} Unknown invoke action: ${action}`);
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

  private async handleP2PMessage(
    chatId: string,
    userId: string,
    text: string,
  ): Promise<void> {
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
      channelLog.info(
        `${LOG_PREFIX} Replied to question ${pendingQ.questionId} with freeform answer`,
      );
      return;
    }

    // 3. Check for pending selection (number reply or "new")
    const pending = this.sessionMapper.getPendingSelection(chatId);
    if (pending) {
      const handled = await this.handlePendingSelection(
        chatId,
        userId,
        text,
        pending,
      );
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
      await this.createTempSessionAndSend(
        chatId,
        p2pState.lastSelectedProject,
        text,
      );
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
        sendText: (text) => this.transport!.sendMarkdown(chatId, text),
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
        await this.transport.sendMarkdown(chatId, buildHelpText(P2P_CAPABILITIES));
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
        await this.transport.sendMarkdown(
          chatId,
          `📋 未知命令：\`/${command.command}\`。使用 \`/help\` 查看可用命令。`,
        );
    }
  }

  /** /new — create a new session under the last selected project (P2P only). */
  private async handleP2PNewCommand(chatId: string): Promise<void> {
    if (!this.transport) return;
    const p2pState = this.sessionMapper.getP2PChat(chatId);
    if (!p2pState?.lastSelectedProject) {
      await this.transport.sendMarkdown(
        chatId,
        "📋 当前未选择项目。请先使用 `/project` 选择项目。",
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

  /** /switch — list existing sessions in the last selected project (P2P only). */
  private async handleP2PSwitchCommand(chatId: string): Promise<void> {
    if (!this.transport) return;
    const p2pState = this.sessionMapper.getP2PChat(chatId);
    if (!p2pState?.lastSelectedProject) {
      await this.transport.sendMarkdown(
        chatId,
        "📋 当前未选择项目。请先使用 `/project` 选择项目。",
      );
      return;
    }
    const project = p2pState.lastSelectedProject;
    const projectName = project.directory.split(/[\\/]/).pop() || project.directory;
    await this.showSessionListForProject(chatId, project, projectName);
  }

  /** Strip Teams <at>BotName</at> mention tags from message text. */
  private stripMentions(text: string): string {
    return text.replace(/<at>.*?<\/at>/gi, "").trim();
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
      await this.transport!.sendMarkdown(chatId, buildProjectListText(projects));
      const flatProjects = this.flattenProjectsByEngine(projects);
      this.sessionMapper.setPendingSelection(chatId, {
        type: "project",
        projects: flatProjects,
      });
    } else {
      const defaultProject = allProjects.find(p => p.isDefault);
      if (defaultProject) {
        await this.transport!.sendMarkdown(chatId, buildProjectListText([]));
      } else {
        await this.transport!.sendMarkdown(chatId, buildProjectListText([]));
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
    project: {
      directory: string;
      engineType?: EngineType;
      projectId: string;
    },
    projectName: string,
  ): Promise<void> {
    if (!this.gatewayClient) return;
    const sessions = await this.gatewayClient.listAllSessions();
    const filtered = sessions.filter((s) => s.projectId === project.projectId);
    const sorted = groupAndSortSessions(filtered);
    const sessionText = buildSessionListText(sorted, projectName);
    await this.transport!.sendMarkdown(chatId, sessionText);

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
    project: {
      directory: string;
      engineType?: EngineType;
      projectId: string;
    },
    projectName: string,
  ): Promise<void> {
    if (!this.gatewayClient) return;
    try {
      const session = await this.gatewayClient.createSession({
        engineType: project.engineType,
        directory: project.directory,
      });

      const tempSession: TeamsTempSession = {
        conversationId: session.id,
        engineType: session.engineType,
        directory: project.directory,
        projectId: project.projectId,
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: false,
      };

      this.sessionMapper.setTempSession(chatId, tempSession);

      await this.transport!.sendMarkdown(
        chatId,
        buildSessionNotification(projectName, session.engineType, session.id),
      );
    } catch (err) {
      await this.transport!.sendMarkdown(
        chatId,
        `📋 创建会话失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ============================================================================
  // P2P Temp Session Methods
  // ============================================================================

  /** Check if a temp session has expired (2h since last activity) */
  private isTempSessionExpired(temp: TeamsTempSession): boolean {
    return Date.now() - temp.lastActiveAt > TEMP_SESSION_TTL_MS;
  }

  /** Create a temp session for the given project and send the first message */
  private async createTempSessionAndSend(
    chatId: string,
    project: {
      directory: string;
      engineType?: EngineType;
      projectId: string;
    },
    text: string,
    projectName?: string,
  ): Promise<void> {
    if (!this.gatewayClient) return;

    try {
      const session = await this.gatewayClient.createSession({
        engineType: project.engineType,
        directory: project.directory,
      });

      const tempSession: TeamsTempSession = {
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
      await this.transport!.sendMarkdown(chatId, buildSessionNotification(name, session.engineType, session.id));
      await this.enqueueP2PMessage(chatId, text);
    } catch (err) {
      await this.transport!.sendMarkdown(
        chatId,
        `📋 创建临时会话失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Enqueue a message for serial processing in the P2P temp session */
  private async enqueueP2PMessage(
    chatId: string,
    text: string,
  ): Promise<void> {
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
    tempSession: TeamsTempSession,
    text: string,
  ): Promise<void> {
    if (
      !this.gatewayClient ||
      !this.transport ||
      !this.streamingController
    ) {
      tempSession.processing = false;
      channelLog.error(
        `${LOG_PREFIX} Gateway client not connected, cannot send P2P message`,
      );
      return;
    }

    tempSession.lastActiveAt = Date.now();

    // Teams supports message update → streaming mode
    // Send "thinking..." placeholder
    const placeholderText = this.renderer.renderStreamingUpdate("");
    const compoundId = await this.transport.sendText(chatId, placeholderText);

    const streaming = createStreamingSession(
      chatId,
      tempSession.conversationId,
      compoundId,
    );
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
      channelLog.info(
        `${LOG_PREFIX} Deleted expired temp session: ${temp.conversationId}`,
      );
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
    pending: TeamsPendingSelection,
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
    pending: TeamsPendingSelection,
  ): Promise<boolean> {
    // Empty project list — clear stale pending state before re-fetching
    if (!pending.projects || pending.projects.length === 0) {
      this.sessionMapper.clearPendingSelection(chatId);
      await this.showProjectList(chatId);
      return true;
    }

    const num = parseInt(text.trim(), 10);
    if (
      isNaN(num) ||
      num < 1 ||
      num > pending.projects.length
    ) {
      return false;
    }

    const project = pending.projects[num - 1];
    const projectName =
      project.name || project.directory.split(/[\\/]/).pop() || project.directory;

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
    pending: TeamsPendingSelection,
  ): Promise<boolean> {
    const trimmed = text.trim().toLowerCase();
    if (!pending.directory || !pending.projectId) {
      return false;
    }

    const num = parseInt(trimmed, 10);
    if (
      isNaN(num) ||
      num < 1 ||
      !pending.sessions ||
      num > pending.sessions.length
    ) {
      return false;
    }

    const session = pending.sessions[num - 1];
    this.sessionMapper.clearPendingSelection(chatId);

    // Bind the selected session as a temp session for P2P
    const tempSession: TeamsTempSession = {
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
    await this.transport!.sendMarkdown(
      chatId,
      buildSessionNotification(projectName, session.engineType, session.id),
    );
    return true;
  }

  // ============================================================================
  // Group / Channel Message Handling
  // ============================================================================

  private async handleGroupMessage(
    groupChatId: string,
    text: string,
    serviceUrl: string,
  ): Promise<void> {
    const binding = this.sessionMapper.getGroupBinding(groupChatId);

    if (!binding) {
      // Check for pending selection first (from a previous /bind flow)
      const pending = this.sessionMapper.getPendingSelection(groupChatId);
      if (pending) {
        const handled = await this.handleGroupPendingSelection(
          groupChatId,
          text,
          pending,
          serviceUrl,
        );
        if (handled) return;
      }

      // No binding yet — show help on how to bind
      const command = parseCommand(text);
      if (command?.command === "help") {
        await this.transport!.sendMarkdown(
          groupChatId,
          buildHelpText(GROUP_CAPABILITIES, { requiresMention: true }),
        );
      } else if (command?.command === "bind") {
        // /bind — show project list for group binding
        await this.showGroupProjectList(groupChatId, serviceUrl);
      } else {
        await this.transport!.sendMarkdown(
          groupChatId,
          "📋 此群聊未绑定到 CodeMux 会话。使用 `/bind` 绑定项目。",
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
      channelLog.info(
        `${LOG_PREFIX} Replied to question ${pendingQ.questionId} with freeform answer`,
      );
      return;
    }

    // Regular message → send to engine
    await this.sendToEngine(groupChatId, binding, text);
  }

  /** Show project list for group binding selection */
  private async showGroupProjectList(
    groupChatId: string,
    serviceUrl: string,
  ): Promise<void> {
    if (!this.gatewayClient) return;

    const projects = await this.gatewayClient.listAllProjects();
    const text = buildProjectListText(projects);
    await this.transport!.sendMarkdown(groupChatId, text);

    if (projects.length > 0) {
      const flatProjects = this.flattenProjectsByEngine(projects);
      this.sessionMapper.setPendingSelection(groupChatId, {
        type: "project",
        projects: flatProjects,
      });
    }
  }

  /** Handle pending selection reply in group context (project or session) */
  private async handleGroupPendingSelection(
    groupChatId: string,
    text: string,
    pending: TeamsPendingSelection,
    serviceUrl: string,
  ): Promise<boolean> {
    if (pending.type === "project") {
      return this.handleGroupProjectSelection(
        groupChatId,
        text,
        pending,
        serviceUrl,
      );
    }
    if (pending.type === "session") {
      return this.handleGroupSessionSelection(
        groupChatId,
        text,
        pending,
        serviceUrl,
      );
    }
    return false;
  }

  /** Handle project number selection for group binding */
  private async handleGroupProjectSelection(
    groupChatId: string,
    text: string,
    pending: TeamsPendingSelection,
    serviceUrl: string,
  ): Promise<boolean> {
    // Empty project list — clear stale pending state before re-fetching
    if (!pending.projects || pending.projects.length === 0) {
      this.sessionMapper.clearPendingSelection(groupChatId);
      await this.showGroupProjectList(groupChatId, serviceUrl);
      return true;
    }

    const num = parseInt(text.trim(), 10);
    if (
      isNaN(num) ||
      num < 1 ||
      num > pending.projects.length
    ) {
      return false;
    }

    const project = pending.projects[num - 1];
    const projectName =
      project.name || project.directory.split(/[\\/]/).pop() || project.directory;

    this.sessionMapper.clearPendingSelection(groupChatId);

    // Show session list for group binding
    if (!this.gatewayClient) return false;
    const sessions = await this.gatewayClient.listAllSessions();
    const filtered = sessions.filter((s) => s.projectId === project.id);
    const sorted = groupAndSortSessions(filtered);
    // Group-bind flow keeps the legacy "new" keyword: /new isn't a group command,
    // so this is the only way to create a session for the binding.
    const sessionText = buildSessionListText(sorted, projectName, {
      newHint: "keyword",
    });
    await this.transport!.sendMarkdown(groupChatId, sessionText);

    this.sessionMapper.setPendingSelection(groupChatId, {
      type: "session",
      sessions: sorted,
      engineType: project.engineType,
      directory: project.directory,
      projectId: project.id,
      projectName,
    });
    return true;
  }

  /** Handle session selection for group binding — creates a group binding */
  private async handleGroupSessionSelection(
    groupChatId: string,
    text: string,
    pending: TeamsPendingSelection,
    serviceUrl: string,
  ): Promise<boolean> {
    if (!pending.directory || !pending.projectId) {
      return false;
    }
    if (!this.gatewayClient) return false;

    const trimmed = text.trim().toLowerCase();
    let conversationId: string;
    let sessionTitle: string;
    let selectedEngineType = pending.engineType!;

    if (trimmed === "new") {
      // Create a new session
      try {
        const session = await this.gatewayClient.createSession({
          engineType: pending.engineType,
          directory: pending.directory,
        });
        conversationId = session.id;
        sessionTitle = session.title || session.id.slice(0, 8);
      } catch (err) {
        this.sessionMapper.clearPendingSelection(groupChatId);
        await this.transport!.sendMarkdown(
          groupChatId,
          `📋 创建会话失败：${err instanceof Error ? err.message : String(err)}`,
        );
        return true;
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (
        isNaN(num) ||
        num < 1 ||
        !pending.sessions ||
        num > pending.sessions.length
      ) {
        return false;
      }
      const session = pending.sessions[num - 1];
      conversationId = session.id;
      sessionTitle = session.title || session.id.slice(0, 8);
      selectedEngineType = session.engineType;
    }

    this.sessionMapper.clearPendingSelection(groupChatId);

    // Create group binding
    const binding: TeamsGroupBinding = {
      chatId: groupChatId,
      conversationId,
      engineType: selectedEngineType,
      directory: pending.directory,
      projectId: pending.projectId,
      serviceUrl,
      streamingSessions: new Map(),
      createdAt: Date.now(),
    };
    this.sessionMapper.createGroupBinding(binding);

    const projectName =
      pending.projectName ||
      pending.directory.split(/[\\/]/).pop() ||
      pending.directory;
    await this.transport!.sendMarkdown(
      groupChatId,
      `✅ 群聊已绑定到项目 ${projectName}（会话：${sessionTitle}）\n@我 或使用 \`/command\` 与 AI 助手对话。`,
    );
    return true;
  }

  private async handleGroupCommand(
    groupChatId: string,
    binding: TeamsGroupBinding,
    command: ReturnType<typeof parseCommand>,
  ): Promise<void> {
    if (!command || !this.gatewayClient || !this.transport) return;

    const handled = await handleSessionOpsCommand(command, {
      sendText: (text) => this.transport!.sendMarkdown(groupChatId, text),
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
        await this.transport.sendMarkdown(
          groupChatId,
          buildHelpText(GROUP_CAPABILITIES, { requiresMention: true }),
        );
        break;

      default:
        await this.transport.sendMarkdown(
          groupChatId,
          `📋 未知命令：\`/${command.command}\`。使用 \`/help\` 查看可用命令。`,
        );
    }
  }

  // ============================================================================
  // Send Message to Engine (Group)
  // ============================================================================

  private async sendToEngine(
    groupChatId: string,
    binding: TeamsGroupBinding,
    text: string,
  ): Promise<void> {
    if (
      !this.gatewayClient ||
      !this.transport ||
      !this.streamingController
    ) {
      return;
    }

    // Teams supports message update → streaming mode
    // Send "thinking..." placeholder
    const placeholderText = this.renderer.renderStreamingUpdate("");
    const compoundId = await this.transport.sendText(
      groupChatId,
      placeholderText,
    );

    const streamingSession = createStreamingSession(
      groupChatId,
      binding.conversationId,
      compoundId,
    );

    // Register with placeholder key, re-key when messageId is known
    const placeholderKey = `pending_${Date.now()}`;
    this.sessionMapper.registerStreamingSession(
      groupChatId,
      placeholderKey,
      streamingSession,
    );

    // Send message to engine via Gateway (non-blocking)
    const sendPromise = this.gatewayClient.sendMessage({
      sessionId: binding.conversationId,
      content: [{ type: "text", text }],
    });

    sendPromise
      .then((msg) => {
        streamingSession.messageId = msg.id;
        binding.streamingSessions.delete(placeholderKey);
        this.sessionMapper.registerStreamingSession(
          groupChatId,
          msg.id,
          streamingSession,
        );
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

  private handlePartUpdated(
    conversationId: string,
    part: UnifiedPart,
  ): void {
    if (!this.streamingController) return;

    // Try group binding first
    const binding =
      this.sessionMapper.findGroupByConversationId(conversationId);
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
    const p2pChatId =
      this.sessionMapper.findP2PChatByTempConversation(conversationId);
    if (p2pChatId) {
      const tempSession = this.sessionMapper.getTempSession(p2pChatId);
      if (
        tempSession?.streamingSession &&
        !tempSession.streamingSession.completed
      ) {
        this.streamingController.applyPart(
          tempSession.streamingSession,
          part,
        );
      }
    }
  }

  private handleMessageCompleted(
    conversationId: string,
    message: UnifiedMessage,
  ): void {
    if (message.role !== "assistant") return;
    if (!message.time?.completed) return;

    // Try group binding first
    const binding =
      this.sessionMapper.findGroupByConversationId(conversationId);
    if (binding) {
      this.finalizeGroupStreaming(binding, conversationId, message);
      return;
    }

    // Try P2P temp session
    const p2pChatId =
      this.sessionMapper.findP2PChatByTempConversation(conversationId);
    if (p2pChatId) {
      void this.finalizeP2PStreaming(p2pChatId, message);
    }
  }

  /** Finalize streaming for a group binding */
  private finalizeGroupStreaming(
    binding: TeamsGroupBinding,
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
  private async finalizeP2PStreaming(
    chatId: string,
    message: UnifiedMessage,
  ): Promise<void> {
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
    const binding = this.sessionMapper.findGroupByConversationId(
      permission.sessionId,
    );
    const p2pChatId = this.sessionMapper.findP2PChatByTempConversation(
      permission.sessionId,
    );
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
        channelLog.info(
          `${LOG_PREFIX} Auto-approving permission: ${permission.id}`,
        );
        this.gatewayClient.replyPermission({
          permissionId: permission.id,
          optionId: acceptOption.id,
        });
        return;
      }
    }

    // Not auto-approved — send Adaptive Card with permission options
    if (
      !this.transport ||
      !permission.options ||
      permission.options.length === 0
    ) {
      return;
    }

    const options = permission.options.map((o: any) => ({
      id: o.id,
      label: o.label || o.id,
    }));

    const card = this.renderer.buildPermissionCard(
      permission.title || permission.id,
      options,
      permission.id,
    );

    void this.transport.sendAdaptiveCard(targetChatId, card);
  }

  private handleQuestionAsked(question: UnifiedQuestion): void {
    // Try group binding first
    const groupChatId = this.sessionMapper.findGroupByConversationId(
      question.sessionId,
    )?.chatId;

    // Fallback to P2P temp session
    const targetChatId =
      groupChatId ||
      this.sessionMapper.findP2PChatByTempConversation(question.sessionId);
    if (!targetChatId || !this.transport) return;

    if (question.questions && question.questions.length > 0) {
      const q = question.questions[0];
      const options = q.options.map((o, i) => ({
        id: String(i),
        label: o.label || o.description,
      }));

      // Send Adaptive Card with Input.ChoiceSet for question response
      const card = this.renderer.buildQuestionCard(
        q.question || "Agent 有一个问题：",
        options,
        question.id,
      );

      void this.transport.sendAdaptiveCard(targetChatId, card);

      this.sessionMapper.setPendingQuestion(targetChatId, {
        questionId: question.id,
        sessionId: question.sessionId,
      });
    } else {
      void this.transport.sendMarkdown(
        targetChatId,
        "📋 Agent 提问（无选项）",
      );
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

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Restore serviceUrls from persisted group bindings into the transport.
   * Called after loadBindings() to ensure the transport can reach all
   * previously-known conversations.
   */
  private restoreServiceUrls(): void {
    if (!this.transport) return;

    // Iterate all group bindings and register their serviceUrls
    // We access the protected map via the public getGroupBinding method
    // by iterating known conversation IDs
    const bindingsField = (this.sessionMapper as any).groupBindings as Map<
      string,
      TeamsGroupBinding
    >;
    for (const binding of bindingsField.values()) {
      if (binding.serviceUrl) {
        this.transport.setServiceUrl(binding.chatId, binding.serviceUrl);
        this.conversationRefs.set(binding.chatId, {
          serviceUrl: binding.serviceUrl,
          conversationId: binding.chatId,
          botId: this.config.microsoftAppId,
        });
      }
    }
  }
}
