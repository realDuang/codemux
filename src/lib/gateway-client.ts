/**
 * Gateway WebSocket Client
 * Connects to the main-process GatewayServer and provides a typed RPC interface.
 */

import { gatewayAPI } from "./electron-api";
import { isElectron } from "./platform";
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
  type UnifiedPermission,
  type UnifiedQuestion,
  type UnifiedPart,
  type SessionCreateRequest,
  type MessageSendRequest,
  type PermissionReplyRequest,
  type QuestionReplyRequest,
  type ProjectSetEngineRequest,
  type ModelSetRequest,
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
  type TeamRun,
  type TeamCreateRequest,
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
  "session.updated": (data: { session: UnifiedSession }) => void;
  "session.created": (data: { session: UnifiedSession }) => void;
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

  /** Orchestration push notifications (PR #117) */
  "orchestration.updated": (data: { run: OrchestrationRun }) => void;

  /** Agent Team push notifications */
  "team.run.updated": (data: { run: TeamRun }) => void;
  "team.task.updated": (data: { runId: string; task: any }) => void;
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

  async connect(url?: string): Promise<void> {
    if (this.ws) return;
    this.manualClose = false;

    if (url) {
      this.wsUrl = url;
    } else if (!this.wsUrl) {
      if (isElectron()) {
        // In Electron: get full WS URL from main process via IPC
        // Dev mode: ws://127.0.0.1:4200
        // Packaged mode: ws://127.0.0.1:${WEB_PORT}/ws (attached to production server)
        this.wsUrl = await gatewayAPI.getWsUrl();
      } else {
        // In remote browser: derive WS URL from current page location
        // Production (Cloudflare Tunnel): wss://tunnel-host/ws
        // Dev fallback: ws://localhost:4200
        const loc = window.location;
        const wsProtocol = loc.protocol === "https:" ? "wss:" : "ws:";
        this.wsUrl = `${wsProtocol}//${loc.host}/ws`;
      }
    }

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl!);

      ws.onopen = () => {
        this._connected = true;
        this.reconnectAttempt = 0;
        this.emit("connected");
        resolve();
      };

      ws.onclose = (ev) => {
        const wasConnected = this._connected;
        this._connected = false;
        this.ws = null;
        this.rejectAllPending("Connection closed");
        this.emit("disconnected", ev.reason || "closed");

        if (!wasConnected) {
          reject(new Error("Failed to connect to gateway"));
        }

        if (!this.manualClose) {
          this.scheduleReconnect();
        }
      };

      ws.onerror = () => {
        // Error details come via onclose; just emit for logging
        this.emit("error", new Error("WebSocket error"));
      };

      ws.onmessage = (ev) => {
        this.handleMessage(ev.data as string);
      };

      this.ws = ws;
    });
  }

  disconnect(): void {
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
      if (GatewayClient.BATCHED_EVENTS.has(notif.type)) {
        this.notificationQueue.push({ type: notif.type, payload: notif.payload });
        this.scheduleNotificationFlush();
      } else {
        this.emit(notif.type as keyof GatewayClientEvents, notif.payload as any);
      }
    }
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
      // Other notification types (message.updated) are emitted as-is.
      const dedupedParts = new Map<string, { type: string; payload: any }>();
      const nonPartNotifications: Array<{ type: string; payload: any }> = [];

      for (const item of batch) {
        if (item.type === "message.part.updated" && item.payload?.part?.id) {
          // Overwrite previous update for the same part ID
          dedupedParts.set(item.payload.part.id, item);
        } else {
          nonPartNotifications.push(item);
        }
      }

      // Emit non-part notifications first (message.updated may signal completion)
      for (const { type, payload } of nonPartNotifications) {
        this.emit(type as keyof GatewayClientEvents, payload as any);
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

  // --- Agent Team API ---

  createTeamRun(req: TeamCreateRequest): Promise<TeamRun> {
    return this.request(GatewayRequestType.TEAM_CREATE, req);
  }

  cancelTeamRun(runId: string): Promise<void> {
    return this.request(GatewayRequestType.TEAM_CANCEL, { runId });
  }

  sendTeamMessage(runId: string, text: string): Promise<void> {
    return this.request(GatewayRequestType.TEAM_SEND_MESSAGE, { runId, text });
  }

  listTeamRuns(): Promise<TeamRun[]> {
    return this.request(GatewayRequestType.TEAM_LIST);
  }

  getTeamRun(runId: string): Promise<TeamRun | null> {
    return this.request(GatewayRequestType.TEAM_GET, { runId });
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
