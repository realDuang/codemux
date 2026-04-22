// ============================================================================
// WeChat iLink Channel Adapter
// Connects a WeChat personal-account bot (via iLink API) to CodeMux.
//
// Architecture:
//   - All chats are P2P (private). iLink does not expose group APIs.
//   - HTTP long-poll for inbound messages (35s server hold).
//   - HTTP POST for outbound messages, requires per-message context_token.
//   - No message edit / delete / rich content → batch streaming mode.
//   - No rate limiter (long-poll naturally throttles).
//   - QR auth flow happens out-of-band (see weixin-ilink-qr-flow.ts + IPC).
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
import { BaseSessionMapper } from "../base-session-mapper";
import { createStreamingSession } from "../streaming/streaming-types";
import { WeixinIlinkTransport } from "./weixin-ilink-transport";
import { WeixinIlinkRenderer } from "./weixin-ilink-renderer";
import { didConfigValuesChange, mergeDefinedConfig } from "../config-utils";
import {
  parseCommand,
  buildHelpText,
  buildProjectListText,
  buildSessionListText,
  buildQuestionText,
  buildHistoryEntries,
} from "./weixin-ilink-command-parser";
import {
  DEFAULT_WEIXIN_ILINK_CONFIG,
  TEMP_SESSION_TTL_MS,
  type WeixinIlinkConfig,
  type WeixinIlinkTempSession,
  type WeixinIlinkPendingSelection,
  type WeixinMessage,
} from "./weixin-ilink-types";
import type {
  EngineType,
  UnifiedPart,
  UnifiedMessage,
  UnifiedPermission,
  UnifiedQuestion,
} from "../../../../src/types/unified";
import { channelLog } from "../../services/logger";

const LOG_PREFIX = "[WeixinIlink]";

// Long-poll reconnect tuning
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 100;

// ============================================================================
// Session Mapper — P2P only (no group bindings used).
// ============================================================================

class WeixinIlinkSessionMapper extends BaseSessionMapper {
  constructor() {
    super("weixin-ilink");
  }
}

// ============================================================================
// Adapter
// ============================================================================

export class WeixinIlinkAdapter extends ChannelAdapter {
  readonly channelType = "weixin-ilink";

  // --- State ---
  private status: ChannelStatus = "stopped";
  private error?: string;
  private config: WeixinIlinkConfig = { ...DEFAULT_WEIXIN_ILINK_CONFIG };

  // --- Internal ---
  private gatewayClient: GatewayWsClient | null = null;
  private sessionMapper = new WeixinIlinkSessionMapper();

  // --- Streaming ---
  private transport: WeixinIlinkTransport | null = null;
  private renderer = new WeixinIlinkRenderer();
  private streamingController: StreamingController | null = null;

  // --- Long-poll loop ---
  private pollingActive = false;
  private pollingGeneration = 0;
  private pollAbortController: AbortController | null = null;
  private pollingLoopPromise: Promise<void> | null = null;
  private updatesBuf = "";
  private reconnectAttempts = 0;
  private connected = false;

  /**
   * iLink capabilities — no edit, no delete, no rich content.
   * → StreamingController operates in batch mode.
   */
  private static readonly CAPABILITIES: ChannelCapabilities = {
    supportsMessageUpdate: false,
    supportsMessageDelete: false,
    supportsRichContent: false,
    maxMessageBytes: 4096,
  };

  private isAbortError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const name = (error as { name?: unknown }).name;
    const msg = (error as { message?: unknown }).message;
    return name === "AbortError" || msg === "Aborted";
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

    this.config = mergeDefinedConfig(
      DEFAULT_WEIXIN_ILINK_CONFIG,
      config.options as Partial<WeixinIlinkConfig> | undefined,
    );

    if (!this.config.botToken) {
      this.status = "error";
      this.error = "Missing botToken — please complete QR login first";
      this.emit("status.changed", this.status);
      throw new Error("WeChat iLink botToken is required (complete QR login)");
    }

