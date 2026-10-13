import { createHash, randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import type { UnifiedProject, UnifiedSession } from "../../../../src/types/unified";
import { fromCodexEffort } from "./config";
import { verifyCodexRolloutPath } from "./desktop-rollout-path";

export const DESKTOP_CATALOG_METHODS = [
  "project/list", "project/read", "project/create", "project/update", "project/move", "project/delete",
  "thread/list", "thread/read", "thread/metadata/update",
] as const;
export type DesktopCatalogMethod = typeof DESKTOP_CATALOG_METHODS[number];
export interface DesktopCatalogClient {
  request(method: DesktopCatalogMethod, params: Record<string, unknown>): Promise<unknown>;
  /** Grants a scoped path fallback only for IDs admitted by this catalog. */
  admitThread?(threadId: string): void;
  subscribe?(listener: (method: string, params: unknown) => void): () => void;
  /** Retires this facade only, never the shared Codex process. */
  dispose?(): void;
}
export interface DesktopCatalogSnapshot {
  sourceId: string;
  revision: string;
  complete: boolean;
  projects: UnifiedProject[];
  sessions: UnifiedSession[];
}
export interface DesktopCatalogProjectInput {
  name: string;
  roots: string[];
  metadata?: Record<string, string>;
  /** Reuse the same key when explicitly retrying a creation with unknown outcome. */
  idempotencyKey?: string;
}
export interface DesktopCatalogProjectPatch {
  name?: string;
  roots?: string[];
  /** Added to the existing metadata map; unrelated native keys are preserved. */
  metadata?: Record<string, string>;
}
export interface DesktopCatalogOptions {
  sourceId: string;
  /** Persist once on first enable, rounded to native Unix-second precision. */
  cutoffMs: number;
  client: DesktopCatalogClient;
  pollIntervalMs?: number;
  /** Only IDs from this source's persisted canonical catalog records. */
  previouslyAdmittedThreadIds?: string[];
  onError?: (error: Error) => void;
}
interface NativeProject {
  id: string;
  name: string;
  roots: Array<{ path: string }>;
  metadata: Record<string, string>;
  position: number;
  createdAt: number;
  updatedAt: number;
}
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const MAX_SUPPLEMENTAL_READS = 1000;
const PREVIEW_TITLE_LIMIT = 120;
const ALL_THREAD_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];
export const DESKTOP_CATALOG_NOTIFICATION_METHODS = new Set([
  "project/changed", "thread/project/updated", "thread/started", "thread/name/updated",
  "thread/archived", "thread/unarchived", "thread/deleted", "thread/settings/updated",
]);

/**
 * Canonical metadata only: no legacy-state overlay, thread resume, or execution.
 * Polling covers writes made by another app-server; local notifications accelerate
 * refreshes but are not assumed to provide cross-process delivery guarantees.
 */
export class CodexDesktopCatalog {
  private readonly sourceId: string;
  private readonly cutoffMs: number;
  private readonly client: DesktopCatalogClient;
  private readonly pollIntervalMs: number;
  private readonly listeners = new Set<(snapshot: DesktopCatalogSnapshot) => void>();
  private readonly admitted = new Set<string>();
  private current?: DesktopCatalogSnapshot;
  private refreshing?: Promise<DesktopCatalogSnapshot>;
  private mutationTail: Promise<unknown> = Promise.resolve();
  private stopping?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private started = false;
  private stopped = false;
  private dirty = false;

