import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import type { GatewayNotification, GatewayResponse, UnifiedMessage, UnifiedSession } from "../../src/types/unified";

// Run against an existing dedicated Desktop test thread:
// CODEMUX_DESKTOP_TEST_THREAD=<id> bunx vitest run --config vitest.desktop-live.config.ts
// Read-only by default. CODEMUX_DESKTOP_TEST_WRITE=1 additionally sends ONE echo
// prompt to that thread. It does not retry, create threads, or start another app.
const fixture = vi.hoisted(() => ({ directory: "" }));

// Only the Electron shell and unrelated services are replaced. IPC, the Desktop
// adapter, conversation persistence, EngineManager, and WebSockets remain real.
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => {
      if (!fixture.directory) throw new Error("Live test storage has not been initialized");
      return fixture.directory;
    },
  },
}));
vi.mock("../../electron/main/services/logger", () => {
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  return {
    default: { scope: () => logger },
    gatewayLog: logger,
    engineManagerLog: logger,
    conversationStoreLog: logger,
    getDefaultEngineFromSettings: () => "codex-desktop",
  };
});
vi.mock("../../electron/main/services/file-service", () => ({ onFileChange() {}, unwatchAll() {} }));
vi.mock("../../electron/main/services/scheduled-task-service", () => ({ scheduledTaskService: { on() {} } }));
vi.mock("../../electron/main/services/orchestrator-service", () => ({ orchestratorService: { init() {}, on() {} } }));
vi.mock("../../electron/main/services/terminal-service", () => ({ getTerminalService: () => ({ on() {}, destroyByOwner() {} }) }));

import { CodexDesktopAdapter } from "../../electron/main/engines/codex/desktop-adapter";
import { EngineManager } from "../../electron/main/gateway/engine-manager";
import { GatewayServer } from "../../electron/main/gateway/ws-server";
import { conversationStore } from "../../electron/main/services/conversation-store";

const targetThread = process.env.CODEMUX_DESKTOP_TEST_THREAD?.trim();
const writesEnabled = process.env.CODEMUX_DESKTOP_TEST_WRITE === "1";

describe.skipIf(!targetThread)("Codex Desktop live Gateway integration", () => {
  let manager: EngineManager;
  let adapter: CodexDesktopAdapter;
  let gateway: GatewayServer;
  let httpServer: Server;
  let clientA: GatewayPeer;
  let clientB: GatewayPeer;
  let url: string;
  let conversationId: string;

  beforeAll(async () => {
    fixture.directory = await mkdtemp(join(tmpdir(), "codemux-desktop-gateway-"));
    conversationStore.init();
    manager = new EngineManager();
    adapter = new CodexDesktopAdapter({ turnTimeoutMs: 100_000 });
    manager.registerAdapter(adapter);
    manager.initFromStore();

    const token = randomUUID();
    gateway = new GatewayServer(manager, { authValidator: (candidate) => candidate === token });
    httpServer = createServer();
    gateway.start({ server: httpServer, path: "/ws" });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Live test server did not bind a loopback port");
    url = `ws://127.0.0.1:${address.port}/ws?token=${token}`;
    [clientA, clientB] = await Promise.all([GatewayPeer.connect(url), GatewayPeer.connect(url)]);

    const session = await adapter.attachThread(targetThread!);
    const result = await clientA.request<{ imported: number; errors: string[] }>("session.import.execute", {
      engineType: "codex-desktop",
      sessions: [{
        engineSessionId: targetThread,
        directory: session.directory,
        title: session.title ?? "Desktop connectivity test",
        createdAt: session.time.created,
        updatedAt: session.time.updated,
        engineMeta: { codexThreadId: targetThread, desktopHostId: "local" },
      }],
    });
    // Do not print error bodies or historical message content in test output.
    expect({ imported: result.imported, errors: result.errors.length }).toEqual({ imported: 1, errors: 0 });
    const imported = conversationStore.list({ engineType: "codex-desktop" });
    expect(imported.length).toBe(1);
    conversationId = imported[0].id;
    expect(conversationId).not.toBe(targetThread);
  });

  afterAll(async () => {
    await Promise.allSettled([clientA?.close(), clientB?.close()]);
    gateway?.stop();
    if (manager) await manager.stopAll();
    if (httpServer?.listening) await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    if (fixture.directory) {
      await conversationStore.flushAll();
      await rm(fixture.directory, { recursive: true, force: true });
      fixture.directory = "";
    }
  });

  async function checkBothClients(): Promise<UnifiedMessage[]> {
    const [messagesA, messagesB, sessionA, sessionB] = await Promise.all([
      clientA.request<UnifiedMessage[]>("message.list", { sessionId: conversationId }),
      clientB.request<UnifiedMessage[]>("message.list", { sessionId: conversationId }),
      clientA.request<UnifiedSession>("session.get", { sessionId: conversationId }),
      clientB.request<UnifiedSession>("session.get", { sessionId: conversationId }),
    ]);
    expect(messagesA.length).toBeGreaterThan(0);
    expect(digest(messagesA)).toBe(digest(messagesB));
    expect(messagesA.every((message) => message.sessionId === conversationId)).toBe(true);
    expect([sessionA.id, sessionB.id]).toEqual([conversationId, conversationId]);
    expect([sessionA.engineMeta?.codexThreadId, sessionB.engineMeta?.codexThreadId]).toEqual([targetThread, targetThread]);
    expect(conversationStore.get(conversationId)?.engineSessionId).toBe(targetThread);
    return messagesA;
  }

  it("imports the existing thread into temporary storage and gives two clients the same history after reconnect", async () => {
    const before = await checkBothClients();
    await clientB.close();
    clientB = await GatewayPeer.connect(url);
    const after = await checkBothClients();
    expect(digest(after)).toBe(digest(before));
    await conversationStore.flushAll();
    const index = JSON.parse(await readFile(join(fixture.directory, "conversations", "index.json"), "utf8")) as { conversations: Array<{ engineSessionId: string }> };
    expect(index.conversations.map((entry) => entry.engineSessionId)).toEqual([targetThread]);
  });

  it.skipIf(!writesEnabled)("sends one no-tools echo through client A and streams the same user and answer to client B", async () => {
    const source = await adapter.getSession(targetThread!);
    expect(source?.activityStatus, "Use an idle dedicated thread for the write test").toBe("idle");
    const baseline = await checkBothClients();
    const existingIds = new Set(baseline.map((message) => message.id));
    const marker = `CODEMUX_GATEWAY_${randomUUID()}`;
    const prompt = `For this connectivity test only, do not use tools, read or modify files, or run commands. Reply with exactly this token and nothing else: ${marker}`;
    const userArrived = clientB.waitForMessage((message) => message.sessionId === conversationId && message.role === "user" && textOf(message) === prompt);
    const answerArrived = clientB.waitForMessage((message) => message.sessionId === conversationId && message.role === "assistant" && message.time.completed != null && textOf(message).trim() === marker);
    const [reply] = await Promise.all([
      clientA.request<UnifiedMessage>("message.send", { sessionId: conversationId, content: [{ type: "text", text: prompt }] }, 110_000),
      userArrived,
      answerArrived,
    ]);
    expect(reply.error == null).toBe(true);
    expect(textOf(reply).trim() === marker).toBe(true);

    const messages = await checkBothClients();
    const added = messages.filter((message) => !existingIds.has(message.id));
    expect(added.filter((message) => message.role === "user" && textOf(message) === prompt).length).toBe(1);
    expect(added.some((message) => message.parts.some((part) => part.type === "tool"))).toBe(false);
    expect(added.some((message) => message.role === "assistant" && textOf(message).trim() === marker)).toBe(true);
    await clientB.close();
    clientB = await GatewayPeer.connect(url);
    expect(digest(await checkBothClients())).toBe(digest(messages));
    expect((await adapter.getSession(targetThread!))?.id).toBe(targetThread);
  });
});

