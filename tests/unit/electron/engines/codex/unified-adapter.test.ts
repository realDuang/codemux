import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAdapter } from "../../../../../electron/main/engines/codex";
import { UnifiedCodexAdapter, type UnifiedCodexAdapterOptions } from "../../../../../electron/main/engines/codex/unified-adapter";
import type { CodexDesktopCatalog } from "../../../../../electron/main/engines/codex/desktop-catalog";
import type { CodexRuntimeIdentity } from "../../../../../electron/main/engines/codex/runtime-selection";
import type { CodexDesktopOwnerRuntime, NativeOwnedThreadState } from "../../../../../electron/main/engines/codex/desktop-owner";
import type { CodexDesktopIpcClient, DesktopOwnedThreadRegistration, DesktopThreadSnapshot } from "../../../../../electron/main/engines/codex/desktop-ipc-client";
import type { EngineCatalogSnapshot, MessagePromptContent, UnifiedPermission, UnifiedQuestion, UnifiedSession } from "../../../../../src/types/unified";

vi.mock("../../../../../electron/main/services/logger", () => ({ codexLog: { info() {}, warn() {}, error() {}, debug() {} } }));

interface TestOwner { clientId: string; registration: DesktopOwnedThreadRegistration; followers: Set<TestClient> }
class TestClient extends EventEmitter {
  connected = false;
  unavailable = false;
  private followed = new Map<string, string>();
  constructor(readonly clientId: string, readonly owners: Map<string, TestOwner>) { super(); }
  connect = vi.fn(async () => { if (this.unavailable) throw new Error("router unavailable"); this.connected = true; });
  close = vi.fn(() => {
    this.connected = false;
    for (const [id, owner] of this.owners) if (owner.clientId === this.clientId) this.owners.delete(id);
    this.emit("close");
  });
  discoverOwner = vi.fn(async (id: string) => {
    const owner = this.owners.get(id);
    return owner ? { ownerClientId: owner.clientId, supportsUntrustedAppInput: false } : null;
  });
  getThreadOwner = (id: string) => {
    const owner = this.owners.get(id);
    return this.connected && owner ? { ownerClientId: owner.clientId, supportsUntrustedAppInput: false,
      ...(owner.registration.clientName ? { clientName: owner.registration.clientName } : {}),
    } : undefined;
  };
  registerOwnedThread = vi.fn((registration: DesktopOwnedThreadRegistration) => {
    const owner = { clientId: this.clientId, registration, followers: new Set<TestClient>() };
    this.owners.set(registration.conversationId, owner);
    return () => { if (this.owners.get(registration.conversationId) === owner) this.owners.delete(registration.conversationId); };
  });
  publishOwnedThreadState = vi.fn((id: string, change: DesktopThreadSnapshot) => {
    const owner = this.owners.get(id);
    if (!this.connected || owner?.clientId !== this.clientId) throw new Error("thread-not-owned");
    for (const follower of owner.followers) follower.emit("stream", { conversationId: id, hostId: "local", ownerClientId: this.clientId, change });
  });
  publishOwnedQueuedFollowUps = vi.fn((id: string) => {
    if (!this.connected || this.owners.get(id)?.clientId !== this.clientId) throw new Error("thread-not-owned");
  });
  notifyThreadUnarchived = vi.fn();
  notifyThreadArchived = vi.fn();
  notifyThreadMetadataAvailable = vi.fn();
  followThread = vi.fn(async (id: string, ownerId: string) => {
    const owner = this.owners.get(id);
    if (!owner || owner.clientId !== ownerId) throw new Error("owner absent");
    this.followed.set(id, ownerId);
    owner.followers.add(this);
    return owner.registration.getSnapshot();
  });
  unfollowThread = vi.fn((id: string) => { this.followed.delete(id); });
  isFollowingThread = vi.fn((id: string, ownerId: string) => this.connected && this.followed.get(id) === ownerId);
  loadCompleteHistory = vi.fn(async (id: string, ownerId: string) => {
    const owner = this.owners.get(id);
    if (!owner || owner.clientId !== ownerId) throw new Error("owner absent");
    this.emit("stream", { conversationId: id, hostId: "local", ownerClientId: ownerId, change: owner.registration.getSnapshot() });
    return { revision: 1 };
  });
  startTurn = vi.fn(async (id: string, _ownerId: string, input: unknown) => ({ threadId: id, input }));
}