  constructor(private readonly options: DesktopCatalogOptions) {
    if (!options.sourceId.trim()) throw new Error("A stable Codex catalog source ID is required");
    if (!Number.isSafeInteger(options.cutoffMs) || options.cutoffMs <= 0 || options.cutoffMs % 1000 !== 0) {
      throw new Error("The first-enable cutoff must be a positive Unix-second-aligned timestamp in milliseconds");
    }
    this.sourceId = options.sourceId;
    this.cutoffMs = options.cutoffMs;
    this.client = options.client;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    for (const id of options.previouslyAdmittedThreadIds ?? []) if (typeof id === "string" && id.trim()) this.admitThread(id);
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs < 25) throw new Error("Invalid catalog polling interval");
  }

  async start(): Promise<void> {
    this.assertRunning();
    if (!this.started) {
      this.started = true;
      this.unsubscribe = this.client.subscribe?.((method) => {
        if (!DESKTOP_CATALOG_NOTIFICATION_METHODS.has(method) || this.stopped) return;
        this.dirty = true;
        this.schedule(0);
      });
    }
    try { await this.refresh(); }
    finally { this.schedule(this.dirty ? 0 : this.pollIntervalMs); }
  }

  /** Stops metadata observation only; the caller owns the shared native client. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.client.dispose?.();
    this.listeners.clear();
    this.stopping = Promise.allSettled([this.refreshing, this.mutationTail]).then(() => {});
    return this.stopping;
  }

  getSnapshot(): DesktopCatalogSnapshot | undefined { return this.current ? structuredClone(this.current) : undefined; }

  subscribe(listener: (snapshot: DesktopCatalogSnapshot) => void): () => void {
    this.assertRunning();
    this.listeners.add(listener);
    if (this.current) listener(structuredClone(this.current));
    return () => { this.listeners.delete(listener); };
  }

  refresh(): Promise<DesktopCatalogSnapshot> {
    this.assertRunning();
    if (this.refreshing) return this.refreshing;
    this.dirty = false;
    const operation = this.readSnapshot().finally(() => {
      if (this.refreshing === operation) this.refreshing = undefined;
    });
    this.refreshing = operation;
    return operation;
  }

  /** Called only after the private native runtime has created this exact ID. */
  async admitCreatedThread(threadId: string): Promise<void> {
    this.assertRunning();
    this.admitThread(requiredString(threadId, "created thread ID"));
    try { await this.freshAfterWrite(); }
    catch (error) {
      this.assertRunning();
      // Creation already succeeded. Keep its trusted ID for the next poll
      // without fabricating a row while metadata or its rollout is unavailable.
      this.reportError(error);
      this.dirty = true;
      this.schedule(0);
    }
  }

  private admitThread(threadId: string): void {
    if (this.admitted.has(threadId)) return;
    this.client.admitThread?.(threadId);
    this.admitted.add(threadId);
  }

  createProject(input: DesktopCatalogProjectInput): Promise<UnifiedProject> {
    return this.mutate(async () => {
      const name = projectName(input.name);
      const roots = projectRoots(input.roots);
      const metadata = stringMap(input.metadata ?? {});
      const idempotencyKey = input.idempotencyKey ?? randomUUID();
      if (!idempotencyKey.trim()) throw new Error("A project creation idempotency key is required");
      const response = object(await this.request("project/create", { name, roots, metadata, idempotencyKey }));
      const created = nativeProject(response.project);
      const snapshot = await this.freshAfterWrite();
      const result = requireProject(snapshot, created.id);
      assertProjectValues(result, { name, roots: roots.map((root) => root.path), metadata });
      return result;
    });
  }

  updateProject(projectId: string, patch: DesktopCatalogProjectPatch): Promise<UnifiedProject> {
    return this.mutate(async () => {
      const before = await this.readProject(projectId);
      const name = patch.name === undefined ? undefined : projectName(patch.name);
      const roots = patch.roots === undefined ? undefined : projectRoots(patch.roots);
      const metadata = patch.metadata === undefined ? undefined : Object.fromEntries([
        ...Object.entries(before.metadata), ...Object.entries(stringMap(patch.metadata)),
      ]);
      const response = object(await this.request("project/update", {
        projectId, ...(name !== undefined ? { name } : {}), ...(roots !== undefined ? { roots } : {}), ...(metadata !== undefined ? { metadata } : {}),
      }));
      if (nativeProject(response.project).id !== projectId) throw new Error("Native project update returned a different project");
      const result = requireProject(await this.freshAfterWrite(), projectId);
      assertProjectValues(result, { name, roots: roots?.map((root) => root.path), metadata });
      return result;
    });
  }

  moveProject(projectId: string, beforeProjectId: string | null): Promise<void> {
    return this.mutate(async () => {
      const before = await this.refresh();
      requireProject(before, projectId);
      if (beforeProjectId === projectId) throw new Error("A project cannot be moved before itself");
      if (beforeProjectId !== null) requireProject(before, beforeProjectId);
      await this.request("project/move", { projectId, beforeProjectId });
      const projects = (await this.freshAfterWrite()).projects;
      const index = projects.findIndex((project) => project.id === projectId);
      if (index < 0 || (beforeProjectId === null ? index !== projects.length - 1 : projects[index + 1]?.id !== beforeProjectId)) {
        throw new Error("The requested native project order was not confirmed");
      }
    });
  }

  /** Deleting a nonempty project would silently clear native thread assignments. */
  deleteProject(projectId: string): Promise<void> {
    return this.mutate(async () => {
      requireProject(await this.refresh(), projectId);
      const project = await this.readProject(projectId);
      if (project.createdAt * 1000 < this.cutoffMs) throw new Error("Pre-enable project definitions are protected from deletion");
      for (const archived of [false, true]) {
        const members = await this.pages("thread/list", { archived, modelProviders: [], sourceKinds: ALL_THREAD_SOURCE_KINDS, useStateDbOnly: true, projectId });
        if (members.length > 0) throw new Error("Move the project's conversations before deleting the project");
      }
      await this.request("project/delete", { projectId });
      if ((await this.freshAfterWrite()).projects.some((project) => project.id === projectId)) throw new Error("Native project deletion was not confirmed");
    });
  }

  assignThreadProject(threadId: string, projectId: string | null): Promise<UnifiedSession> {
    return this.mutate(async () => {
      const response = object(await this.request("thread/read", { threadId, includeTurns: false }));
      const before = object(response.thread);
      if (before.id !== threadId || !this.eligible(before)) throw new Error("Only canonical or post-enable conversations may be reclassified");
      this.admitted.add(threadId);
      if (projectId !== null) await this.readProject(projectId);
      const updated = object(await this.request("thread/metadata/update", { threadId, projectId: projectId ?? "" }));
      const thread = object(updated.thread);
      if (thread.id !== threadId || thread.projectId !== projectId) throw new Error("Native thread project assignment was not confirmed");
      const snapshot = await this.freshAfterWrite();
      const result = snapshot.sessions.find((session) => session.id === threadId);
      if (!result || result.projectId !== projectId) throw new Error("The updated thread classification has not synchronized");
      return result;
    });
  }

  private async readProject(projectId: string): Promise<NativeProject> {
    if (!projectId.trim()) throw new Error("A native project ID is required");
    const project = nativeProject(object(await this.request("project/read", { projectId })).project);
    if (project.id !== projectId) throw new Error("Native project read returned a different project");
    return project;
  }

  private eligible(thread: Record<string, unknown>): boolean {
    if (typeof thread.id === "string" && this.admitted.has(thread.id)) return true;
    if (typeof thread.projectId === "string" && thread.projectId.length > 0) return true;
    return secondsToMs(thread.createdAt) >= this.cutoffMs;
  }

  private async readSnapshot(): Promise<DesktopCatalogSnapshot> {
    const [projectRows, active] = await Promise.all([
      this.pages("project/list", { sortKey: "position", sortDirection: "asc" }),
      this.pages("thread/list", { archived: false, modelProviders: [], useStateDbOnly: true, sortKey: "created_at" }),
    ]);
    this.assertRunning();
    const projects = projectRows.map((row) => this.projectView(nativeProject(row)));
    if (new Set(projects.map((project) => project.id)).size !== projects.length) throw new Error("Native catalog returned duplicate project IDs");
    const byId = new Map<string, UnifiedSession>();
    for (const value of active) {
      const row = object(value);
      if (row.archived === true || !this.eligible(row)) continue;
      const session = this.sessionView(row);
      const previous = byId.get(session.id);
      if (!previous || previous.time.updated <= session.time.updated) byId.set(session.id, session);
    }
    // Native thread/list omits empty rollouts. Inspect only known IDs, never
    // enumerate files or discover unrelated blank conversations from disk.
    const missing = [...this.admitted].filter((id) => !byId.has(id));
    if (missing.length > MAX_SUPPLEMENTAL_READS) throw new Error("Native catalog exceeded its supplemental read limit");
    for (let offset = 0; offset < missing.length; offset += 4) {
      const supplemental = await Promise.all(missing.slice(offset, offset + 4).map(async (id) => {
        let response: Record<string, unknown>;
        try { response = object(await this.request("thread/read", { threadId: id, includeTurns: false })); }
        catch (error) {
          if (error instanceof Error && error.message === `thread not loaded: ${id} (code: -32600)`) return undefined;
          throw error;
        }
        const metadata = object(response.thread);
        const availability = await verifyCodexRolloutPath(id, metadata);
        // An archived known ID is omitted from the authoritative snapshot, so
        // clients remove its mirror without changing the native conversation.
        return availability === "active" && metadata.archived !== true ? this.sessionView(metadata) : undefined;
      }));
      this.assertRunning();
      for (const session of supplemental) if (session) byId.set(session.id, session);
    }
    const sessions = [...byId.values()].sort((left, right) => right.time.created - left.time.created || left.id.localeCompare(right.id));
    const revision = createHash("sha256").update(JSON.stringify({ sourceId: this.sourceId, projects, sessions })).digest("hex");
    const snapshot: DesktopCatalogSnapshot = { sourceId: this.sourceId, revision, complete: true, projects, sessions };
    for (const session of sessions) this.admitThread(session.id);
    const changed = this.current?.revision !== revision;
    this.current = snapshot;
    if (changed) {
      for (const listener of this.listeners) {
        try { listener(structuredClone(snapshot)); }
        catch (error) { this.reportError(error); }
      }
    }
    return structuredClone(snapshot);
  }

  private projectView(project: NativeProject): UnifiedProject {
    return {
      id: project.id, name: project.name, directory: project.roots[0]?.path ?? "", roots: project.roots.map((root) => root.path),
      order: project.position, engineType: "codex-desktop",
      engineMeta: { codexProjectId: project.id, sourceId: this.sourceId, nativeMetadata: project.metadata, nativeDeleteEligible: project.createdAt * 1000 >= this.cutoffMs },
    };
  }

  private sessionView(thread: Record<string, unknown>): UnifiedSession {
    const id = requiredString(thread.id, "thread ID");
    const directory = requiredString(thread.cwd, "thread directory", true);
    const projectId = thread.projectId === null || thread.projectId === undefined ? null : requiredString(thread.projectId, "thread project ID");
    const effort = typeof thread.reasoningEffort === "string" ? fromCodexEffort(thread.reasoningEffort) : undefined;
    const title = catalogThreadTitle(thread);
    return {
      id, engineType: "codex-desktop", directory, projectId, archived: false,
      ...(title ? { title } : {}),
      ...(typeof thread.model === "string" && thread.model ? { modelId: thread.model } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(typeof thread.parentThreadId === "string" ? { parentId: thread.parentThreadId } : {}),
      sourceUrl: `codex://threads/${encodeURIComponent(id)}`, sourceName: "Codex",
      time: { created: secondsToMs(thread.createdAt), updated: secondsToMs(thread.updatedAt) },
      // A metadata-only app-server sees another process's thread as notLoaded.
      // Never overwrite the live follower's activity with a fabricated idle state.
      engineMeta: {
        codexThreadId: id, desktopHostId: "local", sourceId: this.sourceId,
        ...(typeof thread.modelProvider === "string" ? { modelProvider: thread.modelProvider } : {}),
        ...(record(thread.section) && typeof record(thread.section)!.id === "string" ? { nativeSectionId: record(thread.section)!.id } : {}),
      },
    };
  }

  private async pages(method: "project/list" | "thread/list", params: Record<string, unknown>): Promise<unknown[]> {
    const result: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      this.assertRunning();
      const response = object(await this.request(method, { ...params, cursor, limit: PAGE_SIZE }));
      if (!Array.isArray(response.data)) throw new Error("Native catalog returned an invalid page");
      result.push(...response.data);
      if (response.nextCursor === null || response.nextCursor === undefined) return result;
      if (typeof response.nextCursor !== "string" || !response.nextCursor || seen.has(response.nextCursor)) throw new Error("Native catalog returned an invalid or repeated cursor");
      cursor = response.nextCursor;
      seen.add(cursor);
    }
    throw new Error("Native catalog exceeded its bounded pagination limit");
  }

  private async freshAfterWrite(): Promise<DesktopCatalogSnapshot> {
    if (this.refreshing) await this.refreshing;
    return this.refresh();
  }
  private async request(method: DesktopCatalogMethod, params: Record<string, unknown>): Promise<unknown> {
    this.assertRunning();
    const result = await this.client.request(method, params);
    this.assertRunning();
    return result;
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutationTail.catch(() => {}).then(() => { this.assertRunning(); return operation(); });
    this.mutationTail = pending;
    return pending;
  }
  private schedule(delay: number): void {
    if (!this.started || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().catch((error) => this.reportError(error)).finally(() => this.schedule(this.dirty ? 0 : this.pollIntervalMs));
    }, delay);
    this.timer.unref?.();
  }
  private reportError(error: unknown): void { this.options.onError?.(error instanceof Error ? error : new Error("Native catalog refresh failed")); }
  private assertRunning(): void { if (this.stopped) throw new Error("Codex catalog observation has stopped"); }
}

