import { createHash, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { EngineCatalogSnapshot, GatewayNotification, GatewayResponse, UnifiedMessage } from "../../src/types/unified";

// Creates one dedicated native thread with the runtime's default history mode.
// CODEMUX_DESKTOP_TEST_CATALOG=1 bunx vitest run --config vitest.desktop-live.config.ts
// Optional CODEMUX_DESKTOP_TEST_CATALOG_HOLD_MS (0..300000) exposes this temporary
// authenticated loopback Gateway for renderer acceptance after all checks pass.
const fixture = vi.hoisted(() => ({ directory: "" }));
vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => {
  if (!fixture.directory) throw new Error("Live test storage has not been initialized");
  return fixture.directory;
} } }));
vi.mock("../../electron/main/services/logger", () => {
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  return { default: { scope: () => logger }, gatewayLog: logger, engineManagerLog: logger,
    conversationStoreLog: logger, codexLog: logger, getDefaultEngineFromSettings: () => "codex-desktop" };
});
vi.mock("../../electron/main/services/file-service", () => ({ onFileChange() {}, unwatchAll() {} }));
vi.mock("../../electron/main/services/scheduled-task-service", () => ({ scheduledTaskService: { on() {} } }));
vi.mock("../../electron/main/services/orchestrator-service", () => ({ orchestratorService: { init() {}, on() {} } }));
vi.mock("../../electron/main/services/terminal-service", () => ({ getTerminalService: () => ({ on() {}, destroyByOwner() {} }) }));

import { CodexAdapter } from "../../electron/main/engines/codex";
import { resolveCodexCliPath } from "../../electron/main/engines/codex/config";
import { CodexDesktopCatalog } from "../../electron/main/engines/codex/desktop-catalog";
import { CodexDesktopIpcClient } from "../../electron/main/engines/codex/desktop-ipc-client";
import { createCodexDesktopSharing, type CodexDesktopSharingService } from "../../electron/main/engines/codex/desktop-sharing";
import { CodexJsonRpcClient } from "../../electron/main/engines/codex/jsonrpc-client";
import { EngineManager } from "../../electron/main/gateway/engine-manager";
import { GatewayServer } from "../../electron/main/gateway/ws-server";
import { conversationStore } from "../../electron/main/services/conversation-store";

const enabled = process.env.CODEMUX_DESKTOP_TEST_CATALOG === "1";
const holdMs = enabled ? parseHoldMs(process.env.CODEMUX_DESKTOP_TEST_CATALOG_HOLD_MS) : 0;
const SYNC_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 110_000;
// A cold read can cross two 10-second native router discovery windows.
const COLD_READ_TIMEOUT_MS = 60_000;
interface Enrollment { sourceId: string; cutoffMs: number }
interface Runtime {
  metadata: CodexAdapter; execution: CodexAdapter; service: CodexDesktopSharingService;
  ownerClient: CodexDesktopIpcClient; followerClient: CodexDesktopIpcClient;
  manager: EngineManager; gateway: GatewayServer; http: Server;
  clients: GatewayPeer[]; url: string; baseUrl: string;
}
interface NativeThread extends Record<string, unknown> {
  id: string; historyMode?: string; canAcceptDirectInput?: boolean | null;
  turns?: Array<{ id: string; items: Array<{ id: string; type: string; text?: string }> }>;
}