class TestExecution extends EventEmitter {
  readonly states = new Map<string, NativeOwnedThreadState>();
  readonly permissions: UnifiedPermission[] = [];
  readonly questions: UnifiedQuestion[] = [];
  readonly watchers = new Set<(id: string) => void>();
  readonly native: CodexDesktopOwnerRuntime = {
    readThread: vi.fn(async (id) => {
      const state = this.states.get(id);
      if (!state) throw new Error("not loaded");
      return structuredClone(state);
    }),
    readMetadata: vi.fn(async (id) => ({ ...this.states.get(id)!.thread, canAcceptDirectInput: true })),
    request: vi.fn(async () => ({})), respond: vi.fn(async () => {}),
    subscribe: (listener) => { this.watchers.add(listener); return () => { this.watchers.delete(listener); }; },
    updateSettings: vi.fn(async (id, patch) => {
      const state = this.states.get(id)!;
      if (typeof patch.model === "string") state.model = patch.model;
      if (patch.collaborationMode) state.collaborationMode = patch.collaborationMode as Record<string, unknown>;
      if (patch.effort === null || typeof patch.effort === "string") state.reasoningEffort = patch.effort;
      if (patch.serviceTier === null || typeof patch.serviceTier === "string") state.serviceTier = patch.serviceTier;
      for (const key of ["approvalPolicy", "approvalsReviewer"] as const) if (patch[key] !== undefined) state[key] = patch[key];
      if (patch.sandboxPolicy !== undefined) { state.sandboxPolicy = patch.sandboxPolicy; delete state.permissions; }
      return true;
    }),
  };
  createDesktopOwnerRuntime = () => this.native;
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  healthCheck = vi.fn(async () => true);
  getStatus = () => "running" as const;
  getInfo = () => ({ type: "codex" as const, name: "Codex", status: "running" as const, capabilities: this.getCapabilities() });
  getCapabilities = () => ({ loadSession: true, listSessions: true });
  getAuthMethods = () => [];
  hasSession = (id: string) => this.states.has(id);
  createSession = vi.fn(async (directory: string, meta?: Record<string, unknown>): Promise<UnifiedSession> => {
    const threadId = String(meta?.codexThreadId ?? `thread-${this.states.size + 1}`);
    const id = `codex_${threadId}`;
    this.states.set(id, { thread: { id: threadId, cwd: directory, name: "Test conversation", createdAt: 1, updatedAt: 2, turns: [] }, model: "test-model", collaborationMode: { mode: "default", settings: { model: "test-model", reasoning_effort: null } } });
    return { id, engineType: "codex", directory, title: "Test conversation", time: { created: 1000, updated: 2000 }, engineMeta: { codexThreadId: threadId } };
  });
  sendMessage = vi.fn(async (id: string, content: MessagePromptContent[]) => {
    const state = this.states.get(id)!;
    const turns = state.thread.turns as Array<Record<string, unknown>>;
    const turnId = `turn-${turns.length + 1}`;
    turns.push({ id: turnId, status: "completed", startedAt: 3, completedAt: 4, items: [
      { id: `${turnId}-user`, type: "userMessage", content },
      { id: `${turnId}-final`, type: "agentMessage", text: "Full answer", phase: "final_answer" },
    ] });
    for (const watcher of this.watchers) watcher(id);
    return { id: "ordinary-transient-message", sessionId: id, role: "assistant" as const, time: { created: 3000, completed: 4000 }, parts: [], engineMeta: { codexTurnId: turnId } };
  });
  cancelMessage = vi.fn(async (_id: string) => {});
  deleteSession = vi.fn(async (id: string) => { this.states.delete(id); });
  getPendingPermissions = (id?: string) => this.permissions.filter((request) => !id || request.sessionId === id);
  getPendingQuestions = (id?: string) => this.questions.filter((request) => !id || request.sessionId === id);
  replyPermission = vi.fn(async (_id: string, _reply: unknown, _sessionId?: string) => {});
  replyQuestion = vi.fn(async (_id: string, _answers: string[][], _sessionId?: string) => {});
  rejectQuestion = vi.fn(async (_id: string, _sessionId?: string) => {});
  listModels = vi.fn(async () => ({ models: [], currentModelId: "test-model" }));
  listCommands = vi.fn(async () => []);
  invokeCommand = vi.fn(async (id: string, name: string, args: string, _options?: unknown) => ({ handledAsCommand: true,
    message: await this.sendMessage(id, [{ type: "text", text: `/${name} ${args}` }]),
  }));
  setModel = vi.fn(async () => {});
  setMode = vi.fn(async () => {});
  setReasoningEffort = vi.fn(async () => {});
  setServiceTier = vi.fn(async () => {});
  getReasoningEffort = () => null;
  getServiceTier = () => null;
  listHistoricalSessions = vi.fn(async () => []);
}

const adapters: UnifiedCodexAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map((adapter) => adapter.stop())); });

function fixture(sharingEnabled = false, options: Partial<UnifiedCodexAdapterOptions> = {}) {
  const owners = new Map<string, TestOwner>();
  const follower = new TestClient("follower", owners);
  const ownerClients: TestClient[] = [];
  const executions: TestExecution[] = [];
  const resolve = vi.fn(async (_id?: string): Promise<CodexRuntimeIdentity> => ({ cliPath: "/test/codex", version: "0.162.0", source: "configured" }));
  const readStoredThread = vi.fn(async (id: string) => ({ thread: { id, cwd: "/repo", name: "Stored thread", createdAt: 1, updatedAt: 2, turns: [] }, archived: false }));
  const adapter = new UnifiedCodexAdapter({
    sharingEnabled, runtimeResolver: { resolve },
    followerClient: follower as unknown as CodexDesktopIpcClient,
    createOwnerClient: () => { const client = new TestClient(`owner-${ownerClients.length}`, owners); ownerClients.push(client); return client as unknown as CodexDesktopIpcClient; },
    createRuntime: () => { const execution = new TestExecution(); executions.push(execution); return execution as unknown as CodexAdapter; },
    readStoredThread, refreshDelayMs: 0, reconnectDelayMs: 60_000,
    ...options,
  });
  adapters.push(adapter);
  return { adapter, owners, follower, ownerClients, executions, resolve, readStoredThread };
}

