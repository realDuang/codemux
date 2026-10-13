import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineAdapter } from "../../../../electron/main/engines/engine-adapter";
import { EngineManager } from "../../../../electron/main/gateway/engine-manager";
import { conversationStore } from "../../../../electron/main/services/conversation-store";
import { desktopMessageId } from "../../../../electron/main/engines/codex/desktop-state";
import type { CatalogProjectInput, CatalogProjectPatch, EngineCapabilities, EngineCatalogSnapshot, EngineInfo, UnifiedSession, UnifiedMessage } from "../../../../src/types/unified";

const environment = vi.hoisted(() => ({ directory: "" }));
vi.mock("../../../../electron/main/services/app-paths", () => ({ getConversationsPath: () => environment.directory }));
vi.mock("../../../../electron/main/services/default-workspace", () => ({ getDefaultWorkspacePath: () => "/default-workspace" }));
vi.mock("../../../../electron/main/services/logger", () => ({
  engineManagerLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  conversationStoreLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getDefaultEngineFromSettings: () => "catalog-engine",
}));

const session = (id = "native-thread"): UnifiedSession => ({
  id, engineType: "catalog-engine", title: "Native title", directory: "/actual/cwd", projectId: "native-project",
  time: { created: 100, updated: 200 }, modelId: "database-model",
});

class CatalogAdapter extends EngineAdapter {
  readonly engineType = "catalog-engine";
  snapshot: EngineCatalogSnapshot = {
    sourceId: "source-a", revision: "1", complete: true,
    projects: [{ id: "native-project", name: "Canonical", directory: "/root-a", roots: ["/root-a", "/root-b"], order: 0 }],
    sessions: [session()],
  };
  capabilities = { sessionCatalog: true, catalogManagement: true, authoritativeSessionState: true } as EngineCapabilities;
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  healthCheck = vi.fn(async () => true);
  getStatus = () => "running" as const;
  getInfo = (): EngineInfo => ({ type: this.engineType, name: "Catalog", status: "running", capabilities: this.capabilities });
  getCapabilities = () => this.capabilities;
  getAuthMethods = () => [];
  hasSession = vi.fn(() => false);
  listSessions = vi.fn(async () => []);
  getCatalog = vi.fn(async () => structuredClone(this.snapshot));
  createSession = vi.fn(async (directory: string, meta?: Record<string, unknown>): Promise<UnifiedSession> => ({
    ...session("created-thread"), directory, projectId: meta?.catalogProjectId as string | null,
  }));
  restoreSession = vi.fn(async (id: string) => {
    const found = this.snapshot.sessions.find((entry) => entry.id === id);
    if (!found) throw new Error("Owner unavailable");
    return structuredClone(found);
  });
  getSession = vi.fn(async (id: string) => structuredClone(this.snapshot.sessions.find((entry) => entry.id === id) ?? null));
  deleteSession = vi.fn(async () => {});
  sendMessage = vi.fn(async () => ({ id: "reply", sessionId: "native-thread", role: "assistant" as const, time: { created: 1 }, parts: [] }));
  cancelMessage = vi.fn(async () => {});
  listMessages = vi.fn(async (): Promise<UnifiedMessage[]> => []);
  getHistoricalMessages = vi.fn(async () => []);
  listModels = vi.fn(async () => ({ models: [] }));
  setModel = vi.fn(async () => {});
  getModes = () => [];
  setMode = vi.fn(async () => {});
  replyPermission = vi.fn(async () => {});
  replyQuestion = vi.fn(async () => {});
  rejectQuestion = vi.fn(async () => {});
  listProjects = vi.fn(async () => []);
  createProject = vi.fn(async (input: CatalogProjectInput) => {
    const project = { id: "created-project", ...input, directory: input.roots[0] ?? "", order: this.snapshot.projects.length };
    this.snapshot.projects.push(project);
    return structuredClone(project);
  });
  updateProject = vi.fn(async (id: string, patch: CatalogProjectPatch) => {
    const project = this.snapshot.projects.find((entry) => entry.id === id)!;
    Object.assign(project, patch);
    if (patch.roots) project.directory = patch.roots[0] ?? "";
    return structuredClone(project);
  });
  moveProject = vi.fn(async (id: string, beforeId: string | null) => {
    const project = this.snapshot.projects.find((entry) => entry.id === id)!;
    this.snapshot.projects = this.snapshot.projects.filter((entry) => entry.id !== id);
    const before = beforeId === null ? this.snapshot.projects.length : this.snapshot.projects.findIndex((entry) => entry.id === beforeId);
    this.snapshot.projects.splice(before, 0, project);
    this.snapshot.projects.forEach((entry, index) => { entry.order = index; });
  });
  deleteCatalogProject = vi.fn(async (id: string) => { this.snapshot.projects = this.snapshot.projects.filter((entry) => entry.id !== id); });
  setSessionProject = vi.fn(async (id: string, projectId: string | null) => {
    this.snapshot.sessions.find((entry) => entry.id === id)!.projectId = projectId;
  });
}

