import type { ImportableSession, ModelListResult, EngineCatalogSnapshot, UnifiedMessage, UnifiedSession } from "../../../../src/types/unified";
import { isDefaultTitle } from "../../../../src/lib/session-utils";
import type { CodexDesktopCatalog } from "./desktop-catalog";
import { CodexAdapter, createCodexDesktopOwnerRuntime } from "./index";
import { CodexDesktopAdapter, type DesktopStoredThread, type DesktopCreatedThread } from "./desktop-adapter";
import { CodexDesktopIpcClient } from "./desktop-ipc-client";
import { CodexDesktopOwner } from "./desktop-owner";
import { verifyCodexRolloutPath } from "./desktop-rollout-path";

export interface CodexDesktopSharingOptions {
  /** Backend-only identity for the unified Codex engine. */
  engineType?: "codex" | "codex-desktop";
  listCandidates?: (limit: number) => Promise<ImportableSession[]>;
  listModelCatalog?: () => Promise<ModelListResult>;
  /** Writes a stored title once, verifies it, and confirms the thread is unarchived. Never resumes it. */
  renameStoredThread?: (threadId: string, title: string) => Promise<void>;
  readStoredThread?: (threadId: string) => Promise<DesktopStoredThread>;
  archiveStoredThread?: (threadId: string) => Promise<DesktopStoredThread["thread"]>;
  unarchiveStoredThread?: (threadId: string) => Promise<DesktopStoredThread["thread"]>;
  /** Created lazily after the application has acquired its single-instance lock. */
  catalogFactory?: () => CodexDesktopCatalog;
  /** Kept off until the official Desktop project UI has a supported write-through path. */
  catalogManagement?: boolean;
  /** Must be dedicated to this service and never registered with EngineManager. */
  privateExecutionAdapter?: CodexAdapter;
  /** A caller-owned runtime can keep executing after the sharing bridge detaches. */
  stopExecutionOnStop?: boolean;
  ownerClient?: CodexDesktopIpcClient;
  followerClient?: CodexDesktopIpcClient;
  turnTimeoutMs?: number;
  syncTimeoutMs?: number;
  refreshDelayMs?: number;
  onError?: (threadId: string, error: Error) => void;
}

/**
 * One private execution adapter owns CodeMux-created threads. EngineManager sees
 * only the authoritative IPC follower, including for those locally owned threads.
 * Official Desktop-owned threads never enter the private execution adapter.
 */
export class CodexDesktopSharingService {
  readonly adapter: CodexDesktopAdapter;
  private readonly execution: CodexAdapter;
  private readonly stopExecutionOnStop: boolean;
  private readonly ownerClient: CodexDesktopIpcClient;
  private readonly followerClient: CodexDesktopIpcClient;
  private readonly owner: CodexDesktopOwner;
  private readonly renameStoredThread: CodexDesktopSharingOptions["renameStoredThread"];
  private readonly lifecycle: Pick<CodexDesktopSharingOptions, "readStoredThread" | "archiveStoredThread" | "unarchiveStoredThread">;
  private readonly syncTimeoutMs: number;
  private readonly ownedThreads = new Map<string, string>();
  private readonly pendingCreatedAnnouncements = new Set<string>();
  private readonly observedCreatedUserMessages = new Set<string>();
  private readonly announcingCreatedThreads = new Set<string>();
  private readonly reportAnnouncementError: CodexDesktopSharingOptions["onError"];
  private readonly restores = new Map<string, Promise<string>>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly acquisitions = new Map<string, Promise<{ threadId: string; owned: boolean }>>();
  private readonly attachments = new Map<string, Promise<UnifiedSession>>();
  private readonly catalogFactory: CodexDesktopSharingOptions["catalogFactory"];
  private catalog?: CodexDesktopCatalog;
  private catalogStarting?: Promise<void>;
  private unsubscribeCatalog?: () => void;
  private executionUsed = false;
  private stopped = false;
  private stopping: Promise<void> | undefined;

