// ============================================================================
// WebSocket Gateway Server
// Handles WS connections from frontend/remote clients.
// Routes requests to EngineManager and broadcasts notifications.
// ============================================================================

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import type { Server } from "http";
import { EngineManager } from "./engine-manager";
import * as fileService from "../services/file-service";
import {
  onFileChange,
  unwatchAll,
} from "../services/file-service";
import { gatewayLog } from "../services/logger";
import log from "../services/logger";
import { conversationStore } from "../services/conversation-store";
import { scheduledTaskService } from "../services/scheduled-task-service";
import { agentTeamService } from "../services/agent-team";
import {
  GatewayRequestType,
  GatewayNotificationType,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayNotification,
  type EngineType,
  type SessionCreateRequest,
  type MessageSendRequest,
  type PermissionReplyRequest,
  type QuestionReplyRequest,
  type ProjectSetEngineRequest,
  type ModelSetRequest,
  type ModeSetRequest,
  type SessionImportPreviewRequest,
  type SessionImportExecuteRequest,
  type ScheduledTaskCreateRequest,
  type ScheduledTaskUpdateRequest,
  type WorktreeCreateRequest,
  type WorktreeListRequest,
  type WorktreeRemoveRequest,
  type WorktreeMergeRequest,
  type WorktreeListBranchesRequest,
  type TeamCreateRequest,
  type TeamCancelRequest,
  type TeamGetRequest,
} from "../../../src/types/unified";

interface ClientConnection {
  id: string;
  ws: WebSocket;
  authenticated: boolean;
}

