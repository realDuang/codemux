/**
 * Gateway WebSocket Client
 * Connects to the main-process GatewayServer and provides a typed RPC interface.
 */

import { gatewayAPI } from "./electron-api";
import { isElectron } from "./platform";
import { Auth } from "./auth";
import {
  GatewayRequestType,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayNotification,
  type GatewayMessage,
  type EngineType,
  type EngineInfo,
  type EngineCapabilities,
  type UnifiedSession,
  type UnifiedMessage,
  type ModelListResult,
  type UnifiedProject,
  type EngineCatalogSnapshot,
  type CatalogProjectInput,
  type CatalogProjectPatch,
  type UnifiedPermission,
  type UnifiedQuestion,
  type UnifiedPart,
  type SessionCreateRequest,
  type MessageSendRequest,
  type PermissionReplyRequest,
  type QuestionReplyRequest,
  type ProjectSetEngineRequest,
  type ModelSetRequest,
  type SessionConfigUpdateRequest,
  type ModeSetRequest,
  type ImportableSession,
  type SessionImportPreviewRequest,
  type SessionImportExecuteRequest,
  type SessionImportResult,
  type SessionImportProgress,
  type FileExplorerNode,
  type FileExplorerContent,
  type GitFileStatus,
  type EngineCommand,
  type CommandInvokeResult,
  type CommandInvokeRequest,
  type CronCreateRequest,
  type CronCreateResult,
  type CronJobInfo,
  type CronNotification,
  type ScheduledTask,
  type ScheduledTaskCreateRequest,
  type ScheduledTaskUpdateRequest,
  type ScheduledTaskRunResult,
  type OrchestrationRun,
  type TerminalCreateRequest,
  type TerminalCreateResponse,
  type TerminalListRequest,
  type TerminalListResponse,
} from "../types/unified";

// --- Event types emitted by GatewayClient ---

export interface GatewayClientEvents {
  /** Connection lifecycle */
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (err: Error) => void;

  /** Push notifications from gateway */
  "message.part.updated": (data: { sessionId: string; part: UnifiedPart }) => void;
  "message.parts.batch": (data: { sessionId: string; messageId: string; parts: UnifiedPart[] }) => void;
  "message.updated": (data: { sessionId: string; message: UnifiedMessage }) => void;
  "message.removed": (data: { sessionId: string; messageId: string }) => void;
  "session.removed": (data: { sessionId: string }) => void;
  "session.updated": (data: { session: UnifiedSession }) => void;
  "session.created": (data: { session: UnifiedSession }) => void;
  "catalog.updated": (data: EngineCatalogSnapshot) => void;
  "permission.asked": (data: { permission: UnifiedPermission }) => void;
  "permission.replied": (data: { permissionId: string; optionId: string }) => void;
  "question.asked": (data: { question: UnifiedQuestion }) => void;
  "question.replied": (data: { questionId: string; answers: string[][] }) => void;
  "engine.status.changed": (data: { engineType: EngineType; status: string; error?: string }) => void;
  "message.queued": (data: { sessionId: string; messageId: string; queuePosition: number }) => void;
  "message.queued.consumed": (data: { sessionId: string; messageId: string }) => void;
  "session.import.progress": (data: SessionImportProgress) => void;
  "file.changed": (event: { type: string; path: string; directory: string }) => void;
  "commands.changed": (data: { engineType: EngineType; commands: EngineCommand[] }) => void;
  /** Cron scheduler notifications */
  "cron.fired": (data: CronNotification) => void;
  "cron.completed": (data: CronNotification) => void;
  "cron.expired": (data: CronNotification) => void;
  "cron.changed": (data: { jobs: CronJobInfo[] }) => void;

  /** Scheduled task push notifications */
  "scheduledTask.fired": (data: { taskId: string; conversationId: string }) => void;
  "scheduledTask.failed": (data: { taskId: string; error: string }) => void;
  "scheduledTasks.changed": (data: { tasks: ScheduledTask[] }) => void;

  /** Orchestration push notifications */
  "orchestration.updated": (data: { run: OrchestrationRun }) => void;

