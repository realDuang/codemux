// ============================================================================
// Gateway WebSocket Client (Node.js)
// Connects to the Gateway WebSocket server from the main process using the `ws`
// module. Provides the same typed RPC interface as the browser GatewayClient.
// ============================================================================

import WebSocket from "ws";
import { GATEWAY_PORT } from "../../../shared/ports";
import {
  GatewayRequestType,
  GatewayNotificationType,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayNotification,
  type GatewayMessage,
  type EngineType,
  type EngineInfo,
  type EngineCapabilities,
  type AgentMode,
  type UnifiedSession,
  type UnifiedMessage,
  type ModelListResult,
  type UnifiedProject,
  type UnifiedPart,
  type UnifiedPermission,
  type UnifiedQuestion,
  type SessionCreateRequest,
  type MessageSendRequest,
  type PermissionReplyRequest,
  type QuestionReplyRequest,
  type ProjectSetEngineRequest,
  type ModelSetRequest,
  type ModeSetRequest,
  type SessionConfigPatch,
  type SessionConfigUpdateRequest,
} from "../../../src/types/unified";
import { channelLog } from "../services/logger";
import { canonicalCodexEngineType } from "../engines/codex/conversation-migration";

// --- Event types ---

export interface GatewayWsClientEvents {
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (err: Error) => void;

  // Push notifications from gateway
  "message.part.updated": (data: { sessionId: string; part: UnifiedPart }) => void;
  "message.updated": (data: { sessionId: string; message: UnifiedMessage }) => void;
  "session.updated": (data: { session: UnifiedSession }) => void;
  "session.created": (data: { session: UnifiedSession }) => void;
  "permission.asked": (data: { permission: UnifiedPermission }) => void;
  "permission.replied": (data: { permissionId: string; optionId: string }) => void;
  "question.asked": (data: { question: UnifiedQuestion }) => void;
  "question.replied": (data: { questionId: string; answers: string[][] }) => void;
  "engine.status.changed": (data: { engineType: EngineType; status: string; error?: string }) => void;
}

// --- Pending request tracking ---

interface PendingRequest {
  resolve: (payload: any) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

// --- Constants ---

const DEFAULT_TIMEOUT = 120_000; // 2 min
const RECONNECT_DELAYS = [500, 1000, 2000, 5000];

type EventHandler = (...args: any[]) => void;

function notificationRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function notificationSessionId(payload: Record<string, unknown>): string | undefined {
  return [payload.sessionId, notificationRecord(payload.session)?.id,
    ...["message", "part", "permission", "question"].map(key => notificationRecord(payload[key])?.sessionId)]
    .find((id): id is string => typeof id === "string" && id.trim().length > 0);
}

/** Rewrite only session references; native message, part, and interaction IDs stay stable. */
function aliasNotificationPayload(payload: Record<string, unknown>, canonicalId: string, aliasId: string): Record<string, unknown> {
  const rewritten = { ...payload };
  if (rewritten.sessionId === canonicalId) rewritten.sessionId = aliasId;
  for (const key of ["message", "part", "permission", "question", "session"]) {
    const nested = notificationRecord(payload[key]);
    if (!nested) continue;
    rewritten[key] = aliasNotificationPayload(nested, canonicalId, aliasId);
    if (key === "session" && nested.id === canonicalId) {
      (rewritten[key] as Record<string, unknown>).id = aliasId;
    }
  }
  for (const key of ["parts", "inlineAssets"]) {
    const parts = payload[key];
    if (!Array.isArray(parts)) continue;
    rewritten[key] = parts.map(part => {
      const nested = notificationRecord(part);
      return nested ? aliasNotificationPayload(nested, canonicalId, aliasId) : part;
    });
  }
  return rewritten;
}

// --- Client ---

export class GatewayWsClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;
  private _connected = false;
  private wsUrl: string;
  private listeners = new Map<string, Set<EventHandler>>();

  constructor(url: string = `ws://127.0.0.1:${GATEWAY_PORT}`) {
    this.wsUrl = url;
  }

  get connected(): boolean {
    return this._connected;
  }

  // --- Typed event emitter ---

