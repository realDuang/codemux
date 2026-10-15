// ============================================================================
// Engine Manager — Registry, routing, and project-engine bindings
// ============================================================================

import { EventEmitter } from "events";
import { EngineAdapter, type EngineAdapterEvents } from "../engines/engine-adapter";
import { conversationStore, makeCatalogProjectId } from "../services/conversation-store";
import { getDefaultWorkspacePath } from "../services/default-workspace";
import { engineManagerLog, getDefaultEngineFromSettings } from "../services/logger";
import { timeId } from "../utils/id-gen";
import { isDefaultTitle, isPromptFallbackTitle } from "../../../src/lib/session-utils";
import { mimeToFileExtension } from "../../../shared/image-limits";
import type {
  EngineType,
  EngineInfo,
  UnifiedSession,
  UnifiedQuestion,
  UnifiedPermission,
  UnifiedMessage,
  UnifiedPart,
  TextPart,
  FilePart,
  ModelListResult,
  UnifiedProject,
  AgentMode,
  MessagePromptContent,
  PermissionReply,
  ReasoningEffort,
  CodexServiceTier,
  UnifiedSessionConfig,
  SessionConfigPatch,
  ConversationMeta,
  ConversationMessage,
  ImportableSession,
  SessionImportResult,
  SessionImportProgress,
  EngineCommand,
  CommandInvokeResult,
  EngineCatalogSnapshot,
  CatalogProjectInput,
  CatalogProjectPatch,
} from "../../../src/types/unified";
import { REASONING_EFFORT_VALUES } from "../../../src/types/unified";
import { normalizeMessageToolDisplay, normalizeToolPartDisplay } from "../engines/tool-display";
import { canonicalCodexEngineType, canonicalCodexProjectId, canonicalCodexThreadId } from "../engines/codex/conversation-migration";

// --- Helpers ---

/** Normalize directory separators to forward slashes (Windows compat) */
function normalizeDir(dir: string): string {
  return dir ? dir.replaceAll("\\", "/") : "";
}

/** Compute the display title from a ConversationMeta — render-time priority. */
function getUsableEngineTitle(conv: ConversationMeta): string | undefined {
  const title = conv.engineTitle?.trim();
  if (!title) return undefined;
  if (isDefaultTitle(title)) return undefined;
  if (isPromptFallbackTitle(title, conv.firstPrompt)) return undefined;
  return title;
}

function getUsableEngineTitleCandidate(conv: ConversationMeta, title: string): string | undefined {
  const trimmed = title.trim();
  if (!trimmed) return undefined;
  if (conv.customTitle?.trim() === trimmed) return undefined;
  if (isDefaultTitle(trimmed)) return undefined;
  if (isPromptFallbackTitle(trimmed, conv.firstPrompt)) return undefined;
  return trimmed;
}

function computeDisplayTitle(conv: ConversationMeta): string {
  return conv.customTitle || getUsableEngineTitle(conv) || conv.firstPrompt || "New Chat";
}

/** Convert ConversationMeta → UnifiedSession for wire compatibility */
function convToSession(conv: ConversationMeta): UnifiedSession {
  // For worktree sessions, resolve projectId from the parent repo directory
  const projectDir = conv.worktreeId && conv.parentDirectory
    ? normalizeDir(conv.parentDirectory)
    : normalizeDir(conv.directory);

  return {
    id: conv.id,
    engineType: conv.engineType,
    directory: normalizeDir(conv.directory),
    title: conv.catalogSourceId ? conv.engineTitle ?? "" : computeDisplayTitle(conv),
    mode: conv.mode,
    modelId: conv.modelId,
    reasoningEffort: conv.reasoningEffort,
    serviceTier: conv.serviceTier,
    ...(typeof conv.archived === "boolean" ? { archived: conv.archived } : {}),
    worktreeId: conv.worktreeId,
    projectId: conv.catalogSourceId ? conv.projectId ?? null : `dir-${projectDir}`,
    ...(conv.catalogSourceId ? { catalogSourceId: conv.catalogSourceId, catalogAvailable: conv.catalogAvailable } : {}),
    time: {
      created: conv.createdAt,
      updated: conv.updatedAt,
    },
    engineMeta: conv.engineMeta,
  };
}

// --- Event types ---

interface EngineManagerEvents extends EngineAdapterEvents {
  /** Forwarded from adapters with engineType annotation */
}

interface MessageWriteSnapshot {
  generation: number;
  content: Array<TextPart | FilePart>;
  steps: UnifiedPart[];
}

interface AuthoritativeMessageBatch {
  messages: Map<string, { message: UnifiedMessage; snapshot: MessageWriteSnapshot }>;
  completion: Promise<void>;
}

interface InteractionReply {
  engineType: EngineType;
  sessionId?: string;
  fingerprint: string;
  promise: Promise<void>;
  completed: boolean;
}

export declare interface EngineManager {
  on<K extends keyof EngineManagerEvents>(
    event: K,
    listener: EngineManagerEvents[K],
  ): this;
  off<K extends keyof EngineManagerEvents>(
    event: K,
    listener: EngineManagerEvents[K],
  ): this;
  emit<K extends keyof EngineManagerEvents>(
    event: K,
    ...args: Parameters<EngineManagerEvents[K]>
  ): boolean;
}

export class EngineManager extends EventEmitter {
  private adapters = new Map<EngineType, EngineAdapter>();
  private projectBindings = new Map<string, EngineType>();
  /** conversationId → engineType lookup for routing */
  private sessionEngineMap = new Map<string, EngineType>();
  /** permissionId → engineType lookup for routing permission replies */
  private permissionEngineMap = new Map<string, EngineType>();
  /** questionId → engineType lookup for routing question replies */
  private questionEngineMap = new Map<string, EngineType>();
  /** questionId → sessionId lookup so adapters can resolve correct directory */
  private questionSessionMap = new Map<string, string>();
  /** permissionId → sessionId lookup so adapters can resolve correct directory */
  private permissionSessionMap = new Map<string, string>();
  private pendingPermissionReplies = new Set<string>();
  private pendingQuestionReplies = new Set<string>();
  /** Coalesce answers from multiple channel bindings for the same native prompt. */
  private interactionReplies = new Map<string, InteractionReply>();
  /** engineSessionId → conversationId cache (populated on session creation / lookup) */
  private engineToConvMap = new Map<string, string>();
  /** Accumulate step-type parts during streaming: messageId → UnifiedPart[] */
  private stepPartsBuffer = new Map<string, UnifiedPart[]>();
  /** Accumulate content-type parts (text/file) during streaming: messageId → (TextPart|FilePart)[] */
  private contentPartsBuffer = new Map<string, Array<TextPart | FilePart>>();
  /** Explicit removals invalidate writes that captured an earlier message revision. */
  private messageGenerations = new Map<string, number>();
  /**
   * In-memory FIFO queue of persisted user message IDs awaiting timing patch.
   * Populated only for sends that arrive while the session is already active;
   * drained by persistMessage when an adapter emits an enriched queued user
   * message (enqueuedAt/processedAt).
   * Avoids a full conversationStore.listMessages() scan per queued commit.
   * Single-process app (Electron requestSingleInstanceLock), so in-memory
   * state is authoritative.
   */
  private pendingUserMsgIdQueue = new Map<string, string[]>();

  // --- Incremental step persistence ---
  /** messageIds whose step buffers have unsaved changes */
  private dirtySteps = new Set<string>();
  /** messageId → conversationId mapping for dirty step flush */
  private messageConvMap = new Map<string, string>();
  /** messageIds for which a placeholder assistant message has been persisted */
  private persistedPlaceholders = new Set<string>();
  /** Timer for debounced step flush (2s interval) */
  private stepFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serialize timer and explicit flushes so older snapshots finish first. */
  private stepFlushPromise: Promise<void> | null = null;
  private pendingMessageWrites = new Set<Promise<void>>();
  private static readonly STEP_FLUSH_INTERVAL_MS = 2000;

  /** Track active sendMessage call counts per session (for idle/queue detection). */
  private activeSessionCounts = new Map<string, number>();
  private authoritativeAttaching = new Map<string, Promise<void>>();
  /** Live session state owned by an external engine, keyed by conversation ID. */
  private authoritativeSessions = new Map<string, Partial<UnifiedSession>>();
  private authoritativeLiveFields = new Map<string, Partial<UnifiedSession>>();
  private authoritativeReconnects = new Map<EngineType, Promise<void>>();
  private catalogSources = new Map<EngineType, string>();
  private catalogRefreshes = new Map<EngineType, Promise<EngineCatalogSnapshot>>();
  private catalogRevisions = new Map<EngineType, number>();
  /** Preserve message, removal, and incremental step order across multi-step writes. */
  private authoritativeMessageWrites = new Map<string, Promise<void>>();
  private authoritativeMessageBatches = new Map<string, AuthoritativeMessageBatch>();
  private authoritativeHistoryReads = new Map<string, Promise<UnifiedMessage[]>>();
  private sessionRemovals = new Map<string, Promise<void>>();
  private catalogSessionChecks = new Map<string, Promise<void>>();

  // --- Adapter Registration ---

  registerAdapter(adapter: EngineAdapter): void {
    const type = adapter.engineType;
    if (this.adapters.has(type)) {
      throw new Error(`Adapter already registered for engine type: ${type}`);
    }
    this.adapters.set(type, adapter);
    this.forwardEvents(adapter);
  }

  getAdapter(engineType: EngineType): EngineAdapter | undefined {
    return this.adapters.get(this.resolveEngineType(engineType));
  }

  private resolveEngineType(engineType: EngineType): EngineType {
    return this.adapters.has(engineType) ? engineType : canonicalCodexEngineType(engineType);
  }

  private getAdapterOrThrow(engineType: EngineType): EngineAdapter {
    const adapter = this.getAdapter(engineType);
    if (!adapter) {
      throw new Error(`No adapter registered for engine type: ${engineType}`);
    }
    return adapter;
  }

  /** Get adapter for a conversation by looking up its engine binding */
  private getAdapterForSession(sessionId: string): EngineAdapter {
    sessionId = conversationStore.resolveConversationId(sessionId);
    let engineType = this.sessionEngineMap.get(sessionId);
    if (!engineType) {
      // Fallback: recover binding from ConversationStore
      const conv = conversationStore.get(sessionId);
      if (conv?.engineType) {
        engineType = conv.engineType;
        this.sessionEngineMap.set(sessionId, engineType);
      }
    }
    if (!engineType) {
      throw new Error(`No engine binding found for session: ${sessionId}`);
    }
    const adapter = this.getAdapterOrThrow(engineType);
    const conversation = conversationStore.get(sessionId);
    if (conversation?.engineSessionId) this.assertSessionCompatible(conversation, adapter);
    return adapter;
  }

  private isSessionCompatible(conversation: ConversationMeta, adapter: EngineAdapter): boolean {
    try {
      this.assertSessionCompatible(conversation, adapter);
      return true;
    } catch {
      return false;
    }
  }

  private assertSessionCompatible(conversation: ConversationMeta, adapter: EngineAdapter): void {
    if (conversation.engineSessionId) adapter.assertSessionCompatible(conversation.engineSessionId, {
      ...conversation.engineMeta,
      ...(conversation.catalogSourceId ? { catalogSourceId: conversation.catalogSourceId } : {}),
    });
  }

  /** Get adapter for a directory based on project binding */
  private getAdapterForDirectory(directory: string): EngineAdapter {
    const engineType = this.projectBindings.get(normalizeDir(directory));
    if (!engineType) {
      throw new Error(`No engine binding found for directory: ${directory}`);
    }
    return this.getAdapterOrThrow(engineType);
  }

  private sessionFromConversation(conv: ConversationMeta): UnifiedSession {
    const session = convToSession(conv);
    const live = this.authoritativeSessions.get(conv.id);
    if (!live) return session.archived ? { ...session, activityStatus: "idle" } : session;
    return {
      ...session,
      ...live,
      id: conv.id,
      engineType: conv.engineType,
      directory: session.directory,
      projectId: session.projectId,
      ...(conv.catalogSourceId ? { catalogSourceId: conv.catalogSourceId, catalogAvailable: conv.catalogAvailable } : {}),
      worktreeId: session.worktreeId,
      title: Object.prototype.hasOwnProperty.call(live, "title") ? live.title ?? "" : session.title,
      ...((live.archived ?? conv.archived) ? { activityStatus: "idle" as const } : {}),
    };
  }

  private syncArchivedState(conversationId: string, session: Pick<UnifiedSession, "archived">): void {
    if (typeof session.archived !== "boolean") return;
    const conv = conversationStore.get(conversationId);
    if (conv && conv.archived !== session.archived) {
      conversationStore.setArchived(conversationId, session.archived);
    }
  }

  private visibleConversations(filter?: { engineType?: EngineType; directory?: string }): ConversationMeta[] {
    return conversationStore.list(filter).filter((conv) => {
      if (this.catalogSessionChecks.has(conv.id)) return false;
      if (!this.getAdapter(conv.engineType)?.getCapabilities().hideArchivedSessions || !conv.archived) return true;
      void this.purgeRemovedConversation(conv, "archived").catch((error) => {
        engineManagerLog.error(`Failed to remove archived mirror ${conv.id}:`, error);
      });
      return false;
    });
  }

  private verifyCatalogOmissions(adapter: EngineAdapter, snapshot: EngineCatalogSnapshot): void {
    if (!snapshot.complete || !adapter.getCapabilities().hideArchivedSessions) return;
    const present = new Set(snapshot.sessions.map((session) => session.id));
    for (const conv of conversationStore.list({ engineType: adapter.engineType })) {
      if (!this.isSessionCompatible(conv, adapter) || !conv.engineSessionId || present.has(conv.engineSessionId) || this.catalogSessionChecks.has(conv.id)
        || (conv.catalogSourceId && conv.catalogSourceId !== snapshot.sourceId)
        || (conv.catalogSourceId && conv.catalogAvailable === undefined)) continue;
      // An active-only catalog cannot tell archive from temporarily missing
      // storage. Confirm omitted saved rows before publishing their metadata.
      const check = Promise.resolve().then(async () => {
        try {
          const session = await adapter.getSession(conv.engineSessionId!);
          if (session && session.id === conv.engineSessionId && session.archived) {
            await this.purgeRemovedConversation(conv, "archived", conv.catalogSourceId ?? snapshot.sourceId);
          }
        } catch (error) {
          if ((error as { code?: string }).code === "CODEX_THREAD_ARCHIVED") {
            await this.purgeRemovedConversation(conv, "archived", conv.catalogSourceId ?? snapshot.sourceId);
          }
          // Other failures preserve the saved mirror for an offline read.
        }
      }).finally(() => {
        this.catalogSessionChecks.delete(conv.id);
        const current = this.listCatalogs().find((catalog) => catalog.engineType === adapter.engineType && catalog.sourceId === snapshot.sourceId);
        if (current) this.emit("catalog.updated", current);
      });
      this.catalogSessionChecks.set(conv.id, check);
      void check.catch((error) => engineManagerLog.error("Failed to verify omitted conversation:", error));
    }
  }

