// ============================================================================
// E2E Test Server
// Standalone HTTP + WebSocket server for integration/E2E testing.
// No Electron dependencies — runs in plain Node.js.
// ============================================================================

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { randomUUID } from "crypto";
import { MockEngineAdapter } from "../../../electron/main/engines/mock-adapter";
import { MockAuthStore } from "./mock-auth-store";
import { seedTestData } from "./seed-data";
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
  type UnifiedSession,
  type UnifiedProject,
} from "../../../src/types/unified";

// --- MIME types for static file serving ---

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

// --- HTTP helpers ---

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-opencode-directory",
  });
  res.end(body);
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-opencode-directory");
}

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function extractBearerToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

// --- WebSocket client tracking ---

interface WsClient {
  id: string;
  ws: WebSocket;
}

// --- Configuration & Result types ---

export interface TestServerConfig {
  /** Port for HTTP server (0 = auto-assign) */
  port?: number;
  /** Path to built renderer files for static serving */
  staticRoot?: string;
}

export interface TestServerInstance {
  baseUrl: string;
  wsUrl: string;
  port: number;
  mockAdapters: Map<string, MockEngineAdapter>;
  authStore: MockAuthStore;
  /** Pre-register session→engine routing (call after seeding) */
  registerSessionRoutes: () => Promise<void>;
  stop: () => Promise<void>;
}

// ============================================================================
// startTestServer
// ============================================================================

