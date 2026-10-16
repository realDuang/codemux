/**
 * Gateway API — Frontend bridge between GatewayClient and SolidJS stores.
 *
 * This module connects to the main-process gateway via WebSocket, subscribes
 * to push notifications, and exposes typed methods for the frontend to use.
 */

import { gatewayClient } from "./gateway-client";
import { GatewayRequestType } from "../types/unified";
import { logger } from "./logger";
import { createSignal, untrack } from "solid-js";
import { configStore } from "../stores/config";
import { beginPendingSessionSend, sessionStore, setSendingFor } from "../stores/session";
import type {
  EngineType,
  EngineInfo,
  EngineSharingState,
  EngineCapabilities,
  UnifiedSession,
  SessionActivityStatus,
  UnifiedMessage,
  UnifiedPart,
  ModelListResult,
  UnifiedProject,
  EngineCatalogSnapshot,
  CatalogProjectPatch,
  UnifiedPermission,
  UnifiedQuestion,
  ImportableSession,
  SessionImportResult,
  SessionImportProgress,
  FileExplorerNode,
  FileExplorerContent,
  GitFileStatus,
  EngineCommand,
  CommandInvokeResult,
  ScheduledTask,
  ScheduledTaskCreateRequest,
  ScheduledTaskUpdateRequest,
  ScheduledTaskRunResult,
  UnifiedWorktree,
  WorktreeMergeResult,
  OrchestrationRun,
  OrchestrationSubtask,
  OrchestrationCreateRequest,
  OrchestrationConfirmRequest,
  TerminalCreateRequest,
  TerminalCreateResponse,
  TerminalListResponse,
  TerminalProfilesListResponse,
  FileExistsResponse,
} from "../types/unified";

// --- Reactive connection signal ---
//
// `gatewayClient.connected` is a plain class getter, so reading it inside a
// SolidJS effect does not establish reactivity. This module-level signal
// mirrors the underlying boolean and is updated from the gateway's
// `connected`/`disconnected` events bound in `bindEvents()`. Use this in any
// component that needs to react to reconnect (e.g. terminal panel re-running
// initialization once the WebSocket comes back).
const [_gatewayConnected, _setGatewayConnected] = createSignal(
  gatewayClient.connected,
);

/** Reactive accessor reflecting `gatewayClient.connected`. */
export const gatewayConnected = _gatewayConnected;

const [sessionActivity, setSessionActivity] = createSignal<Record<string, SessionActivityStatus>>({});

export function hasAuthoritativeSessionState(engineType: EngineType | undefined): boolean {
  return configStore.engines.find((engine) => engine.type === engineType)
    ?.capabilities?.authoritativeSessionState === true;
}

export function getAuthoritativeSessionActivity(sessionId: string): SessionActivityStatus | undefined {
  return sessionActivity()[sessionId];
}

type SnapshotUpdate =
  | { type: "message"; message: UnifiedMessage }
  | { type: "part"; part: UnifiedPart; createdAt: number }
  | { type: "removed"; messageId: string };

interface PendingMessageSnapshot {
  sessionId: string;
  updates: SnapshotUpdate[];
}

// --- Notification callback types ---

export interface GatewayNotificationHandlers {
  onPartUpdated?: (sessionId: string, part: UnifiedPart) => void;
  onPartsBatch?: (sessionId: string, messageId: string, parts: UnifiedPart[]) => void;
  onMessageUpdated?: (sessionId: string, message: UnifiedMessage) => void;
  onMessagesUpdated?: (messages: UnifiedMessage[]) => void;
  onMessageRemoved?: (sessionId: string, messageId: string) => void;
  onSessionRemoved?: (sessionId: string) => void;
  onSessionUpdated?: (session: UnifiedSession) => void;
  onSessionCreated?: (session: UnifiedSession) => void;
  onCatalogUpdated?: (snapshot: EngineCatalogSnapshot) => void;
  onPermissionAsked?: (permission: UnifiedPermission) => void;
  onPermissionReplied?: (permissionId: string, optionId: string) => void;
  onQuestionAsked?: (question: UnifiedQuestion) => void;
  onQuestionReplied?: (questionId: string, answers: string[][]) => void;
  onEngineStatusChanged?: (engineType: EngineType, status: string, error?: string) => void;
  onMessageQueued?: (sessionId: string, messageId: string, queuePosition: number, clientMessageId?: string) => void;
  onMessageQueuedConsumed?: (sessionId: string, messageId: string, clientMessageId?: string) => void;
  onFileChanged?: (event: { type: string; path: string; directory: string }) => void;
  onCommandsChanged?: (engineType: EngineType, commands: EngineCommand[]) => void;
  onScheduledTaskFired?: (taskId: string, conversationId: string) => void;
  onScheduledTaskFailed?: (taskId: string, error: string) => void;
  onScheduledTasksChanged?: (tasks: ScheduledTask[]) => void;
  onOrchestrationUpdated?: (run: OrchestrationRun) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
}