    try {
      this.transport = new WeixinIlinkTransport(
        this.config.botToken,
        this.config.baseUrl,
        this.config.accountId,
      );
      this.streamingController = new StreamingController(
        this.transport,
        this.renderer,
        { throttleMs: 1500 },
        WeixinIlinkAdapter.CAPABILITIES,
      );

      this.gatewayClient = new GatewayWsClient(this.config.gatewayUrl);
      await this.gatewayClient.connect();
      channelLog.info(`${LOG_PREFIX} Gateway WS client connected`);

      this.subscribeGatewayEvents();

      await this.startLongPolling();

      this.status = "running";
      this.emit("status.changed", this.status);
      this.emit("connected");
      channelLog.info(`${LOG_PREFIX} Adapter started successfully`);
    } catch (err) {
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.emit("status.changed", this.status);
      channelLog.error(`${LOG_PREFIX} Failed to start adapter:`, err);
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

    await this.stopPolling();

    this.sessionMapper.cleanup();

    if (this.gatewayClient) {
      this.gatewayClient.disconnect();
      this.gatewayClient = null;
    }

    this.transport = null;
    this.streamingController = null;
    this.updatesBuf = "";
    this.reconnectAttempts = 0;
    this.connected = false;

    this.status = "stopped";
    this.error = undefined;
    this.emit("status.changed", this.status);
    this.emit("disconnected", "stopped");
    channelLog.info(`${LOG_PREFIX} Adapter stopped`);
  }

  getInfo(): ChannelInfo {
    return {
      type: this.channelType,
      name: "WeChat iLink Bot",
      status: this.status,
      error: this.error,
      stats: {
        accountId: this.config.accountId,
        connected: this.connected,
        mode: "long-poll",
      },
    };
  }

  async updateConfig(config: Partial<ChannelConfig>): Promise<void> {
    const wasRunning = this.status === "running";
    const newOptions = config.options as Partial<WeixinIlinkConfig> | undefined;
    const previousConfig = { ...this.config };

    if (newOptions) {
      this.config = mergeDefinedConfig(this.config, newOptions);
    }

    const shouldRestart = wasRunning && didConfigValuesChange(
      previousConfig,
      this.config,
      ["botToken", "baseUrl", "accountId"],
    );

    if (shouldRestart) {
      channelLog.info(`${LOG_PREFIX} Credentials changed, restarting adapter`);
      await this.stop();
      const fullConfig: ChannelConfig = {
        type: "weixin-ilink",
        name: "WeChat iLink Bot",
        enabled: true,
        options: this.config as unknown as Record<string, unknown>,
      };
      await this.start(fullConfig);
    }
  }

  // ============================================================================
  // Long-Poll Loop
  // ============================================================================

  private async startLongPolling(): Promise<void> {
    if (!this.transport) return;

    this.pollingActive = true;
    this.updatesBuf = "";
    this.reconnectAttempts = 0;
    const generation = ++this.pollingGeneration;
    const abortController = new AbortController();
    this.pollAbortController = abortController;

    channelLog.info(`${LOG_PREFIX} Starting long-poll loop...`);

    const loopPromise = this.pollingLoop(generation, abortController.signal);
    const tracked = loopPromise.finally(() => {
      if (this.pollingLoopPromise === tracked) this.pollingLoopPromise = null;
      if (this.pollAbortController === abortController) this.pollAbortController = null;
    });
    this.pollingLoopPromise = tracked;
  }

  private async stopPolling(): Promise<void> {
    this.pollingActive = false;
    this.pollingGeneration += 1;
    this.pollAbortController?.abort();
    this.pollAbortController = null;

    const loopPromise = this.pollingLoopPromise;
    this.pollingLoopPromise = null;

    if (!loopPromise) return;

    try {
      await loopPromise;
    } catch (error) {
      if (!this.isAbortError(error)) {
        channelLog.warn(`${LOG_PREFIX} Polling loop exited with unexpected error during shutdown:`, error);
      }
    }
  }