  on<K extends keyof GatewayWsClientEvents>(event: K, handler: GatewayWsClientEvents[K]): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler as EventHandler);
    return this;
  }

  off<K extends keyof GatewayWsClientEvents>(event: K, handler: GatewayWsClientEvents[K]): this {
    this.listeners.get(event)?.delete(handler as EventHandler);
    return this;
  }

  private emit<K extends keyof GatewayWsClientEvents>(
    event: K,
    ...args: Parameters<GatewayWsClientEvents[K]>
  ): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const h of handlers) h(...args);
    }
  }

  // --- Connection lifecycle ---

  connect(url?: string): Promise<void> {
    if (this.ws) return Promise.resolve();
    this.manualClose = false;

    if (url) {
      this.wsUrl = url;
    }

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);

      ws.on("open", () => {
        this._connected = true;
        this.reconnectAttempt = 0;
        this.emit("connected");
        const endpoint = new URL(this.wsUrl);
        channelLog.info(`Gateway WS connected: ${endpoint.origin}${endpoint.pathname}`);
        resolve();
      });

      ws.on("close", (code, reason) => {
        const wasConnected = this._connected;
        this._connected = false;
        this.ws = null;
        this.rejectAllPending("Connection closed");
        this.emit("disconnected", reason?.toString() || `closed (${code})`);

        if (!wasConnected) {
          reject(new Error("Failed to connect to gateway"));
        }

        if (!this.manualClose) {
          this.scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      });

      ws.on("message", (data) => {
        this.handleMessage(data.toString());
      });

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
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt++;

    channelLog.verbose(`Gateway WS reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

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
      // Legacy channel bindings retain their conversation IDs after consolidation.
      // Expand here so browser clients still receive one canonical notification.
      const notif = msg as GatewayNotification;
      const payload = notificationRecord(notif.payload);
      const canonicalId = payload && notificationSessionId(payload);
      const aliases = canonicalId && Array.isArray(payload?.conversationAliases)
        ? [...new Set(payload.conversationAliases.filter((id): id is string =>
          typeof id === "string" && id.trim().length > 0 && id !== canonicalId))]
        : [];
      const deliveries = [notif.payload, ...aliases.map(alias => aliasNotificationPayload(payload!, canonicalId!, alias))];
      for (const delivery of deliveries) this.emit(notif.type as keyof GatewayWsClientEvents, delivery as any);
    }
  }

  // --- RPC helper ---

  private request<T>(type: string, payload: unknown = {}, timeout = DEFAULT_TIMEOUT): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || !this._connected) {
        return reject(new Error("Not connected to gateway"));
      }

      const requestId = `ch_${++this.requestCounter}_${Date.now()}`;

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
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
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
    // No timeout — agent tasks can run for minutes/hours
    return this.request(GatewayRequestType.MESSAGE_SEND, req, 0);
  }

  cancelMessage(sessionId: string): Promise<void> {
    return this.request(GatewayRequestType.MESSAGE_CANCEL, { sessionId }, 10_000);
  }

  listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    return this.request(GatewayRequestType.MESSAGE_LIST, { sessionId });
  }

  // --- Model API ---

  listModels(engineType: EngineType): Promise<ModelListResult> {
    return this.request(GatewayRequestType.MODEL_LIST, { engineType });
  }

  setModel(req: ModelSetRequest): Promise<void> {
    return this.request(GatewayRequestType.MODEL_SET, req);
  }

  updateSessionConfig(sessionId: string, config: SessionConfigPatch): Promise<void> {
    const req: SessionConfigUpdateRequest = { sessionId, config };
    return this.request(GatewayRequestType.SESSION_CONFIG_UPDATE, req);
  }

  // --- Mode API ---

  async listModes(engineType: EngineType): Promise<AgentMode[]> {
    const engines = await this.listEngines();
    const canonicalType = canonicalCodexEngineType(engineType);
    return engines.find((engine) => engine.type === canonicalType)?.capabilities.availableModes ?? [];
  }

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

  // --- Cross-engine API ---

  listAllSessions(): Promise<UnifiedSession[]> {
    return this.request(GatewayRequestType.SESSION_LIST_ALL);
  }

  listAllProjects(): Promise<UnifiedProject[]> {
    return this.request(GatewayRequestType.PROJECT_LIST_ALL);
  }

  deleteProject(projectId: string): Promise<{ success: boolean }> {
    return this.request(GatewayRequestType.PROJECT_DELETE, { projectId });
  }
}