  /** Integrated terminal (PTY) push streams — owner-scoped on the server */
  "terminal.data": (data: { terminalId: string; data: string }) => void;
  "terminal.exit": (data: { terminalId: string; exitCode?: number; signal?: number }) => void;
}

// --- Pending request tracking ---

interface PendingRequest {
  resolve: (payload: any) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

// --- Client ---

const DEFAULT_TIMEOUT = 120_000; // 2 min for long-running requests like message.send
const RECONNECT_DELAYS = [500, 1000, 2000, 5000]; // Backoff sequence

type EventHandler = (...args: any[]) => void;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;
  private _connected = false;
  private wsUrl: string | null = null;
  private connectionPromise: Promise<void> | null = null;
  private healthCheckPromise: Promise<void> | null = null;
  private connectionEpoch = 0;
  private listeners = new Map<string, Set<EventHandler>>();

  // --- Notification batching ---
  // High-frequency notifications (message.part.updated) are collected and
  // dispatched in batches via requestAnimationFrame. This prevents the JS
  // event loop from being starved when streaming parts arrive faster than
  // the renderer can process them (which causes permanent UI freeze).
  private notificationQueue: Array<{ type: string; payload: any }> = [];
  private notificationFlushScheduled = false;
  private static readonly BATCHED_EVENTS = new Set([
    "message.part.updated",
    "message.updated",
    "message.removed",
    // Keep in sync with the message.updated batch so wire order is preserved.
    // Otherwise consumed fires immediately and clears the queued preview before
    // the preceding `message.updated` (Turn N completed) is handled, which then
    // sees an empty queue and incorrectly clears the `sending` state.
    "message.queued.consumed",
  ]);

  get connected(): boolean {
    return this._connected;
  }

  // --- Typed event emitter ---