  private async pollingLoop(generation: number, signal: AbortSignal): Promise<void> {
    while (this.pollingActive && this.transport && generation === this.pollingGeneration) {
      try {
        const response = await this.transport.getUpdates(this.updatesBuf, signal);

        if (!this.pollingActive || generation !== this.pollingGeneration) break;

        const ret = response.ret ?? response.errcode ?? 0;
        if (WeixinIlinkTransport.isSessionExpired(ret, response.errcode)) {
          channelLog.error(`${LOG_PREFIX} Session expired (-14) — re-auth via QR required`);
          this.connected = false;
          this.status = "error";
          this.error = "Session expired — re-auth required";
          this.emit("status.changed", this.status);
          this.pollingActive = false;
          break;
        }

        if (ret !== 0) {
          channelLog.warn(`${LOG_PREFIX} getupdates error ret=${ret} errcode=${response.errcode ?? "n/a"}; will retry`);
          this.connected = false;
          if (!(await this.backoffDelay(generation))) break;
          continue;
        }

        if (!this.connected) {
          this.connected = true;
          this.reconnectAttempts = 0;
          channelLog.info(`${LOG_PREFIX} Long-poll connected`);
        }

        if (response.get_updates_buf) {
          this.updatesBuf = response.get_updates_buf;
        }

        if (response.msgs && response.msgs.length > 0) {
          for (const msg of response.msgs) {
            if (!this.pollingActive || generation !== this.pollingGeneration) break;
            if (msg.message_type === 1) {
              void this.handleInboundMessage(msg);
            }
          }
        }
      } catch (err) {
        if (this.isAbortError(err) || !this.pollingActive || generation !== this.pollingGeneration) break;
        channelLog.error(`${LOG_PREFIX} Poll error:`, err);
        this.connected = false;
        if (!(await this.backoffDelay(generation))) break;
      }
    }
  }

