import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { EngineAdapter } from "../engine-adapter";
import type {
  EngineCapabilities, EngineInfo, EngineStatus, ImportableSession,
  MessagePromptContent, PermissionReply, UnifiedMessage, UnifiedSession,
  ReasoningEffort, CodexServiceTier, EngineCommand, CommandInvokeResult,
  ModelListResult, UnifiedModelInfo, EngineCatalogSnapshot, UnifiedProject,
  CatalogProjectInput, CatalogProjectPatch, UnifiedQuestion,
} from "../../../../src/types/unified";
import { CodexDesktopIpcClient, type DesktopThreadStream, type DesktopThreadSettingsPatch, type DesktopCollaborationMode } from "./desktop-ipc-client";
import { DesktopStateReducer, desktopRequestId, type DesktopStateChange, type DesktopConversationSnapshot, type DesktopPendingRequest } from "./desktop-state";
import { CODEX_MODES, codexPermissionPatch, toCodexEffort } from "./config";
import { validateImageAddition, type ImageCandidate } from "../../../../shared/image-limits";
import { buildDesktopElicitationResponse, cancelDesktopElicitation } from "./desktop-elicitation";
import { buildCodexAsyncQuestionReply, convertCodexAsyncQuestion, type CodexAsyncQuestion } from "./async-questions";

const READ_OWNER_MISS_TTL_MS = 1000;
const MAX_READ_OWNER_MISSES = 256;
import { buildDesktopOwnerState } from "./desktop-owner";

export interface DesktopStoredThread {
  thread: Record<string, unknown> & { id: string };
  archived: boolean;
}

interface FollowedSession {
  ownerClientId: string;
  reducer: DesktopStateReducer;
  available: boolean;
}

export interface DesktopCatalogBridge {
  managementAvailable?: boolean;
  getCatalog(): Promise<EngineCatalogSnapshot>;
  stop(): Promise<void>;
  createProject(input: CatalogProjectInput): Promise<UnifiedProject>;
  updateProject(id: string, patch: CatalogProjectPatch): Promise<UnifiedProject>;
  moveProject(id: string, beforeId: string | null): Promise<void>;
  deleteProject(id: string): Promise<void>;
  assignThreadProject(id: string, projectId: string | null): Promise<void>;
}

export interface DesktopCreatedThread {
  threadId: string;
  catalogSourceId?: string;
  projectId?: string | null;
}

export interface CodexDesktopAdapterOptions {
  /** Backend-only identity for the unified-entry prototype. */
  engineType?: "codex" | "codex-desktop";
  client?: CodexDesktopIpcClient;
  /** A read-only history index. Listing must not resume or execute threads. */
  listCandidates?: (limit: number) => Promise<ImportableSession[]>;
  listModelCatalog?: () => Promise<ModelListResult>;
  renameThread?: (threadId: string, title: string, ownerClientId?: string) => Promise<void>;
  /** Service callbacks are the only path that may create or restore CodeMux-owned threads. */
  createThread?: (directory: string, meta?: Record<string, unknown>) => Promise<string | DesktopCreatedThread>;
  restoreThread?: (threadId: string, directory: string, meta: Record<string, unknown>) => Promise<string>;
  acquireThread?: (threadId: string) => Promise<{ threadId: string; owned: boolean }>;
  catalog?: DesktopCatalogBridge;
  readStoredThread?: (threadId: string) => Promise<DesktopStoredThread>;
  setThreadArchived?: (threadId: string, archived: boolean, meta: Record<string, unknown>) => Promise<DesktopStoredThread>;
  discardThread?: (threadId: string) => Promise<void>;
  turnTimeoutMs?: number;
  syncTimeoutMs?: number;
}

/** Follows IPC owners; optional service callbacks manage CodeMux-created threads. */
export class CodexDesktopAdapter extends EngineAdapter {
  readonly engineType: "codex" | "codex-desktop";
  private readonly client: CodexDesktopIpcClient;
  private readonly sessions = new Map<string, FollowedSession>();
  private readonly attaching = new Map<string, Promise<UnifiedSession>>();
  private readonly readOwnerMisses = new Map<string, { expiresAt: number; clientId: string | null }>();
  private readonly inputOwnerChecks = new Map<string, number>();
  private readonly watchers = new Set<() => void>();
  private readonly codemuxOwnedThreadIds = new Set<string>();
  private readonly storedSnapshots = new Map<string, DesktopConversationSnapshot>();
  private readonly archivedSessionIds = new Set<string>();
  private readonly dismissedAsyncQuestionIds = new Set<string>();
  private catalogSnapshot?: EngineCatalogSnapshot;
  private status: EngineStatus = "stopped";
  private lastError: string | undefined;
  private stopped = true;

  constructor(private readonly options: CodexDesktopAdapterOptions = {}) {
    super();
    this.engineType = options.engineType ?? "codex-desktop";
    this.client = options.client ?? new CodexDesktopIpcClient();
    this.client.on("stream", (stream: DesktopThreadStream) => this.receive(stream));
    this.client.on("close", () => this.markUnavailable("Codex Desktop connection closed"));
    this.client.on("error", (error: Error) => this.markUnavailable(error.message));
    this.client.on("ownerDisconnected", (ownerClientId: string) => {
      this.readOwnerMisses.clear();
      for (const session of this.sessions.values()) {
        if (session.ownerClientId === ownerClientId) session.available = false;
      }
      this.publishAvailability();
    });
    const refreshArchiveState = ({ conversationId }: { conversationId: string }) => {
      this.readOwnerMisses.delete(conversationId);
      if (!this.sessions.has(conversationId) && !this.storedSnapshots.has(conversationId)) return;
      void this.readStoredSnapshot(conversationId).catch((error: unknown) => {
        if (isArchivedThreadError(error)) return;
        this.lastError = error instanceof Error ? error.message : "Stored Desktop state could not be verified";
      });
    };
    this.client.on("threadArchived", refreshArchiveState);
    this.client.on("threadUnarchived", refreshArchiveState);
  }