describe.skipIf(!enabled)("Codex Desktop live catalog integration", () => {
  const natives = new Set<CodexJsonRpcClient>();
  const nativeProcesses = new Set<ChildProcess>();
  const runtimes = new Set<Runtime>();
  const indexWrites = new Set<Promise<void>>();
  let originalWriteIndex: (() => Promise<void>) | undefined;
  let workspace = "";
  let manifestPath = "";
  let tokenFile = "";
  let token = "";
  let stage = "prepare";
  let runtimeErrors = 0;

  beforeAll(async () => {
    fixture.directory = await mkdtemp(join(tmpdir(), "codemux-desktop-catalog-"));
    workspace = join(fixture.directory, "native-workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "AGENTS.md"), [
      "# Live catalog fixture", "", "Do not use tools, run commands, read files, or modify files.",
      "Return only the exact echo token requested by the test. Do not begin background work.", "",
    ].join("\n"), { mode: 0o600 });
    token = randomUUID();
    tokenFile = join(fixture.directory, "gateway-token");
    await writeFile(tokenFile, token, { mode: 0o600 });
    manifestPath = join(fixture.directory, "catalog-enrollment.json");
    await writeFile(manifestPath, JSON.stringify({ sourceId: `live-${randomUUID()}`, cutoffMs: Math.floor(Date.now() / 1000) * 1000 }), { mode: 0o600 });
    // Track actual I/O without substituting data or changing Store behavior.
    // flushAll() alone cannot see an index write already started by its timer.
    originalWriteIndex = Reflect.get(conversationStore, "writeIndex") as () => Promise<void>;
    Reflect.set(conversationStore, "writeIndex", () => {
      const write = originalWriteIndex!.call(conversationStore);
      indexWrites.add(write);
      void write.finally(() => indexWrites.delete(write)).catch(() => {});
      return write;
    });
    conversationStore.init();
  });

  afterAll(async () => {
    const stops = await Promise.allSettled([...runtimes].map(stopRuntime));
    const nativeStops = await Promise.allSettled([...natives].map((client) => client.stop()));
    const processStops = await Promise.allSettled([...nativeProcesses].map(stopOwnedProcess));
    await flushStore();
    if (originalWriteIndex) Reflect.set(conversationStore, "writeIndex", originalWriteIndex);
    if (fixture.directory) await rm(fixture.directory, { recursive: true, force: true });
    fixture.directory = "";
    expect(stops.every((result) => result.status === "fulfilled"), "All test Gateway runtimes stopped").toBe(true);
    expect(nativeStops.every((result) => result.status === "fulfilled") && [...natives].every((client) => !client.running), "All test native processes stopped").toBe(true);
    expect(processStops.every((result) => result.status === "fulfilled"), "Every spawned native process actually exited").toBe(true);
  }, 90_000);

  async function nativeClient(): Promise<CodexJsonRpcClient> {
    const cliPath = resolveCodexCliPath();
    if (!cliPath) throw new Error("Codex CLI is unavailable");
    const client = new CodexJsonRpcClient({ cliPath, args: ["app-server"] });
    natives.add(client);
    client.on("error", () => { runtimeErrors += 1; });
    // Any approval/tool-side server request is outside this bounded echo test.
    client.on("request", () => { runtimeErrors += 1; });
    await client.start();
    rememberProcess(client);
    await client.request("initialize", { clientInfo: { name: "codemux-catalog-live", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    client.notify("initialized");
    return client;
  }

  async function makeRuntime(): Promise<Runtime> {
    const enrollment = JSON.parse(await readFile(manifestPath, "utf8")) as Enrollment;
    const metadata = new CodexAdapter();
    const execution = new CodexAdapter();
    const ownerClient = new CodexDesktopIpcClient();
    const followerClient = new CodexDesktopIpcClient();
    const facade = metadata.createDesktopCatalogClient();
    const service = createCodexDesktopSharing({
      privateExecutionAdapter: execution, ownerClient, followerClient,
      readStoredThread: (id) => metadata.readStoredThread(id),
      renameStoredThread: (id, title) => metadata.renameStoredThread(id, title),
      archiveStoredThread: (id) => metadata.archiveStoredThread(id),
      unarchiveStoredThread: (id) => metadata.unarchiveStoredThread(id),
      catalogFactory: () => new CodexDesktopCatalog({
        ...enrollment, pollIntervalMs: 250,
        previouslyAdmittedThreadIds: conversationStore.list({ engineType: "codex-desktop" })
          .filter((entry) => entry.catalogSourceId === enrollment.sourceId)
          .flatMap((entry) => entry.engineSessionId ? [entry.engineSessionId] : []),
        // The native cwd filter prevents this fixture from enrolling user chats.
        // Every metadata result still comes from the actual native app-server.
        client: { request: (method, params) => facade.request(method, method === "thread/list" ? { ...params, cwd: workspace } : params),
          subscribe: facade.subscribe, dispose: facade.dispose },
        onError: () => { runtimeErrors += 1; },
      }),
      catalogManagement: false, turnTimeoutMs: TURN_TIMEOUT_MS, syncTimeoutMs: SYNC_TIMEOUT_MS,
      onError: () => { runtimeErrors += 1; },
    });
    const manager = new EngineManager();
    manager.registerAdapter(service.adapter);
    manager.initFromStore();
    const gateway = new GatewayServer(manager, { authValidator: (candidate) => candidate === token });
    const http = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const authorized = request.headers.authorization === `Bearer ${token}`;
      let statusCode = 200;
      let payload: unknown;
      if (pathname === "/api/system/is-local") payload = { isLocal: true };
      else if (pathname === "/api/system/info") payload = { port: request.socket.localPort };
      else if (pathname === "/api/auth/local-auth" && request.method === "POST") payload = { success: true, token, deviceId: "catalog-live-fixture" };
      else if (pathname === "/api/auth/validate") payload = { valid: authorized, deviceId: "catalog-live-fixture" };
      else if (pathname === "/api/settings/shared" && authorized) payload = { settings: { defaultEngine: "codex-desktop", locale: "en" } };
      else if (pathname === "/api/admin/pending-requests" && authorized) payload = { requests: [] };
      else { statusCode = 404; payload = { error: "Fixture route not found" }; }
      response.writeHead(statusCode, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(payload));
    });
    gateway.start({ server: http, path: "/ws" });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Fixture Gateway did not bind loopback");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const url = `ws://127.0.0.1:${address.port}/ws?token=${token}`;
    const runtime = { metadata, execution, service, ownerClient, followerClient, manager, gateway, http, clients: [] as GatewayPeer[], url, baseUrl };
    runtimes.add(runtime);
    runtime.clients = await Promise.all([GatewayPeer.connect(url), GatewayPeer.connect(url)]);
    await manager.startEngine("codex-desktop");
    // The running-status event starts the catalog asynchronously.
    await Promise.all(runtime.clients.map((client) => client.waitForCatalog((snapshot) => snapshot.sourceId === enrollment.sourceId)));
    return runtime;
  }

  async function stopRuntime(runtime: Runtime): Promise<void> {
    const processes: ChildProcess[] = [];
    for (const adapter of [runtime.metadata, runtime.execution]) {
      const client = Reflect.get(adapter, "client") as CodexJsonRpcClient | null;
      if (client) {
        rememberProcess(client);
        const process = Reflect.get(client, "proc") as ChildProcess | null;
        if (process) processes.push(process);
      }
    }
    const outcomes = await Promise.allSettled(runtime.clients.map((client) => client.close()));
    outcomes.push(...await Promise.allSettled([Promise.resolve().then(() => runtime.gateway.stop())]));
    outcomes.push(...await Promise.allSettled([runtime.service.stop()]));
    // Always stop the exact adapters even if a peer or service cleanup failed.
    outcomes.push(...await Promise.allSettled([runtime.metadata.stop(), runtime.execution.stop()]));
    outcomes.push(...await Promise.allSettled(processes.map(stopOwnedProcess)));
    outcomes.push(...await Promise.allSettled([
      Promise.resolve().then(() => runtime.ownerClient.close()),
      Promise.resolve().then(() => runtime.followerClient.close()),
    ]));
    const writes = Reflect.get(runtime.manager, "authoritativeMessageWrites") as Map<string, Promise<void>>;
    outcomes.push(...await Promise.allSettled([...writes.values()]));
    outcomes.push(...await Promise.allSettled([flushStore()]));
    if (runtime.http.listening) {
      const closed = new Promise<void>((resolve, reject) => runtime.http.close((error) => error ? reject(error) : resolve()));
      runtime.http.closeAllConnections();
      outcomes.push(...await Promise.allSettled([closed]));
    }
    expect(runtime.execution.getStatus()).toBe("stopped");
    expect(runtime.metadata.getStatus()).toBe("stopped");
    runtimes.delete(runtime);
    expect(outcomes.every((result) => result.status === "fulfilled"), "Every runtime cleanup stage completed").toBe(true);
  }

  function rememberProcess(client: CodexJsonRpcClient): void {
    const process = Reflect.get(client, "proc") as ChildProcess | null;
    if (process) nativeProcesses.add(process);
  }

  async function flushStore(): Promise<void> {
    const storeWrites = Reflect.get(conversationStore, "writeLocks") as Map<string, Promise<void>>;
    await Promise.all([...storeWrites.values()]);
    while (indexWrites.size > 0) await Promise.all([...indexWrites]);
    await conversationStore.flushAll();
    while (indexWrites.size > 0) await Promise.all([...indexWrites]);
  }

  async function assertMetadataOnly(runtime: Runtime): Promise<void> {
    const loaded = record(await nativeRpc(runtime.metadata).request("thread/loaded/list", {}));
    expect(Array.isArray(loaded.data) && loaded.data.length === 0, "Metadata app-server does not load native threads").toBe(true);
    expect((await runtime.metadata.listSessions()).length).toBe(0);
    expect(runtime.execution.getStatus(), "Catalog reads never start the private execution runtime").toBe("stopped");
  }

  it("discovers default-history threads, synchronizes metadata, safely acquires input, and survives restart", async () => {
    try {
      stage = "start-catalog";
      const originalEnrollment = await readFile(manifestPath, "utf8");
      const enrollment = JSON.parse(originalEnrollment) as Enrollment;
      const first = await makeRuntime();
      await Promise.all(first.clients.map((client) => client.request("catalog.list", {})));
      await assertMetadataOnly(first);

      stage = "native-default-create";
      const creator = await nativeClient();
      // Deliberately omit historyMode: this is the deployed native default.
      const created = record(await creator.request("thread/start", { cwd: workspace, approvalPolicy: "never", sandbox: "read-only" }));
      const thread = created.thread as NativeThread;
      const threadId = thread.id;
      expect(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)).toBe(true);
      const initialMarker = `CATALOG_NATIVE_${randomUUID()}`;
      stage = "native-materialize";
      await nativeEcho(creator, threadId, initialMarker);
      const initialHistory = await readNative(creator, threadId);
      const originalItems = itemIds(initialHistory);
      expect(originalItems.length > 0).toBe(true);
      expect(hasAnswer(initialHistory, initialMarker)).toBe(true);
      report({ stage: "catalog-native-created", threadId, historyMode: initialHistory.historyMode ?? thread.historyMode ?? "unspecified", createdAfterCutoff: Number(thread.createdAt) * 1000 >= enrollment.cutoffMs });

      stage = "automatic-discovery";
      const discovered = await Promise.all(first.clients.map((client) => client.waitForCatalog((snapshot) => snapshot.sourceId === enrollment.sourceId && snapshot.sessions.some((session) => session.engineMeta?.codexThreadId === threadId))));
      const sessions = discovered.map((snapshot) => snapshot.sessions.find((session) => session.engineMeta?.codexThreadId === threadId)!);
      const conversationId = sessions[0].id;
      expect(conversationId.startsWith("conv_") && sessions.every((session) => session.id === conversationId)).toBe(true);
      expect(sessions.every((session) => session.time.created >= enrollment.cutoffMs)).toBe(true);
      expect(conversationStore.list().length).toBe(1);
      await assertMetadataOnly(first);

      stage = "native-rename-poll";
      const title = `Catalog live ${randomUUID().slice(0, 8)}`;
      await creator.request("thread/name/set", { threadId, name: title });
      await Promise.all(first.clients.map((client) => client.waitForCatalog((snapshot) => snapshot.sessions.some((session) => session.id === conversationId && session.title === title))));
      await assertMetadataOnly(first);

      stage = "native-writer-lock";
      const contender = await nativeClient();
      let refused = false;
      try { await contender.request("thread/resume", { threadId, cwd: workspace }); }
      catch (error) { refused = error instanceof Error && /already has an active writer/.test(error.message); }
      expect(refused, "A second runtime is refused while the original writer is alive").toBe(true);
      // Never submit a turn through the rejected competing writer.
      await contender.stop();
      await creator.stop();

      stage = "gateway-explicit-input";
      const continuationMarker = `CATALOG_GATEWAY_${randomUUID()}`;
      const content = echoPrompt(continuationMarker);
      const answerPush = first.clients[1].waitForMessage((message) => message.sessionId === conversationId && message.role === "assistant" && message.time.completed != null && textOf(message).trim() === continuationMarker);
      const [reply] = await Promise.all([
        first.clients[0].request<UnifiedMessage>("message.send", { sessionId: conversationId, content: [{ type: "text", text: content }] }, TURN_TIMEOUT_MS), answerPush,
      ]);
      expect(reply.error == null && textOf(reply).trim() === continuationMarker).toBe(true);
      const after = await synchronized(first, conversationId, continuationMarker);
      expect(after.some((message) => message.parts.some((part) => part.type === "tool"))).toBe(false);
      expect(first.execution.getStatus()).toBe("running");
      const ownedNative = await readNative(nativeRpc(first.execution), threadId);
      expect(ownedNative.id === threadId && ownedNative.canAcceptDirectInput === true).toBe(true);
      expect(ownedNative.historyMode === initialHistory.historyMode).toBe(true);
      expect(originalItems.every((id) => itemIds(ownedNative).includes(id)), "Continuation preserves original native item identities").toBe(true);
      expect(hasAnswer(ownedNative, initialMarker) && hasAnswer(ownedNative, continuationMarker)).toBe(true);
      expect(conversationStore.findByEngineSession(threadId, "codex-desktop", enrollment.sourceId)?.id).toBe(conversationId);

      stage = "restart-store-and-service";
      await stopRuntime(first);
      // Flush before clearing the singleton's caches; init reads the real index.
      Reflect.set(conversationStore, "initialized", false);
      Reflect.set(conversationStore, "index", new Map());
      Reflect.set(conversationStore, "catalogs", new Map());
      conversationStore.init();
      expect(await readFile(manifestPath, "utf8")).toBe(originalEnrollment);
      expect(conversationStore.findByEngineSession(threadId, "codex-desktop", enrollment.sourceId)?.id).toBe(conversationId);
      const second = await makeRuntime();
      const restarted = await Promise.all(second.clients.map((client) => client.request<EngineCatalogSnapshot[]>("catalog.list", {})));
      expect(restarted.every((catalogs) => catalogs.some((catalog) => catalog.sourceId === enrollment.sourceId && catalog.sessions.some((session) => session.id === conversationId && session.title === title)))).toBe(true);
      await assertMetadataOnly(second);
      const persisted = await readNative(nativeRpc(second.metadata), threadId);
      expect(digest(itemIds(persisted))).toBe(digest(itemIds(ownedNative)));
      expect(hasAnswer(persisted, initialMarker) && hasAnswer(persisted, continuationMarker)).toBe(true);
      const coldReadStarted = Date.now();
      await synchronized(second, conversationId, continuationMarker, COLD_READ_TIMEOUT_MS);
      const coldReadMs = Date.now() - coldReadStarted;
      await assertMetadataOnly(second);
      expect(runtimeErrors, "No asynchronous owner or catalog failures").toBe(0);
      report({ stage: "catalog-passed", threadId, conversationId, historyMode: initialHistory.historyMode, twoClients: true, metadataOnly: true, renamePolled: true, writerLock: true, originalHistoryPreserved: true, restartMappingPreserved: true, coldReadMs });

      if (holdMs > 0) {
        stage = "browser-hold";
        expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
        const handoff = { stage: "catalog-hold", baseUrl: second.baseUrl, tokenFile, threadId, conversationId, workspace, title, holdMs };
        await writeFile(join(fixture.directory, "gateway-hold.json"), JSON.stringify(handoff), { mode: 0o600 });
        report(handoff);
        const until = Date.now() + holdMs;
        while (Date.now() < until) await pause(Math.min(1000, until - Date.now()));
      }
    } catch (error) {
      report({ stage, event: "catalog-acceptance-error", error: safeError(error) });
      // The original cause can contain provider bodies or credentials.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Live catalog acceptance failed during ${stage}; provider details are withheld`);
    }
  }, 360_000 + holdMs);
});

