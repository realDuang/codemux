import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDesktopCatalog, type DesktopCatalogClient, type DesktopCatalogMethod } from "../../../../../electron/main/engines/codex/desktop-catalog";
const { verifyRollout } = vi.hoisted(() => ({ verifyRollout: vi.fn(async (_id: string, _metadata: Record<string, unknown>): Promise<"active" | "archived" | undefined> => undefined) }));
vi.mock("../../../../../electron/main/engines/codex/desktop-rollout-path", () => ({ verifyCodexRolloutPath: verifyRollout }));

interface Project {
  id: string; name: string; roots: Array<{ path: string }>; metadata: Record<string, string>;
  position: number; createdAt: number; updatedAt: number;
}
interface Thread {
  id: string; cwd: string; name: string; createdAt: number; updatedAt: number;
  projectId: string | null; archived: boolean; source: string; modelProvider: string; model: string;
  preview?: string;
}
function project(id: string, position = 0, createdAt = 900): Project {
  return { id, name: id, roots: [{ path: `/fixture/${id}` }], metadata: { preserved: "yes" }, position, createdAt, updatedAt: 1001 };
}
function thread(id: string, createdAt: number, projectId: string | null = null, archived = false): Thread {
  return { id, name: id, cwd: "/fixture", createdAt, updatedAt: 1001, projectId, archived, source: "vscode", modelProvider: "custom-provider", model: "custom-model" };
}
class Client implements DesktopCatalogClient {
  projects = [project("existing", 0), project("second", 1)];
  threads = [thread("old-unassigned", 900), thread("old-canonical", 900, "existing"), thread("future", 1001), thread("archived", 1002, null, true)];
  storedOnly = new Map<string, Thread>();
  admitThread = vi.fn();
  pageSize = 2;
  listeners = new Set<(method: string, params: unknown) => void>();
  disposed = false;
  subscribe = vi.fn((listener: (method: string, params: unknown) => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; });
  dispose = vi.fn(() => { this.disposed = true; });
  emit(method: string): void { for (const listener of this.listeners) listener(method, {}); }
  request = vi.fn(async (method: DesktopCatalogMethod, params: Record<string, unknown>): Promise<unknown> => {
    if (this.disposed) throw new Error("disposed");
    if (method === "project/list") return this.page([...this.projects].sort((left, right) => left.position - right.position), params.cursor);
    if (method === "thread/list") {
      let rows = this.threads.filter((thread) => thread.archived === params.archived);
      if (Object.hasOwn(params, "projectId")) rows = rows.filter((thread) => thread.projectId === params.projectId);
      if (!Array.isArray(params.sourceKinds)) rows = rows.filter((thread) => ["vscode", "cli", "appServer"].includes(thread.source));
      return this.page(rows, params.cursor);
    }
    if (method === "project/read") {
      const value = this.projects.find((project) => project.id === params.projectId);
      if (!value) throw new Error("project-not-found");
      return { project: structuredClone(value) };
    }
    if (method === "thread/read") {
      const value = this.threads.find((thread) => thread.id === params.threadId) ?? this.storedOnly.get(params.threadId as string);
      if (!value) throw new Error(`thread not loaded: ${params.threadId} (code: -32600)`);
      return { thread: structuredClone(value) };
    }
    if (method === "project/create") {
      const value: Project = { ...project("created", this.projects.length, 1001), name: params.name as string, roots: params.roots as Project["roots"], metadata: params.metadata as Project["metadata"] };
      this.projects.push(value);
      return { project: structuredClone(value) };
    }
    if (method === "project/update") {
      const value = this.projects.find((project) => project.id === params.projectId)!;
      if (typeof params.name === "string") value.name = params.name;
      if (Array.isArray(params.roots)) value.roots = params.roots as Project["roots"];
      if (params.metadata) value.metadata = params.metadata as Project["metadata"];
      return { project: structuredClone(value) };
    }
    if (method === "project/move") {
      const value = this.projects.find((project) => project.id === params.projectId)!;
      this.projects = this.projects.filter((project) => project !== value).sort((left, right) => left.position - right.position);
      const before = params.beforeProjectId == null ? this.projects.length : this.projects.findIndex((project) => project.id === params.beforeProjectId);
      this.projects.splice(before, 0, value);
      this.projects.forEach((project, index) => { project.position = index; });
      return {};
    }
    if (method === "project/delete") { this.projects = this.projects.filter((project) => project.id !== params.projectId); return {}; }
    if (method === "thread/metadata/update") {
      const value = this.threads.find((thread) => thread.id === params.threadId)!;
      value.projectId = params.projectId === "" ? null : params.projectId as string;
      return { thread: structuredClone(value) };
    }
    throw new Error("Unexpected method");
  });
  private page<T>(rows: T[], cursor: unknown): { data: T[]; nextCursor: string | null } {
    const offset = cursor == null ? 0 : Number(cursor);
    return { data: structuredClone(rows.slice(offset, offset + this.pageSize)), nextCursor: offset + this.pageSize < rows.length ? String(offset + this.pageSize) : null };
  }
}