  private async backoffDelay(generation: number): Promise<boolean> {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      channelLog.error(`${LOG_PREFIX} Max reconnect attempts reached, stopping`);
      this.pollingActive = false;
      return false;
    }
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempts++;
    channelLog.info(`${LOG_PREFIX} Backing off ${delay}ms (attempt ${this.reconnectAttempts})`);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    return this.pollingActive && generation === this.pollingGeneration;
  }

  // ============================================================================
  // Inbound Message Handling
  // ============================================================================

  private async handleInboundMessage(msg: WeixinMessage): Promise<void> {
    const userId = msg.from_user_id;
    if (!userId) return;

    // Deduplicate: prefer numeric message_id, fall back to context composite
    const dedupKey = msg.message_id != null
      ? `wx:${msg.message_id}`
      : `wx:${userId}:${msg.context_token ?? Date.now()}`;
    if (this.sessionMapper.isDuplicate(dedupKey)) {
      channelLog.verbose(`${LOG_PREFIX} Duplicate message skipped: ${dedupKey}`);
      return;
    }

    // Cache context_token (per-message, no expiry)
    if (msg.context_token && this.transport) {
      this.transport.setContextToken(userId, msg.context_token);
    }

    const text = this.extractText(msg);
    if (!text) {
      channelLog.verbose(`${LOG_PREFIX} Inbound msg from ${userId} had no text`);
      return;
    }

    channelLog.info(`${LOG_PREFIX} Inbound from ${userId}: ${text.slice(0, 100)}`);

    // chatId == userId for iLink (P2P only)
    const chatId = userId;
    const p2p = this.sessionMapper.getOrCreateP2PChat(chatId, userId);
    p2p.userId = userId;
    this.sessionMapper.setUserIdMapping(userId, chatId);

    await this.handleP2PMessage(chatId, userId, text);
  }

  private extractText(msg: WeixinMessage): string {
    const items = msg.item_list ?? [];
    const parts: string[] = [];
    for (const item of items) {
      switch (item.type) {
        case 1:
          if (item.text_item?.text) parts.push(item.text_item.text);
          break;
        case 2:
          parts.push("[Image]");
          break;
        case 3:
          if (item.voice_item?.text) parts.push(item.voice_item.text);
          else parts.push("[Voice]");
          break;
        case 4:
          parts.push(`[File: ${item.file_item?.filename ?? "unknown"}]`);
          break;
        case 5:
          parts.push("[Video]");
          break;
        default:
          parts.push(`[Unknown message type: ${item.type}]`);
      }
    }
    return parts.join("\n").trim();
  }

  // ============================================================================
  // P2P Message Routing
  // ============================================================================

  private async handleP2PMessage(chatId: string, _userId: string, text: string): Promise<void> {
    const command = parseCommand(text);
    if (command) {
      this.sessionMapper.clearPendingSelection(chatId);
      await this.handleP2PCommand(chatId, command);
      return;
    }

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

    const pending = this.sessionMapper.getPendingSelection(chatId);
    if (pending) {
      const handled = await this.handlePendingSelection(chatId, text, pending as WeixinIlinkPendingSelection);
      if (handled) return;
    }

    const tempSession = this.sessionMapper.getTempSession(chatId) as WeixinIlinkTempSession | undefined;
    if (tempSession && !this.isTempSessionExpired(tempSession)) {
      await this.enqueueP2PMessage(chatId, text);
      return;
    }

    const p2pState = this.sessionMapper.getP2PChat(chatId);
    if (p2pState?.lastSelectedProject && this.gatewayClient) {
      if (tempSession) await this.cleanupExpiredTempSession(chatId);
      await this.createTempSessionAndSend(chatId, p2pState.lastSelectedProject, text);
      return;
    }

    await this.showProjectList(chatId);
  }

  private async handleP2PCommand(
    chatId: string,
    command: ReturnType<typeof parseCommand>,
  ): Promise<void> {
    if (!command || !this.transport) return;

    switch (command.command) {
      case "help":
      case "start":
        await this.transport.sendText(chatId, buildHelpText());
        break;

      case "project":
        await this.showProjectList(chatId);
        break;

      case "cancel": {
        const temp = this.sessionMapper.getTempSession(chatId);
        if (temp && this.gatewayClient) {
          await this.gatewayClient.cancelMessage(temp.conversationId);
          await this.transport.sendText(chatId, "📋 消息已取消。");
        } else {
          await this.transport.sendText(chatId, "📋 当前没有正在运行的消息。");
        }
        break;
      }

      case "status": {
        const temp = this.sessionMapper.getTempSession(chatId);
        if (!temp) {
          await this.transport.sendText(chatId, "📋 当前没有活动会话。使用 /project 选择项目。");
          break;
        }
        const projectName = temp.directory.split(/[\\/]/).pop();
        const lines = [
          "📋 会话状态",
          `项目：${projectName}（${temp.engineType}）`,
          `会话：${temp.conversationId}`,
        ];
        await this.transport.sendText(chatId, lines.join("\n"));
        break;
      }

      case "mode": {
        const temp = this.sessionMapper.getTempSession(chatId);
        if (!temp || !this.gatewayClient) {
          await this.transport.sendText(chatId, "📋 当前没有活动会话。");
          break;
        }
        if (!command.args || command.args.length === 0) {
          await this.transport.sendText(chatId, "📋 用法：/mode <agent|plan|build>");
          break;
        }
        await this.gatewayClient.setMode({
          sessionId: temp.conversationId,
          modeId: command.args[0],
        });
        await this.transport.sendText(chatId, `📋 模式已切换为：${command.args[0]}`);
        break;
      }

      case "model": {
        const temp = this.sessionMapper.getTempSession(chatId);
        if (!temp || !this.gatewayClient) {
          await this.transport.sendText(chatId, "📋 当前没有活动会话。");
          break;
        }
        if (
          command.subcommand === "list" ||
          (!command.subcommand && (!command.args || command.args.length === 0))
        ) {
          const result = await this.gatewayClient.listModels(temp.engineType);
          const lines = ["📋 模型列表", "─────────────────────────"];
          for (const m of result.models) {
            const current = m.modelId === result.currentModelId ? "（当前）" : "";
            lines.push(`  ${m.name || m.modelId}${current}`);
          }
          lines.push("─────────────────────────");
          lines.push("使用 /model <model-id> 切换模型。");
          await this.transport.sendText(chatId, lines.join("\n"));
        } else if (command.args && command.args.length > 0) {
          await this.gatewayClient.setModel({
            sessionId: temp.conversationId,
            modelId: command.args[0],
          });
          await this.transport.sendText(chatId, `📋 模型已切换为：${command.args[0]}`);
        }
        break;
      }

      case "history": {
        const temp = this.sessionMapper.getTempSession(chatId);
        if (!temp || !this.gatewayClient) {
          await this.transport.sendText(chatId, "📋 当前没有活动会话。");
          break;
        }
        const messages = await this.gatewayClient.listMessages(temp.conversationId);
        const entries = buildHistoryEntries(messages);
        if (entries.length === 0) {
          await this.transport.sendText(chatId, "📋 暂无会话历史记录。");
        } else {
          await this.transport.sendText(chatId, "📋 会话历史");
          for (const entry of entries) {
            await this.transport.sendText(chatId, `${entry.emoji} ${entry.text}`);
          }
        }
        break;
      }

      default:
        await this.transport.sendText(
          chatId,
          `📋 未知命令：${command.command}。使用 /help 查看可用命令。`,
        );
    }
  }

  // ============================================================================
  // Selection State Machine
  // ============================================================================

  private async showProjectList(chatId: string): Promise<void> {
    if (!this.gatewayClient || !this.transport) return;
    const projects = await this.gatewayClient.listAllProjects();
    await this.transport.sendText(chatId, buildProjectListText(projects));
    if (projects.length > 0) {
      this.sessionMapper.setPendingSelection(chatId, {
        type: "project",
        projects,
      });
    }
  }

  private async showSessionListForProject(
    chatId: string,
    project: { directory: string; engineType?: EngineType; projectId: string },
    projectName: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport) return;
    const sessions = await this.gatewayClient.listAllSessions();
    const filtered = sessions.filter((s) => s.directory === project.directory);
    await this.transport.sendText(chatId, buildSessionListText(filtered, projectName));
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
    project: { directory: string; engineType?: EngineType; projectId: string },
    projectName: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport) return;
    try {
      const session = await this.gatewayClient.createSession({
        engineType: project.engineType,
        directory: project.directory,
      });

      const tempSession: WeixinIlinkTempSession = {
        conversationId: session.id,
        engineType: session.engineType,
        directory: project.directory,
        projectId: project.projectId,
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: false,
      };

      this.sessionMapper.setTempSession(chatId, tempSession);
      await this.transport.sendText(
        chatId,
        `📋 已创建会话：${projectName}\n发送消息即可开始对话。`,
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
    text: string,
    pending: WeixinIlinkPendingSelection,
  ): Promise<boolean> {
    if (pending.type === "project") return this.handleProjectSelection(chatId, text, pending);
    if (pending.type === "session") return this.handleSessionSelection(chatId, text, pending);
    return false;
  }

  private async handleProjectSelection(
    chatId: string,
    text: string,
    pending: WeixinIlinkPendingSelection,
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
    text: string,
    pending: WeixinIlinkPendingSelection,
  ): Promise<boolean> {
    if (!this.transport) return false;
    const trimmed = text.trim().toLowerCase();
    if (!pending.directory || !pending.projectId) return false;

    if (trimmed === "new") {
      this.sessionMapper.clearPendingSelection(chatId);
      await this.createNewSessionForProject(
        chatId,
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

    const tempSession: WeixinIlinkTempSession = {
      conversationId: session.id,
      engineType: session.engineType,
      directory: pending.directory,
      projectId: pending.projectId,
      lastActiveAt: Date.now(),
      messageQueue: [],
      processing: false,
    };
    this.sessionMapper.setTempSession(chatId, tempSession);
    await this.transport.sendText(
      chatId,
      `📋 已切换到会话：${session.title || session.id.slice(0, 8)}\n发送消息即可继续对话。`,
    );
    return true;
  }

  // ============================================================================
  // Temp Session Methods
  // ============================================================================

  private isTempSessionExpired(temp: WeixinIlinkTempSession): boolean {
    return Date.now() - temp.lastActiveAt > TEMP_SESSION_TTL_MS;
  }

  private async createTempSessionAndSend(
    chatId: string,
    project: { directory: string; engineType?: EngineType; projectId: string },
    text: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport) return;

    try {
      const session = await this.gatewayClient.createSession({
        engineType: project.engineType,
        directory: project.directory,
      });
      const tempSession: WeixinIlinkTempSession = {
        conversationId: session.id,
        engineType: session.engineType,
        directory: project.directory,
        projectId: project.projectId,
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: false,
      };
      this.sessionMapper.setTempSession(chatId, tempSession);
      await this.enqueueP2PMessage(chatId, text);
    } catch (err) {
      await this.transport.sendText(
        chatId,
        `📋 创建临时会话失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async enqueueP2PMessage(chatId: string, text: string): Promise<void> {
    const temp = this.sessionMapper.getTempSession(chatId) as WeixinIlinkTempSession | undefined;
    if (!temp) return;
    temp.messageQueue.push(text);
    if (!temp.processing) await this.processP2PQueue(chatId);
  }

  private async processP2PQueue(chatId: string): Promise<void> {
    const temp = this.sessionMapper.getTempSession(chatId) as WeixinIlinkTempSession | undefined;
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
    tempSession: WeixinIlinkTempSession,
    text: string,
  ): Promise<void> {
    if (!this.gatewayClient || !this.transport || !this.streamingController) {
      tempSession.processing = false;
      channelLog.error(`${LOG_PREFIX} Gateway client not connected, cannot send P2P message`);
      return;
    }

    tempSession.lastActiveAt = Date.now();

    // Batch mode: do NOT send a placeholder. StreamingController will sendText
    // when finalize() is called.
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
        channelLog.error(`${LOG_PREFIX} P2P sendMessage failed:`, err);
        tempSession.streamingSession = undefined;
        await this.transport!.sendText(
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
      channelLog.info(`${LOG_PREFIX} Deleted expired temp session: ${temp.conversationId}`);
    } catch {
      // Ignore deletion failures for temp sessions
    }
    this.sessionMapper.clearTempSession(chatId);
  }

  // ============================================================================
  // Gateway Event Subscriptions
  // ============================================================================

  private subscribeGatewayEvents(): void {
    if (!this.gatewayClient) return;

    this.gatewayClient.on("message.part.updated", (data) => {
      channelLog.verbose(`${LOG_PREFIX} <gw> message.part.updated session=${data.sessionId} part.type=${data.part.type}`);
      this.handlePartUpdated(data.sessionId, data.part);
    });
    this.gatewayClient.on("message.updated", (data) => {
      channelLog.verbose(`${LOG_PREFIX} <gw> message.updated session=${data.sessionId} role=${data.message.role} completed=${data.message.time?.completed ?? "n/a"} hasError=${!!data.message.error}`);
      this.handleMessageCompleted(data.sessionId, data.message);
    });
    this.gatewayClient.on("permission.asked", (data) => {
      this.handlePermissionAsked(data.permission);
    });
    this.gatewayClient.on("question.asked", (data) => {
      this.handleQuestionAsked(data.question);
    });
  }

  private handleMessageCompleted(conversationId: string, message: UnifiedMessage): void {
    if (message.role !== "assistant" || !message.time?.completed) {
      channelLog.verbose(`${LOG_PREFIX} handleMessageCompleted skipped: role=${message.role} completed=${message.time?.completed ?? "n/a"}`);
      return;
    }
    const p2pChatId = this.sessionMapper.findP2PChatByTempConversation(conversationId);
    if (!p2pChatId) {
      channelLog.warn(`${LOG_PREFIX} handleMessageCompleted: no P2P chat mapped for conversation=${conversationId}`);
      return;
    }
    channelLog.verbose(`${LOG_PREFIX} handleMessageCompleted: routing to P2P chat=${p2pChatId}`);
    void this.finalizeP2PStreaming(p2pChatId, message);
  }

  private async finalizeP2PStreaming(chatId: string, message: UnifiedMessage): Promise<void> {
    const tempSession = this.sessionMapper.getTempSession(chatId) as WeixinIlinkTempSession | undefined;
    if (!tempSession?.streamingSession || !this.streamingController) {
      channelLog.warn(`${LOG_PREFIX} finalizeP2PStreaming aborted: hasTemp=${!!tempSession} hasStream=${!!tempSession?.streamingSession} hasController=${!!this.streamingController}`);
      return;
    }

    const streaming = tempSession.streamingSession;
    channelLog.verbose(`${LOG_PREFIX} finalize chat=${chatId} bufLen=${streaming.textBuffer?.length ?? 0} hasError=${!!message.error}`);
    this.streamingController.finalize(streaming, message);

    tempSession.lastActiveAt = Date.now();
    tempSession.streamingSession = undefined;

    await this.processP2PQueue(chatId);
  }

  private handlePartUpdated(conversationId: string, part: UnifiedPart): void {
    if (!this.streamingController) return;
    const p2pChatId = this.sessionMapper.findP2PChatByTempConversation(conversationId);
    if (!p2pChatId) return;
    const tempSession = this.sessionMapper.getTempSession(p2pChatId) as WeixinIlinkTempSession | undefined;
    if (tempSession?.streamingSession && !tempSession.streamingSession.completed) {
      this.streamingController.applyPart(tempSession.streamingSession, part);
    }
  }

  private handlePermissionAsked(permission: UnifiedPermission): void {
    const targetChatId = this.sessionMapper.findP2PChatByTempConversation(permission.sessionId);
    if (!targetChatId || !this.transport) return;

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

    if (!permission.options || permission.options.length === 0) return;
    const lines: string[] = ["🔐 权限请求", permission.title || permission.id, "─────────────────────────"];
    for (let i = 0; i < permission.options.length; i++) {
      lines.push(`  ${i + 1}. ${permission.options[i].label || permission.options[i].id}`);
    }
    lines.push("─────────────────────────");
    lines.push("回复对应数字以选择。");
    void this.transport.sendText(targetChatId, lines.join("\n"));
  }

  private handleQuestionAsked(question: UnifiedQuestion): void {
    const targetChatId = this.sessionMapper.findP2PChatByTempConversation(question.sessionId);
    if (!targetChatId || !this.transport) return;

    if (question.questions && question.questions.length > 0) {
      const q = question.questions[0];
      const options = q.options.map((o, i) => ({ id: String(i), label: o.label || o.description }));
      const questionText = buildQuestionText(q.question || "Agent 有一个问题：", options);
      void this.transport.sendText(targetChatId, questionText);
      this.sessionMapper.setPendingQuestion(targetChatId, {
        questionId: question.id,
        sessionId: question.sessionId,
      });
    } else {
      void this.transport.sendText(targetChatId, "📋 Agent 提问（无选项）");
    }
  }
}