async function synchronized(runtime: Runtime, conversationId: string, marker: string, timeoutMs = SYNC_TIMEOUT_MS): Promise<UnifiedMessage[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const values = await Promise.all(runtime.clients.map((client) => client.request<UnifiedMessage[]>("message.list", { sessionId: conversationId }, timeoutMs)));
    if (digest(values[0]) === digest(values[1]) && values[0].some((message) => message.role === "assistant" && textOf(message).trim() === marker)) return values[0];
    if (Date.now() >= deadline) throw new Error("Gateway clients did not converge on native history");
    await pause(100);
  }
}

async function nativeEcho(client: CodexJsonRpcClient, threadId: string, marker: string): Promise<void> {
  let listener: ((method: string, params: unknown) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Native echo timed out")), TURN_TIMEOUT_MS);
    listener = (method, params) => {
      const event = record(params);
      if (event.threadId !== threadId) return;
      if (method === "item/completed") {
        const type = record(event.item).type;
        if (type !== "userMessage" && type !== "agentMessage" && type !== "reasoning") reject(new Error("Native echo used an unexpected item type"));
      }
      if (method === "turn/completed") {
        if (record(event.turn).status === "completed") resolve(); else reject(new Error("Native echo did not complete successfully"));
      }
    };
    client.on("notification", listener);
  });
  try {
    await Promise.all([completed, client.request("turn/start", {
      threadId, input: [{ type: "text", text: echoPrompt(marker), text_elements: [] }], effort: "low", approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (listener) client.off("notification", listener);
  }
}

interface PendingRpc { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
class GatewayPeer {
  private readonly pending = new Map<string, PendingRpc>();
  private readonly catalogs: EngineCatalogSnapshot[] = [];
  private readonly messages: UnifiedMessage[] = [];
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
      } else if (message.type === "catalog.updated") this.catalogs.push(message.payload as EngineCatalogSnapshot);
      else if (message.type === "message.updated") this.messages.push((message.payload as { message: UnifiedMessage }).message);
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
  request<T>(type: string, payload: unknown, timeoutMs = SYNC_TIMEOUT_MS): Promise<T> {
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`Gateway request timed out (${type})`)); }, timeoutMs);
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
      this.socket.send(JSON.stringify({ type, requestId, payload }));
    });
  }
  async waitForCatalog(predicate: (snapshot: EngineCatalogSnapshot) => boolean): Promise<EngineCatalogSnapshot> {
    const deadline = Date.now() + SYNC_TIMEOUT_MS;
    for (;;) {
      const found = this.catalogs.find(predicate);
      if (found) return found;
      if (Date.now() >= deadline || this.socket.readyState !== WebSocket.OPEN) throw new Error("Expected automatic catalog notification did not arrive");
      await pause(50);
    }
  }
  async waitForMessage(predicate: (message: UnifiedMessage) => boolean): Promise<void> {
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    for (;;) {
      if (this.messages.some(predicate)) return;
      if (Date.now() >= deadline || this.socket.readyState !== WebSocket.OPEN) throw new Error("Expected cross-client answer did not arrive");
      await pause(50);
    }
  }
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, "close");
    this.socket.close();
    await closed;
  }
  private rejectPending(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Gateway disconnected")); }
    this.pending.clear();
  }
}

