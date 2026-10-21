import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  CatalogProjectInput, CatalogProjectPatch, CodexServiceTier, CommandInvokeResult,
  EngineCapabilities, EngineCatalogSnapshot, EngineInfo, EngineSharingState, EngineStatus,
  ImportableSession, MessagePromptContent, PermissionReply, ReasoningEffort,
  UnifiedMessage, UnifiedPermission, UnifiedProject, UnifiedQuestion, UnifiedSession,
} from "../../../../src/types/unified";
import { EngineAdapter } from "../engine-adapter";
import { CODEX_MODES, toCodexEffort } from "./config";
import { CodexAdapter } from "./index";
import { CodexDesktopAdapter, type DesktopStoredThread } from "./desktop-adapter";
import type { CodexDesktopCatalog } from "./desktop-catalog";
import { CodexDesktopIpcClient } from "./desktop-ipc-client";
import { buildDesktopOwnerState, CodexDesktopOwner, type CodexDesktopOwnerRuntime, type NativeOwnedThreadState } from "./desktop-owner";
import { convertDesktopConversation, type DesktopConversationSnapshot } from "./desktop-state";
import { CodexRuntimeResolver, type CodexRuntimeIdentity } from "./runtime-selection";

type SendOptions = Parameters<EngineAdapter["sendMessage"]>[2];

export interface UnifiedCodexAdapterOptions {
  sharingEnabled?: boolean;
  /** Identity of the native home used by the execution factory and IPC router. */
  codexHome?: string;
  /** Existing enrollment identity; keep its spelling across the engine rename. */
  catalogSourceId?: string;
  /** Persisted native identities already visible in this source before startup. */
  knownThreadIds?: () => readonly string[];
  persistSharingEnabled?: (enabled: boolean) => Promise<void> | void;
  runtimeResolver?: Pick<CodexRuntimeResolver, "resolve">;
  createRuntime?: (identity: CodexRuntimeIdentity) => CodexAdapter;
  followerClient?: CodexDesktopIpcClient;
  createOwnerClient?: () => CodexDesktopIpcClient;
  listCandidates?: (limit: number) => Promise<ImportableSession[]>;
  readStoredThread?: (threadId: string) => Promise<DesktopStoredThread>;
  renameStoredThread?: (threadId: string, title: string) => Promise<void>;
  archiveStoredThread?: (threadId: string) => Promise<DesktopStoredThread["thread"]>;
  catalogFactory?: () => CodexDesktopCatalog;
  catalogManagement?: boolean;
  refreshDelayMs?: number;
  reconnectDelayMs?: number;
  turnTimeoutMs?: number;
  syncTimeoutMs?: number;
  onError?: (threadId: string, error: Error) => void;
}

interface LocalRuntime {
  identity: CodexRuntimeIdentity;
  execution: CodexAdapter;
  native: CodexDesktopOwnerRuntime;
  owner: CodexDesktopOwner;
  client: CodexDesktopIpcClient;
  unsubscribe: () => void;
}

interface LocalSession {
  runtime: LocalRuntime;
  engineSessionId: string;
  session: UnifiedSession;
  snapshot?: DesktopConversationSnapshot;
  refresh?: Promise<DesktopConversationSnapshot>;
  refreshAgain: boolean;
  timer?: ReturnType<typeof setTimeout>;
  shared: boolean;
  /** Created here but not yet written to native storage, catalog, or sharing. */
  draft?: boolean;
  materializing?: Promise<void>;
}

type InputRoute = { kind: "local"; session: LocalSession } | { kind: "foreign" };

interface PendingRoute {
  runtime: LocalRuntime;
  sessionId: string;
  requestId: string;
}

/**
 * A stable public engine over native Codex identities. Sharing changes transport,
 * never the local writer. Both paths project native items with the same IDs.
 */
export class UnifiedCodexAdapter extends EngineAdapter {
  readonly engineType = "codex" as const;
  private readonly resolver: Pick<CodexRuntimeResolver, "resolve">;
  private readonly codexHome: string;
  private readonly catalogSourceId: string;
  private readonly followerClient: CodexDesktopIpcClient;
  private readonly follower: CodexDesktopAdapter;
  private readonly runtimes = new Map<string, LocalRuntime>();
  private readonly runtimeStarts = new Map<string, Promise<LocalRuntime>>();
  private readonly locals = new Map<string, LocalSession>();
  private readonly inputRoutes = new Map<string, Promise<InputRoute>>();
  private readonly sessions = new Map<string, UnifiedSession>();
  private readonly pendingPermissions = new Map<string, PendingRoute>();
  private readonly pendingQuestions = new Map<string, PendingRoute>();
  private readonly announced = new Set<string>();
  private status: EngineStatus = "stopped";
  private sharingEnabled: boolean;
  private sharingError?: string;
  private sharingTransition?: Promise<EngineSharingState>;
  private sharingConnection?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private defaultRuntime?: LocalRuntime;
  private starting?: Promise<void>;
  private catalog?: CodexDesktopCatalog;
  private catalogStarting?: Promise<void>;
  private unsubscribeCatalog?: () => void;
  private generation = 0;