// --- Gateway API singleton ---

class GatewayAPI {
  private handlers: GatewayNotificationHandlers = {};
  private initialized = false;
  private boundHandlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  private pendingMessageSnapshots = new Set<PendingMessageSnapshot>();
  private activityRevision = 0;
  private sessionActivityRevisions = new Map<string, number>();
  private catalogRevision = 0;
  private catalogSnapshots = new Map<string, { revision: number; snapshot: EngineCatalogSnapshot }>();
  private pendingSessionSnapshots = new Set<Map<string, UnifiedSession | null>>();
  private removedSessionIds = new Set<string>();
  private sessionRemovalRevisions = new Map<string, number>();
  private pendingSends = new Map<string, Set<() => void>>();

  private async withPendingSend<T>(sessionId: string, send: () => Promise<T>): Promise<T> {
    const releaseSending = untrack(() => {
      const engineType = sessionStore.list.find((session) => session.id === sessionId)?.engineType;
      const activity = getAuthoritativeSessionActivity(sessionId);
      return beginPendingSessionSend(sessionId, hasAuthoritativeSessionState(engineType)
        ? activity === "running" || activity === "waiting" : undefined);
    });
    const pending = this.pendingSends.get(sessionId) ?? new Set<() => void>();
    this.pendingSends.set(sessionId, pending);
    const release = () => {
      if (!pending.delete(release)) return;
      if (pending.size === 0 && this.pendingSends.get(sessionId) === pending) this.pendingSends.delete(sessionId);
      releaseSending();
    };
    pending.add(release);
    try { return await send(); }
    finally { release(); }
  }

  private releasePendingSends(sessionId?: string): void {
    const groups = sessionId ? [this.pendingSends.get(sessionId)] : [...this.pendingSends.values()];
    for (const pending of groups) for (const release of [...(pending ?? [])]) release();
  }

  private recordCatalogSession(session: UnifiedSession, restore = false): boolean {
    if (this.removedSessionIds.has(session.id)) {
      if (!restore) return false;
      gatewayClient.discardSessionNotifications(session.id);
      this.removedSessionIds.delete(session.id);
    }
    for (const updates of this.pendingSessionSnapshots) updates.set(session.id, session);
    return true;
  }

  private snapshotWasRemoved(sessionId: string, revision: number): boolean {
    return this.removedSessionIds.has(sessionId)
      || (this.sessionRemovalRevisions.get(sessionId) ?? 0) > revision;
  }

  private async readSessions(read: () => Promise<UnifiedSession[]>, engineType?: EngineType): Promise<UnifiedSession[]> {
    const revision = this.activityRevision;
    const updates = new Map<string, UnifiedSession | null>();
    this.pendingSessionSnapshots.add(updates);
    try {
      const sessions = new Map((await read()).map((session) => [session.id, session]));
      for (const [id, session] of updates) {
        if (session && (!engineType || session.engineType === engineType)) sessions.set(id, session);
        else sessions.delete(id);
      }
      const current = [...sessions.values()].filter((session) => !this.removedSessionIds.has(session.id));
      current.forEach((session) => this.syncSessionActivity(session, revision));
      return current;
    } finally {
      this.pendingSessionSnapshots.delete(updates);
    }
  }

  private syncSessionActivity(session: UnifiedSession, snapshotRevision = this.activityRevision): void {
    if (this.removedSessionIds.has(session.id)) return;
    const activity = session.activityStatus;
    if (!hasAuthoritativeSessionState(session.engineType) || !activity) return;
    if ((this.sessionActivityRevisions.get(session.id) ?? 0) > snapshotRevision) return;
    this.sessionActivityRevisions.set(session.id, ++this.activityRevision);
    setSessionActivity((current) => ({ ...current, [session.id]: activity }));
    setSendingFor(session.id, activity === "running" || activity === "waiting");
  }