function parseHoldMs(value: string | undefined): number {
  const parsed = value ? Number(value) : 0;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 300_000) throw new Error("CODEMUX_DESKTOP_TEST_CATALOG_HOLD_MS must be an integer from 0 to 300000");
  return parsed;
}
function nativeRpc(adapter: CodexAdapter): CodexJsonRpcClient {
  const client = Reflect.get(adapter, "client") as CodexJsonRpcClient | null;
  if (!client?.running) throw new Error("Native adapter has no running client");
  return client;
}
async function readNative(client: CodexJsonRpcClient, threadId: string): Promise<NativeThread> {
  const thread = record(await client.request("thread/read", { threadId, includeTurns: true })).thread as NativeThread;
  if (thread?.id !== threadId) throw new Error("Native read returned a different thread");
  return thread;
}
function itemIds(thread: NativeThread): string[] { return (thread.turns ?? []).flatMap((turn) => turn.items.map((item) => item.id)); }
function hasAnswer(thread: NativeThread, marker: string): boolean { return (thread.turns ?? []).some((turn) => turn.items.some((item) => item.type === "agentMessage" && item.text?.trim() === marker)); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function echoPrompt(marker: string): string { return `For this connectivity test only, do not use tools, read or modify files, browse, or run commands. Reply with exactly this token and nothing else: ${marker}`; }
function textOf(message: UnifiedMessage): string { return message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"); }
function pause(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function stopOwnedProcess(process: ChildProcess): Promise<void> {
  const exited = () => process.exitCode !== null || process.signalCode !== null;
  if (exited()) return;
  process.kill("SIGTERM");
  const deadline = Date.now() + 5000;
  while (!exited() && Date.now() < deadline) await pause(50);
  if (!exited()) {
    process.kill("SIGKILL");
    const killDeadline = Date.now() + 5000;
    while (!exited() && Date.now() < killDeadline) await pause(50);
  }
  if (!exited()) throw new Error("A test-owned native process did not exit");
}
// Bypass Vitest's per-test console buffering so the bounded HOLD is usable.
function report(value: Record<string, unknown>): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown failure").split("\n")[0]
    .replace(/https?:\/\/\S+/gi, "[url]").replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[:=]\s*\S+/gi, "[credential redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 240);
}
