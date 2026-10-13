import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The installed router discovers a target before starting the forwarded request's
// timeoutMs. Its discovery deadline is fixed and independent of that wire value.
const ROUTER_DISCOVERY_TIMEOUT_MS = 10_000;
const RESPONSE_DELIVERY_GRACE_MS = 1_000;

// Private Desktop/IDE protocol verified against Codex Desktop 26.1007.30912.
// Explicit versions prevent silently delivering commands to incompatible owners.
export const DESKTOP_IPC_VERSIONS = {
  "thread-owner-discovery": 1,
  "thread-stream-following-changed": 1,
  "thread-stream-following-status-requested": 1,
  "thread-stream-state-changed": 11,
  "thread-archived": 2,
  "thread-unarchived": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 4,
  "thread-follower-load-complete-history": 1,
  "thread-follower-read-model-settings": 1,
  "thread-follower-update-thread-settings": 2,
  "thread-follower-update-daybreak": 1,
  "thread-follower-compact-thread": 1,
  "thread-follower-edit-last-user-turn": 2,
  "thread-follower-set-queued-follow-ups-state": 1,
  "thread-follower-remove-queued-message": 1,
  "thread-follower-clear-queued-messages": 1,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-permissions-request-approval-response": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-submit-mcp-server-elicitation-response": 1,
} as const;