  async start(): Promise<void> {
    if (this.status === "running" && this.client.connected) return;
    this.stopped = false;
    this.status = "starting";
    try {
      await this.client.connect();
      this.status = "running";
      this.lastError = undefined;
      this.emit("status.changed", { engineType: this.engineType, status: "running" });
    } catch (error) {
      this.markUnavailable(error instanceof Error ? error.message : "Desktop connection failed");
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.options.catalog?.stop();
    this.client.close();
    this.markUnavailable("CodeMux detached from Codex Desktop");
    this.status = "stopped";
    this.dismissedAsyncQuestionIds.clear();
  }

  async healthCheck(): Promise<boolean> { return this.client.connected; }
  getStatus(): EngineStatus { return this.status; }
  getInfo(): EngineInfo {
    return {
      type: this.engineType, name: this.engineType === "codex" ? "Codex" : "Codex Desktop (shared)", status: this.status,
      capabilities: this.getCapabilities(), errorMessage: this.lastError,
    };
  }
  getCapabilities(): EngineCapabilities {
    return {
      reasoningEffortOptions: ["low", "medium", "high", "max", "ultra"],
      sessionCatalog: !!this.options.catalog,
      catalogManagement: this.options.catalog?.managementAvailable === true,
      sessionArchive: false, hideArchivedSessions: true, confirmedSessionRemoval: true,
      authoritativeSessionState: true, questionDismissStopsTurn: true, providerModelHierarchy: false, dynamicModes: true,
      messageCancellation: true, permissionAlways: true, imageAttachment: true,
      loadSession: true, listSessions: true, modelSwitchable: true, customModelInput: true,
      messageEnqueue: true, slashCommands: true, fastModeSupported: true, availableModes: this.getModes(),
    };
  }
  getAuthMethods() { return []; }
  getModes() { return CODEX_MODES; }
  hasSession(id: string): boolean {
    return !this.archivedSessionIds.has(id) && this.sessions.get(id)?.available === true && this.client.connected;
  }

  publishCatalog(snapshot: EngineCatalogSnapshot): void {
    const activeIds = new Set(snapshot.sessions.filter((session) => !session.archived).map((session) => session.id));
    for (const id of activeIds) this.archivedSessionIds.delete(id);
    const excluded = new Set(snapshot.sessions.filter((session) => session.archived).map((session) => session.id));
    if (snapshot.complete && this.catalogSnapshot?.sourceId === snapshot.sourceId) {
      for (const session of this.catalogSnapshot.sessions) {
        if (activeIds.has(session.id) || excluded.has(session.id)) continue;
        // Missing catalog rows can also reflect unavailable storage. Only a
        // verified archive may remove the existing mirror.
        void this.readStoredSnapshot(session.id).catch((error: unknown) => {
          if (!isArchivedThreadError(error)) this.lastError = error instanceof Error ? error.message : "Stored Desktop state could not be verified";
        });
      }
    }
    for (const id of excluded) this.excludeArchivedSession(id);
    snapshot = this.applyCatalogIdentity({ ...snapshot, sessions: snapshot.sessions.filter((session) => !session.archived) });
    if (this.catalogSnapshot?.sourceId !== snapshot.sourceId) this.readOwnerMisses.clear();
    else {
      const previous = new Map(this.catalogSnapshot.sessions.map((session) => [session.id, session.archived]));
      const current = new Map(snapshot.sessions.map((session) => [session.id, session.archived]));
      for (const id of this.readOwnerMisses.keys()) {
        if (!previous.has(id) || !current.has(id) || previous.get(id) !== current.get(id)) this.readOwnerMisses.delete(id);
      }
    }
    this.catalogSnapshot = structuredClone(snapshot);
    for (const session of snapshot.sessions) {
      const live = this.sessions.get(session.id)?.reducer.snapshot;
      if (live) live.session = {
        ...live.session, projectId: session.projectId ?? null,
        catalogSourceId: snapshot.sourceId, catalogAvailable: true,
      };
    }
    this.emit("catalog.updated", structuredClone(snapshot));
  }

  async getCatalog(): Promise<EngineCatalogSnapshot> {
    const snapshot = await this.catalog().getCatalog();
    return this.applyCatalogIdentity({ ...snapshot, sessions: snapshot.sessions.filter((session) => !session.archived) });
  }

  private applyCatalogIdentity(snapshot: EngineCatalogSnapshot): EngineCatalogSnapshot {
    if (!this.options.engineType) return snapshot;
    return {
      ...snapshot,
      engineType: this.engineType,
      sessions: snapshot.sessions.map((session) => ({ ...session, engineType: this.engineType })),
      projects: snapshot.projects.map((project) => ({ ...project, ...(project.engineType ? { engineType: this.engineType } : {}) })),
    };
  }
  async createProject(input: CatalogProjectInput): Promise<UnifiedProject> { return this.catalog(true).createProject(input); }
  async updateProject(id: string, patch: CatalogProjectPatch): Promise<UnifiedProject> { return this.catalog(true).updateProject(id, patch); }
  async moveProject(id: string, beforeId: string | null): Promise<void> { return this.catalog(true).moveProject(id, beforeId); }
  async deleteCatalogProject(id: string): Promise<void> { return this.catalog(true).deleteProject(id); }
  async setSessionProject(id: string, projectId: string | null): Promise<void> { return this.catalog(true).assignThreadProject(id, projectId); }

  private catalog(requireManagement = false): DesktopCatalogBridge {
    if (this.stopped || !this.options.catalog) throw new Error("The shared session catalog is not available.");
    if (requireManagement && this.options.catalog.managementAvailable !== true) throw new Error("Official Desktop project management is not available through this bridge.");
    return this.options.catalog;
  }

  /** Explicitly attaches one existing Desktop thread, preserving its identity. */
  async attachThread(id: string): Promise<UnifiedSession> {
    const pending = this.attaching.get(id);
    if (pending) return pending;
    const operation = this.attach(id).finally(() => this.attaching.delete(id));
    this.attaching.set(id, operation);
    return operation;
  }

  private async attach(id: string): Promise<UnifiedSession> {
    if (this.archivedSessionIds.has(id)) throw archivedThreadError();
    if (this.sessions.get(id)?.available && this.client.connected) return this.requireSnapshot(id).session;
    let stored: DesktopConversationSnapshot | undefined;
    if (!this.client.connected) {
      try { await this.start(); }
      catch (error) {
        stored = await this.readStoredSnapshot(id);
        if (stored) return stored.session;
        throw error;
      }
    }
    const recentMiss = this.readOwnerMisses.get(id);
    if (!this.inputOwnerChecks.has(id) && recentMiss && recentMiss.expiresAt > performance.now() && recentMiss.clientId === this.client.clientId) {
      stored = await this.readStoredSnapshot(id);
      if (stored) return stored.session;
    }
    this.readOwnerMisses.delete(id);
    const owner = await this.client.discoverOwner(id);
    if (!owner) {
      // Cache only a completed negative response, never a timeout or error. The
      // short read-only window avoids repeating router discovery in restore/list.
      this.readOwnerMisses.set(id, { expiresAt: performance.now() + READ_OWNER_MISS_TTL_MS, clientId: this.client.clientId });
      if (this.readOwnerMisses.size > MAX_READ_OWNER_MISSES) this.readOwnerMisses.delete(this.readOwnerMisses.keys().next().value!);
      stored = await this.readStoredSnapshot(id);
      if (stored) return stored.session;
      throw new Error("This conversation has no connected Codex Desktop owner. Open it in Codex Desktop first.");
    }
    const session: FollowedSession = { ownerClientId: owner.ownerClientId, reducer: new DesktopStateReducer(), available: false };
    this.sessions.set(id, session);
    try {
      const initial = await this.client.followThread(id, owner.ownerClientId);
      // The stream event can arrive before followThread resolves.
      if (session.reducer.revision === undefined) this.applyState(id, session, initial);
      session.available = true;
      if (session.reducer.snapshot?.incompleteHistory) await this.client.loadCompleteHistory(id, owner.ownerClientId);
      return this.requireSnapshot(id).session;
    } catch (error) {
      session.available = false;
      this.client.unfollowThread(id);
      throw error;
    }
  }

  async listSessions(directory?: string): Promise<UnifiedSession[]> {
    const sessions = new Map([...this.storedSnapshots].map(([id, snapshot]) => [id, snapshot.session]));
    for (const entry of this.sessions.values()) {
      const snapshot = entry.reducer.snapshot;
      if (snapshot) sessions.set(snapshot.session.id, entry.available ? snapshot.session : this.unavailableSession(snapshot));
    }
    return [...sessions.values()].filter((session) => !session.archived && !this.archivedSessionIds.has(session.id) && (!directory || session.directory === directory));
  }
  async createSession(directory: string, meta?: Record<string, unknown>): Promise<UnifiedSession> {
    const existingId = typeof meta?.codexThreadId === "string" ? meta.codexThreadId : undefined;
    if (existingId && meta?.codexDesktopOwner === "codemux") this.markCodeMuxOwnedThread(existingId);
    if (existingId && (typeof meta?.catalogSourceId === "string" || this.catalogSnapshot?.sessions.some((session) => session.id === existingId))) {
      // Catalog restoration is a read operation even for historically CodeMux-
      // owned IDs. Only validated sendMessage input may request a native writer.
      return this.attachThread(existingId);
    }
    if (existingId) {
      if (!this.client.connected) {
        try { await this.start(); }
        catch (error) {
          const stored = await this.readStoredSnapshot(existingId);
          if (stored?.session.archived) return stored.session;
          throw error;
        }
      }
      if (this.sessions.get(existingId)?.available || await this.client.discoverOwner(existingId)) return this.attachThread(existingId);
      const stored = await this.readStoredSnapshot(existingId);
      if (stored?.session.archived) return stored.session;
    }
    if (meta?.codexDesktopOwner === "codemux") {
      if (!existingId) throw new Error("CodeMux-owned restoration requires the original Codex thread ID");
      if (!this.options.restoreThread) throw new Error("CodeMux-owned thread restoration is unavailable");
      const restored = await this.options.restoreThread(existingId, directory, meta);
      if (restored !== existingId) throw new Error("CodeMux-owned restoration changed the original thread ID");
      this.markCodeMuxOwnedThread(existingId);
      return this.attachThread(existingId);
    }
    if (existingId) return this.attachThread(existingId);
    if (!this.options.createThread) throw new Error("Create a conversation in Codex Desktop, then attach it using Import Sessions.");
    if (!this.client.connected) await this.start();
    const created = meta
      ? await this.options.createThread(directory, meta)
      : await this.options.createThread(directory);
    const threadId = typeof created === "string" ? created : created.threadId;
    if (!threadId) throw new Error("CodeMux did not create a Codex thread ID");
    this.markCodeMuxOwnedThread(threadId);
    // Catalog readers can race owner registration. Do not reuse their pending
    // attach or negative discovery cache after creation has registered the owner.
    const session = await this.attachForInput(threadId);
    if (typeof created !== "string" && created.catalogSourceId) {
      const result: UnifiedSession = {
        ...session, projectId: created.projectId ?? null, catalogSourceId: created.catalogSourceId,
        engineMeta: { ...session.engineMeta, catalogSourceId: created.catalogSourceId, catalogProjectId: created.projectId ?? null },
      };
      const snapshot = this.sessions.get(threadId)?.reducer.snapshot ?? this.storedSnapshots.get(threadId);
      if (snapshot) snapshot.session = result;
      return result;
    }
    return session;
  }
  override async restoreSession(sessionId: string, directory: string, meta?: Record<string, unknown>): Promise<UnifiedSession> {
    return this.createSession(directory, { ...meta, codexThreadId: sessionId });
  }
  private markCodeMuxOwnedThread(id: string): void {
    this.codemuxOwnedThreadIds.add(id);
    const snapshot = this.sessions.get(id)?.reducer.snapshot;
    if (snapshot) snapshot.session = { ...snapshot.session, engineMeta: { ...snapshot.session.engineMeta, codexDesktopOwner: "codemux" } };
  }

  /** Called only after the service registers an already loaded native writer. */
  async attachOwnedThread(id: string): Promise<UnifiedSession> {
    this.markCodeMuxOwnedThread(id);
    return this.attachForInput(id);
  }
  async getSession(id: string): Promise<UnifiedSession | null> {
    if (this.archivedSessionIds.has(id)) return null;
    if (!this.sessions.has(id) && !this.storedSnapshots.has(id) && !this.options.readStoredThread) return null;
    try { return await this.attachThread(id); }
    catch (error) { if (isArchivedThreadError(error)) return null; throw error; }
  }
  async deleteSession(id: string): Promise<void> {
    // Lifecycle cleanup only detaches; explicit user removal has a separate path.
    this.detachSession(id);
  }

  async removeSession(id: string): Promise<"local" | "archived"> {
    try { await this.attachThread(id); }
    catch (error) {
      if (!isArchivedThreadError(error)) throw error;
      this.detachSession(id);
      return "archived";
    }
    const entry = this.sessions.get(id);
    if (entry?.available) await this.client.loadCompleteHistory(id, entry.ownerClientId);
    if (this.archivedSessionIds.has(id)) return "archived";
    const current = this.sessions.get(id);
    const snapshot = current?.available && this.client.connected ? current.reducer.snapshot : this.storedSnapshots.get(id);
    if (!snapshot || snapshot.incompleteHistory) throw new Error("The complete conversation must be synchronized before removing it.");
    if (snapshot.isActive || snapshot.pendingRequests.length) throw new Error("Finish the current turn and pending interactions before removing this conversation.");
    if (snapshot.messages.length > 0) {
      if (!this.options.setThreadArchived) throw new Error("Native conversation archiving is unavailable; the conversation was not removed.");
      const meta = { codexThreadId: id, ...(this.codemuxOwnedThreadIds.has(id) ? { codexDesktopOwner: "codemux" } : {}) };
      const archived = await this.options.setThreadArchived(id, true, meta);
      if (archived.thread.id !== id || archived.archived !== true) throw new Error("The native conversation archive state was not confirmed.");
      this.archivedSessionIds.add(id);
    } else {
      await this.options.discardThread?.(id);
    }
    this.detachSession(id);
    return snapshot.messages.length > 0 ? "archived" : "local";
  }

  private detachSession(id: string): void {
    this.client.unfollowThread(id);
    this.sessions.delete(id);
    this.storedSnapshots.delete(id);
    this.readOwnerMisses.delete(id);
    this.notifyWatchers();
  }

  private excludeArchivedSession(id: string): void {
    const firstExclusion = !this.archivedSessionIds.has(id);
    this.archivedSessionIds.add(id);
    this.detachSession(id);
    if (firstExclusion) this.emit("session.removed", { sessionId: id });
  }
  async renameSession(id: string, title: string): Promise<void> {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) throw new Error("A non-empty conversation title is required.");
    await this.attachThread(id);
    if (!this.options.renameThread) throw new Error("Renaming a shared conversation is unavailable in this client. Rename it in Codex Desktop.");
    if (!this.sessions.get(id)?.available) {
      await this.options.renameThread(id, normalizedTitle);
      const stored = await this.readStoredSnapshot(id);
      if (stored?.session.title?.trim() !== normalizedTitle) throw new Error("The stored conversation title could not be confirmed.");
      return;
    }
    const snapshot = this.requireSnapshot(id);
    if (snapshot.pendingRequests.length > 0) throw new Error("Resolve pending approvals or questions before renaming this shared conversation.");
    if ((snapshot.session.title ?? "").trim() === normalizedTitle) return;
    await this.options.renameThread(id, normalizedTitle, this.sessions.get(id)!.ownerClientId);
    await this.waitForState(id, (snapshot) => (snapshot.session.title ?? "").trim() === normalizedTitle, "The shared title update has not been synchronized yet.");
  }
  async listMessages(id: string): Promise<UnifiedMessage[]> {
    await this.attachThread(id);
    const stored = this.storedSnapshots.get(id);
    if (!this.sessions.get(id)?.available && stored) return stored.messages;
    return this.requireSnapshot(id).messages;
  }

