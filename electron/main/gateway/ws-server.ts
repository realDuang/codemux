// ============================================================================
// WebSocket Gateway Server
// Handles WS connections from frontend/remote clients.
// Routes requests to EngineManager and broadcasts notifications.
// ============================================================================

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, Server } from "http";
import { EngineManager } from "./engine-manager";
import * as fileService from "../services/file-service";
import {
  onFileChange,
  unwatchAll,
} from "../services/file-service";
import { gatewayLog } from "../services/logger";
import log from "../services/logger";
import { conversationStore } from "../services/conversation-store";
import { canonicalCodexEngineType, canonicalCodexProjectId, canonicalCodexThreadId } from "../engines/codex/conversation-migration";
import { scheduledTaskService } from "../services/scheduled-task-service";
import { orchestratorService } from "../services/orchestrator-service";
import { getTerminalService } from "../services/terminal-service";
import { getSettingsPath } from "../services/app-paths";
import {
  GatewayRequestType,
  GatewayNotificationType,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayNotification,
  type EngineType,
  type SessionCreateRequest,
  type SessionArchiveRequest,
  type MessageSendRequest,
  type PermissionReplyRequest,
  type QuestionReplyRequest,
  type PendingListRequest,
  type ProjectSetEngineRequest,
  type CatalogProjectPatch,
  type ModelSetRequest,
  type SessionConfigUpdateRequest,
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
  type TerminalCreateRequest,
  type TerminalWriteRequest,
  type TerminalResizeRequest,
  type TerminalDestroyRequest,
  type TerminalListRequest,
  type TerminalProfilesListRequest,
  type FileExistsRequest,
} from "../../../src/types/unified";
import { isCodexServiceTier, isReasoningEffort } from "../../../src/types/unified";

interface ClientConnection {
  id: string;
  ws: WebSocket;
  request: IncomingMessage;
  authenticated: boolean;
  authToken?: string;
}

interface GatewayServerOptions {
  authValidator?: (token: string, req: IncomingMessage) => boolean;
  requestValidator?: (req: IncomingMessage) => boolean;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function invalidCatalogParams(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "INVALID_PARAMS" });
}

