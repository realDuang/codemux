import { randomUUID } from "node:crypto";
import { lookup } from "node:dns";
import { createConnection } from "node:net";
import WebSocket from "ws";
import {
  chatReducer, rootReducer, sessionReducer, SUPPORTED_PROTOCOL_VERSIONS,
  type ActionEnvelope, type ChatAction, type ChatState, type RootAction, type RootState,
  type SessionAction, type SessionState, type Snapshot, type StateAction, type CommandMap,
} from "@microsoft/agent-host-protocol";
import { AhpClient, type AhpTransport, type JsonRpcMessage, type TransportFrame } from "@microsoft/agent-host-protocol/client";
import type { AgentHostEndpoint } from "./discovery";
import type { Wire } from "./wire";

export const ROOT = "ahp-root://";

class LocalTransport implements AhpTransport {
  private frames: TransportFrame[] = [];
  private waiting?: (frame: TransportFrame | null) => void;
  private closed = false;

  constructor(private readonly socket: WebSocket) {
    socket.on("message", data => {
      if (this.closed) return;
      const text = data.toString();
      try { JSON.parse(text); } catch { this.close(); return; }
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = undefined;
        resolve({ kind: "text", text });
      } else if (this.frames.length < 4096) this.frames.push({ kind: "text", text });
      else this.close();
    });
    socket.on("close", () => this.finish());
    socket.on("error", () => this.close());
  }
  private finish() {
    this.closed = true;
    this.frames = [];
    this.waiting?.(null);
    this.waiting = undefined;
  }
  send(message: JsonRpcMessage | string) {
    if (this.closed) throw new Error("VS Code connection is closed.");
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }
  async recv(): Promise<TransportFrame | null> {
    return this.frames.shift() ?? (this.closed ? null : new Promise(resolve => { this.waiting = resolve; }));
  }
  close() { this.finish(); this.socket.terminate(); }
}

export interface HostConnectionOptions {
  onChange: (channel: string, envelope?: ActionEnvelope) => void;
  onCatalogChange: () => void;
  onClose: () => void;
}

/** Snapshots and authoritative echoes, never optimistic reducers or retried writes. */
export class AgentHostConnection {
  readonly id = randomUUID();
  readonly sessions = new Map<string, SessionState>();
  readonly chats = new Map<string, ChatState>();
  root?: RootState;
  version?: string;
  connected = false;
  private client?: AhpClient;
  private closed = false;
  private notifiedClose = false;
  private sequences = new Map<string, number>();
  private loading = new Map<string, Promise<void>>();
  private buffered = new Map<string, ActionEnvelope[]>();
  private writes = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(readonly endpoint: AgentHostEndpoint, private readonly options: HostConnectionOptions) {}