  async setSessionArchived(_id: string, _archived: boolean): Promise<void> {
    throw new Error("Shared conversations do not expose archive or restore controls. Remove the conversation to archive non-empty native history.");
  }

  private async readStoredSnapshot(id: string): Promise<DesktopConversationSnapshot | undefined> {
    if (!this.options.readStoredThread) return undefined;
    try { return this.acceptStoredSnapshot(id, await this.options.readStoredThread(id)); }
    catch (error) {
      this.readOwnerMisses.delete(id);
      if (isArchivedThreadError(error)) this.excludeArchivedSession(id);
      throw error;
    }
  }

  private acceptStoredSnapshot(id: string, stored: DesktopStoredThread): DesktopConversationSnapshot {
    if (stored.thread.id !== id) throw new Error("Stored Codex history returned a different thread ID");
    if (stored.archived) {
      this.excludeArchivedSession(id);
      throw archivedThreadError();
    }
    const followed = this.sessions.get(id);
    const live = followed?.available ? followed.reducer.snapshot : undefined;
    const known = followed?.reducer.snapshot?.session ?? this.storedSnapshots.get(id)?.session;
    const state = buildDesktopOwnerState({
      thread: stored.thread, model: known?.modelId ?? "",
      reasoningEffort: known?.reasoningEffort ? toCodexEffort(known.reasoningEffort) : undefined,
      serviceTier: known?.serviceTier,
    });
    const reducer = new DesktopStateReducer();
    const snapshot = reducer.apply({ type: "snapshot", revision: 0, conversationState: state });
    this.applyEngineIdentity(snapshot);
    snapshot.session = {
      ...this.unavailableSession(snapshot), archived: false,
      ...(snapshot.messages.length > 0 ? { sourceUrl: `codex://threads/${encodeURIComponent(id)}`, sourceName: "Codex" } : {}),
      engineMeta: { ...snapshot.session.engineMeta, ...(this.codemuxOwnedThreadIds.has(id) ? { codexDesktopOwner: "codemux" } : {}) },
    };
    const previous = this.storedSnapshots.get(id);
    if (previous && previous.session.archived !== false) this.readOwnerMisses.delete(id);
    if (followed && !followed.available) this.sessions.delete(id);
    this.storedSnapshots.set(id, snapshot);
    if (!live || previous?.session.archived !== false) {
      this.emit("session.updated", { session: live ? { ...live.session, archived: false } : snapshot.session });
    }
    return snapshot;
  }
  async getHistoricalMessages(id: string): Promise<UnifiedMessage[]> { return this.listMessages(id); }