  private recordSnapshotUpdate(sessionId: string, update: SnapshotUpdate): void {
    for (const snapshot of this.pendingMessageSnapshots) {
      if (snapshot.sessionId === sessionId) snapshot.updates.push(update);
    }
  }


  /**
   * Whether the gateway has been initialized (connected + events bound).
   */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Initialize the gateway connection and subscribe to notifications.
   * Call once during app startup (e.g., in a top-level createEffect).
   * If already initialized, only updates the notification handlers
   * (useful when Chat remounts after navigation).
   */
  async init(handlers?: GatewayNotificationHandlers): Promise<void> {
    if (handlers) {
      this.handlers = handlers;
    }
    if (this.initialized) return;
    this.initialized = true;

    this.bindEvents();

    try {
      await gatewayClient.connect();
    } catch (err) {
      logger.error("[GatewayAPI] Failed to connect:", err);
      // Reconnect will be handled by GatewayClient automatically
    }
  }

  /**
   * Update notification handlers (can be called after init).
   */
  setHandlers(handlers: Partial<GatewayNotificationHandlers>): void {
    Object.assign(this.handlers, handlers);
  }

  /**
   * Disconnect and cleanup.
   */
  destroy(): void {
    this.releasePendingSends();
    this.unbindEvents();
    gatewayClient.disconnect();
    _setGatewayConnected(false);
    this.initialized = false;
    setSessionActivity({});
    this.sessionActivityRevisions.clear();
    this.removedSessionIds.clear();
    this.sessionRemovalRevisions.clear();
    this.catalogSnapshots.clear();
    this.catalogRevision = 0;
  }

  get connected(): boolean {
    return gatewayClient.connected;
  }

  // --- Event binding ---

  private bind<K extends keyof import("./gateway-client").GatewayClientEvents>(
    event: K,
    handler: import("./gateway-client").GatewayClientEvents[K],
  ): void {
    gatewayClient.on(event, handler);
    this.boundHandlers.push({ event, handler: handler as (...args: any[]) => void });
  }

  private unbindEvents(): void {
    for (const { event, handler } of this.boundHandlers) {
      gatewayClient.off(event as any, handler as any);
    }
    this.boundHandlers = [];
  }

