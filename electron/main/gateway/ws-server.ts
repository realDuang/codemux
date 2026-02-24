// ============================================================================
// WebSocket Gateway Server
// Handles WS connections from frontend/remote clients.
// Routes requests to EngineManager and broadcasts notifications.
// ============================================================================

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import type { Server } from "http";
import { EngineManager } from "./engine-manager";
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
  type ProjectSetEngineRequest,
  type ModelSetRequest,
  type ModeSetRequest,
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

    if ("server" in options) {
      this.wss = new WebSocketServer({ server: options.server, path: options.path });
    } else {
      this.wss = new WebSocketServer({ port: options.port });
    }
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    this.wss.on("error", (err) => {
      console.error("[GatewayServer] WebSocket server error:", err);
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
    console.log(`[GatewayServer] Started on ${addr}`);
  }

  stop(): void {
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
      console.log("[GatewayServer] Stopped");
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
    console.log(`[GatewayServer] Client connected: ${clientId}`);

    ws.on("message", (data) => this.handleMessage(client, data));
    ws.on("close", () => {
      this.clients.delete(clientId);
      console.log(`[GatewayServer] Client disconnected: ${clientId}`);
    });
    ws.on("error", (err) => {
      console.error(`[GatewayServer] Client error (${clientId}):`, err);
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
        return this.engineManager.createSession(req.engineType, req.directory);
      }

      case GatewayRequestType.SESSION_GET:
        return this.engineManager.getSession(p.sessionId);

      case GatewayRequestType.SESSION_DELETE:
        return this.engineManager.deleteSession(p.sessionId);

      // Message
      case GatewayRequestType.MESSAGE_SEND: {
        const req = p as MessageSendRequest;
        return this.engineManager.sendMessage(req.sessionId, req.content, {
          mode: req.mode,
          modelId: req.modelId,
        });
      }

      case GatewayRequestType.MESSAGE_CANCEL:
        return this.engineManager.cancelMessage(p.sessionId);

      case GatewayRequestType.MESSAGE_LIST:
        return this.engineManager.listMessages(p.sessionId);

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
          p.sessionId,
        );
      }

      // Project
      case GatewayRequestType.PROJECT_LIST:
        return this.engineManager.listProjects(p.engineType as EngineType);

      case GatewayRequestType.PROJECT_SET_ENGINE: {
        const req = p as ProjectSetEngineRequest;
        this.engineManager.setProjectEngine(req.directory, req.engineType);
        return { success: true };
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

    em.on("status.changed", (data) => {
      this.broadcast({
        type: GatewayNotificationType.ENGINE_STATUS_CHANGED,
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