  constructor(private readonly options: UnifiedCodexAdapterOptions = {}) {
    super();
    this.sharingEnabled = options.sharingEnabled === true;
    this.codexHome = canonicalHome(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
    this.catalogSourceId = options.catalogSourceId ?? `codex-desktop:local:${createHash("sha256").update(this.codexHome).digest("hex").slice(0, 20)}`;
    this.resolver = options.runtimeResolver ?? new CodexRuntimeResolver({ preferDesktop: true, codexHome: this.codexHome });
    this.followerClient = options.followerClient ?? new CodexDesktopIpcClient({ codexHome: this.codexHome });
    this.follower = new CodexDesktopAdapter({
      engineType: "codex", client: this.followerClient,
      listCandidates: options.listCandidates,
      readStoredThread: (id) => this.readStoredThread(id),
      listModelCatalog: () => this.listModels(),
      renameThread: (id, title, ownerId) => this.renameForeignThread(id, title, ownerId),
      setThreadArchived: (id, archived) => this.archiveThread(id, archived),
      acquireThread: async (id) => {
        const route = await this.routeForInput(id);
        return { threadId: id, owned: route.kind === "local" };
      },
      turnTimeoutMs: options.turnTimeoutMs, syncTimeoutMs: options.syncTimeoutMs,
      catalog: options.catalogFactory ? {
        managementAvailable: options.catalogManagement,
        getCatalog: () => this.getCatalog(), stop: async () => {},
        createProject: (input) => this.createProject(input),
        updateProject: (id, patch) => this.updateProject(id, patch),
        moveProject: (id, beforeId) => this.moveProject(id, beforeId),
        deleteProject: (id) => this.deleteCatalogProject(id),
        assignThreadProject: (id, projectId) => this.setSessionProject(id, projectId),
      } : undefined,
    });
    this.bindFollower();
  }

  async start(): Promise<void> {
    if (this.status === "running") return;
    if (this.starting) return this.starting;
    const generation = this.generation;
    this.status = "starting";
    this.starting = (async () => {
      try {
        this.defaultRuntime = await this.runtimeFor();
        if (generation !== this.generation) throw new Error("The Codex engine stopped while it was starting.");
        this.status = "running";
        this.emit("status.changed", { engineType: this.engineType, status: this.status });
        if (this.sharingEnabled) await this.connectSharing();
      } catch (error) {
        if (generation === this.generation) {
          this.status = "error";
          this.emit("status.changed", { engineType: this.engineType, status: this.status, error: errorMessage(error) });
        }
        throw error;
      }
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.status = "stopped";
    this.clearReconnect();
    // Runtime creation can already be awaiting initialization. Finish that
    // bounded operation before closing its resources, rather than orphan it.
    await Promise.allSettled([...this.runtimeStarts.values()]);
    await this.follower.stop();
    this.unsubscribeCatalog?.();
    this.unsubscribeCatalog = undefined;
    await this.catalog?.stop();
    this.catalog = undefined;
    for (const local of this.locals.values()) if (local.timer) clearTimeout(local.timer);
    for (const runtime of this.runtimes.values()) {
      runtime.unsubscribe();
      runtime.owner.dispose();
      runtime.client.close();
    }
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.execution.stop()));
    this.locals.clear();
    this.runtimes.clear();
    this.defaultRuntime = undefined;
    this.pendingPermissions.clear();
    this.pendingQuestions.clear();
    this.emit("status.changed", { engineType: this.engineType, status: this.status });
  }

  async healthCheck(): Promise<boolean> { return this.defaultRuntime?.execution.healthCheck() ?? false; }
  getStatus(): EngineStatus { return this.status; }
  getInfo(): EngineInfo {
    return { ...this.defaultRuntime?.execution.getInfo(), type: "codex", name: "Codex", status: this.status, capabilities: this.getCapabilities(), sessionSharing: this.getSessionSharing() };
  }
  getCapabilities(): EngineCapabilities {
    return {
      ...this.defaultRuntime?.execution.getCapabilities(),
      reasoningEffortOptions: ["low", "medium", "high", "max", "ultra"],
      authoritativeSessionState: true, questionDismissStopsTurn: true,
      sessionSharing: true,
      sessionCatalog: !!this.options.catalogFactory, catalogManagement: this.options.catalogManagement === true,
      confirmedSessionRemoval: true, hideArchivedSessions: true, sessionArchive: false,
      providerModelHierarchy: false, dynamicModes: true, messageCancellation: true,
      permissionAlways: true, imageAttachment: true, loadSession: true, listSessions: true,
      modelSwitchable: true, customModelInput: true, messageEnqueue: true, slashCommands: true,
      availableModes: this.getModes(),
    };
  }
  getAuthMethods() { return this.defaultRuntime?.execution.getAuthMethods() ?? []; }
  getModes() { return CODEX_MODES; }
  getSessionSharing(): EngineSharingState {
    return {
      enabled: this.sharingEnabled, available: this.followerClient.connected && !this.sharingError,
      status: !this.sharingEnabled ? "disabled" : this.sharingError ? "unavailable"
        : this.followerClient.connected ? "connected" : this.sharingTransition || this.sharingConnection ? "connecting" : "unavailable",
      peerName: "Codex Desktop", ...(this.sharingError ? { error: this.sharingError } : {}),
    };
  }
  async setSessionSharing(enabled: boolean): Promise<EngineSharingState> {
    if (this.sharingTransition) await this.sharingTransition;
    await this.options.persistSharingEnabled?.(enabled);
    this.sharingEnabled = enabled;
    this.clearReconnect();
    const transition = (async () => {
      if (enabled) await this.connectSharing();
      else {
        this.sharingError = undefined;
        // Keep the owners and their queued input alive; closing IPC only removes
        // external access, while already accepted work stays with its writer.
        for (const runtime of this.runtimes.values()) runtime.client.close();
        await this.follower.stop();
        for (const local of this.locals.values()) local.shared = false;
      }
      this.publishConnections();
      if (this.options.catalogFactory) {
        const catalog = await this.requireCatalog();
        // A toggle changes visibility even when native storage has not changed.
        const snapshot = this.decorateCatalog(await catalog.refresh());
        this.follower.publishCatalog(snapshot);
        this.emit("catalog.updated", snapshot);
      }
    })();
    this.sharingTransition = transition.then(() => this.getSessionSharing());
    try { await this.sharingTransition; }
    finally { this.sharingTransition = undefined; }
    return this.getSessionSharing();
  }

  hasSession(id: string): boolean {
    const nativeId = nativeThreadId(id);
    const local = this.locals.get(nativeId);
    return local ? local.runtime.execution.hasSession(local.engineSessionId)
      : this.sharingEnabled && this.follower.hasSession(nativeId);
  }
  override assertSessionCompatible(id: string, meta?: Record<string, unknown>): void {
    const fail = () => { throw Object.assign(new Error("This conversation belongs to another Codex source. Its history was preserved; connect its original source to continue."), { code: "CODEX_SESSION_SOURCE_MISMATCH" }); };
    for (const key of ["sourceId", "catalogSourceId"] as const) {
      if (meta?.[key] != null && (typeof meta[key] !== "string" || meta[key] !== this.catalogSourceId)) fail();
    }
    if (meta?.codexHome != null) {
      if (typeof meta.codexHome !== "string" || !meta.codexHome || meta.codexHome.includes("\0")) fail();
      if (canonicalHome(meta.codexHome as string) !== this.codexHome) fail();
    }
    if (meta?.desktopHostId != null && meta.desktopHostId !== "local") fail();
    if (id && meta?.codexThreadId != null && (typeof meta.codexThreadId !== "string" || nativeThreadId(meta.codexThreadId) !== nativeThreadId(id))) fail();
  }
  async listSessions(directory?: string): Promise<UnifiedSession[]> {
    for (const session of await this.follower.listSessions(directory)) {
      if (!this.locals.has(session.id)) this.rememberSession(this.decorateSession(session));
    }
    return [...this.sessions.values()].filter((session) => !session.archived && (!directory || session.directory === directory))
      .map((session) => this.decorateSession(session));
  }
  async createSession(directory: string, meta?: Record<string, unknown>): Promise<UnifiedSession> {
    const existingId = typeof meta?.codexThreadId === "string" ? nativeThreadId(meta.codexThreadId) : undefined;
    this.assertSessionCompatible(existingId ?? "", meta);
    if (existingId) return this.restoreSession(existingId, directory, meta);
    await this.start();
    if (meta?.catalogSourceId != null) {
      const catalog = await this.getCatalog();
      if (catalog.sourceId !== meta.catalogSourceId || (meta.catalogProjectId != null && !catalog.projects.some((project) => project.id === meta.catalogProjectId))) {
        throw new Error("The selected native project is not available in this catalog.");
      }
    }
    const runtime = this.defaultRuntime!;
    const created = await runtime.execution.createSession(directory, meta);
    const id = sessionThreadId(created);
    // Codex writes a new thread only with its first item. Until CodeMux sends
    // input, the conversation is a local draft: no native name, catalog
    // admission, or sharing registration, so creating and discarding it is cheap.
    const local = this.rememberLocal(runtime, created, { ...meta, codexOrigin: "CodeMux" });
    local.draft = true;
    const session = this.decorateSession(local.session);
    this.emit("session.created", { session });
    return session;
  }
  async restoreSession(id: string, directory: string, meta?: Record<string, unknown>): Promise<UnifiedSession> {
    this.assertSessionCompatible(id, meta);
    if (id.startsWith("codex_")) meta = { codexDesktopOwner: "codemux", ...meta };
    id = nativeThreadId(id);
    const local = this.locals.get(id);
    if (local) return (await this.refreshLocal(id, local)).session;
    // Restoring a selection is read-only. A writer is acquired only for explicit
    // input; an absent router is never evidence that a foreign writer is gone.
    if (meta) this.rememberSession({
      id, engineType: "codex", directory, time: { created: 0, updated: 0 }, engineMeta: { ...meta, codexThreadId: id },
    });
    if (this.sharingEnabled) {
      const session = await this.follower.restoreSession(id, directory, { ...meta, codexThreadId: id, catalogSourceId: meta?.catalogSourceId ?? "codex-local" });
      return this.rememberSession(this.decorateSession(session));
    }
    const stored = await this.readStoredThread(id);
    const snapshot = this.snapshotStored(stored);
    return this.rememberSession(this.decorateSession(snapshot.session));
  }
  async getSession(id: string): Promise<UnifiedSession | null> {
    id = nativeThreadId(id);
    const local = this.locals.get(id);
    if (local) return (await this.refreshLocal(id, local)).session;
    if (this.sharingEnabled) {
      const session = await this.follower.getSession(id);
      if (session) return this.rememberSession(this.decorateSession(session));
    }
    const session = this.sessions.get(id);
    return session ? this.decorateSession(session) : null;
  }
  async deleteSession(id: string): Promise<void> {
    id = nativeThreadId(id);
    const local = this.locals.get(id);
    if (local) {
      local.runtime.owner.unregisterThread(id);
      if (local.timer) clearTimeout(local.timer);
      await local.runtime.execution.deleteSession(local.engineSessionId);
      this.locals.delete(id);
    }
    await this.follower.deleteSession(id);
    this.sessions.delete(id);
  }
  async removeSession(id: string): Promise<"local" | "archived"> {
    id = nativeThreadId(id);
    const local = this.locals.get(id);
    if (!local && this.sharingEnabled) {
      // The follower hydrates complete history and verifies pending requests;
      // an incomplete empty-looking snapshot is not permission to discard it.
      const result = await this.follower.removeSession(id);
      this.sessions.delete(id);
      this.announced.delete(id);
      return result;
    }
    let snapshot: DesktopConversationSnapshot;
    if (local) snapshot = await this.refreshLocal(id, local);
    else {
      // Sharing-off removal must not reconnect an external transport. Native
      // storage still provides the full transcript and verifies archive writes.
      const stored = await this.readStoredThread(id);
      snapshot = this.snapshotStored(stored);
      if (asRecord(stored.thread.status).type === "active") snapshot.isActive = true;
    }
    if (snapshot.incompleteHistory) throw new Error("The complete conversation must be synchronized before removing it.");
    if (snapshot.isActive || snapshot.pendingRequests.length) throw new Error("Finish the current turn and pending interactions before removing this conversation.");
    if (snapshot.messages.length) {
      await this.archiveThread(id, true);
      await this.deleteSession(id);
      return "archived";
    }
    await this.deleteSession(id);
    return "local";
  }
  async renameSession(id: string, title: string): Promise<void> {
    id = nativeThreadId(id);
    const local = this.locals.get(id);
    if (!local) {
      if (this.sharingEnabled) { await this.requireSharing(); return this.follower.renameSession(id, title); }
      const rename = this.options.renameStoredThread ?? ((threadId: string, name: string) => this.runtimeFor().then((runtime) => runtime.execution.renameStoredThread(threadId, name)));
      await rename(id, title);
      const session = this.rememberSession(this.decorateSession(this.snapshotStored(await this.readStoredThread(id)).session));
      if (session.title?.trim() !== title.trim()) throw new Error("The Codex runtime did not confirm the new title.");
      this.emit("session.updated", { session });
      return;
    }
    await local.runtime.execution.renameSession(local.engineSessionId, title);
    // A native name persists an empty thread, so it is no longer a draft.
    await this.materialize(id, local);
    const snapshot = await this.refreshLocal(id, local);
    if (snapshot.session.title?.trim() !== title.trim()) throw new Error("The Codex runtime did not confirm the new title.");
  }

  async sendMessage(id: string, content: MessagePromptContent[], options?: SendOptions): Promise<UnifiedMessage> {
    id = nativeThreadId(id);
    const route = await this.routeForInput(id, options?.directory);
    if (route.kind === "foreign") return this.follower.sendMessage(id, content, options);
    const local = route.session;
    await this.materialize(id, local);
    const result = await local.runtime.execution.sendMessage(local.engineSessionId, content, await this.localInputOptions(local, options));
    const snapshot = await this.refreshLocal(id, local);
    return canonicalResponse(snapshot, result);
  }
  async cancelMessage(id: string, directory?: string): Promise<void> {
    id = nativeThreadId(id);
    const local = this.locals.get(id);
    if (!local) { await this.requireSharing(); return this.follower.cancelMessage(id); }
    await local.runtime.execution.cancelMessage(local.engineSessionId, directory);
    await this.refreshLocal(id, local);
  }
  async listMessages(id: string): Promise<UnifiedMessage[]> {
    id = nativeThreadId(id);
    const local = this.locals.get(id);
    if (local) return (await this.refreshLocal(id, local)).messages;
    if (this.sharingEnabled) return this.follower.listMessages(id);
    return this.snapshotStored(await this.readStoredThread(id)).messages;
  }
  async getHistoricalMessages(id: string, _directory: string, meta?: Record<string, unknown>): Promise<UnifiedMessage[]> {
    this.assertSessionCompatible(id, meta);
    return this.listMessages(typeof meta?.codexThreadId === "string" ? meta.codexThreadId : id);
  }
  async listHistoricalSessions(limit: number): Promise<ImportableSession[]> {
    const candidates = this.options.listCandidates ? await this.options.listCandidates(limit)
      : await (await this.runtimeFor()).execution.listHistoricalSessions(limit);
    const unique = new Map<string, ImportableSession>();
    for (const candidate of candidates) {
      if (candidate.archived) continue;
      const id = nativeThreadId(typeof candidate.engineMeta?.codexThreadId === "string" ? candidate.engineMeta.codexThreadId : candidate.engineSessionId);
      unique.set(id, { ...candidate, engineSessionId: id, alreadyImported: this.sessions.has(id), engineMeta: { ...candidate.engineMeta, codexThreadId: id } });
    }
    const ordered = [...unique.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    return limit > 0 ? ordered.slice(0, limit) : ordered;
  }
  async listModels() { return (await this.runtimeFor()).execution.listModels(); }
  async setModel(id: string, value: string): Promise<void> {
    await this.setting(id, (adapter, key) => adapter.setModel(key, value), (state) => ({ model: value,
      collaborationMode: { ...state.collaborationMode, settings: { ...asRecord(state.collaborationMode?.settings), model: value } } }));
  }
  async setMode(id: string, value: string): Promise<void> {
    await this.setting(id, (adapter, key) => adapter.setMode(key, value), (state) => ({
      collaborationMode: { ...state.collaborationMode, mode: value, settings: { model: state.model, reasoning_effort: state.reasoningEffort ?? null, ...asRecord(state.collaborationMode?.settings) } },
    }));
  }
  async setReasoningEffort(id: string, value: ReasoningEffort | null): Promise<void> {
    const effort = value ? toCodexEffort(value) : null;
    await this.setting(id, (adapter, key) => adapter.setReasoningEffort(key, value), (state) => ({ effort,
      collaborationMode: { ...state.collaborationMode, settings: { ...asRecord(state.collaborationMode?.settings), reasoning_effort: effort } } }));
  }
  getReasoningEffort(id: string): ReasoningEffort | null {
    const local = this.locals.get(nativeThreadId(id));
    return local ? local.runtime.execution.getReasoningEffort(local.engineSessionId) : this.follower.getReasoningEffort(nativeThreadId(id));
  }
  async setServiceTier(id: string, value: CodexServiceTier | null): Promise<void> { await this.setting(id, (adapter, key) => adapter.setServiceTier(key, value), () => ({ serviceTier: value })); }
  getServiceTier(id: string): CodexServiceTier | null {
    const local = this.locals.get(nativeThreadId(id));
    return local ? local.runtime.execution.getServiceTier(local.engineSessionId) : this.follower.getServiceTier(nativeThreadId(id));
  }
  async listCommands(id?: string, directory?: string) {
    const local = id ? this.locals.get(nativeThreadId(id)) : undefined;
    if (local) return local.runtime.execution.listCommands(local.engineSessionId, directory);
    if (id && this.sharingEnabled) return this.follower.listCommands(id, directory);
    return (await this.runtimeFor()).execution.listCommands(undefined, directory);
  }
  async invokeCommand(id: string, name: string, args: string, options?: SendOptions): Promise<CommandInvokeResult> {
    id = nativeThreadId(id);
    const route = await this.routeForInput(id, options?.directory);
    if (route.kind === "foreign") return this.follower.invokeCommand(id, name, args);
    const local = route.session;
    await this.materialize(id, local);
    const result = await local.runtime.execution.invokeCommand(local.engineSessionId, name, args, await this.localInputOptions(local, options));
    const snapshot = await this.refreshLocal(id, local);
    return result.message ? { ...result, message: canonicalResponse(snapshot, result.message) } : result;
  }
  async getPendingPermissions(id?: string): Promise<UnifiedPermission[]> {
    const result: UnifiedPermission[] = [];
    for (const [key, local] of this.locals) {
      if (id && nativeThreadId(id) !== key) continue;
      for (const permission of await local.runtime.execution.getPendingPermissions(local.engineSessionId)) result.push(this.mapPermission(local.runtime, permission));
    }
    if (this.sharingEnabled) result.push(...this.follower.getPendingPermissions(id ? nativeThreadId(id) : undefined).filter((permission) => !this.locals.has(permission.sessionId)));
    return result;
  }
  async getPendingQuestions(id?: string): Promise<UnifiedQuestion[]> {
    const result: UnifiedQuestion[] = [];
    for (const [key, local] of this.locals) {
      if (id && nativeThreadId(id) !== key) continue;
      for (const question of await local.runtime.execution.getPendingQuestions(local.engineSessionId)) result.push(this.mapQuestion(local.runtime, question));
    }
    if (this.sharingEnabled) result.push(...this.follower.getPendingQuestions(id ? nativeThreadId(id) : undefined).filter((question) => !this.locals.has(question.sessionId)));
    return result;
  }
  async replyPermission(id: string, reply: PermissionReply, sessionId?: string): Promise<void> {
    const route = this.pendingPermissions.get(id);
    if (!route) { await this.requireSharing(); return this.follower.replyPermission(id, reply, sessionId ? nativeThreadId(sessionId) : undefined); }
    this.assertRequestSession(route, sessionId);
    await route.runtime.execution.replyPermission(route.requestId, reply, route.sessionId);
  }
  async replyQuestion(id: string, answers: string[][], sessionId?: string): Promise<void> {
    const route = this.pendingQuestions.get(id);
    if (!route) { await this.requireSharing(); return this.follower.replyQuestion(id, answers, sessionId ? nativeThreadId(sessionId) : undefined); }
    this.assertRequestSession(route, sessionId);
    await route.runtime.execution.replyQuestion(route.requestId, answers, route.sessionId);
  }
  async rejectQuestion(id: string, sessionId?: string): Promise<void> {
    const route = this.pendingQuestions.get(id);
    if (!route) { await this.requireSharing(); return this.follower.rejectQuestion(id, sessionId ? nativeThreadId(sessionId) : undefined); }
    this.assertRequestSession(route, sessionId);
    const pending = (await route.runtime.execution.getPendingQuestions(route.sessionId)).find((question) => question.id === route.requestId);
    if (Array.isArray(pending?.metadata?.codexAsyncQuestions)) await route.runtime.execution.rejectQuestion(route.requestId, route.sessionId);
    else await route.runtime.execution.cancelMessage(route.sessionId);
  }

  async listProjects(): Promise<UnifiedProject[]> {
    return [...new Set((await this.listSessions()).map((session) => session.directory))]
      .map((directory) => ({ id: directory, directory, name: directory.split(/[\\/]/).pop() || directory }));
  }
  async getCatalog(): Promise<EngineCatalogSnapshot> {
    const catalog = await this.requireCatalog();
    return this.decorateCatalog(catalog.getSnapshot() ?? await catalog.refresh());
  }
  async createProject(input: CatalogProjectInput): Promise<UnifiedProject> { return (await this.requireCatalog(true)).createProject(input); }
  async updateProject(id: string, patch: CatalogProjectPatch): Promise<UnifiedProject> { return (await this.requireCatalog(true)).updateProject(id, patch); }
  async moveProject(id: string, beforeId: string | null): Promise<void> { return (await this.requireCatalog(true)).moveProject(id, beforeId); }
  async deleteCatalogProject(id: string): Promise<void> { return (await this.requireCatalog(true)).deleteProject(id); }
  async setSessionProject(id: string, projectId: string | null): Promise<void> { await (await this.requireCatalog(true)).assignThreadProject(nativeThreadId(id), projectId); }

  private async runtimeFor(id?: string, metadata?: Record<string, unknown>): Promise<LocalRuntime> {
    if (!id && this.defaultRuntime) {
      if (this.defaultRuntime.execution.getStatus() !== "running") await this.defaultRuntime.execution.start();
      return this.defaultRuntime;
    }
    const generation = this.generation;
    const identity = await this.resolver.resolve(id, metadata);
    if (generation !== this.generation) throw new Error("The Codex engine stopped while resolving its runtime.");
    // Updaters can replace an executable in place while its earlier process is
    // still running. Path equality does not imply runtime compatibility.
    const key = JSON.stringify([identity.cliPath, identity.version]);
    const existing = this.runtimes.get(key);
    if (existing) {
      if (existing.execution.getStatus() !== "running") await existing.execution.start();
      return existing;
    }
    const pending = this.runtimeStarts.get(key);
    if (pending) return pending;
    const operation = (async () => {
      const execution = this.options.createRuntime?.(identity) ?? new CodexAdapter({ cliPath: identity.cliPath, cliVersion: identity.version });
      const native = execution.createDesktopOwnerRuntime();
      const client = this.options.createOwnerClient?.() ?? new CodexDesktopIpcClient({ codexHome: this.codexHome });
      const assertSharing = () => { if (!this.sharingEnabled) throw new Error("Codex Desktop sharing is disabled."); };
      const registrations = new Map<string, { clientId: string | null; token: symbol }>();
      const registrationKey = (threadId: string, hostId = "local") => JSON.stringify([hostId, threadId]);
      client.on("close", () => registrations.clear());
      const canPublish = (threadId: string, hostId?: string) => this.sharingEnabled && client.connected
        && registrations.get(registrationKey(threadId, hostId))?.clientId === client.clientId;
      const transport: ConstructorParameters<typeof CodexDesktopOwner>[0] = {
        get clientId() { return client.clientId; },
        connect: async () => { assertSharing(); await client.connect(); assertSharing(); },
        discoverOwner: (threadId, hostId) => client.discoverOwner(threadId, hostId),
        registerOwnedThread: (registration) => {
          assertSharing();
          const unregister = client.registerOwnedThread(registration);
          const key = registrationKey(registration.conversationId, registration.hostId);
          const token = Symbol();
          registrations.set(key, { clientId: client.clientId, token });
          return () => {
            if (registrations.get(key)?.token === token) registrations.delete(key);
            unregister();
          };
        },
        // Accepted queued work belongs to the local owner. It may complete while
        // sharing is off or reconnecting. A connected socket cannot publish until
        // this specific thread is registered on that connection again.
        publishOwnedThreadState: (...args) => { if (canPublish(args[0], args[2])) client.publishOwnedThreadState(...args); },
        publishOwnedQueuedFollowUps: (...args) => { if (canPublish(args[0], args[2])) client.publishOwnedQueuedFollowUps(...args); },
      };
      const runtime: LocalRuntime = {
        identity, execution, native, client, unsubscribe: () => {},
        owner: new CodexDesktopOwner(transport, native, { refreshDelayMs: this.options.refreshDelayMs,
          onError: (threadId, error) => { if (this.sharingEnabled) this.options.onError?.(threadId, error); } }),
      };
      runtime.unsubscribe = native.subscribe((engineSessionId) => this.scheduleRefresh(nativeThreadId(engineSessionId)));
      this.bindRuntime(runtime);
      try {
        await execution.start();
        if (generation !== this.generation) throw new Error("The Codex engine stopped while initializing its runtime.");
      }
      catch (error) {
        runtime.unsubscribe(); runtime.owner.dispose(); client.close();
        await execution.stop().catch(() => {});
        throw error;
      }
      this.runtimes.set(key, runtime);
      return runtime;
    })().finally(() => this.runtimeStarts.delete(key));
    this.runtimeStarts.set(key, operation);
    return operation;
  }
  private rememberLocal(runtime: LocalRuntime, session: UnifiedSession, meta?: Record<string, unknown>): LocalSession {
    const id = sessionThreadId(session);
    const previous = this.sessions.get(id);
    const local: LocalSession = {
      runtime, engineSessionId: session.id, refreshAgain: false, shared: false,
      session: { ...previous, ...session, id, engineType: "codex", engineMeta: { ...previous?.engineMeta, ...meta, ...session.engineMeta, codexThreadId: id, codexRuntimeVersion: runtime.identity.version } },
    };
    this.locals.set(id, local);
    this.rememberSession(this.decorateSession(local.session));
    return local;
  }
  private async routeForInput(id: string, directory?: string): Promise<InputRoute> {
    id = nativeThreadId(id);
    // A loaded writer enters locals before sharing registration finishes. Every
    // concurrent input must await that preparation before using the fast path.
    const pending = this.inputRoutes.get(id);
    if (pending) return pending;
    const known = this.locals.get(id);
    if (known) return { kind: "local", session: known };
    const operation = (async (): Promise<InputRoute> => {
      if (this.sharingEnabled) {
        await this.requireSharing();
        const owner = await this.followerClient.discoverOwner(id);
        // The follower revalidates its transport before submitting. Negative
        // discovery is used only within this acquisition, never cached for reuse.
        if (owner) return { kind: "foreign" };
      } else if (this.sessions.get(id)?.engineMeta?.codexOrigin !== "CodeMux"
        && this.sessions.get(id)?.engineMeta?.codexDesktopOwner !== "codemux") {
        throw new Error("Enable sharing to continue a conversation whose execution is managed outside CodeMux.");
      }
      const stored = await this.readStoredThread(id);
      const runtime = await this.runtimeFor(id, stored.thread);
      const previous = this.sessions.get(id) ?? this.decorateSession(this.snapshotStored(stored).session);
      const session = await runtime.execution.createSession(directory ?? String(stored.thread.cwd ?? this.sessions.get(id)?.directory ?? ""), {
        ...this.sessions.get(id)?.engineMeta, codexThreadId: id, codexDesktopOwner: "codemux",
      });
      let local: LocalSession | undefined;
      try {
        if (sessionThreadId(session) !== id) throw new Error("Codex restoration changed the original thread identity.");
        local = this.rememberLocal(runtime, session);
        await this.refreshLocal(id, local);
        if (this.sharingEnabled) await this.exposeLocal(id, local);
        return { kind: "local", session: local };
      } catch (error) {
        // Failed ownership proof must never become a later local fast path.
        // Detach only this acquisition; the original native history remains.
        if (local && this.locals.get(id) === local) {
          if (local.timer) clearTimeout(local.timer);
          this.locals.delete(id);
          runtime.owner.unregisterThread(id);
        }
        await runtime.execution.deleteSession(session.id).catch((cleanupError: unknown) => {
          this.options.onError?.(id, cleanupError instanceof Error ? cleanupError : new Error(errorMessage(cleanupError)));
        });
        if (!this.locals.has(id)) {
          const restored = this.rememberSession(this.decorateSession(previous));
          this.emit("session.updated", { session: restored });
        }
        throw error;
      }
    })().finally(() => this.inputRoutes.delete(id));
    this.inputRoutes.set(id, operation);
    return operation;
  }
  /** Publishes a draft once it receives input that Codex will persist. */
  private materialize(id: string, local: LocalSession): Promise<void> {
    if (!local.draft) return Promise.resolve();
    local.materializing ??= (async () => {
      if (this.options.catalogFactory) {
        // Admission only trusts this ID; the row appears once the rollout exists.
        void this.requireCatalog().then((catalog) => catalog.admitCreatedThread(id))
          .catch((error: unknown) => this.reportLocalError(id, error));
      }
      if (this.sharingEnabled) await this.exposeLocal(id, local, true).catch((error: unknown) => this.sharingFailed(error));
      local.draft = false;
    })().finally(() => { local.materializing = undefined; });
    return local.materializing;
  }
  private async exposeLocal(id: string, local: LocalSession, materializing = false): Promise<void> {
    if (!this.sharingEnabled || (local.draft && !materializing)) return;
    const metadata = await local.runtime.native.readMetadata?.(local.engineSessionId);
    if (metadata?.id !== id || metadata.canAcceptDirectInput !== true) throw new Error("The Codex runtime did not confirm exclusive input ownership.");
    if (!this.sharingEnabled) return;
    await local.runtime.owner.registerCreatedThread(local.engineSessionId, id);
    local.shared = this.sharingEnabled && local.runtime.client.connected;
    this.rememberSession(this.decorateSession(local.session));
  }
  private scheduleRefresh(id: string): void {
    const local = this.locals.get(id);
    if (!local || local.timer) return;
    local.timer = setTimeout(() => {
      local.timer = undefined;
      void this.refreshLocal(id, local).catch((error: unknown) => this.reportLocalError(id, error));
    }, this.options.refreshDelayMs ?? 100);
    local.timer.unref?.();
  }
  private refreshLocal(id: string, local: LocalSession): Promise<DesktopConversationSnapshot> {
    if (local.refresh) { local.refreshAgain = true; return local.refresh; }
    local.refresh = (async () => {
      do {
        local.refreshAgain = false;
        const native = await local.runtime.native.readThread(local.engineSessionId);
        const snapshot = convertDesktopConversation(buildDesktopOwnerState(native));
        if (snapshot.session.id !== id) throw new Error("The Codex runtime returned another conversation's state.");
        if (this.locals.get(id) !== local) return snapshot;
        snapshot.session = this.decorateSession({ ...local.session, ...snapshot.session, engineMeta: { ...local.session.engineMeta, ...snapshot.session.engineMeta } });
        const previous = new Map(local.snapshot?.messages.map((message) => [message.id, JSON.stringify(message)]));
        const present = new Set(snapshot.messages.map((message) => message.id));
        local.snapshot = snapshot;
        local.session = snapshot.session;
        this.rememberSession(snapshot.session);
        this.emit("session.updated", { session: snapshot.session });
        for (const messageId of previous.keys()) if (!present.has(messageId)) this.emit("message.removed", { sessionId: id, messageId });
        for (const message of snapshot.messages) if (previous.get(message.id) !== JSON.stringify(message)) this.emit("message.updated", { sessionId: id, message });
        this.announceMaterialized(id, local);
      } while (local.refreshAgain);
      return local.snapshot!;
    })().finally(() => { local.refresh = undefined; });
    return local.refresh;
  }
  private async setting(id: string, update: (adapter: EngineAdapter, id: string) => Promise<void>, nativePatch: (state: NativeOwnedThreadState) => Record<string, unknown>): Promise<void> {
    id = nativeThreadId(id);
    const route = await this.routeForInput(id);
    if (route.kind === "foreign") return update(this.follower, id);
    const local = route.session;
    if (local.runtime.native.updateSettings) {
      const current = await local.runtime.native.readThread(local.engineSessionId);
      if (!await local.runtime.native.updateSettings(local.engineSessionId, nativePatch(current), {})) throw new Error("The Codex runtime did not accept the settings update.");
    } else await update(local.runtime.execution, local.engineSessionId);
    await this.refreshLocal(id, local);
  }
  private async localInputOptions(local: LocalSession, options?: SendOptions): Promise<NonNullable<Parameters<CodexAdapter["sendMessage"]>[2]>> {
    const native = await local.runtime.native.readThread(local.engineSessionId);
    return {
      ...options,
      // The native permission profile belongs to this writer. Both normal input
      // and /skills preserve it instead of applying initial adapter defaults.
      nativeOverrides: Object.fromEntries(Object.entries({
        approvalPolicy: native.approvalPolicy, sandboxPolicy: native.sandboxPolicy, permissions: native.permissions,
      }).filter(([, value]) => value !== undefined)),
    };
  }
  private async requireSharing(): Promise<void> {
    if (!this.sharingEnabled) throw new Error("Codex Desktop sharing is disabled. The original conversation was preserved.");
    if (!this.followerClient.connected) await this.connectSharing();
    if (!this.followerClient.connected) throw new Error(this.sharingError ?? "Codex Desktop sharing is unavailable. The original conversation was preserved.");
  }
  private async connectSharing(): Promise<void> {
    if (!this.sharingEnabled) return;
    if (this.sharingConnection) return this.sharingConnection;
    this.sharingConnection = this.connectSharingInternal().finally(() => { this.sharingConnection = undefined; });
    return this.sharingConnection;
  }
  private async connectSharingInternal(): Promise<void> {
    const generation = this.generation;
    try {
      await this.follower.start();
      if (generation !== this.generation || !this.sharingEnabled) { await this.follower.stop(); return; }
      for (const runtime of this.runtimes.values()) await runtime.owner.reconnect();
      for (const [id, local] of this.locals) await this.exposeLocal(id, local);
      const externalIds = [...this.sessions.keys()].filter((id) => !this.locals.has(id));
      for (let index = 0; index < externalIds.length; index += 4) {
        if (generation !== this.generation || !this.sharingEnabled) return;
        // Rejoin observed conversations after router recovery. Attaching reads
        // owner state and stored history; it never acquires a replacement writer.
        const results = await Promise.allSettled(externalIds.slice(index, index + 4).map((id) => this.follower.attachThread(id)));
        results.forEach((result, offset) => {
          if (result.status === "fulfilled") this.rememberSession(this.decorateSession(result.value));
          else this.options.onError?.(externalIds[index + offset], result.reason instanceof Error ? result.reason : new Error(errorMessage(result.reason)));
        });
      }
      if (generation !== this.generation || !this.sharingEnabled) return;
      this.sharingError = undefined;
    } catch (error) { this.sharingFailed(error); }
    this.publishConnections();
  }
  private sharingFailed(error: unknown): void {
    if (!this.sharingEnabled || this.status === "stopped") return;
    this.sharingError = errorMessage(error);
    for (const local of this.locals.values()) local.shared = false;
    this.publishConnections();
    if (this.sharingEnabled && this.getStatus() !== "stopped" && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        void this.connectSharing();
      }, this.options.reconnectDelayMs ?? 5_000);
      this.reconnectTimer.unref?.();
    }
  }
  private clearReconnect(): void { if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
  private decorateSession(session: UnifiedSession): UnifiedSession {
    const id = nativeThreadId(session.id);
    const local = this.locals.get(id);
    const previous = this.sessions.get(id);
    const meta: Record<string, unknown> = { ...previous?.engineMeta, ...session.engineMeta, codexThreadId: id, codexHome: this.codexHome, sourceId: this.catalogSourceId };
    const available = local ? local.runtime.execution.hasSession(local.engineSessionId) : this.sharingEnabled && this.follower.hasSession(id);
    return {
      ...session, id, engineType: "codex", engineMeta: meta,
      sourceUrl: `codex://threads/${encodeURIComponent(id)}`, sourceName: "Codex",
      connection: {
        ...(typeof meta.codexOrigin === "string" ? { origin: meta.codexOrigin } : {}),
        ...(local ? { executor: "CodeMux" } : this.follower.hasSession(id) && this.sharingEnabled
          ? { executor: this.followerClient.getThreadOwner(id)?.clientName ?? "Codex" } : {}),
        shared: local ? local.shared && this.sharingEnabled : this.sharingEnabled,
        sharingStatus: this.getSessionSharing().status,
        available, ...(local ? { runtimeVersion: local.runtime.identity.version } : {}),
      },
    };
  }
  private rememberSession(session: UnifiedSession): UnifiedSession { this.sessions.set(session.id, session); return session; }
  private publishConnections(): void {
    for (const session of [...this.sessions.values()]) {
      const decorated = this.rememberSession(this.decorateSession(session));
      this.emit("session.updated", { session: decorated });
    }
    if (this.status === "running") this.emit("status.changed", { engineType: "codex", status: "running" });
  }
  private reportLocalError(id: string, error: unknown): void {
    const session = this.sessions.get(id);
    if (session) this.emit("session.updated", { session: { ...session, activityStatus: "error" } });
    this.options.onError?.(id, error instanceof Error ? error : new Error(errorMessage(error)));
  }
  private async readStoredThread(id: string): Promise<DesktopStoredThread> {
    const local = this.locals.get(id);
    const result = local ? await local.runtime.execution.readStoredThread(id, { activeOnly: true })
      : this.options.readStoredThread ? await this.options.readStoredThread(id)
      : await (await this.runtimeFor()).execution.readStoredThread(id, { activeOnly: true });
    if (result.thread.id !== id) throw new Error("Stored Codex metadata returned a different native identity.");
    if (result.archived) throw Object.assign(new Error("Archived Codex conversations are not synchronized."), { code: "CODEX_THREAD_ARCHIVED" });
    return result;
  }
  private snapshotStored(stored: DesktopStoredThread): DesktopConversationSnapshot {
    return convertDesktopConversation(buildDesktopOwnerState({ thread: stored.thread, model: typeof stored.thread.model === "string" ? stored.thread.model : "" }));
  }
  private async renameForeignThread(id: string, title: string, ownerId?: string): Promise<void> {
    if (!this.options.renameStoredThread) throw new Error("Native conversation renaming is unavailable.");
    if (ownerId && (await this.followerClient.discoverOwner(id))?.ownerClientId !== ownerId) throw new Error("The conversation owner changed before its title could be updated.");
    await this.options.renameStoredThread(id, title);
    if (ownerId) {
      this.followerClient.notifyThreadMetadataAvailable(id, ownerId);
      await this.followerClient.loadCompleteHistory(id, ownerId);
    }
  }
  private async archiveThread(id: string, archived: boolean): Promise<DesktopStoredThread> {
    if (!archived) throw new Error("Restore archived conversations in their native client.");
    const local = this.locals.get(id);
    const thread = local ? await local.runtime.execution.archiveStoredThread(id)
      : this.options.archiveStoredThread ? await this.options.archiveStoredThread(id)
      : (() => { throw new Error("Native conversation archiving is unavailable."); })();
    if (thread.id !== id) throw new Error("Native archive returned a different conversation.");
    if (this.followerClient.connected && typeof thread.cwd === "string") this.followerClient.notifyThreadArchived(id, thread.cwd);
    return { thread, archived: true };
  }
  private async requireCatalog(management = false): Promise<CodexDesktopCatalog> {
    if (!this.options.catalogFactory) throw new Error("The native Codex catalog is unavailable.");
    if (management && !this.options.catalogManagement) throw new Error("Official Desktop project management is unavailable through this bridge.");
    if (!this.catalog) {
      this.catalog = this.options.catalogFactory();
      this.unsubscribeCatalog = this.catalog.subscribe((snapshot) => {
        const decorated = this.decorateCatalog(snapshot);
        this.follower.publishCatalog(decorated);
        this.emit("catalog.updated", decorated);
        for (const [id, local] of this.locals) this.announceMaterialized(id, local);
      });
      this.catalogStarting = this.catalog.start().finally(() => { this.catalogStarting = undefined; });
    }
    if (this.catalogStarting) await this.catalogStarting;
    return this.catalog;
  }
  private decorateCatalog(snapshot: EngineCatalogSnapshot): EngineCatalogSnapshot {
    this.assertSessionCompatible("", { sourceId: snapshot.sourceId });
    const known = new Set([...this.locals.keys(), ...this.sessions.keys(), ...(this.options.knownThreadIds?.() ?? []).map(nativeThreadId)]);
    const sessions = this.sharingEnabled ? snapshot.sessions : snapshot.sessions.filter((session) => known.has(session.id));
    const projectIds = new Set(sessions.flatMap((session) => typeof session.projectId === "string" ? [session.projectId] : []));
    const projects = this.sharingEnabled ? snapshot.projects : snapshot.projects.filter((project) => projectIds.has(project.id));
    const revision = this.sharingEnabled ? snapshot.revision
      : createHash("sha256").update(JSON.stringify([snapshot.revision, sessions.map((session) => session.id), projects.map((project) => project.id)])).digest("hex");
    return { ...snapshot, revision, engineType: "codex", projects: projects.map((project) => ({ ...project, engineType: "codex" })),
      sessions: sessions.map((session) => this.decorateSession(session)) };
  }
  private announceMaterialized(id: string, local: LocalSession): void {
    if (this.announced.has(id) || !local.shared || !this.followerClient.connected || !local.snapshot?.messages.some((message) => message.role === "user")) return;
    const candidate = this.catalog?.getSnapshot()?.sessions.find((session) => session.id === id && session.archived === false);
    if (this.options.catalogFactory && !candidate) return;
    this.followerClient.notifyThreadUnarchived(id);
    this.announced.add(id);
  }
  private assertRequestSession(route: PendingRoute, id?: string): void {
    if (id && nativeThreadId(id) !== nativeThreadId(route.sessionId)) throw new Error("The pending request belongs to another conversation.");
  }
  private mapPermission(runtime: LocalRuntime, permission: UnifiedPermission): UnifiedPermission {
    const sessionId = nativeThreadId(permission.sessionId);
    const id = requestKey(sessionId, "permission", permission.id);
    this.pendingPermissions.set(id, { runtime, sessionId: permission.sessionId, requestId: permission.id });
    return { ...permission, id, sessionId, engineType: "codex" };
  }
  private mapQuestion(runtime: LocalRuntime, question: UnifiedQuestion): UnifiedQuestion {
    const sessionId = nativeThreadId(question.sessionId);
    const id = requestKey(sessionId, "question", question.id);
    this.pendingQuestions.set(id, { runtime, sessionId: question.sessionId, requestId: question.id });
    return { ...question, id, sessionId, engineType: "codex" };
  }
  private bindRuntime(runtime: LocalRuntime): void {
    runtime.execution.on("status.changed", ({ status, error }) => {
      if (this.status === "stopped") return;
      if (status === "error" || status === "stopped") {
        for (const [id, local] of this.locals) if (local.runtime === runtime) {
          if (local.timer) clearTimeout(local.timer);
          runtime.owner.unregisterThread(id);
          this.locals.delete(id);
          this.rememberSession({ ...local.session, activityStatus: "error", engineMeta: { ...local.session.engineMeta, codexDesktopOwner: "codemux" } });
        }
        this.publishConnections();
      }
      if (runtime === this.defaultRuntime) {
        this.status = status;
        this.emit("status.changed", { engineType: "codex", status, ...(error ? { error } : {}) });
      }
    });
    runtime.execution.on("permission.asked", ({ permission }) => this.emit("permission.asked", { permission: this.mapPermission(runtime, permission) }));
    runtime.execution.on("question.asked", ({ question }) => this.emit("question.asked", { question: this.mapQuestion(runtime, question) }));
    runtime.execution.on("permission.replied", ({ permissionId, optionId }) => {
      for (const [id, route] of this.pendingPermissions) if (route.runtime === runtime && route.requestId === permissionId) {
        this.pendingPermissions.delete(id); this.emit("permission.replied", { permissionId: id, optionId });
      }
    });
    runtime.execution.on("question.replied", ({ questionId, answers }) => {
      for (const [id, route] of this.pendingQuestions) if (route.runtime === runtime && route.requestId === questionId) {
        this.pendingQuestions.delete(id); this.emit("question.replied", { questionId: id, answers });
      }
    });
    runtime.execution.on("session.updated", ({ session }) => this.scheduleRefresh(nativeThreadId(session.id)));
    runtime.execution.on("message.queued", (event) => this.emit("message.queued", { ...event, sessionId: nativeThreadId(event.sessionId) }));
    runtime.execution.on("message.queued.consumed", (event) => this.emit("message.queued.consumed", { ...event, sessionId: nativeThreadId(event.sessionId) }));
    runtime.execution.on("commands.changed", ({ commands }) => this.emit("commands.changed", { engineType: "codex", commands }));
    runtime.client.on("close", () => { if (this.sharingEnabled) this.sharingFailed(new Error("Codex Desktop owner connection closed.")); });
  }
  private bindFollower(): void {
    this.follower.on("session.updated", ({ session }) => {
      if (this.locals.has(session.id)) return;
      const previous = this.sessions.get(session.id);
      if (!previous && (!session.directory || !session.time)) return;
      const decorated = this.decorateSession({ ...previous, ...session } as UnifiedSession);
      this.rememberSession(decorated);
      this.emit("session.updated", { session: decorated });
    });
    this.follower.on("message.updated", (event) => { if (!this.locals.has(event.sessionId)) this.emit("message.updated", event); });
    this.follower.on("message.removed", (event) => { if (!this.locals.has(event.sessionId)) this.emit("message.removed", event); });
    this.follower.on("message.queued.consumed", (event) => { if (!this.locals.has(event.sessionId)) this.emit("message.queued.consumed", event); });
    this.follower.on("session.removed", (event) => { if (!this.locals.has(event.sessionId)) { this.sessions.delete(event.sessionId); this.emit("session.removed", event); } });
    this.follower.on("permission.asked", (event) => { if (!this.locals.has(event.permission.sessionId)) this.emit("permission.asked", event); });
    this.follower.on("question.asked", (event) => { if (!this.locals.has(event.question.sessionId)) this.emit("question.asked", event); });
    this.follower.on("permission.replied", (event) => this.emit("permission.replied", event));
    this.follower.on("question.replied", (event) => this.emit("question.replied", event));
    this.followerClient.on("close", () => { if (this.sharingEnabled) this.sharingFailed(new Error("Codex Desktop connection closed.")); });
  }
}

function nativeThreadId(id: string): string { return id.startsWith("codex_") ? id.slice("codex_".length) : id; }
function sessionThreadId(session: UnifiedSession): string {
  return typeof session.engineMeta?.codexThreadId === "string" ? session.engineMeta.codexThreadId : nativeThreadId(session.id);
}
function requestKey(sessionId: string, kind: string, id: string): string { return ["codex", sessionId, kind, id].map(encodeURIComponent).join(":"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Codex sharing could not connect."; }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function canonicalHome(path: string): string { return existsSync(path) ? realpathSync(path) : resolve(path); }
function canonicalResponse(snapshot: DesktopConversationSnapshot, result: UnifiedMessage): UnifiedMessage {
  const turnId = result.engineMeta?.codexTurnId;
  const answer = snapshot.messages.findLast((message) => message.role === "assistant" && (!turnId || message.engineMeta?.codexTurnId === turnId));
  if (!answer) throw new Error("The Codex turn completed before its authoritative response became available.");
  return answer;
}