export class GatewayServer {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ClientConnection>();
  private engineManager: EngineManager;
  private authValidator?: (token: string) => boolean;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    engineManager: EngineManager,
    options?: {
      authValidator?: (token: string) => boolean;
    },
  ) {
    this.engineManager = engineManager;
    this.authValidator = options?.authValidator;
    this.subscribeToEngineEvents();

    onFileChange((event) => {
      this.broadcast({
        type: GatewayNotificationType.FILE_CHANGED,
        payload: event,
      });
    });
  }

  // --- Server Lifecycle ---

  /**
   * Start the WebSocket server.
   * Can attach to an existing HTTP server or listen on a port.
   */
  start(options: { port: number } | { server: Server; path?: string }): void {
    if (this.wss) {
      throw new Error("Gateway server already started");
    }

    const WS_MAX_PAYLOAD = 20 * 1024 * 1024; // 20MB — image attachments can be large

    if ("server" in options) {
      this.wss = new WebSocketServer({ server: options.server, path: options.path, maxPayload: WS_MAX_PAYLOAD });
    } else {
      this.wss = new WebSocketServer({ port: options.port, maxPayload: WS_MAX_PAYLOAD });
    }
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    this.wss.on("error", (err) => {
      gatewayLog.error("WebSocket server error:", err);
    });

    // Ping all clients every 30s to keep connections alive through proxies
    this.pingInterval = setInterval(() => {
      for (const client of this.clients.values()) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping();
        }
      }
    }, 30_000);

    const addr = "port" in options ? `:${options.port}` : "(attached to HTTP server)";
    gatewayLog.info(`Started on ${addr}`);
  }

  stop(): void {
    unwatchAll();
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.wss) {
      // Close all client connections
      for (const client of this.clients.values()) {
        client.ws.close(1001, "Server shutting down");
      }
      this.clients.clear();
      this.wss.close();
      this.wss = null;
      gatewayLog.info("Stopped");
    }
  }

  getPort(): number | undefined {
    const addr = this.wss?.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return undefined;
  }

  // --- Connection Handling ---

  private handleConnection(ws: WebSocket, req: any): void {
    const clientId = randomUUID();
    const client: ClientConnection = {
      id: clientId,
      ws,
      authenticated: !this.authValidator, // No validator = auto-authenticated
    };

    // Check auth token from query string if validator exists
    if (this.authValidator) {
      const url = new URL(req.url ?? "", "http://localhost");
      const token = url.searchParams.get("token");
      if (token && this.authValidator(token)) {
        client.authenticated = true;
      }
    }

    this.clients.set(clientId, client);
    gatewayLog.info(`Client connected: ${clientId}`);

    ws.on("message", (data) => this.handleMessage(client, data));
    ws.on("close", () => {
      this.clients.delete(clientId);
      gatewayLog.info(`Client disconnected: ${clientId}`);
    });
    ws.on("error", (err) => {
      gatewayLog.error(`Client error (${clientId}):`, err);
    });
  }

  private async handleMessage(client: ClientConnection, data: any): Promise<void> {
    if (!client.authenticated) {
      // First message can be auth token
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "auth" && this.authValidator?.(msg.token)) {
          client.authenticated = true;
          this.sendToClient(client, {
            type: "response",
            requestId: msg.requestId ?? "",
            payload: { authenticated: true },
          });
          return;
        }
      } catch {
        // ignore
      }
      client.ws.close(4001, "Unauthorized");
      return;
    }

    let request: GatewayRequest;
    try {
      request = JSON.parse(data.toString());
    } catch {
      this.sendToClient(client, {
        type: "response",
        requestId: "",
        payload: null,
        error: { code: "PARSE_ERROR", message: "Invalid JSON" },
      });
      return;
    }

    // Fire-and-forget: renderer log forwarding — write to file, no response
    if (request.type === GatewayRequestType.LOG_SEND) {
      const p = request.payload as any;
      const level = p?.level ?? "info";
      const args = Array.isArray(p?.args) ? p.args : [String(p?.args ?? "")];
      const rendererLog = log.scope("renderer");
      if (typeof (rendererLog as any)[level] === "function") {
        (rendererLog as any)[level](...args);
      } else {
        rendererLog.info(...args);
      }
      return;
    }

    try {
      const result = await this.routeRequest(request);
      this.sendToClient(client, {
        type: "response",
        requestId: request.requestId,
        payload: result,
      });
    } catch (err: any) {
      this.sendToClient(client, {
        type: "response",
        requestId: request.requestId,
        payload: null,
        error: {
          code: err.code ?? "INTERNAL_ERROR",
          message: err.message ?? "Unknown error",
        },
      });
    }
  }

  // --- Request Routing ---

  private isWorktreeEnabled(): boolean {
    try {
      const settingsPath = require("path").join(
        require("electron").app.getPath("userData"),
        "settings.json",
      );
      const raw = require("fs").readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      return settings.worktreeEnabled === true;
    } catch {
      return false;
    }
  }

  private async routeRequest(request: GatewayRequest): Promise<unknown> {
    const { type, payload } = request;
    const p = payload as any;

    switch (type) {
      // Engine
      case GatewayRequestType.ENGINE_LIST:
        return this.engineManager.listEngines();

      case GatewayRequestType.ENGINE_CAPABILITIES:
        return this.engineManager
          .getEngineInfo(p.engineType as EngineType)
          .capabilities;

      // Session
      case GatewayRequestType.SESSION_LIST:
        return this.engineManager.listSessions(p.engineType ?? p.directory);

      case GatewayRequestType.SESSION_CREATE: {
        const req = p as SessionCreateRequest;
        return this.engineManager.createSession(req.engineType, req.directory, req.worktreeId);
      }

      case GatewayRequestType.SESSION_GET:
        return this.engineManager.getSession(p.sessionId);

      case GatewayRequestType.SESSION_DELETE:
        return this.engineManager.deleteSession(p.sessionId);

      case GatewayRequestType.SESSION_RENAME: {
        return this.engineManager.renameSession(p.sessionId, p.title);
      }

      // Message
      case GatewayRequestType.MESSAGE_SEND: {
        const req = p as MessageSendRequest;
        return this.engineManager.sendMessage(req.sessionId, req.content, {
          mode: req.mode,
          modelId: req.modelId,
          reasoningEffort: req.reasoningEffort,
        });
      }

      case GatewayRequestType.MESSAGE_CANCEL:
        return this.engineManager.cancelMessage(p.sessionId);

      case GatewayRequestType.MESSAGE_LIST:
        return this.engineManager.listMessages(p.sessionId);

      case GatewayRequestType.MESSAGE_STEPS: {
        const { sessionId, messageId } = p as { sessionId: string; messageId: string };
        const steps = await this.engineManager.getMessageSteps(sessionId, messageId);
        return steps;
      }

      // Model
      case GatewayRequestType.MODEL_LIST:
        return this.engineManager.listModels(p.engineType as EngineType);

      case GatewayRequestType.MODEL_SET: {
        const req = p as ModelSetRequest;
        return this.engineManager.setModel(req.sessionId, req.modelId);
      }

      // Mode
      case GatewayRequestType.MODE_SET: {
        const req = p as ModeSetRequest;
        return this.engineManager.setMode(req.sessionId, req.modeId);
      }

      // Permission
      case GatewayRequestType.PERMISSION_REPLY: {
        const req = p as PermissionReplyRequest;
        return this.engineManager.replyPermission(
          req.permissionId,
          { optionId: req.optionId },
        );
      }

      // Question
      case GatewayRequestType.QUESTION_REPLY: {
        const req = p as QuestionReplyRequest;
        return this.engineManager.replyQuestion(
          req.questionId,
          req.answers,
        );
      }

      case GatewayRequestType.QUESTION_REJECT: {
        const req = p as QuestionReplyRequest;
        return this.engineManager.rejectQuestion(req.questionId);
      }

      // Project
      case GatewayRequestType.PROJECT_LIST:
        return this.engineManager.listProjects(p.engineType as EngineType);

      case GatewayRequestType.PROJECT_SET_ENGINE: {
        const req = p as ProjectSetEngineRequest;
        this.engineManager.setProjectEngine(req.directory, req.engineType);
        return { success: true };
      }

      // Session (cross-engine)
      case GatewayRequestType.SESSION_LIST_ALL:
        return this.engineManager.listAllSessions();

      // Project (cross-engine)
      case GatewayRequestType.PROJECT_LIST_ALL:
        return this.engineManager.listAllProjects();

      case GatewayRequestType.PROJECT_DELETE:
        await this.engineManager.deleteProject(p.projectId);
        return { success: true };

      // Legacy migration
      case GatewayRequestType.IMPORT_LEGACY_PROJECTS:
        return { imported: 0 }; // Legacy import no longer needed

      // Session import (from engine history)
      case GatewayRequestType.SESSION_IMPORT_PREVIEW: {
        const req = p as SessionImportPreviewRequest;
        return this.engineManager.importPreview(req.engineType, req.limit);
      }

      case GatewayRequestType.SESSION_IMPORT_EXECUTE: {
        const req = p as SessionImportExecuteRequest;
        return this.engineManager.importExecute(req.engineType, req.sessions);
      }

      // File Explorer
      case GatewayRequestType.FILE_LIST: {
        const { directory, rootDirectory } = p as { directory: string; rootDirectory?: string };
        return fileService.listDirectory(directory, rootDirectory ?? directory);
      }

      case GatewayRequestType.FILE_READ: {
        const { path: filePath, directory } = p as { path: string; directory: string };
        return fileService.readFile(filePath, directory);
      }

      case GatewayRequestType.FILE_GIT_STATUS: {
        const { directory } = p as { directory: string };
        return fileService.getGitStatus(directory);
      }

      case GatewayRequestType.FILE_GIT_DIFF: {
        const { directory, path: filePath } = p as { directory: string; path: string };
        return fileService.getGitDiff(directory, filePath);
      }

      case GatewayRequestType.FILE_WATCH: {
        const { directory } = p as { directory: string };
        fileService.watchDirectory(directory);
        return { success: true };
      }

      case GatewayRequestType.FILE_UNWATCH: {
        const { directory } = p as { directory: string };
        fileService.unwatchDirectory(directory);
        return { success: true };
      }

      // Slash Commands
      case GatewayRequestType.COMMAND_LIST: {
        const req = p as any;
        return this.engineManager.listCommands(req.engineType, req.sessionId);
      }

      case GatewayRequestType.COMMAND_INVOKE: {
        const req = p as any;
        return this.engineManager.invokeCommand(req.sessionId, req.commandName, req.args, {
          mode: req.mode,
          modelId: req.modelId,
          reasoningEffort: req.reasoningEffort,
        });
      }

      // Scheduled Tasks
      case GatewayRequestType.SCHEDULED_TASK_LIST:
        return scheduledTaskService.list();

      case GatewayRequestType.SCHEDULED_TASK_GET:
        return scheduledTaskService.get(p.id);

      case GatewayRequestType.SCHEDULED_TASK_CREATE:
        return scheduledTaskService.create(p as ScheduledTaskCreateRequest);

      case GatewayRequestType.SCHEDULED_TASK_UPDATE:
        return scheduledTaskService.update(p as ScheduledTaskUpdateRequest);

      case GatewayRequestType.SCHEDULED_TASK_DELETE:
        scheduledTaskService.delete(p.id);
        return { success: true };

      case GatewayRequestType.SCHEDULED_TASK_RUN_NOW:
        return scheduledTaskService.runNow(p.id);

      // Worktree
      case GatewayRequestType.WORKTREE_CREATE: {
        const req = p as WorktreeCreateRequest;
        if (!this.isWorktreeEnabled()) {
          throw Object.assign(new Error("Worktree feature is disabled"), { code: "WORKTREE_DISABLED" });
        }
        const { worktreeManager } = await import("../services/worktree-manager");
        return worktreeManager.create(req.directory, {
          name: req.name,
          baseBranch: req.baseBranch,
        });
      }

      case GatewayRequestType.WORKTREE_LIST: {
        const req = p as WorktreeListRequest;
        const { worktreeManager } = await import("../services/worktree-manager");
        return worktreeManager.list(req.directory);
      }

      case GatewayRequestType.WORKTREE_REMOVE: {
        const req = p as WorktreeRemoveRequest;
        const { worktreeManager } = await import("../services/worktree-manager");

        // Delete all sessions belonging to this worktree (same pattern as project delete)
        const allConvs = conversationStore.list();
        const worktreeConvs = allConvs.filter((conv) => conv.worktreeId === req.worktreeName);
        for (const conv of worktreeConvs) {
          await this.engineManager.deleteSession(conv.id);
        }

        // Then remove the git worktree, branch, and directory
        return worktreeManager.remove(req.directory, req.worktreeName);
      }

      case GatewayRequestType.WORKTREE_MERGE: {
        const req = p as WorktreeMergeRequest;
        const { worktreeManager } = await import("../services/worktree-manager");
        return worktreeManager.merge(req.directory, req.worktreeName, {
          targetBranch: req.targetBranch,
          mode: req.mode,
          message: req.message,
        });
      }

      case GatewayRequestType.WORKTREE_LIST_BRANCHES: {
        const req = p as WorktreeListBranchesRequest;
        const { worktreeManager } = await import("../services/worktree-manager");
        return worktreeManager.listBranches(req.directory);
      }

      // --- Agent Team ---

      case GatewayRequestType.TEAM_CREATE: {
        const req = p as TeamCreateRequest;
        return agentTeamService.createRun(req);
      }

      case GatewayRequestType.TEAM_CANCEL: {
        const req = p as TeamCancelRequest;
        return agentTeamService.cancelRun(req.runId);
      }

      case GatewayRequestType.TEAM_LIST: {
        return agentTeamService.listRuns();
      }

      case GatewayRequestType.TEAM_GET: {
        const req = p as TeamGetRequest;
        return agentTeamService.getRun(req.runId);
      }

      default:
        throw Object.assign(
          new Error(`Unknown request type: ${type}`),
          { code: "UNKNOWN_REQUEST" },
        );
    }
  }

  // --- Notification Broadcasting ---

  private subscribeToEngineEvents(): void {
    const em = this.engineManager;

    em.on("message.part.updated", (data) => {
      this.broadcast({
        type: GatewayNotificationType.MESSAGE_PART_UPDATED,
        payload: data,
      });
    });

    em.on("message.updated", (data) => {
      this.broadcast({
        type: GatewayNotificationType.MESSAGE_UPDATED,
        payload: data,
      });
    });

    em.on("session.updated", (data) => {
      this.broadcast({
        type: GatewayNotificationType.SESSION_UPDATED,
        payload: data,
      });
    });

    em.on("session.created", (data) => {
      this.broadcast({
        type: GatewayNotificationType.SESSION_CREATED,
        payload: data,
      });
    });

    em.on("permission.asked", (data) => {
      this.broadcast({
        type: GatewayNotificationType.PERMISSION_ASKED,
        payload: data,
      });
    });

    em.on("permission.replied", (data) => {
      this.broadcast({
        type: GatewayNotificationType.PERMISSION_REPLIED,
        payload: data,
      });
    });

    em.on("question.asked", (data) => {
      this.broadcast({
        type: GatewayNotificationType.QUESTION_ASKED,
        payload: data,
      });
    });

    em.on("question.replied", (data) => {
      this.broadcast({
        type: GatewayNotificationType.QUESTION_REPLIED,
        payload: data,
      });
    });

    em.on("status.changed", (data) => {
      this.broadcast({
        type: GatewayNotificationType.ENGINE_STATUS_CHANGED,
        payload: data,
      });
    });

    em.on("message.queued", (data) => {
      this.broadcast({
        type: GatewayNotificationType.MESSAGE_QUEUED,
        payload: data,
      });
    });

    em.on("message.queued.consumed", (data) => {
      this.broadcast({
        type: GatewayNotificationType.MESSAGE_QUEUED_CONSUMED,
        payload: data,
      });
    });

    em.on("session.import.progress" as any, (data: any) => {
      this.broadcast({
        type: GatewayNotificationType.SESSION_IMPORT_PROGRESS,
        payload: data,
      });
    });

    em.on("commands.changed", (data) => {
      this.broadcast({
        type: GatewayNotificationType.COMMANDS_CHANGED,
        payload: data,
      });
    });

    // Scheduled Task events
    scheduledTaskService.on("task.fired", (data) => {
      this.broadcast({
        type: GatewayNotificationType.SCHEDULED_TASK_FIRED,
        payload: data,
      });
    });
    scheduledTaskService.on("task.failed", (data) => {
      this.broadcast({
        type: GatewayNotificationType.SCHEDULED_TASK_FAILED,
        payload: data,
      });
    });
    scheduledTaskService.on("tasks.changed", (data) => {
      this.broadcast({
        type: GatewayNotificationType.SCHEDULED_TASKS_CHANGED,
        payload: data,
      });
    });

    // Agent Team events
    agentTeamService.on("team.run.updated", (data) => {
      this.broadcast({
        type: GatewayNotificationType.TEAM_RUN_UPDATED,
        payload: data,
      });
    });
    agentTeamService.on("team.task.updated", (data) => {
      this.broadcast({
        type: GatewayNotificationType.TEAM_TASK_UPDATED,
        payload: data,
      });
    });
  }

  private broadcast(notification: GatewayNotification): void {
    const msg = JSON.stringify(notification);
    for (const client of this.clients.values()) {
      if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  private sendToClient(
    client: ClientConnection,
    response: GatewayResponse,
  ): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(response));
    }
  }
}