  constructor(options: CodexDesktopSharingOptions = {}) {
    this.execution = options.privateExecutionAdapter ?? new CodexAdapter();
    this.stopExecutionOnStop = options.stopExecutionOnStop !== false;
    this.ownerClient = options.ownerClient ?? new CodexDesktopIpcClient();
    const followerClient = options.followerClient ?? new CodexDesktopIpcClient();
    this.followerClient = followerClient;
    this.renameStoredThread = options.renameStoredThread;
    this.lifecycle = options;
    this.catalogFactory = options.catalogFactory;
    this.reportAnnouncementError = options.onError;
    this.syncTimeoutMs = options.syncTimeoutMs ?? 10_000;
    if (followerClient === this.ownerClient) throw new Error("Desktop sharing requires separate owner and follower IPC connections");
    this.owner = new CodexDesktopOwner(this.ownerClient, createCodexDesktopOwnerRuntime(this.execution), {
      refreshDelayMs: options.refreshDelayMs,
      onError: options.onError,
    });
    this.adapter = new CodexDesktopAdapter({
      engineType: options.engineType,
      client: followerClient,
      turnTimeoutMs: options.turnTimeoutMs,
      syncTimeoutMs: options.syncTimeoutMs,
      listModelCatalog: options.listModelCatalog,
      renameThread: (threadId, title, ownerClientId) => this.track(this.renameThread(threadId, title, ownerClientId)),
      readStoredThread: options.readStoredThread ? (threadId) => this.track(this.readStoredThread(threadId)) : undefined,
      setThreadArchived: options.readStoredThread && options.archiveStoredThread
        ? (threadId, archived, meta) => this.track(this.setThreadArchived(threadId, archived, meta)) : undefined,
      discardThread: (threadId) => this.track(this.discardThread(threadId)),
      catalog: options.catalogFactory ? {
        managementAvailable: options.catalogManagement === true,
        getCatalog: () => this.track(this.getCatalog()),
        stop: () => this.stopCatalog(),
        createProject: (input) => this.track(this.withCatalog((catalog) => catalog.createProject(input))),
        updateProject: (id, patch) => this.track(this.withCatalog((catalog) => catalog.updateProject(id, patch))),
        moveProject: (id, beforeId) => this.track(this.withCatalog((catalog) => catalog.moveProject(id, beforeId))),
        deleteProject: (id) => this.track(this.withCatalog((catalog) => catalog.deleteProject(id))),
        assignThreadProject: (id, projectId) => this.track(this.withCatalog(async (catalog) => { await catalog.assignThreadProject(id, projectId); })),
      } : undefined,
      listCandidates: options.listCandidates ? async (limit) => (await options.listCandidates!(limit)).map((candidate) => {
        const threadId = typeof candidate.engineMeta?.codexThreadId === "string" ? candidate.engineMeta.codexThreadId : candidate.engineSessionId;
        return this.ownedThreads.has(threadId)
          ? { ...candidate, engineMeta: { ...candidate.engineMeta, codexDesktopOwner: "codemux" } }
          : candidate;
      }) : undefined,
      createThread: (directory, meta) => this.track(this.createThread(directory, meta)),
      restoreThread: (threadId, directory, meta) => this.restoreThread(threadId, directory, meta),
      acquireThread: options.catalogFactory ? (threadId) => this.acquireThread(threadId) : undefined,
    });
    this.adapter.on("message.updated", this.observeCreatedUserMessage);
  }

  /** Detaches external owners; caller-owned execution may explicitly outlive sharing. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.adapter.off("message.updated", this.observeCreatedUserMessage);
    this.pendingCreatedAnnouncements.clear();
    this.observedCreatedUserMessages.clear();
    this.stopping = (async () => {
      await this.adapter.stop();
      this.owner.dispose();
      this.ownerClient.close();
      await Promise.allSettled([...this.pending]);
      if (this.executionUsed && this.stopExecutionOnStop) await this.execution.stop();
    })();
    return this.stopping;
  }

  /** Publishes an existing writer without starting, resuming, or replacing it. */
  attachExistingSession(engineSessionId: string): Promise<UnifiedSession> {
    const pending = this.attachments.get(engineSessionId);
    if (pending) return pending;
    const operation = this.track(this.attachLoadedSession(engineSessionId));
    this.attachments.set(engineSessionId, operation);
    void operation.finally(() => { this.attachments.delete(engineSessionId); }).catch(() => {});
    return operation;
  }