const instances: CodexDesktopCatalog[] = [];
function catalog(client = new Client(), extra: Partial<ConstructorParameters<typeof CodexDesktopCatalog>[0]> = {}) {
  const service = new CodexDesktopCatalog({ sourceId: "stable-source", cutoffMs: 1_000_000, client, ...extra });
  instances.push(service);
  return { service, client };
}
afterEach(async () => { for (const service of instances.splice(0)) await service.stop(); vi.restoreAllMocks(); verifyRollout.mockReset(); });

describe("CodexDesktopCatalog.refresh", () => {
  it("paginates native projects and active threads without listing the archive index", async () => {
    const { service, client } = catalog();
    const snapshot = await service.refresh();
    expect(snapshot.sourceId).toBe("stable-source");
    expect(snapshot.complete).toBe(true);
    expect(snapshot.projects.map((project) => project.id)).toEqual(["existing", "second"]);
    expect(snapshot.projects[0]).toMatchObject({ roots: ["/fixture/existing"], order: 0 });
    expect(snapshot.sessions.map((session) => session.id)).toEqual(["future", "old-canonical"]);
    expect(snapshot.sessions.find((session) => session.id === "future")).toMatchObject({ projectId: null, modelId: "custom-model", time: { created: 1_001_000 }, archived: false });
    expect(snapshot.sessions.every((session) => session.activityStatus === undefined)).toBe(true);
    const listRequests = client.request.mock.calls.filter(([method]) => method === "thread/list");
    expect(listRequests.every(([, params]) => params.useStateDbOnly === true && Array.isArray(params.modelProviders) && params.modelProviders.length === 0)).toBe(true);
    expect(listRequests.every(([, params]) => !Object.hasOwn(params, "sourceKinds"))).toBe(true);
    expect(listRequests.every(([, params]) => params.archived === false)).toBe(true);
    expect(listRequests.some(([, params]) => params.cursor !== null)).toBe(true);
    expect(client.request.mock.calls.every(([method]) => !["thread/resume", "turn/start", "thread/start"].includes(method))).toBe(true);
    expect(client.admitThread).not.toHaveBeenCalledWith("archived");
  });

  it("keeps admitted conversations visible when their native project is cleared", async () => {
    const { service, client } = catalog();
    await service.refresh();
    client.threads.find((thread) => thread.id === "old-canonical")!.projectId = null;
    expect((await service.refresh()).sessions.find((session) => session.id === "old-canonical")?.projectId).toBeNull();
    const restored = catalog(new Client(), { previouslyAdmittedThreadIds: ["old-unassigned", "missing-id"] });
    const ids = (await restored.service.refresh()).sessions.map((session) => session.id);
    expect(ids).toContain("old-unassigned");
    expect(ids).not.toContain("missing-id");
  });

  it("supplements only persisted known IDs using metadata and a verified rollout path", async () => {
    const client = new Client();
    const empty = thread("known-empty", 900);
    client.storedOnly.set(empty.id, empty);
    client.storedOnly.set("foreign-empty", thread("foreign-empty", 1005));
    verifyRollout.mockResolvedValue("active");
    const { service } = catalog(client, { previouslyAdmittedThreadIds: [empty.id] });
    const snapshot = await service.refresh();
    expect(snapshot.sessions.find((session) => session.id === empty.id)).toMatchObject({ id: empty.id, archived: false });
    expect(snapshot.sessions.some((session) => session.id === "foreign-empty")).toBe(false);
    expect(client.admitThread).toHaveBeenCalledWith(empty.id);
    expect(client.request.mock.calls.filter(([method]) => method === "thread/read")).toEqual([["thread/read", { threadId: empty.id, includeTurns: false }]]);
    expect(verifyRollout).toHaveBeenCalledExactlyOnceWith(empty.id, empty);
  });

  it("omits archived persisted IDs while preserving known active empty conversations", async () => {
    const client = new Client();
    const active = thread("known-active-empty", 900);
    const archived = thread("known-archived-empty", 900);
    client.storedOnly.set(active.id, active);
    client.storedOnly.set(archived.id, archived);
    verifyRollout.mockImplementation(async (id) => id === active.id ? "active" : "archived");
    const { service } = catalog(client, { previouslyAdmittedThreadIds: [active.id, archived.id] });
    const listener = vi.fn();
    service.subscribe(listener);
    const snapshot = await service.refresh();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.sessions.find((session) => session.id === active.id)).toMatchObject({ archived: false });
    expect(snapshot.sessions.some((session) => session.id === archived.id)).toBe(false);
    expect(listener.mock.calls[0][0].sessions).toEqual(snapshot.sessions);
    expect(verifyRollout).toHaveBeenCalledWith(archived.id, archived);
    expect(client.request.mock.calls.every(([method, params]) => method !== "thread/list" || params.archived === false)).toBe(true);
  });

  it("removes newly archived active conversations from complete snapshots without native writes", async () => {
    const { service, client } = catalog();
    const listener = vi.fn();
    service.subscribe(listener);
    const before = await service.refresh();
    const future = client.threads.find((thread) => thread.id === "future")!;
    future.archived = true;
    const nativeBefore = structuredClone(client.threads);
    verifyRollout.mockResolvedValue("archived");
    const after = await service.refresh();
    expect(after.complete).toBe(true);
    expect(after.revision).not.toBe(before.revision);
    expect(after.sessions.map((session) => session.id)).toEqual(["old-canonical"]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1][0]).toEqual(after);
    expect(service.getSnapshot()).toEqual(after);
    expect(client.threads).toEqual(nativeBefore);
    expect(client.request.mock.calls.every(([method]) => ["project/list", "thread/list", "thread/read"].includes(method))).toBe(true);
  });

  it("admits a successful native creation once and omits it while its verified rollout is archived", async () => {
    const client = new Client();
    const empty = thread("created-empty", 1005);
    client.storedOnly.set(empty.id, empty);
    verifyRollout.mockResolvedValue("active");
    const { service } = catalog(client);
    await service.admitCreatedThread(empty.id);
    await service.admitCreatedThread(empty.id);
    expect(client.admitThread.mock.calls.filter(([id]) => id === empty.id)).toHaveLength(1);
    expect(service.getSnapshot()?.sessions.find((session) => session.id === empty.id)?.archived).toBe(false);
    verifyRollout.mockResolvedValue("archived");
    expect((await service.refresh()).sessions.some((session) => session.id === empty.id)).toBe(false);
    verifyRollout.mockResolvedValue("active");
    expect((await service.refresh()).sessions.find((session) => session.id === empty.id)?.archived).toBe(false);
    expect(client.request.mock.calls.every(([method]) => ["project/list", "thread/list", "thread/read"].includes(method))).toBe(true);
  });

  it("omits known missing or invalid rollouts without accepting metadata alone", async () => {
    const client = new Client();
    client.storedOnly.set("invalid-path", thread("invalid-path", 1005));
    const { service } = catalog(client, { previouslyAdmittedThreadIds: ["missing-id", "invalid-path"] });
    verifyRollout.mockResolvedValue(undefined);
    const snapshot = await service.refresh();
    expect(snapshot.sessions.some((session) => ["missing-id", "invalid-path"].includes(session.id))).toBe(false);
    expect(verifyRollout).toHaveBeenCalledExactlyOnceWith("invalid-path", client.storedOnly.get("invalid-path"));
  });

  it("preserves the last catalog on an ambiguous supplemental read failure", async () => {
    const { service, client } = catalog();
    const before = await service.refresh();
    client.threads = client.threads.filter((value) => value.id !== "future");
    const request = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) => {
      if (method === "thread/read") throw new Error("Native connection failed");
      return request(method, params);
    });
    await expect(service.refresh()).rejects.toThrow("Native connection failed");
    expect(service.getSnapshot()?.revision).toBe(before.revision);
  });

  it("bounds supplemental reads before making any per-thread request", async () => {
    const { service, client } = catalog(new Client(), { previouslyAdmittedThreadIds: Array.from({ length: 1001 }, (_, i) => `missing-${i}`) });
    await expect(service.refresh()).rejects.toThrow("supplemental read limit");
    expect(client.request.mock.calls.some(([method]) => method === "thread/read")).toBe(false);
  });

  it("uses a bounded preview only when the native name is empty", async () => {
    const { service, client } = catalog();
    const future = client.threads.find((thread) => thread.id === "future")!;
    future.name = " \t\n ";
    future.preview = "  First\n\tuseful   prompt\u0000text  ";
    expect((await service.refresh()).sessions.find((session) => session.id === "future")?.title).toBe("First useful prompt text");
    future.preview = "🐦".repeat(5000);
    const title = (await service.refresh()).sessions.find((session) => session.id === "future")?.title;
    expect(Array.from(title ?? "")).toHaveLength(120);
    expect(title).toBe(`${"🐦".repeat(119)}…`);
    future.name = " Explicit native name ";
    expect((await service.refresh()).sessions.find((session) => session.id === "future")?.title).toBe("Explicit native name");
    future.name = "";
    future.preview = " \n\t ";
    expect((await service.refresh()).sessions.find((session) => session.id === "future")?.title).toBeUndefined();
    expect(client.request.mock.calls.some(([method]) => method === "thread/metadata/update" || method === "project/update")).toBe(false);
  });

  it("publishes stable revisions only on changes and isolates subscriber copies", async () => {
    const { service, client } = catalog();
    const listener = vi.fn();
    service.subscribe(listener);
    const first = await service.refresh();
    const second = await service.refresh();
    expect(second.revision).toBe(first.revision);
    expect(listener).toHaveBeenCalledOnce();
    first.projects[0].name = "caller mutation";
    expect(service.getSnapshot()?.projects[0].name).toBe("existing");
    client.projects[0].name = "native rename";
    expect((await service.refresh()).revision).not.toBe(second.revision);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("rejects incomplete pagination without deleting the last good snapshot", async () => {
    const { service, client } = catalog();
    const first = await service.refresh();
    const original = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) => method === "thread/list" ? { data: [], nextCursor: "repeat" } : original(method, params));
    await expect(service.refresh()).rejects.toThrow("repeated cursor");
    expect(service.getSnapshot()?.revision).toBe(first.revision);
  });
});