export class GatewayServer {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ClientConnection>();
  private engineManager: EngineManager;
  private authValidator?: GatewayServerOptions["authValidator"];
  private requestValidator?: GatewayServerOptions["requestValidator"];
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(
    engineManager: EngineManager,
    options?: GatewayServerOptions,
  ) {
    this.engineManager = engineManager;
    this.authValidator = options?.authValidator;
    this.requestValidator = options?.requestValidator;
    orchestratorService.init(engineManager);
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
    this.closePromise = null;

    const WS_MAX_PAYLOAD = 20 * 1024 * 1024; // 20MB — image attachments can be large
    const verifyClient = (info: { req: IncomingMessage }, done: (allowed: boolean, code?: number, message?: string) => void) => {
      if (this.isRequestAllowed(info.req)) done(true);
      else done(false, 403, "Remote access disabled");
    };

    if ("server" in options) {
      this.wss = new WebSocketServer({ server: options.server, path: options.path, maxPayload: WS_MAX_PAYLOAD, verifyClient });
    } else {
      this.wss = new WebSocketServer({ port: options.port, maxPayload: WS_MAX_PAYLOAD, verifyClient });
    }
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    this.wss.on("error", (err) => {
      gatewayLog.error("WebSocket server error:", err);
    });

    // Ping all clients every 30s to keep connections alive through proxies
    this.pingInterval = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!this.isClientAccessAllowed(client)) continue;
        if (client.authenticated && !this.isClientAuthorized(client)) continue;
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping();
        }
      }
    }, 30_000);

    const addr = "port" in options ? `:${options.port}` : "(attached to HTTP server)";
    gatewayLog.info(`Started on ${addr}`);
  }

  stop(): void {
    void this.close().catch((err) => {
      gatewayLog.error("WebSocket server shutdown failed:", err);
    });
  }

  /** Close upgraded connections before their owning HTTP server is stopped. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    unwatchAll();
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    const wss = this.wss;
    if (!wss) return Promise.resolve();
    this.wss = null;

    // Keep the sockets after clearing the routing map: a suspended mobile
    // client may never acknowledge the close frame, but still owns PTYs.
    const sockets = new Set(wss.clients);
    for (const client of this.clients.values()) sockets.add(client.ws);
    this.clients.clear();
    const disconnected = [...sockets].map((ws) => new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve();
      else ws.once("close", () => resolve());
    }));
    const forceCloseTimer = setTimeout(() => {
      for (const ws of sockets) {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      }
    }, 1_000);
    forceCloseTimer.unref?.();
    const stopped = new Promise<void>((resolve, reject) => {
      wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    // An internally owned HTTP server can report close before the WebSocket
    // close handlers have destroyed the clients' terminal processes.
    this.closePromise = Promise.all([stopped, ...disconnected]).then(() => {
      gatewayLog.info("Stopped");
    }).finally(() => clearTimeout(forceCloseTimer));
    for (const ws of sockets) ws.close(1001, "Server shutting down");
    return this.closePromise;
  }

  getPort(): number | undefined {
    const addr = this.wss?.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return undefined;
  }

  /** Withdraw existing remote connections immediately when access policy changes. */
  revalidateClients(): void {
    for (const client of this.clients.values()) {
      if (!this.isClientAccessAllowed(client)) continue;
      if (client.authenticated) this.isClientAuthorized(client);
    }
  }

  // --- Connection Handling ---

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    if (!this.isRequestAllowed(req)) {
      ws.close(4003, "Remote access disabled");
      return;
    }
    const clientId = randomUUID();
    const client: ClientConnection = {
      id: clientId,
      ws,
      request: req,
      authenticated: !this.authValidator, // No validator = auto-authenticated
    };

    // Check auth token from query string if validator exists
    if (this.authValidator) {
      const url = new URL(req.url ?? "", "http://localhost");
      const token = url.searchParams.get("token");
      if (this.isValidToken(token, req)) {
        client.authenticated = true;
        client.authToken = token;
      }
    }

    this.clients.set(clientId, client);
    gatewayLog.info(`Client connected: ${clientId}`);

    ws.on("message", (data) => this.handleMessage(client, data));
    ws.on("close", () => {
      this.clients.delete(clientId);
      // Tear down any PTY processes spawned by this client so the host
      // doesn't leak orphan shell processes after a disconnect.
      try {
        getTerminalService().destroyByOwner(clientId);
      } catch (err) {
        gatewayLog.error(`Terminal cleanup failed for ${clientId}:`, err);
      }
      gatewayLog.info(`Client disconnected: ${clientId}`);
    });
    ws.on("error", (err) => {
      gatewayLog.error(`Client error (${clientId}):`, err);
    });
  }

  private async handleMessage(client: ClientConnection, data: any): Promise<void> {
    if (!this.isClientAccessAllowed(client)) return;
    if (client.authenticated && !this.isClientAuthorized(client)) return;
    if (!client.authenticated) {
      // First message can be auth token
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "auth" && this.isValidToken(msg.token, client.request)) {
          client.authenticated = true;
          client.authToken = msg.token;
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

    // Explicitly unauthenticated test servers still acknowledge the client handshake.
    if (!this.authValidator && (request.type as string) === "auth") {
      this.sendToClient(client, {
        type: "response",
        requestId: request.requestId,
        payload: { authenticated: true },
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
      const result = await this.routeRequest(request, client);
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

  private isValidToken(token: unknown, req: IncomingMessage): token is string {
    if (typeof token !== "string" || !token || !this.authValidator) return false;
    try {
      return this.authValidator(token, req);
    } catch {
      return false;
    }
  }

  private isRequestAllowed(req: IncomingMessage): boolean {
    if (!this.requestValidator) return true;
    try {
      return this.requestValidator(req);
    } catch {
      return false;
    }
  }

  private isClientAccessAllowed(client: ClientConnection): boolean {
    if (this.isRequestAllowed(client.request)) return true;
    client.authenticated = false;
    client.authToken = undefined;
    client.ws.close(4003, "Remote access disabled");
    return false;
  }

  private isClientAuthorized(client: ClientConnection): boolean {
    if (!this.isClientAccessAllowed(client)) return false;
    if (!client.authenticated) return false;
    if (!this.authValidator || this.isValidToken(client.authToken, client.request)) return true;
    client.authenticated = false;
    client.authToken = undefined;
    client.ws.close(4001, "Unauthorized");
    return false;
  }

  // --- Request Routing ---

  private isWorktreeEnabled(): boolean {
    try {
      const raw = readFileSync(getSettingsPath(), "utf-8");
      const settings = JSON.parse(raw);
      return settings.worktreeEnabled === true;
    } catch {
      return false;
    }
  }

  private async routeRequest(
    request: GatewayRequest,
    client: ClientConnection,
  ): Promise<unknown> {
    const { type, payload } = request;
    const p = payload && typeof payload === "object" ? { ...payload } as any : payload as any;
    if (p && typeof p === "object") {
      // Old browser tabs and IM bindings keep their saved conversation IDs.
      // Deleting an alias detaches that binding instead of deleting its owner.
      for (const key of ["sessionId", "conversationId"] as const) {
        if (type !== GatewayRequestType.SESSION_DELETE && typeof p[key] === "string") {
          p[key] = conversationStore.resolveConversationId(p[key]);
        }
      }
      if (typeof p.engineType === "string") p.engineType = canonicalCodexEngineType(p.engineType);
      if (typeof p.projectId === "string") p.projectId = canonicalCodexProjectId(p.projectId);
      if (Array.isArray(p.projectIds)) p.projectIds = p.projectIds.map((id: unknown) => typeof id === "string" ? canonicalCodexProjectId(id) : id);
      if (p.engineType === "codex" && Array.isArray(p.sessions)) {
        p.sessions = p.sessions.map((session: Record<string, unknown>) => ({
          ...session,
          ...(typeof session.engineSessionId === "string" ? { engineSessionId: canonicalCodexThreadId(session.engineSessionId) } : {}),
        }));
      }
    }

    switch (type) {
      // Engine
      case GatewayRequestType.ENGINE_LIST:
        return this.engineManager.listEngines();

      case GatewayRequestType.ENGINE_CAPABILITIES:
        return this.engineManager
          .getEngineInfo(p.engineType as EngineType)
          .capabilities;

      case GatewayRequestType.ENGINE_SHARING_GET:
        return this.engineManager.getSessionSharing(p?.engineType);

      case GatewayRequestType.ENGINE_SHARING_SET:
        if (typeof p?.enabled !== "boolean") throw invalidCatalogParams("enabled must be a boolean");
        return this.engineManager.setSessionSharing(p.engineType, p.enabled);

      // Session
      case GatewayRequestType.SESSION_LIST:
        return this.engineManager.listSessions(p.engineType ?? p.directory);

      case GatewayRequestType.SESSION_CREATE: {
        const req = p as SessionCreateRequest;
        if (req?.projectId !== undefined) {
          if (req.projectId !== null && !nonEmptyString(req.projectId)) throw invalidCatalogParams("projectId must be a non-empty string or null");
          return this.engineManager.createSession(req.engineType, req.directory, req.worktreeId, req.projectId);
        }
        return this.engineManager.createSession(req.engineType, req.directory, req.worktreeId);
      }

      case GatewayRequestType.SESSION_GET:
        return this.engineManager.getSession(p.sessionId);

      case GatewayRequestType.SESSION_DELETE:
        return this.engineManager.deleteSession(p.sessionId);

      case GatewayRequestType.SESSION_RENAME: {
        return this.engineManager.renameSession(p.sessionId, p.title);
      }

      case GatewayRequestType.SESSION_ARCHIVE: {
        const req = p as SessionArchiveRequest;
        if (!req || typeof req.sessionId !== "string" || !req.sessionId || typeof req.archived !== "boolean") {
          throw Object.assign(new Error("sessionId and archived are required"), { code: "INVALID_PARAMS" });
        }
        return this.engineManager.setSessionArchived(req.sessionId, req.archived);
      }

      case GatewayRequestType.SESSION_PROJECT_SET: {
        if (!p || !nonEmptyString(p.sessionId) || (p.projectId !== null && !nonEmptyString(p.projectId))) {
          throw invalidCatalogParams("sessionId and a projectId string or null are required");
        }
        await this.engineManager.setSessionProject(p.sessionId, p.projectId);
        return { success: true };
      }

      // Message
      case GatewayRequestType.MESSAGE_SEND: {
        const req = p as MessageSendRequest;
        return this.engineManager.sendMessage(req.sessionId, req.content, {
          mode: req.mode,
          modelId: req.modelId,
          reasoningEffort: req.reasoningEffort,
          serviceTier: isCodexServiceTier(req.serviceTier) ? req.serviceTier : undefined,
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

      case GatewayRequestType.SESSION_CONFIG_UPDATE: {
        const req = p as SessionConfigUpdateRequest;
        const config = req.config ?? {};
        // Validate reasoning effort and service tier at the gateway boundary.
        // Reject loud rather than silently dropping the field — silent drops
        // make the RPC look successful while the value never persists.
        if (Object.prototype.hasOwnProperty.call(config, "reasoningEffort") && config.reasoningEffort !== null) {
          if (!isReasoningEffort(config.reasoningEffort)) {
            throw Object.assign(
              new Error(`Invalid reasoningEffort: ${JSON.stringify(config.reasoningEffort)}`),
              { code: "INVALID_REASONING_EFFORT" },
            );
          }
        }
        if (Object.prototype.hasOwnProperty.call(config, "serviceTier") && config.serviceTier !== null) {
          if (!isCodexServiceTier(config.serviceTier)) {
            throw Object.assign(
              new Error(`Invalid serviceTier: ${JSON.stringify(config.serviceTier)}`),
              { code: "INVALID_SERVICE_TIER" },
            );
          }
        }
        return this.engineManager.updateSessionConfig(req.sessionId, config);
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

      case GatewayRequestType.PENDING_LIST: {
        const req = p as PendingListRequest;
        return this.engineManager.getPending(req.sessionId);
      }

      // Project
      case GatewayRequestType.CATALOG_LIST:
        return this.engineManager.listCatalogs();

      case GatewayRequestType.PROJECT_CREATE: {
        if (!p || !nonEmptyString(p.sourceId) || !nonEmptyString(p.name) || !stringList(p.roots)) {
          throw invalidCatalogParams("sourceId, name, and a roots array are required");
        }
        return this.engineManager.createProject(p.sourceId, { name: p.name, roots: p.roots });
      }

      case GatewayRequestType.PROJECT_UPDATE: {
        const patch = p?.patch as CatalogProjectPatch | undefined;
        if (!p || !nonEmptyString(p.projectId) || !patch || typeof patch !== "object" || Array.isArray(patch)
          || Object.keys(patch).some((key) => key !== "name" && key !== "roots")
          || (patch.name === undefined && patch.roots === undefined)
          || (patch.name !== undefined && !nonEmptyString(patch.name))
          || (patch.roots !== undefined && !stringList(patch.roots))) {
          throw invalidCatalogParams("projectId and a valid name or roots patch are required");
        }
        return this.engineManager.updateProject(p.projectId, patch);
      }

      case GatewayRequestType.PROJECT_REORDER: {
        if (!p || !nonEmptyString(p.sourceId) || !stringList(p.projectIds) || new Set(p.projectIds).size !== p.projectIds.length) {
          throw invalidCatalogParams("sourceId and unique projectIds are required");
        }
        await this.engineManager.reorderProjects(p.sourceId, p.projectIds);
        return { success: true };
      }

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
        if (!p || !nonEmptyString(p.projectId)) throw invalidCatalogParams("projectId is required");
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
          serviceTier: isCodexServiceTier(req.serviceTier) ? req.serviceTier : undefined,
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
        // Allow team worktrees even when worktree feature is disabled (internal orchestration)
        if (!this.isWorktreeEnabled() && !req.name?.startsWith("team-")) {
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

      // Orchestration
      case GatewayRequestType.ORCHESTRATION_CREATE:
        return orchestratorService.createRun(p.parentSessionId, p.directory, p.prompt, p.engineTypes, p.roleMappings, p.worktreeInfo);
      case GatewayRequestType.ORCHESTRATION_DECOMPOSE:
        // Fire-and-forget: return ack immediately, progress via orchestration.updated events
        orchestratorService.decomposeTask(p.runId).catch((err) => {
          gatewayLog.error("[Orchestration] decompose failed:", err);
        });
        return { ok: true };
      case GatewayRequestType.ORCHESTRATION_CONFIRM:
        // Fire-and-forget: execution is long-running, progress via events
        orchestratorService.confirmAndExecute(p.runId, p.subtasks).catch((err) => {
          gatewayLog.error("[Orchestration] confirm+execute failed:", err);
        });
        return { ok: true };
      case GatewayRequestType.ORCHESTRATION_CANCEL:
        return orchestratorService.cancelRun(p.runId);
      case GatewayRequestType.ORCHESTRATION_LIST:
        return orchestratorService.listRuns();

      // Integrated Terminal (PTY)
      case GatewayRequestType.TERMINAL_CREATE: {
        const req = p as TerminalCreateRequest;
        const terminalService = getTerminalService();
        const info = terminalService.create({
          ownerClientId: client.id,
          cwd: req.cwd,
          cols: req.cols,
          rows: req.rows,
          sessionId: req.sessionId,
          profileId: req.profileId,
        });
        return { terminalId: info.terminalId, info };
      }

      case GatewayRequestType.TERMINAL_WRITE: {
        const req = p as TerminalWriteRequest;
        getTerminalService().write(req.terminalId, req.data, client.id);
        return { success: true };
      }

      case GatewayRequestType.TERMINAL_RESIZE: {
        const req = p as TerminalResizeRequest;
        getTerminalService().resize(req.terminalId, req.cols, req.rows, client.id);
        return { success: true };
      }

      case GatewayRequestType.TERMINAL_DESTROY: {
        const req = p as TerminalDestroyRequest;
        getTerminalService().destroy(req.terminalId, client.id);
        return { success: true };
      }

      case GatewayRequestType.TERMINAL_LIST: {
        const req = p as TerminalListRequest;
        return { terminals: getTerminalService().list(client.id, req?.sessionId) };
      }

      case GatewayRequestType.TERMINAL_PROFILES_LIST: {
        const req = (p ?? {}) as TerminalProfilesListRequest;
        const { listTerminalProfiles } = await import("../services/terminal-profiles");
        return listTerminalProfiles({ refresh: req.refresh });
      }

      case GatewayRequestType.FILE_EXISTS: {
        const req = p as FileExistsRequest;
        return await fileService.fileExists(req.path, req.cwd);
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

    em.on("message.removed", (data) => {
      this.broadcast({ type: GatewayNotificationType.MESSAGE_REMOVED, payload: data });
    });

    em.on("session.removed", (data) => {
      const aliases = (data as { conversationAliases?: string[] }).conversationAliases;
      this.broadcast({ type: GatewayNotificationType.SESSION_REMOVED, payload: {
        sessionId: data.sessionId,
        ...(Array.isArray(aliases) ? { conversationAliases: aliases.filter((id) => typeof id === "string" && id !== data.sessionId) } : {}),
      } });
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

    em.on("catalog.updated", (snapshot) => {
      this.broadcast({ type: GatewayNotificationType.CATALOG_UPDATED, payload: snapshot });
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

    // Orchestration events
    orchestratorService.on("orchestration.updated", (data) => {
      this.broadcast({ type: GatewayNotificationType.ORCHESTRATION_UPDATED, payload: data });
    });

    // Terminal events — scoped to owner client only (private streams).
    const terminalService = getTerminalService();
    terminalService.on("data", ({ terminalId, ownerClientId, data }) => {
      this.sendToOwner(ownerClientId, {
        type: GatewayNotificationType.TERMINAL_DATA,
        payload: { terminalId, data },
      });
    });
    terminalService.on("exit", ({ terminalId, ownerClientId, exitCode, signal }) => {
      this.sendToOwner(ownerClientId, {
        type: GatewayNotificationType.TERMINAL_EXIT,
        payload: { terminalId, exitCode, signal },
      });
    });
  }

  /**
   * Send a notification to a single client (used for owner-scoped streams
   * like terminal data). No-op if the client is gone — stale terminals are
   * cleaned up by destroyByOwner on disconnect.
   */
  private sendToOwner(clientId: string, notification: GatewayNotification): void {
    const client = this.clients.get(clientId);
    if (!client || !this.isClientAuthorized(client)) return;
    if (client.ws.readyState !== WebSocket.OPEN) return;
    client.ws.send(JSON.stringify(notification));
  }

  private broadcast(notification: GatewayNotification): void {
    const payload = notification.payload as Record<string, any> | undefined;
    const sessionId = payload?.sessionId ?? payload?.session?.id ?? payload?.message?.sessionId
      ?? payload?.part?.sessionId ?? payload?.permission?.sessionId ?? payload?.question?.sessionId;
    if (typeof sessionId === "string") {
      const aliases = conversationStore.getConversationIds(sessionId).filter((id) => id !== sessionId);
      if (aliases.length > 0) notification = { ...notification, payload: { ...payload, conversationAliases: aliases } };
    }
    const msg = JSON.stringify(notification);
    for (const client of this.clients.values()) {
      if (this.isClientAuthorized(client) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  private sendToClient(
    client: ClientConnection,
    response: GatewayResponse,
  ): void {
    if (this.isClientAuthorized(client) && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(response));
    }
  }
}