  private async attachLoadedSession(engineSessionId: string): Promise<UnifiedSession> {
    this.assertRunning();
    if (!this.execution.hasSession(engineSessionId)) throw new Error("Sharing requires a session already loaded in this Codex runtime.");
    const session = await this.execution.getSession(engineSessionId);
    const threadId = session?.engineMeta?.codexThreadId;
    if (!session || typeof threadId !== "string" || !threadId) throw new Error("The loaded Codex session has no native thread identity.");
    const runtime = createCodexDesktopOwnerRuntime(this.execution);
    const metadata = await runtime.readMetadata!(engineSessionId);
    if (metadata.id !== threadId || metadata.canAcceptDirectInput !== true) {
      throw new Error("The loaded Codex runtime did not confirm exclusive input ownership.");
    }
    this.assertRunning();
    const existing = this.ownedThreads.get(threadId);
    if (existing && existing !== engineSessionId) throw new Error("The shared thread is already bound to another execution session.");
    // Registration verifies the IPC owner itself; repeating discovery adds the
    // router's full no-owner deadline before a thread can first be shared.
    await this.owner.registerCreatedThread(engineSessionId, threadId);
    if (this.stopped) this.owner.unregisterThread(threadId);
    this.assertRunning();
    this.ownedThreads.set(threadId, engineSessionId);
    this.executionUsed = true;
    if (existing) await this.owner.reconnect();
    return this.adapter.attachOwnedThread(threadId);
  }

  private async createThread(directory: string, meta?: Record<string, unknown>): Promise<string | DesktopCreatedThread> {
    this.assertRunning();
    if (meta?.catalogProjectId != null) {
      const catalog = await this.getCatalog();
      if (meta.catalogSourceId !== catalog.sourceId || !catalog.projects.some((project) => project.id === meta.catalogProjectId)) {
        throw new Error("The selected native project is not available in this catalog.");
      }
    }
    // Fail before native creation when Desktop's IPC router is unavailable.
    await this.ownerClient.connect();
    this.assertRunning();
    this.executionUsed = true;
    const session = meta
      ? await this.execution.createSession(directory, meta)
      : await this.execution.createSession(directory);
    let registered = false;
    try {
      this.assertRunning();
      const threadId = session.engineMeta?.codexThreadId;
      if (typeof threadId !== "string" || !threadId) throw new Error("The private Codex adapter did not return a native thread ID");
      if (typeof meta?.catalogSourceId === "string" && session.projectId !== (meta.catalogProjectId ?? null)) {
        throw new Error("The native runtime did not confirm the new conversation's project.");
      }
      if (this.catalogFactory) {
        const runtime = createCodexDesktopOwnerRuntime(this.execution);
        const metadata = await runtime.readMetadata!(session.id);
        this.assertRunning();
        if (metadata.id !== threadId) throw new Error("Native creation metadata changed the conversation identity.");
        const nativeTitle = typeof metadata.name === "string" ? metadata.name.trim() : "";
        const createdTitle = session.title?.trim();
        if ((!nativeTitle || isDefaultTitle(nativeTitle)) && (!createdTitle || isDefaultTitle(createdTitle))) {
          // A non-empty native name makes an empty thread durable without a model turn.
          const title = `New session - ${new Date(session.time.created).toISOString()}`;
          await this.execution.renameSession(session.id, title);
          const confirmed = await runtime.readMetadata!(session.id);
          if (confirmed.id !== threadId || confirmed.name !== title) throw new Error("The Codex runtime did not confirm the new conversation's default title.");
          if (await verifyCodexRolloutPath(threadId, confirmed) !== "active") throw new Error("The Codex runtime did not persist the new conversation's default title.");
        }
        await this.withCatalog((catalog) => catalog.admitCreatedThread(threadId));
      }
      this.assertRunning();
      await this.owner.registerCreatedThread(session.id, threadId);
      registered = true;
      this.ownedThreads.set(threadId, session.id);
      this.pendingCreatedAnnouncements.add(threadId);
      return typeof meta?.catalogSourceId === "string"
        ? { threadId, catalogSourceId: meta.catalogSourceId, projectId: session.projectId ?? null }
        : threadId;
    } finally {
      if (!registered) await this.execution.deleteSession(session.id);
    }
  }