export type DesktopFollowerMethod = Extract<keyof typeof DESKTOP_IPC_VERSIONS, `thread-follower-${string}`>;
export interface DesktopThreadSnapshot {
  type: "snapshot";
  revision: number;
  conversationState: Record<string, unknown>;
}
export interface DesktopThreadPatches {
  type: "patches";
  baseRevision: number;
  revision: number;
  patches: unknown[];
  acceptedTextChanges?: unknown;
}
export interface DesktopThreadStream {
  conversationId: string;
  hostId: string;
  ownerClientId: string;
  change: DesktopThreadSnapshot | DesktopThreadPatches;
}
export interface DesktopThreadOwner {
  ownerClientId: string;
  supportsUntrustedAppInput: boolean;
}
export interface DesktopThreadAvailabilityEvent {
  conversationId: string;
  hostId: "local";
  sourceClientId: string;
}
export interface DesktopThreadArchivedEvent extends DesktopThreadAvailabilityEvent {
  cwd: string;
}
export interface DesktopSteerOptions {
  input: unknown[];
  restoreMessage: Record<string, unknown>;
  serviceTier?: unknown;
  attachments?: unknown;
  clientUserMessageId?: string;
  additionalContext?: unknown;
  toolOutput?: unknown;
}
export interface DesktopCollaborationMode {
  mode: string;
  settings: {
    model: string;
    reasoning_effort: string | null;
    developer_instructions?: string | null;
  };
}
export interface DesktopThreadSettingsPatch {
  model?: string;
  effort?: string | null;
  collaborationMode?: DesktopCollaborationMode;
  serviceTier?: string | null;
  cwd?: string;
  disabledPluginIds?: string[];
  approvalPolicy?: unknown;
  approvalsReviewer?: string | null;
  activePermissionProfile?: { id: string; extends?: string | null } | null;
  sandboxPolicy?: Record<string, unknown>;
  permissions?: string | null;
  multiAgentMode?: unknown;
}
export interface DesktopThreadSettingsOptions {
  hostId?: string;
  activeTurnId?: string;
  condition?: { ifEffortEquals: string | null; ifModelEquals?: string };
}
export interface DesktopModelSettings {
  model?: string | null;
  reasoningEffort?: string | null;
  daybreakEnabled?: boolean | null;
  resumeState?: string;
  mode?: string | null;
  threadSource?: string | null;
  modelProvider?: string | null;
}
export interface DesktopEditLastUserTurnOptions {
  turnId: string;
  message: string;
  agentMode: string;
  shouldSendPermissionOverrides: boolean;
  serviceTier?: string | null;
  additionalContext?: unknown;
  writingBlockContextPrepared?: boolean;
}
export interface DesktopQueuedFollowUp {
  id: string;
  text: string;
  context: Record<string, unknown>;
  cwd?: string | null;
  createdAt: number;
  [key: string]: unknown;
}
export interface DesktopOwnedThreadRegistration {
  conversationId: string;
  hostId?: string;
  supportedMethods: readonly DesktopFollowerMethod[];
  getSnapshot: () => DesktopThreadSnapshot;
  handleRequest: (method: DesktopFollowerMethod, params: Record<string, unknown>, context: { sourceClientId: string }) => Promise<unknown>;
  supportsUntrustedAppInput?: boolean;
}
interface OwnedThread {
  registration: DesktopOwnedThreadRegistration;
  hostId: string;
  methods: Set<DesktopFollowerMethod>;
  followers: Set<string>;
}
export interface DesktopIpcClientOptions {
  socketPath?: string;
  codexHome?: string;
  /** Target-handler budget; routed calls also allow router discovery and delivery. */
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
}
export interface DesktopFollowerRequestOptions {
  ownerClientId: string;
  hostId?: string;
  timeoutMs?: number;
}
interface IpcResponse {
  type: "response";
  requestId: string;
  resultType: "success" | "error";
  method?: string;
  handledByClientId?: string;
  result?: unknown;
  error?: string;
}
interface PendingRequest {
  method: string;
  ownerClientId?: string;
  resolve: (value: IpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface FollowedThread {
  conversationId: string;
  hostId: string;
  ownerClientId: string;
  snapshot?: DesktopThreadSnapshot;
  promise: Promise<DesktopThreadSnapshot>;
  resolve: (value: DesktopThreadSnapshot) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DesktopIpcClientEvents {
  stream: (stream: DesktopThreadStream) => void;
  ownerDisconnected: (ownerClientId: string) => void;
  followersChanged: (event: { conversationId: string; hostId: string; followerCount: number }) => void;
  threadArchived: (event: DesktopThreadArchivedEvent) => void;
  threadUnarchived: (event: DesktopThreadAvailabilityEvent) => void;
  close: () => void;
  error: (error: Error) => void;
}
export declare interface CodexDesktopIpcClient {
  on<K extends keyof DesktopIpcClientEvents>(event: K, listener: DesktopIpcClientEvents[K]): this;
  off<K extends keyof DesktopIpcClientEvents>(event: K, listener: DesktopIpcClientEvents[K]): this;
}

export class DesktopIpcError extends Error {
  constructor(public readonly code: string, message: string = code) {
    super(message);
    this.name = "DesktopIpcError";
  }
}

/** Attaches to the existing local router; never starts or terminates Codex. */
export class CodexDesktopIpcClient extends EventEmitter {
  readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly maxFrameBytes: number;
  private socket: Socket | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectionEpoch = 0;
  private _clientId: string | null = null;
  private pending = new Map<string, PendingRequest>();
  private owners = new Map<string, DesktopThreadOwner>();
  private followed = new Map<string, FollowedThread>();
  private previouslyFollowed = new Set<string>();
  private owned = new Map<string, OwnedThread>();
  private ownedRequests = new Map<string, Promise<Record<string, unknown>>>();
  private completedOwnedRequests: string[] = [];
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private body: Buffer | null = null;
  private bodyBytes = 0;

  constructor(options: DesktopIpcClientOptions = {}) {
    super();
    this.socketPath = options.socketPath ?? (process.platform === "win32"
      ? "\\\\.\\pipe\\codex-ipc"
      : join(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), "ipc", "ipc.sock"));
    this.timeoutMs = options.requestTimeoutMs ?? 10_000;
    this.maxFrameBytes = options.maxFrameBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 256 || this.maxFrameBytes > 256 * 1024 * 1024) {
      throw new Error("Invalid Desktop IPC frame limit");
    }
  }

  get connected(): boolean { return this._clientId !== null && this.socket?.writable === true; }
  get clientId(): string | null { return this._clientId; }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.open(++this.connectionEpoch).finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  private async open(epoch: number): Promise<void> {
    if (process.platform !== "win32") {
      const [socketInfo, parentInfo] = await Promise.all([lstat(this.socketPath), lstat(dirname(this.socketPath))]);
      const uid = process.getuid?.();
      if (uid == null || !socketInfo.isSocket() || socketInfo.uid !== uid || (socketInfo.mode & 0o077) !== 0 ||
        !parentInfo.isDirectory() || parentInfo.uid !== uid || (parentInfo.mode & 0o022) !== 0) {
        throw new DesktopIpcError("unsafe-endpoint", "Desktop IPC endpoint must be private and owned by the current user");
      }
    }
    if (epoch !== this.connectionEpoch) throw new DesktopIpcError("client-closed");
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    socket.on("data", (data: Buffer) => this.receive(data));
    socket.on("error", () => this.fail(new DesktopIpcError("connection-error", "Desktop IPC connection failed")));
    socket.on("close", () => {
      if (this.socket === socket) this.detach(new DesktopIpcError("connection-closed"));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new DesktopIpcError("connection-timeout")), this.timeoutMs);
        const onConnect = () => finish();
        const onClose = () => finish(new DesktopIpcError("connection-closed"));
        const finish = (error?: Error) => {
          clearTimeout(timer);
          socket.off("connect", onConnect);
          socket.off("close", onClose);
          if (error) reject(error);
          else resolve();
        };
        socket.once("connect", onConnect);
        socket.once("close", onClose);
      });
      const response = await this.sendRequest("initialize", { clientType: "codemux" }, 0);
      if (!isRecord(response.result) || typeof response.result.clientId !== "string" || !response.result.clientId) {
        throw new DesktopIpcError("invalid-initialize-response");
      }
      if (this.socket !== socket || epoch !== this.connectionEpoch) throw new DesktopIpcError("connection-closed");
      this._clientId = response.result.clientId;
    } catch (error) {
      this.detach(error instanceof Error ? error : new DesktopIpcError("connection-failed"));
      throw error;
    }
  }

  /** Detaching only closes this client connection, including its subscriptions. */
  close(): void { this.detach(new DesktopIpcError("client-closed")); }

  async discoverOwner(conversationId: string, hostId = "local"): Promise<DesktopThreadOwner | null> {
    this.assertConnected();
    const key = threadKey(conversationId, hostId);
    try {
      const response = await this.sendRequest("thread-owner-discovery", { conversationId, hostId }, 1);
      if (!response.handledByClientId || !isRecord(response.result)) throw new DesktopIpcError("invalid-owner-response");
      const owner = { ownerClientId: response.handledByClientId, supportsUntrustedAppInput: response.result.supportsUntrustedAppInput === true };
      this.owners.set(key, owner);
      return owner;
    } catch (error) {
      this.owners.delete(key);
      if (error instanceof DesktopIpcError && error.code === "no-client-found") return null;
      throw error;
    }
  }

  /** Only register threads created or explicitly acquired by this execution host. */
  registerOwnedThread(registration: DesktopOwnedThreadRegistration): () => void {
    this.assertConnected();
    const hostId = registration.hostId ?? "local";
    const key = threadKey(registration.conversationId, hostId);
    if (!registration.conversationId || this.owned.has(key) || this.followed.has(key) || this.owners.has(key)) {
      throw new DesktopIpcError("thread-ownership-conflict");
    }
    if (registration.supportedMethods.some((method) => !Object.hasOwn(DESKTOP_IPC_VERSIONS, method) || !method.startsWith("thread-follower-"))) {
      throw new DesktopIpcError("unsupported-method");
    }
    const entry: OwnedThread = { registration, hostId, methods: new Set(registration.supportedMethods), followers: new Set() };
    this.owned.set(key, entry);
    return () => { if (this.owned.get(key) === entry) this.owned.delete(key); };
  }

  publishOwnedThreadState(conversationId: string, change: DesktopThreadSnapshot | DesktopThreadPatches, hostId = "local"): void {
    this.assertConnected();
    const entry = this.owned.get(threadKey(conversationId, hostId));
    if (!entry) throw new DesktopIpcError("thread-not-owned");
    this.sendOwnedState(entry, change, [...entry.followers]);
  }

  followThread(conversationId: string, ownerClientId: string, hostId = "local"): Promise<DesktopThreadSnapshot> {
    this.assertConnected();
    const key = threadKey(conversationId, hostId);
    if (this.owners.get(key)?.ownerClientId !== ownerClientId) return Promise.reject(new DesktopIpcError("owner-not-discovered"));
    const previous = this.followed.get(key);
    if (previous?.ownerClientId === ownerClientId) return previous.snapshot ? Promise.resolve(previous.snapshot) : previous.promise;
    if (previous) this.unfollowThread(conversationId, hostId);
    let resolve!: FollowedThread["resolve"];
    let reject!: FollowedThread["reject"];
    const promise = new Promise<DesktopThreadSnapshot>((yes, no) => { resolve = yes; reject = no; });
    const entry: FollowedThread = {
      conversationId, hostId, ownerClientId, promise, resolve, reject,
      timer: setTimeout(() => {
        this.unfollowThread(conversationId, hostId, new DesktopIpcError("snapshot-timeout"));
      }, this.timeoutMs),
    };
    this.followed.set(key, entry);
    this.previouslyFollowed.add(key);
    try { this.sendFollowing(entry, true); }
    catch (error) { this.unfollowThread(conversationId, hostId, error instanceof Error ? error : new DesktopIpcError("write-failed")); }
    return promise;
  }

  unfollowThread(conversationId: string, hostId = "local", error: Error = new DesktopIpcError("thread-detached")): void {
    const key = threadKey(conversationId, hostId);
    const entry = this.followed.get(key);
    if (!entry) return;
    this.followed.delete(key);
    clearTimeout(entry.timer);
    entry.reject(error);
    if (this.connected) this.sendFollowing(entry, false);
  }

  isFollowingThread(conversationId: string, ownerClientId: string, hostId = "local"): boolean {
    const key = threadKey(conversationId, hostId);
    const entry = this.followed.get(key);
    return this.connected && entry?.snapshot != null && entry.ownerClientId === ownerClientId
      && this.owners.get(key)?.ownerClientId === ownerClientId;
  }

  /**
   * Replays an already verified unarchived state after a metadata write. This is
   * not an archive/unarchive operation. Desktop refreshes metadata but may not
   * push a snapshot, so callers must separately confirm the refreshed state.
   */
  notifyThreadMetadataAvailable(conversationId: string, ownerClientId: string, hostId = "local"): void {
    this.assertConnected();
    if (!this.isFollowingThread(conversationId, ownerClientId, hostId)) throw new DesktopIpcError("thread-not-synchronized");
    this.write({
      type: "broadcast", method: "thread-unarchived", version: DESKTOP_IPC_VERSIONS["thread-unarchived"],
      sourceClientId: this._clientId, targetClientIds: [ownerClientId],
      params: { conversationId, hostId },
    });
  }

  /** Broadcast only after native storage has confirmed the archived state. */
  notifyThreadArchived(conversationId: string, cwd: string, hostId = "local"): void {
    this.assertConnected();
    if (!conversationId || !cwd || hostId !== "local") throw new DesktopIpcError("invalid-thread-notification");
    this.write({
      type: "broadcast", method: "thread-archived", version: DESKTOP_IPC_VERSIONS["thread-archived"],
      sourceClientId: this._clientId,
      params: { conversationId, hostId, cwd },
    });
  }

  /** Broadcast only after native storage has confirmed the active state. */
  notifyThreadUnarchived(conversationId: string, hostId = "local"): void {
    this.assertConnected();
    if (!conversationId || hostId !== "local") throw new DesktopIpcError("invalid-thread-notification");
    this.write({
      type: "broadcast", method: "thread-unarchived", version: DESKTOP_IPC_VERSIONS["thread-unarchived"],
      sourceClientId: this._clientId,
      params: { conversationId, hostId },
    });
  }

  async requestFollower(method: DesktopFollowerMethod, params: Record<string, unknown>, options: DesktopFollowerRequestOptions): Promise<unknown> {
    this.assertConnected();
    const hostId = options.hostId ?? "local";
    const entry = typeof params.conversationId === "string" ? this.followed.get(threadKey(params.conversationId, hostId)) : undefined;
    if (!entry?.snapshot || entry.ownerClientId !== options.ownerClientId) throw new DesktopIpcError("thread-not-synchronized");
    if (!Object.hasOwn(DESKTOP_IPC_VERSIONS, method) || !method.startsWith("thread-follower-")) throw new DesktopIpcError("unsupported-method");
    const version = DESKTOP_IPC_VERSIONS[method] + (hostId === "local" ? 0 : 1);
    const response = await this.sendRequest(method, params, version, options);
    return response.result;
  }

  startTurn(conversationId: string, ownerClientId: string, turnStart: Record<string, unknown>, hostId = "local"): Promise<unknown> {
    const context = isRecord(turnStart.context) ? turnStart.context : undefined;
    if (Array.isArray(context?.responseItems) && context.responseItems.length && !this.owners.get(threadKey(conversationId, hostId))?.supportsUntrustedAppInput) {
      return Promise.reject(new DesktopIpcError("unsupported-app-input"));
    }
    return this.requestFollower("thread-follower-start-turn", { conversationId, turnStart }, { ownerClientId, hostId });
  }

  steerTurn(conversationId: string, ownerClientId: string, options: DesktopSteerOptions, hostId = "local"): Promise<unknown> {
    return this.requestFollower("thread-follower-steer-turn", { ...options, conversationId }, { ownerClientId, hostId });
  }

  interruptTurn(conversationId: string, ownerClientId: string, expectedTurnId: string, hostId = "local"): Promise<unknown> {
    if (!expectedTurnId) return Promise.reject(new DesktopIpcError("expected-turn-id-required"));
    return this.requestFollower("thread-follower-interrupt-turn", { conversationId, mode: "user-stop", expectedTurnId }, { ownerClientId, hostId });
  }

  loadCompleteHistory(conversationId: string, ownerClientId: string, hostId = "local"): Promise<unknown> {
    return this.requestFollower("thread-follower-load-complete-history", { conversationId }, { ownerClientId, hostId });
  }

  async readModelSettings(conversationId: string, ownerClientId: string, hostId = "local"): Promise<{ settings: DesktopModelSettings | null }> {
    const result = await this.requestFollower("thread-follower-read-model-settings", { conversationId }, { ownerClientId, hostId });
    if (!isRecord(result) || (result.settings !== null && !isRecord(result.settings))) throw new DesktopIpcError("invalid-settings-response");
    return { settings: result.settings as DesktopModelSettings | null };
  }

  async updateThreadSettings(conversationId: string, ownerClientId: string, threadSettings: DesktopThreadSettingsPatch, options: DesktopThreadSettingsOptions = {}): Promise<{ applied: boolean }> {
    const result = await this.requestFollower("thread-follower-update-thread-settings", {
      conversationId, threadSettings, ...(options.activeTurnId ? { activeTurnId: options.activeTurnId } : {}),
      ...(options.condition ? { condition: options.condition } : {}),
    }, { ownerClientId, hostId: options.hostId });
    if (!isRecord(result) || typeof result.applied !== "boolean") throw new DesktopIpcError("invalid-settings-response");
    return { applied: result.applied };
  }

  updateDaybreak(conversationId: string, ownerClientId: string, daybreakEnabled: boolean, hostId = "local"): Promise<unknown> {
    return this.requestFollower("thread-follower-update-daybreak", { conversationId, daybreakEnabled }, { ownerClientId, hostId });
  }

  compactThread(conversationId: string, ownerClientId: string, hostId = "local"): Promise<unknown> {
    return this.requestFollower("thread-follower-compact-thread", { conversationId }, { ownerClientId, hostId });
  }

  editLastUserTurn(conversationId: string, ownerClientId: string, options: DesktopEditLastUserTurnOptions, hostId = "local"): Promise<unknown> {
    return this.requestFollower("thread-follower-edit-last-user-turn", { ...options, conversationId }, { ownerClientId, hostId });
  }

  setQueuedFollowUps(conversationId: string, ownerClientId: string, messages: DesktopQueuedFollowUp[], discardedMessageIds: string[] = [], hostId = "local"): Promise<unknown> {
    return this.requestFollower("thread-follower-set-queued-follow-ups-state", {
      conversationId, state: { [conversationId]: messages }, discardedMessageIds,
    }, { ownerClientId, hostId });
  }

  removeQueuedMessage(conversationId: string, ownerClientId: string, messageId: string, hostId = "local"): Promise<unknown> {
    return this.requestFollower("thread-follower-remove-queued-message", { conversationId, messageId }, { ownerClientId, hostId });
  }

  clearQueuedMessages(conversationId: string, ownerClientId: string, hostId = "local"): Promise<unknown> {
    return this.requestFollower("thread-follower-clear-queued-messages", { conversationId }, { ownerClientId, hostId });
  }

  replyCommandApproval(conversationId: string, ownerClientId: string, requestId: string | number, decision: unknown, hostId = "local"): Promise<unknown> {
    return this.requestFollower("thread-follower-command-approval-decision", { conversationId, requestId, decision }, { ownerClientId, hostId });
  }

  replyFileApproval(conversationId: string, ownerClientId: string, requestId: string | number, decision: unknown, hostId = "local"): Promise<unknown> {
    return this.requestFollower("thread-follower-file-approval-decision", { conversationId, requestId, decision }, { ownerClientId, hostId });
  }

  submitUserInput(conversationId: string, ownerClientId: string, requestId: string | number, response: unknown, hostId = "local"): Promise<unknown> {
    return this.requestFollower("thread-follower-submit-user-input", { conversationId, requestId, response }, { ownerClientId, hostId });
  }

  replyPermissionsApproval(conversationId: string, ownerClientId: string, requestId: string | number, response: unknown, hostId = "local"): Promise<unknown> {
    return this.requestFollower("thread-follower-permissions-request-approval-response", { conversationId, requestId, response }, { ownerClientId, hostId });
  }

  replyMcpElicitation(conversationId: string, ownerClientId: string, requestId: string | number, response: unknown, hostId = "local"): Promise<unknown> {
    return this.requestFollower("thread-follower-submit-mcp-server-elicitation-response", { conversationId, requestId, response }, { ownerClientId, hostId });
  }

  private findOwnedRequest(message: Record<string, unknown>): { entry: OwnedThread; method: "thread-owner-discovery" | DesktopFollowerMethod; params: Record<string, unknown> } | undefined {
    if (!isRecord(message.params) || typeof message.params.conversationId !== "string" || typeof message.method !== "string") return;
    if (message.targetClientId != null && message.targetClientId !== this._clientId) return;
    const method = message.method;
    const hostId = method === "thread-owner-discovery" ? message.params.hostId : message.hostId ?? "local";
    if (typeof hostId !== "string") return;
    const entry = this.owned.get(threadKey(message.params.conversationId, hostId));
    if (!entry) return;
    if (method === "thread-owner-discovery") {
      return message.version === 1 ? { entry, method, params: message.params } : undefined;
    }
    if (!entry.methods.has(method as DesktopFollowerMethod)) return;
    const expectedVersion = DESKTOP_IPC_VERSIONS[method as DesktopFollowerMethod] + (hostId === "local" ? 0 : 1);
    if (message.version !== expectedVersion) return;
    return { entry, method: method as DesktopFollowerMethod, params: message.params };
  }

  private handleOwnedRequest(message: Record<string, unknown>): void {
    const requestId = message.requestId as string;
    const match = this.findOwnedRequest(message);
    if (!match || typeof message.sourceClientId !== "string") {
      this.write({ type: "response", requestId, resultType: "error", error: "no-handler-for-request" });
      return;
    }
    const sourceClientId = message.sourceClientId;
    const key = JSON.stringify([sourceClientId, requestId]);
    let response = this.ownedRequests.get(key);
    if (!response) {
      if (this.ownedRequests.size - this.completedOwnedRequests.length >= 128) {
        this.write({ type: "response", requestId, resultType: "error", error: "too-many-pending-requests" });
        return;
      }
      const epoch = this.connectionEpoch;
      const handledByClientId = this._clientId;
      response = Promise.resolve().then(async (): Promise<Record<string, unknown>> => {
        try {
          const result = match.method === "thread-owner-discovery"
            ? { supportsUntrustedAppInput: match.entry.registration.supportsUntrustedAppInput === true }
            : await match.entry.registration.handleRequest(match.method, match.params, { sourceClientId });
          return { type: "response", requestId, resultType: "success", method: match.method, handledByClientId, result };
        } catch (error) {
          // Arbitrary execution errors can contain user text, paths, or secrets.
          const code = error instanceof DesktopIpcError && /^[a-z-]+$/.test(error.code) ? error.code : "owner-request-failed";
          return { type: "response", requestId, resultType: "error", error: code };
        } finally {
          if (this.connectionEpoch === epoch) {
            this.completedOwnedRequests.push(key);
            while (this.completedOwnedRequests.length > 128) this.ownedRequests.delete(this.completedOwnedRequests.shift()!);
          }
        }
      });
      this.ownedRequests.set(key, response);
    }
    const socket = this.socket;
    void response.then((reply) => {
      if (this.socket === socket && this.connected) this.write(reply);
    }).catch(() => {
      if (this.socket === socket) this.fail(new DesktopIpcError("response-write-failed"));
    });
  }

  private sendOwnedState(entry: OwnedThread, change: DesktopThreadSnapshot | DesktopThreadPatches, targetClientIds: string[]): void {
    if ((change.type !== "snapshot" && change.type !== "patches") || !Number.isSafeInteger(change.revision) || change.revision < 0 ||
      (change.type === "snapshot" && (!isRecord(change.conversationState) || change.conversationState.id !== entry.registration.conversationId)) ||
      (change.type === "patches" && (!Number.isSafeInteger(change.baseRevision) || !Array.isArray(change.patches)))) {
      throw new DesktopIpcError("invalid-owned-state");
    }
    if (targetClientIds.length === 0) return;
    this.write({ type: "broadcast", method: "thread-stream-state-changed", version: 11, sourceClientId: this._clientId,
      targetClientIds, params: { conversationId: entry.registration.conversationId, hostId: entry.hostId, change } });
  }

  private sendFollowing(entry: FollowedThread, following: boolean): void {
    this.write({ type: "broadcast", method: "thread-stream-following-changed", version: 1, sourceClientId: this._clientId,
      targetClientIds: [entry.ownerClientId], params: { conversationId: entry.conversationId, hostId: entry.hostId, following } });
  }

  private sendRequest(method: string, params: unknown, version: number, options?: DesktopFollowerRequestOptions): Promise<IpcResponse> {
    const requestId = randomUUID();
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const localTimeoutMs = method === "initialize" ? timeoutMs
      : ROUTER_DISCOVERY_TIMEOUT_MS + timeoutMs + RESPONSE_DELIVERY_GRACE_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new DesktopIpcError("request-timeout", `Desktop IPC ${method} timed out; delivery may have completed`));
      }, localTimeoutMs);
      this.pending.set(requestId, { method, ownerClientId: options?.ownerClientId, resolve, reject, timer });
      try {
        this.write({ type: "request", requestId, sourceClientId: this._clientId ?? "initializing-client", version, method, params,
          ...(options?.ownerClientId ? { targetClientId: options.ownerClientId } : {}),
          ...(options?.hostId && options.hostId !== "local" ? { hostId: options.hostId } : {}), timeoutMs });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  private write(message: unknown): void {
    if (!this.socket?.writable) throw new DesktopIpcError("not-connected");
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    if (payload.length > this.maxFrameBytes || this.socket.writableLength + payload.length > this.maxFrameBytes * 2) {
      throw new DesktopIpcError("frame-too-large");
    }
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    this.socket.write(frame);
  }

  private receive(chunk: Buffer): void {
    try {
      let offset = 0;
      while (offset < chunk.length && this.socket) {
        if (!this.body) {
          const length = Math.min(4 - this.headerBytes, chunk.length - offset);
          chunk.copy(this.header, this.headerBytes, offset, offset + length);
          this.headerBytes += length;
          offset += length;
          if (this.headerBytes < 4) continue;
          const frameBytes = this.header.readUInt32LE(0);
          this.headerBytes = 0;
          if (frameBytes === 0 || frameBytes > this.maxFrameBytes) throw new DesktopIpcError("invalid-frame-length");
          this.body = Buffer.allocUnsafe(frameBytes);
        }
        const length = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
        chunk.copy(this.body, this.bodyBytes, offset, offset + length);
        this.bodyBytes += length;
        offset += length;
        if (this.bodyBytes !== this.body.length) continue;
        const payload = this.body;
        this.body = null;
        this.bodyBytes = 0;
        let message: unknown;
        try { message = JSON.parse(payload.toString("utf8")); }
        catch { throw new DesktopIpcError("invalid-frame-json"); }
        this.handleMessage(message);
      }
    } catch (error) {
      this.fail(error instanceof DesktopIpcError ? error : new DesktopIpcError("invalid-message"));
    }
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message) || typeof message.type !== "string") throw new DesktopIpcError("invalid-message");
    if (message.type === "response" && typeof message.requestId === "string") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.resultType === "error") {
        const code = typeof message.error === "string" && /^[a-z-]+$/.test(message.error) ? message.error : "owner-request-failed";
        pending.reject(new DesktopIpcError(code));
      } else if (message.resultType !== "success" || message.method !== pending.method ||
        (pending.ownerClientId && message.handledByClientId !== pending.ownerClientId)) {
        pending.reject(new DesktopIpcError("response-routing-mismatch"));
      } else pending.resolve(message as unknown as IpcResponse);
      return;
    }
    if (message.type === "client-discovery-request" && typeof message.requestId === "string") {
      const canHandle = this.connected && isRecord(message.request) && this.findOwnedRequest(message.request) != null;
      this.write({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle } });
      return;
    }
    if (message.type === "request" && typeof message.requestId === "string") {
      this.handleOwnedRequest(message);
      return;
    }
    if (message.type !== "broadcast" || typeof message.sourceClientId !== "string" || !isRecord(message.params)) return;
    if (Array.isArray(message.targetClientIds) && !message.targetClientIds.includes(this._clientId)) return;
    const params = message.params;
    if (message.method === "client-status-changed" && (message.version ?? 0) === 0 && params.status === "disconnected" && typeof params.clientId === "string") {
      const ownerClientId = params.clientId;
      for (const entry of this.followed.values()) {
        if (entry.ownerClientId === ownerClientId) this.unfollowThread(entry.conversationId, entry.hostId, new DesktopIpcError("owner-disconnected"));
      }
      for (const [key, owner] of this.owners) if (owner.ownerClientId === ownerClientId) this.owners.delete(key);
      for (const entry of this.owned.values()) {
        if (entry.followers.delete(ownerClientId)) this.emit("followersChanged", { conversationId: entry.registration.conversationId, hostId: entry.hostId, followerCount: entry.followers.size });
      }
      this.emit("ownerDisconnected", ownerClientId);
      return;
    }
    if (typeof params.conversationId !== "string" || typeof params.hostId !== "string") return;
    if (message.method === "thread-archived" || message.method === "thread-unarchived") {
      if (params.hostId !== "local" || !params.conversationId || !message.sourceClientId
        || !this.previouslyFollowed.has(threadKey(params.conversationId, params.hostId))) return;
      const event: DesktopThreadAvailabilityEvent = {
        conversationId: params.conversationId, hostId: "local", sourceClientId: message.sourceClientId,
      };
      if (message.method === "thread-archived") {
        if (message.version !== DESKTOP_IPC_VERSIONS["thread-archived"] || typeof params.cwd !== "string" || !params.cwd) return;
        this.emit("threadArchived", { ...event, cwd: params.cwd });
      } else if (message.version === DESKTOP_IPC_VERSIONS["thread-unarchived"]) this.emit("threadUnarchived", event);
      return;
    }
    const owned = this.owned.get(threadKey(params.conversationId, params.hostId));
    if (owned && message.method === "thread-stream-following-changed") {
      if (message.version !== 1 || typeof params.following !== "boolean") return;
      const sourceClientId = message.sourceClientId;
      if (params.following) {
        owned.followers.add(sourceClientId);
        this.sendOwnedState(owned, owned.registration.getSnapshot(), [sourceClientId]);
      } else owned.followers.delete(sourceClientId);
      this.emit("followersChanged", { conversationId: params.conversationId, hostId: params.hostId, followerCount: owned.followers.size });
      return;
    }
    const entry = this.followed.get(threadKey(params.conversationId, params.hostId));
    if (!entry || entry.ownerClientId !== message.sourceClientId) return;
    if (message.method === "thread-stream-following-status-requested") {
      if (message.version !== 1) throw new DesktopIpcError("notification-version-mismatch");
      this.sendFollowing(entry, true);
      return;
    }
    if (message.method !== "thread-stream-state-changed") return;
    if (message.version !== DESKTOP_IPC_VERSIONS["thread-stream-state-changed"]) throw new DesktopIpcError("notification-version-mismatch");
    const change = params.change;
    if (!isRecord(change) || !Number.isSafeInteger(change.revision) || (change.revision as number) < 0) throw new DesktopIpcError("invalid-stream-change");
    if (change.type === "snapshot" && isRecord(change.conversationState)) {
      entry.snapshot = change as unknown as DesktopThreadSnapshot;
      clearTimeout(entry.timer);
      entry.resolve(entry.snapshot);
    } else if (change.type !== "patches" || !Number.isSafeInteger(change.baseRevision) || !Array.isArray(change.patches)) {
      throw new DesktopIpcError("invalid-stream-change");
    }
    this.emit("stream", { conversationId: entry.conversationId, hostId: entry.hostId, ownerClientId: entry.ownerClientId,
      change: change as unknown as DesktopThreadStream["change"] } satisfies DesktopThreadStream);
  }

  private assertConnected(): void { if (!this.connected) throw new DesktopIpcError("not-connected"); }
  private fail(error: Error): void {
    this.detach(error);
    if (this.listenerCount("error")) this.emit("error", error);
  }
  private detach(error: Error): void {
    this.connectionEpoch += 1;
    const socket = this.socket;
    const wasAttached = socket !== null;
    this.socket = null;
    this._clientId = null;
    socket?.destroy();
    this.headerBytes = 0;
    this.body = null;
    this.bodyBytes = 0;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const entry of this.followed.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.followed.clear();
    this.owners.clear();
    this.owned.clear();
    this.ownedRequests.clear();
    this.completedOwnedRequests = [];
    if (wasAttached) this.emit("close");
  }
}

function threadKey(conversationId: string, hostId: string): string { return JSON.stringify([hostId, conversationId]); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