function nativeProject(value: unknown): NativeProject {
  const project = object(value);
  if (!Array.isArray(project.roots) || !Number.isFinite(project.position)) throw new Error("Invalid native project metadata");
  return {
    id: requiredString(project.id, "project ID"), name: requiredString(project.name, "project name"),
    roots: project.roots.map((root) => ({ path: requiredString(object(root).path, "project root") })),
    metadata: stringMap(project.metadata ?? {}), position: project.position as number,
    createdAt: secondsToMs(project.createdAt) / 1000, updatedAt: secondsToMs(project.updatedAt) / 1000,
  };
}
function catalogThreadTitle(thread: Record<string, unknown>): string | undefined {
  if (typeof thread.name === "string" && thread.name.trim()) return thread.name.trim();
  if (typeof thread.preview !== "string") return undefined;
  // A preview is only a display fallback. Never persist it as a native rename or
  // copy an unbounded first prompt into the catalog's title field.
  const preview = thread.preview.slice(0, 2048).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!preview) return undefined;
  const characters = Array.from(preview);
  return characters.length <= PREVIEW_TITLE_LIMIT ? preview : `${characters.slice(0, PREVIEW_TITLE_LIMIT - 1).join("").trimEnd()}…`;
}
function projectName(name: string): string { return requiredString(name, "project name").trim(); }
function projectRoots(roots: string[]): Array<{ path: string }> {
  if (!Array.isArray(roots)) throw new Error("Project roots must be an array");
  return [...new Set(roots)].map((path) => {
    if (typeof path !== "string" || !path || (!posix.isAbsolute(path) && !win32.isAbsolute(path))) throw new Error("Project roots must be absolute paths");
    return { path };
  });
}
function stringMap(value: unknown): Record<string, string> {
  const entries = Object.entries(object(value));
  if (entries.some(([, entry]) => typeof entry !== "string")) throw new Error("Project metadata values must be strings");
  return Object.fromEntries(entries) as Record<string, string>;
}
function requireProject(snapshot: DesktopCatalogSnapshot, id: string): UnifiedProject {
  const project = snapshot.projects.find((project) => project.id === id);
  if (!project) throw new Error("The native project is no longer present");
  return project;
}
function assertProjectValues(project: UnifiedProject, expected: { name?: string; roots?: string[]; metadata?: Record<string, string> }): void {
  if ((expected.name !== undefined && project.name !== expected.name) || (expected.roots !== undefined && JSON.stringify(project.roots) !== JSON.stringify(expected.roots))) {
    throw new Error("The native project update was not confirmed");
  }
  if (expected.metadata) {
    const metadata = object(project.engineMeta?.nativeMetadata);
    if (Object.entries(expected.metadata).some(([key, value]) => metadata[key] !== value)) throw new Error("The native project metadata update was not confirmed");
  }
}
function secondsToMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Native catalog timestamp is invalid");
  return value * 1000;
}
function requiredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`Native ${label} is invalid`);
  return value;
}
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function object(value: unknown): Record<string, unknown> { const result = record(value); if (!result) throw new Error("Native catalog returned an invalid object"); return result; }
