import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket, { WebSocketServer } from "ws";
import { chatReducer, sessionReducer, type ChatAction, type ChatState, type SessionAction, type SessionState, type StateAction, type RootState } from "@microsoft/agent-host-protocol";
import type { Wire } from "../../../../../electron/main/session-sources/agent-host/wire";
import type { AgentHostEndpoint } from "../../../../../electron/main/session-sources/agent-host/discovery";

export async function createAgentHostFixture(provider = "copilotcli", transport: "socket" | "tcp" = "socket") {
  const instance = randomUUID();
  const path = process.platform === "win32" ? `\\\\.\\pipe\\vscode-agent-host-codemux-test-${instance}` : join(tmpdir(), `cm-ahp-${instance}.sock`);
  const endpoint: AgentHostEndpoint = { source: "a".repeat(64), type: transport === "tcp" ? "standalone" : "editor",
    instanceId: instance, pid: process.pid, transport: { type: "socket", path }, token: "test-token-for-local-fixture" };
  const sessionUri = "ahp-session:/fixture";
  const chatUri = "ahp-chat:/fixture";
  const now = "2026-11-19T00:00:00.000Z";
  let session = {
    provider, title: "Native editor chat", status: 1, lifecycle: "ready", activeClients: [],
    chats: [{ resource: chatUri, title: "Native editor chat", status: 1, modifiedAt: now }], defaultChat: chatUri,
    config: { schema: { type: "object", properties: { mode: { type: "string", enum: ["interactive", "plan"], sessionMutable: true } } }, values: { mode: "interactive" } },
  } as SessionState;
  let chat = { resource: chatUri, title: "Native editor chat", status: 1, modifiedAt: now, turns: [] } as ChatState;
  const extraChats = new Map<string, ChatState>();
  let seq = 0;
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url!, "http://localhost").searchParams.get("tkn") !== endpoint.token) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  });
  const clients = new Map<WebSocket, { id: string; subscriptions: Set<string> }>();
  const broadcast = (channel: string, action: Wire<StateAction>, origin?: { clientId: string; clientSeq: number }, rejectionReason?: string) => {
    if (!rejectionReason) {
      if (channel === chatUri) chat = chatReducer(chat, action as ChatAction);
      else if (extraChats.has(channel)) extraChats.set(channel, chatReducer(extraChats.get(channel)!, action as ChatAction));
      if (channel === sessionUri) session = sessionReducer(session, action as SessionAction);
    }
    const params = { channel, action, serverSeq: ++seq, ...(origin ? { origin } : {}), ...(rejectionReason ? { rejectionReason } : {}) };
    for (const [ws, client] of clients) if (ws.readyState === WebSocket.OPEN && client.subscriptions.has(channel)) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "action", params }));
  };
  const fixture = {
    endpoint, sessionUri, chatUri, requests, broadcast, extraChats,
    models: [{ id: "test-model", name: "Test", provider }] as NonNullable<RootState["agents"][number]["models"]>,
    providers: [provider],
    unavailableSession: false,
    get connectionCount() { return clients.size; },
    rejectNext: false,
    get chat() { return chat; },
    get session() { return session; },
    snapshotInterleave: undefined as (() => void) | undefined,
    dropConnections() { for (const ws of wss.clients) ws.terminate(); },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
  wss.on("connection", ws => {
    const client = { id: "", subscriptions: new Set<string>() };
    clients.set(ws, client);
    ws.on("close", () => clients.delete(ws));
    ws.on("message", data => {
      const { id, method, params } = JSON.parse(data.toString());
      requests.push({ method, params });
      const result = (value: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: value }));
      if (method === "initialize") {
        client.id = params.clientId;
        client.subscriptions.add("ahp-root://");
        result({ protocolVersion: "1.1.0", serverSeq: seq, snapshots: [{ resource: "ahp-root://", fromSeq: seq, state: {
          agents: fixture.providers.map(provider => ({ provider, displayName: provider, models: fixture.models.filter(model => model.provider === provider) })),
          activeSessions: [],
        } }] });
      } else if (method === "listSessions") result({ items: [
        ...(fixture.unavailableSession ? [{ resource: "ahp-session:/unavailable", provider: "other-harness" }] : []),
        { resource: sessionUri, ...session },
      ] });
      else if (method === "ping") result(null);
      else if (method === "subscribe") {
        if (params.channel === "ahp-session:/unavailable") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Session unavailable" } }));
          return;
        }
        client.subscriptions.add(params.channel);
        const snapshot = { resource: params.channel, fromSeq: seq, state: structuredClone(params.channel === chatUri ? chat : extraChats.get(params.channel) ?? session) };
        const interleave = fixture.snapshotInterleave;
        fixture.snapshotInterleave = undefined;
        interleave?.();
        result({ snapshot });
      } else if (method === "dispatchAction") {
        const reject = fixture.rejectNext;
        fixture.rejectNext = false;
        broadcast(params.channel, params.action, { clientId: client.id, clientSeq: params.clientSeq }, reject ? "not-allowed" : undefined);
      } else if (method === "unsubscribe") client.subscriptions.delete(params.channel);
      else if (id !== undefined) ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported fixture method" } }));
    });
  });
  await new Promise<void>(resolve => transport === "tcp" ? server.listen(0, "127.0.0.1", resolve) : server.listen(path, resolve));
  const address = server.address();
  if (typeof address === "object" && address) endpoint.transport = { type: "tcp", host: address.address, port: address.port };
  return fixture;
}