describe("CodexDesktopCatalog project mutations", () => {
  it("creates, verifies, updates, and reorders native projects while preserving other metadata", async () => {
    const { service, client } = catalog();
    const created = await service.createProject({ name: "New", roots: ["/new", "/new", "/second"], idempotencyKey: "operation-id" });
    expect(created).toMatchObject({ id: "created", name: "New", roots: ["/new", "/second"] });
    expect(client.request).toHaveBeenCalledWith("project/create", { name: "New", roots: [{ path: "/new" }, { path: "/second" }], metadata: {}, idempotencyKey: "operation-id" });
    const updated = await service.updateProject("existing", { name: "Renamed", metadata: { added: "value" } });
    expect(updated.engineMeta?.nativeMetadata).toEqual({ preserved: "yes", added: "value" });
    await service.moveProject("created", "existing");
    expect(service.getSnapshot()?.projects.map((project) => project.id)).toEqual(["created", "existing", "second"]);
    await service.moveProject("created", null);
    expect(service.getSnapshot()?.projects.map((project) => project.id)).toEqual(["existing", "second", "created"]);
  });

  it("does not silently accept a write whose read-back values disagree", async () => {
    const { service, client } = catalog();
    const original = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) => method === "project/update" ? { project: structuredClone(client.projects[0]) } : original(method, params));
    await expect(service.updateProject("existing", { name: "not persisted" })).rejects.toThrow("not confirmed");
  });

  it("deletes only fresh empty projects and checks noninteractive archived members", async () => {
    const { service, client } = catalog();
    await expect(service.deleteProject("second")).rejects.toThrow("Pre-enable");
    await service.createProject({ name: "New", roots: [] });
    client.threads.push({ ...thread("hidden-member", 900, "created", true), source: "subAgent" });
    await expect(service.deleteProject("created")).rejects.toThrow("Move the project's conversations");
    expect(client.request.mock.calls.some(([method, params]) => method === "thread/list" && Array.isArray(params.sourceKinds) && params.sourceKinds.includes("subAgent") && params.archived === true)).toBe(true);
    expect(client.request.mock.calls.some(([method]) => method === "project/delete")).toBe(false);
    client.threads = client.threads.filter((thread) => thread.id !== "hidden-member");
    await service.deleteProject("created");
    expect(service.getSnapshot()?.projects.some((project) => project.id === "created")).toBe(false);
  });

  it("uses empty string to clear membership and refuses old unassigned threads", async () => {
    const { service, client } = catalog();
    await expect(service.assignThreadProject("old-unassigned", "existing")).rejects.toThrow("Only canonical or post-enable");
    expect(client.request.mock.calls.some(([method]) => method === "thread/metadata/update")).toBe(false);
    await service.assignThreadProject("future", "second");
    expect(client.request).toHaveBeenCalledWith("thread/metadata/update", { threadId: "future", projectId: "second" });
    const cleared = await service.assignThreadProject("old-canonical", null);
    expect(cleared.projectId).toBeNull();
    expect(client.request).toHaveBeenCalledWith("thread/metadata/update", { threadId: "old-canonical", projectId: "" });
  });
});