interface PendingRpc {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class GatewayPeer {
  private readonly pending = new Map<string, PendingRpc>();
  private readonly messageObservers = new Set<(message: UnifiedMessage) => void>();
  private readonly closingObservers = new Set<() => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as GatewayResponse | GatewayNotification;
      if (message.type === "response") {
        const response = message as GatewayResponse;
        const pending = this.pending.get(response.requestId);
        if (!pending) return;
        this.pending.delete(response.requestId);
        clearTimeout(pending.timer);
        if (response.error) pending.reject(new Error(`Gateway request failed (${response.error.code})`));
        else pending.resolve(response.payload);
      } else if (message.type === "message.updated") {
        const payload = message.payload as { message: UnifiedMessage };
        for (const observer of this.messageObservers) observer(payload.message);
      }
    });
    socket.on("error", () => this.rejectPending());
    socket.on("close", () => this.rejectPending());
  }

  static async connect(url: string): Promise<GatewayPeer> {
    const socket = new WebSocket(url);
    const peer = new GatewayPeer(socket);
    await once(socket, "open");
    return peer;
  }

  request<T>(type: string, payload: unknown, timeoutMs = 20_000): Promise<T> {
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Gateway request timed out (${type})`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve: (payload) => resolve(payload as T), reject, timer });
      this.socket.send(JSON.stringify({ type, requestId, payload }));
    });
  }

  waitForMessage(predicate: (message: UnifiedMessage) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Expected cross-client message did not arrive")), 110_000);
      const observer = (message: UnifiedMessage) => { if (predicate(message)) finish(); };
      const closed = () => finish(new Error("Gateway disconnected before the expected message"));
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.messageObservers.delete(observer);
        this.closingObservers.delete(closed);
        if (error) reject(error); else resolve();
      };
      this.messageObservers.add(observer);
      this.closingObservers.add(closed);
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, "close");
    this.socket.close();
    await closed;
  }

  private rejectPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Gateway connection closed"));
    }
    this.pending.clear();
    for (const observer of [...this.closingObservers]) observer();
  }
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function textOf(message: UnifiedMessage): string { return message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"); }