  async connect(): Promise<void> {
    const endpoint = this.endpoint.transport;
    const authority = endpoint.type === "tcp"
      ? `${endpoint.host === "::1" ? "[::1]" : endpoint.host}:${endpoint.port}` : "localhost";
    const socket = new WebSocket(`ws://${authority}/?tkn=${encodeURIComponent(this.endpoint.token)}`, {
      ...(endpoint.type === "socket" ? { createConnection: () => createConnection(endpoint.path) } : {}),
      // Resolve localhost once and only dial loopback, including IPv6-only hosts.
      lookup: (hostname, options, callback) => lookup(hostname, { all: true }, (error, addresses) => {
        const local = addresses?.filter(address => address.address === "127.0.0.1" || address.address === "::1");
        if (error || !local?.length) { callback(error ?? new Error("Agent Host must resolve to loopback."), ""); return; }
        if (options.all) callback(null, local);
        else callback(null, local[0].address, local[0].family);
      }),
      handshakeTimeout: 8000, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false,
    });
    const transport = new LocalTransport(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", () => reject(new Error("Cannot connect to the local VS Code Agent Host.")));
        socket.once("close", () => reject(new Error("The local VS Code Agent Host closed the connection.")));
      });
      if (this.closed) throw new Error("VS Code sharing was stopped.");
      const client = this.client = new AhpClient(transport, { requestTimeoutMs: 12000 });
      const events = client.events();
      this.buffered.set(ROOT, []);
      client.connect();
      void (async () => {
        try {
          for await (const { event } of events) {
            if (event.type === "action") this.action(event.params);
            else if (event.type === "authRequired") this.options.onCatalogChange();
            else this.options.onCatalogChange();
          }
        } finally { this.disconnected(); }
      })().catch(() => this.close());
      const init = await client.request("initialize", {
        channel: ROOT, clientId: this.id, protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        clientInfo: { name: "codemux", title: "CodeMux" }, initialSubscriptions: [ROOT],
      });
      this.version = init.protocolVersion;
      for (const snapshot of init.snapshots) this.snapshot(snapshot);
      this.connected = true;
    } catch (error) {
      transport.close();
      this.disconnected();
      throw error;
    }
  }

  request<M extends keyof CommandMap>(method: M, params: CommandMap[M]["params"]): Promise<CommandMap[M]["result"]> {
    return this.client!.request(method, params);
  }

  async subscribe(channel: string): Promise<void> {
    const pending = this.loading.get(channel);
    if (pending) return pending;
    if (this.sequences.has(channel)) return;
    if (!this.connected) throw new Error("VS Code is not connected.");
    this.buffered.set(channel, []);
    const operation = this.client!.request("subscribe", { channel }).then(result => {
      if (!result.snapshot) throw new Error("VS Code did not provide a channel snapshot.");
      this.snapshot(result.snapshot);
    }).finally(() => { this.loading.delete(channel); this.buffered.delete(channel); });
    this.loading.set(channel, operation);
    return operation;
  }

  private snapshot(snapshot: Snapshot) {
    const { resource, state, fromSeq } = snapshot;
    if (resource === ROOT) this.root = state as RootState;
    else if (resource.startsWith("ahp-session:")) this.sessions.set(resource, state as SessionState);
    else if (resource.startsWith("ahp-chat:")) this.chats.set(resource, state as ChatState);
    this.sequences.set(resource, fromSeq);
    const buffered = this.buffered.get(resource) ?? [];
    this.buffered.delete(resource);
    for (const envelope of buffered) this.action(envelope);
    this.options.onChange(resource);
  }

  private action(envelope: ActionEnvelope) {
    const pending = envelope.origin?.clientId === this.id ? this.writes.get(envelope.origin.clientSeq) : undefined;
    if (pending) {
      clearTimeout(pending.timer);
      this.writes.delete(envelope.origin!.clientSeq);
      if (envelope.rejectionReason) pending.reject(new Error("VS Code rejected the action. Refresh this conversation and try again."));
      else pending.resolve();
    }
    if (envelope.rejectionReason) return;
    const queued = this.buffered.get(envelope.channel);
    if (queued) {
      if (queued.length >= 4096) { void this.close(); return; }
      queued.push(envelope);
      return;
    }
    const seq = this.sequences.get(envelope.channel);
    if (seq === undefined || envelope.serverSeq <= seq) return;
    this.sequences.set(envelope.channel, envelope.serverSeq);
    if (envelope.channel === ROOT && this.root) this.root = rootReducer(this.root, envelope.action as RootAction);
    const session = this.sessions.get(envelope.channel);
    if (session) this.sessions.set(envelope.channel, sessionReducer(session, envelope.action as SessionAction));
    const chat = this.chats.get(envelope.channel);
    if (chat) this.chats.set(envelope.channel, chatReducer(chat, envelope.action as ChatAction));
    this.options.onChange(envelope.channel, envelope);
  }

  dispatch(channel: string, action: Wire<StateAction>): Promise<void> {
    if (!this.connected) return Promise.reject(new Error("VS Code is not connected. Reopen its original session to continue."));
    return new Promise((resolve, reject) => {
      const { clientSeq } = this.client!.dispatch(channel, action as StateAction);
      const timer = setTimeout(() => {
        this.writes.delete(clientSeq);
        reject(new Error("VS Code did not confirm the action. Its outcome is unknown; refresh before retrying."));
      }, 12000);
      this.writes.set(clientSeq, { resolve, reject, timer });
    });
  }

  private disconnected() {
    if (this.notifiedClose) return;
    this.notifiedClose = true;
    this.connected = false;
    for (const pending of this.writes.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("VS Code disconnected. Refresh before retrying; the action may already have been accepted."));
    }
    this.writes.clear();
    this.options.onClose();
  }

  async close() {
    this.closed = true;
    this.connected = false;
    await this.client?.shutdown();
    this.disconnected();
  }
}