  private ignoreSessionEvent(adapter: EngineAdapter, nativeId: string): boolean {
    if (!adapter.getCapabilities().hideArchivedSessions) return false;
    const conversationId = this.resolveConversationId(nativeId, adapter.engineType);
    if (conversationId && this.catalogSessionChecks.has(conversationId)) return true;
    return conversationStore.isSessionSuppressed(adapter.engineType, nativeId, this.catalogSources.get(adapter.engineType));
  }

  private purgeRemovedConversation(conv: ConversationMeta, kind: "local" | "archived", sourceId = conv.catalogSourceId): Promise<void> {
    const pending = this.sessionRemovals.get(conv.id);
    if (pending) return kind === "local"
      ? this.trackMessageWrite(pending.then(() => conversationStore.removeEngineConversation(conv.id, kind, sourceId))) : pending;
    // Install the identity tombstone and remove the index synchronously, before
    // any late event or catalog can observe the old conversation again.
    const conversationAliases = conversationStore.getConversationIds(conv.id).filter((id) => id !== conv.id);
    const operation = this.trackMessageWrite(conversationStore.removeEngineConversation(conv.id, kind, sourceId));
    this.catalogRevisions.set(conv.engineType, (this.catalogRevisions.get(conv.engineType) ?? 0) + 1);
    this.forgetConversationMappings(conv.id);
    this.sessionEngineMap.delete(conv.id);
    this.authoritativeSessions.delete(conv.id);
    this.authoritativeAttaching.delete(conv.id);
    this.pendingUserMsgIdQueue.delete(conv.id);
    this.activeSessionCounts.delete(conv.id);
    for (const [messageId, conversationId] of this.messageConvMap) {
      if (conversationId !== conv.id) continue;
      this.messageConvMap.delete(messageId);
      this.stepPartsBuffer.delete(messageId);
      this.contentPartsBuffer.delete(messageId);
      this.dirtySteps.delete(messageId);
      this.persistedPlaceholders.delete(messageId);
    }
    for (const [id, sessionId] of this.permissionSessionMap) {
      if (this.permissionEngineMap.get(id) === conv.engineType && (sessionId === conv.engineSessionId || sessionId === conv.id)) {
        this.permissionSessionMap.delete(id);
        this.permissionEngineMap.delete(id);
      }
    }
    for (const [id, sessionId] of this.questionSessionMap) {
      if (this.questionEngineMap.get(id) === conv.engineType && (sessionId === conv.engineSessionId || sessionId === conv.id)) {
        this.questionSessionMap.delete(id);
        this.questionEngineMap.delete(id);
      }
    }
    const removed = { sessionId: conv.id, ...(conversationAliases.length ? { conversationAliases } : {}) };
    this.emit("session.removed", removed);
    this.sessionRemovals.set(conv.id, operation);
    void operation.finally(() => this.sessionRemovals.delete(conv.id)).catch(() => {});
    return operation;
  }

  listCatalogs(): EngineCatalogSnapshot[] {
    this.visibleConversations();
    return conversationStore.listCatalogs().map((catalog) => ({
      ...catalog,
      sessions: catalog.sessions.filter((session) => !this.catalogSessionChecks.has(session.id)).map((session) => {
        const conv = conversationStore.get(session.id);
        return conv ? this.sessionFromConversation(conv) : session;
      }),
    }));
  }

  private applyCatalog(adapter: EngineAdapter, snapshot: EngineCatalogSnapshot): EngineCatalogSnapshot {
    if (adapter.getCapabilities().hideArchivedSessions) {
      for (const session of snapshot.sessions) {
        if (!session.archived) continue;
        const conv = conversationStore.findByEngineSession(session.id, adapter.engineType, snapshot.sourceId)
          ?? conversationStore.findByEngineSession(session.id, adapter.engineType);
        if (conv && this.isSessionCompatible(conv, adapter) && (!conv.catalogSourceId || conv.catalogSourceId === snapshot.sourceId)) {
          void this.purgeRemovedConversation(conv, "archived", snapshot.sourceId).catch((error) => engineManagerLog.error("Failed to remove archived mirror:", error));
        }
      }
      snapshot = { ...snapshot, sessions: snapshot.sessions.filter((session) => !session.archived) };
      this.visibleConversations({ engineType: adapter.engineType });
      this.verifyCatalogOmissions(adapter, snapshot);
    }
    const previousSource = this.catalogSources.get(adapter.engineType);
    if (previousSource && previousSource !== snapshot.sourceId) {
      const previous = conversationStore.markCatalogUnavailable(adapter.engineType, previousSource);
      if (previous) this.emit("catalog.updated", { ...previous, sessions: previous.sessions.filter((session) => !this.catalogSessionChecks.has(session.id)) });
    }
    const normalized = conversationStore.upsertCatalog(adapter.engineType, {
      ...snapshot,
      sessions: snapshot.sessions.map((session) => {
        const scoped = conversationStore.findByEngineSession(session.id, adapter.engineType, snapshot.sourceId);
        const legacy = scoped ? undefined : conversationStore.findByEngineSession(session.id, adapter.engineType);
        const conv = scoped ?? (legacy && !legacy.catalogSourceId && this.isSessionCompatible(legacy, adapter) ? legacy : undefined);
        const liveOwner = !session.archived && (adapter.hasSession(session.id) || !!(conv && this.authoritativeAttaching.has(conv.id)));
        if (conv && !liveOwner) this.authoritativeLiveFields.delete(conv.id);
        const live = liveOwner && conv ? this.authoritativeLiveFields.get(conv.id) : undefined;
        if (live) return { ...session, ...live } as UnifiedSession;
        return session.archived || !liveOwner ? { ...session, activityStatus: session.archived ? "idle" : session.activityStatus ?? "idle" } : session;
      }),
    });
    normalized.sessions = normalized.sessions.filter((session) => !this.catalogSessionChecks.has(session.id));
    this.catalogSources.set(adapter.engineType, snapshot.sourceId);
    this.catalogRevisions.set(adapter.engineType, (this.catalogRevisions.get(adapter.engineType) ?? 0) + 1);
    for (const session of normalized.sessions) {
      const conv = conversationStore.get(session.id);
      if (!conv?.engineSessionId) continue;
      this.sessionEngineMap.set(conv.id, adapter.engineType);
      this.engineToConvMap.set(JSON.stringify([adapter.engineType, snapshot.sourceId, conv.engineSessionId]), conv.id);
      this.authoritativeSessions.set(conv.id, { ...this.authoritativeSessions.get(conv.id), ...session });
    }
    this.emit("catalog.updated", normalized);
    return normalized;
  }

  private markCatalogsUnavailable(engineType: EngineType): void {
    this.visibleConversations({ engineType });
    for (const catalog of conversationStore.listCatalogs()) {
      if (catalog.engineType !== engineType) continue;
      const unavailable = conversationStore.markCatalogUnavailable(engineType, catalog.sourceId);
      if (unavailable) this.emit("catalog.updated", { ...unavailable, sessions: unavailable.sessions.filter((session) => !this.catalogSessionChecks.has(session.id)) });
    }
  }

  private rememberLiveSessionFields(conversationId: string, session: Partial<UnifiedSession>, ownerAvailable: boolean): void {
    if (!ownerAvailable || session.archived) {
      this.authoritativeLiveFields.delete(conversationId);
      return;
    }
    const fields: Partial<UnifiedSession> = { ...this.authoritativeLiveFields.get(conversationId) };
    for (const key of ["mode", "modelId", "reasoningEffort", "serviceTier", "activityStatus", "connection"] as const) {
      if (Object.prototype.hasOwnProperty.call(session, key)) Object.assign(fields, { [key]: session[key] });
    }
    this.authoritativeLiveFields.set(conversationId, fields);
  }

  private async refreshCatalog(adapter: EngineAdapter, afterMutation = false): Promise<EngineCatalogSnapshot> {
    const pending = this.catalogRefreshes.get(adapter.engineType);
    if (pending) {
      if (!afterMutation) return pending;
      await pending.catch(() => undefined);
      return this.refreshCatalog(adapter, true);
    }
    const revision = this.catalogRevisions.get(adapter.engineType) ?? 0;
    const operation = Promise.resolve().then(() => adapter.getCatalog()).then((snapshot) => {
      if ((this.catalogRevisions.get(adapter.engineType) ?? 0) !== revision) {
        const latest = this.listCatalogs().find((catalog) => catalog.engineType === adapter.engineType
          && catalog.sourceId === this.catalogSources.get(adapter.engineType));
        if (latest) return latest;
      }
      return this.applyCatalog(adapter, snapshot);
    }).catch((error) => {
      this.markCatalogsUnavailable(adapter.engineType);
      throw error;
    }).finally(() => this.catalogRefreshes.delete(adapter.engineType));
    this.catalogRefreshes.set(adapter.engineType, operation);
    return operation;
  }

  private async catalogAdapter(sourceId: string): Promise<EngineAdapter> {
    const sources = conversationStore.listCatalogs().filter((catalog) => catalog.sourceId === sourceId);
    if (sources.length !== 1 || !sources[0].engineType) throw new Error("Catalog source is unavailable or ambiguous.");
    const adapter = this.getAdapterOrThrow(sources[0].engineType);
    if (!adapter.getCapabilities().sessionCatalog || !adapter.getCapabilities().catalogManagement) {
      throw new Error("This engine does not support catalog project management.");
    }
    await this.refreshCatalog(adapter, true);
    if (this.catalogSources.get(adapter.engineType) !== sourceId) throw new Error("The catalog source is not connected to this engine.");
    return adapter;
  }

  private requireCatalogProject(projectId: string): UnifiedProject {
    projectId = canonicalCodexProjectId(projectId);
    const project = conversationStore.getCatalogProject(projectId);
    if (!project?.catalogSourceId || !project.catalogProjectId || project.catalogAvailable === false) {
      throw new Error("The catalog project is unavailable.");
    }
    return project;
  }

  private forgetConversationMappings(conversationId: string): void {
    for (const [key, mappedId] of this.engineToConvMap) {
      if (mappedId === conversationId) this.engineToConvMap.delete(key);
    }
    this.authoritativeLiveFields.delete(conversationId);
  }

  private validateProjectInput(input: CatalogProjectInput): CatalogProjectInput {
    if (!input || typeof input.name !== "string" || !input.name.trim() || !Array.isArray(input.roots)
      || input.roots.some((root) => typeof root !== "string" || !root.trim())) {
      throw new Error("A project name and an array of root paths are required.");
    }
    return { name: input.name.trim(), roots: input.roots.slice() };
  }

  // --- Event Forwarding ---

  /**
   * Resolve engineSessionId → conversationId.
   * Uses in-memory cache first, then falls back to ConversationStore lookup.
   */
  private resolveConversationId(engineSessionId: string, engineType?: EngineType): string | null {
    if (engineType) engineType = this.resolveEngineType(engineType);
    const adapter = engineType ? this.getAdapter(engineType) : undefined;
    const compatible = (conv: ConversationMeta | null | undefined) => !!conv && (!adapter || this.isSessionCompatible(conv, adapter));
    const sourceId = engineType ? this.catalogSources.get(engineType) : undefined;
    if (engineType && sourceId) {
      const key = JSON.stringify([engineType, sourceId, engineSessionId]);
      const cached = this.engineToConvMap.get(key);
      if (cached && compatible(conversationStore.get(cached))) return conversationStore.resolveConversationId(cached);
      const scoped = conversationStore.findByEngineSession(engineSessionId, engineType, sourceId);
      if (scoped && compatible(scoped)) {
        this.engineToConvMap.set(key, scoped.id);
        return scoped.id;
      }
      const legacy = conversationStore.findByEngineSession(engineSessionId, engineType);
      return legacy && !legacy.catalogSourceId && compatible(legacy) ? legacy.id : null;
    }
    if (engineType && adapter?.getCapabilities().sessionCatalog) {
      const legacy = conversationStore.findByEngineSession(engineSessionId, engineType);
      return legacy && !legacy.catalogSourceId && compatible(legacy) ? legacy.id : null;
    }
    const cacheKey = engineType ? JSON.stringify([engineType, engineSessionId]) : engineSessionId;
    const cached = this.engineToConvMap.get(cacheKey);
    if (cached && compatible(conversationStore.get(cached))) return conversationStore.resolveConversationId(cached);
    const conv = conversationStore.findByEngineSession(engineSessionId, engineType);
    if (conv && compatible(conv)) {
      this.engineToConvMap.set(cacheKey, conv.id);
      return conv.id;
    }
    return null;
  }

  /**
   * Check if a part is a "content" part (text or file) that belongs in ConversationMessage,
   * vs a "step" part (reasoning, tool, step-start/finish, snapshot, patch) that goes in StepsFile.
   */
  private isContentPart(part: UnifiedPart): part is TextPart | FilePart {
    return part.type === "text" || part.type === "file";
  }

  /**
   * Rewrite sessionId fields in event data from engineSessionId to conversationId.
   * Returns null if the mapping cannot be resolved.
   */
  private rewriteSessionId(
    data: Record<string, any>,
    engineSessionId: string,
    conversationId: string,
  ): Record<string, any> {
    const rewritten = { ...data };
    // Top-level sessionId
    if ("sessionId" in rewritten && rewritten.sessionId === engineSessionId) {
      rewritten.sessionId = conversationId;
    }
    // Nested message.sessionId
    if ("message" in rewritten && rewritten.message?.sessionId === engineSessionId) {
      rewritten.message = { ...rewritten.message, sessionId: conversationId };
      // Rewrite parts inside the message
      if (Array.isArray(rewritten.message.parts)) {
        rewritten.message.parts = rewritten.message.parts.map((p: any) =>
          p.sessionId === engineSessionId ? { ...p, sessionId: conversationId } : p,
        );
      }
    }
    // Nested part.sessionId
    if ("part" in rewritten && rewritten.part?.sessionId === engineSessionId) {
      rewritten.part = { ...rewritten.part, sessionId: conversationId };
    }
    // Nested permission.sessionId
    if ("permission" in rewritten && rewritten.permission?.sessionId === engineSessionId) {
      rewritten.permission = { ...rewritten.permission, sessionId: conversationId };
    }
    // Nested session.id (e.g., in session.created / session.updated events)
    if ("session" in rewritten && rewritten.session?.id === engineSessionId) {
      rewritten.session = { ...rewritten.session, id: conversationId };
    }
    // Nested question.sessionId (e.g., in question.asked events)
    if ("question" in rewritten && rewritten.question?.sessionId === engineSessionId) {
      rewritten.question = { ...rewritten.question, sessionId: conversationId };
    }
    return rewritten;
  }