describe("UnifiedCodexAdapter", () => {
  it("keeps fresh sharing-disabled catalogs empty while retaining persisted native identities", async () => {
    const known: string[] = [];
    const snapshot: EngineCatalogSnapshot = {
      sourceId: "test-catalog", revision: "native-revision", complete: true,
      projects: [
        { id: "known-project", name: "Known", directory: "/known" },
        { id: "foreign-project", name: "Foreign", directory: "/foreign" },
      ],
      sessions: ["known", "foreign"].map((id) => ({ id, engineType: "codex", directory: `/${id}`, projectId: `${id}-project`, archived: false, activityStatus: "idle", time: { created: 1, updated: 2 } })),
    };
    const catalog = {
      subscribe: () => () => {}, start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
      getSnapshot: () => snapshot, refresh: vi.fn(async () => snapshot),
    };
    const f = fixture(false, { catalogSourceId: snapshot.sourceId, knownThreadIds: () => known, catalogFactory: () => catalog as unknown as CodexDesktopCatalog });
    const initial = await f.adapter.getCatalog();
    expect(initial).toMatchObject({ complete: true, sessions: [], projects: [] });
    known.push("codex_known");
    const existing = await f.adapter.getCatalog();
    expect(existing.sessions.map((session) => session.id)).toEqual(["known"]);
    expect(existing.sessions[0]).toMatchObject({ activityStatus: "idle", connection: { available: false } });
    expect(existing.projects.map((project) => project.id)).toEqual(["known-project"]);
    expect(existing.revision).not.toBe(initial.revision);
    const updates = vi.fn();
    f.adapter.on("catalog.updated", updates);
    await f.adapter.setSessionSharing(true);
    expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: expect.arrayContaining([expect.objectContaining({ id: "foreign" })]) }));
    const enabled = await f.adapter.getCatalog();
    expect(enabled.sessions).toHaveLength(2);
    known.push("foreign");
    await f.adapter.setSessionSharing(false);
    const disabled = updates.mock.lastCall![0] as EngineCatalogSnapshot;
    expect(disabled.sessions).toHaveLength(2);
    expect(disabled.projects).toHaveLength(2);
    expect(disabled.revision).not.toBe(enabled.revision);
    expect(f.executions).toHaveLength(0);
  });

  it("keeps native session and message identities across sharing toggles without replacing the writer", async () => {
    const f = fixture();
    const session = await f.adapter.createSession("/repo");
    expect(session.id).toBe("thread-1");
    expect(session.connection).toMatchObject({ origin: "CodeMux", executor: "CodeMux", shared: false, available: true });
    const messages = vi.fn();
    const consumed = vi.fn();
    f.adapter.on("message.updated", messages);
    f.adapter.on("message.queued.consumed", consumed);
    const reply = await f.adapter.sendMessage("codex_thread-1", [{ type: "text", text: "Hello" }], { clientMessageId: "local-preview" });
    expect(f.executions[0].sendMessage).toHaveBeenCalledWith("codex_thread-1", expect.any(Array), expect.objectContaining({ clientMessageId: "local-preview" }));
    f.executions[0].emit("message.queued.consumed", { sessionId: "codex_thread-1", messageId: "local-native-message", clientMessageId: "local-preview" });
    expect(consumed).toHaveBeenCalledExactlyOnceWith({ sessionId: "thread-1", messageId: "local-native-message", clientMessageId: "local-preview" });
    expect(reply.id).toContain("codex-desktop:v1:local:thread-1:turn-1:item:turn-1-final");
    const before = await f.adapter.listMessages(session.id);
    expect(before).toHaveLength(2);
    await f.adapter.setSessionSharing(true);
    expect(f.adapter.getSessionSharing()).toMatchObject({ enabled: true, status: "connected" });
    expect((await f.adapter.getSession(session.id))!.connection?.shared).toBe(true);
    expect(await f.adapter.listMessages(session.id)).toEqual(before);
    await f.adapter.setSessionSharing(false);
    expect(f.executions).toHaveLength(1);
    expect(f.executions[0].createSession).toHaveBeenCalledTimes(1);
    expect(f.executions[0].stop).not.toHaveBeenCalled();
    expect(await f.adapter.listMessages(session.id)).toEqual(before);
    expect(messages).toHaveBeenCalledTimes(2);
    await f.adapter.sendMessage(session.id, [{ type: "text", text: "Continue independently" }]);
    expect(await f.adapter.listMessages(session.id)).toHaveLength(4);
    await f.adapter.setSessionSharing(true);
    expect(f.owners.has(session.id)).toBe(true);
    expect(f.executions[0].createSession).toHaveBeenCalledTimes(1);
  });

  it("keeps independent execution available when the sharing router is unavailable", async () => {
    const f = fixture(true);
    f.follower.unavailable = true;
    const session = await f.adapter.createSession("/repo");
    expect(f.adapter.getStatus()).toBe("running");
    expect(f.adapter.getSessionSharing()).toMatchObject({ enabled: true, status: "unavailable" });
    await expect(f.adapter.sendMessage(session.id, [{ type: "text", text: "Local" }])).resolves.toMatchObject({ role: "assistant" });
    await f.adapter.restoreSession("external", "/repo", { codexThreadId: "external" });
    await expect(f.adapter.sendMessage("external", [{ type: "text", text: "Remote" }])).rejects.toThrow("router unavailable");
    expect(f.executions[0].createSession).toHaveBeenCalledTimes(1);
  });

  it("keeps permission and question routes attached to the same runtime while sharing is disabled", async () => {
    const f = fixture(true);
    const session = await f.adapter.createSession("/repo");
    const execution = f.executions[0];
    execution.permissions.push({ id: "7", sessionId: "codex_thread-1", engineType: "codex", title: "Permission", kind: "other", options: [{ id: "allow_once", label: "Allow", type: "allow_once" }] });
    execution.questions.push({ id: "7", sessionId: "codex_thread-1", engineType: "codex", questions: [{ header: "Choice", question: "Pick one", options: [{ label: "A", description: "A" }] }] });
    const [permission] = await f.adapter.getPendingPermissions(session.id);
    const [question] = await f.adapter.getPendingQuestions(session.id);
    expect(permission.id).not.toBe(question.id);
    await f.adapter.setSessionSharing(false);
    await expect(f.adapter.replyPermission(permission.id, { optionId: "allow_once" }, "another-thread")).rejects.toThrow("another conversation");
    await f.adapter.replyPermission(permission.id, { optionId: "allow_once" }, session.id);
    await f.adapter.replyQuestion(question.id, [["A"]], session.id);
    expect(execution.replyPermission).toHaveBeenCalledExactlyOnceWith("7", { optionId: "allow_once" }, "codex_thread-1");
    expect(execution.replyQuestion).toHaveBeenCalledExactlyOnceWith("7", [["A"]], "codex_thread-1");
    expect(execution.stop).not.toHaveBeenCalled();
  });

  it("retains accepted Desktop follow-up input when sharing is disabled during the current turn", async () => {
    const f = fixture(true);
    const session = await f.adapter.createSession("/repo");
    const execution = f.executions[0];
    const turns = execution.states.get("codex_thread-1")!.thread.turns as Array<Record<string, unknown>>;
    turns.push({ id: "active-turn", status: "inProgress", items: [] });
    const registration = f.owners.get(session.id)!.registration;
    const queued = { id: "queued-desktop-input", text: "Continue after the active turn", context: {}, cwd: "/repo", createdAt: 2, submission: { hostId: "local", status: "pending" } };
    await registration.handleRequest("thread-follower-set-queued-follow-ups-state", {
      conversationId: session.id, state: { [session.id]: [queued] }, discardedMessageIds: [],
    }, { sourceClientId: "official-desktop" });
    await vi.waitFor(() => expect(registration.getQueuedFollowUps?.()).toEqual([queued]));
    expect(execution.native.request).not.toHaveBeenCalled();
    await f.adapter.setSessionSharing(false);
    f.ownerClients[0].publishOwnedQueuedFollowUps.mockClear();
    turns[0].status = "completed";
    for (const watcher of execution.watchers) watcher("codex_thread-1");
    await vi.waitFor(() => expect(execution.native.request).toHaveBeenCalledExactlyOnceWith("codex_thread-1", "turn/start", expect.objectContaining({
      threadId: session.id, clientUserMessageId: queued.id, input: [{ type: "text", text: queued.text }],
    })));
    expect(registration.getQueuedFollowUps?.()).toEqual([]);
    expect(f.ownerClients[0].publishOwnedQueuedFollowUps).not.toHaveBeenCalled();
    expect(execution.stop).not.toHaveBeenCalled();
    await f.adapter.setSessionSharing(true);
    expect(f.owners.get(session.id)!.registration.getQueuedFollowUps?.()).toEqual([]);
    expect(execution.native.request).toHaveBeenCalledTimes(1);
  });

  it("retains updates while a reconnected owner is still awaiting thread registration", async () => {
    const errors = vi.fn();
    const f = fixture(true, { onError: errors });
    const session = await f.adapter.createSession("/repo");
    await f.adapter.setSessionSharing(false);
    const owner = f.ownerClients[0];
    let discovered!: () => void;
    let release!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => { discovered = resolve; });
    const discoveryReleased = new Promise<void>((resolve) => { release = resolve; });
    owner.discoverOwner.mockImplementationOnce(async () => {
      discovered();
      await discoveryReleased;
      return null;
    });
    const reconnecting = f.adapter.setSessionSharing(true);
    await discoveryStarted;
    expect(owner.connected).toBe(true);
    expect(f.owners.has(session.id)).toBe(false);
    await f.adapter.sendMessage(session.id, [{ type: "text", text: "Changed during reconnection" }]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    release();
    await reconnecting;
    expect(errors).not.toHaveBeenCalled();
    expect(JSON.stringify(f.owners.get(session.id)!.registration.getSnapshot())).toContain("Full answer");
    const published = owner.publishOwnedThreadState.mock.calls.length;
    await f.adapter.sendMessage(session.id, [{ type: "text", text: "Normal publishing resumed" }]);
    await vi.waitFor(() => expect(owner.publishOwnedThreadState.mock.calls.length).toBeGreaterThan(published));
    expect(errors).not.toHaveBeenCalled();
    expect(f.executions[0].createSession).toHaveBeenCalledTimes(1);
  });

  it("reads restoration without starting a writer and resolves the original runtime only for explicit input", async () => {
    const f = fixture();
    const session = await f.adapter.restoreSession("codex_legacy", "/repo", { codexThreadId: "legacy", codexDesktopOwner: "codemux" });
    expect(session.id).toBe("legacy");
    expect(session).toMatchObject({ activityStatus: "idle", connection: { available: false } });
    expect(f.executions).toHaveLength(0);
    f.resolve.mockImplementation(async (id) => ({ cliPath: id ? "/test/older-codex" : "/test/codex", version: id ? "0.154.0" : "0.162.0", source: "configured" }));
    await f.adapter.sendMessage(session.id, [{ type: "text", text: "Continue original" }]);
    expect(f.resolve).toHaveBeenCalledWith("legacy", expect.objectContaining({ id: "legacy" }));
    expect(f.executions[0].createSession).toHaveBeenCalledWith("/repo", expect.objectContaining({ codexThreadId: "legacy", codexDesktopOwner: "codemux" }));
    expect((await f.adapter.getSession(session.id))!.connection?.runtimeVersion).toBe("0.154.0");
  });

  it("distinguishes a healthy sharing channel from idle history without an attached executor", async () => {
    const f = fixture(true);
    await f.adapter.start();
    const session = await f.adapter.restoreSession("idle-history", "/repo", { codexThreadId: "idle-history" });

    expect(f.adapter.getSessionSharing().status).toBe("connected");
    expect(session.connection).toMatchObject({ shared: true, available: false, sharingStatus: "connected" });
    expect(session.connection?.executor).toBeUndefined();
    expect(f.executions[0].createSession).not.toHaveBeenCalled();
    const updates = vi.fn();
    f.adapter.on("session.updated", updates);
    await f.adapter.setSessionSharing(false);
    expect(updates).toHaveBeenLastCalledWith({ session: expect.objectContaining({ connection: expect.objectContaining({
      available: false, sharingStatus: "disabled",
    }) }) });
    await f.adapter.setSessionSharing(true);
    expect(updates).toHaveBeenLastCalledWith({ session: expect.objectContaining({ connection: expect.objectContaining({
      available: false, sharingStatus: "connected",
    }) }) });
  });

  it("reports sharing loss separately while a local executor remains available", async () => {
    const f = fixture(true);
    const session = await f.adapter.createSession("/repo");
    f.follower.close();

    expect(f.adapter.getSessionSharing().status).toBe("unavailable");
    expect((await f.adapter.getSession(session.id))?.connection).toMatchObject({
      executor: "CodeMux", available: true, shared: false, sharingStatus: "unavailable",
    });
    expect(f.executions[0].hasSession(`codex_${session.id}`)).toBe(true);
  });

  it("performs one no-owner lookup before acquisition while retaining final owner registration checks", async () => {
    const f = fixture(true);
    await f.adapter.restoreSession("legacy", "/repo", { codexThreadId: "legacy", codexDesktopOwner: "codemux" });
    f.follower.discoverOwner.mockClear();
    await f.adapter.sendMessage("legacy", [{ type: "text", text: "Continue" }]);
    expect(f.follower.discoverOwner).toHaveBeenCalledExactlyOnceWith("legacy");
    expect(f.ownerClients[0].discoverOwner).toHaveBeenCalledExactlyOnceWith("legacy", undefined);
    expect(f.executions[0].native.readMetadata).toHaveBeenCalledWith("codex_legacy");
    expect(f.executions[0].createSession).toHaveBeenCalledExactlyOnceWith("/repo", expect.objectContaining({ codexThreadId: "legacy", codexDesktopOwner: "codemux" }));
  });

  it("makes concurrent input await the same acquisition through completed exposure", async () => {
    const f = fixture(true);
    await f.adapter.start();
    await f.adapter.restoreSession("legacy", "/repo", { codexThreadId: "legacy", codexDesktopOwner: "codemux" });
    let registering!: () => void;
    let release!: () => void;
    const registrationStarted = new Promise<void>((resolve) => { registering = resolve; });
    const registrationReleased = new Promise<void>((resolve) => { release = resolve; });
    f.ownerClients[0].discoverOwner.mockImplementationOnce(async () => {
      registering();
      await registrationReleased;
      return null;
    });
    const first = f.adapter.sendMessage("legacy", [{ type: "text", text: "First" }]);
    await registrationStarted;
    expect(f.adapter.hasSession("legacy")).toBe(true);
    const second = f.adapter.sendMessage("codex_legacy", [{ type: "text", text: "Second" }]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const earlySends = f.executions[0].sendMessage.mock.calls.length;
    release();
    await Promise.all([first, second]);
    expect(earlySends).toBe(0);
    expect(f.executions[0].createSession).toHaveBeenCalledTimes(1);
    expect(f.executions[0].sendMessage.mock.calls.map(([, content]) => content[0].text)).toEqual(["First", "Second"]);
    expect(f.owners.has("legacy")).toBe(true);
  });

  it("revalidates a retry after native ownership verification rejects an acquired writer", async () => {
    const archiveStoredThread = vi.fn(async (id: string) => ({ id }));
    const f = fixture(true, { archiveStoredThread });
    await f.adapter.start();
    await f.adapter.restoreSession("legacy", "/repo", { codexThreadId: "legacy", codexDesktopOwner: "codemux" });
    const execution = f.executions[0];
    let allowInput = false;
    vi.mocked(execution.native.readMetadata!).mockImplementation(async (id) => ({ ...execution.states.get(id)!.thread, canAcceptDirectInput: allowInput }));
    await expect(f.adapter.sendMessage("legacy", [{ type: "text", text: "First attempt" }])).rejects.toThrow("exclusive input ownership");
    await expect(f.adapter.sendMessage("legacy", [{ type: "text", text: "Retry remains blocked" }])).rejects.toThrow("exclusive input ownership");
    expect(execution.sendMessage).not.toHaveBeenCalled();
    expect(f.adapter.hasSession("legacy")).toBe(false);
    expect(execution.deleteSession).toHaveBeenCalledTimes(2);
    expect(archiveStoredThread).not.toHaveBeenCalled();
    allowInput = true;
    await expect(f.adapter.sendMessage("legacy", [{ type: "text", text: "Verified retry" }])).resolves.toMatchObject({ role: "assistant", sessionId: "legacy" });
    expect(execution.createSession).toHaveBeenCalledTimes(3);
    expect(execution.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("detaches failed acquisition and follows a foreign owner discovered during final registration on retry", async () => {
    const archiveStoredThread = vi.fn(async (id: string) => ({ id }));
    const f = fixture(true, { archiveStoredThread });
    await f.adapter.start();
    await f.adapter.restoreSession("legacy", "/repo", { codexThreadId: "legacy", codexDesktopOwner: "codemux" });
    const state = { id: "legacy", hostId: "local", cwd: "/repo", title: "Original thread", createdAt: 1000, updatedAt: 2000,
      resumeState: "resumed", turns: [] as Array<Record<string, unknown>>, requests: [],
    };
    let revision = 1;
    f.ownerClients[0].discoverOwner.mockImplementationOnce(async () => {
      f.owners.set("legacy", { clientId: "foreign-owner", followers: new Set(), registration: {
        conversationId: "legacy", supportedMethods: [], getSnapshot: () => ({ type: "snapshot", revision, conversationState: state }), handleRequest: async () => ({}),
      } });
      return { ownerClientId: "foreign-owner", supportsUntrustedAppInput: false };
    });
    await expect(f.adapter.sendMessage("legacy", [{ type: "text", text: "First attempt" }])).rejects.toThrow("owned by another Codex client");
    f.follower.startTurn.mockImplementation(async () => {
      state.turns.push({ turnId: "remote-retry", status: "completed", turnStartedAtMs: 3000, durationMs: 1000,
        params: { input: [{ type: "text", text: "Remote retry" }] },
        items: [{ id: "user", type: "userMessage", content: [{ type: "text", text: "Remote retry" }] },
          { id: "answer", type: "agentMessage", text: "Original owner's reply", phase: "final_answer" }],
      });
      revision += 1;
      f.follower.emit("stream", { conversationId: "legacy", hostId: "local", ownerClientId: "foreign-owner", change: { type: "snapshot", revision, conversationState: state } });
      return { threadId: "legacy", input: {}, turnId: "remote-retry" };
    });
    const reply = await f.adapter.sendMessage("legacy", [{ type: "text", text: "Remote retry" }]);
    expect(reply.id).toContain(":legacy:remote-retry:");
    expect(f.executions[0].createSession).toHaveBeenCalledTimes(1);
    expect(f.executions[0].sendMessage).not.toHaveBeenCalled();
    expect(f.executions[0].deleteSession).toHaveBeenCalledExactlyOnceWith("codex_legacy");
    expect(archiveStoredThread).not.toHaveBeenCalled();
    expect(f.owners.get("legacy")?.clientId).toBe("foreign-owner");
  });

  it("preserves the original identity when its runtime is incompatible", async () => {
    const f = fixture();
    await f.adapter.restoreSession("legacy", "/repo", { codexThreadId: "legacy", codexDesktopOwner: "codemux" });
    f.resolve.mockRejectedValue(new Error("Matching Codex 0.154.0 runtime is unavailable"));
    await expect(f.adapter.sendMessage("legacy", [{ type: "text", text: "Continue" }])).rejects.toThrow("0.154.0");
    expect(f.executions).toHaveLength(0);
    expect((await f.adapter.listSessions())[0].id).toBe("legacy");
  });

  it("separates binary versions installed at the same path", async () => {
    const f = fixture();
    await f.adapter.createSession("/repo");
    await f.adapter.restoreSession("legacy", "/repo", { codexThreadId: "legacy", codexDesktopOwner: "codemux" });
    f.resolve.mockResolvedValue({ cliPath: "/test/codex", version: "0.154.0", source: "configured" });
    await f.adapter.sendMessage("legacy", [{ type: "text", text: "Continue" }]);
    expect(f.executions).toHaveLength(2);
    expect(f.executions[0].createSession).toHaveBeenCalledTimes(1);
    expect(f.executions[1].createSession).toHaveBeenCalledWith("/repo", expect.objectContaining({ codexThreadId: "legacy" }));
    for (const [index, id] of ["codex_thread-1", "codex_legacy"].entries()) f.executions[index].permissions.push({
      id: "0", sessionId: id, engineType: "codex", title: "Approve", kind: "other", options: [{ id: "allow_once", label: "Allow", type: "allow_once" }],
    });
    const permissions = await f.adapter.getPendingPermissions();
    expect(new Set(permissions.map((permission) => permission.id)).size).toBe(2);
    for (const permission of permissions) await f.adapter.replyPermission(permission.id, { optionId: "allow_once" }, permission.sessionId);
    expect(f.executions[0].replyPermission).toHaveBeenCalledExactlyOnceWith("0", { optionId: "allow_once" }, "codex_thread-1");
    expect(f.executions[1].replyPermission).toHaveBeenCalledExactlyOnceWith("0", { optionId: "allow_once" }, "codex_legacy");
  });

  it("rejects foreign source metadata before a same-UUID local cache hit", async () => {
    const f = fixture();
    const session = await f.adapter.createSession("/repo");
    const reads = vi.mocked(f.executions[0].native.readThread).mock.calls.length;
    await expect(f.adapter.restoreSession(session.id, "/repo", { ...session.engineMeta, codexHome: "/different-codex-home" })).rejects.toMatchObject({ code: "CODEX_SESSION_SOURCE_MISMATCH" });
    await expect(f.adapter.restoreSession(session.id, "/repo", { ...session.engineMeta, sourceId: "different-source" })).rejects.toMatchObject({ code: "CODEX_SESSION_SOURCE_MISMATCH" });
    await expect(f.adapter.getHistoricalMessages(session.id, "/repo", { catalogSourceId: "different-source" })).rejects.toMatchObject({ code: "CODEX_SESSION_SOURCE_MISMATCH" });
    expect(() => f.adapter.assertSessionCompatible(session.id, { codexThreadId: "another-thread" })).toThrow("another Codex source");
    expect(() => f.adapter.assertSessionCompatible(`codex_${session.id}`, session.engineMeta)).not.toThrow();
    expect(f.executions[0].native.readThread).toHaveBeenCalledTimes(reads);
    expect(f.readStoredThread).not.toHaveBeenCalled();
  });

  it("preserves the native permission profile and synchronizes explicit settings changes", async () => {
    const f = fixture();
    const session = await f.adapter.createSession("/repo");
    const execution = f.executions[0];
    const native = execution.states.get("codex_thread-1")!;
    native.permissions = ":workspace";
    native.approvalPolicy = "on-request";
    native.sandboxPolicy = null;
    await f.adapter.setModel(session.id, "chosen-model");
    await f.adapter.setReasoningEffort(session.id, "high");
    await f.adapter.setServiceTier(session.id, "fast");
    const current = await f.adapter.getSession(session.id);
    expect(current).toMatchObject({ modelId: "chosen-model", mode: "ask", reasoningEffort: "high", serviceTier: "fast" });
    await f.adapter.sendMessage(session.id, [{ type: "text", text: "Preserve permissions" }]);
    expect(execution.sendMessage).toHaveBeenCalledWith("codex_thread-1", expect.any(Array), expect.objectContaining({
      nativeOverrides: { permissions: ":workspace", approvalPolicy: "on-request", sandboxPolicy: null },
    }));
    expect(native.permissions).toBe(":workspace");
    expect(execution.native.updateSettings).toHaveBeenCalledTimes(3);

    // Choosing a preset replaces the native profile with explicit permissions.
    await f.adapter.setMode(session.id, "full-access");
    expect(execution.native.updateSettings).toHaveBeenLastCalledWith("codex_thread-1", {
      approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" },
    }, {});
    expect(await f.adapter.getSession(session.id)).toMatchObject({ mode: "full-access" });
    await f.adapter.sendMessage(session.id, [{ type: "text", text: "Full access" }]);
    expect(execution.sendMessage).toHaveBeenLastCalledWith("codex_thread-1", expect.any(Array), expect.objectContaining({
      nativeOverrides: { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } },
    }));
    await expect(f.adapter.setMode(session.id, "plan")).rejects.toThrow("Unsupported Codex permission mode");
  });

  it("uses the same protected permissions and canonical reply identity for skills", async () => {
    const f = fixture();
    const session = await f.adapter.createSession("/repo");
    const execution = f.executions[0];
    const native = execution.states.get("codex_thread-1")!;
    native.permissions = ":read-only";
    native.approvalPolicy = "on-request";
    native.sandboxPolicy = null;
    const result = await f.adapter.invokeCommand(session.id, "test-skill", "task");
    expect(result.message?.id).toBe("codex-desktop:v1:local:thread-1:turn-1:item:turn-1-final");
    expect(execution.invokeCommand).toHaveBeenCalledWith("codex_thread-1", "test-skill", "task", expect.objectContaining({
      nativeOverrides: { permissions: ":read-only", approvalPolicy: "on-request", sandboxPolicy: null },
    }));
  });

  it("retracts a removed native item without retaining the old response", async () => {
    const f = fixture();
    const session = await f.adapter.createSession("/repo");
    await f.adapter.sendMessage(session.id, [{ type: "text", text: "Hello" }]);
    const removed = vi.fn();
    f.adapter.on("message.removed", removed);
    const turns = f.executions[0].states.get("codex_thread-1")!.thread.turns as Array<{ items: unknown[] }>;
    turns[0].items.pop();
    expect(await f.adapter.listMessages(session.id)).toHaveLength(1);
    expect(removed).toHaveBeenCalledExactlyOnceWith({ sessionId: session.id, messageId: "codex-desktop:v1:local:thread-1:turn-1:item:turn-1-final" });
  });

  it("does not discard a foreign conversation whose complete history did not synchronize", async () => {
    const archiveStoredThread = vi.fn(async (id: string) => ({ id }));
    const f = fixture(true, { archiveStoredThread });
    const state = { id: "external", hostId: "local", cwd: "/repo", title: "Partial", createdAt: 1000, updatedAt: 2000,
      resumeState: "resumed", turnsPagination: { hasLoadedOldest: false }, turns: [], requests: [],
    };
    f.owners.set("external", { clientId: "external-owner", followers: new Set(), registration: {
      conversationId: "external", supportedMethods: [], getSnapshot: () => ({ type: "snapshot", revision: 1, conversationState: state }), handleRequest: async () => ({}),
    } });
    await expect(f.adapter.removeSession("external")).rejects.toThrow("complete conversation");
    expect(f.follower.loadCompleteHistory).toHaveBeenCalledWith("external", "external-owner");
    expect(archiveStoredThread).not.toHaveBeenCalled();
    expect(f.follower.unfollowThread).not.toHaveBeenCalled();
    expect(f.executions).toHaveLength(0);
    expect((await f.adapter.getSession("external"))?.id).toBe("external");
  });

  it("preserves a locally owned conversation and its pending native interaction on removal", async () => {
    const f = fixture();
    const session = await f.adapter.createSession("/repo");
    const execution = f.executions[0];
    execution.states.get("codex_thread-1")!.requests = [{ id: 7, method: "item/tool/requestUserInput", params: {
      questions: [{ id: "decision", header: "Choice", question: "Keep working?", options: [{ label: "Continue", description: "Keep the turn" }] }],
    } }];
    await expect(f.adapter.removeSession(session.id)).rejects.toThrow("pending interactions");
    expect(execution.deleteSession).not.toHaveBeenCalled();
    expect(execution.states.get("codex_thread-1")!.requests).toHaveLength(1);
    expect(f.adapter.hasSession(session.id)).toBe(true);
  });

  it("checks stored activity without reconnecting IPC when removal is requested with sharing off", async () => {
    const archiveStoredThread = vi.fn(async (id: string) => ({ id, cwd: "/repo" }));
    const f = fixture(false, { archiveStoredThread, readStoredThread: async (id) => ({ archived: false,
      thread: { id, cwd: "/repo", status: { type: "active" }, turns: [] },
    }) });
    await expect(f.adapter.removeSession("external")).rejects.toThrow("pending interactions");
    expect(archiveStoredThread).not.toHaveBeenCalled();
    expect(f.follower.connect).not.toHaveBeenCalled();
    expect(f.follower.unfollowThread).not.toHaveBeenCalled();
    expect(f.executions).toHaveLength(0);
  });

  it("archives verified idle stored history without reconnecting IPC while sharing is off", async () => {
    const archiveStoredThread = vi.fn(async (id: string) => ({ id, cwd: "/repo" }));
    const f = fixture(false, { archiveStoredThread, readStoredThread: async (id) => ({ archived: false,
      thread: { id, cwd: "/repo", status: { type: "idle" }, turns: [{ id: "turn", status: "completed", items: [
        { id: "answer", type: "agentMessage", text: "Complete reply", phase: "final_answer" },
      ] }] },
    }) });
    await expect(f.adapter.removeSession("external")).resolves.toBe("archived");
    expect(archiveStoredThread).toHaveBeenCalledExactlyOnceWith("external");
    expect(f.follower.connect).not.toHaveBeenCalled();
    expect(f.executions).toHaveLength(0);
  });

  it.each([undefined, "CodeMux"])("follows a foreign owner using its advertised name %s without inferring creation origin", async (clientName) => {
    const f = fixture(true);
    const consumed = vi.fn();
    f.adapter.on("message.queued.consumed", consumed);
    const state = { id: "external", hostId: "local", cwd: "/repo", title: "External", createdAt: 1000, updatedAt: 2000, resumeState: "resumed", turns: [] as Array<Record<string, unknown>>, requests: [] };
    let revision = 1;
    f.owners.set("external", { clientId: "desktop", followers: new Set(), registration: {
      conversationId: "external", clientName, supportedMethods: [], getSnapshot: () => ({ type: "snapshot", revision, conversationState: state }), handleRequest: async () => ({}),
    } });
    f.follower.startTurn.mockImplementation(async () => {
      state.turns.push({ turnId: "remote-turn", status: "completed", turnStartedAtMs: 3000, durationMs: 1000,
        params: { input: [{ type: "text", text: "External turn" }] },
        items: [{ id: "remote-user", type: "userMessage", content: [{ type: "text", text: "External turn" }] },
          { id: "remote-final", type: "agentMessage", text: "External answer", phase: "final_answer" }],
      });
      revision += 1;
      f.follower.emit("stream", { conversationId: "external", hostId: "local", ownerClientId: "desktop", change: { type: "snapshot", revision, conversationState: state } });
      return { threadId: "external", input: {}, turnId: "remote-turn" };
    });
    const session = await f.adapter.restoreSession("external", "/repo", { codexThreadId: "external", codexOrigin: "Codex Desktop" });
    expect(session.connection).toMatchObject({ origin: "Codex Desktop", executor: clientName ?? "Codex", shared: true, available: true });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.executions).toHaveLength(0);
    f.follower.discoverOwner.mockClear();
    const reply = await f.adapter.sendMessage("external", [{ type: "text", text: "External turn" }], { clientMessageId: "foreign-preview" });
    expect(reply.id).toBe("codex-desktop:v1:local:external:remote-turn:item:remote-final");
    expect(consumed).toHaveBeenCalledExactlyOnceWith({ sessionId: "external", messageId: expect.any(String), clientMessageId: "foreign-preview" });
    expect(f.follower.discoverOwner).toHaveBeenCalledExactlyOnceWith("external");
    expect(f.follower.startTurn).toHaveBeenCalledTimes(1);
    expect(f.executions).toHaveLength(0);
    await f.adapter.setSessionSharing(false);
    expect((await f.adapter.getSession("external"))?.connection?.available).toBe(false);
    await expect(f.adapter.sendMessage("external", [{ type: "text", text: "No takeover" }])).rejects.toThrow("Enable sharing");
    await f.adapter.setSessionSharing(true);
    expect((await f.adapter.getSession("external"))?.connection?.available).toBe(true);
    expect(await f.adapter.listMessages("external")).toHaveLength(2);
    expect(f.executions).toHaveLength(0);
  });
});
