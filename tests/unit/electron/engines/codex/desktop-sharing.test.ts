import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CodexAdapter } from "../../../../../electron/main/engines/codex";
import type { CodexDesktopOwnerRuntime } from "../../../../../electron/main/engines/codex/desktop-owner";
import type { CodexDesktopIpcClient, DesktopOwnedThreadRegistration, DesktopThreadSnapshot, DesktopThreadPatches } from "../../../../../electron/main/engines/codex/desktop-ipc-client";
import { createCodexDesktopSharing, type CodexDesktopSharingOptions } from "../../../../../electron/main/engines/codex/desktop-sharing";
import { CodexDesktopCatalog } from "../../../../../electron/main/engines/codex/desktop-catalog";
import { verifyCodexRolloutPath } from "../../../../../electron/main/engines/codex/desktop-rollout-path";

vi.mock("../../../../../electron/main/services/logger", () => ({ codexLog: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock("../../../../../electron/main/engines/codex/desktop-rollout-path", () => ({ verifyCodexRolloutPath: vi.fn(async () => undefined) }));

interface OwnerEntry {
  ownerClientId: string;
  snapshot: () => DesktopThreadSnapshot;
  followers: Set<MockIpcClient>;
}

class MockIpcClient extends EventEmitter {
  connected = true;
  private followed = new Map<string, string>();
  private discovered = new Map<string, string>();
  constructor(readonly clientId: string, private readonly owners: Map<string, OwnerEntry>) { super(); }
  connect = vi.fn(async () => { this.connected = true; });
  close = vi.fn(() => { this.connected = false; this.emit("close"); });
  discoverOwner = vi.fn(async (id: string) => {
    const owner = this.owners.get(id);
    if (owner) this.discovered.set(id, owner.ownerClientId); else this.discovered.delete(id);
    return owner ? { ownerClientId: owner.ownerClientId, supportsUntrustedAppInput: false } : null;
  });
  registerOwnedThread = vi.fn((registration: DesktopOwnedThreadRegistration) => {
    const entry = { ownerClientId: this.clientId, snapshot: registration.getSnapshot, followers: new Set<MockIpcClient>() };
    this.owners.set(registration.conversationId, entry);
    return () => { if (this.owners.get(registration.conversationId) === entry) this.owners.delete(registration.conversationId); };
  });
  publishOwnedThreadState = vi.fn((id: string, change: DesktopThreadSnapshot | DesktopThreadPatches) => {
    for (const follower of this.owners.get(id)?.followers ?? []) {
      follower.emit("stream", { conversationId: id, hostId: "local", ownerClientId: this.clientId, change });
    }
  });
  followThread = vi.fn(async (id: string, ownerId: string) => {
    const owner = this.owners.get(id);
    if (!owner || owner.ownerClientId !== ownerId) throw new Error("Test owner missing");
    this.followed.set(id, ownerId);
    owner.followers.add(this);
    return owner.snapshot();
  });
  unfollowThread = vi.fn((id: string) => { this.followed.delete(id); this.owners.get(id)?.followers.delete(this); });
  isFollowingThread = vi.fn((id: string, ownerId: string) => this.connected && this.followed.get(id) === ownerId && this.discovered.get(id) === ownerId);
  notifyThreadMetadataAvailable = vi.fn((_id: string, _ownerId: string) => {});
  notifyThreadArchived = vi.fn((_id: string, _cwd: string) => {});
  notifyThreadUnarchived = vi.fn((_id: string) => {});
  startTurn = vi.fn(async (_id: string, _ownerId: string, _operation: Record<string, unknown>): Promise<unknown> => ({}));
  loadCompleteHistory = vi.fn(async (id: string, ownerId: string) => {
    const owner = this.owners.get(id);
    if (!owner || owner.ownerClientId !== ownerId) throw new Error("Test owner missing");
    for (const follower of owner.followers) follower.emit("stream", { conversationId: id, hostId: "local", ownerClientId: ownerId, change: owner.snapshot() });
    return { revision: owner.snapshot().revision };
  });
}

function fixture(options: Partial<CodexDesktopSharingOptions> = {}) {
  const owners = new Map<string, OwnerEntry>();
  const ownerClient = new MockIpcClient("codemux-owner", owners);
  const followerClient = new MockIpcClient("codemux-follower", owners);
  const nativeState = {
    thread: { id: "native-thread", cwd: "/selected/repo", name: "Shared new task", createdAt: 1, updatedAt: 2, turns: [] },
    model: "modelhub-model", modelProvider: "modelhub", reasoningEffort: "ultra",
  };
  const runtime: CodexDesktopOwnerRuntime = {
    readThread: vi.fn(async () => nativeState),
    request: vi.fn(async () => ({})),
    respond: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };
  let created = false;
  const execution = {
    createDesktopOwnerRuntime: () => runtime,
    createSession: vi.fn(async (directory: string, _meta?: Record<string, unknown>) => {
      created = true;
      nativeState.thread.cwd = directory;
      return { id: "codex_native-thread", engineType: "codex" as const, directory, time: { created: 1000, updated: 2000 }, engineMeta: { codexThreadId: "native-thread" } };
    }),
    hasSession: vi.fn(() => created),
    renameSession: vi.fn(async (_id: string, title: string) => { nativeState.thread.name = title; }),
    readStoredThread: vi.fn(async (_id: string) => ({ thread: nativeState.thread, archived: false })),
    archiveStoredThread: vi.fn(async (_id: string) => nativeState.thread),
    deleteSession: vi.fn(async (_id: string) => { created = false; }),
    stop: vi.fn(async () => {}),
  };
  const foreignStates = new Map<string, Record<string, unknown>>();
  const storedTitles = new Map<string, string>();
  const renameStoredThread = vi.fn(async (id: string, title: string) => { storedTitles.set(id, title); });
  followerClient.notifyThreadMetadataAvailable.mockImplementation((id) => {
    const state = foreignStates.get(id);
    if (state && storedTitles.has(id)) state.title = storedTitles.get(id);
  });
  const service = createCodexDesktopSharing({
    privateExecutionAdapter: execution as unknown as CodexAdapter,
    ownerClient: ownerClient as unknown as CodexDesktopIpcClient,
    followerClient: followerClient as unknown as CodexDesktopIpcClient,
    renameStoredThread,
    syncTimeoutMs: 250,
    ...options,
  });
  const foreignOwner = (id: string) => {
    const state = {
      id, hostId: "local", cwd: "/official/repo", title: "Official task", createdAt: 1000, updatedAt: 2000,
      latestModel: "official-model", resumeState: "resumed", turns: [], requests: [],
    };
    foreignStates.set(id, state);
    owners.set(id, {
      ownerClientId: "official-desktop", followers: new Set(),
      snapshot: () => ({ type: "snapshot", revision: state.title === "Official task" ? 1 : 2, conversationState: state }),
    });
    return state;
  };
  return { service, execution, runtime, ownerClient, followerClient, owners, foreignOwner, renameStoredThread, nativeState, foreignStates };
}

function lifecycleFixture() {
  const archived = new Set<string>();
  const readStoredThread = vi.fn(async (id: string) => {
    if (id === "native-thread") return { thread: { ...f.nativeState.thread }, archived: archived.has(id) };
    const foreign = f.foreignStates.get(id);
    if (!foreign) throw new Error("Original thread is missing");
    return { thread: { id, cwd: foreign.cwd, name: foreign.title, createdAt: 1, updatedAt: 2, turns: [] }, archived: archived.has(id) };
  });
  const archiveStoredThread = vi.fn(async (id: string) => {
    if (f.owners.get(id)?.ownerClientId === "official-desktop") throw new Error("Cannot archive a thread with an active writer");
    archived.add(id);
    return (await readStoredThread(id)).thread;
  });
  const unarchiveStoredThread = vi.fn(async (id: string) => {
    archived.delete(id);
    return (await readStoredThread(id)).thread;
  });
  const f: ReturnType<typeof fixture> = fixture({ readStoredThread, archiveStoredThread, unarchiveStoredThread });
  f.execution.readStoredThread.mockImplementation(async (id) => {
    const stored = await readStoredThread(id);
    return { thread: stored.thread as typeof f.nativeState.thread, archived: stored.archived };
  });
  f.execution.archiveStoredThread.mockImplementation(async (id) => {
    archived.add(id);
    return f.nativeState.thread;
  });
  return { ...f, archived, readStoredThread, archiveStoredThread, unarchiveStoredThread };
}

function catalogFixture(initiallyVisible = true) {
  let visible = initiallyVisible;
  let archived = false;
  const admitThread = vi.fn((_id: string) => {});
  const catalogFactory = vi.fn(() => new CodexDesktopCatalog({
    sourceId: "test-source", cutoffMs: 1000, pollIntervalMs: 10000,
    client: { admitThread, request: vi.fn(async (method, params) => {
      if (method === "project/list") return { data: [], nextCursor: null };
      if (method === "thread/list") return { data: visible && params.archived === archived ? [{ ...f.nativeState.thread, projectId: null }] : [], nextCursor: null };
      if (method === "thread/read") return { thread: { ...f.nativeState.thread, projectId: null } };
      throw new Error(`Unexpected metadata method: ${method}`);
    }) },
  }));
  const f: ReturnType<typeof fixture> = fixture({
    catalogFactory,
    readStoredThread: async () => ({ thread: f.nativeState.thread, archived: false }),
  });
  f.runtime.readMetadata = vi.fn(async () => ({ ...f.nativeState.thread, canAcceptDirectInput: true }));
  return { ...f, catalogFactory, admitThread,
    setCatalogState: (nextVisible: boolean, nextArchived = false) => { visible = nextVisible; archived = nextArchived; },
    refreshCatalog: () => catalogFactory.mock.results[0].value.refresh(),
  };
}

function publishObservedUser(f: ReturnType<typeof catalogFixture>, id = "native-thread", revision = 2): void {
  const entry = f.owners.get(id);
  if (!entry) throw new Error("Fixture owner missing");
  const before = entry.snapshot();
  const state = { ...before.conversationState, turns: [{
    turnId: "first-turn", status: "inProgress", turnStartedAtMs: 3000,
    params: { input: [{ type: "text", text: "First user input" }] },
    items: [{ type: "userMessage", id: "first-user", content: [{ type: "text", text: "First user input" }] }],
  }] };
  for (const follower of entry.followers) follower.emit("stream", { conversationId: id, hostId: "local", ownerClientId: entry.ownerClientId,
    change: { type: "snapshot", revision, conversationState: state } });
}

describe("new materialized thread announcements", () => {
  it.each([undefined, "", "  ", "New session - 2026-10-13T00:00:00.000Z"])("persists a default native title for a new catalog conversation named %s", async (nativeTitle) => {
    const f = catalogFixture(false);
    if (nativeTitle === undefined) Reflect.deleteProperty(f.nativeState.thread, "name");
    else f.nativeState.thread.name = nativeTitle;
    vi.mocked(verifyCodexRolloutPath).mockResolvedValueOnce("active");
    try {
      const session = await f.service.adapter.createSession("/selected/repo");
      expect(session.id).toBe("native-thread");
      expect(session.title).toBe("New session - 1970-01-01T00:00:01.000Z");
      expect(f.execution.renameSession).toHaveBeenCalledExactlyOnceWith("codex_native-thread", session.title);
      expect(f.runtime.readMetadata).toHaveBeenCalledTimes(2);
      const metadataReads = vi.mocked(f.runtime.readMetadata!).mock.invocationCallOrder;
      expect(metadataReads[0]).toBeLessThan(f.execution.renameSession.mock.invocationCallOrder[0]);
      expect(f.execution.renameSession.mock.invocationCallOrder[0]).toBeLessThan(metadataReads[1]);
      expect(metadataReads[1]).toBeLessThan(f.admitThread.mock.invocationCallOrder[0]);
      expect(verifyCodexRolloutPath).toHaveBeenCalledWith("native-thread", expect.objectContaining({ id: "native-thread", name: session.title }));
      expect(f.admitThread.mock.invocationCallOrder[0]).toBeLessThan(f.ownerClient.registerOwnedThread.mock.invocationCallOrder[0]);
      expect(f.nativeState.thread.turns).toEqual([]);
      expect(f.runtime.request).not.toHaveBeenCalled();
      expect(f.execution.deleteSession).not.toHaveBeenCalled();
      expect(f.followerClient.notifyThreadUnarchived).not.toHaveBeenCalled();
      publishObservedUser(f);
      await f.refreshCatalog();
      expect(f.execution.renameSession).toHaveBeenCalledOnce();
    } finally { await f.service.stop(); }
  });

  it("preserves a custom native title even when the creation response omits it", async () => {
    const f = catalogFixture(false);
    try {
      const session = await f.service.adapter.createSession("/selected/repo");
      expect(session.title).toBe("Shared new task");
      expect(f.execution.renameSession).not.toHaveBeenCalled();
      expect(f.runtime.readMetadata).toHaveBeenCalledOnce();
      expect(f.admitThread).toHaveBeenCalledExactlyOnceWith("native-thread");
    } finally { await f.service.stop(); }
  });

  it("preserves a custom creation title when metadata temporarily omits its name", async () => {
    const f = catalogFixture(false);
    f.nativeState.thread.name = "";
    f.execution.createSession.mockResolvedValueOnce({ id: "codex_native-thread", engineType: "codex", directory: "/selected/repo", title: "Custom title", time: { created: 1000, updated: 2000 }, engineMeta: { codexThreadId: "native-thread" } });
    try {
      await f.service.adapter.createSession("/selected/repo");
      expect(f.execution.renameSession).not.toHaveBeenCalled();
      expect(f.admitThread).toHaveBeenCalledExactlyOnceWith("native-thread");
    } finally { await f.service.stop(); }
  });

  it.each(["unconfirmed-title", "wrong-identity", "metadata-read", "missing-path", "archived-path", "catalog-admission", "owner-registration"])("unloads only the new writer after %s fails", async (failure) => {
    const f = catalogFixture(false);
    f.nativeState.thread.name = "";
    const admission = vi.spyOn(CodexDesktopCatalog.prototype, "admitCreatedThread");
    if (failure === "unconfirmed-title") f.execution.renameSession.mockResolvedValueOnce(undefined);
    if (failure === "wrong-identity") vi.mocked(f.runtime.readMetadata!).mockResolvedValueOnce({ ...f.nativeState.thread, id: "different-thread" });
    if (failure === "metadata-read") vi.mocked(f.runtime.readMetadata!).mockRejectedValueOnce(new Error("Metadata unavailable"));
    if (failure === "archived-path") vi.mocked(verifyCodexRolloutPath).mockResolvedValueOnce("archived");
    if (failure === "catalog-admission" || failure === "owner-registration") vi.mocked(verifyCodexRolloutPath).mockResolvedValueOnce("active");
    if (failure === "catalog-admission") admission.mockRejectedValueOnce(new Error("Catalog unavailable"));
    if (failure === "owner-registration") f.ownerClient.registerOwnedThread.mockImplementationOnce(() => { throw new Error("Owner unavailable"); });
    try {
      await expect(f.service.adapter.createSession("/selected/repo")).rejects.toThrow();
      expect(f.execution.deleteSession).toHaveBeenCalledExactlyOnceWith("codex_native-thread");
      expect(f.owners.size).toBe(0);
      expect(f.nativeState.thread.id).toBe("native-thread");
      expect(f.nativeState.thread.turns).toEqual([]);
      if (failure === "catalog-admission" || failure === "owner-registration" || failure === "missing-path" || failure === "archived-path") expect(f.nativeState.thread.name).toBe("New session - 1970-01-01T00:00:01.000Z");
      if (failure !== "owner-registration") expect(f.admitThread).not.toHaveBeenCalled();
      expect(f.runtime.request).not.toHaveBeenCalled();
      expect(f.followerClient.notifyThreadUnarchived).not.toHaveBeenCalled();
    } finally { admission.mockRestore(); await f.service.stop(); }
  });

  it("admits a newly created native identity before registering its owner", async () => {
    const f = catalogFixture(false);
    try {
      expect((await f.service.adapter.createSession("/selected/repo")).id).toBe("native-thread");
      expect(f.admitThread).toHaveBeenCalledExactlyOnceWith("native-thread");
      expect(f.execution.createSession.mock.invocationCallOrder[0]).toBeLessThan(f.admitThread.mock.invocationCallOrder[0]);
      expect(f.admitThread.mock.invocationCallOrder[0]).toBeLessThan(f.ownerClient.registerOwnedThread.mock.invocationCallOrder[0]);
      expect(f.catalogFactory).toHaveBeenCalledOnce();
      expect(f.followerClient.notifyThreadUnarchived).not.toHaveBeenCalled();
      expect(f.runtime.request).not.toHaveBeenCalled();
    } finally { await f.service.stop(); }
  });

  it("does not admit a conversation when native creation returns no identity", async () => {
    const f = catalogFixture(false);
    f.execution.createSession.mockResolvedValueOnce({ id: "codex_invalid", engineType: "codex", directory: "/selected/repo", time: { created: 1000, updated: 2000 }, engineMeta: { codexThreadId: "" } });
    try {
      await expect(f.service.adapter.createSession("/selected/repo")).rejects.toThrow("did not return a native thread ID");
      expect(f.admitThread).not.toHaveBeenCalled();
      expect(f.ownerClient.registerOwnedThread).not.toHaveBeenCalled();
      expect(f.execution.deleteSession).toHaveBeenCalledExactlyOnceWith("codex_invalid");
    } finally { await f.service.stop(); }
  });

  it.each(["catalog-first", "message-first"])("announces once after both readiness signals in %s order", async (order) => {
    const f = catalogFixture(false);
    try {
      await f.service.adapter.start();
      await f.service.adapter.getCatalog();
      await f.service.adapter.createSession("/selected/repo");
      expect(f.followerClient.notifyThreadUnarchived).not.toHaveBeenCalled();
      if (order === "catalog-first") {
        f.setCatalogState(true);
        await f.refreshCatalog();
        expect(f.followerClient.notifyThreadUnarchived).not.toHaveBeenCalled();
        publishObservedUser(f);
      } else {
        publishObservedUser(f);
        expect(f.followerClient.notifyThreadUnarchived).not.toHaveBeenCalled();
        f.setCatalogState(true);
        await f.refreshCatalog();
      }
      expect(f.followerClient.notifyThreadUnarchived).toHaveBeenCalledExactlyOnceWith("native-thread");
      publishObservedUser(f, "native-thread", 3);
      await f.refreshCatalog();
      expect(f.followerClient.notifyThreadUnarchived).toHaveBeenCalledOnce();
      expect(f.execution.readStoredThread).not.toHaveBeenCalled();
    } finally { await f.service.stop(); }
  });

  it("does not announce restored or explicitly acquired threads as new creations", async () => {
    for (const mode of ["restore", "acquire"] as const) {
      const f = catalogFixture();
      try {
        await f.service.adapter.start();
        await f.service.adapter.getCatalog();
        if (mode === "restore") {
          f.foreignOwner("native-thread");
          await f.service.adapter.restoreSession("native-thread", "/selected/repo", { codexThreadId: "native-thread", codexDesktopOwner: "codemux" });
        }
        else {
          const service = f.service as unknown as { acquireForExplicitInput(id: string): Promise<unknown> };
          await service.acquireForExplicitInput("native-thread");
          await f.service.adapter.attachThread("native-thread");
        }
        publishObservedUser(f);
        await f.refreshCatalog();
        expect(f.followerClient.notifyThreadUnarchived).not.toHaveBeenCalled();
      } finally { await f.service.stop(); }
    }
  });

  it("does not announce after archival, a foreign-owner change, or shutdown", async () => {
    for (const mode of ["archived", "foreign", "stopped"] as const) {
      const f = catalogFixture(false);
      try {
        await f.service.adapter.start();
        await f.service.adapter.getCatalog();
        await f.service.adapter.createSession("/selected/repo");
        publishObservedUser(f);
        if (mode === "stopped") await f.service.stop();
        else {
          if (mode === "foreign") f.followerClient.isFollowingThread.mockReturnValue(false);
          f.setCatalogState(true, mode === "archived");
          await f.refreshCatalog();
        }
        expect(f.followerClient.notifyThreadUnarchived).not.toHaveBeenCalled();
      } finally { await f.service.stop(); }
    }
  });
});

describe("canonical catalog ownership", () => {
  it.each(["metadata-marker", "catalog-membership"])("reads a restarted CodeMux-owned catalog thread without a writer using %s", async (detection) => {
    const f = catalogFixture();
    try {
      await f.service.adapter.start();
      if (detection === "catalog-membership") await f.service.adapter.getCatalog();
      const meta = { codexThreadId: "native-thread", codexDesktopOwner: "codemux", ...(detection === "metadata-marker" ? { catalogSourceId: "test-source" } : {}) };
      const restored = await f.service.adapter.restoreSession("native-thread", "/selected/repo", meta);
      expect(restored.id).toBe("native-thread");
      await f.service.adapter.listMessages("native-thread");
      await f.service.adapter.getSession("native-thread");
      expect(f.execution.createSession).not.toHaveBeenCalled();
      expect(f.ownerClient.registerOwnedThread).not.toHaveBeenCalled();
      await expect(f.service.adapter.sendMessage("native-thread", [])).rejects.toThrow("non-empty");
      expect(f.execution.createSession).not.toHaveBeenCalled();

      f.followerClient.startTurn.mockImplementation(async (id, ownerId, operation) => {
        const request = operation.request as { input: unknown[]; clientUserMessageId: string };
        const owner = f.owners.get(id)!;
        const state = { ...owner.snapshot().conversationState, turns: [{
          turnId: "sent-turn", status: "completed", turnStartedAtMs: 3000, durationMs: 1000,
          params: { input: request.input, clientUserMessageId: request.clientUserMessageId },
          items: [
            { type: "userMessage", id: "sent-user", content: request.input },
            { type: "agentMessage", id: "sent-answer", phase: "final_answer", text: "Done" },
          ],
        }] };
        for (const follower of owner.followers) follower.emit("stream", { conversationId: id, hostId: "local", ownerClientId: ownerId,
          change: { type: "snapshot", revision: 2, conversationState: state } });
        return { result: { turn: { id: "sent-turn" } } };
      });
      await f.service.adapter.sendMessage("native-thread", [{ type: "text", text: "Explicit input" }]);
      expect(f.execution.createSession).toHaveBeenCalledExactlyOnceWith("/selected/repo", { codexThreadId: "native-thread", codexDesktopOwner: "codemux" });
      expect(f.runtime.readMetadata).toHaveBeenCalledWith("codex_native-thread");
      expect(f.ownerClient.registerOwnedThread).toHaveBeenCalledOnce();
      expect(f.followerClient.startTurn).toHaveBeenCalledOnce();
    } finally { await f.service.stop(); }
  });

  it("reads and publishes metadata without acquiring or executing the discovered thread", async () => {
    const f = catalogFixture();
    const updated = vi.fn();
    f.service.adapter.on("catalog.updated", updated);
    await f.service.adapter.start();
    expect((await f.service.adapter.getCatalog()).sessions.map((session) => session.id)).toEqual(["native-thread"]);
    await f.service.adapter.getSession("native-thread");
    await expect(f.service.adapter.sendMessage("native-thread", [])).rejects.toThrow("non-empty");
    expect(updated).toHaveBeenCalled();
    expect(f.execution.createSession).not.toHaveBeenCalled();
    expect(f.runtime.request).not.toHaveBeenCalled();
    expect(f.ownerClient.registerOwnedThread).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it.each([false, null, undefined])("refuses to advertise input ownership when native readback is %s", async (canAcceptDirectInput) => {
    const f = catalogFixture();
    f.runtime.readMetadata = vi.fn(async () => ({ ...f.nativeState.thread, canAcceptDirectInput }));
    await f.service.adapter.start();
    await expect(f.service.adapter.sendMessage("native-thread", [{ type: "text", text: "Test input" }])).rejects.toThrow("exclusive input ownership");
    expect(f.ownerClient.registerOwnedThread).not.toHaveBeenCalled();
    expect(f.execution.deleteSession).toHaveBeenCalledWith("codex_native-thread");
    expect(f.runtime.request).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it("propagates a competing native writer refusal without creating an owner or a replacement", async () => {
    const f = catalogFixture();
    f.execution.createSession.mockRejectedValueOnce(new Error("already has an active writer"));
    await f.service.adapter.start();
    await expect(f.service.adapter.sendMessage("native-thread", [{ type: "text", text: "Test input" }])).rejects.toThrow("active writer");
    expect(f.execution.createSession).toHaveBeenCalledExactlyOnceWith("/selected/repo", { codexThreadId: "native-thread", codexDesktopOwner: "codemux" });
    expect(f.ownerClient.registerOwnedThread).not.toHaveBeenCalled();
    expect(f.runtime.request).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it("registers the same native identity only after exclusive input capability is confirmed", async () => {
    const f = catalogFixture();
    await f.service.adapter.start();
    const acquire = f.service as unknown as { acquireForExplicitInput(id: string): Promise<{ threadId: string; owned: boolean }> };
    expect(await acquire.acquireForExplicitInput("native-thread")).toEqual({ threadId: "native-thread", owned: true });
    expect(f.runtime.readMetadata).toHaveBeenCalledWith("codex_native-thread");
    expect(f.ownerClient.registerOwnedThread).toHaveBeenCalledOnce();
    expect((await f.service.adapter.attachThread("native-thread")).id).toBe("native-thread");
    expect(f.runtime.request).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it("re-registers a loaded CodeMux writer after IPC disconnect before sending", async () => {
    const f = catalogFixture();
    try {
      await f.service.adapter.createSession("/selected/repo");
      f.owners.clear();
      f.ownerClient.close();
      f.followerClient.close();
      f.followerClient.startTurn.mockImplementation(async (id, ownerId, operation) => {
        const request = operation.request as { input: unknown[]; clientUserMessageId: string };
        const owner = f.owners.get(id)!;
        const state = { ...owner.snapshot().conversationState, turns: [{
          turnId: "reconnected-turn", status: "completed", turnStartedAtMs: 3000, durationMs: 1000,
          params: { input: request.input, clientUserMessageId: request.clientUserMessageId },
          items: [
            { type: "userMessage", id: "reconnected-user", content: request.input },
            { type: "agentMessage", id: "reconnected-answer", phase: "final_answer", text: "Reconnected" },
          ],
        }] };
        for (const follower of owner.followers) follower.emit("stream", { conversationId: id, hostId: "local", ownerClientId: ownerId,
          change: { type: "snapshot", revision: 2, conversationState: state } });
        return { result: { turn: { id: "reconnected-turn" } } };
      });

      await expect(f.service.adapter.sendMessage("native-thread", [{ type: "text", text: "Continue after reconnect" }]))
        .resolves.toMatchObject({ engineMeta: { codexItemId: "reconnected-answer" } });
      expect(f.ownerClient.registerOwnedThread).toHaveBeenCalledTimes(2);
      expect(f.execution.createSession).toHaveBeenCalledOnce();
      expect(f.followerClient.startTurn).toHaveBeenCalledExactlyOnceWith("native-thread", "codemux-owner", expect.any(Object));
      expect(f.execution.deleteSession).not.toHaveBeenCalled();
    } finally { await f.service.stop(); }
  });

  it("follows a foreign owner that appears while a loaded writer reconnects", async () => {
    const f = catalogFixture();
    try {
      await f.service.adapter.createSession("/selected/repo");
      f.owners.clear();
      f.ownerClient.close();
      f.followerClient.close();
      f.ownerClient.discoverOwner.mockResolvedValueOnce(null).mockImplementationOnce(async (id) => {
        f.foreignOwner(id);
        return { ownerClientId: "official-desktop", supportsUntrustedAppInput: false };
      });
      const acquire = f.service as unknown as { acquireForExplicitInput(id: string): Promise<{ threadId: string; owned: boolean }> };

      await expect(acquire.acquireForExplicitInput("native-thread")).resolves.toEqual({ threadId: "native-thread", owned: false });
      expect((await f.service.adapter.attachThread("native-thread")).modelId).toBe("official-model");
      expect(f.ownerClient.registerOwnedThread).toHaveBeenCalledOnce();
      expect(f.execution.createSession).toHaveBeenCalledOnce();
      expect(f.execution.deleteSession).not.toHaveBeenCalled();
      expect(f.runtime.request).not.toHaveBeenCalled();
    } finally { await f.service.stop(); }
  });
});

describe("CodexDesktopSharingService", () => {
  it("uses live owners without reading unmaterialized or paginated stored history", async () => {
    const f = lifecycleFixture();
    f.readStoredThread.mockRejectedValue(new Error("Stored history is not materialized"));
    f.execution.readStoredThread.mockRejectedValue(new Error("Stored history is not materialized"));
    const created = await f.service.adapter.createSession("/chosen/repo");
    expect(created.id).toBe("native-thread");
    expect((await f.service.adapter.getSession("native-thread"))?.id).toBe("native-thread");
    expect(await f.service.adapter.listMessages("native-thread")).toEqual([]);

    f.foreignOwner("official-thread");
    expect((await f.service.adapter.restoreSession("official-thread", "/official/repo", { codexThreadId: "official-thread" })).id).toBe("official-thread");
    expect((await f.service.adapter.getSession("official-thread"))?.id).toBe("official-thread");
    expect(await f.service.adapter.listMessages("official-thread")).toEqual([]);
    expect(f.readStoredThread).not.toHaveBeenCalled();
    expect(f.execution.readStoredThread).not.toHaveBeenCalled();
    expect(f.execution.renameSession).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it("archives non-empty native history before removing its local writer and mirror", async () => {
    const f = lifecycleFixture();
    Object.assign(f.nativeState.thread, { turns: [{ id: "native-turn", status: "completed", items: [
      { id: "original-user", type: "userMessage", content: [{ type: "text", text: "Stored prompt" }] },
      { id: "original-answer", type: "agentMessage", text: "Stored answer" },
    ] }] });
    const original = structuredClone(f.nativeState.thread.turns);
    await f.service.adapter.createSession("/chosen/repo");
    expect(await f.service.adapter.removeSession("native-thread")).toBe("archived");
    expect(f.execution.archiveStoredThread).toHaveBeenCalledExactlyOnceWith("native-thread");
    expect(f.archiveStoredThread).not.toHaveBeenCalled();
    expect(f.execution.deleteSession).toHaveBeenCalledExactlyOnceWith("codex_native-thread");
    expect(f.execution.archiveStoredThread.mock.invocationCallOrder[0]).toBeLessThan(f.execution.deleteSession.mock.invocationCallOrder[0]);
    expect(f.owners.has("native-thread")).toBe(false);
    expect(f.followerClient.notifyThreadArchived).toHaveBeenCalledExactlyOnceWith("native-thread", "/chosen/repo");
    expect(await f.service.adapter.getSession("native-thread")).toBeNull();
    expect(await f.service.adapter.listSessions()).toEqual([]);
    expect(f.nativeState.thread.turns).toEqual(original);
    expect(f.readStoredThread).not.toHaveBeenCalled();
    expect(f.execution.readStoredThread).not.toHaveBeenCalled();
    expect(f.unarchiveStoredThread).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it("discards an empty CodeMux session without archiving or changing the native record", async () => {
    const f = lifecycleFixture();
    await f.service.adapter.createSession("/chosen/repo");
    const before = structuredClone(f.nativeState);
    expect(await f.service.adapter.removeSession("native-thread")).toBe("local");
    expect(f.execution.deleteSession).toHaveBeenCalledExactlyOnceWith("codex_native-thread");
    expect(f.execution.archiveStoredThread).not.toHaveBeenCalled();
    expect(f.archiveStoredThread).not.toHaveBeenCalled();
    expect(f.unarchiveStoredThread).not.toHaveBeenCalled();
    expect(f.followerClient.notifyThreadArchived).not.toHaveBeenCalled();
    expect(f.owners.size).toBe(0);
    expect(await f.service.adapter.listSessions()).toEqual([]);
    expect(f.nativeState).toEqual(before);
    await f.service.stop();
  });

  it("restricts owned conversation history reads to active native records", async () => {
    const f = lifecycleFixture();
    await f.service.adapter.createSession("/chosen/repo");
    const service = f.service as unknown as { readStoredThread(id: string): Promise<unknown> };
    await service.readStoredThread("native-thread");
    expect(f.execution.readStoredThread).toHaveBeenCalledExactlyOnceWith("native-thread", { activeOnly: true });
    expect(f.readStoredThread).toHaveBeenCalledExactlyOnceWith("native-thread");
    await f.service.stop();
  });

  it("preserves a foreign live owner when native archive rejects removal", async () => {
    const f = lifecycleFixture();
    const state = f.foreignOwner("official-thread");
    Object.assign(state, { turns: [{ turnId: "foreign-turn", status: "completed", turnStartedAtMs: 1000, durationMs: 1000,
      items: [{ id: "foreign-user", type: "userMessage", content: [{ type: "text", text: "Stored prompt" }] }] }] });
    await f.service.adapter.attachThread("official-thread");
    await expect(f.service.adapter.removeSession("official-thread")).rejects.toThrow("active writer");
    expect((await f.service.adapter.getSession("official-thread"))?.archived).toBe(false);
    expect(f.followerClient.isFollowingThread("official-thread", "official-desktop")).toBe(true);
    expect(f.followerClient.notifyThreadArchived).not.toHaveBeenCalled();
    expect(f.followerClient.unfollowThread).not.toHaveBeenCalled();
    expect(f.execution.deleteSession).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it("excludes archived history without publishing its metadata or messages", async () => {
    const f = lifecycleFixture();
    const updated = vi.fn();
    const messages = vi.fn();
    const removed = vi.fn();
    f.service.adapter.on("session.updated", updated);
    f.service.adapter.on("message.updated", messages);
    f.service.adapter.on("session.removed", removed);
    f.archived.add("native-thread");
    Object.assign(f.nativeState.thread, { turns: [{ id: "native-turn", status: "completed", items: [
      { id: "original-user", type: "userMessage", content: [{ type: "text", text: "Stored prompt" }] },
      { id: "original-answer", type: "agentMessage", text: "Stored answer" },
    ] }] });
    expect(await f.service.adapter.getSession("native-thread")).toBeNull();
    await expect(f.service.adapter.restoreSession("native-thread", "/saved/repo", { codexThreadId: "native-thread", codexDesktopOwner: "codemux" })).rejects.toThrow("not synchronized");
    await expect(f.service.adapter.listMessages("native-thread")).rejects.toThrow("not synchronized");
    expect(await f.service.adapter.removeSession("native-thread")).toBe("archived");
    expect(await f.service.adapter.listSessions()).toEqual([]);
    expect(updated).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledExactlyOnceWith({ sessionId: "native-thread" });
    expect(f.execution.createSession).not.toHaveBeenCalled();
    expect(f.ownerClient.registerOwnedThread).not.toHaveBeenCalled();
    expect(f.followerClient.followThread).not.toHaveBeenCalled();
    expect(f.unarchiveStoredThread).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it.each([true, false])("rejects the retired shared archive control (%s) without native writes", async (archived) => {
    const f = lifecycleFixture();
    await expect(f.service.adapter.setSessionArchived("native-thread", archived)).rejects.toThrow("do not expose");
    expect(f.archiveStoredThread).not.toHaveBeenCalled();
    expect(f.unarchiveStoredThread).not.toHaveBeenCalled();
    expect(f.execution.createSession).not.toHaveBeenCalled();
    expect(f.followerClient.notifyThreadUnarchived).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it("verifies external archive notifications and removes the mirror without restoring it", async () => {
    const f = lifecycleFixture();
    const removed = vi.fn();
    f.service.adapter.on("session.removed", removed);
    f.foreignOwner("official-thread");
    await f.service.adapter.attachThread("official-thread");
    f.followerClient.emit("threadArchived", { conversationId: "official-thread", hostId: "local", sourceClientId: "official-desktop", cwd: "/official/repo" });
    await vi.waitFor(() => expect(f.readStoredThread).toHaveBeenCalled());
    expect((await f.service.adapter.listSessions())[0].archived).toBe(false);
    expect(f.followerClient.unfollowThread).not.toHaveBeenCalled();

    f.archived.add("official-thread");
    f.owners.delete("official-thread");
    f.followerClient.emit("threadArchived", { conversationId: "official-thread", hostId: "local", sourceClientId: "official-desktop", cwd: "/official/repo" });
    await vi.waitFor(async () => expect(await f.service.adapter.listSessions()).toEqual([]));
    expect(removed).toHaveBeenCalledExactlyOnceWith({ sessionId: "official-thread" });
    expect(await f.service.adapter.getSession("official-thread")).toBeNull();
    expect(f.execution.createSession).not.toHaveBeenCalled();
    expect(f.ownerClient.registerOwnedThread).not.toHaveBeenCalled();
    expect(f.unarchiveStoredThread).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it("creates through the private runtime and exposes only the IPC follower's original thread identity", async () => {
    const f = fixture();
    const session = await f.service.adapter.createSession("/chosen/repo");
    expect(f.execution.createSession).toHaveBeenCalledExactlyOnceWith("/chosen/repo");
    expect(session).toMatchObject({ id: "native-thread", engineType: "codex-desktop", directory: "/chosen/repo", engineMeta: { codexThreadId: "native-thread", desktopHostId: "local", codexDesktopOwner: "codemux" } });
    expect(f.followerClient.followThread).toHaveBeenCalledWith("native-thread", "codemux-owner");
    expect((await f.service.adapter.listSessions())[0].engineMeta?.codexDesktopOwner).toBe("codemux");
    expect((await f.service.adapter.getSession("native-thread"))?.engineMeta?.codexDesktopOwner).toBe("codemux");
    await f.service.stop();
    await f.service.stop();
    expect(f.execution.stop).toHaveBeenCalledOnce();
    expect(f.owners.size).toBe(0);
  });

  it("follows official-owned history without starting or stopping the private execution adapter", async () => {
    const f = fixture();
    f.foreignOwner("official-thread");
    const session = await f.service.adapter.restoreSession("official-thread", "/official/repo", { codexThreadId: "official-thread" });
    expect(session.engineMeta?.codexDesktopOwner).toBeUndefined();
    expect(f.execution.createSession).not.toHaveBeenCalled();
    expect(f.runtime.readThread).not.toHaveBeenCalled();
    expect(f.ownerClient.connect).not.toHaveBeenCalled();
    await f.service.stop();
    expect(f.execution.stop).not.toHaveBeenCalled();
    expect(f.followerClient.close).toHaveBeenCalledOnce();
  });

  it("restores only marked CodeMux threads and deduplicates concurrent restoration", async () => {
    const f = fixture();
    const meta = { codexThreadId: "native-thread", codexDesktopOwner: "codemux" };
    const [first, second] = await Promise.all([
      f.service.adapter.restoreSession("native-thread", "/saved/repo", meta),
      f.service.adapter.restoreSession("native-thread", "/saved/repo", meta),
    ]);
    expect(first.id).toBe("native-thread");
    expect(second.id).toBe(first.id);
    expect(f.execution.createSession).toHaveBeenCalledExactlyOnceWith("/saved/repo", meta);
    expect(f.followerClient.followThread).toHaveBeenCalledOnce();
    await f.service.stop();
  });

  it("follows a new foreign owner of a marked thread without resuming a competing runtime", async () => {
    const f = fixture();
    f.foreignOwner("native-thread");
    const session = await f.service.adapter.restoreSession("native-thread", "/saved/repo", { codexThreadId: "native-thread", codexDesktopOwner: "codemux" });
    expect(session.id).toBe("native-thread");
    expect(session.engineMeta?.codexDesktopOwner).toBe("codemux");
    expect(f.execution.createSession).not.toHaveBeenCalled();
    expect(f.ownerClient.registerOwnedThread).not.toHaveBeenCalled();
    expect(f.followerClient.followThread).toHaveBeenCalledWith("native-thread", "official-desktop");
    await f.service.stop();
  });

  it("does not create a replacement when a marked restoration fails", async () => {
    const f = fixture();
    f.execution.createSession.mockRejectedValueOnce(new Error("Original thread is missing"));
    await expect(f.service.adapter.restoreSession("native-thread", "/saved/repo", { codexThreadId: "native-thread", codexDesktopOwner: "codemux" })).rejects.toThrow("Original thread is missing");
    expect(f.execution.createSession).toHaveBeenCalledOnce();
    expect(f.ownerClient.registerOwnedThread).not.toHaveBeenCalled();
    expect(f.followerClient.followThread).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it("rejects an owner marker without the original thread id before creating native state", async () => {
    const f = fixture();
    await expect(f.service.adapter.createSession("/repo", { codexDesktopOwner: "codemux" })).rejects.toThrow("original Codex thread ID");
    expect(f.execution.createSession).not.toHaveBeenCalled();
    expect(f.ownerClient.connect).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it("renames its own native thread through the private runtime and confirms the shared state", async () => {
    const f = fixture();
    const session = await f.service.adapter.createSession("/chosen/repo");
    await f.service.adapter.renameSession(session.id, "Updated private title");
    expect(f.execution.renameSession).toHaveBeenCalledExactlyOnceWith("codex_native-thread", "Updated private title");
    expect((await f.service.adapter.getSession(session.id))?.title).toBe("Updated private title");
    expect(f.renameStoredThread).not.toHaveBeenCalled();
    expect(f.followerClient.notifyThreadMetadataAvailable).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it("writes a foreign title once and confirms the original owner's metadata snapshot without resuming it", async () => {
    const f = fixture();
    f.foreignOwner("official-thread");
    await f.service.adapter.attachThread("official-thread");
    await f.service.adapter.renameSession("official-thread", "  Updated official title  ");
    expect(f.renameStoredThread).toHaveBeenCalledExactlyOnceWith("official-thread", "Updated official title");
    expect(f.followerClient.notifyThreadMetadataAvailable).toHaveBeenCalledExactlyOnceWith("official-thread", "official-desktop");
    expect(f.followerClient.loadCompleteHistory).toHaveBeenCalledExactlyOnceWith("official-thread", "official-desktop");
    expect((await f.service.adapter.getSession("official-thread"))?.title).toBe("Updated official title");
    expect(f.execution.createSession).not.toHaveBeenCalled();
    expect(f.execution.renameSession).not.toHaveBeenCalled();
    expect(f.ownerClient.connect).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it("only repeats read requests while the foreign owner's metadata refresh is pending", async () => {
    const f = fixture();
    const state = f.foreignOwner("official-thread");
    await f.service.adapter.attachThread("official-thread");
    f.followerClient.notifyThreadMetadataAvailable.mockImplementation(() => {});
    const read = f.followerClient.loadCompleteHistory.getMockImplementation()!;
    f.followerClient.loadCompleteHistory.mockImplementation(async (id, owner) => {
      if (f.followerClient.loadCompleteHistory.mock.calls.length === 2) state.title = "Delayed title";
      return read(id, owner);
    });
    await f.service.adapter.renameSession("official-thread", "Delayed title");
    expect(f.followerClient.loadCompleteHistory).toHaveBeenCalledTimes(2);
    expect(f.renameStoredThread).toHaveBeenCalledOnce();
    expect(f.followerClient.notifyThreadMetadataAvailable).toHaveBeenCalledOnce();
    await f.service.stop();
  });

  it("does not write metadata when ownership changes after attachment", async () => {
    const f = fixture();
    f.foreignOwner("official-thread");
    await f.service.adapter.attachThread("official-thread");
    f.owners.get("official-thread")!.ownerClientId = "different-owner";
    await expect(f.service.adapter.renameSession("official-thread", "Blocked title")).rejects.toThrow("owner changed before");
    expect(f.renameStoredThread).not.toHaveBeenCalled();
    expect(f.followerClient.notifyThreadMetadataAvailable).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it("does not replay availability when the stored metadata write fails verification", async () => {
    const f = fixture();
    f.foreignOwner("official-thread");
    await f.service.adapter.attachThread("official-thread");
    f.renameStoredThread.mockRejectedValueOnce(new Error("The thread is archived"));
    await expect(f.service.adapter.renameSession("official-thread", "Blocked title")).rejects.toThrow("archived");
    expect(f.renameStoredThread).toHaveBeenCalledOnce();
    expect(f.followerClient.notifyThreadMetadataAvailable).not.toHaveBeenCalled();
    expect(f.followerClient.loadCompleteHistory).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it("reports a stored but unconfirmed title when the original owner changes during the write", async () => {
    const f = fixture();
    f.foreignOwner("official-thread");
    await f.service.adapter.attachThread("official-thread");
    f.renameStoredThread.mockImplementation(async () => { f.owners.get("official-thread")!.ownerClientId = "different-owner"; });
    await expect(f.service.adapter.renameSession("official-thread", "Unconfirmed title")).rejects.toThrow("stored, but its synchronization");
    expect(f.renameStoredThread).toHaveBeenCalledOnce();
    expect(f.followerClient.notifyThreadMetadataAvailable).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it("bounds snapshot confirmation and never retries the title write", async () => {
    const f = fixture({ syncTimeoutMs: 10 });
    f.foreignOwner("official-thread");
    await f.service.adapter.attachThread("official-thread");
    f.followerClient.notifyThreadMetadataAvailable.mockImplementation(() => {});
    await expect(f.service.adapter.renameSession("official-thread", "Unconfirmed title")).rejects.toThrow("stored, but its synchronization");
    expect(f.renameStoredThread).toHaveBeenCalledOnce();
    expect(f.followerClient.notifyThreadMetadataAvailable).toHaveBeenCalledOnce();
    expect((await f.service.adapter.getSession("official-thread"))?.title).toBe("Official task");
    await f.service.stop();
  });
});