  private forwardEvents(adapter: EngineAdapter): void {
    adapter.on("catalog.updated", (snapshot) => {
      if (!adapter.getCapabilities().sessionCatalog) return;
      try {
        this.applyCatalog(adapter, snapshot);
      } catch (error) {
        engineManagerLog.warn(`Invalid catalog update for ${adapter.engineType}:`, error);
        this.markCatalogsUnavailable(adapter.engineType);
      }
    });
    adapter.on("session.removed", ({ sessionId }) => {
      const conversationId = this.resolveConversationId(sessionId, adapter.engineType);
      const conv = conversationId && conversationStore.get(conversationId);
      if (!conv) return;
      void this.purgeRemovedConversation(conv, "archived", conv.catalogSourceId ?? this.catalogSources.get(adapter.engineType))
        .catch((error) => engineManagerLog.error("Failed to remove excluded mirror:", error));
    });
    // --- message.part.updated: accumulate step parts + rewrite sessionId ---
    adapter.on("message.part.updated", (data) => {
      const { sessionId: engineSessionId, messageId, part } = data;
      if (this.ignoreSessionEvent(adapter, engineSessionId)) return;
      const convId = this.resolveConversationId(engineSessionId, adapter.engineType);

      // External engines supply complete live messages on read; their streaming
      // state must not depend on this process's persistence buffers.
      if (adapter.getCapabilities().authoritativeSessionState) {
        this.emit("message.part.updated", convId
          ? this.rewriteSessionId(data, engineSessionId, convId) as typeof data
          : data);
        return;
      }

      // Accumulate parts for later persistence
      if (this.isContentPart(part)) {
        // Buffer content parts (text/file) — these are NOT included in
        // message.updated's parts array (OpenCode sends them only via
        // part.updated SSE), so we must buffer them separately.
        const key = messageId;
        if (!this.contentPartsBuffer.has(key)) {
          this.contentPartsBuffer.set(key, []);
        }
        const buffer = this.contentPartsBuffer.get(key)!;
        const existingIdx = buffer.findIndex((p) => p.id === part.id);
        if (existingIdx >= 0) {
          buffer[existingIdx] = part as TextPart | FilePart;
        } else {
          buffer.push(part as TextPart | FilePart);
        }
      } else {
        // Buffer step-type parts
        const key = messageId;
        if (!this.stepPartsBuffer.has(key)) {
          this.stepPartsBuffer.set(key, []);
        }
        const buffer = this.stepPartsBuffer.get(key)!;
        const existingIdx = buffer.findIndex((p) => p.id === part.id);
        if (existingIdx >= 0) {
          buffer[existingIdx] = part;
        } else {
          buffer.push(part);
        }

        // Mark for incremental persistence
        if (convId) {
          this.messageConvMap.set(messageId, convId);
          this.dirtySteps.add(messageId);
          this.scheduleStepFlush();
        }
      }

      // Rewrite sessionId and forward to frontend
      if (convId) {
        const rewritten = this.rewriteSessionId(data, engineSessionId, convId);
        this.emit("message.part.updated", rewritten as any);
      } else {
        this.emit("message.part.updated", data);
      }
    });

    // --- message.updated: persist message + flush steps + rewrite sessionId ---
    adapter.on("message.updated", (data) => {
      const { sessionId: engineSessionId, message } = data;
      if (this.ignoreSessionEvent(adapter, engineSessionId)) return;
      const convId = this.resolveConversationId(engineSessionId, adapter.engineType);

      if (convId) {
        // Persist the message
        const authoritative = adapter.getCapabilities().authoritativeSessionState === true;
        this.persistMessage(convId, message, authoritative);

        // Rewrite sessionId and forward to frontend
        const rewritten = this.rewriteSessionId(authoritative
          ? { ...data, message: this.projectHistoryMessage(message) } : data, engineSessionId, convId);
        this.emit("message.updated", rewritten as any);
      } else {
        this.emit("message.updated", data);
      }
    });

    adapter.on("message.removed", (data) => {
      const { sessionId: engineSessionId, messageId } = data;
      if (this.ignoreSessionEvent(adapter, engineSessionId)) return;
      const convId = this.resolveConversationId(engineSessionId, adapter.engineType);

      this.messageGenerations.set(messageId, (this.messageGenerations.get(messageId) ?? 0) + 1);
      this.stepPartsBuffer.delete(messageId);
      this.contentPartsBuffer.delete(messageId);
      this.dirtySteps.delete(messageId);
      this.persistedPlaceholders.delete(messageId);
      this.messageConvMap.delete(messageId);

      if (convId) {
        void this.runMessageWrite(convId, () => conversationStore.removeMessage(convId, messageId)).catch(() => {});
      }

      this.emit("message.removed", convId ? { ...data, sessionId: convId } : data);
    });

    // --- session.updated: persist metadata changes then forward with rewrite ---
    adapter.on("session.updated", (data) => {
      const engineSessionId = data?.session?.id;
      if (engineSessionId && this.ignoreSessionEvent(adapter, engineSessionId)) return;
      const convId = engineSessionId ? this.resolveConversationId(engineSessionId, adapter.engineType) : null;
      if (adapter.getCapabilities().hideArchivedSessions && data.session.archived) {
        const conv = convId && conversationStore.get(convId);
        if (conv) void this.purgeRemovedConversation(conv, "archived").catch((error) => engineManagerLog.error("Failed to remove archived mirror:", error));
        return;
      }

      if (convId) {
        if (adapter.getCapabilities().authoritativeSessionState) {
          const attachingLiveSnapshot = this.authoritativeAttaching.has(convId)
            && data.session.activityStatus !== undefined && data.session.activityStatus !== "error";
          this.rememberLiveSessionFields(convId, data.session, adapter.hasSession(engineSessionId!) || attachingLiveSnapshot);
          this.authoritativeSessions.set(convId, {
            ...this.authoritativeSessions.get(convId),
            ...data.session,
          });
        }
        this.syncArchivedState(convId, data.session);
        const current = conversationStore.get(convId);
        if (current?.catalogSourceId) {
          const patch: Partial<ConversationMeta> = {};
          if (Object.prototype.hasOwnProperty.call(data.session, "projectId")) {
            patch.projectId = data.session.projectId == null ? null
              : makeCatalogProjectId(adapter.engineType, current.catalogSourceId, data.session.projectId);
          }
          if (typeof data.session.directory === "string") patch.directory = data.session.directory;
          if (Object.keys(patch).length > 0) conversationStore.update(convId, patch);
        }
        if (adapter.getCapabilities().authoritativeSessionState && current && Object.prototype.hasOwnProperty.call(data.session, "title")) {
          const title = data.session.title?.trim() || undefined;
          if (current.engineTitle !== title || current.customTitle !== undefined) {
            conversationStore.update(convId, { customTitle: undefined, engineTitle: title });
          }
        } else if (data.session.title && current) {
          const title = getUsableEngineTitleCandidate(current, data.session.title);
          if (title) conversationStore.setEngineTitle(convId, title);
        }
        // Persist engineMeta (e.g. ccSessionId for Claude Code session resumption)
        if (data.session.engineMeta) {
          conversationStore.setEngineSession(
            convId,
            conversationStore.get(convId)?.engineSessionId ?? "",
            data.session.engineMeta as Record<string, unknown>,
          );
        }
        if (
          Object.prototype.hasOwnProperty.call(data.session, "mode")
          || Object.prototype.hasOwnProperty.call(data.session, "modelId")
          || Object.prototype.hasOwnProperty.call(data.session, "reasoningEffort")
          || Object.prototype.hasOwnProperty.call(data.session, "serviceTier")
        ) {
          conversationStore.updateSessionConfig(convId, {
            ...(Object.prototype.hasOwnProperty.call(data.session, "mode") ? { mode: data.session.mode ?? null } : {}),
            ...(Object.prototype.hasOwnProperty.call(data.session, "modelId") ? { modelId: data.session.modelId ?? null } : {}),
            ...(Object.prototype.hasOwnProperty.call(data.session, "reasoningEffort")
              ? { reasoningEffort: data.session.reasoningEffort ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(data.session, "serviceTier")
              ? { serviceTier: data.session.serviceTier ?? null }
              : {}),
          });
        }
        const conv = conversationStore.get(convId);
        if (conv) {
          this.emit("session.updated", { session: this.sessionFromConversation(conv) });
        }
      } else {
        this.emit("session.updated", data);
      }
    });

    // --- Other events: simple forwarding with sessionId rewrite ---
    const simpleEvents: (keyof EngineAdapterEvents)[] = [
      "session.created",
      "permission.asked",
      "permission.replied",
      "question.asked",
      "question.replied",
      "status.changed",
      "message.queued",
      "message.queued.consumed",
      "commands.changed",
    ];

    for (const event of simpleEvents) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapter.on(event, (data: any) => {
        if (event === "permission.replied" || event === "question.replied") {
          const permission = event === "permission.replied";
          const id = permission ? data?.permissionId : data?.questionId;
          const engines = permission ? this.permissionEngineMap : this.questionEngineMap;
          const sessions = permission ? this.permissionSessionMap : this.questionSessionMap;
          const key = `${permission ? "permission" : "question"}:${id}`;
          const submitted = this.interactionReplies.get(key);
          const sessionId = data?.sessionId ?? (engines.get(id) === adapter.engineType ? sessions.get(id) : undefined)
            ?? (submitted?.engineType === adapter.engineType ? submitted.sessionId : undefined);
          if (sessionId) data = { ...data, sessionId };
          if (engines.get(id) === adapter.engineType) {
            engines.delete(id);
            sessions.delete(id);
            if (!submitted) this.rememberInteractionReply(key, {
              engineType: adapter.engineType, sessionId,
              fingerprint: permission ? JSON.stringify(data.optionId) : JSON.stringify(["answer", data.answers]),
              promise: Promise.resolve(), completed: true,
            });
          }
        }
        const eventSessionId = data?.sessionId || data?.session?.id || data?.permission?.sessionId || data?.question?.sessionId;
        if (eventSessionId && (this.ignoreSessionEvent(adapter, eventSessionId)
          || (adapter.getCapabilities().hideArchivedSessions && data?.session?.archived))) return;
        if (event === "status.changed" && data?.status === "running") {
          if (adapter.getCapabilities().sessionCatalog) {
            void this.refreshCatalog(adapter).catch((error) => engineManagerLog.warn(`Failed to refresh catalog for ${adapter.engineType}:`, error));
          } else if (adapter.getCapabilities().authoritativeSessionState) {
            this.reconnectPersistedAuthoritativeSessions(adapter);
          }
        } else if (event === "status.changed" && ["stopped", "error"].includes(data?.status) && adapter.getCapabilities().sessionCatalog) {
          this.markCatalogsUnavailable(adapter.engineType);
        }
        // Track permission → engine mapping for routing replies
        if (event === "permission.asked" && data?.permission?.id) {
          const key = `permission:${data.permission.id}`;
          if (this.interactionReplies.get(key)?.completed) this.interactionReplies.delete(key);
          this.permissionEngineMap.set(data.permission.id, adapter.engineType);
          // Also store sessionId so adapters can resolve correct directory
          const permSid = data?.permission?.sessionId || data?.sessionId;
          if (permSid) this.permissionSessionMap.set(data.permission.id, permSid);
        }
        // Track question → engine mapping for routing replies
        if (event === "question.asked" && data?.question?.id) {
          const key = `question:${data.question.id}`;
          if (this.interactionReplies.get(key)?.completed) this.interactionReplies.delete(key);
          this.questionEngineMap.set(data.question.id, adapter.engineType);
          // Also store sessionId so adapters can resolve correct directory
          const qSid = data?.question?.sessionId || data?.sessionId;
          if (qSid) this.questionSessionMap.set(data.question.id, qSid);
        }

        // Rewrite sessionId if applicable
        const engineSessionId =
          data?.sessionId || data?.session?.id || data?.permission?.sessionId || data?.question?.sessionId;
        if (engineSessionId) {
          const convId = this.resolveConversationId(engineSessionId, adapter.engineType);
          if (convId) {
            this.emit(event, this.rewriteSessionId(data, engineSessionId, convId) as any);
            return;
          }
        }
        // Don't forward session.created if we can't resolve the conversation ID.
        // This happens during lazy engine session creation in sendMessage() —
        // the frontend already knows about the session via the prior createSession() call.
        if (event === "session.created") return;
        this.emit(event, data);
      });
    }
  }

  private runMessageWrite<T>(conversationId: string, write: () => Promise<T>): Promise<T> {
    // A removal or full snapshot closes the preceding burst before later events arrive.
    this.authoritativeMessageBatches.delete(conversationId);
    const previous = this.authoritativeMessageWrites.get(conversationId) ?? Promise.resolve();
    const result = previous.then(write);
    const pending = result.then(() => undefined).catch((err) => {
      engineManagerLog.error(`Failed to mirror message changes for ${conversationId}:`, err);
    });
    this.authoritativeMessageWrites.set(conversationId, pending);
    // Include queued snapshots and removals before their first write starts.
    this.trackMessageWrite(pending);
    void pending.then(() => {
      if (this.authoritativeMessageWrites.get(conversationId) === pending) {
        this.authoritativeMessageWrites.delete(conversationId);
      }
    });
    return result;
  }

  /**
   * Persist a UnifiedMessage to ConversationStore.
   * Splits content parts (text/file) into ConversationMessage and step parts into StepsFile.
   * Only persists completed assistant messages (those with time.completed).
   * User messages are normally persisted via persistUserMessage(); this method only
   * updates the most recent persisted user message when an adapter emits an enriched
   * user message carrying enqueuedAt/processedAt (i.e. a queued message that just
   * started processing). Authoritative external engines instead upsert their own
   * user message IDs, including messages submitted from another client.
   */
  private persistMessage(
    conversationId: string,
    message: UnifiedMessage,
    authoritative = false,
  ): Promise<void> {
    if (message.role === "assistant" && !message.time.completed) return Promise.resolve();
    // Cancellation may clear streaming buffers before this queued completion runs.
    const snapshot: MessageWriteSnapshot = {
      generation: this.messageGenerations.get(message.id) ?? 0,
      content: [...(this.contentPartsBuffer.get(message.id) ?? [])],
      steps: [...(this.stepPartsBuffer.get(message.id) ?? [])],
    };
    if (authoritative) return this.persistAuthoritativeMessage(conversationId, message, snapshot);
    return this.runMessageWrite(conversationId, () => this.writeMessage(conversationId, message, snapshot));
  }