  private async renameThread(threadId: string, title: string, ownerClientId?: string): Promise<void> {
    this.assertRunning();
    if (!ownerClientId) {
      const catalog = await this.getCatalog();
      if (!catalog.sessions.some((session) => session.id === threadId && !session.archived)) {
        throw new Error("This legacy or unavailable conversation is not enrolled in catalog synchronization.");
      }
      if (!this.renameStoredThread) throw new Error("Stored conversation renaming is unavailable.");
      await this.renameStoredThread(threadId, title);
      const refreshed = await this.catalog!.refresh();
      if (refreshed.sessions.find((session) => session.id === threadId)?.title?.trim() !== title) throw new Error("The stored title did not synchronize.");
      this.followerClient.notifyThreadUnarchived(threadId);
      return;
    }
    this.assertFollowedOwner(threadId, ownerClientId);
    const currentOwner = await this.followerClient.discoverOwner(threadId);
    this.assertRunning();
    if (currentOwner?.ownerClientId !== ownerClientId) throw new Error("The conversation owner changed before its title could be updated.");
    this.assertFollowedOwner(threadId, ownerClientId);
    const engineSessionId = this.ownedThreads.get(threadId);
    if (engineSessionId && ownerClientId === this.ownerClient.clientId) {
      await this.execution.renameSession(engineSessionId, title);
      const native = await createCodexDesktopOwnerRuntime(this.execution).readThread(engineSessionId);
      if ((typeof native.thread.name === "string" ? native.thread.name : "").trim() !== title) {
        throw new Error("The Codex runtime did not confirm the new title.");
      }
      this.assertRunning();
      await this.owner.refresh(threadId);
      return;
    }
    if (!this.renameStoredThread) throw new Error("Renaming a Desktop-owned conversation is unavailable in this installation.");
    await this.renameStoredThread(threadId, title);
    try {
      this.assertRunning();
      const ownerAfterWrite = await this.followerClient.discoverOwner(threadId);
      if (ownerAfterWrite?.ownerClientId !== ownerClientId) throw new Error("The conversation owner changed after the title was stored.");
      this.assertFollowedOwner(threadId, ownerClientId);
      this.followerClient.notifyThreadMetadataAvailable(threadId, ownerClientId);
      // Availability delivery has no acknowledgement and does not itself push
      // the changed title. Read snapshots until the original owner confirms it.
      const deadline = Date.now() + this.syncTimeoutMs;
      for (;;) {
        this.assertRunning();
        this.assertFollowedOwner(threadId, ownerClientId);
        if (Date.now() >= deadline) throw new Error("Desktop metadata synchronization timed out");
        await beforeDeadline(this.followerClient.loadCompleteHistory(threadId, ownerClientId), deadline);
        this.assertRunning();
        this.assertFollowedOwner(threadId, ownerClientId);
        const session = (await this.adapter.listSessions()).find((session) => session.id === threadId);
        if ((session?.title ?? "").trim() === title) return;
        await beforeDeadline(new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now())))), deadline);
      }
    } catch (error) {
      throw new Error("The title was stored, but its synchronization with Codex Desktop was not confirmed.", { cause: error });
    }
  }

  private assertFollowedOwner(threadId: string, ownerClientId: string): void {
    if (!this.followerClient.isFollowingThread(threadId, ownerClientId)) throw new Error("The conversation is no longer synchronized with its original owner.");
  }

  private readonly observeCreatedUserMessage = ({ sessionId, message }: { sessionId: string; message: UnifiedMessage }): void => {
    if (this.stopped || message.role !== "user" || message.sessionId !== sessionId || !this.pendingCreatedAnnouncements.has(sessionId)) return;
    this.observedCreatedUserMessages.add(sessionId);
    this.announceCreatedThreadIfReady(sessionId, this.catalog?.getSnapshot());
  };

  private announceCreatedThreadIfReady(threadId: string, catalog: EngineCatalogSnapshot | undefined): void {
    if (this.stopped || !catalog?.complete || !this.pendingCreatedAnnouncements.has(threadId) || this.announcingCreatedThreads.has(threadId)) return;
    const candidate = catalog?.sessions.find((session) => session.id === threadId);
    if (candidate?.archived) {
      this.pendingCreatedAnnouncements.delete(threadId);
      this.observedCreatedUserMessages.delete(threadId);
      return;
    }
    const ownerId = this.ownerClient.clientId;
    const engineSessionId = this.ownedThreads.get(threadId);
    if (!candidate || candidate.archived !== false || !this.observedCreatedUserMessages.has(threadId) || !this.ownerClient.connected || !ownerId || !engineSessionId
      || !this.execution.hasSession(engineSessionId) || !this.followerClient.isFollowingThread(threadId, ownerId)) return;
    this.announcingCreatedThreads.add(threadId);
    try {
      // The catalog confirms stored/unarchived membership; a user item observed
      // through the follower confirms this is no longer only an empty draft.
      // This announces availability once, without claiming a Desktop UI ACK.
      this.followerClient.notifyThreadUnarchived(threadId);
      this.pendingCreatedAnnouncements.delete(threadId);
      this.observedCreatedUserMessages.delete(threadId);
    } catch (error) {
      this.reportAnnouncementError?.(threadId, error instanceof Error ? error : new Error("Thread availability announcement failed"));
    } finally {
      this.announcingCreatedThreads.delete(threadId);
    }
  }

  private async readStoredThread(threadId: string): Promise<DesktopStoredThread> {
    this.assertRunning();
    const engineSessionId = this.ownedThreads.get(threadId);
    const stored = engineSessionId && this.execution.hasSession(engineSessionId)
      ? await this.execution.readStoredThread(threadId, { activeOnly: true })
      : await this.lifecycle.readStoredThread!(threadId);
    if (stored.thread.id !== threadId || typeof stored.archived !== "boolean") throw new Error("Stored Codex thread identity or archive state did not match");
    return stored;
  }

  private async setThreadArchived(threadId: string, archived: boolean, _meta: Record<string, unknown>): Promise<DesktopStoredThread> {
    this.assertRunning();
    if (!archived) throw new Error("Archived Codex conversations cannot be restored through CodeMux.");
    await this.followerClient.connect();
    this.assertRunning();
    const engineSessionId = this.ownedThreads.get(threadId);
    // These native methods verify metadata and archive location before returning.
    // A foreign writer refusal must preserve its owner and the local conversation.
    const stored = engineSessionId
      ? await this.execution.archiveStoredThread(threadId)
      : await this.lifecycle.archiveStoredThread!(threadId);
    if (stored.id !== threadId) throw new Error("Native archive returned a different Codex thread");
    if (engineSessionId) await this.discardThread(threadId);
    this.assertRunning();
    this.pendingCreatedAnnouncements.delete(threadId);
    this.observedCreatedUserMessages.delete(threadId);
    if (typeof stored.cwd !== "string") throw new Error("The archived thread has no verified working directory");
    this.followerClient.notifyThreadArchived(threadId, stored.cwd);
    try { await this.catalog?.refresh(); }
    catch (error) { this.reportAnnouncementError?.(threadId, error instanceof Error ? error : new Error("Catalog refresh after archive failed")); }
    return { thread: stored, archived: true };
  }

  private async discardThread(threadId: string): Promise<void> {
    this.assertRunning();
    const engineSessionId = this.ownedThreads.get(threadId);
    if (engineSessionId) {
      this.owner.unregisterThread(threadId);
      try { await this.execution.deleteSession(engineSessionId); }
      finally { this.ownedThreads.delete(threadId); }
    }
    this.pendingCreatedAnnouncements.delete(threadId);
    this.observedCreatedUserMessages.delete(threadId);
  }

  private async withCatalog<T>(operation: (catalog: CodexDesktopCatalog) => Promise<T>): Promise<T> {
    await this.getCatalog();
    this.assertRunning();
    return operation(this.catalog!);
  }

  private async getCatalog(): Promise<EngineCatalogSnapshot> {
    this.assertRunning();
    if (!this.catalogFactory) throw new Error("Canonical catalog synchronization is unavailable.");
    if (!this.catalog) {
      const catalog = this.catalogFactory();
      this.catalog = catalog;
      this.unsubscribeCatalog = catalog.subscribe((snapshot) => {
        if (!this.stopped && this.catalog === catalog) {
          this.adapter.publishCatalog(snapshot);
          for (const threadId of this.pendingCreatedAnnouncements) this.announceCreatedThreadIfReady(threadId, snapshot);
        }
      });
      const starting = catalog.start().finally(() => {
        if (this.catalogStarting === starting) this.catalogStarting = undefined;
      });
      this.catalogStarting = starting;
    }
    if (this.catalogStarting) await this.catalogStarting;
    this.assertRunning();
    if (!this.catalog) throw new Error("Catalog synchronization has stopped.");
    return this.catalog.getSnapshot() ?? await this.catalog.refresh();
  }

  private async stopCatalog(): Promise<void> {
    const catalog = this.catalog;
    this.catalog = undefined;
    this.catalogStarting = undefined;
    this.unsubscribeCatalog?.();
    this.unsubscribeCatalog = undefined;
    await catalog?.stop();
  }

  private acquireThread(threadId: string): Promise<{ threadId: string; owned: boolean }> {
    const pending = this.acquisitions.get(threadId);
    if (pending) return pending;
    const operation = this.track(this.acquireForExplicitInput(threadId));
    this.acquisitions.set(threadId, operation);
    void operation.finally(() => { if (this.acquisitions.get(threadId) === operation) this.acquisitions.delete(threadId); }).catch(() => {});
    return operation;
  }

  /** Native writer locking, not absent IPC discovery, decides whether acquisition is safe. */
  private async acquireForExplicitInput(threadId: string): Promise<{ threadId: string; owned: boolean }> {
    await this.getCatalog();
    const snapshot = await this.catalog!.refresh();
    const candidate = snapshot.sessions.find((session) => session.id === threadId);
    if (!candidate || candidate.archived) throw new Error("Only an enrolled, unarchived conversation can be continued here.");
    await this.ownerClient.connect();
    this.assertRunning();
    const currentOwner = await this.ownerClient.discoverOwner(threadId);
    if (currentOwner && currentOwner.ownerClientId !== this.ownerClient.clientId) return { threadId, owned: false };
    const existing = this.ownedThreads.get(threadId);
    if (existing && this.execution.hasSession(existing)) {
      // IPC disconnect clears registrations while the native writer stays loaded.
      await this.owner.reconnect();
      await this.followerClient.connect();
      const reconnectedOwner = await this.followerClient.discoverOwner(threadId);
      this.assertRunning();
      if (!reconnectedOwner) throw new Error("The loaded Codex writer did not reconnect to Desktop IPC.");
      return { threadId, owned: reconnectedOwner.ownerClientId === this.ownerClient.clientId };
    }
    this.executionUsed = true;
    const session = await this.execution.createSession(candidate.directory, { codexThreadId: threadId, codexDesktopOwner: "codemux" });
    let registered = false;
    try {
      this.assertRunning();
      if (session.engineMeta?.codexThreadId !== threadId) throw new Error("Native acquisition changed the conversation identity.");
      const runtime = createCodexDesktopOwnerRuntime(this.execution);
      const metadata = await runtime.readMetadata!(session.id);
      if (metadata.id !== threadId || metadata.canAcceptDirectInput !== true) throw new Error("The native runtime did not confirm exclusive input ownership.");
      await this.owner.registerCreatedThread(session.id, threadId);
      this.ownedThreads.set(threadId, session.id);
      registered = true;
      return { threadId, owned: true };
    } finally {
      if (!registered) await this.execution.deleteSession(session.id);
    }
  }

  private restoreThread(threadId: string, directory: string, meta: Record<string, unknown>): Promise<string> {
    const existing = this.restores.get(threadId);
    if (existing) return existing;
    const operation = this.track(this.restore(threadId, directory, meta));
    this.restores.set(threadId, operation);
    void operation.finally(() => { if (this.restores.get(threadId) === operation) this.restores.delete(threadId); }).catch(() => {});
    return operation;
  }

  private async restore(threadId: string, directory: string, meta: Record<string, unknown>): Promise<string> {
    this.assertRunning();
    if (meta.codexDesktopOwner !== "codemux" || meta.codexThreadId !== threadId) {
      throw new Error("Only explicitly marked CodeMux-owned threads may be restored");
    }
    await this.ownerClient.connect();
    this.assertRunning();
    const currentOwner = await this.ownerClient.discoverOwner(threadId);
    if (currentOwner && currentOwner.ownerClientId !== this.ownerClient.clientId) {
      // The same original thread may have been continued in official Desktop.
      // Follow that live owner; do not load a competing execution in CodeMux.
      return threadId;
    }
    const existingSessionId = this.ownedThreads.get(threadId);
    if (existingSessionId && this.execution.hasSession(existingSessionId)) {
      await this.owner.reconnect();
      return threadId;
    }
    if (this.lifecycle.readStoredThread && (await this.readStoredThread(threadId)).archived) {
      throw new Error("The Codex thread is archived. Restore it explicitly before reconnecting its runtime.");
    }
    this.executionUsed = true;
    const session = await this.execution.createSession(directory, {
      ...meta, codexThreadId: threadId, codexDesktopOwner: "codemux",
    });
    this.assertRunning();
    if (session.engineMeta?.codexThreadId !== threadId) throw new Error("CodeMux-owned restore did not preserve the native thread ID");
    await this.owner.registerCreatedThread(session.id, threadId);
    this.ownedThreads.set(threadId, session.id);
    return threadId;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    void operation.finally(() => { this.pending.delete(operation); }).catch(() => {});
    return operation;
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error("Codex Desktop sharing service is stopped");
  }
}

export function createCodexDesktopSharing(options: CodexDesktopSharingOptions = {}): CodexDesktopSharingService {
  return new CodexDesktopSharingService(options);
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Desktop metadata synchronization timed out")), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