describe("CodexDesktopCatalog observation lifecycle", () => {
  it("coalesces refreshes and notices other clients through polling", async () => {
    const { service, client } = catalog(new Client(), { pollIntervalMs: 25 });
    const a = service.refresh();
    const b = service.refresh();
    expect(a).toBe(b);
    await a;
    await service.start();
    client.projects[0].name = "external update";
    await vi.waitFor(() => expect(service.getSnapshot()?.projects[0].name).toBe("external update"));
    await service.stop();
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(client.listeners.size).toBe(0);
  });

  it("refreshes immediately on native notifications", async () => {
    const { service, client } = catalog(new Client(), { pollIntervalMs: 60_000 });
    await service.start();
    client.projects[0].name = "notified update";
    client.emit("project/changed");
    await vi.waitFor(() => expect(service.getSnapshot()?.projects[0].name).toBe("notified update"));
  });

  it("stops before issuing another page or publishing a late snapshot", async () => {
    const { service, client } = catalog();
    const original = client.request.getMockImplementation()!;
    let release!: (value: unknown) => void;
    client.request.mockImplementation(async (method, params) => method === "thread/list" && params.archived === false
      ? new Promise((resolve) => { release = resolve; }) : original(method, params));
    const listener = vi.fn();
    service.subscribe(listener);
    const assertion = expect(service.refresh()).rejects.toThrow("stopped");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const stopping = service.stop();
    release({ data: [], nextCursor: "next-page" });
    await Promise.all([assertion, stopping]);
    expect(client.request.mock.calls.some(([, params]) => params.cursor === "next-page")).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    await expect(service.createProject({ name: "late", roots: [] })).rejects.toThrow("stopped");
  });
});