export async function startTestServer(
  config?: TestServerConfig,
): Promise<TestServerInstance> {
  const requestedPort = config?.port ?? 0;
  const staticRoot = config?.staticRoot ?? path.resolve(__dirname, "../../../out/renderer");

  // --- Create mock adapters ---

  const opencodeAdapter = new MockEngineAdapter({ engineType: "opencode", name: "Mock OpenCode" });
  const copilotAdapter = new MockEngineAdapter({ engineType: "copilot", name: "Mock Copilot" });

  const adapters = new Map<string, MockEngineAdapter>([
    ["opencode", opencodeAdapter],
    ["copilot", copilotAdapter],
  ]);

  // Start both adapters
  await opencodeAdapter.start();
  await copilotAdapter.start();

  // --- Auth state ---

  const authStore = new MockAuthStore();

  // --- Routing state ---

  /** sessionId -> engineType */
  const sessionEngineMap = new Map<string, EngineType>();
  /** permissionId -> engineType */
  const permissionEngineMap = new Map<string, EngineType>();
  /** directory -> engineType project bindings */
  const projectBindings = new Map<string, EngineType>();

  // --- Helper: resolve adapter for a session ---

  function getAdapterForSession(sessionId: string): MockEngineAdapter {
    const engineType = sessionEngineMap.get(sessionId);
    if (!engineType) {
      throw Object.assign(
        new Error(`No engine binding found for session: ${sessionId}`),
        { code: "SESSION_NOT_FOUND" },
      );
    }
    const adapter = adapters.get(engineType);
    if (!adapter) {
      throw Object.assign(
        new Error(`No adapter registered for engine type: ${engineType}`),
        { code: "ENGINE_NOT_FOUND" },
      );
    }
    return adapter;
  }

  // --- WebSocket client management ---

  const wsClients = new Map<string, WsClient>();

  function broadcast(notification: GatewayNotification): void {
    const msg = JSON.stringify(notification);
    for (const client of wsClients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  function sendToClient(client: WsClient, response: GatewayResponse): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(response));
    }
  }

  // --- Subscribe to adapter events and broadcast ---

  function subscribeAdapterEvents(adapter: MockEngineAdapter): void {
    adapter.on("message.part.updated", (data) => {
      broadcast({ type: GatewayNotificationType.MESSAGE_PART_UPDATED, payload: data });
    });

    adapter.on("message.updated", (data) => {
      broadcast({ type: GatewayNotificationType.MESSAGE_UPDATED, payload: data });
    });

    adapter.on("session.updated", (data) => {
      broadcast({ type: GatewayNotificationType.SESSION_UPDATED, payload: data });
    });

    adapter.on("session.created", (data) => {
      // Register newly created sessions for routing
      if (data.session) {
        sessionEngineMap.set(data.session.id, adapter.engineType);
      }
      broadcast({ type: GatewayNotificationType.SESSION_CREATED, payload: data });
    });

    adapter.on("permission.asked", (data) => {
      if (data.permission?.id) {
        permissionEngineMap.set(data.permission.id, adapter.engineType);
      }
      broadcast({ type: GatewayNotificationType.PERMISSION_ASKED, payload: data });
    });

    adapter.on("permission.replied", (data) => {
      broadcast({ type: GatewayNotificationType.PERMISSION_REPLIED, payload: data });
    });

    adapter.on("status.changed", (data) => {
      broadcast({ type: GatewayNotificationType.ENGINE_STATUS_CHANGED, payload: data });
    });
  }

  subscribeAdapterEvents(opencodeAdapter);
  subscribeAdapterEvents(copilotAdapter);

  // --- Request routing ---

  async function routeRequest(request: GatewayRequest): Promise<unknown> {
    const { type, payload } = request;
    const p = payload as any;

    switch (type) {
      // --- Engine ---
      case GatewayRequestType.ENGINE_LIST: {
        return Array.from(adapters.values()).map((a) => a.getInfo());
      }

      case GatewayRequestType.ENGINE_CAPABILITIES: {
        const adapter = adapters.get(p.engineType as string);
        if (!adapter) {
          throw Object.assign(
            new Error(`Unknown engine type: ${p.engineType}`),
            { code: "ENGINE_NOT_FOUND" },
          );
        }
        return adapter.getCapabilities();
      }

      // --- Session ---
      case GatewayRequestType.SESSION_LIST_ALL: {
        const allSessions: UnifiedSession[] = [];
        for (const adapter of adapters.values()) {
          const sessions = await adapter.listSessions();
          for (const s of sessions) {
            sessionEngineMap.set(s.id, adapter.engineType);
          }
          allSessions.push(...sessions);
        }
        return allSessions;
      }

      case GatewayRequestType.SESSION_LIST: {
        const engineType = p.engineType as string | undefined;
        if (engineType && adapters.has(engineType)) {
          const adapter = adapters.get(engineType)!;
          const sessions = await adapter.listSessions();
          for (const s of sessions) {
            sessionEngineMap.set(s.id, adapter.engineType);
          }
          return sessions;
        }
        // Treat as directory-based lookup
        const bindingType = projectBindings.get(p.directory ?? p.engineType);
        if (bindingType) {
          const adapter = adapters.get(bindingType)!;
          const sessions = await adapter.listSessions(p.directory ?? p.engineType);
          for (const s of sessions) {
            sessionEngineMap.set(s.id, adapter.engineType);
          }
          return sessions;
        }
        return [];
      }

      case GatewayRequestType.SESSION_CREATE: {
        const req = p as SessionCreateRequest;
        const adapter = adapters.get(req.engineType);
        if (!adapter) {
          throw Object.assign(
            new Error(`Unknown engine type: ${req.engineType}`),
            { code: "ENGINE_NOT_FOUND" },
          );
        }
        const session = await adapter.createSession(req.directory);
        sessionEngineMap.set(session.id, req.engineType);
        return session;
      }

      case GatewayRequestType.SESSION_GET: {
        const adapter = getAdapterForSession(p.sessionId);
        return adapter.getSession(p.sessionId);
      }

      case GatewayRequestType.SESSION_DELETE: {
        const adapter = getAdapterForSession(p.sessionId);
        await adapter.deleteSession(p.sessionId);
        sessionEngineMap.delete(p.sessionId);
        return { success: true };
      }

      // --- Message ---
      case GatewayRequestType.MESSAGE_SEND: {
        const req = p as MessageSendRequest;
        const adapter = getAdapterForSession(req.sessionId);
        return adapter.sendMessage(req.sessionId, req.content, {
          mode: req.mode,
          modelId: req.modelId,
        });
      }

      case GatewayRequestType.MESSAGE_CANCEL: {
        const adapter = getAdapterForSession(p.sessionId);
        await adapter.cancelMessage(p.sessionId);
        return { success: true };
      }

      case GatewayRequestType.MESSAGE_LIST: {
        const adapter = getAdapterForSession(p.sessionId);
        return adapter.listMessages(p.sessionId);
      }

      // --- Model ---
      case GatewayRequestType.MODEL_LIST: {
        const adapter = adapters.get(p.engineType as string);
        if (!adapter) {
          throw Object.assign(
            new Error(`Unknown engine type: ${p.engineType}`),
            { code: "ENGINE_NOT_FOUND" },
          );
        }
        return adapter.listModels();
      }

      case GatewayRequestType.MODEL_SET: {
        const req = p as ModelSetRequest;
        const adapter = getAdapterForSession(req.sessionId);
        await adapter.setModel(req.sessionId, req.modelId);
        return { success: true };
      }

      // --- Session Rename ---
      case GatewayRequestType.SESSION_RENAME: {
        const adapter = getAdapterForSession(p.sessionId);
        const sessions = await adapter.listSessions();
        const session = sessions.find(s => s.id === p.sessionId);
        if (session) {
          session.title = p.title;
        }
        return { success: true };
      }

      // --- Mode ---
      case GatewayRequestType.MODE_GET: {
        const adapter = getAdapterForSession(p.sessionId);
        const mode = await adapter.getMode(p.sessionId);
        return { mode };
      }

      case GatewayRequestType.MODE_SET: {
        const req = p as ModeSetRequest;
        const adapter = getAdapterForSession(req.sessionId);
        await adapter.setMode(req.sessionId, req.modeId);
        return { success: true };
      }

      // --- Permission ---
      case GatewayRequestType.PERMISSION_REPLY: {
        const req = p as PermissionReplyRequest;
        const engineType = permissionEngineMap.get(req.permissionId);
        if (!engineType) {
          throw Object.assign(
            new Error(`No engine binding found for permission: ${req.permissionId}`),
            { code: "PERMISSION_NOT_FOUND" },
          );
        }
        const adapter = adapters.get(engineType)!;
        permissionEngineMap.delete(req.permissionId);
        await adapter.replyPermission(req.permissionId, { optionId: req.optionId });
        return { success: true };
      }

      // --- Project ---
      case GatewayRequestType.PROJECT_LIST_ALL: {
        const allProjects: UnifiedProject[] = [];
        for (const adapter of adapters.values()) {
          const projects = await adapter.listProjects();
          allProjects.push(...projects);
        }
        return allProjects;
      }

      case GatewayRequestType.PROJECT_LIST: {
        const adapter = adapters.get(p.engineType as string);
        if (!adapter) {
          throw Object.assign(
            new Error(`Unknown engine type: ${p.engineType}`),
            { code: "ENGINE_NOT_FOUND" },
          );
        }
        return adapter.listProjects();
      }

      case GatewayRequestType.PROJECT_SET_ENGINE: {
        const req = p as ProjectSetEngineRequest;
        if (!adapters.has(req.engineType)) {
          throw Object.assign(
            new Error(`Unknown engine type: ${req.engineType}`),
            { code: "ENGINE_NOT_FOUND" },
          );
        }
        projectBindings.set(req.directory, req.engineType);
        return { success: true };
      }

      // --- Log (fire-and-forget, no response needed) ---
      case GatewayRequestType.LOG_SEND: {
        // Silently swallow renderer log forwarding in test mode
        return { success: true };
      }

      default:
        throw Object.assign(
          new Error(`Unknown request type: ${type}`),
          { code: "UNKNOWN_REQUEST" },
        );
    }
  }

  // --- Create the HTTP server ---

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-opencode-directory",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    setCorsHeaders(res);

    // ========================================================================
    // Stub Auth API
    // ========================================================================

    // --- Test control endpoints ---

    if (pathname === "/api/test/set-local" && req.method === "POST") {
      const body = await parseJsonBody(req);
      authStore.setIsLocal(body.isLocal);
      sendJson(res, { success: true });
      return;
    }

    if (pathname === "/api/test/reset-auth" && req.method === "POST") {
      authStore.reset();
      sendJson(res, { success: true });
      return;
    }

    // Reset all mock adapters and re-seed with fresh test data
    if (pathname === "/api/test/reseed" && req.method === "POST") {
      for (const adapter of adapters.values()) {
        adapter.reset();
        await adapter.start();
      }
      sessionEngineMap.clear();
      seedTestData(adapters);
      // Re-register session routes
      for (const [engineType, adapter] of adapters) {
        const sessions = await adapter.listSessions();
        for (const s of sessions) {
          sessionEngineMap.set(s.id, engineType as EngineType);
        }
      }
      sendJson(res, { success: true });
      return;
    }

    // Set slow response mode on a mock adapter for cancel testing
    if (pathname === "/api/test/set-slow-mode" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const adapter = adapters.get(body.engineType);
      if (!adapter) {
        sendJson(res, { error: `Unknown engine type: ${body.engineType}` }, 400);
        return;
      }
      adapter.setSlowMode(body.delayMs ?? 0);
      sendJson(res, { success: true });
      return;
    }

    // --- Auth endpoints ---

    if (pathname === "/api/auth/local-auth" && req.method === "POST") {
      sendJson(res, {
        success: true,
        token: "test-token",
        deviceId: "test-device",
      });
      return;
    }

    if (pathname === "/api/auth/validate" && req.method === "GET") {
      const token = extractBearerToken(req);
      if (token) {
        const result = authStore.verifyToken(token);
        if (result.valid) {
          sendJson(res, { valid: true, deviceId: result.deviceId });
          return;
        }
      }
      // Fallback for existing local auth test-token
      if (token === "test-token") {
        sendJson(res, { valid: true, deviceId: "test-device" });
        return;
      }
      sendJson(res, { valid: false }, 401);
      return;
    }

    if (pathname === "/api/system/is-local" && req.method === "GET") {
      sendJson(res, { isLocal: authStore.getIsLocal() });
      return;
    }

    if (pathname === "/api/auth/request-access" && req.method === "POST") {
      const body = await parseJsonBody(req);
      if (!authStore.verifyAccessCode(body.code)) {
        sendJson(res, { success: false, error: "Invalid code" }, 401);
        return;
      }
      const request = authStore.createPendingRequest(
        body.device || { name: "Unknown", platform: "Unknown", browser: "Unknown" },
        "127.0.0.1",
      );
      sendJson(res, { success: true, requestId: request.id });
      return;
    }

    if (pathname === "/api/auth/check-status" && req.method === "GET") {
      const requestId = url.searchParams.get("requestId");
      if (!requestId) {
        sendJson(res, { status: "not_found" });
        return;
      }
      const request = authStore.getPendingRequest(requestId);
      if (!request) {
        sendJson(res, { status: "not_found" });
        return;
      }
      if (request.status === "approved") {
        sendJson(res, {
          status: "approved",
          token: request.token,
          deviceId: request.deviceId,
        });
      } else {
        sendJson(res, { status: request.status });
      }
      return;
    }

    if (pathname === "/api/auth/code" && req.method === "GET") {
      sendJson(res, { code: authStore.getAccessCode() });
      return;
    }

    // --- Admin endpoints ---

    if (pathname === "/api/admin/pending-requests" && req.method === "GET") {
      sendJson(res, { requests: authStore.listPendingRequests() });
      return;
    }

    if (pathname === "/api/admin/approve" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const approved = authStore.approveRequest(body.requestId);
      if (approved) {
        sendJson(res, { success: true });
      } else {
        sendJson(res, { error: "Request not found or already processed" }, 404);
      }
      return;
    }

    if (pathname === "/api/admin/deny" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const denied = authStore.denyRequest(body.requestId);
      if (denied) {
        sendJson(res, { success: true });
      } else {
        sendJson(res, { error: "Request not found or already processed" }, 404);
      }
      return;
    }

    // ========================================================================
    // Static File Serving (SPA)
    // ========================================================================

    let filePath = path.join(staticRoot, pathname);

    // Security: prevent directory traversal
    const resolvedStaticRoot = path.resolve(staticRoot);
    const resolvedFilePath = path.resolve(filePath);
    if (!resolvedFilePath.startsWith(resolvedStaticRoot)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
    } catch {
      // File not found — SPA fallback to index.html
      filePath = path.join(staticRoot, "index.html");
    }

    try {
      const content = await fs.promises.readFile(filePath);
      const mimeType = getMimeType(filePath);
      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": content.length,
        "Cache-Control": filePath.endsWith(".html") ? "no-cache" : "public, max-age=31536000",
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  // --- Create the WebSocket server at /ws ---

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws) => {
    const clientId = randomUUID();
    const client: WsClient = { id: clientId, ws };
    wsClients.set(clientId, client);

    ws.on("message", async (data) => {
      let request: GatewayRequest;
      try {
        request = JSON.parse(data.toString());
      } catch {
        sendToClient(client, {
          type: "response",
          requestId: "",
          payload: null,
          error: { code: "PARSE_ERROR", message: "Invalid JSON" },
        });
        return;
      }

      try {
        const result = await routeRequest(request);
        sendToClient(client, {
          type: "response",
          requestId: request.requestId,
          payload: result,
        });
      } catch (err: any) {
        sendToClient(client, {
          type: "response",
          requestId: request.requestId,
          payload: null,
          error: {
            code: err.code ?? "INTERNAL_ERROR",
            message: err.message ?? "Unknown error",
          },
        });
      }
    });

    ws.on("close", () => {
      wsClients.delete(clientId);
    });

    ws.on("error", () => {
      wsClients.delete(clientId);
    });
  });

  // --- Listen and resolve ---

  return new Promise<TestServerInstance>((resolve, reject) => {
    httpServer.on("error", reject);

    httpServer.listen(requestedPort, "127.0.0.1", () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;

      const instance: TestServerInstance = {
        baseUrl: `http://127.0.0.1:${actualPort}`,
        wsUrl: `ws://127.0.0.1:${actualPort}/ws`,
        port: actualPort,
        mockAdapters: adapters,
        authStore,
        registerSessionRoutes: async () => {
          for (const [engineType, adapter] of adapters) {
            const sessions = await adapter.listSessions();
            for (const s of sessions) {
              sessionEngineMap.set(s.id, engineType as EngineType);
            }
          }
        },
        stop: async () => {
          // Close all WS clients
          for (const client of wsClients.values()) {
            client.ws.close(1001, "Server shutting down");
          }
          wsClients.clear();

          // Close WS server
          await new Promise<void>((res) => wss.close(() => res()));

          // Stop adapters
          await opencodeAdapter.stop();
          await copilotAdapter.stop();

          // Close HTTP server
          await new Promise<void>((res) => httpServer.close(() => res()));
        },
      };

      resolve(instance);
    });
  });
}