  private persistAuthoritativeMessage(conversationId: string, message: UnifiedMessage, snapshot: MessageWriteSnapshot): Promise<void> {
    const pending = this.authoritativeMessageBatches.get(conversationId);
    if (pending) {
      pending.messages.set(message.id, { message, snapshot });
      return pending.completion;
    }
    const batch: AuthoritativeMessageBatch = { messages: new Map([[message.id, { message, snapshot }]]), completion: Promise.resolve() };
    batch.completion = this.runMessageWrite(conversationId, async () => {
      if (this.authoritativeMessageBatches.get(conversationId) === batch) this.authoritativeMessageBatches.delete(conversationId);
      const messages = [...batch.messages.values()].map(({ message: value, snapshot: saved }) => {
        const parts = [...value.parts];
        const ids = new Set(parts.map((part) => part.id));
        for (const part of [...saved.content, ...saved.steps]) {
          if (ids.has(part.id)) continue;
          ids.add(part.id);
          parts.push(part);
        }
        return { ...value, sessionId: conversationId, parts: parts.map((part) => ({ ...part, sessionId: conversationId })) };
      });
      await conversationStore.upsertMessageSnapshots(conversationId, messages);
      for (const { message: value, snapshot: saved } of batch.messages.values()) {
        const unchanged = (current: UnifiedPart[] | undefined, captured: UnifiedPart[]) =>
          !current || (current.length === captured.length && current.every((part, index) => part === captured[index]));
        if (unchanged(this.contentPartsBuffer.get(value.id), saved.content)) this.contentPartsBuffer.delete(value.id);
        if (unchanged(this.stepPartsBuffer.get(value.id), saved.steps)) {
          this.stepPartsBuffer.delete(value.id);
          this.dirtySteps.delete(value.id);
          this.persistedPlaceholders.delete(value.id);
          this.messageConvMap.delete(value.id);
        }
      }
    });
    this.authoritativeMessageBatches.set(conversationId, batch);
    // Adapter events do not await persistence; the ordered queue still reports errors.
    void batch.completion.catch(() => {});
    return batch.completion;
  }

  private trackMessageWrite(write: Promise<void>): Promise<void> {
    this.pendingMessageWrites.add(write);
    void write.then(
      () => { this.pendingMessageWrites.delete(write); },
      () => { this.pendingMessageWrites.delete(write); },
    );
    return write;
  }

  private async writeMessage(
    conversationId: string,
    message: UnifiedMessage,
    snapshot: MessageWriteSnapshot,
  ): Promise<void> {
    const isCurrent = () => (this.messageGenerations.get(message.id) ?? 0) === snapshot.generation;
    if (!isCurrent()) return;
    if (message.role === "user") {
      // Adapter-emitted queued user messages have a different ID than the one
      // we wrote via persistUserMessage at send time. Track only queued sends in
      // pendingUserMsgIdQueue so foreground messages cannot consume timing
      // patches intended for later queued messages.
      if (message.enqueuedAt == null && message.processedAt == null) return;
      const queue = this.pendingUserMsgIdQueue.get(conversationId);
      const targetId = queue?.shift();
      if (queue && queue.length === 0) this.pendingUserMsgIdQueue.delete(conversationId);
      if (!targetId) return; // No pending entry — likely a duplicate emit
      try {
        // Partial patch — updateMessage internally merges via Object.assign,
        // so we don't need to send the full message body.
        await conversationStore.updateMessage(conversationId, targetId, {
          enqueuedAt: message.enqueuedAt,
          processedAt: message.processedAt,
        });
      } catch (err) {
        engineManagerLog.warn(`Failed to patch user message timing for ${conversationId}:`, err);
      }
      return;
    }

    try {
      // Split parts into content vs steps, rewriting sessionId to conversationId
      const contentParts: Array<TextPart | FilePart> = [];
      const stepParts: UnifiedPart[] = [];

      for (const part of message.parts || []) {
        const rewritten = part.sessionId !== conversationId
          ? { ...part, sessionId: conversationId }
          : part;
        if (this.isContentPart(rewritten)) {
          contentParts.push(rewritten);
        } else {
          stepParts.push(rewritten);
        }
      }

      // Merge buffered content parts (text/file sent via part.updated SSE,
      // which are often NOT included in message.updated's parts array).
      const bufferedContent = [...(this.contentPartsBuffer.get(message.id) ?? []), ...snapshot.content];
      for (const bp of bufferedContent) {
        if (!contentParts.some((p) => p.id === bp.id)) {
          const rewritten = bp.sessionId !== conversationId
            ? { ...bp, sessionId: conversationId } as TextPart | FilePart
            : bp;
          contentParts.push(rewritten);
        }
      }

      // Build ConversationMessage (content parts only)
      const convMessage: ConversationMessage = {
        id: message.id,
        role: message.role,
        time: message.time,
        enqueuedAt: message.enqueuedAt,
        processedAt: message.processedAt,
        parts: contentParts,
        tokens: message.tokens,
        cost: message.cost,
        costUnit: message.costUnit,
        modelId: message.modelId,
        reasoningEffort: message.reasoningEffort,
        error: message.error,
      };

      const existingMessages = await conversationStore.listMessages(conversationId);
      if (!isCurrent()) return;
      if (existingMessages.some((m) => m.id === message.id)) {
        await conversationStore.updateMessage(conversationId, message.id, convMessage);
      } else {
        await conversationStore.appendMessage(conversationId, convMessage);
      }

      if (!isCurrent()) return;
      // Merge buffered step parts with any steps from the message itself
      const bufferedSteps = [...(this.stepPartsBuffer.get(message.id) ?? []), ...snapshot.steps];
      const allSteps = [...stepParts];
      for (const bp of bufferedSteps) {
        if (!allSteps.some((s) => s.id === bp.id)) {
          const rewritten = bp.sessionId !== conversationId
            ? { ...bp, sessionId: conversationId }
            : bp;
          allSteps.push(rewritten);
        }
      }

      // A corrected snapshot must clear old steps even when it retains only text.
      if (allSteps.length > 0 || snapshot.generation > 0) {
        await conversationStore.saveSteps(conversationId, message.id, allSteps);
      }

      if (!isCurrent()) return;
      // Clean up buffers and incremental persistence state
      this.stepPartsBuffer.delete(message.id);
      this.contentPartsBuffer.delete(message.id);
      this.dirtySteps.delete(message.id);
      this.persistedPlaceholders.delete(message.id);
      this.messageConvMap.delete(message.id);

      engineManagerLog.debug(
        `Persisted message ${message.id} (${message.role}) to conversation ${conversationId}: ${contentParts.length} content parts, ${allSteps.length} steps`,
      );
    } catch (err) {
      engineManagerLog.error(`Failed to persist message ${message.id}:`, err);
    }
  }

  /**
   * Schedule a debounced flush of dirty step buffers to disk.
   * Uses a fixed 2s interval to avoid excessive I/O during streaming.
   */
  private scheduleStepFlush(): void {
    if (this.stepFlushTimer) return;
    this.stepFlushTimer = setTimeout(() => {
      this.stepFlushTimer = null;
      void this.flushDirtySteps().catch((err) => {
        engineManagerLog.warn("flushDirtySteps failed:", err);
      });
    }, EngineManager.STEP_FLUSH_INTERVAL_MS);
  }

  async flushPendingState(): Promise<void> {
    if (this.stepFlushTimer) {
      clearTimeout(this.stepFlushTimer);
      this.stepFlushTimer = null;
    }
    do {
      while (this.pendingMessageWrites.size > 0) {
        await Promise.allSettled([...this.pendingMessageWrites]);
      }
      await this.flushDirtySteps();
    } while (this.pendingMessageWrites.size > 0);
  }

  /**
   * Incrementally persist dirty step buffers to disk.
   * Ensures a placeholder assistant message exists so that steps are
   * discoverable via listMessages() even if the message never completes.
   */
  private flushDirtySteps(): Promise<void> {
    const flush = this.stepFlushPromise
      ? this.stepFlushPromise.then(() => this.writeDirtySteps())
      : this.writeDirtySteps();
    this.stepFlushPromise = flush;
    return flush.finally(() => {
      if (this.stepFlushPromise === flush) this.stepFlushPromise = null;
    });
  }

  private async writeDirtySteps(): Promise<void> {
    const toFlush = [...this.dirtySteps];
    this.dirtySteps.clear();

    for (const messageId of toFlush) {
      const convId = this.messageConvMap.get(messageId);
      if (!convId) continue;

      const steps = this.stepPartsBuffer.get(messageId);
      if (!steps || steps.length === 0) continue;
      const generation = this.messageGenerations.get(messageId) ?? 0;
      const isCurrent = () => (this.messageGenerations.get(messageId) ?? 0) === generation
        && this.stepPartsBuffer.get(messageId) === steps;

      try {
        await this.runMessageWrite(convId, async () => {
          if (!isCurrent()) return;
          // Ensure placeholder assistant message exists (once per message).
          if (!this.persistedPlaceholders.has(messageId)) {
            await conversationStore.ensureMessage(convId, {
              id: messageId,
              role: "assistant",
              time: { created: Date.now() },
              parts: [],
            });
            if (!isCurrent()) return;
            this.persistedPlaceholders.add(messageId);
          }

          // Rewrite sessionId in steps to use conversationId before persisting.
          const rewrittenSteps = steps.map((s) =>
            s.sessionId !== convId ? { ...s, sessionId: convId } : s,
          );
          await conversationStore.saveSteps(convId, messageId, rewrittenSteps);
        });
      } catch (err) {
        engineManagerLog.error(`Failed to flush steps for ${messageId}:`, err);
        // Retry only the current buffer; a removed snapshot must stay invalidated.
        if (isCurrent()) this.dirtySteps.add(messageId);
      }
    }
  }

  /**
   * Persist a user message from sendMessage() content.
   * Called before adapter.sendMessage() to ensure user messages are saved
   * even if the adapter doesn't emit user message events (e.g., OpenCode).
   */
  private persistUserMessage(
    conversationId: string,
    content: MessagePromptContent[],
    trackQueuedTiming = false,
  ): Promise<void> {
    return this.trackMessageWrite(this.writeUserMessage(conversationId, content, trackQueuedTiming));
  }

  private async writeUserMessage(
    conversationId: string,
    content: MessagePromptContent[],
    trackQueuedTiming: boolean,
  ): Promise<void> {
    try {
      const now = Date.now();
      const msgId = timeId("msg");

      // Build parts from prompt content. Images are persisted inline as
      // data: URLs inside a FilePart so the webui can render them after
      // session reload. Per-image size is already bounded upstream
      // (frontend & Feishu both cap individual images at 3MB), so the
      // resulting JSON growth is acceptable.
      const parts: Array<TextPart | FilePart> = [];
      let partIdx = 0;
      let imageIdx = 0;
      for (const c of content) {
        if (c.type === "text" && c.text) {
          parts.push({
            type: "text" as const,
            id: `${msgId}_p${partIdx++}`,
            messageId: msgId,
            sessionId: conversationId,
            text: c.text,
          });
        } else if (c.type === "image" && c.data) {
          const mime = c.mimeType ?? "image/png";
          const ext = mimeToFileExtension(mime);
          parts.push({
            type: "file" as const,
            id: `${msgId}_p${partIdx++}`,
            messageId: msgId,
            sessionId: conversationId,
            mime,
            filename: `image-${++imageIdx}.${ext}`,
            url: `data:${mime};base64,${c.data}`,
          });
        }
      }

      if (parts.length === 0) return;

      const convMessage: ConversationMessage = {
        id: msgId,
        role: "user",
        time: { created: now, completed: now },
        parts,
      };

      const hadFirstPrompt = !!conversationStore.get(conversationId)?.firstPrompt;
      await conversationStore.appendMessage(conversationId, convMessage);

      if (!hadFirstPrompt) {
        const updated = conversationStore.get(conversationId);
        if (updated?.firstPrompt) {
          this.emit("session.updated", { session: convToSession(updated) });
        }
      }

      if (trackQueuedTiming) {
        // Queue this ID only for sends known to be queued. Foreground sends do
        // not later emit timing patches and must not shift the FIFO.
        const queue = this.pendingUserMsgIdQueue.get(conversationId) ?? [];
        queue.push(msgId);
        this.pendingUserMsgIdQueue.set(conversationId, queue);
      }

      engineManagerLog.debug(
        `Persisted user message ${msgId} to conversation ${conversationId}: ${parts.length} parts`,
      );
    } catch (err) {
      engineManagerLog.error(`Failed to persist user message for conversation ${conversationId}:`, err);
    }
  }

  // --- Project-Engine Bindings ---

  setProjectEngine(directory: string, engineType: EngineType): void {
    engineType = this.resolveEngineType(engineType);
    this.getAdapterOrThrow(engineType); // Validate engine exists
    this.projectBindings.set(normalizeDir(directory), engineType);
  }

  getProjectEngine(directory: string): EngineType | undefined {
    return this.projectBindings.get(normalizeDir(directory));
  }

  getProjectBindings(): Map<string, EngineType> {
    return new Map(this.projectBindings);
  }

  loadProjectBindings(bindings: Record<string, EngineType>): void {
    for (const [dir, engine] of Object.entries(bindings)) {
      this.projectBindings.set(normalizeDir(dir), this.resolveEngineType(engine));
    }
  }

  // --- Lifecycle ---