  on<K extends keyof GatewayClientEvents>(event: K, handler: GatewayClientEvents[K]): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler as EventHandler);
    return this;
  }

  off<K extends keyof GatewayClientEvents>(event: K, handler: GatewayClientEvents[K]): this {
    this.listeners.get(event)?.delete(handler as EventHandler);
    return this;
  }

  private emit<K extends keyof GatewayClientEvents>(
    event: K,
    ...args: Parameters<GatewayClientEvents[K]>
  ): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const h of handlers) h(...args);
    }
  }

  // --- Connection lifecycle ---

  connect(url?: string): Promise<void> {
    if (this.connectionPromise) return this.connectionPromise;
    const connecting = this.openConnection(url);
    this.connectionPromise = connecting;
    void connecting.finally(() => {
      if (this.connectionPromise === connecting) this.connectionPromise = null;
    }).catch(() => {});
    return connecting;
  }

  private async openConnection(url?: string): Promise<void> {
    if (this.ws) return;
    const epoch = this.connectionEpoch;
    this.manualClose = false;

    if (url) {
      this.wsUrl = url;
    } else if (!this.wsUrl) {
      if (isElectron()) {
        // In Electron: get full WS URL from main process via IPC
        // Dev mode uses the configured standalone Gateway port.
        // Packaged mode attaches Gateway to the production server at /ws.
        this.wsUrl = await gatewayAPI.getWsUrl();
      } else {
        // In remote browser: derive WS URL from current page location
        // Production (Cloudflare Tunnel): wss://tunnel-host/ws
        // Dev fallback uses the current Vite host.
        const loc = window.location;
        const wsProtocol = loc.protocol === "https:" ? "wss:" : "ws:";
        this.wsUrl = `${wsProtocol}//${loc.host}/ws`;
      }
    }

    if (epoch !== this.connectionEpoch) throw new Error("Client disconnected");
    const endpoint = new URL(this.wsUrl!);
    const token = Auth.getToken() || endpoint.searchParams.get("token");
    if (!token) throw new Error("Gateway authentication required");
    // Authenticate in the first frame so device credentials stay out of URLs.
    endpoint.searchParams.delete("token");

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(endpoint.toString());
      const authRequestId = `auth_${++this.requestCounter}`;
      const authTimer = setTimeout(() => {
        reject(new Error("Gateway authentication timed out"));
        ws.close(4000, "Authentication timed out");
      }, 10_000);

      ws.onopen = () => {
        if (this.ws !== ws) return;
        ws.send(JSON.stringify({ type: "auth", requestId: authRequestId, token }));
      };

      ws.onclose = (ev) => {
        clearTimeout(authTimer);
        reject(new Error("Failed to connect to gateway"));
        if (this.ws !== ws) return;
        this._connected = false;
        this.ws = null;
        this.rejectAllPending("Connection closed");
        this.emit("disconnected", ev.reason || "closed");

        if (!this.manualClose && ev.code !== 4001) {
          this.scheduleReconnect();
        }
      };

      ws.onerror = () => {
        // Error details come via onclose; just emit for logging
        this.emit("error", new Error("WebSocket error"));
      };

      ws.onmessage = (ev) => {
        if (this.ws !== ws) return;
        if (!this._connected) {
          let response: GatewayResponse;
          try {
            response = JSON.parse(ev.data as string);
          } catch {
            return;
          }
          if (response?.type !== "response" || response.requestId !== authRequestId) return;
          if (authTimer) clearTimeout(authTimer);
          const payload = response.payload;
          if (response.error || !payload || typeof payload !== "object"
            || !("authenticated" in payload) || payload.authenticated !== true) {
            reject(new Error("Gateway authentication failed"));
            ws.close(4001, "Unauthorized");
            return;
          }
          this._connected = true;
          this.reconnectAttempt = 0;
          this.emit("connected");
          resolve();
          return;
        }
        this.handleMessage(ev.data as string);
      };

      this.ws = ws;
    });
  }

  /** Probe the authenticated socket before reusing it after a browser suspension. */
  ensureConnected(): Promise<void> {
    if (this.healthCheckPromise) return this.healthCheckPromise;
    const checking = this.checkConnection();
    this.healthCheckPromise = checking;
    void checking.finally(() => {
      if (this.healthCheckPromise === checking) this.healthCheckPromise = null;
    }).catch(() => {});
    return checking;
  }

  private async checkConnection(): Promise<void> {
    const epoch = this.connectionEpoch;
    const socket = this.ws;
    if (this._connected && socket?.readyState === WebSocket.OPEN) {
      try {
        await this.request(GatewayRequestType.ENGINE_LIST, {}, 5_000);
        return;
      } catch {
        if (this.manualClose || epoch !== this.connectionEpoch) throw new Error("Client disconnected");
        if (this.ws !== socket) return this.connect();
      }
    } else if (this.connectionPromise) {
      return this.connectionPromise;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // Detach first: a delayed close event from the stale socket must not
      // invalidate its authenticated replacement or reject the new requests.
      const stale = this.ws;
      this.ws = null;
      this._connected = false;
      this.rejectAllPending("Connection interrupted");
      this.emit("disconnected", "Connection interrupted");
      stale.close(4000, "Connection health check failed");
    }
    await this.connect();
  }

  disconnect(): void {
    this.connectionEpoch++;
    this.connectionPromise = null;
    this.healthCheckPromise = null;
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
    this._connected = false;
    this.rejectAllPending("Client disconnected");
    this.listeners.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // Will retry via onclose → scheduleReconnect
      });
    }, delay);
  }

  // --- Message handling ---

  private handleMessage(raw: string): void {
    let msg: GatewayMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!msg || typeof msg !== "object") return;

    if (msg.type === "response") {
      // Response to a request
      const resp = msg as GatewayResponse;
      const pending = this.pending.get(resp.requestId);
      if (pending) {
        this.pending.delete(resp.requestId);
        if (pending.timer) clearTimeout(pending.timer);
        if (resp.error) {
          pending.reject(new Error(`${resp.error.code}: ${resp.error.message}`));
        } else {
          pending.resolve(resp.payload);
        }
      }
    } else {
      // Push notification — batch high-frequency events to prevent event loop starvation
      const notif = msg as GatewayNotification;
      if (notif.type === "session.removed") {
        this.discardSessionNotifications((notif.payload as { sessionId: string }).sessionId);
      }
      if (GatewayClient.BATCHED_EVENTS.has(notif.type)) {
        this.notificationQueue.push({ type: notif.type, payload: notif.payload });
        this.scheduleNotificationFlush();
      } else {
        this.emit(notif.type as keyof GatewayClientEvents, notif.payload as any);
      }
    }
  }

  /** Drop buffered output that predates a session removal or restoration. */
  discardSessionNotifications(sessionId: string): void {
    this.notificationQueue = this.notificationQueue.filter((item) => item.payload?.sessionId !== sessionId);
  }

  // --- RPC helper ---

  request<T>(type: string, payload: unknown = {}, timeout = DEFAULT_TIMEOUT): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || !this._connected) {
        return reject(new Error("Not connected to gateway"));
      }

      const requestId = `req_${++this.requestCounter}_${Date.now()}`;

      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeout > 0) {
        timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error(`Request timeout: ${type}`));
        }, timeout);
      }

      this.pending.set(requestId, { resolve, reject, timer });

      const msg: GatewayRequest = { type, requestId, payload };
      try {
        if (this.ws!.readyState !== WebSocket.OPEN) {
          if (timer) clearTimeout(timer);
          this.pending.delete(requestId);
          return reject(new Error("WebSocket is not open"));
        }
        this.ws!.send(JSON.stringify(msg));
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  // --- Notification batching ---

  /**
   * Schedule a flush of queued notifications on the next animation frame.
   * Uses requestAnimationFrame (browser) or setTimeout (Node.js tests) to
   * yield control back to the browser between batches, allowing user input
   * events (mouse, keyboard) to be processed. Without this, a burst of
   * streaming part updates can starve the event loop and freeze the UI.
   *
   * Deduplication: for `message.part.updated` notifications, multiple updates
   * to the same part ID within a single frame are coalesced — only the latest
   * state is emitted. During SSE text streaming, the same text part may be
   * updated 20-50 times per frame (each append of a few tokens). Benchmark
   * data shows deduplication provides 2-3x throughput improvement.
   */
  private scheduleNotificationFlush(): void {
    if (this.notificationFlushScheduled) return;
    this.notificationFlushScheduled = true;

    const flush = () => {
      this.notificationFlushScheduled = false;
      const batch = this.notificationQueue;
      this.notificationQueue = [];

      // Deduplicate message.part.updated: keep only the latest update per part ID.
      // A removal invalidates earlier message and part updates in this frame.
      const dedupedParts = new Map<string, { type: string; payload: any }>();
      const nonPartNotifications: Array<{ type: string; payload: any }> = [];
      const removedMessages = new Set<string>();
      const pendingMessageUpdates = new Map<string, Array<{ type: string; payload: any }>>();
      const supersededMessages = new Set<{ type: string; payload: any }>();
      const messageKey = (sessionId: string, messageId: string) => JSON.stringify([sessionId, messageId]);

      for (const item of batch) {
        if (item.type === "message.removed") {
          const key = messageKey(item.payload.sessionId, item.payload.messageId);
          removedMessages.add(key);
          for (const [partId, pending] of dedupedParts) {
            if (messageKey(pending.payload.sessionId, pending.payload.part.messageId) === key) dedupedParts.delete(partId);
          }
          for (const pending of pendingMessageUpdates.get(key) ?? []) supersededMessages.add(pending);
          pendingMessageUpdates.delete(key);
          nonPartNotifications.push(item);
          continue;
        }
        if (item.type === "message.part.updated" && item.payload?.part?.id) {
          if (removedMessages.has(messageKey(item.payload.sessionId, item.payload.part.messageId))) continue;
          // Overwrite previous update for the same part ID
          dedupedParts.set(item.payload.part.id, item);
        } else {
          if (item.type === "message.updated") {
            const key = messageKey(item.payload.sessionId, item.payload.message.id);
            removedMessages.delete(key);
            const updates = pendingMessageUpdates.get(key) ?? [];
            updates.push(item);
            pendingMessageUpdates.set(key, updates);
          }
          nonPartNotifications.push(item);
        }
      }

      // Emit non-part notifications first (message.updated may signal completion)
      for (const notification of nonPartNotifications) {
        if (supersededMessages.has(notification)) continue;
        this.emit(notification.type as keyof GatewayClientEvents, notification.payload as any);
      }

      // Group deduped parts by messageId. When multiple distinct parts arrive
      // in one frame (e.g. tool-heavy streaming), emit them as a single batch
      // so the handler can merge them in one store mutation instead of N.
      const byMessage = new Map<string, { sessionId: string; parts: any[] }>();
      for (const { payload } of dedupedParts.values()) {
        const messageId = payload.part.messageId;
        let group = byMessage.get(messageId);
        if (!group) {
          group = { sessionId: payload.sessionId, parts: [] };
          byMessage.set(messageId, group);
        }
        group.parts.push(payload.part);
      }

      for (const [messageId, { sessionId, parts }] of byMessage) {
        if (parts.length === 1) {
          // Single part per message: emit as-is (common case for text streaming)
          this.emit("message.part.updated", { sessionId, part: parts[0] } as any);
        } else {
          // Multiple parts per message: emit batch to avoid N separate store updates
          this.emit("message.parts.batch", { sessionId, messageId, parts } as any);
        }
      }
    };

    // Use rAF in browsers, setTimeout in Node.js (tests)
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 0);
    }
  }

  // --- Engine API ---

  listEngines(): Promise<EngineInfo[]> {
    return this.request(GatewayRequestType.ENGINE_LIST);
  }

  getEngineCapabilities(engineType: EngineType): Promise<EngineCapabilities> {
    return this.request(GatewayRequestType.ENGINE_CAPABILITIES, { engineType });
  }

  // --- Session API ---

  listSessions(engineType: EngineType): Promise<UnifiedSession[]> {
    return this.request(GatewayRequestType.SESSION_LIST, { engineType });
  }

  createSession(req: SessionCreateRequest): Promise<UnifiedSession> {
    return this.request(GatewayRequestType.SESSION_CREATE, req);
  }

  getSession(sessionId: string): Promise<UnifiedSession> {
    return this.request(GatewayRequestType.SESSION_GET, { sessionId });
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.request(GatewayRequestType.SESSION_DELETE, { sessionId });
  }

  renameSession(sessionId: string, title: string): Promise<void> {
    return this.request(GatewayRequestType.SESSION_RENAME, { sessionId, title });
  }

  setSessionArchived(sessionId: string, archived: boolean): Promise<void> {
    return this.request(GatewayRequestType.SESSION_ARCHIVE, { sessionId, archived });
  }

  setSessionProject(req: { sessionId: string; projectId: string | null }): Promise<void> {
    return this.request(GatewayRequestType.SESSION_PROJECT_SET, req);
  }

  // --- Message API ---

  sendMessage(req: MessageSendRequest): Promise<UnifiedMessage> {
    // No timeout — agent tasks can run for minutes/hours.
    // Cancellation via cancelMessage(); UI recovery via isLastTurnWorking.
    return this.request(GatewayRequestType.MESSAGE_SEND, req, 0);
  }

  cancelMessage(sessionId: string): Promise<void> {
    return this.request(GatewayRequestType.MESSAGE_CANCEL, { sessionId }, 10_000);
  }

  listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    return this.request(GatewayRequestType.MESSAGE_LIST, { sessionId });
  }

  async getMessageSteps(sessionId: string, messageId: string): Promise<UnifiedPart[]> {
    return this.request<UnifiedPart[]>(GatewayRequestType.MESSAGE_STEPS, { sessionId, messageId });
  }

  // --- Model API ---

  listModels(engineType: EngineType): Promise<ModelListResult> {
    return this.request(GatewayRequestType.MODEL_LIST, { engineType });
  }

  setModel(req: ModelSetRequest): Promise<void> {
    return this.request(GatewayRequestType.MODEL_SET, req);
  }

  updateSessionConfig(req: SessionConfigUpdateRequest): Promise<void> {
    return this.request(GatewayRequestType.SESSION_CONFIG_UPDATE, req);
  }

  // --- Mode API ---

  setMode(req: ModeSetRequest): Promise<void> {
    return this.request(GatewayRequestType.MODE_SET, req);
  }

  // --- Permission API ---

  replyPermission(req: PermissionReplyRequest): Promise<void> {
    return this.request(GatewayRequestType.PERMISSION_REPLY, req);
  }

  // --- Question API ---

  replyQuestion(req: QuestionReplyRequest): Promise<void> {
    return this.request(GatewayRequestType.QUESTION_REPLY, req);
  }

  rejectQuestion(questionId: string): Promise<void> {
    return this.request(GatewayRequestType.QUESTION_REJECT, { questionId });
  }

  // --- Project API ---

  listCatalogs(): Promise<EngineCatalogSnapshot[]> {
    return this.request(GatewayRequestType.CATALOG_LIST);
  }

  createProject(req: CatalogProjectInput & { sourceId: string }): Promise<UnifiedProject> {
    return this.request(GatewayRequestType.PROJECT_CREATE, req);
  }

  updateProject(req: { projectId: string; patch: CatalogProjectPatch }): Promise<UnifiedProject> {
    return this.request(GatewayRequestType.PROJECT_UPDATE, req);
  }

  reorderProjects(req: { sourceId: string; projectIds: string[] }): Promise<void> {
    return this.request(GatewayRequestType.PROJECT_REORDER, req);
  }

  listProjects(engineType: EngineType): Promise<UnifiedProject[]> {
    return this.request(GatewayRequestType.PROJECT_LIST, { engineType });
  }

  setProjectEngine(req: ProjectSetEngineRequest): Promise<void> {
    return this.request(GatewayRequestType.PROJECT_SET_ENGINE, req);
  }

  // --- Cross-engine API (SessionStore) ---

  listAllSessions(): Promise<UnifiedSession[]> {
    return this.request(GatewayRequestType.SESSION_LIST_ALL);
  }

  listAllProjects(): Promise<UnifiedProject[]> {
    return this.request(GatewayRequestType.PROJECT_LIST_ALL);
  }

  deleteProject(projectId: string): Promise<{ success: boolean }> {
    return this.request(GatewayRequestType.PROJECT_DELETE, { projectId });
  }

  importLegacyProjects(
    projects: UnifiedProject[],
  ): Promise<{ success: boolean }> {
    return this.request(GatewayRequestType.IMPORT_LEGACY_PROJECTS, { projects });
  }

  // --- Session Import API ---

  importPreview(req: SessionImportPreviewRequest): Promise<ImportableSession[]> {
    return this.request(GatewayRequestType.SESSION_IMPORT_PREVIEW, req);
  }

  importExecute(req: SessionImportExecuteRequest): Promise<SessionImportResult> {
    // No timeout — importing many sessions with full messages can take minutes
    return this.request(GatewayRequestType.SESSION_IMPORT_EXECUTE, req, 0);
  }

  // --- Slash Command API ---

  listCommands(req: { engineType: EngineType; sessionId?: string }): Promise<EngineCommand[]> {
    return this.request(GatewayRequestType.COMMAND_LIST, req);
  }

  invokeCommand(req: CommandInvokeRequest): Promise<CommandInvokeResult> {
    return this.request(GatewayRequestType.COMMAND_INVOKE, req, 0); // No timeout, same as sendMessage
  }

  // --- Cron / Scheduled Tasks API ---
  // Note: Cron RPC methods are not yet implemented on the gateway server.
  // These stubs are provided for future use; calling them will reject
  // with a clear error until the backend handlers are added.

  createCronJob(_req: CronCreateRequest): Promise<CronCreateResult> {
    return Promise.reject(new Error("Cron RPC is not implemented on the gateway server yet."));
  }

  deleteCronJob(_jobId: string): Promise<boolean> {
    return Promise.reject(new Error("Cron RPC is not implemented on the gateway server yet."));
  }

  listCronJobs(_sessionId?: string): Promise<CronJobInfo[]> {
    return Promise.reject(new Error("Cron RPC is not implemented on the gateway server yet."));
  }

  // --- File Explorer API ---

  listFiles(directory: string, rootDirectory: string): Promise<FileExplorerNode[]> {
    return this.request(GatewayRequestType.FILE_LIST, { directory, rootDirectory });
  }

  readFile(path: string, directory: string): Promise<FileExplorerContent> {
    return this.request(GatewayRequestType.FILE_READ, { path, directory });
  }

  getGitStatus(directory: string): Promise<GitFileStatus[]> {
    return this.request(GatewayRequestType.FILE_GIT_STATUS, { directory });
  }

  getGitDiff(directory: string, path: string): Promise<string> {
    return this.request(GatewayRequestType.FILE_GIT_DIFF, { directory, path });
  }

  watchDirectory(directory: string): Promise<void> {
    return this.request(GatewayRequestType.FILE_WATCH, { directory });
  }

  unwatchDirectory(directory: string): Promise<void> {
    return this.request(GatewayRequestType.FILE_UNWATCH, { directory });
  }

  // --- Scheduled Tasks API ---

  listScheduledTasks(): Promise<ScheduledTask[]> {
    return this.request(GatewayRequestType.SCHEDULED_TASK_LIST);
  }

  getScheduledTask(id: string): Promise<ScheduledTask | null> {
    return this.request(GatewayRequestType.SCHEDULED_TASK_GET, { id });
  }

  createScheduledTask(req: ScheduledTaskCreateRequest): Promise<ScheduledTask> {
    return this.request(GatewayRequestType.SCHEDULED_TASK_CREATE, req);
  }

  updateScheduledTask(req: ScheduledTaskUpdateRequest): Promise<ScheduledTask> {
    return this.request(GatewayRequestType.SCHEDULED_TASK_UPDATE, req);
  }

  deleteScheduledTask(id: string): Promise<{ success: boolean }> {
    return this.request(GatewayRequestType.SCHEDULED_TASK_DELETE, { id });
  }

  runScheduledTaskNow(id: string): Promise<ScheduledTaskRunResult> {
    return this.request(GatewayRequestType.SCHEDULED_TASK_RUN_NOW, { id });
  }

  // --- Integrated Terminal (PTY) API ---

  createTerminal(req: TerminalCreateRequest): Promise<TerminalCreateResponse> {
    return this.request(GatewayRequestType.TERMINAL_CREATE, req);
  }

  writeTerminal(terminalId: string, data: string): Promise<void> {
    // Fire-and-forget semantics with a short timeout so a stuck terminal
    // doesn't pile up promises. We still wait for the ack so back-pressure
    // can propagate up to the caller.
    return this.request(GatewayRequestType.TERMINAL_WRITE, { terminalId, data }, 10_000);
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
    return this.request(
      GatewayRequestType.TERMINAL_RESIZE,
      { terminalId, cols, rows },
      10_000,
    );
  }

  destroyTerminal(terminalId: string): Promise<void> {
    return this.request(GatewayRequestType.TERMINAL_DESTROY, { terminalId }, 10_000);
  }

  listTerminals(req: TerminalListRequest = {}): Promise<TerminalListResponse> {
    return this.request(GatewayRequestType.TERMINAL_LIST, req);
  }

  // --- Log forwarding (fire-and-forget, no response expected) ---

  sendLog(level: string, args: unknown[]): void {
    if (!this.ws || !this._connected || this.ws.readyState !== WebSocket.OPEN) {
      return; // silently drop — we can't log failures from the logger itself
    }
    try {
      this.ws.send(JSON.stringify({
        type: GatewayRequestType.LOG_SEND,
        requestId: "",
        payload: { level, args },
      }));
    } catch {
      // ignore — never let log forwarding break the app
    }
  }
}

// Singleton instance
export const gatewayClient = new GatewayClient();