  async listHistoricalSessions(limit: number): Promise<ImportableSession[]> {
    if (!this.options.listCandidates) return super.listHistoricalSessions(limit);
    const count = limit > 0 ? limit : 100;
    const candidates = await this.options.listCandidates(count);
    // Listing is a bounded metadata read. Resolve the owner only when a user
    // selects a conversation; offline history remains a valid import candidate.
    return candidates.filter((candidate) => !candidate.archived).slice(0, count).map((candidate) => {
      const id = typeof candidate.engineMeta?.codexThreadId === "string" ? candidate.engineMeta.codexThreadId : candidate.engineSessionId;
      return { ...candidate, engineSessionId: id, engineMeta: {
        ...candidate.engineMeta, codexThreadId: id, desktopHostId: "local",
        ...(this.codemuxOwnedThreadIds.has(id) ? { codexDesktopOwner: "codemux" } : {}),
      } };
    });
  }

  async sendMessage(id: string, content: MessagePromptContent[], options?: Parameters<EngineAdapter["sendMessage"]>[2]): Promise<UnifiedMessage> {
    await this.attachForInput(id);
    const text = content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
    const input: Array<Record<string, unknown>> = text ? [{ type: "text", text, text_elements: [] }] : [];
    const images: ImageCandidate[] = [];
    for (const part of content) {
      if (part.type !== "image") continue;
      const data = part.data ?? "";
      if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) throw new Error("Invalid base64 image data.");
      const image = { size: Buffer.byteLength(data, "base64"), mimeType: part.mimeType ?? "image/png" };
      const validation = validateImageAddition(images, image);
      if (!validation.ok) throw new Error(`Image attachment rejected: ${validation.reason}`);
      images.push(image);
      input.push({ type: "image", url: `data:${image.mimeType};base64,${data}` });
    }
    if (input.length === 0) throw new Error("A non-empty message is required.");
    if (!this.sessions.get(id)?.available && this.options.acquireThread) {
      const acquired = await this.options.acquireThread(id);
      if (acquired.threadId !== id) throw new Error("Acquiring the shared conversation changed its identity.");
      if (acquired.owned) this.markCodeMuxOwnedThread(id);
      await this.attachForInput(id);
    }
    const entry = this.sessions.get(id)!;
    const before = this.requireSnapshot(id);
    const revision = entry.reducer.revision!;
    const clientUserMessageId = randomUUID();
    let response: unknown;
    if (before.isActive) {
      response = await this.client.steerTurn(id, entry.ownerClientId, {
        input, clientUserMessageId, attachments: [],
        restoreMessage: {
          id: clientUserMessageId, text, cwd: before.session.directory, createdAt: Date.now(),
          context: {
            messageThreadId: id, workspaceRoots: [before.session.directory],
            collaborationMode: entry.reducer.conversationState?.latestCollaborationMode,
            commentAttachments: [], fileAttachments: [],
            imageAttachments: input.flatMap((part, index) => part.type === "image" ? [{ id: `${clientUserMessageId}:image:${index}`, src: part.url }] : []),
            ideContext: null,
          },
          responsesapiClientMetadata: { source: "codex" },
        },
      });
    } else {
      response = await this.client.startTurn(id, entry.ownerClientId, { request: { threadId: id, input, clientUserMessageId }, context: { attachments: [] } });
    }
    return this.waitForCompletion(id, revision, readTurnId(response) ?? (before.isActive ? before.activeTurnId : undefined), before.latestTurnId, before.isActive,
      new Set(before.messages.filter((message) => message.role === "user").map((message) => message.id)), text, images.length, clientUserMessageId, options?.clientMessageId);
  }

  private async attachForInput(id: string): Promise<UnifiedSession> {
    this.readOwnerMisses.delete(id);
    this.inputOwnerChecks.set(id, (this.inputOwnerChecks.get(id) ?? 0) + 1);
    try {
      // A read that began before this input may still be discovering an owner.
      // After it finishes, a fresh input attachment must not reuse its miss.
      const reading = this.attaching.get(id);
      if (reading) await reading;
      this.readOwnerMisses.delete(id);
      return await this.attachThread(id);
    } finally {
      const remaining = (this.inputOwnerChecks.get(id) ?? 1) - 1;
      if (remaining > 0) this.inputOwnerChecks.set(id, remaining);
      else this.inputOwnerChecks.delete(id);
    }
  }

  async cancelMessage(id: string): Promise<void> {
    const snapshot = this.requireSnapshot(id);
    if (!snapshot.isActive) return;
    if (!snapshot.activeTurnId) throw new Error("The active turn is not synchronized; refresh before stopping it.");
    await this.client.interruptTurn(id, this.sessions.get(id)!.ownerClientId, snapshot.activeTurnId);
  }

  async listModels() {
    const catalog = await this.options.listModelCatalog?.();
    const models: UnifiedModelInfo[] = (catalog?.models ?? []).map((model) => ({ ...model, engineType: this.engineType }));
    let currentModelId: string | undefined;
    for (const entry of this.sessions.values()) {
      const session = entry.reducer.snapshot?.session;
      if (!session?.modelId) continue;
      currentModelId ??= session.modelId;
      let model = models.find((candidate) => candidate.modelId === session.modelId);
      if (!model) {
        const named = models.find((candidate) => candidate.name === session.modelId);
        model = { ...named, modelId: session.modelId, name: named?.name ?? session.modelId, engineType: this.engineType };
        models.push(model);
      }
      if (session.reasoningEffort && !model.capabilities?.supportedReasoningEfforts?.includes(session.reasoningEffort)) {
        model.capabilities = { ...model.capabilities, supportedReasoningEfforts: [...(model.capabilities?.supportedReasoningEfforts ?? []), session.reasoningEffort] };
      }
    }
    return { models, currentModelId: currentModelId ?? catalog?.currentModelId };
  }
  async setModel(id: string, modelId: string): Promise<void> {
    if (!modelId.trim()) throw new Error("A model ID is required.");
    await this.attachThread(id);
    if (this.requireSnapshot(id).session.modelId === modelId) return;
    await this.updateSettings(id, { model: modelId, collaborationMode: this.collaborationMode(id, { model: modelId }) }, (snapshot) => snapshot.session.modelId === modelId);
  }
  async setMode(id: string, modeId: string): Promise<void> {
    if (!CODEX_MODES.some((mode) => mode.id === modeId)) throw new Error(`Unsupported Codex permission mode: ${modeId}`);
    await this.attachThread(id);
    if (this.requireSnapshot(id).session.mode === modeId) return;
    await this.updateSettings(id, codexPermissionPatch(modeId), (snapshot) => snapshot.session.mode === modeId);
  }
  async setReasoningEffort(id: string, effort: ReasoningEffort | null): Promise<void> {
    await this.attachThread(id);
    const nativeEffort = effort == null ? null : toCodexEffort(effort);
    await this.updateSettings(id, { effort: nativeEffort, collaborationMode: this.collaborationMode(id, { effort: nativeEffort }) },
      (snapshot, state) => effort == null ? asRecord(state.latestThreadSettings).effort === null : snapshot.session.reasoningEffort === effort);
  }
  getReasoningEffort(id: string): ReasoningEffort | null { return this.sessions.get(id)?.reducer.snapshot?.session.reasoningEffort ?? null; }
  async setServiceTier(id: string, tier: CodexServiceTier | null): Promise<void> {
    await this.attachThread(id);
    await this.updateSettings(id, { serviceTier: tier === "fast" ? "priority" : tier },
      (snapshot) => snapshot.session.serviceTier === (tier ?? undefined));
  }
  getServiceTier(id: string): CodexServiceTier | null { return this.sessions.get(id)?.reducer.snapshot?.session.serviceTier ?? null; }

  private collaborationMode(id: string, patch: { model?: string; effort?: string | null; mode?: string }): DesktopCollaborationMode {
    const entry = this.sessions.get(id)!;
    const snapshot = this.requireSnapshot(id);
    const state = entry.reducer.conversationState ?? {};
    const threadSettings = asRecord(state.latestThreadSettings);
    const current = asRecord(threadSettings.collaborationMode ?? state.latestCollaborationMode);
    const settings = asRecord(current.settings);
    const currentEffort = Object.hasOwn(threadSettings, "effort") ? threadSettings.effort
      : state.latestReasoningEffort ?? settings.reasoning_effort;
    const model = patch.model ?? snapshot.session.modelId;
    if (!model) throw new Error("The Desktop model is not synchronized. Refresh before changing settings.");
    return {
      mode: patch.mode ?? (typeof current.mode === "string" ? current.mode : snapshot.session.mode ?? "default"),
      settings: {
        model,
        reasoning_effort: Object.hasOwn(patch, "effort") ? patch.effort ?? null
          : typeof currentEffort === "string" ? currentEffort
            : currentEffort === null ? null
            : snapshot.session.reasoningEffort ? toCodexEffort(snapshot.session.reasoningEffort) : null,
        ...(typeof settings.developer_instructions === "string" || settings.developer_instructions === null ? { developer_instructions: settings.developer_instructions } : {}),
      },
    };
  }

  private async updateSettings(id: string, patch: DesktopThreadSettingsPatch, isApplied: (snapshot: DesktopConversationSnapshot, state: Record<string, unknown>) => boolean): Promise<void> {
    this.requireSnapshot(id);
    const entry = this.sessions.get(id)!;
    // Model and mode controls update the next turn. Supplying activeTurnId would
    // route the Desktop request through its current-turn permission editor.
    const response = await this.client.updateThreadSettings(id, entry.ownerClientId, patch);
    if (!response.applied) throw new Error("Codex Desktop did not apply the settings. Refresh the conversation and try again.");
    await this.waitForState(id, isApplied, "The Desktop settings update was accepted but its state is not synchronized yet.");
  }

  getPendingPermissions(id?: string) {
    return [...this.sessions.entries()].flatMap(([key, entry]) => !id || key === id ? entry.reducer.snapshot?.permissions ?? [] : []);
  }
  getPendingQuestions(id?: string) {
    return [...this.sessions.entries()].flatMap(([key, entry]) => (!id || key === id) && entry.reducer.snapshot
      ? this.visibleQuestions(entry.reducer.snapshot) : []);
  }
  async replyPermission(id: string, reply: PermissionReply, sessionId?: string): Promise<void> {
    const { threadId, entry, request } = this.pendingRequest(id, sessionId);
    if (!["allow_once", "allow_always", "reject_once"].includes(reply.optionId)) throw new Error(`Unsupported permission decision: ${reply.optionId}`);
    const permission = entry.reducer.snapshot!.permissions.find((item) => item.id === id);
    if (!permission?.options.some((option) => option.id === reply.optionId)) throw new Error("This decision is not offered by the pending permission request.");
    const decision = reply.optionId === "allow_always" ? "acceptForSession" : reply.optionId === "allow_once" ? "accept" : "decline";
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        await this.client.replyCommandApproval(threadId, entry.ownerClientId, request.id, decision);
        break;
      case "item/fileChange/requestApproval":
        await this.client.replyFileApproval(threadId, entry.ownerClientId, request.id, decision);
        break;
      case "item/permissions/requestApproval":
        await this.client.replyPermissionsApproval(threadId, entry.ownerClientId, request.id, {
          permissions: reply.optionId === "reject_once" ? {} : asRecord(request.params.permissions),
          scope: reply.optionId === "allow_always" ? "session" : "turn",
        });
        break;
      default:
        throw new Error(`This approval type is not supported by the Desktop follower: ${request.method}`);
    }
    await this.waitForRequestRemoval(threadId, request.id);
  }
  async replyQuestion(id: string, answers: string[][], sessionId?: string): Promise<void> {
    const asynchronous = this.pendingAsyncQuestion(id, sessionId);
    if (asynchronous) {
      const { threadId, entry, question, definitions } = asynchronous;
      const snapshot = this.requireSnapshot(threadId);
      const turnId = question.metadata?.codexTurnId;
      if (!snapshot.isActive || !snapshot.activeTurnId || snapshot.activeTurnId !== turnId) {
        throw new Error("The question's active turn has changed. Refresh before replying.");
      }
      const { text, replies } = buildCodexAsyncQuestionReply(definitions, answers);
      const clientUserMessageId = randomUUID();
      await this.client.steerTurn(threadId, entry.ownerClientId, {
        input: [{ type: "text", text }], clientUserMessageId, attachments: [],
        restoreMessage: {
          id: clientUserMessageId, text, cwd: snapshot.session.directory, createdAt: Date.now(),
          context: {
            prompt: text, turnTrigger: "send_user_message_async_question", messageThreadId: threadId,
            workspaceRoots: [snapshot.session.directory], collaborationMode: entry.reducer.conversationState?.latestCollaborationMode,
            addedFiles: [], commentAttachments: [], fileAttachments: [], imageAttachments: [], ideContext: null,
          },
          responsesapiClientMetadata: { source: "codex" },
        },
      });
      // Admission is not acknowledgement: a pending or failed steer cannot consume a question.
      await this.waitForState(threadId, (current) => {
        const accepted = new Set(current.messages.flatMap(message =>
          message.engineMeta?.codexTurnId === turnId && message.engineMeta?.codexAsyncQuestionReplyAccepted === true
            && Array.isArray(message.engineMeta.codexAsyncQuestionReplyIds) ? message.engineMeta.codexAsyncQuestionReplyIds : []));
        return replies.every(reply => accepted.has(reply.questionItemId));
      }, "The answer was sent but its accepted receipt has not synchronized yet.");
      return;
    }
    const { threadId, entry, request } = this.pendingRequest(id, sessionId);
    if (request.method === "mcpServer/elicitation/request") {
      const response = buildDesktopElicitationResponse(request.params, answers);
      await this.client.replyMcpElicitation(threadId, entry.ownerClientId, request.id, response);
      await this.waitForRequestRemoval(threadId, request.id);
      return;
    }
    if (request.method !== "item/tool/requestUserInput") throw new Error(`Unsupported Desktop question type: ${request.method}`);
    const definitions = Array.isArray(request.params.questions) ? request.params.questions : [];
    if (definitions.length === 0) throw new Error("The pending request has no supported questions.");
    const response: Record<string, { answers: string[] }> = {};
    definitions.forEach((definition, index) => {
      const questionId = asRecord(definition).id;
      if (typeof questionId !== "string") throw new Error("The pending question has no stable ID.");
      response[questionId] = { answers: answers[index] ?? [] };
    });
    await this.client.submitUserInput(threadId, entry.ownerClientId, request.id, { answers: response });
    await this.waitForRequestRemoval(threadId, request.id);
  }
  async rejectQuestion(id: string, sessionId?: string): Promise<void> {
    const asynchronous = this.pendingAsyncQuestion(id, sessionId);
    if (asynchronous) {
      for (const question of asynchronous.definitions) {
        this.dismissedAsyncQuestionIds.add(JSON.stringify([asynchronous.threadId, question.id]));
      }
      // Native async question dismissal is local UI state, never an empty answer or interruption.
      this.emit("question.replied", { questionId: id, answers: [] });
      return;
    }
    const { threadId, entry, request } = this.pendingRequest(id, sessionId);
    if (request.method === "mcpServer/elicitation/request") {
      await this.client.replyMcpElicitation(threadId, entry.ownerClientId, request.id, cancelDesktopElicitation());
      await this.waitForRequestRemoval(threadId, request.id);
      return;
    }
    if (request.method !== "item/tool/requestUserInput") throw new Error(`Unsupported Desktop question type: ${request.method}`);
    const snapshot = this.requireSnapshot(threadId);
    if (!snapshot.isActive || !snapshot.activeTurnId) throw new Error("The active turn is not synchronized; refresh before dismissing the question.");
    // Desktop dismisses an ordinary blocking question by stopping its turn.
    // Empty answers are reserved for specific onboarding/automatic flows.
    await this.client.interruptTurn(threadId, entry.ownerClientId, snapshot.activeTurnId);
    await this.waitForRequestRemoval(threadId, request.id);
  }

  private visibleQuestions(snapshot: DesktopConversationSnapshot): UnifiedQuestion[] {
    return snapshot.questions.flatMap(question => {
      const definitions = question.metadata?.codexAsyncQuestions as CodexAsyncQuestion[] | undefined;
      if (!Array.isArray(definitions)) return [question];
      const remaining = definitions.filter(item => !this.dismissedAsyncQuestionIds.has(JSON.stringify([snapshot.session.id, item.id])));
      if (remaining.length === definitions.length) return [question];
      if (remaining.length === 0) return [];
      return [convertCodexAsyncQuestion(snapshot.session.id, String(question.metadata?.codexTurnId), remaining,
        this.engineType, String(snapshot.session.engineMeta?.desktopHostId ?? "local"))];
    });
  }

  private pendingAsyncQuestion(id: string, sessionId?: string): {
    threadId: string; entry: FollowedSession; question: UnifiedQuestion; definitions: CodexAsyncQuestion[];
  } | undefined {
    for (const [threadId, entry] of this.sessions) {
      if ((sessionId && threadId !== sessionId) || !entry.reducer.snapshot) continue;
      const question = this.visibleQuestions(entry.reducer.snapshot).find(item => item.id === id);
      const definitions = question?.metadata?.codexAsyncQuestions as CodexAsyncQuestion[] | undefined;
      if (question && Array.isArray(definitions)) {
        this.requireSnapshot(threadId);
        return { threadId, entry, question, definitions };
      }
    }
    return undefined;
  }

  private pendingRequest(id: string, sessionId?: string): { threadId: string; entry: FollowedSession; request: DesktopPendingRequest } {
    const matches = [...this.sessions.entries()].flatMap(([threadId, entry]) => {
      if (sessionId && sessionId !== threadId) return [];
      const hostId = entry.reducer.snapshot?.session.engineMeta?.desktopHostId;
      return (entry.reducer.snapshot?.pendingRequests ?? []).filter((request) => desktopRequestId(threadId, request.id, typeof hostId === "string" ? hostId : "local") === id)
        .map((request) => ({ threadId, entry, request }));
    });
    if (matches.length !== 1) throw new Error(matches.length ? "This request ID is ambiguous; select its conversation first." : "This request is no longer pending.");
    this.requireSnapshot(matches[0].threadId);
    return matches[0];
  }
  private waitForRequestRemoval(id: string, requestId: string | number): Promise<void> {
    return this.waitForState(id, (snapshot) => !snapshot.pendingRequests.some((request) => request.id === requestId), "The reply was delivered but its acknowledgement has not synchronized yet.");
  }
  async listCommands(_sessionId?: string, _directory?: string): Promise<EngineCommand[]> {
    return [{ name: "compact", description: "Compact the shared conversation in Codex Desktop", userInvocable: true }];
  }
  async invokeCommand(id: string, name: string, args: string): Promise<CommandInvokeResult> {
    if (name !== "compact" || args.trim()) throw new Error("Only /compact without arguments is supported by the Desktop follower.");
    const snapshot = this.requireSnapshot(id);
    if (snapshot.isActive) throw new Error("Wait for the current turn to finish before compacting.");
    await this.client.compactThread(id, this.sessions.get(id)!.ownerClientId);
    return { handledAsCommand: true };
  }
  async listProjects() {
    return [...new Set((await this.listSessions()).map((session) => session.directory))]
      .map((directory) => ({ id: directory, directory, name: directory.split(/[\\/]/).pop() || directory }));
  }

  private receive(stream: DesktopThreadStream): void {
    const entry = this.sessions.get(stream.conversationId);
    if (!entry || entry.ownerClientId !== stream.ownerClientId || stream.hostId !== "local") return;
    try {
      this.applyState(stream.conversationId, entry, stream.change as DesktopStateChange);
    } catch (error) {
      entry.available = false;
      this.lastError = error instanceof Error ? error.message : "Invalid Desktop snapshot";
      this.client.unfollowThread(stream.conversationId);
      this.publishAvailability();
    }
  }

  private applyState(id: string, entry: FollowedSession, change: DesktopStateChange): void {
    if (this.archivedSessionIds.has(id)) throw archivedThreadError();
    const previous = entry.reducer.snapshot;
    const snapshot = entry.reducer.apply(change);
    this.applyEngineIdentity(snapshot);
    snapshot.session = { ...snapshot.session, archived: false };
    const catalogEntry = this.catalogSnapshot?.sessions.find((session) => session.id === id);
    if (catalogEntry) snapshot.session = {
      ...snapshot.session, projectId: catalogEntry.projectId ?? null,
      catalogSourceId: this.catalogSnapshot!.sourceId, catalogAvailable: true,
    };
    else if (previous?.session.catalogSourceId) snapshot.session = {
      ...snapshot.session, catalogSourceId: previous.session.catalogSourceId,
      projectId: previous.session.projectId ?? null,
    };
    if (snapshot.messages.length > 0) {
      snapshot.session.sourceUrl = `codex://threads/${encodeURIComponent(id)}`;
      snapshot.session.sourceName = "Codex";
    }
    if (snapshot.session.id !== id) throw new Error("Desktop snapshot identity mismatch");
    if (this.codemuxOwnedThreadIds.has(id)) {
      snapshot.session = { ...snapshot.session, engineMeta: { ...snapshot.session.engineMeta, codexDesktopOwner: "codemux" } };
    }
    entry.available = true;
    this.emit("session.updated", { session: snapshot.session });
    const priorMessages = new Map(previous?.messages.map((message) => [message.id, JSON.stringify(message)]));
    const currentMessageIds = new Set(snapshot.messages.map((message) => message.id));
    for (const messageId of priorMessages.keys()) {
      if (!currentMessageIds.has(messageId)) this.emit("message.removed", { sessionId: id, messageId });
    }
    for (const message of snapshot.messages) {
      if (priorMessages.get(message.id) !== JSON.stringify(message)) this.emit("message.updated", { sessionId: id, message });
    }
    const oldPermissions = new Set(previous?.permissions.map((permission) => permission.id));
    for (const permission of snapshot.permissions) if (!oldPermissions.has(permission.id)) this.emit("permission.asked", { permission });
    for (const permission of previous?.permissions ?? []) {
      if (!snapshot.permissions.some((current) => current.id === permission.id)) this.emit("permission.replied", { permissionId: permission.id, optionId: "resolved" });
    }
    const previousQuestions = previous ? this.visibleQuestions(previous) : [];
    const currentQuestions = this.visibleQuestions(snapshot);
    const oldQuestions = new Set(previousQuestions.map((question) => question.id));
    for (const question of currentQuestions) if (!oldQuestions.has(question.id)) this.emit("question.asked", { question });
    for (const question of previousQuestions) {
      if (!currentQuestions.some((current) => current.id === question.id)) this.emit("question.replied", { questionId: question.id, answers: [] });
    }
    const currentAsyncIds = new Set(snapshot.questions.flatMap(question =>
      (question.metadata?.codexAsyncQuestions as CodexAsyncQuestion[] | undefined)?.map(item => JSON.stringify([id, item.id])) ?? []));
    for (const key of this.dismissedAsyncQuestionIds) {
      if (JSON.parse(key)[0] === id && !currentAsyncIds.has(key)) this.dismissedAsyncQuestionIds.delete(key);
    }
    this.notifyWatchers();
  }

  private applyEngineIdentity(snapshot: DesktopConversationSnapshot): void {
    snapshot.session.engineType = this.engineType;
    for (const permission of snapshot.permissions) permission.engineType = this.engineType;
    for (const question of snapshot.questions) question.engineType = this.engineType;
  }

  private requireSnapshot(id: string): DesktopConversationSnapshot {
    if (this.archivedSessionIds.has(id)) throw archivedThreadError();
    const entry = this.sessions.get(id);
    if (!this.client.connected || !entry?.available || !entry.reducer.snapshot) throw new Error("Codex Desktop conversation is disconnected. Reconnect before sending commands.");
    return entry.reducer.snapshot;
  }

  private waitForCompletion(id: string, afterRevision: number, expectedTurnId: string | undefined, previousTurnId: string | undefined, steering: boolean, previousUserIds: Set<string>, inputText: string, imageCount: number, nativeClientMessageId: string, clientMessageId?: string): Promise<UnifiedMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Desktop turn is still running. Its execution was not cancelled.")), this.options.turnTimeoutMs ?? 600_000);
      let consumed = false;
      const check = () => {
        try {
          const snapshot = this.requireSnapshot(id);
          if (this.sessions.get(id)!.reducer.revision! <= afterRevision) return;
          const turnId = expectedTurnId ?? snapshot.latestTurnId;
          if (!turnId || (!steering && !expectedTurnId && turnId === previousTurnId)) return;
          if (!consumed) {
            const state = this.sessions.get(id)!.reducer.conversationState ?? {};
            const nativeTurn = Array.isArray(state.turns)
              ? asRecord(state.turns.findLast((turn) => (asRecord(turn).turnId ?? asRecord(turn).id) === turnId)) : {};
            const nativeItems = Array.isArray(nativeTurn.items) ? nativeTurn.items.map(asRecord) : [];
            const acceptedInput = snapshot.messages.findLast((message) => message.role === "user" && !previousUserIds.has(message.id)
              && message.time.completed != null && message.engineMeta?.codexTurnId === turnId
              && isAcceptedNativeInput(message, nativeItems, nativeClientMessageId)
              && message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim() === inputText
              && message.parts.filter((part) => part.type === "file" && part.mime.startsWith("image/")).length === imageCount);
            if (!acceptedInput) return;
            consumed = true;
            if (steering || clientMessageId) {
              this.emit("message.queued.consumed", { sessionId: id, messageId: acceptedInput.id,
                ...(clientMessageId ? { clientMessageId } : {}) });
            }
          }
          if (snapshot.isActive && (!snapshot.activeTurnId || snapshot.activeTurnId === turnId)) return;
          const message = snapshot.messages.findLast((entry) => entry.role === "assistant" && entry.engineMeta?.codexTurnId === turnId);
          if (message?.time.completed != null) finish(undefined, message);
        } catch (error) { finish(error instanceof Error ? error : new Error("Desktop unavailable")); }
      };
      const finish = (error?: Error, message?: UnifiedMessage) => {
        clearTimeout(timer);
        this.watchers.delete(check);
        if (error) reject(error); else resolve(message!);
      };
      this.watchers.add(check);
      check();
    });
  }

  private waitForState(id: string, predicate: (snapshot: DesktopConversationSnapshot, state: Record<string, unknown>) => boolean, timeoutMessage: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.watchers.delete(check);
        if (error) reject(error); else resolve();
      };
      const check = () => {
        try {
          const snapshot = this.requireSnapshot(id);
          if (predicate(snapshot, this.sessions.get(id)!.reducer.conversationState ?? {})) finish();
        } catch (error) { finish(error instanceof Error ? error : new Error("Desktop unavailable")); }
      };
      const timer = setTimeout(() => finish(new Error(timeoutMessage)), this.options.syncTimeoutMs ?? 10_000);
      this.watchers.add(check);
      check();
    });
  }

  private markUnavailable(error: string): void {
    this.readOwnerMisses.clear();
    this.lastError = error;
    this.status = this.stopped ? "stopped" : "error";
    for (const entry of this.sessions.values()) entry.available = false;
    this.publishAvailability();
    this.emit("status.changed", { engineType: this.engineType, status: this.status, error });
  }
  private publishAvailability(): void {
    for (const entry of this.sessions.values()) {
      if (!entry.available && entry.reducer.snapshot) this.emit("session.updated", { session: this.unavailableSession(entry.reducer.snapshot) });
    }
    this.notifyWatchers();
  }
  private unavailableSession(snapshot: DesktopConversationSnapshot): UnifiedSession {
    // Completed or interrupted history keeps its native outcome when its owner
    // goes away. Unfinished work still needs attention until a fresh follow.
    return snapshot.isActive || snapshot.pendingRequests.length > 0 || this.visibleQuestions(snapshot).length > 0
      ? { ...snapshot.session, activityStatus: "error" }
      : snapshot.session;
  }
  private notifyWatchers(): void { for (const watcher of [...this.watchers]) watcher(); }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isAcceptedNativeInput(message: UnifiedMessage, items: Record<string, unknown>[], clientMessageId: string): boolean {
  const item = items.find((entry) => entry.id === message.engineMeta?.codexItemId);
  // Native snapshots can replace the steering placeholder with its server user
  // item. The retained receipt still owns its original client correlation.
  const receipt = item?.type === "userMessage"
    ? items.find((entry) => entry.type === "steeringUserMessage" && entry.serverUserMessageId === item.id)
    : item;
  if (receipt?.type === "steeringUserMessage" && receipt.status !== "accepted") return false;
  const nativeClientId = receipt?.clientUserMessageId ?? item?.clientUserMessageId ?? item?.clientId ?? message.engineMeta?.clientUserMessageId;
  return nativeClientId == null || nativeClientId === clientMessageId;
}

function archivedThreadError(): Error & { code: string } {
  return Object.assign(new Error("Archived Codex conversations are not synchronized."), { code: "CODEX_THREAD_ARCHIVED" });
}

function isArchivedThreadError(error: unknown): boolean {
  return asRecord(error).code === "CODEX_THREAD_ARCHIVED";
}

function readTurnId(value: unknown, depth = 0): string | undefined {
  if (depth > 3 || !value || typeof value !== "object") return undefined;
  const result = value as Record<string, unknown>;
  if (typeof result.turnId === "string") return result.turnId;
  if (result.turn && typeof result.turn === "object" && typeof (result.turn as Record<string, unknown>).id === "string") return (result.turn as { id: string }).id;
  return readTurnId(result.result, depth + 1);
}