  private bindEvents(): void {
    this.bind("connected", () => {
      _setGatewayConnected(true);
      this.handlers.onConnected?.();
    });

    this.bind("disconnected", (reason) => {
      this.releasePendingSends();
      _setGatewayConnected(false);
      this.handlers.onDisconnected?.(reason);
    });

    this.bind("message.part.updated", (data) => {
      if (this.removedSessionIds.has(data.sessionId)) return;
      this.recordSnapshotUpdate(data.sessionId, { type: "part", part: data.part, createdAt: Date.now() });
      this.handlers.onPartUpdated?.(data.sessionId, data.part);
    });

    this.bind("message.parts.batch", (data) => {
      if (this.removedSessionIds.has(data.sessionId)) return;
      for (const part of data.parts) {
        this.recordSnapshotUpdate(data.sessionId, { type: "part", part, createdAt: Date.now() });
      }
      this.handlers.onPartsBatch?.(data.sessionId, data.messageId, data.parts);
    });

    this.bind("message.updated", (data) => {
      if (this.removedSessionIds.has(data.sessionId)) return;
      this.recordSnapshotUpdate(data.sessionId, { type: "message", message: data.message });
      this.handlers.onMessageUpdated?.(data.sessionId, data.message);
    });

    this.bind("message.updated.batch", ({ messages }) => {
      const retained = messages.filter(({ sessionId }) => !this.removedSessionIds.has(sessionId));
      for (const { sessionId, message } of retained) {
        this.recordSnapshotUpdate(sessionId, { type: "message", message });
      }
      if (this.handlers.onMessagesUpdated) {
        if (retained.length > 0) this.handlers.onMessagesUpdated(retained.map(({ message }) => message));
      } else {
        for (const { sessionId, message } of retained) this.handlers.onMessageUpdated?.(sessionId, message);
      }
    });

    this.bind("message.removed", (data) => {
      if (this.removedSessionIds.has(data.sessionId)) return;
      this.recordSnapshotUpdate(data.sessionId, { type: "removed", messageId: data.messageId });
      this.handlers.onMessageRemoved?.(data.sessionId, data.messageId);
    });

    this.bind("session.removed", ({ sessionId }) => {
      this.releasePendingSends(sessionId);
      this.removedSessionIds.add(sessionId);
      const revision = ++this.activityRevision;
      this.sessionActivityRevisions.set(sessionId, revision);
      this.sessionRemovalRevisions.set(sessionId, revision);
      for (const updates of this.pendingSessionSnapshots) updates.set(sessionId, null);
      for (const [sourceId, entry] of this.catalogSnapshots) {
        if (!entry.snapshot.sessions.some((session) => session.id === sessionId)) continue;
        this.catalogSnapshots.set(sourceId, {
          revision: ++this.catalogRevision,
          snapshot: { ...entry.snapshot, sessions: entry.snapshot.sessions.filter((session) => session.id !== sessionId) },
        });
      }
      setSessionActivity((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      setSendingFor(sessionId, false);
      this.handlers.onSessionRemoved?.(sessionId);
    });

    this.bind("session.updated", (data) => {
      if (!this.recordCatalogSession(data.session)) return;
      this.syncSessionActivity(data.session);
      this.handlers.onSessionUpdated?.(data.session);
    });

    this.bind("session.created", (data) => {
      this.recordCatalogSession(data.session, true);
      this.syncSessionActivity(data.session);
      this.handlers.onSessionCreated?.(data.session);
    });

    this.bind("catalog.updated", (snapshot) => {
      this.catalogSnapshots.set(snapshot.sourceId, { revision: ++this.catalogRevision, snapshot });
      snapshot.sessions.forEach((session) => this.recordCatalogSession(session, true));
      snapshot.sessions.forEach((session) => this.syncSessionActivity(session));
      this.handlers.onCatalogUpdated?.(snapshot);
    });

    this.bind("permission.asked", (data) => {
      if (this.removedSessionIds.has(data.permission.sessionId)) return;
      this.handlers.onPermissionAsked?.(data.permission);
    });

    this.bind("permission.replied", (data) => {
      this.handlers.onPermissionReplied?.(data.permissionId, data.optionId);
    });

    this.bind("question.asked", (data) => {
      if (this.removedSessionIds.has(data.question.sessionId)) return;
      this.handlers.onQuestionAsked?.(data.question);
    });

    this.bind("question.replied", (data) => {
      this.handlers.onQuestionReplied?.(data.questionId, data.answers);
    });

    this.bind("engine.status.changed", (data) => {
      this.handlers.onEngineStatusChanged?.(data.engineType, data.status, data.error);
    });

    this.bind("message.queued", (data) => {
      if (this.removedSessionIds.has(data.sessionId)) return;
      this.handlers.onMessageQueued?.(data.sessionId, data.messageId, data.queuePosition, data.clientMessageId);
    });

    this.bind("message.queued.consumed", (data) => {
      if (this.removedSessionIds.has(data.sessionId)) return;
      this.handlers.onMessageQueuedConsumed?.(data.sessionId, data.messageId, data.clientMessageId);
    });

    this.bind("file.changed", (event) => {
      this.handlers.onFileChanged?.(event);
    });

    this.bind("commands.changed", (data) => {
      this.handlers.onCommandsChanged?.(data.engineType, data.commands);
    });

    this.bind("scheduledTask.fired", (data) => {
      this.handlers.onScheduledTaskFired?.(data.taskId, data.conversationId);
    });

    this.bind("scheduledTask.failed", (data) => {
      this.handlers.onScheduledTaskFailed?.(data.taskId, data.error);
    });

    this.bind("scheduledTasks.changed", (data) => {
      this.handlers.onScheduledTasksChanged?.(data.tasks);
    });

    this.bind("orchestration.updated", (data) => {
      this.handlers.onOrchestrationUpdated?.(data.run);
    });
  }

  // --- Engine ---

  listEngines(): Promise<EngineInfo[]> {
    return gatewayClient.listEngines();
  }

  getSessionSharing(engineType: EngineType): Promise<EngineSharingState> {
    return gatewayClient.request(GatewayRequestType.ENGINE_SHARING_GET, { engineType });
  }

  setSessionSharing(engineType: EngineType, enabled: boolean): Promise<EngineSharingState> {
    return gatewayClient.request(GatewayRequestType.ENGINE_SHARING_SET, { engineType, enabled });
  }

  getCapabilities(engineType: EngineType): Promise<EngineCapabilities> {
    return gatewayClient.getEngineCapabilities(engineType);
  }

  // --- Session ---

  async listSessions(engineType: EngineType): Promise<UnifiedSession[]> {
    return this.readSessions(() => gatewayClient.listSessions(engineType), engineType);
  }

  createSession(
    engineType: EngineType,
    directory: string,
    worktreeId?: string,
    projectId?: string | null,
  ): Promise<UnifiedSession> {
    return gatewayClient.createSession({ engineType, directory, worktreeId, ...(projectId !== undefined ? { projectId } : {}) });
  }

  setSessionProject(sessionId: string, projectId: string | null): Promise<void> {
    return gatewayClient.setSessionProject({ sessionId, projectId });
  }

  async getSession(sessionId: string): Promise<UnifiedSession> {
    const revision = this.activityRevision;
    const updates = new Map<string, UnifiedSession | null>();
    this.pendingSessionSnapshots.add(updates);
    try {
      const snapshot = await gatewayClient.getSession(sessionId);
      const session = updates.has(sessionId) ? updates.get(sessionId) : snapshot;
      if (!session || this.removedSessionIds.has(sessionId)) throw new Error("Session was removed");
      const stale = (this.sessionActivityRevisions.get(session.id) ?? 0) > revision;
      this.syncSessionActivity(session, revision);
      if (!stale && hasAuthoritativeSessionState(session.engineType)) this.handlers.onSessionUpdated?.(session);
      return session;
    } finally {
      this.pendingSessionSnapshots.delete(updates);
    }
  }

  deleteSession(sessionId: string): Promise<void> {
    return gatewayClient.deleteSession(sessionId);
  }

  renameSession(sessionId: string, title: string): Promise<void> {
    return gatewayClient.renameSession(sessionId, title);
  }

  setSessionArchived(sessionId: string, archived: boolean): Promise<void> {
    return gatewayClient.setSessionArchived(sessionId, archived);
  }

  // --- Message ---

  sendMessage(
    sessionId: string,
    text: string,
    options?: { clientMessageId?: string; mode?: string; modelId?: string; images?: import("../types/unified").ImageAttachment[]; reasoningEffort?: import("../types/unified").ReasoningEffort | null; serviceTier?: import("../types/unified").CodexServiceTier | null },
  ): Promise<UnifiedMessage> {
    const content: import("../types/unified").MessagePromptContent[] = [{ type: "text", text }];
    if (options?.images) {
      for (const img of options.images) {
        content.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
    }
    return this.withPendingSend(sessionId, () => gatewayClient.sendMessage({
      sessionId,
      content,
      clientMessageId: options?.clientMessageId,
      mode: options?.mode,
      modelId: options?.modelId,
      reasoningEffort: options?.reasoningEffort,
      serviceTier: options?.serviceTier,
    }));
  }

  async cancelMessage(sessionId: string): Promise<void> {
    const pending = [...(this.pendingSends.get(sessionId) ?? [])];
    await gatewayClient.cancelMessage(sessionId);
    // Only cancel submissions that existed when this request was made.
    for (const release of pending) release();
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    const revision = this.activityRevision;
    if (this.removedSessionIds.has(sessionId)) return [];
    const queued = gatewayClient.waitForQueuedNotifications();
    if (queued) await queued;
    if (this.snapshotWasRemoved(sessionId, revision)) return [];
    const session = sessionStore.list.find((item) => item.id === sessionId);
    const authoritative = hasAuthoritativeSessionState(session?.engineType);

    // Every engine retains notifications received during history loading.
    // Authoritative messages replace their complete parts; other engines merge.
    const pending: PendingMessageSnapshot = { sessionId, updates: [] };
    this.pendingMessageSnapshots.add(pending);
    try {
      const snapshot = await gatewayClient.listMessages(sessionId);
      if (this.snapshotWasRemoved(sessionId, revision)) return [];
      const messages = new Map(snapshot.map((message) => [message.id, message]));
      const removedMessages = new Set<string>();
      const mergeParts = (existing: UnifiedPart[], incoming: UnifiedPart[]) =>
        [...new Map([...existing, ...incoming].map((part) => [part.id, part])).values()];

      for (const update of pending.updates) {
        if (update.type === "removed") {
          messages.delete(update.messageId);
          removedMessages.add(update.messageId);
        } else if (update.type === "message") {
          removedMessages.delete(update.message.id);
          const current = messages.get(update.message.id);
          messages.set(update.message.id, {
            ...current,
            ...update.message,
            parts: authoritative ? update.message.parts ?? []
              : mergeParts(current?.parts ?? [], update.message.parts ?? []),
          });
        } else {
          const { part } = update;
          if (removedMessages.has(part.messageId)) continue;
          const current = messages.get(part.messageId) ?? {
            id: part.messageId,
            sessionId,
            role: "assistant" as const,
            time: { created: update.createdAt },
            parts: [],
          };
          messages.set(part.messageId, { ...current, parts: mergeParts(current.parts ?? [], [part]) });
        }
      }
      return [...messages.values()].sort((a, b) => a.time.created - b.time.created);
    } finally {
      this.pendingMessageSnapshots.delete(pending);
    }
  }

  async getMessageSteps(sessionId: string, messageId: string): Promise<UnifiedPart[]> {
    const revision = this.activityRevision;
    if (this.removedSessionIds.has(sessionId)) return [];
    const steps = await gatewayClient.getMessageSteps(sessionId, messageId);
    return this.snapshotWasRemoved(sessionId, revision) ? [] : steps;
  }

  // --- Model ---

  listModels(engineType: EngineType): Promise<ModelListResult> {
    return gatewayClient.listModels(engineType);
  }

  setModel(sessionId: string, modelId: string): Promise<void> {
    return gatewayClient.setModel({ sessionId, modelId });
  }

  updateSessionConfig(
    sessionId: string,
    config: import("../types/unified").SessionConfigPatch,
  ): Promise<void> {
    return gatewayClient.updateSessionConfig({ sessionId, config });
  }

  // --- Mode ---

  setMode(sessionId: string, modeId: string): Promise<void> {
    return gatewayClient.setMode({ sessionId, modeId });
  }

  // --- Permission ---

  replyPermission(permissionId: string, optionId: string): Promise<void> {
    return gatewayClient.replyPermission({ permissionId, optionId });
  }

  // --- Question ---

  replyQuestion(questionId: string, answers: string[][]): Promise<void> {
    return gatewayClient.replyQuestion({ questionId, answers });
  }

  rejectQuestion(questionId: string): Promise<void> {
    return gatewayClient.rejectQuestion(questionId);
  }

  // --- Pending state (resync) ---

  async listPending(sessionId: string): Promise<{
    questions: UnifiedQuestion[];
    permissions: UnifiedPermission[];
  }> {
    const revision = this.activityRevision;
    const empty = { questions: [], permissions: [] };
    if (this.removedSessionIds.has(sessionId)) return empty;
    const pending = await gatewayClient.request<{ questions: UnifiedQuestion[]; permissions: UnifiedPermission[] }>(
      GatewayRequestType.PENDING_LIST, { sessionId },
    );
    return this.snapshotWasRemoved(sessionId, revision) ? empty : pending;
  }

  // --- Project ---

  async listCatalogs(): Promise<EngineCatalogSnapshot[]> {
    const revision = this.activityRevision;
    const catalogRevision = this.catalogRevision;
    const updates = new Map<string, UnifiedSession | null>();
    this.pendingSessionSnapshots.add(updates);
    try {
      const catalogs = await gatewayClient.listCatalogs();
      // Preserve both catalog and live-session events received during this read.
      const current = new Map(catalogs.map((catalog) => [catalog.sourceId, catalog]));
      for (const entry of this.catalogSnapshots.values()) {
        if (entry.revision > catalogRevision) current.set(entry.snapshot.sourceId, entry.snapshot);
      }
      return [...current.values()].map((catalog) => {
        const sessions = new Map(catalog.sessions.map((session) => [session.id, session]));
        for (const session of catalog.sessions) {
          // A catalog requested after removal may authoritatively restore an active ID.
          if (!updates.has(session.id) && (this.sessionRemovalRevisions.get(session.id) ?? 0) <= revision
            && this.removedSessionIds.has(session.id)) this.recordCatalogSession(session, true);
        }
        for (const [id, session] of updates) {
          if (!session) {
            sessions.delete(id);
            continue;
          }
          const prior = sessions.get(id);
          if (session.catalogSourceId === catalog.sourceId
            || (!session.catalogSourceId && prior?.engineType === session.engineType)) {
            sessions.set(id, session);
          }
        }
        const merged = [...sessions.values()].filter((session) => !this.removedSessionIds.has(session.id));
        merged.forEach((session) => this.syncSessionActivity(session, revision));
        return { ...catalog, sessions: merged };
      });
    } finally {
      this.pendingSessionSnapshots.delete(updates);
    }
  }

  createProject(sourceId: string, name: string, roots: string[]): Promise<UnifiedProject> {
    return gatewayClient.createProject({ sourceId, name, roots });
  }

  updateProject(projectId: string, patch: CatalogProjectPatch): Promise<UnifiedProject> {
    return gatewayClient.updateProject({ projectId, patch });
  }

  reorderProjects(sourceId: string, projectIds: string[]): Promise<void> {
    return gatewayClient.reorderProjects({ sourceId, projectIds });
  }

  listProjects(engineType: EngineType): Promise<UnifiedProject[]> {
    return gatewayClient.listProjects(engineType);
  }

  setProjectEngine(directory: string, engineType: EngineType): Promise<void> {
    return gatewayClient.setProjectEngine({ directory, engineType });
  }

  // --- Cross-engine (SessionStore) ---

  async listAllSessions(): Promise<UnifiedSession[]> {
    return this.readSessions(() => gatewayClient.listAllSessions());
  }

  listAllProjects(): Promise<UnifiedProject[]> {
    return gatewayClient.listAllProjects();
  }

  async deleteProject(projectId: string): Promise<{ success: boolean }> {
    return gatewayClient.deleteProject(projectId);
  }

  async importLegacyProjects(projects: UnifiedProject[]): Promise<{ success: boolean }> {
    return gatewayClient.importLegacyProjects(projects);
  }

  // --- Session Import ---

  importPreview(engineType: EngineType, limit: number): Promise<ImportableSession[]> {
    return gatewayClient.importPreview({ engineType, limit });
  }

  importExecute(
    engineType: EngineType,
    sessions: Array<{
      engineSessionId: string;
      directory: string;
      title: string;
      createdAt: number;
      updatedAt: number;
      engineMeta?: Record<string, unknown>;
    }>,
    onProgress?: (progress: SessionImportProgress) => void,
  ): Promise<SessionImportResult> {
    if (onProgress) {
      gatewayClient.on("session.import.progress", onProgress);
    }
    return gatewayClient.importExecute({ engineType, sessions }).finally(() => {
      if (onProgress) {
        gatewayClient.off("session.import.progress", onProgress);
      }
    });
  }
  // --- Slash Commands ---

  listCommands(engineType: EngineType, sessionId?: string): Promise<EngineCommand[]> {
    return gatewayClient.listCommands({ engineType, sessionId });
  }

  invokeCommand(
    sessionId: string,
    commandName: string,
    args: string,
    options?: { mode?: string; modelId?: string; reasoningEffort?: import("../types/unified").ReasoningEffort | null; serviceTier?: import("../types/unified").CodexServiceTier | null },
  ): Promise<CommandInvokeResult> {
    return this.withPendingSend(sessionId, () => gatewayClient.invokeCommand({ sessionId, commandName, args, ...options }));
  }

  // --- File Explorer ---

  listFiles(directory: string, rootDirectory: string): Promise<FileExplorerNode[]> {
    return gatewayClient.listFiles(directory, rootDirectory);
  }

  readFile(path: string, directory: string): Promise<FileExplorerContent> {
    return gatewayClient.readFile(path, directory);
  }

  getGitStatus(directory: string): Promise<GitFileStatus[]> {
    return gatewayClient.getGitStatus(directory);
  }

  getGitDiff(directory: string, path: string): Promise<string> {
    return gatewayClient.getGitDiff(directory, path);
  }

  watchDirectory(directory: string): Promise<void> {
    return gatewayClient.watchDirectory(directory);
  }

  unwatchDirectory(directory: string): Promise<void> {
    return gatewayClient.unwatchDirectory(directory);
  }

  // --- Scheduled Tasks ---

  listScheduledTasks(): Promise<ScheduledTask[]> {
    return gatewayClient.listScheduledTasks();
  }

  getScheduledTask(id: string): Promise<ScheduledTask | null> {
    return gatewayClient.getScheduledTask(id);
  }

  createScheduledTask(req: ScheduledTaskCreateRequest): Promise<ScheduledTask> {
    return gatewayClient.createScheduledTask(req);
  }

  updateScheduledTask(req: ScheduledTaskUpdateRequest): Promise<ScheduledTask> {
    return gatewayClient.updateScheduledTask(req);
  }

  deleteScheduledTask(id: string): Promise<{ success: boolean }> {
    return gatewayClient.deleteScheduledTask(id);
  }

  runScheduledTaskNow(id: string): Promise<ScheduledTaskRunResult> {
    return gatewayClient.runScheduledTaskNow(id);
  }

  // --- Worktree ---

  createWorktree(
    directory: string,
    options?: { name?: string; baseBranch?: string },
  ): Promise<UnifiedWorktree> {
    return gatewayClient.request("worktree.create", {
      directory,
      name: options?.name,
      baseBranch: options?.baseBranch,
    });
  }

  listWorktrees(directory: string): Promise<UnifiedWorktree[]> {
    return gatewayClient.request("worktree.list", { directory });
  }

  removeWorktree(directory: string, worktreeName: string): Promise<boolean> {
    return gatewayClient.request("worktree.remove", { directory, worktreeName });
  }

  mergeWorktree(
    directory: string,
    worktreeName: string,
    options?: { targetBranch?: string; mode?: "merge" | "squash" | "rebase"; message?: string },
  ): Promise<WorktreeMergeResult> {
    return gatewayClient.request("worktree.merge", {
      directory,
      worktreeName,
      targetBranch: options?.targetBranch,
      mode: options?.mode,
      message: options?.message,
    });
  }

  listBranches(directory: string): Promise<string[]> {
    return gatewayClient.request("worktree.listBranches", { directory });
  }

  // --- Orchestration ---

  async createOrchestration(req: OrchestrationCreateRequest): Promise<OrchestrationRun> {
    return gatewayClient.request("orchestration.create", req);
  }

  async decomposeOrchestration(runId: string): Promise<{ ok: boolean }> {
    return gatewayClient.request("orchestration.decompose", { runId });
  }

  async confirmOrchestration(req: OrchestrationConfirmRequest): Promise<{ ok: boolean }> {
    return gatewayClient.request("orchestration.confirm", req);
  }

  async cancelOrchestration(runId: string): Promise<void> {
    return gatewayClient.request("orchestration.cancel", { runId });
  }

  async listOrchestrations(): Promise<OrchestrationRun[]> {
    return gatewayClient.request("orchestration.list", {});
  }

  // --- Integrated Terminal (PTY) ---

  createTerminal(req: TerminalCreateRequest): Promise<TerminalCreateResponse> {
    return gatewayClient.createTerminal(req);
  }

  writeTerminal(terminalId: string, data: string): Promise<void> {
    return gatewayClient.writeTerminal(terminalId, data);
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
    return gatewayClient.resizeTerminal(terminalId, cols, rows);
  }

  destroyTerminal(terminalId: string): Promise<void> {
    return gatewayClient.destroyTerminal(terminalId);
  }

  listTerminals(sessionId?: string): Promise<TerminalListResponse> {
    return gatewayClient.listTerminals({ sessionId });
  }

  /**
   * Subscribe to PTY output for a specific terminal. Returns an unsubscribe
   * function. The server only forwards data for terminals owned by this
   * client connection, so the filter inside the handler is just a safety net.
   */
  onTerminalData(
    terminalId: string,
    callback: (data: string) => void,
  ): () => void {
    const handler = (payload: { terminalId: string; data: string }) => {
      if (payload.terminalId === terminalId) callback(payload.data);
    };
    gatewayClient.on("terminal.data", handler);
    return () => gatewayClient.off("terminal.data", handler);
  }

  /** Subscribe to PTY exit notifications for a specific terminal. */
  onTerminalExit(
    terminalId: string,
    callback: (exitCode: number | undefined, signal: number | undefined) => void,
  ): () => void {
    const handler = (payload: {
      terminalId: string;
      exitCode?: number;
      signal?: number;
    }) => {
      if (payload.terminalId === terminalId) callback(payload.exitCode, payload.signal);
    };
    gatewayClient.on("terminal.exit", handler);
    return () => gatewayClient.off("terminal.exit", handler);
  }

  /** List discovered shell profiles plus the resolved default profile ID. */
  listTerminalProfiles(refresh = false): Promise<TerminalProfilesListResponse> {
    return gatewayClient.request("terminal.profiles.list", { refresh });
  }

  /** Check whether a path exists on the host (used by terminal link provider). */
  checkFileExists(filePath: string, cwd?: string): Promise<FileExistsResponse> {
    return gatewayClient.request("file.exists", { path: filePath, cwd });
  }
}

export const gateway = new GatewayAPI();