  async startAll(): Promise<void> {
    const startPromises = Array.from(this.adapters.values()).map((adapter) =>
      adapter.start().catch((err) => {
        engineManagerLog.error(`Failed to start ${adapter.engineType}:`, err);
      }),
    );
    await Promise.all(startPromises);
  }

  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.adapters.values()).map((adapter) =>
      adapter.stop().catch((err) => {
        engineManagerLog.error(`Failed to stop ${adapter.engineType}:`, err);
      }),
    );
    await Promise.all(stopPromises);
  }

  async startEngine(engineType: EngineType): Promise<void> {
    const adapter = this.getAdapterOrThrow(engineType);
    await adapter.start();
  }

  async stopEngine(engineType: EngineType): Promise<void> {
    const adapter = this.getAdapterOrThrow(engineType);
    await adapter.stop();
  }

  // --- Engine Info ---

  listEngines(): EngineInfo[] {
    return Array.from(this.adapters.values()).map((a) => a.getInfo());
  }

  /**
   * Get the user-configured default engine type from settings.json.
   * Falls back to the first running engine, then to the first registered engine.
   */
  getDefaultEngineType(): EngineType {
    const saved = this.resolveEngineType(getDefaultEngineFromSettings() as EngineType);
    const adapter = this.adapters.get(saved as EngineType);
    if (adapter && adapter.getInfo().status === "running") {
      return saved as EngineType;
    }
    // Fallback: first running engine
    for (const [type, adapter] of this.adapters) {
      if (adapter.getInfo().status === "running") return type;
    }
    // Last resort: first registered engine
    const first = this.adapters.keys().next();
    return (first.done ? "opencode" : first.value) as EngineType;
  }

  getEngineInfo(engineType: EngineType): EngineInfo {
    return this.getAdapterOrThrow(engineType).getInfo();
  }

  getSessionSharing(engineType: EngineType) {
    return this.getAdapterOrThrow(engineType).getSessionSharing();
  }

  async setSessionSharing(engineType: EngineType, enabled: boolean) {
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
    return this.getAdapterOrThrow(engineType).setSessionSharing(enabled);
  }

  // --- Sessions (backed by ConversationStore) ---

  async listSessions(engineTypeOrDirectory: string): Promise<UnifiedSession[]> {
    engineTypeOrDirectory = this.resolveEngineType(engineTypeOrDirectory as EngineType);
    if (this.adapters.has(engineTypeOrDirectory as EngineType)) {
      // List all conversations for this engine type
      const convs = this.visibleConversations({ engineType: engineTypeOrDirectory as EngineType });
      // Register all for routing
      for (const conv of convs) {
        this.sessionEngineMap.set(conv.id, conv.engineType);
      }
      return convs.map((conv) => this.sessionFromConversation(conv));
    } else {
      // List conversations for a specific directory
      const convs = this.visibleConversations({ directory: engineTypeOrDirectory });
      for (const conv of convs) {
        this.sessionEngineMap.set(conv.id, conv.engineType);
      }
      return convs.map((conv) => this.sessionFromConversation(conv));
    }
  }

  async createSession(
    engineType: EngineType | undefined,
    directory: string,
    worktreeId?: string,
    projectId?: string | null,
  ): Promise<UnifiedSession> {
    if (engineType) engineType = this.resolveEngineType(engineType);
    if (projectId) projectId = canonicalCodexProjectId(projectId);
    const project = projectId == null ? undefined : this.requireCatalogProject(projectId);
    if (project && engineType && project.engineType !== engineType) throw new Error("The project belongs to another engine.");
    const resolvedType = project?.engineType || engineType || this.getDefaultEngineType();
    const adapter = this.getAdapterOrThrow(resolvedType); // Validate engine exists
    if (project && !adapter.getCapabilities().catalogManagement) throw new Error("This engine does not support catalog project management.");
    const catalog = adapter.getCapabilities().sessionCatalog ? await this.refreshCatalog(adapter, true) : undefined;
    if (project && (!catalog || project.catalogSourceId !== catalog.sourceId)) throw new Error("The project belongs to another catalog source.");
    if (projectId !== undefined && !catalog) throw new Error("This engine does not support catalog project assignment.");
    const nativeProjectId = project?.catalogProjectId ?? null;

    // If worktreeId is specified, resolve worktree directory
    let sessionDir = directory;
    if (worktreeId) {
      const { worktreeManager } = await import("../services/worktree-manager");
      const projectId = await worktreeManager.resolveProjectId(directory);
      const wt = worktreeManager.getWorktreeByName(projectId, worktreeId);
      if (wt) {
        sessionDir = wt.directory;
      }
    }

    const localCreation = {
      engineType: resolvedType,
      directory: sessionDir,
      worktreeId,
      // Remember the original repo directory so worktree sessions group under the right project
      parentDirectory: worktreeId ? directory : undefined,
      ...(catalog ? { catalogSourceId: catalog.sourceId, projectId: project?.id ?? null } : {}),
    };
    // A catalog may announce the native thread before createSession resolves.
    // Delay the local row until its native ID is known, then reuse that mapping.
    let conv = catalog ? undefined : conversationStore.create(localCreation);
    if (conv) this.sessionEngineMap.set(conv.id, resolvedType);

    // Create the engine session immediately (not lazily on first sendMessage).
    // This ensures that engine-specific initialization (like fetching Copilot skills
    // or Claude V2 session init) happens at session creation time, so features
    // like slash command autocomplete work before the user sends a message.
    let engineCreated = false;
    try {
      const engineSession = await adapter.createSession(sessionDir, catalog
        ? { catalogSourceId: catalog.sourceId, catalogProjectId: nativeProjectId }
        : conv?.engineMeta);
      engineCreated = true;
      if (catalog) {
        conv = conversationStore.findByEngineSession(engineSession.id, resolvedType, catalog.sourceId)
          ?? conversationStore.create(localCreation);
        if (worktreeId) conversationStore.update(conv.id, { worktreeId, parentDirectory: directory });
        this.sessionEngineMap.set(conv.id, resolvedType);
      }
      if (!conv) throw new Error("The created conversation could not be mapped locally.");
      conversationStore.setEngineSession(conv.id, engineSession.id, engineSession.engineMeta);
      this.engineToConvMap.set(engineSession.id, conv.id);
      if (catalog) {
        const actualProjectId = engineSession.projectId ?? null;
        conversationStore.update(conv.id, {
          projectId: actualProjectId === null ? null : makeCatalogProjectId(resolvedType, catalog.sourceId, actualProjectId),
          engineTitle: engineSession.title,
          ...(engineSession.archived !== undefined ? { archived: engineSession.archived } : {}),
        });
        this.engineToConvMap.set(JSON.stringify([resolvedType, catalog.sourceId, engineSession.id]), conv.id);
        this.authoritativeSessions.set(conv.id, engineSession);
        this.rememberLiveSessionFields(conv.id, engineSession, adapter.hasSession(engineSession.id));
        if (actualProjectId !== nativeProjectId) throw new Error("The new conversation's project assignment could not be confirmed.");
      }
    } catch (err) {
      // Clean up the orphaned conversation if engine session creation fails
      if (conv && (!catalog || !engineCreated)) {
        this.sessionEngineMap.delete(conv.id);
        await conversationStore.delete(conv.id);
      }
      throw err;
    }

    const session = this.sessionFromConversation(conv!);
    // Broadcast to all connected clients (e.g., UI) so session lists update in real-time
    this.emit("session.created", { session });
    return session;
  }

  async getSession(sessionId: string): Promise<UnifiedSession | null> {
    sessionId = conversationStore.resolveConversationId(sessionId);
    await this.catalogSessionChecks.get(sessionId);
    const conv = conversationStore.get(sessionId);
    if (!conv) return null;
    const adapter = this.getAdapter(conv.engineType);
    const capabilities = adapter?.getCapabilities();
    if (conv.archived && capabilities?.hideArchivedSessions) {
      await this.purgeRemovedConversation(conv, "archived");
      return null;
    }
    if (conv.engineSessionId && adapter && conv.catalogAvailable !== false && (capabilities?.authoritativeSessionState || capabilities?.sessionArchive)) {
      if (capabilities.authoritativeSessionState) await this.ensureAuthoritativeSession(conv, adapter);
      const session = await adapter.getSession(conv.engineSessionId);
      if (!conversationStore.get(sessionId)) return null;
      if (session) {
        if (session.id !== conv.engineSessionId) throw new Error("The session read returned a different identity.");
        if (session.archived && capabilities.hideArchivedSessions) {
          await this.purgeRemovedConversation(conv, "archived");
          return null;
        }
        if (capabilities.authoritativeSessionState) {
          this.authoritativeSessions.set(sessionId, session);
          this.rememberLiveSessionFields(sessionId, session, adapter.hasSession(conv.engineSessionId));
        }
        this.syncArchivedState(sessionId, session);
      }
    }
    const result = this.sessionFromConversation(conv);
    if (!capabilities?.authoritativeSessionState) {
      result.activityStatus = this.activeSessionCounts.has(sessionId) ? "running" : "idle";
    }
    return result;
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (conversationStore.isConversationAlias(sessionId)) {
      await conversationStore.delete(sessionId);
      this.sessionEngineMap.delete(sessionId);
      this.emit("session.removed", { sessionId });
      return;
    }
    const conv = conversationStore.get(sessionId);
    if (!conv) return;
    const removalAdapter = this.getAdapter(conv.engineType);
    if (removalAdapter) this.assertSessionCompatible(conv, removalAdapter);
    if (removalAdapter?.getCapabilities().confirmedSessionRemoval) {
      if (!conv.engineSessionId) throw new Error("The conversation has no confirmed native identity.");
      const capabilities = removalAdapter.getCapabilities();
      let sourceId = conv.catalogSourceId;
      if (capabilities.sessionCatalog) {
        const current = await removalAdapter.getCatalog();
        if (sourceId && current.sourceId !== sourceId) throw new Error("The conversation belongs to a different catalog source.");
        sourceId = current.sourceId;
      }
      // The adapter validates fresh complete history, activity, pending input,
      // and the native archive result before granting removal.
      const kind = await removalAdapter.removeSession(conv.engineSessionId);
      if (kind !== "local" && kind !== "archived") throw new Error("The native removal result was not confirmed.");
      await this.purgeRemovedConversation(conv, kind, sourceId);
      await conversationStore.flushAll();
      return;
    }
    if (conv.catalogSourceId) throw new Error("Catalog conversations must be archived through their owner, not removed locally.");
    this.authoritativeSessions.delete(sessionId);

    // Clean up buffers for all messages in this session
    try {
      const messages = await conversationStore.listMessages(sessionId);
      for (const msg of messages) {
        this.stepPartsBuffer.delete(msg.id);
        this.contentPartsBuffer.delete(msg.id);
        this.dirtySteps.delete(msg.id);
        this.messageConvMap.delete(msg.id);
        this.persistedPlaceholders.delete(msg.id);
      }
    } catch (err) {
      engineManagerLog.warn(`Failed to clean up buffers for session ${sessionId}:`, err);
    }

    // Best-effort engine session cleanup
    if (conv.engineSessionId) {
      try {
        const adapter = this.getAdapter(conv.engineType);
        if (adapter) {
          await adapter.deleteSession(conv.engineSessionId);
        }
      } catch {
        // Engine cleanup is best-effort
      }
      this.forgetConversationMappings(conv.id);
    }

    await conversationStore.delete(sessionId);
    this.sessionEngineMap.delete(sessionId);
    this.pendingUserMsgIdQueue.delete(sessionId);
  }

  /**
   * Delete a project and all its conversations.
   * Cleans up engine sessions best-effort, then removes conversations from store.
   */
  async deleteProject(projectId: string): Promise<void> {
    projectId = canonicalCodexProjectId(projectId);
    const catalogProject = conversationStore.getCatalogProject(projectId);
    if (catalogProject) {
      const project = this.requireCatalogProject(projectId);
      const adapter = await this.catalogAdapter(project.catalogSourceId!);
      if (conversationStore.list().some((conv) => conv.catalogSourceId === project.catalogSourceId
        && conv.projectId === projectId && conv.catalogAvailable !== false)) {
        throw new Error("Only an empty catalog project can be deleted.");
      }
      await adapter.deleteCatalogProject(project.catalogProjectId!);
      const confirmed = await this.refreshCatalog(adapter, true);
      if (confirmed.projects.some((entry) => entry.id === projectId && entry.catalogAvailable !== false)) {
        throw new Error("The project deletion could not be confirmed.");
      }
      return;
    }
    const allConvs = conversationStore.list();
    const projectConvs = allConvs.filter((conv) => {
      const derived = `dir-${normalizeDir(conv.directory)}`;
      return derived === projectId;
    });
    // Bulk cleanup cannot bypass the owner's confirmed removal policy.
    // A saved catalog identity remains protected while its adapter is offline.
    if (projectConvs.some((conv) => conv.catalogSourceId
      || this.getAdapter(conv.engineType)?.getCapabilities().confirmedSessionRemoval)) {
      throw new Error("Shared conversations must be removed individually before deleting their project.");
    }

    for (const conv of projectConvs) {
      // Clean up buffers for all messages in this session
      try {
        const messages = await conversationStore.listMessages(conv.id);
        for (const msg of messages) {
          this.stepPartsBuffer.delete(msg.id);
          this.contentPartsBuffer.delete(msg.id);
          this.dirtySteps.delete(msg.id);
          this.messageConvMap.delete(msg.id);
          this.persistedPlaceholders.delete(msg.id);
        }
      } catch (err) {
        engineManagerLog.warn(`Failed to clean up buffers for session ${conv.id} during project delete:`, err);
      }

      // Best-effort engine session cleanup
      if (conv.engineSessionId) {
        try {
          const adapter = this.getAdapter(conv.engineType);
          if (adapter) {
            await adapter.deleteSession(conv.engineSessionId);
          }
        } catch (err) {
          engineManagerLog.warn(`Failed to delete engine session for ${conv.id} during project delete:`, err);
        }
        this.forgetConversationMappings(conv.id);
      }
      await conversationStore.delete(conv.id);
      this.sessionEngineMap.delete(conv.id);
      this.pendingUserMsgIdQueue.delete(conv.id);
    }
  }

  async renameSession(sessionId: string, title: string): Promise<{ success: boolean }> {
    sessionId = conversationStore.resolveConversationId(sessionId);
    const conv = conversationStore.get(sessionId);
    if (!conv) return { success: false };

    const trimmed = title.trim();
    const adapter = this.getAdapter(conv.engineType);
    const authoritative = adapter?.getCapabilities().authoritativeSessionState === true;
    if (authoritative) {
      if (!conv.engineSessionId) throw new Error("The shared conversation is not connected.");
      await this.ensureAuthoritativeSession(conv, adapter);
      await adapter.renameSession(conv.engineSessionId, trimmed, conv.directory, conv.engineMeta);
      const confirmed = await adapter.getSession(conv.engineSessionId);
      if (!confirmed || confirmed.id !== conv.engineSessionId || (confirmed.title?.trim() ?? "") !== trimmed) {
        throw new Error("The shared title could not be confirmed.");
      }
      this.authoritativeSessions.set(sessionId, confirmed);
      conversationStore.update(sessionId, { customTitle: undefined, engineTitle: confirmed.title || undefined });
      this.emit("session.updated", { session: this.sessionFromConversation(conversationStore.get(sessionId)!) });
      return { success: true };
    }
    // Empty string clears the customTitle (revert to engineTitle/firstPrompt fallback)
    conversationStore.setCustomTitle(sessionId, trimmed || undefined);

    // Best-effort writeback to the engine so its own session list stays in sync.
    // Adapters that don't support rename are no-ops by default.
    if (conv.engineSessionId && !authoritative) {
      try {
        await adapter?.renameSession(conv.engineSessionId, trimmed, conv.directory, conv.engineMeta);
      } catch (err) {
        engineManagerLog.warn(`Engine rename writeback failed for ${sessionId}:`, err);
      }
    }

    this.emit("session.updated", { session: convToSession(conversationStore.get(sessionId)!) });
    return { success: true };
  }

  async setSessionArchived(sessionId: string, archived: boolean): Promise<void> {
    sessionId = conversationStore.resolveConversationId(sessionId);
    if (typeof archived !== "boolean") throw new Error("archived must be a boolean");
    const conv = conversationStore.get(sessionId);
    if (!conv) throw new Error(`Session ${sessionId} not found`);
    const adapter = this.getAdapterOrThrow(conv.engineType);
    const capabilities = adapter.getCapabilities();
    if (!capabilities.sessionArchive) throw new Error("This engine does not support archiving sessions.");
    if (!conv.engineSessionId) throw new Error("The conversation is not connected to its engine.");
    if (capabilities.authoritativeSessionState) await this.ensureAuthoritativeSession(conv, adapter);

    await adapter.setSessionArchived(conv.engineSessionId, archived);
    const confirmed = await adapter.getSession(conv.engineSessionId);
    if (!confirmed || confirmed.id !== conv.engineSessionId || confirmed.archived !== archived) {
      throw new Error("The session archive state could not be confirmed.");
    }
    conversationStore.setArchived(sessionId, archived);
    if (archived && capabilities.hideArchivedSessions) {
      await this.purgeRemovedConversation(conv, "archived");
      return;
    }
    if (capabilities.authoritativeSessionState) this.authoritativeSessions.set(sessionId, confirmed);
    this.emit("session.updated", { session: this.sessionFromConversation(conversationStore.get(sessionId)!) });
  }

  private resolveSessionOptions(
    conv: ConversationMeta,
    options?: {
      mode?: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: CodexServiceTier | null;
    },
  ): {
    mode?: string;
    modelId?: string;
    reasoningEffort?: ReasoningEffort | null;
    serviceTier?: CodexServiceTier | null;
  } {
    const hasExplicitReasoningEffort = options != null
      && Object.prototype.hasOwnProperty.call(options, "reasoningEffort");
    const hasExplicitServiceTier = options != null
      && Object.prototype.hasOwnProperty.call(options, "serviceTier");

    return {
      mode: options?.mode ?? conv.mode,
      modelId: options?.modelId ?? conv.modelId,
      reasoningEffort: hasExplicitReasoningEffort
        ? (options?.reasoningEffort ?? null)
        : (conv.reasoningEffort ?? undefined),
      serviceTier: hasExplicitServiceTier
        ? (options?.serviceTier ?? null)
        : (conv.serviceTier ?? undefined),
    };
  }

  private updateStoredSessionConfig(
    sessionId: string,
    patch: {
      mode?: string | null;
      modelId?: string | null;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: CodexServiceTier | null;
    },
  ): ConversationMeta {
    const conv = conversationStore.updateSessionConfig(sessionId, patch);
    if (!conv) {
      throw new Error(`Conversation not found: ${sessionId}`);
    }
    this.emit("session.updated", { session: convToSession(conv) });
    return conv;
  }

  // --- Messages ---

  private markSessionActive(sessionId: string): boolean {
    const activeCount = this.activeSessionCounts.get(sessionId) ?? 0;
    this.activeSessionCounts.set(sessionId, activeCount + 1);
    return activeCount > 0;
  }

  private markSessionInactive(sessionId: string): void {
    const activeCount = this.activeSessionCounts.get(sessionId) ?? 0;
    if (activeCount <= 1) {
      this.activeSessionCounts.delete(sessionId);
      return;
    }
    this.activeSessionCounts.set(sessionId, activeCount - 1);
  }

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: { mode?: string; modelId?: string; reasoningEffort?: ReasoningEffort | null; serviceTier?: CodexServiceTier | null },
  ): Promise<UnifiedMessage> {
    sessionId = conversationStore.resolveConversationId(sessionId);
    const trackQueuedTiming = this.markSessionActive(sessionId);
    try {
      const conv = conversationStore.get(sessionId);
      if (!conv) throw new Error(`Conversation not found: ${sessionId}`);

      const adapter = this.getAdapterForSession(sessionId);
      const resolvedOptions = this.resolveSessionOptions(conv, options);
      this.validateReasoningEffort(adapter, resolvedOptions.reasoningEffort);

      // Lazy engine session creation: first sendMessage triggers adapter.createSession()
      // Also re-create if the adapter lost track of the session (e.g. after app restart,
      // the persisted engineSessionId refers to a cs_ ID that only existed in runtime memory).
      let engineSessionId = conv.engineSessionId;
      if (conv.catalogSourceId || (engineSessionId && adapter.getCapabilities().authoritativeSessionState)) {
        if (!engineSessionId) throw new Error("The catalog conversation has no native identity.");
        await this.ensureAuthoritativeSession(conv, adapter);
      } else if (!engineSessionId || !adapter.hasSession(engineSessionId)) {
        const engineSession = await adapter.createSession(conv.directory, conv.engineMeta);
        engineSessionId = engineSession.id;
        conversationStore.setEngineSession(sessionId, engineSessionId, engineSession.engineMeta);
      }

      // Cache the engineSessionId → conversationId mapping
      this.engineToConvMap.set(engineSessionId, sessionId);

      // Persist user message before sending to engine
      // (Some adapters like OpenCode don't emit user message events)
      if (!adapter.getCapabilities().authoritativeSessionState) {
        await this.persistUserMessage(sessionId, content, trackQueuedTiming);
      }

      const result = await adapter.sendMessage(engineSessionId, content, {
        ...resolvedOptions,
        directory: conv.directory,
      });

      // If the engine reported a stale session (no SSE response within timeout),
      // clear the engineSessionId so the next attempt creates a fresh session.
      if (result.staleSession && !conv.catalogSourceId) {
        engineManagerLog.warn(`Stale session detected for ${sessionId}, clearing engineSessionId`);
        conversationStore.clearEngineSession(sessionId);
        this.forgetConversationMappings(sessionId);
      }

      // Ensure completed assistant messages always have time.completed.
      // Some adapters (e.g. OpenCode) strip time.completed during multi-step loops
      // and only restore it on session.idle — if that event is lost (e.g. WebSocket
      // reconnect), the field stays undefined, causing the frontend timer to tick
      // indefinitely on an already-finished message.
      if (!adapter.getCapabilities().authoritativeSessionState && result.role === "assistant" && !result.time.completed) {
        const finalized = { ...result, time: { ...result.time, completed: Date.now() } };
        this.persistMessage(sessionId, finalized);
        this.emit("message.updated", { sessionId, message: finalized });
      }

      return result;
    } finally {
      this.markSessionInactive(sessionId);
    }
  }

  /** Check if a session is idle (not actively processing a message) */
  isSessionIdle(sessionId: string): boolean {
    sessionId = conversationStore.resolveConversationId(sessionId);
    return !this.activeSessionCounts.has(sessionId);
  }

  async cancelMessage(sessionId: string): Promise<void> {
    sessionId = conversationStore.resolveConversationId(sessionId);
    const conv = conversationStore.get(sessionId);
    if (!conv?.engineSessionId) return;
    const adapter = this.getAdapterForSession(sessionId);
    await adapter.cancelMessage(conv.engineSessionId, conv.directory);

    // Clean up buffered parts for this session's in-flight messages.
    // Normally persistMessage() handles cleanup on message.updated, but if
    // the engine drops the completion event (crash/timeout), buffers linger.
    for (const [messageId, convId] of this.messageConvMap) {
      if (convId === sessionId) {
        this.stepPartsBuffer.delete(messageId);
        this.contentPartsBuffer.delete(messageId);
        this.dirtySteps.delete(messageId);
        this.messageConvMap.delete(messageId);
      }
    }
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    sessionId = conversationStore.resolveConversationId(sessionId);
    await this.catalogSessionChecks.get(sessionId);
    const conv = conversationStore.get(sessionId);
    if (!conv) return [];
    const adapter = conv && this.getAdapter(conv.engineType);
    if (conv.archived && adapter?.getCapabilities().hideArchivedSessions) {
      await this.purgeRemovedConversation(conv, "archived");
      return [];
    }
    if (conv?.engineSessionId && conv.catalogAvailable !== false && adapter?.getCapabilities().authoritativeSessionState) {
      await this.ensureAuthoritativeSession(conv, adapter);
      return this.runMessageWrite(sessionId, async () => {
        if (!conversationStore.get(sessionId)) return [];
        // A lazy step read may predate queued updates, so a replacing snapshot must
        // start its own owner read after the persistence barrier.
        const messages = await adapter.listMessages(conv.engineSessionId!);
        if (!conversationStore.get(sessionId)) return [];
        const normalized = messages.map((message) => ({
          ...message, sessionId,
          parts: message.parts.map((part) => normalizeToolPartDisplay({ ...part, sessionId }, conv.directory)),
          stepCount: message.parts.filter((part) => !this.isContentPart(part)).length,
        }));
        await conversationStore.replaceMessageSnapshot(sessionId, normalized);
        return conversationStore.get(sessionId) ? normalized.map((message) => this.projectHistoryMessage(message)) : [];
      });
    }
    const messages = await conversationStore.listMessages(sessionId);
    const stepsFile = await conversationStore.getAllSteps(sessionId);
    if (!conversationStore.get(sessionId)) return [];
    // Backfill costUnit for legacy Copilot data (cost stored without unit)
    const engineType = this.sessionEngineMap.get(sessionId);
    const scopeMirror = !adapter || adapter.getCapabilities().authoritativeSessionState || !!conv?.catalogSourceId;

    return messages.map((msg) => {
      // Content parts only — steps are lazy-loaded via getMessageSteps()
      const stepCount = (stepsFile?.messages[msg.id] ?? []).length;
      // Legacy Copilot messages have cost but no costUnit
      const costUnit = msg.costUnit ?? (msg.cost != null && engineType === "copilot" ? "premium_requests" : undefined);

      const id = scopeMirror ? this.mirrorMessageId(sessionId, msg.id) : msg.id;
      return {
        id,
        sessionId,
        role: msg.role,
        time: msg.time,
        enqueuedAt: msg.enqueuedAt,
        processedAt: msg.processedAt,
        parts: (scopeMirror ? msg.parts.map((part) => this.mirrorPart(sessionId, msg.id, part)) : msg.parts as UnifiedPart[])
          .map((part) => normalizeToolPartDisplay(part, conv.directory)),
        stepCount,
        tokens: msg.tokens,
        cost: msg.cost,
        costUnit,
        modelId: msg.modelId,
        reasoningEffort: msg.reasoningEffort,
        error: msg.error,
      };
    });
  }

  async getMessageSteps(sessionId: string, messageId: string): Promise<UnifiedPart[]> {
    sessionId = conversationStore.resolveConversationId(sessionId);
    await this.catalogSessionChecks.get(sessionId);
    const conv = conversationStore.get(sessionId);
    if (!conv) return [];
    const adapter = conv && this.getAdapter(conv.engineType);
    if (conv.archived && adapter?.getCapabilities().hideArchivedSessions) {
      await this.purgeRemovedConversation(conv, "archived");
      return [];
    }
    const mirrorPrefix = this.mirrorMessageId(sessionId, "");
    if (messageId.startsWith(mirrorPrefix)) {
      const storedId = decodeURIComponent(messageId.slice(mirrorPrefix.length));
      const parts = await conversationStore.getSteps(sessionId, storedId);
      return conversationStore.get(sessionId)
        ? parts.map((part) => normalizeToolPartDisplay(this.mirrorPart(sessionId, storedId, part), conv.directory))
        : [];
    }
    if (conv?.engineSessionId && conv.catalogAvailable !== false && adapter?.getCapabilities().authoritativeSessionState) {
      await this.ensureAuthoritativeSession(conv, adapter);
      const messages = await this.readAuthoritativeHistory(sessionId, conv.engineSessionId, adapter);
      if (!conversationStore.get(sessionId)) return [];
      return (messages.find((message) => message.id === messageId)?.parts ?? [])
        .filter((part) => !this.isContentPart(part))
        .map((part) => normalizeToolPartDisplay({ ...part, sessionId }, conv.directory));
    }
    const parts = await conversationStore.getSteps(sessionId, messageId);
    return conversationStore.get(sessionId) ? parts.map((part) => normalizeToolPartDisplay(part, conv.directory)) : [];
  }

  private readAuthoritativeHistory(conversationId: string, engineSessionId: string, adapter: EngineAdapter): Promise<UnifiedMessage[]> {
    const existing = this.authoritativeHistoryReads.get(conversationId);
    if (existing) return existing;
    const read = Promise.resolve().then(() => adapter.listMessages(engineSessionId)).finally(() => {
      if (this.authoritativeHistoryReads.get(conversationId) === read) this.authoritativeHistoryReads.delete(conversationId);
    });
    this.authoritativeHistoryReads.set(conversationId, read);
    return read;
  }

  private projectHistoryMessage(message: UnifiedMessage): UnifiedMessage {
    const stepCount = message.parts.filter((part) => !this.isContentPart(part)).length;
    return { ...message, stepCount, parts: message.time.completed
      ? message.parts.filter((part) => this.isContentPart(part)) : message.parts };
  }

  /**
   * Single egress for client-facing message events: tool parts leave with the
   * same engine-agnostic display fields whichever adapter produced them.
   * Buffers and persistence keep the raw adapter parts.
   */
  override emit(event: string | symbol, ...args: any[]): boolean {
    const payload = args[0];
    if ((event === "message.part.updated" || event === "message.updated") && payload && typeof payload === "object") {
      const dir = this.conversationDirectory(payload.sessionId);
      if (event === "message.part.updated" && payload.part) {
        const part = normalizeToolPartDisplay(payload.part, dir);
        if (part !== payload.part) args = [{ ...payload, part }, ...args.slice(1)];
      } else if (event === "message.updated" && payload.message) {
        const message = normalizeMessageToolDisplay(payload.message, dir);
        if (message !== payload.message) args = [{ ...payload, message }, ...args.slice(1)];
      }
    }
    return super.emit(event, ...args);
  }

  /** Session directory used to show tool paths relative to the project. */
  private conversationDirectory(conversationId: string | null | undefined): string | undefined {
    return conversationId ? conversationStore.get(conversationId)?.directory : undefined;
  }

  private mirrorMessageId(conversationId: string, messageId: string): string {
    return `codemux-mirror:v1:${encodeURIComponent(conversationId)}:${encodeURIComponent(messageId)}`;
  }

  private mirrorPart(conversationId: string, messageId: string, part: UnifiedPart): UnifiedPart {
    const id = this.mirrorMessageId(conversationId, messageId);
    return { ...part, id: `${id}:${encodeURIComponent(part.id)}`, messageId: id, sessionId: conversationId };
  }

  private async ensureAuthoritativeSession(conv: ConversationMeta, adapter: EngineAdapter): Promise<void> {
    this.assertSessionCompatible(conv, adapter);
    if (conv.catalogSourceId) {
      const current = await this.refreshCatalog(adapter);
      if (current.sourceId !== conv.catalogSourceId) throw new Error("This conversation belongs to another catalog source.");
      if (conversationStore.get(conv.id)?.catalogAvailable === false) throw new Error("This conversation is unavailable in the current catalog.");
    }
    if (!conv.engineSessionId || adapter.hasSession(conv.engineSessionId)) return;
    const pending = this.authoritativeAttaching.get(conv.id);
    if (pending) return pending;
    const operation = Promise.resolve().then(async () => {
      const session = await adapter.restoreSession(conv.engineSessionId!, conv.directory, conv.engineMeta);
      if (!conversationStore.get(conv.id)) throw new Error("The conversation has been removed.");
      if (session.id !== conv.engineSessionId) throw new Error("Restoring the shared conversation changed its identity.");
      if (session.archived && adapter.getCapabilities().hideArchivedSessions) {
        await this.purgeRemovedConversation(conv, "archived");
        throw new Error("Archived conversations are not available.");
      }
      this.authoritativeSessions.set(conv.id, session);
      this.rememberLiveSessionFields(conv.id, session, adapter.hasSession(session.id));
      this.syncArchivedState(conv.id, session);
      this.engineToConvMap.set(session.id, conv.id);
      conversationStore.setEngineSession(conv.id, session.id, session.engineMeta);
    }).catch(async (error) => {
      if (adapter.getCapabilities().hideArchivedSessions && (error as { code?: string }).code === "CODEX_THREAD_ARCHIVED") {
        await this.purgeRemovedConversation(conv, "archived");
      }
      throw error;
    }).finally(() => this.authoritativeAttaching.delete(conv.id));
    this.authoritativeAttaching.set(conv.id, operation);
    return operation;
  }

  private reconnectPersistedAuthoritativeSessions(adapter: EngineAdapter): void {
    if (this.authoritativeReconnects.has(adapter.engineType)) return;
    const conversations = conversationStore.list({ engineType: adapter.engineType }).filter((conv) =>
      conv.engineType === adapter.engineType && !conv.catalogSourceId && !!conv.engineSessionId && conv.archived !== true,
    );
    let next = 0;
    const reconnect = Promise.resolve().then(async () => {
      const worker = async () => {
        while (next < conversations.length && adapter.getInfo().status === "running") {
          const saved = conversations[next++];
          const conv = conversationStore.get(saved.id);
          if (!conv || conv.archived || conv.engineSessionId !== saved.engineSessionId || adapter.hasSession(conv.engineSessionId!)) continue;
          try {
            await this.ensureAuthoritativeSession(conv, adapter);
            const session = await adapter.getSession(conv.engineSessionId!);
            if (!session || session.id !== conv.engineSessionId) throw new Error("The reconnected conversation identity could not be confirmed.");
            this.authoritativeSessions.set(conv.id, session);
            this.syncArchivedState(conv.id, session);
            this.emit("session.updated", { session: this.sessionFromConversation(conv) });
          } catch (error) {
            engineManagerLog.warn(`Failed to reconnect shared conversation ${conv.id}:`, error);
            this.authoritativeSessions.set(conv.id, { ...convToSession(conv), ...this.authoritativeSessions.get(conv.id), activityStatus: "error" });
            this.emit("session.updated", { session: this.sessionFromConversation(conv) });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, conversations.length) }, () => worker()));
    });
    this.authoritativeReconnects.set(adapter.engineType, reconnect);
    void reconnect.catch((error) => {
      engineManagerLog.warn(`Failed to reconnect shared conversations for ${adapter.engineType}:`, error);
    }).finally(() => {
      if (this.authoritativeReconnects.get(adapter.engineType) === reconnect) this.authoritativeReconnects.delete(adapter.engineType);
    });
  }

  // --- Slash Commands ---

  async listCommands(engineType: EngineType, sessionId?: string): Promise<EngineCommand[]> {
    const adapter = this.getAdapter(engineType);
    if (!adapter) return [];

    if (sessionId) {
      const conv = conversationStore.get(sessionId);
      if (conv) this.assertSessionCompatible(conv, adapter);
      return adapter.listCommands(conv?.engineSessionId ?? undefined, conv?.directory);
    }

    return adapter.listCommands();
  }

  async invokeCommand(
    sessionId: string,
    commandName: string,
    args: string,
    options?: { mode?: string; modelId?: string; reasoningEffort?: ReasoningEffort | null; serviceTier?: CodexServiceTier | null },
  ): Promise<CommandInvokeResult> {
    sessionId = conversationStore.resolveConversationId(sessionId);
    const trackQueuedTiming = this.markSessionActive(sessionId);
    try {
      const conv = conversationStore.get(sessionId);
      if (!conv) throw new Error(`Conversation not found: ${sessionId}`);

      const adapter = this.getAdapterForSession(sessionId);

      // Lazy engine session creation (same pattern as sendMessage)
      let engineSessionId = conv.engineSessionId;
      if (conv.catalogSourceId || (engineSessionId && adapter.getCapabilities().authoritativeSessionState)) {
        if (!engineSessionId) throw new Error("The catalog conversation has no native identity.");
        await this.ensureAuthoritativeSession(conv, adapter);
      } else if (!engineSessionId || !adapter.hasSession(engineSessionId)) {
        const engineSession = await adapter.createSession(conv.directory, conv.engineMeta);
        engineSessionId = engineSession.id;
        conversationStore.setEngineSession(sessionId, engineSessionId, engineSession.engineMeta);
      }
      this.engineToConvMap.set(engineSessionId, sessionId);

      // Persist user command message
      const commandText = `/${commandName}${args ? ` ${args}` : ""}`;
      if (!adapter.getCapabilities().authoritativeSessionState) {
        await this.persistUserMessage(sessionId, [{ type: "text", text: commandText }], trackQueuedTiming);
      }

      const resolvedOptions = this.resolveSessionOptions(conv, options);

      const result = await adapter.invokeCommand(
        engineSessionId,
        commandName,
        args,
        { ...resolvedOptions, directory: conv.directory },
      );

      // If the adapter couldn't handle it, fall back to sendMessage
      if (!result.handledAsCommand) {
        const message = await adapter.sendMessage(
          engineSessionId,
          [{ type: "text", text: commandText }],
          { ...resolvedOptions, directory: conv.directory },
        );
        return { handledAsCommand: false, message };
      }

      return result;
    } finally {
      this.markSessionInactive(sessionId);
    }
  }

  // --- Models ---

  async listModels(engineType: EngineType): Promise<ModelListResult> {
    const adapter = this.getAdapterOrThrow(engineType);
    return adapter.listModels();
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    return this.updateSessionConfig(sessionId, { modelId });
  }

  // --- Modes ---

  getModes(engineType: EngineType): AgentMode[] {
    const adapter = this.getAdapterOrThrow(engineType);
    return adapter.getModes();
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    return this.updateSessionConfig(sessionId, { mode: modeId });
  }

  async updateSessionConfig(
    sessionId: string,
    config: SessionConfigPatch,
  ): Promise<void> {
    sessionId = conversationStore.resolveConversationId(sessionId);
    const patch: {
      mode?: string | null;
      modelId?: string | null;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: CodexServiceTier | null;
    } = {};

    if (Object.prototype.hasOwnProperty.call(config, "mode")) {
      patch.mode = config.mode ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(config, "modelId")) {
      patch.modelId = config.modelId ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(config, "reasoningEffort")) {
      patch.reasoningEffort = config.reasoningEffort ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(config, "serviceTier")) {
      patch.serviceTier = config.serviceTier ?? null;
    }

    const existing = conversationStore.get(sessionId);
    const existingAdapter = existing && this.getAdapter(existing.engineType);
    if (existingAdapter) this.validateReasoningEffort(existingAdapter, config.reasoningEffort);
    if (existing?.engineSessionId && existingAdapter?.getCapabilities().authoritativeSessionState) {
      await this.ensureAuthoritativeSession(existing, existingAdapter);
      await this.applySessionConfig(existingAdapter, existing.engineSessionId, config);
      const confirmed = await existingAdapter.getSession(existing.engineSessionId);
      if (!confirmed) throw new Error("The shared settings could not be confirmed.");
      this.authoritativeSessions.set(sessionId, confirmed);
      for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
        Object.assign(patch, { [key]: confirmed[key] ?? null });
      }
      this.updateStoredSessionConfig(sessionId, patch);
      return;
    }
    const conv = this.updateStoredSessionConfig(sessionId, patch);
    if (!conv.engineSessionId) {
      return;
    }

    const adapter = this.getAdapterForSession(sessionId);
    const engineSessionId = conv.engineSessionId;
    await this.applySessionConfig(adapter, engineSessionId, config);
  }

  private async applySessionConfig(adapter: EngineAdapter, engineSessionId: string, config: SessionConfigPatch): Promise<void> {
    if (Object.prototype.hasOwnProperty.call(config, "mode") && config.mode) {
      await adapter.setMode(engineSessionId, config.mode);
    }
    if (Object.prototype.hasOwnProperty.call(config, "modelId") && config.modelId) {
      await adapter.setModel(engineSessionId, config.modelId);
    }
    if (Object.prototype.hasOwnProperty.call(config, "reasoningEffort")) {
      await adapter.setReasoningEffort(engineSessionId, config.reasoningEffort ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(config, "serviceTier")) {
      await adapter.setServiceTier(engineSessionId, config.serviceTier ?? null);
    }
  }

  private validateReasoningEffort(adapter: EngineAdapter, effort: ReasoningEffort | null | undefined): void {
    const supported = adapter.getCapabilities().reasoningEffortOptions ?? REASONING_EFFORT_VALUES;
    if (effort != null && !(supported as readonly string[]).includes(effort)) {
      throw new Error(`This engine does not support reasoning effort: ${effort}`);
    }
  }

  // --- Permissions ---

  private rememberInteractionReply(key: string, reply: InteractionReply): void {
    this.interactionReplies.set(key, reply);
    // Only recent completed replies need to acknowledge late channel callbacks.
    if (this.interactionReplies.size > 512) {
      for (const [id, entry] of this.interactionReplies) {
        if (entry.completed) this.interactionReplies.delete(id);
        if (this.interactionReplies.size <= 512) break;
      }
    }
  }

  private submitInteractionReply(
    kind: "permission" | "question",
    id: string,
    fingerprint: string,
    submit: (adapter: EngineAdapter, sessionId?: string) => Promise<void>,
  ): Promise<void> {
    const engines = kind === "permission" ? this.permissionEngineMap : this.questionEngineMap;
    const sessions = kind === "permission" ? this.permissionSessionMap : this.questionSessionMap;
    const pending = kind === "permission" ? this.pendingPermissionReplies : this.pendingQuestionReplies;
    const key = `${kind}:${id}`;
    const engineType = engines.get(id);
    const sessionId = sessions.get(id);
    const previous = this.interactionReplies.get(key);
    if (previous && (!engineType || (previous.engineType === engineType && previous.sessionId === sessionId))) {
      if (previous.fingerprint === fingerprint) return previous.promise;
      return Promise.reject(Object.assign(new Error(`This ${kind} already has a different reply.`), { code: "INTERACTION_ALREADY_RESOLVED" }));
    }
    if (!engineType) return Promise.reject(new Error(`No engine binding found for ${kind}: ${id}`));
    const adapter = this.getAdapterOrThrow(engineType);
    const entry: InteractionReply = { engineType, sessionId, fingerprint, promise: Promise.resolve(), completed: false };
    pending.add(id);
    entry.promise = Promise.resolve().then(() => submit(adapter, sessionId)).then(() => {
      entry.completed = true;
      if (engines.get(id) === engineType && sessions.get(id) === sessionId) {
        engines.delete(id);
        sessions.delete(id);
      }
    }).catch((error) => {
      // Failed submissions remain retryable and never cache a successful answer.
      if (this.interactionReplies.get(key) === entry) this.interactionReplies.delete(key);
      if (!engines.has(id)) {
        engines.set(id, engineType);
        if (sessionId) sessions.set(id, sessionId);
      }
      throw error;
    }).finally(() => pending.delete(id));
    this.rememberInteractionReply(key, entry);
    return entry.promise;
  }

  async replyPermission(permissionId: string, reply: PermissionReply): Promise<void> {
    return this.submitInteractionReply("permission", permissionId, JSON.stringify(reply.optionId),
      (adapter, sessionId) => adapter.replyPermission(permissionId, reply, sessionId));
  }

  // --- Questions ---

  async replyQuestion(questionId: string, answers: string[][]): Promise<void> {
    return this.submitInteractionReply("question", questionId, JSON.stringify(["answer", answers]),
      (adapter, sessionId) => adapter.replyQuestion(questionId, answers, sessionId));
  }

  async rejectQuestion(questionId: string): Promise<void> {
    return this.submitInteractionReply("question", questionId, "reject",
      (adapter, sessionId) => adapter.rejectQuestion(questionId, sessionId));
  }

  // --- Projects ---

  async listProjects(engineType: EngineType): Promise<UnifiedProject[]> {
    engineType = this.resolveEngineType(engineType);
    // Derive projects from conversations for this engine type
    return [...conversationStore.deriveProjects().filter(p => p.engineType === engineType),
      ...conversationStore.listCatalogs().filter((catalog) => catalog.engineType === engineType).flatMap((catalog) => catalog.projects)];
  }

  async createProject(sourceId: string, input: CatalogProjectInput): Promise<UnifiedProject> {
    const validated = this.validateProjectInput(input);
    const adapter = await this.catalogAdapter(sourceId);
    const created = await adapter.createProject(validated);
    if (!created?.id) throw new Error("The project owner did not return a project identity.");
    const confirmed = await this.refreshCatalog(adapter, true);
    const project = confirmed.projects.find((entry) => entry.catalogProjectId === created.id && entry.catalogAvailable !== false);
    if (!project || project.name !== validated.name || JSON.stringify(project.roots ?? []) !== JSON.stringify(validated.roots)) {
      throw new Error("The project creation could not be confirmed.");
    }
    return project;
  }

  async updateProject(projectId: string, patch: CatalogProjectPatch): Promise<UnifiedProject> {
    projectId = canonicalCodexProjectId(projectId);
    const project = this.requireCatalogProject(projectId);
    const validated = this.validateProjectInput({ name: patch.name ?? project.name ?? "", roots: patch.roots ?? project.roots ?? [] });
    if (patch.name === undefined && patch.roots === undefined) throw new Error("A project update is required.");
    const adapter = await this.catalogAdapter(project.catalogSourceId!);
    const updated = await adapter.updateProject(project.catalogProjectId!, {
      ...(patch.name !== undefined ? { name: validated.name } : {}),
      ...(patch.roots !== undefined ? { roots: validated.roots } : {}),
    });
    if (updated?.id !== project.catalogProjectId) throw new Error("Updating the project changed its identity.");
    const confirmed = await this.refreshCatalog(adapter, true);
    const result = confirmed.projects.find((entry) => entry.id === projectId && entry.catalogAvailable !== false);
    if (!result || (patch.name !== undefined && result.name !== validated.name)
      || (patch.roots !== undefined && JSON.stringify(result.roots ?? []) !== JSON.stringify(validated.roots))) {
      throw new Error("The project update could not be confirmed.");
    }
    return result;
  }

  async reorderProjects(sourceId: string, projectIds: string[]): Promise<void> {
    projectIds = projectIds.map(canonicalCodexProjectId);
    const adapter = await this.catalogAdapter(sourceId);
    const projects = conversationStore.listCatalogs().find((catalog) => catalog.engineType === adapter.engineType && catalog.sourceId === sourceId)!
      .projects.filter((project) => project.catalogAvailable !== false);
    if (!Array.isArray(projectIds) || projectIds.length !== projects.length || new Set(projectIds).size !== projectIds.length
      || projectIds.some((id) => !projects.some((project) => project.id === id))) {
      throw new Error("Project order must contain every available project from this source exactly once.");
    }
    const nativeIds = projectIds.map((id) => projects.find((project) => project.id === id)!.catalogProjectId!);
    try {
      for (let i = nativeIds.length - 1; i >= 0; i--) await adapter.moveProject(nativeIds[i], nativeIds[i + 1] ?? null);
    } catch (error) {
      await this.refreshCatalog(adapter, true).catch((refreshError) => engineManagerLog.warn("Failed to refresh a partially changed project order:", refreshError));
      throw error;
    }
    const confirmed = await this.refreshCatalog(adapter, true);
    const order = confirmed.projects.filter((project) => project.catalogAvailable !== false).map((project) => project.id);
    if (JSON.stringify(order) !== JSON.stringify(projectIds)) throw new Error("The project order could not be confirmed.");
  }

  async setSessionProject(sessionId: string, projectId: string | null): Promise<void> {
    sessionId = conversationStore.resolveConversationId(sessionId);
    if (projectId) projectId = canonicalCodexProjectId(projectId);
    const conv = conversationStore.get(sessionId);
    if (!conv?.catalogSourceId || !conv.engineSessionId || conv.catalogAvailable === false) throw new Error("This conversation is not available in a managed catalog.");
    const project = projectId === null ? null : this.requireCatalogProject(projectId);
    if (project && (project.catalogSourceId !== conv.catalogSourceId || project.engineType !== conv.engineType)) {
      throw new Error("A conversation can only move within its own catalog source.");
    }
    const adapter = await this.catalogAdapter(conv.catalogSourceId);
    await adapter.setSessionProject(conv.engineSessionId, project?.catalogProjectId ?? null);
    await this.refreshCatalog(adapter, true);
    if (conversationStore.get(sessionId)?.projectId !== projectId) throw new Error("The conversation project change could not be confirmed.");
  }

  // --- Pending state (for resync after reconnect / session switch) ---

  /**
   * Aggregate pending questions and permissions for a specific conversation.
   * Resolves conversationId → engineSessionId per adapter, queries the adapter's
   * in-memory pending state, and rewrites sessionId back to the conversationId
   * so the frontend receives ids it can route.
   */
  async getPending(conversationId: string): Promise<{
    questions: UnifiedQuestion[];
    permissions: UnifiedPermission[];
  }> {
    conversationId = conversationStore.resolveConversationId(conversationId);
    await this.catalogSessionChecks.get(conversationId);
    const conv = conversationStore.get(conversationId);
    if (!conv) return { questions: [], permissions: [] };
    const adapter = this.getAdapter(conv.engineType);
    if (!adapter) return { questions: [], permissions: [] };
    this.assertSessionCompatible(conv, adapter);
    if (conv.archived && adapter.getCapabilities().hideArchivedSessions) {
      await this.purgeRemovedConversation(conv, "archived");
      return { questions: [], permissions: [] };
    }

    const engineSessionId = conv.engineSessionId;
    // Without an engine-side session id we have no safe way to filter: adapters
    // treat an undefined sessionId as "no filter" and would leak pending items
    // from unrelated sessions (then rewrite them to this conversationId).
    if (engineSessionId == null) return { questions: [], permissions: [] };

    const [rawQuestions, rawPermissions] = await Promise.all([
      Promise.resolve(adapter.getPendingQuestions(engineSessionId)),
      Promise.resolve(adapter.getPendingPermissions(engineSessionId)),
    ]);
    if (!conversationStore.get(conversationId)) return { questions: [], permissions: [] };
    // Reconnect can discover requests whose original asked event was missed.
    for (const question of rawQuestions) {
      if (this.pendingQuestionReplies.has(question.id)) continue;
      this.questionEngineMap.set(question.id, adapter.engineType);
      this.questionSessionMap.set(question.id, question.sessionId);
    }
    for (const permission of rawPermissions) {
      if (this.pendingPermissionReplies.has(permission.id)) continue;
      this.permissionEngineMap.set(permission.id, adapter.engineType);
      this.permissionSessionMap.set(permission.id, permission.sessionId);
    }
    const questions = rawQuestions.map((q) => ({ ...q, sessionId: conversationId }));
    const permissions = rawPermissions.map((p) => ({ ...p, sessionId: conversationId }));

    return { questions, permissions };
  }

  // --- Session Registration (for adapters that load existing sessions) ---

  registerSession(sessionId: string, engineType: EngineType): void {
    sessionId = conversationStore.resolveConversationId(sessionId);
    this.sessionEngineMap.set(sessionId, engineType);
  }

  // --- ConversationStore Integration ---

  /**
   * Rebuild routing tables from ConversationStore data.
   * Called once at startup, after conversationStore.init().
   */
  initFromStore(): void {
    for (const conv of this.visibleConversations()) {
      this.sessionEngineMap.set(conv.id, conv.engineType);
      // Cache engineSessionId → conversationId mapping
      if (conv.engineSessionId) {
        this.engineToConvMap.set(conv.engineSessionId, conv.id);
      }
      // Derive project bindings from conversations
      if (conv.directory) {
        const normDir = normalizeDir(conv.directory);
        if (normDir && normDir !== "/" && !this.projectBindings.has(normDir)) {
          this.projectBindings.set(normDir, conv.engineType);
        }
      }
    }
    engineManagerLog.info(
      `Restored ${this.sessionEngineMap.size} conversation routes, ${this.projectBindings.size} project bindings, ${this.engineToConvMap.size} engine session mappings`,
    );
  }

  /** Return all conversations as UnifiedSession[] (all engines) */
  listAllSessions(): UnifiedSession[] {
    return this.visibleConversations().map((conv) => this.sessionFromConversation(conv));
  }

  /** Return all projects derived from conversations, always including the default workspace */
  listAllProjects(): UnifiedProject[] {
    this.visibleConversations();
    const projects = conversationStore.deriveProjects();
    const defaultDir = normalizeDir(getDefaultWorkspacePath());
    const existing = projects.find(
      (p) => normalizeDir(p.directory) === defaultDir,
    );
    if (!existing) {
      projects.push({
        id: `dir-${defaultDir}`,
        directory: defaultDir,
        name: "workspace",
        isDefault: true,
      });
    } else {
      existing.isDefault = true;
    }
    return [...projects, ...conversationStore.listCatalogs().flatMap((catalog) => catalog.projects)];
  }

  // --- Historical Session Import ---

  /**
   * Preview importable sessions from an engine.
   * Returns all historical sessions with dedup flags marking already-imported ones.
   */
  async importPreview(engineType: EngineType, limit: number): Promise<ImportableSession[]> {
    engineType = this.resolveEngineType(engineType);
    const adapter = this.getAdapterOrThrow(engineType);
    const sessions = (await adapter.listHistoricalSessions(limit)).filter((session) => !adapter.getCapabilities().hideArchivedSessions || !session.archived);

    // Build dedup set: all known engine session IDs for this engine type
    const existingIds = conversationStore.findAllEngineSessionIds(engineType);
    const knownConversations = conversationStore.list({ engineType });

    for (const s of sessions) {
      // Check both the direct engine session ID and any nested IDs (e.g. Claude's ccSessionId)
      const ccId = s.engineMeta?.ccSessionId;
      const candidates = knownConversations.filter((conv) => conv.engineSessionId === s.engineSessionId
        || (typeof ccId === "string" && conv.engineMeta?.ccSessionId === ccId));
      s.alreadyImported =
        (existingIds.has(s.engineSessionId) || (typeof ccId === "string" && existingIds.has(ccId)))
        && (candidates.length === 0 || candidates.some((conv) => this.isSessionCompatible(conv, adapter)));
    }

    return sessions;
  }

  /**
   * Execute import of selected sessions from an engine.
   * Fetches full message history and persists to ConversationStore.
   */
  async importExecute(
    engineType: EngineType,
    sessions: Array<{
      engineSessionId: string;
      directory: string;
      title: string;
      createdAt: number;
      updatedAt: number;
      engineMeta?: Record<string, unknown>;
    }>,
  ): Promise<SessionImportResult> {
    engineType = this.resolveEngineType(engineType);
    if (engineType === "codex") sessions = sessions.map((session) => ({ ...session, engineSessionId: canonicalCodexThreadId(session.engineSessionId) }));
    const adapter = this.getAdapterOrThrow(engineType);
    const capabilities = adapter.getCapabilities();
    const sourceId = capabilities.hideArchivedSessions && capabilities.sessionCatalog
      ? (await adapter.getCatalog()).sourceId : undefined;

    const result: SessionImportResult = { imported: 0, skipped: 0, errors: [] };
    const total = sessions.length;

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];

      const ccId = s.engineMeta?.ccSessionId;
      const existingCandidate = this.findImportedConversation(engineType, s.engineSessionId, ccId);
      const existingConv = sourceId && existingCandidate?.catalogSourceId && existingCandidate.catalogSourceId !== sourceId
        ? null : existingCandidate;

      try {
        // Fetch messages from engine
        adapter.assertSessionCompatible(s.engineSessionId, s.engineMeta);
        const messages = await adapter.getHistoricalMessages(
          s.engineSessionId,
          s.directory,
          s.engineMeta,
        );
        // Active-only adapters validate their native transcript before returning.
        // Catalog owners also confirm metadata after the read before restoring a
        // previously archived identity through this explicit import operation.
        let nativeSession: UnifiedSession | null = null;
        if (capabilities.hideArchivedSessions && capabilities.authoritativeSessionState) {
          nativeSession = await adapter.getSession(s.engineSessionId);
          if (!nativeSession || nativeSession.id !== s.engineSessionId || nativeSession.archived !== false) {
            throw new Error("Only a confirmed active native conversation can be imported.");
          }
        }

        engineManagerLog.info(
          `Import ${s.engineSessionId}: got ${messages.length} messages (${messages.filter(m => m.role === "user").length} user, ${messages.filter(m => m.role === "assistant").length} assistant)`,
        );

        // Split each message's parts into content (text/file) and steps (everything else)
        const convMessages: ConversationMessage[] = [];
        const allSteps: Record<string, UnifiedPart[]> = {};

        for (const msg of messages) {
          const contentParts: Array<TextPart | FilePart> = [];
          const stepParts: UnifiedPart[] = [];

          for (const part of msg.parts || []) {
            if (part.type === "text" || part.type === "file") {
              contentParts.push(part as TextPart | FilePart);
            } else {
              stepParts.push(part);
            }
          }

          convMessages.push({
            id: msg.id,
            role: msg.role,
            time: msg.time,
            parts: contentParts,
            tokens: msg.tokens,
            cost: msg.cost,
            costUnit: msg.costUnit,
            modelId: msg.modelId,
            reasoningEffort: msg.reasoningEffort,
            error: msg.error,
          });

          if (stepParts.length > 0) {
            allSteps[msg.id] = stepParts;
          }
        }

        // Determine the engineSessionId to store
        // For Claude: store the cc_ prefixed ID, and keep ccSessionId in engineMeta
        const storedEngineSessionId = s.engineSessionId;

        // Preserve the existing mirror if the authoritative history read fails.
        if (existingConv) {
          await conversationStore.delete(existingConv.id);
          this.sessionEngineMap.delete(existingConv.id);
          this.forgetConversationMappings(existingConv.id);
        }

        const conv = await conversationStore.importConversation({
          engineType,
          directory: nativeSession?.directory ?? s.directory,
          title: nativeSession?.title ?? s.title,
          createdAt: nativeSession?.time.created ?? s.createdAt,
          updatedAt: nativeSession?.time.updated ?? s.updatedAt,
          engineSessionId: storedEngineSessionId,
          engineMeta: s.engineMeta,
          ...(capabilities.hideArchivedSessions ? { archived: false, catalogSourceId: sourceId, restoreArchived: true } : {}),
          messages: convMessages,
          steps: allSteps,
        });

        // Register in routing tables
        this.sessionEngineMap.set(conv.id, engineType);
        this.engineToConvMap.set(storedEngineSessionId, conv.id);
        if (capabilities.hideArchivedSessions) this.emit("session.created", { session: this.sessionFromConversation(conv) });

        result.imported++;
      } catch (err: any) {
        const errMsg = `${s.title}: ${err?.message ?? String(err)}`;
        result.errors.push(errMsg);
        engineManagerLog.warn(`Failed to import session ${s.engineSessionId}:`, err);
      }

      this.emitImportProgress(total, i + 1, s.title, result.errors);
    }

    engineManagerLog.info(
      `Import complete: ${result.imported} imported, ${result.skipped} skipped, ${result.errors.length} errors`,
    );
    return result;
  }

  private emitImportProgress(total: number, completed: number, currentTitle: string, errors: string[]): void {
    const progress: SessionImportProgress = { total, completed, currentTitle, errors: [...errors] };
    this.emit("session.import.progress" as any, progress);
  }

  /**
   * Find an existing imported conversation by engine session ID.
   * Returns null if not found or if the conversation was not imported.
   */
  private findImportedConversation(
    engineType: EngineType,
    engineSessionId: string,
    ccSessionId?: string | unknown,
  ): ConversationMeta | null {
    for (const conv of conversationStore.list({ engineType })) {
      if (!conv.imported || !this.isSessionCompatible(conv, this.getAdapterOrThrow(engineType))) continue;
      if (conv.engineSessionId === engineSessionId) return conv;
      if (typeof ccSessionId === "string" && conv.engineMeta?.ccSessionId === ccSessionId) return conv;
    }
    return null;
  }
}