describe("EngineManager catalog integration", () => {
  let manager: EngineManager;
  let adapter: CatalogAdapter;

  beforeEach(() => {
    environment.directory = fs.mkdtempSync(path.join(os.tmpdir(), "codemux-catalog-manager-"));
    Object.assign(conversationStore, { initialized: false, index: new Map(), catalogs: new Map(), indexDirty: false, indexTimer: null, writeLocks: new Map() });
    conversationStore.init();
    manager = new EngineManager();
    adapter = new CatalogAdapter();
    manager.registerAdapter(adapter);
  });

  afterEach(async () => {
    await conversationStore.flushAll();
    fs.rmSync(environment.directory, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const publish = () => adapter.emit("catalog.updated", structuredClone(adapter.snapshot));

  const qualifiedMessage = (threadId: string, text: string, itemId = "item-1"): UnifiedMessage => {
    const id = desktopMessageId(threadId, "turn-1", itemId);
    return {
      id, sessionId: threadId, role: "assistant", time: { created: 100, completed: 200 },
      engineMeta: { codexThreadId: threadId, codexTurnId: "turn-1", codexItemId: itemId },
      parts: [
        { id: `${id}:text`, messageId: id, sessionId: threadId, type: "text", text },
        { id: `${id}:reasoning`, messageId: id, sessionId: threadId, type: "reasoning", text: "Reasoning" },
      ],
    };
  };

  const seedLegacyProjection = async (conversationId: string, text: string) => {
    await conversationStore.appendMessage(conversationId, {
      id: "item-1", role: "assistant", time: { created: 100, completed: 200 },
      parts: [{ id: "raw-text", messageId: "item-1", sessionId: conversationId, type: "text", text }],
    });
    await conversationStore.saveSteps(conversationId, "item-1", [
      { id: "raw-reasoning", messageId: "item-1", sessionId: conversationId, type: "reasoning", text: "Old steps" },
    ]);
  };

  const useRemovalPolicy = () => {
    adapter.capabilities = { ...adapter.capabilities, confirmedSessionRemoval: true, hideArchivedSessions: true };
    return vi.spyOn(adapter, "removeSession");
  };

  it("suppresses an empty local discard across stale catalogs, events, and restart", async () => {
    const remove = useRemovalPolicy().mockResolvedValue("local");
    publish();
    const conv = conversationStore.findByEngineSession("native-thread", adapter.engineType, "source-a")!;
    const removed = vi.fn();
    const updated = vi.fn();
    manager.on("session.removed", removed);
    manager.on("message.updated", updated);
    await manager.deleteSession(conv.id);
    expect(remove).toHaveBeenCalledWith("native-thread");
    expect(adapter.deleteSession).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledExactlyOnceWith({ sessionId: conv.id });
    publish();
    adapter.emit("message.updated", { sessionId: "native-thread", message: qualifiedMessage("native-thread", "Late") });
    expect(manager.listAllSessions()).toEqual([]);
    expect(manager.listCatalogs()[0].sessions).toEqual([]);
    expect(updated).not.toHaveBeenCalled();
    Object.assign(conversationStore, { initialized: false, index: new Map(), catalogs: new Map() });
    conversationStore.init();
    publish();
    expect(manager.listAllSessions()).toEqual([]);
    expect(conversationStore.isSessionSuppressed(adapter.engineType, "native-thread", "source-a")).toBe(true);
  });

  it("keeps the complete mirror when native archive confirmation fails", async () => {
    useRemovalPolicy().mockRejectedValue(new Error("Native archive failed"));
    publish();
    const conv = manager.listAllSessions()[0];
    await seedLegacyProjection(conv.id, "Kept content");
    await expect(manager.deleteSession(conv.id)).rejects.toThrow("Native archive failed");
    expect(manager.listAllSessions().map((entry) => entry.id)).toEqual([conv.id]);
    expect((await conversationStore.listMessages(conv.id))[0].parts[0]).toMatchObject({ text: "Kept content" });
    expect(await conversationStore.getSteps(conv.id, "item-1")).toHaveLength(1);
    expect(conversationStore.isSessionSuppressed(adapter.engineType, "native-thread", "source-a")).toBe(false);
  });

  it("purges confirmed archives and only restores them through a fresh explicit active import", async () => {
    useRemovalPolicy().mockResolvedValue("archived");
    publish();
    const conv = manager.listAllSessions()[0];
    await seedLegacyProjection(conv.id, "Archived content");
    await manager.deleteSession(conv.id);
    publish();
    expect(manager.listAllSessions()).toEqual([]);
    expect(await manager.listMessages(conv.id)).toEqual([]);
    expect(await manager.getMessageSteps(conv.id, "item-1")).toEqual([]);
    expect(fs.existsSync(path.join(environment.directory, `${conv.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(environment.directory, `${conv.id}.steps.json`))).toBe(false);
    adapter.snapshot.sessions[0].archived = false;
    adapter.getHistoricalMessages.mockResolvedValue([qualifiedMessage("native-thread", "Restored content")] as never);
    const created = vi.fn();
    manager.on("session.created", created);
    const result = await manager.importExecute(adapter.engineType, [{
      engineSessionId: "native-thread", directory: "/old", title: "Old", createdAt: 1, updatedAt: 2,
    }]);
    expect(result).toMatchObject({ imported: 1, errors: [] });
    expect(manager.listAllSessions()).toEqual([expect.objectContaining({ id: conv.id, title: "Native title" })]);
    expect(created).toHaveBeenCalledExactlyOnceWith({ session: expect.objectContaining({ id: conv.id }) });
  });

  it("prunes archived upgrade mirrors and rejects archived catalog and session metadata", async () => {
    useRemovalPolicy();
    publish();
    const conv = manager.listAllSessions()[0];
    await seedLegacyProjection(conv.id, "Old archived mirror");
    conversationStore.setArchived(conv.id, true);
    manager.initFromStore();
    expect(manager.listAllSessions()).toEqual([]);
    expect(await manager.listSessions(adapter.engineType)).toEqual([]);
    expect(await manager.getSession(conv.id)).toBeNull();
    expect(await manager.listMessages(conv.id)).toEqual([]);
    adapter.snapshot.sessions = [{ ...session("other-archived"), archived: true }];
    publish();
    const updates = vi.fn();
    manager.on("session.updated", updates);
    adapter.emit("session.updated", { session: { ...session("unmapped-archive"), archived: true } });
    expect(manager.listCatalogs()[0].sessions).toEqual([]);
    expect(updates).not.toHaveBeenCalled();
    await Promise.all([...(manager as any).sessionRemovals.values()]);
    expect(fs.existsSync(path.join(environment.directory, `${conv.id}.json`))).toBe(false);
  });

  it("does not return or persist an authoritative read that finishes after removal", async () => {
    useRemovalPolicy().mockResolvedValue("archived");
    publish();
    const conv = manager.listAllSessions()[0];
    adapter.hasSession.mockReturnValue(true);
    let finish!: (value: UnifiedMessage[]) => void;
    adapter.listMessages.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const reading = manager.listMessages(conv.id);
    await vi.waitFor(() => expect(adapter.listMessages).toHaveBeenCalled());
    await manager.deleteSession(conv.id);
    finish([qualifiedMessage("native-thread", "Late archived history")]);
    expect(await reading).toEqual([]);
    expect(await conversationStore.listMessages(conv.id)).toEqual([]);
  });

  it("maps native removal events to stable IDs and does not confuse ordinary unavailability with archive", async () => {
    useRemovalPolicy();
    publish();
    const conv = manager.listAllSessions()[0];
    adapter.emit("status.changed", { engineType: adapter.engineType, status: "error" });
    expect(manager.listAllSessions()).toHaveLength(1);
    const removed = vi.fn();
    manager.on("session.removed", removed);
    adapter.emit("session.removed", { sessionId: "native-thread" });
    expect(removed).toHaveBeenCalledExactlyOnceWith({ sessionId: conv.id });
    expect(manager.listAllSessions()).toEqual([]);
    publish();
    expect(manager.listAllSessions()).toEqual([]);
    await Promise.all([...(manager as any).sessionRemovals.values()]);
  });

  it("resolves legacy manual removal to the current trusted source and preserves another source", async () => {
    useRemovalPolicy().mockResolvedValue("local");
    const legacy = conversationStore.create({ engineType: adapter.engineType, directory: "/legacy" });
    conversationStore.setEngineSession(legacy.id, "native-thread");
    const foreign = conversationStore.create({ engineType: adapter.engineType, directory: "/foreign", catalogSourceId: "source-b" });
    conversationStore.setEngineSession(foreign.id, "native-thread");
    await manager.deleteSession(legacy.id);
    expect(conversationStore.get(foreign.id)).not.toBeNull();
    expect(conversationStore.isSessionSuppressed(adapter.engineType, "native-thread", "source-a")).toBe(true);
    expect(conversationStore.isSessionSuppressed(adapter.engineType, "native-thread", "source-b")).toBe(false);
    await expect(manager.deleteSession(foreign.id)).rejects.toThrow("different catalog source");
  });

  it("drops a stale in-flight catalog response after confirmed removal", async () => {
    useRemovalPolicy().mockResolvedValue("archived");
    publish();
    const conv = manager.listAllSessions()[0];
    const stale = structuredClone(adapter.snapshot);
    let finish!: (snapshot: EngineCatalogSnapshot) => void;
    adapter.getCatalog.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const refreshing = (manager as any).refreshCatalog(adapter);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await manager.deleteSession(conv.id);
    finish(stale);
    expect((await refreshing).sessions).toEqual([]);
    expect(manager.listAllSessions()).toEqual([]);
  });

  it("confirms omitted startup mirrors without exposing archive metadata or purging unavailable active rows", async () => {
    useRemovalPolicy();
    publish();
    const archived = manager.listAllSessions()[0];
    await seedLegacyProjection(archived.id, "Old mirror");
    const unavailable = conversationStore.create({ engineType: adapter.engineType, directory: "/unavailable", catalogSourceId: "source-a", catalogAvailable: true });
    conversationStore.setEngineSession(unavailable.id, "unavailable-thread");
    adapter.snapshot.sessions = [];
    adapter.getSession.mockImplementation(async (id) => {
      if (id === "native-thread") throw Object.assign(new Error("Archived"), { code: "CODEX_THREAD_ARCHIVED" });
      throw new Error("Storage temporarily unavailable");
    });
    const catalogs = vi.fn();
    manager.on("catalog.updated", catalogs);
    publish();
    expect(manager.listAllSessions()).toEqual([]);
    expect(catalogs.mock.calls[0][0].sessions).toEqual([]);
    await Promise.all([...(manager as any).catalogSessionChecks.values()]);
    expect(manager.listAllSessions().map((entry) => entry.id)).toEqual([unavailable.id]);
    expect(conversationStore.get(archived.id)).toBeNull();
    expect(await manager.listMessages(archived.id)).toEqual([]);
    expect(catalogs.mock.calls.flatMap(([catalog]) => catalog.sessions).some((entry) => entry.id === archived.id)).toBe(false);
  });

  it("replaces legacy raw-ID mirrors from complete qualified history without touching another conversation", async () => {
    adapter.snapshot.sessions = [session("thread-a"), session("thread-b")];
    publish();
    const a = conversationStore.findByEngineSession("thread-a", adapter.engineType, "source-a")!;
    const b = conversationStore.findByEngineSession("thread-b", adapter.engineType, "source-a")!;
    await seedLegacyProjection(a.id, "A legacy");
    await seedLegacyProjection(b.id, "B legacy");
    const snapshots = [qualifiedMessage("thread-a", "A complete"), qualifiedMessage("thread-b", "B complete")];
    const original = JSON.stringify(snapshots);
    adapter.listMessages.mockImplementation(async (id) => snapshots.filter((message) => message.sessionId === id));
    const foreignBuffer = [{ id: "foreign", messageId: "item-1", sessionId: b.id, type: "reasoning", text: "Other live buffer" }];
    (manager as any).stepPartsBuffer.set("item-1", foreignBuffer);
    (manager as any).messageConvMap.set("item-1", b.id);

    const first = await manager.listMessages(a.id);
    expect((await conversationStore.listMessages(a.id)).map((message) => message.id)).toEqual([snapshots[0].id]);
    expect(await conversationStore.getSteps(a.id, "item-1")).toEqual([]);
    expect(await conversationStore.getSteps(a.id, snapshots[0].id)).toEqual([expect.objectContaining({ messageId: snapshots[0].id, sessionId: a.id })]);
    expect((await conversationStore.listMessages(b.id)).map((message) => message.id)).toEqual(["item-1"]);
    expect((manager as any).stepPartsBuffer.get("item-1")).toBe(foreignBuffer);
    expect((manager as any).messageConvMap.get("item-1")).toBe(b.id);

    const second = await manager.listMessages(b.id);
    expect(first[0].id).not.toBe(second[0].id);
    expect(first[0].parts[0].id).not.toBe(second[0].parts[0].id);
    expect((await conversationStore.listMessages(b.id)).map((message) => message.id)).toEqual([snapshots[1].id]);
    expect(JSON.stringify(snapshots)).toBe(original);
  });

  it("replays newer updates and removals after an in-flight complete mirror replacement", async () => {
    publish();
    const conversationId = manager.listAllSessions()[0].id;
    const old = qualifiedMessage("native-thread", "Snapshot value");
    const newer = qualifiedMessage("native-thread", "New event", "item-2");
    let finish!: (messages: UnifiedMessage[]) => void;
    adapter.listMessages.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const loading = manager.listMessages(conversationId);
    await vi.waitFor(() => expect(adapter.listMessages).toHaveBeenCalledOnce());
    adapter.emit("message.updated", { sessionId: "native-thread", message: newer });
    adapter.emit("message.removed", { sessionId: "native-thread", messageId: old.id });
    finish([old]);
    await loading;
    await (manager as any).authoritativeMessageWrites.get(conversationId);
    expect((await conversationStore.listMessages(conversationId)).map((message) => message.id)).toEqual([newer.id]);
    expect(await conversationStore.getSteps(conversationId, old.id)).toEqual([]);
    expect(await conversationStore.getSteps(conversationId, newer.id)).toHaveLength(1);
  });

  it("scopes disconnected legacy fallback IDs and resolves its local steps without native access", async () => {
    adapter.snapshot.sessions = [session("thread-a"), session("thread-b")];
    publish();
    const [a, b] = conversationStore.list();
    await seedLegacyProjection(a.id, "A cached");
    await seedLegacyProjection(b.id, "B cached");
    conversationStore.markCatalogUnavailable(adapter.engineType, "source-a");
    const first = await manager.listMessages(a.id);
    const second = await manager.listMessages(b.id);
    expect(first[0].id).not.toBe(second[0].id);
    expect(first[0].parts[0].id).not.toBe(second[0].parts[0].id);
    expect(first[0].parts[0].messageId).toBe(first[0].id);
    expect(await manager.getMessageSteps(a.id, first[0].id)).toEqual([
      expect.objectContaining({ messageId: first[0].id, sessionId: a.id, text: "Old steps" }),
    ]);
    expect(adapter.listMessages).not.toHaveBeenCalled();
    expect(adapter.restoreSession).not.toHaveBeenCalled();
    expect((await conversationStore.listMessages(a.id))[0].id).toBe("item-1");
  });

  it("rejects local deletion of a managed catalog conversation without dropping its stable identity", async () => {
    publish();
    const conversationId = manager.listAllSessions()[0].id;
    await expect(manager.deleteSession(conversationId)).rejects.toThrow("archived through their owner");
    expect(conversationStore.get(conversationId)?.engineSessionId).toBe("native-thread");
    expect(adapter.deleteSession).not.toHaveBeenCalled();
    publish();
    expect(manager.listAllSessions()[0].id).toBe(conversationId);
  });

  it("synchronizes startup metadata without loading messages or restoring historical runtimes", async () => {
    adapter.emit("status.changed", { engineType: adapter.engineType, status: "running" });
    await vi.waitFor(() => expect(manager.listCatalogs()).toHaveLength(1));
    const [catalog] = manager.listCatalogs();
    expect(catalog.sessions[0].id).not.toBe("native-thread");
    expect(catalog.sessions[0].projectId).toBe(catalog.projects[0].id);
    expect(catalog.sessions[0].directory).toBe("/actual/cwd");
    expect(catalog.projects[0].roots).toEqual(["/root-a", "/root-b"]);
    expect(adapter.restoreSession).not.toHaveBeenCalled();
    expect(adapter.listMessages).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it("keeps a newer catalog event when an earlier initial read finishes late", async () => {
    let finish!: (snapshot: EngineCatalogSnapshot) => void;
    adapter.getCatalog.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    adapter.emit("status.changed", { engineType: adapter.engineType, status: "running" });
    await vi.waitFor(() => expect(adapter.getCatalog).toHaveBeenCalled());
    const old = structuredClone(adapter.snapshot);
    adapter.snapshot.projects[0].name = "Newest";
    adapter.snapshot.revision = "2";
    publish();
    finish(old);
    await vi.waitFor(() => expect((manager as any).catalogRefreshes.size).toBe(0));
    expect(manager.listCatalogs()[0].projects[0].name).toBe("Newest");
  });

  it("protects owner-confirmed runtime settings and activity from catalog database lag", () => {
    publish();
    adapter.hasSession.mockReturnValue(true);
    adapter.emit("session.updated", { session: {
      id: "native-thread", engineType: adapter.engineType, modelId: "live-model", reasoningEffort: "ultra", activityStatus: "running",
    } });
    adapter.snapshot.sessions[0].reasoningEffort = "low";
    adapter.snapshot.sessions[0].activityStatus = "idle";
    publish();
    expect(manager.listAllSessions()[0]).toMatchObject({ modelId: "live-model", reasoningEffort: "ultra", activityStatus: "running" });
    expect(conversationStore.list()[0].modelId).toBe("live-model");
  });

  it("protects the first attach snapshot before the adapter marks its owner available", async () => {
    publish();
    const conversationId = manager.listAllSessions()[0].id;
    const initial = { ...session(), modelId: "initial-owner-model", reasoningEffort: "ultra" as const, activityStatus: "idle" as const };
    adapter.restoreSession.mockImplementationOnce(async () => {
      adapter.emit("session.updated", { session: initial });
      publish();
      expect(manager.listAllSessions()[0].modelId).toBe("initial-owner-model");
      adapter.hasSession.mockReturnValue(true);
      return initial;
    });
    await manager.listMessages(conversationId);
    publish();
    expect(manager.listAllSessions()[0]).toMatchObject({ modelId: "initial-owner-model", reasoningEffort: "ultra" });
  });

  it("lets catalog metadata replace protected fields after the owner disconnects", () => {
    publish();
    adapter.hasSession.mockReturnValue(true);
    adapter.emit("session.updated", { session: { ...session(), modelId: "old-owner-model", activityStatus: "running" } });
    adapter.hasSession.mockReturnValue(false);
    adapter.emit("session.updated", { session: { ...session(), modelId: "old-owner-model", activityStatus: "error" } });
    adapter.snapshot.sessions[0].modelId = "current-metadata-model";
    publish();
    expect(manager.listAllSessions()[0]).toMatchObject({ modelId: "current-metadata-model", activityStatus: "idle" });
  });

  it("forces archived catalog sessions idle even before a stale owner is detached", () => {
    publish();
    adapter.hasSession.mockReturnValue(true);
    adapter.emit("session.updated", { session: { ...session(), modelId: "owner-model", activityStatus: "waiting" } });
    adapter.snapshot.sessions[0].archived = true;
    publish();
    expect(manager.listAllSessions()[0]).toMatchObject({ archived: true, activityStatus: "idle", modelId: "database-model" });
    expect(manager.listCatalogs()[0].sessions[0].activityStatus).toBe("idle");
  });

  it("does not promote stored read fallback fields into lasting live-owner overrides", async () => {
    publish();
    const conversationId = manager.listAllSessions()[0].id;
    const stored = { ...session(), modelId: "stored-fallback", activityStatus: "error" as const };
    adapter.restoreSession.mockResolvedValueOnce(stored);
    adapter.getSession.mockResolvedValueOnce(stored);
    expect(await manager.getSession(conversationId)).toMatchObject({ modelId: "stored-fallback", activityStatus: "error" });
    adapter.snapshot.sessions[0].modelId = "fresh-catalog-model";
    publish();
    expect(manager.listAllSessions()[0]).toMatchObject({ modelId: "fresh-catalog-model", activityStatus: "idle" });
  });

  it("creates, updates, and reorders canonical projects without changing session cwd", async () => {
    publish();
    const original = manager.listCatalogs()[0].projects[0];
    const created = await manager.createProject("source-a", { name: "Empty", roots: [] });
    expect(created).toMatchObject({ name: "Empty", roots: [], catalogProjectId: "created-project" });
    const updated = await manager.updateProject(created.id, { name: "Renamed", roots: ["/new-root", "/another-root"] });
    expect(updated.roots).toEqual(["/new-root", "/another-root"]);
    await manager.reorderProjects("source-a", [created.id, original.id]);
    expect(manager.listCatalogs()[0].projects.map((entry) => entry.id)).toEqual([created.id, original.id]);
    expect(manager.listAllSessions()[0].directory).toBe("/actual/cwd");
  });

  it("moves a session by native project identity and refuses deletion until a project is empty", async () => {
    publish();
    const [catalog] = manager.listCatalogs();
    const conversationId = catalog.sessions[0].id;
    await expect(manager.deleteProject(catalog.projects[0].id)).rejects.toThrow("empty");
    expect(adapter.deleteCatalogProject).not.toHaveBeenCalled();
    await manager.setSessionProject(conversationId, null);
    expect(adapter.setSessionProject).toHaveBeenCalledWith("native-thread", null);
    expect(manager.listAllSessions()[0]).toMatchObject({ id: conversationId, projectId: null, directory: "/actual/cwd" });
    await manager.deleteProject(catalog.projects[0].id);
    expect(manager.listCatalogs()[0].projects[0].catalogAvailable).toBe(false);
    expect(conversationStore.get(conversationId)).not.toBeNull();
    expect(adapter.deleteSession).not.toHaveBeenCalled();
  });

  it("rejects writes to a previous profile source before routing its native IDs", async () => {
    publish();
    const previous = manager.listCatalogs()[0];
    adapter.snapshot.sourceId = "source-b";
    await expect(manager.updateProject(previous.projects[0].id, { name: "Unsafe" })).rejects.toThrow("source");
    expect(adapter.updateProject).not.toHaveBeenCalled();
    expect(conversationStore.get(previous.sessions[0].id)?.catalogAvailable).toBe(false);
    const current = manager.listCatalogs().find((catalog) => catalog.sourceId === "source-b")!;
    const received = vi.fn();
    manager.on("session.updated", received);
    adapter.emit("session.updated", { session: { id: "native-thread", engineType: adapter.engineType, title: "Current source" } });
    expect(received.mock.calls[0][0].session.id).toBe(current.sessions[0].id);
    expect(current.sessions[0].id).not.toBe(previous.sessions[0].id);
  });

  it("passes canonical project metadata when creating a pending native conversation", async () => {
    publish();
    const project = manager.listCatalogs()[0].projects[0];
    const created = await manager.createSession(adapter.engineType, "/chosen/cwd", undefined, project.id);
    expect(adapter.createSession).toHaveBeenCalledWith("/chosen/cwd", { catalogSourceId: "source-a", catalogProjectId: "native-project" });
    expect(created).toMatchObject({ projectId: project.id, directory: "/chosen/cwd", catalogSourceId: "source-a" });
    expect(conversationStore.get(created.id)?.catalogAvailable).toBeUndefined();
    publish();
    expect(conversationStore.get(created.id)?.catalogAvailable).toBeUndefined();
    expect(conversationStore.get(created.id)?.engineSessionId).toBe("created-thread");
  });

  it("reuses the catalog identity when discovery arrives before native creation resolves", async () => {
    publish();
    const project = manager.listCatalogs()[0].projects[0];
    let finish!: (value: UnifiedSession) => void;
    adapter.createSession.mockReturnValueOnce(new Promise<UnifiedSession>((resolve) => { finish = resolve; }));
    const creating = manager.createSession(adapter.engineType, "/chosen/cwd", undefined, project.id);
    await vi.waitFor(() => expect(adapter.createSession).toHaveBeenCalledOnce());
    const native = { ...session("created-thread"), directory: "/chosen/cwd" };
    adapter.snapshot.sessions.push(native);
    publish();
    const discovered = conversationStore.findByEngineSession(native.id, adapter.engineType, "source-a")!;
    await conversationStore.appendMessage(discovered.id, { id: "early-message", role: "user", time: { created: 300 }, parts: [] });

    finish(native);
    const created = await creating;
    expect(created.id).toBe(discovered.id);
    publish();
    const rows = conversationStore.list().filter((entry) => entry.engineSessionId === native.id && entry.catalogSourceId === "source-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: created.id, catalogAvailable: true, messageCount: 1 });
    expect((await conversationStore.listMessages(created.id)).map((message) => message.id)).toEqual(["early-message"]);
    const received = vi.fn();
    manager.on("message.queued", received);
    adapter.emit("message.queued", { sessionId: native.id, messageId: "next-message", queuePosition: 0 });
    expect(received.mock.calls[0][0].sessionId).toBe(created.id);
  });

  it("never creates a replacement when an explicitly selected catalog owner is unavailable", async () => {
    publish();
    const conversationId = manager.listAllSessions()[0].id;
    adapter.restoreSession.mockRejectedValueOnce(new Error("Owner unavailable"));
    await expect(manager.listMessages(conversationId)).rejects.toThrow("Owner unavailable");
    expect(adapter.createSession).not.toHaveBeenCalled();
    expect(conversationStore.get(conversationId)?.engineSessionId).toBe("native-thread");
  });

  it("keeps metadata unchanged on failed project writes and refuses excluded manual sessions", async () => {
    publish();
    const before = manager.listCatalogs()[0].projects[0];
    adapter.updateProject.mockRejectedValueOnce(new Error("Denied"));
    await expect(manager.updateProject(before.id, { name: "Not saved" })).rejects.toThrow("Denied");
    expect(manager.listCatalogs()[0].projects[0].name).toBe(before.name);
    const manual = conversationStore.create({ engineType: adapter.engineType, directory: "/old-manual" });
    conversationStore.setEngineSession(manual.id, "excluded-old-thread");
    await expect(manager.setSessionProject(manual.id, before.id)).rejects.toThrow("managed catalog");
    expect(adapter.setSessionProject).not.toHaveBeenCalled();
  });

  it("clears scoped routing caches when a legacy conversation is removed and imported again", async () => {
    adapter.capabilities = {} as EngineCapabilities;
    const old = conversationStore.create({ engineType: adapter.engineType, directory: "/legacy" });
    conversationStore.setEngineSession(old.id, "legacy-thread");
    const received = vi.fn();
    manager.on("message.queued", received);
    adapter.emit("message.queued", { sessionId: "legacy-thread", messageId: "queued-1", queuePosition: 0 });
    expect(received.mock.calls[0][0].sessionId).toBe(old.id);
    await manager.deleteSession(old.id);
    const replacement = conversationStore.create({ engineType: adapter.engineType, directory: "/legacy" });
    conversationStore.setEngineSession(replacement.id, "legacy-thread");
    adapter.emit("message.queued", { sessionId: "legacy-thread", messageId: "queued-2", queuePosition: 0 });
    expect(received.mock.calls[1][0].sessionId).toBe(replacement.id);
  });
});
