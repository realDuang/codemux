// =============================================================================
// Conversation Store — Self-owned conversation persistence layer
//
// Single source of truth for all conversations, messages, and steps.
// Engine sessions are ephemeral runtime channels; this store owns the data.
//
// Disk layout:
//   %APPDATA%/codemux/conversations/
//     index.json                  - ConversationMeta[] for fast listing
//     {conversationId}.json       - ConversationMessage[] (content parts only)
//     {conversationId}.steps.json - StepsFile (reasoning, tool, step-start/finish, etc.)
//
// Performance:
//   - index.json fully loaded into memory on init (fast listing)
//   - Message/step files loaded on-demand via async I/O (non-blocking)
//   - Index writes debounced 500ms
//   - Atomic writes (.tmp + rename) for crash safety
//   - Per-conversation write locks prevent concurrent file corruption
// =============================================================================

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { conversationStoreLog } from "./logger";
import { getConversationsPath } from "./app-paths";
import { timeId } from "../utils/id-gen";
import type {
  EngineType,
  ConversationMeta,
  ConversationMessage,
  StepsFile,
  UnifiedPart,
  UnifiedProject,
  TextPart,
  ReasoningEffort,
  CodexServiceTier,
  EngineCatalogSnapshot,
  UnifiedSession,
  UnifiedMessage,
  FilePart,
} from "../../../src/types/unified";

// Re-export for convenience
export type { ConversationMeta, ConversationMessage, StepsFile };

// =============================================================================
// Constants
// =============================================================================

const INDEX_VERSION = 1;
const PREVIEW_LENGTH = 100;
const STEPS_FILE_VERSION = 1;
const INDEX_DEBOUNCE_MS = 500;
const MAX_TOOL_OUTPUT_SIZE = 10_240; // 10KB per tool output in persisted steps

// =============================================================================
// Index File Structure
// =============================================================================

interface ConversationIndex {
  version: number;
  updatedAt: string;
  conversations: ConversationMeta[];
  catalogs?: StoredCatalog[];
  removals?: EngineConversationRemoval[];
}

interface EngineConversationRemoval {
  engineType: EngineType;
  sourceId?: string;
  engineSessionId: string;
  conversationId: string;
  kind: "local" | "archived";
}

interface StoredCatalog {
  sourceId: string;
  engineType: EngineType;
  revision: string;
  complete: boolean;
  projects: UnifiedProject[];
}

export function makeCatalogProjectId(engineType: EngineType, sourceId: string, nativeProjectId: string): string {
  return `catalog:${encodeURIComponent(engineType)}:${encodeURIComponent(sourceId)}:${encodeURIComponent(nativeProjectId)}`;
}

// =============================================================================
// Conversation Store
// =============================================================================

class ConversationStore {
  private basePath = "";
  private initialized = false;

  // In-memory index: id → ConversationMeta
  private index = new Map<string, ConversationMeta>();
  private catalogs = new Map<string, StoredCatalog>();
  private removals = new Map<string, EngineConversationRemoval>();

  // Debounced index write
  private indexDirty = false;
  private indexTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-conversation write locks to prevent concurrent file corruption
  private writeLocks = new Map<string, Promise<void>>();

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  init(): void {
    if (this.initialized) return;

    this.basePath = getConversationsPath();
    this.ensureDirSync(this.basePath);
    this.loadIndex();
    this.initialized = true;
    conversationStoreLog.info(
      `Initialized at ${this.basePath}, ${this.index.size} conversations`,
    );
  }

  async flushAll(): Promise<void> {
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
    await this.writeLocks.get("$index");
    if (this.indexDirty) {
      await this.writeIndex();
    }
  }

  // -------------------------------------------------------------------------
  // Conversation CRUD
  // -------------------------------------------------------------------------

  list(filter?: {
    engineType?: EngineType;
    directory?: string;
  }): ConversationMeta[] {
    this.ensureInitialized();
    let result = Array.from(this.index.values());

    if (filter?.engineType) {
      result = result.filter((c) => c.engineType === filter.engineType);
    }
    if (filter?.directory) {
      const norm = this.normalizeDir(filter.directory);
      result = result.filter((c) => this.normalizeDir(c.directory) === norm);
    }

    result.sort((a, b) => b.updatedAt - a.updatedAt);
    return result;
  }

  get(id: string): ConversationMeta | null {
    this.ensureInitialized();
    return this.index.get(id) ?? null;
  }

  create(params: {
    engineType: EngineType;
    directory: string;
    worktreeId?: string;
    parentDirectory?: string;
    archived?: boolean;
    projectId?: string | null;
    catalogSourceId?: string;
    catalogAvailable?: boolean;
  }): ConversationMeta {
    this.ensureInitialized();

    const now = Date.now();
    const conv: ConversationMeta = {
      id: timeId("conv"),
      engineType: params.engineType,
      directory: params.directory,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      worktreeId: params.worktreeId,
      parentDirectory: params.parentDirectory,
      ...(params.archived !== undefined ? { archived: params.archived } : {}),
      ...(params.projectId !== undefined ? { projectId: params.projectId } : {}),
      ...(params.catalogSourceId ? { catalogSourceId: params.catalogSourceId } : {}),
      ...(params.catalogAvailable !== undefined ? { catalogAvailable: params.catalogAvailable } : {}),
    };

    this.index.set(conv.id, conv);
    this.scheduleIndexWrite();

    conversationStoreLog.info(
      `Created conversation ${conv.id} (${conv.engineType}, ${conv.directory})`,
    );
    return conv;
  }

  update(id: string, patch: Partial<ConversationMeta>): void {
    this.ensureInitialized();
    const conv = this.index.get(id);
    if (!conv) return;

    // Apply patch (preserve id, createdAt)
    const { id: _id, createdAt: _ca, ...allowed } = patch;
    Object.assign(conv, allowed);
    if (!patch.updatedAt) {
      conv.updatedAt = Date.now();
    }

    this.scheduleIndexWrite();
  }

  async delete(id: string): Promise<void> {
    this.ensureInitialized();
    if (!this.index.has(id)) return;

    this.index.delete(id);

    // Delete message and steps files (async, best-effort)
    const msgPath = this.getMessageFilePath(id);
    const stepsPath = this.getStepsFilePath(id);
    await Promise.all([
      this.safeDelete(msgPath),
      this.safeDelete(msgPath + ".tmp"),
      this.safeDelete(stepsPath),
      this.safeDelete(stepsPath + ".tmp"),
    ]);

    // Remove any pending write lock for this conversation
    this.writeLocks.delete(id);

    this.scheduleIndexWrite();
    conversationStoreLog.info(`Deleted conversation ${id}`);
  }

  isSessionSuppressed(engineType: EngineType, engineSessionId: string, sourceId?: string): boolean {
    this.ensureInitialized();
    return this.findSessionRemoval(engineType, engineSessionId, sourceId) !== undefined;
  }

  async removeEngineConversation(id: string, kind: "local" | "archived", sourceId?: string): Promise<void> {
    this.ensureInitialized();
    const conv = this.index.get(id);
    const previous = [...this.removals.values()].find((entry) => entry.conversationId === id);
    if (!conv && !previous) return;

    const engineType = conv?.engineType ?? previous!.engineType;
    const engineSessionId = conv?.engineSessionId ?? previous?.engineSessionId;
    const owner = conv?.catalogSourceId ?? previous?.sourceId ?? sourceId;
    if (sourceId !== undefined && owner !== sourceId) throw new Error("Conversation source does not match removal source");
    if (engineSessionId) {
      if (previous) this.removals.delete(this.removalKey(previous.engineType, previous.engineSessionId, previous.sourceId));
      const removal: EngineConversationRemoval = {
        engineType, engineSessionId, conversationId: id,
        kind: previous?.kind === "local" ? "local" : kind,
        ...(owner !== undefined ? { sourceId: owner } : {}),
      };
      this.removals.set(this.removalKey(engineType, engineSessionId, owner), removal);
    }
    // Invalidate pending mirror writes before yielding to the filesystem.
    this.index.delete(id);
    this.scheduleIndexWrite();

    await this.withWriteLock(id, () => this.withWriteLock(`${id}.steps`, async () => {
      await this.flushAll();
      await this.deleteConversationFiles(id);
    }));
  }

  private removalKey(engineType: EngineType, engineSessionId: string, sourceId?: string): string {
    return JSON.stringify([engineType, sourceId ?? null, engineSessionId]);
  }

  private findSessionRemoval(engineType: EngineType, engineSessionId: string, sourceId?: string): EngineConversationRemoval | undefined {
    const legacy = this.removals.get(this.removalKey(engineType, engineSessionId));
    const scoped = sourceId === undefined ? undefined : this.removals.get(this.removalKey(engineType, engineSessionId, sourceId));
    return legacy?.kind === "local" ? legacy : scoped ?? legacy;
  }

  setCustomTitle(id: string, title?: string): void {
    this.update(id, { customTitle: title });
  }

  setArchived(id: string, archived: boolean): void {
    this.ensureInitialized();
    if (!this.index.has(id)) throw new Error(`Conversation not found: ${id}`);
    this.update(id, { archived });
  }

  setEngineTitle(id: string, title?: string): void {
    if (!title) return;
    const conv = this.index.get(id);
    if (!conv || conv.engineTitle === title) return;
    this.update(id, { engineTitle: title });
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async listMessages(id: string): Promise<ConversationMessage[]> {
    this.ensureInitialized();
    const filePath = this.getMessageFilePath(id);

    try {
      const raw = await fsp.readFile(filePath, "utf-8");
      return JSON.parse(raw) as ConversationMessage[];
    } catch (err: any) {
      // ENOENT is expected for new conversations with no messages yet
      if (err.code !== "ENOENT") {
        conversationStoreLog.error(
          `Failed to read messages for ${id}:`,
          err,
        );
      }
      return [];
    }
  }

  /**
   * Appends a message to a conversation.
   * Uses a per-conversation write lock to prevent concurrent file corruption.
   */
  async appendMessage(id: string, msg: ConversationMessage): Promise<void> {
    this.ensureInitialized();

    await this.withWriteLock(id, async () => {
      if (!this.index.has(id)) return;
      const messages = await this.listMessages(id);
      messages.push(msg);
      await this.writeMessages(id, messages);

      // Update meta
      const conv = this.index.get(id);
      if (conv) {
        conv.messageCount = messages.length;
        conv.updatedAt = Date.now();

        // Update preview from last text part
        if (msg.parts.length > 0) {
          const textPart = msg.parts.find(
            (p): p is TextPart => p.type === "text",
          );
          if (textPart) {
            conv.preview = textPart.text.slice(0, PREVIEW_LENGTH);
            if (textPart.text.length > PREVIEW_LENGTH) {
              conv.preview += "...";
            }
          }
        }

        // Capture first user prompt for displayTitle fallback
        if (
          messages.length === 1 &&
          msg.role === "user" &&
          !conv.firstPrompt
        ) {
          const textPart = msg.parts.find(
            (p): p is TextPart => p.type === "text",
          );
          if (textPart) {
            conv.firstPrompt =
              textPart.text.slice(0, 100) +
              (textPart.text.length > 100 ? "…" : "");
          }
        }

        this.scheduleIndexWrite();
      }
    });
  }

  async updateMessage(
    id: string,
    msgId: string,
    patch: Partial<ConversationMessage>,
  ): Promise<void> {
    this.ensureInitialized();

    await this.withWriteLock(id, async () => {
      if (!this.index.has(id)) return;
      const messages = await this.listMessages(id);
      const idx = messages.findIndex((m) => m.id === msgId);
      if (idx === -1) return;

      const { id: _id, ...allowed } = patch;
      Object.assign(messages[idx], allowed);
      await this.writeMessages(id, messages);
    });
  }

  /** Replace one local projection only after its owner returned complete history. */
  async replaceMessageSnapshot(id: string, snapshot: UnifiedMessage[]): Promise<void> {
    this.ensureInitialized();
    const ids = snapshot.map((message) => message.id);
    if (new Set(ids).size !== ids.length) throw new Error("Snapshot message identities must be unique.");
    const messages: ConversationMessage[] = [];
    const steps: StepsFile = { version: STEPS_FILE_VERSION, conversationId: id, messages: {} };
    for (const source of structuredClone(snapshot)) {
      const parts = source.parts.map((part) => ({ ...part, sessionId: id, messageId: source.id }));
      const { parts: _parts, sessionId: _sessionId, ...metadata } = source;
      messages.push({ ...metadata, parts: parts.filter((part): part is TextPart | FilePart => part.type === "text" || part.type === "file") });
      const messageSteps = parts.filter((part) => part.type !== "text" && part.type !== "file");
      if (messageSteps.length > 0) steps.messages[source.id] = messageSteps.map((part) => this.truncateStepOutput(part));
    }

    await this.withWriteLock(id, () => this.withWriteLock(`${id}.steps`, async () => {
      const conv = this.index.get(id);
      if (!conv) throw new Error(`Conversation ${id} not found`);
      await this.writeMessages(id, messages);
      await this.writeStepsFile(id, steps);
      conv.messageCount = messages.length;
      conv.preview = undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        const text = messages[i].parts.find((part): part is TextPart => part.type === "text");
        if (!text) continue;
        conv.preview = text.text.slice(0, PREVIEW_LENGTH) + (text.text.length > PREVIEW_LENGTH ? "..." : "");
        break;
      }
      this.scheduleIndexWrite();
    }));
  }

  async removeMessage(id: string, messageId: string): Promise<void> {
    this.ensureInitialized();

    await this.withWriteLock(id, () => this.withWriteLock(`${id}.steps`, async () => {
      if (!this.index.has(id)) return;
      const messages = await this.listMessages(id);
      const remaining = messages.filter((message) => message.id !== messageId);
      const stepsFile = await this.readStepsFile(id);
      const hasSteps = stepsFile !== null &&
        Object.prototype.hasOwnProperty.call(stepsFile.messages, messageId);
      if (remaining.length === messages.length && !hasSteps) return;

      if (remaining.length !== messages.length) {
        await this.writeMessages(id, remaining);
      }
      if (stepsFile && hasSteps) {
        delete stepsFile.messages[messageId];
        await this.writeStepsFile(id, stepsFile);
      }

      const conv = this.index.get(id);
      if (conv) {
        conv.messageCount = remaining.length;
        conv.updatedAt = Date.now();
        conv.preview = undefined;
        for (let i = remaining.length - 1; i >= 0; i--) {
          const textPart = remaining[i].parts.find(
            (part): part is TextPart => part.type === "text",
          );
          if (textPart) {
            conv.preview = textPart.text.slice(0, PREVIEW_LENGTH);
            if (textPart.text.length > PREVIEW_LENGTH) conv.preview += "...";
            break;
          }
        }
        this.scheduleIndexWrite();
      }
    }));
  }

  /**
   * Idempotently ensure a message exists — creates it only if no message
   * with the same ID is present. Used for placeholder assistant messages
   * during incremental step persistence.
   */
  async ensureMessage(id: string, msg: ConversationMessage): Promise<void> {
    this.ensureInitialized();

    await this.withWriteLock(id, async () => {
      if (!this.index.has(id)) return;
      const messages = await this.listMessages(id);
      if (messages.some((m) => m.id === msg.id)) return;
      messages.push(msg);
      await this.writeMessages(id, messages);

      // Update meta (same as appendMessage)
      const conv = this.index.get(id);
      if (conv) {
        conv.messageCount = messages.length;
        conv.updatedAt = Date.now();

        if (msg.parts.length > 0) {
          const textPart = msg.parts.find(
            (p): p is TextPart => p.type === "text",
          );
          if (textPart) {
            conv.preview = textPart.text.slice(0, PREVIEW_LENGTH);
            if (textPart.text.length > PREVIEW_LENGTH) {
              conv.preview += "...";
            }
          }
        }

        this.scheduleIndexWrite();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  async getSteps(id: string, messageId: string): Promise<UnifiedPart[]> {
    this.ensureInitialized();
    const stepsFile = await this.readStepsFile(id);
    if (!stepsFile) return [];
    return stepsFile.messages[messageId] ?? [];
  }

  async getAllSteps(id: string): Promise<StepsFile | null> {
    this.ensureInitialized();
    return this.readStepsFile(id);
  }

  async saveSteps(id: string, messageId: string, steps: UnifiedPart[]): Promise<void> {
    this.ensureInitialized();

    // Truncate large tool outputs before persisting
    const truncated = steps.map((step) => this.truncateStepOutput(step));

    await this.withWriteLock(`${id}.steps`, async () => {
      if (!this.index.has(id)) return;
      // Read existing steps file or create new
      let stepsFile = await this.readStepsFile(id);
      if (!stepsFile) {
        stepsFile = {
          version: STEPS_FILE_VERSION,
          conversationId: id,
          messages: {},
        };
      }

      stepsFile.messages[messageId] = truncated;
      await this.writeStepsFile(id, stepsFile);
    });
  }

  // -------------------------------------------------------------------------
  // Project Derivation
  // -------------------------------------------------------------------------

  /**
   * Derive projects by grouping conversations by directory.
   * Each unique directory becomes a single project (engine-agnostic).
   */
  deriveProjects(): UnifiedProject[] {
    this.ensureInitialized();
    const dirMap = new Map<string, { directory: string }>();

    for (const conv of this.index.values()) {
      if (conv.catalogSourceId) continue;
      if (!conv.directory || conv.directory === "/") continue;
      // Worktree sessions belong to their parent project, not a separate one
      if (conv.worktreeId) continue;
      const key = this.normalizeDir(conv.directory);
      if (!dirMap.has(key)) {
        // Always store the normalized (forward-slash) form as the canonical directory
        dirMap.set(key, { directory: key });
      }
    }

    const projects: UnifiedProject[] = [];
    for (const { directory } of dirMap.values()) {
      const name =
        directory.split(/[/\\]/).filter(Boolean).pop() || directory;
      projects.push({
        id: `dir-${directory}`,
        directory,
        name,
      });
    }
    return projects;
  }

  // -------------------------------------------------------------------------
  // Engine Session Association
  // -------------------------------------------------------------------------

  setEngineSession(
    id: string,
    engineSessionId: string,
    meta?: Record<string, unknown>,
  ): void {
    const conv = this.index.get(id);
    if (!conv) return;

    conv.engineSessionId = engineSessionId;
    if (meta) {
      conv.engineMeta = { ...conv.engineMeta, ...meta };
    }
    this.scheduleIndexWrite();
  }

  updateSessionConfig(
    id: string,
    patch: {
      mode?: string | null;
      modelId?: string | null;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: CodexServiceTier | null;
    },
  ): ConversationMeta | null {
    const conv = this.index.get(id);
    if (!conv) return null;

    let changed = false;

    if (Object.prototype.hasOwnProperty.call(patch, "mode")) {
      const nextMode = patch.mode ?? undefined;
      if (conv.mode !== nextMode) {
        conv.mode = nextMode;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, "modelId")) {
      const nextModelId = patch.modelId ?? undefined;
      if (conv.modelId !== nextModelId) {
        conv.modelId = nextModelId;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, "reasoningEffort")) {
      const nextEffort = patch.reasoningEffort ?? undefined;
      if (conv.reasoningEffort !== nextEffort) {
        conv.reasoningEffort = nextEffort;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, "serviceTier")) {
      const nextTier = patch.serviceTier ?? undefined;
      if (conv.serviceTier !== nextTier) {
        conv.serviceTier = nextTier;
        changed = true;
      }
    }

    if (changed) {
      this.scheduleIndexWrite();
    }

    return conv;
  }

  clearEngineSession(id: string): void {
    const conv = this.index.get(id);
    if (!conv) return;

    conv.engineSessionId = undefined;
    this.scheduleIndexWrite();
  }

  findByEngineSession(engineSessionId: string, engineType?: EngineType, sourceId?: string): ConversationMeta | null {
    for (const conv of this.index.values()) {
      if (conv.engineSessionId === engineSessionId && (!engineType || conv.engineType === engineType)
        && (sourceId === undefined || conv.catalogSourceId === sourceId)) return conv;
    }
    return null;
  }

  listCatalogs(): EngineCatalogSnapshot[] {
    this.ensureInitialized();
    return [...this.catalogs.values()].map((catalog) => ({
      ...catalog,
      projects: structuredClone(catalog.projects),
      sessions: [...this.index.values()].filter((conv) => conv.engineType === catalog.engineType && conv.catalogSourceId === catalog.sourceId)
        .map((conv) => this.catalogSession(conv)),
    }));
  }

  getCatalogProject(projectId: string): UnifiedProject | undefined {
    this.ensureInitialized();
    for (const catalog of this.catalogs.values()) {
      const project = catalog.projects.find((candidate) => candidate.id === projectId);
      if (project) return structuredClone(project);
    }
    return undefined;
  }

  upsertCatalog(engineType: EngineType, snapshot: EngineCatalogSnapshot): EngineCatalogSnapshot {
    this.ensureInitialized();
    if (typeof snapshot.sourceId !== "string" || !snapshot.sourceId.trim() || typeof snapshot.revision !== "string"
      || typeof snapshot.complete !== "boolean" || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.sessions)) throw new Error("Invalid catalog identity or snapshot");
    if (snapshot.engineType !== undefined && snapshot.engineType !== engineType) throw new Error("Catalog engine identity does not match its source");
    for (const entries of [snapshot.projects, snapshot.sessions]) {
      const ids = entries.map((entry) => entry?.id);
      if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw new Error("Catalog IDs must be unique and non-empty");
    }
    for (const project of snapshot.projects) {
      if (project.engineType !== undefined && project.engineType !== engineType) throw new Error("Catalog project belongs to another engine");
      if (project.directory !== undefined && typeof project.directory !== "string") throw new Error("Invalid catalog project directory");
      if (project.roots !== undefined && (!Array.isArray(project.roots) || project.roots.some((root) => typeof root !== "string"))) throw new Error("Invalid catalog project roots");
      if (project.order !== undefined && !Number.isFinite(project.order)) throw new Error("Invalid catalog project order");
    }
    for (const session of snapshot.sessions) {
      if (session.engineType !== engineType) throw new Error("Catalog session belongs to another engine");
      if (typeof session.directory !== "string" || !Number.isFinite(session.time?.created) || !Number.isFinite(session.time?.updated)) throw new Error("Invalid catalog session metadata");
      if (session.projectId != null && (typeof session.projectId !== "string" || !session.projectId)) throw new Error("Invalid catalog session project ID");
    }
    // Validate and detach all input before changing persistent metadata. Engines
    // may reuse their snapshot objects while the store waits for its disk flush.
    snapshot = structuredClone(snapshot);
    const key = JSON.stringify([engineType, snapshot.sourceId]);
    const previous = this.catalogs.get(key);
    const projects = new Map((previous?.projects ?? []).map((project) => [project.id, project]));
    let nextPartialOrder = [...projects.values()].reduce((last, project) => Math.max(last, project.order ?? -1), -1) + 1;
    if (snapshot.complete) {
      for (const [id, project] of projects) projects.set(id, { ...project, catalogAvailable: false });
    }
    snapshot.projects.forEach((project, position) => {
      const id = makeCatalogProjectId(engineType, snapshot.sourceId, project.id);
      // A partial page has no absolute position for an omitted order field.
      const order = project.order ?? (snapshot.complete ? position : projects.get(id)?.order ?? nextPartialOrder);
      nextPartialOrder = Math.max(nextPartialOrder, order + 1);
      projects.set(id, {
        ...project, id, engineType, directory: project.directory ?? project.roots?.[0] ?? "",
        roots: project.roots?.slice() ?? (project.directory ? [project.directory] : []),
        order, catalogSourceId: snapshot.sourceId,
        catalogProjectId: project.id, catalogAvailable: true,
      });
    });

    const seen = new Set<string>();
    const liveSessions = new Map<string, UnifiedSession>();
    for (const session of snapshot.sessions) {
      if (this.isSessionSuppressed(engineType, session.id, snapshot.sourceId)) continue;
      const existing = this.findByEngineSession(session.id, engineType, snapshot.sourceId)
        ?? [...this.index.values()].find((conv) => conv.engineType === engineType && conv.engineSessionId === session.id && !conv.catalogSourceId);
      const conv: ConversationMeta = existing ?? {
        id: timeId("conv"), engineType, directory: session.directory, createdAt: session.time.created,
        updatedAt: session.time.updated, messageCount: 0, imported: true,
      };
      const projectId = session.projectId === undefined ? (existing?.catalogSourceId === snapshot.sourceId ? conv.projectId ?? null : null)
        : session.projectId === null ? null : makeCatalogProjectId(engineType, snapshot.sourceId, session.projectId);
      Object.assign(conv, {
        engineType, engineSessionId: session.id, catalogSourceId: snapshot.sourceId, catalogAvailable: true,
        projectId, directory: session.directory, updatedAt: session.time.updated,
        ...(Object.prototype.hasOwnProperty.call(session, "title") ? { engineTitle: session.title } : {}),
        ...(session.archived !== undefined ? { archived: session.archived } : {}),
        ...(session.mode !== undefined ? { mode: session.mode } : {}),
        ...(session.modelId !== undefined ? { modelId: session.modelId } : {}),
        ...(session.reasoningEffort !== undefined ? { reasoningEffort: session.reasoningEffort } : {}),
        ...(session.serviceTier !== undefined ? { serviceTier: session.serviceTier } : {}),
        engineMeta: structuredClone({ ...conv.engineMeta, ...session.engineMeta }),
      });
      this.index.set(conv.id, conv);
      seen.add(conv.id);
      liveSessions.set(conv.id, { ...session, ...this.catalogSession(conv) });
    }
    if (snapshot.complete) {
      for (const conv of this.index.values()) {
        // Undefined means a local creation has not appeared in native storage yet.
        if (conv.engineType === engineType && conv.catalogSourceId === snapshot.sourceId && conv.catalogAvailable === true && !seen.has(conv.id)) conv.catalogAvailable = false;
      }
    }
    this.catalogs.set(key, {
      sourceId: snapshot.sourceId, engineType, revision: snapshot.revision, complete: snapshot.complete,
      projects: [...projects.values()].sort((a, b) => Number(b.catalogAvailable) - Number(a.catalogAvailable) || (a.order ?? 0) - (b.order ?? 0)),
    });
    this.scheduleIndexWrite();
    const result = this.listCatalogs().find((catalog) => catalog.engineType === engineType && catalog.sourceId === snapshot.sourceId)!;
    result.sessions = result.sessions.map((session) => liveSessions.get(session.id) ?? session);
    return result;
  }

  markCatalogUnavailable(engineType: EngineType, sourceId: string): EngineCatalogSnapshot | undefined {
    this.ensureInitialized();
    const catalog = this.catalogs.get(JSON.stringify([engineType, sourceId]));
    if (!catalog) return undefined;
    catalog.complete = false;
    catalog.projects = catalog.projects.map((project) => ({ ...project, catalogAvailable: false }));
    for (const conv of this.index.values()) {
      if (conv.engineType === engineType && conv.catalogSourceId === sourceId && conv.catalogAvailable === true) conv.catalogAvailable = false;
    }
    this.scheduleIndexWrite();
    return this.listCatalogs().find((entry) => entry.engineType === engineType && entry.sourceId === sourceId);
  }

  private catalogSession(conv: ConversationMeta): UnifiedSession {
    return {
      id: conv.id, engineType: conv.engineType, title: conv.engineTitle ?? "", directory: conv.directory,
      projectId: conv.projectId ?? null, catalogSourceId: conv.catalogSourceId, catalogAvailable: conv.catalogAvailable,
      archived: conv.archived, mode: conv.mode, modelId: conv.modelId, reasoningEffort: conv.reasoningEffort,
      serviceTier: conv.serviceTier, engineMeta: structuredClone(conv.engineMeta), time: { created: conv.createdAt, updated: conv.updatedAt },
    };
  }

  // -------------------------------------------------------------------------
  // Historical Session Import
  // -------------------------------------------------------------------------

  /**
   * Collect all engine session IDs for a given engine type, for O(1) dedup lookups.
   * For Claude, also includes engineMeta.ccSessionId values.
   */
  findAllEngineSessionIds(engineType: EngineType): Set<string> {
    this.ensureInitialized();
    const ids = new Set<string>();
    for (const conv of this.index.values()) {
      if (conv.engineType !== engineType) continue;
      if (conv.engineSessionId) ids.add(conv.engineSessionId);
      // Claude stores the real CC session ID in engineMeta
      const ccId = conv.engineMeta?.ccSessionId;
      if (typeof ccId === "string") ids.add(ccId);
    }
    return ids;
  }

  /**
   * Import a complete conversation (meta + messages + steps) in one operation.
   * Used for importing historical sessions from engines.
   */
  async importConversation(params: {
    engineType: EngineType;
    directory: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    engineSessionId: string;
    engineMeta?: Record<string, unknown>;
    archived?: boolean;
    catalogSourceId?: string;
    restoreArchived?: boolean;
    messages: ConversationMessage[];
    steps: Record<string, UnifiedPart[]>;
  }): Promise<ConversationMeta> {
    this.ensureInitialized();

    const removal = this.findSessionRemoval(params.engineType, params.engineSessionId, params.catalogSourceId);
    if (removal && (removal.kind === "local" || !params.restoreArchived)) throw new Error("Engine session is suppressed");
    const convId = removal?.conversationId ?? timeId("conv");
    const conv: ConversationMeta = {
      id: convId,
      engineType: params.engineType,
      directory: params.directory,
      engineTitle: params.title,
      createdAt: params.createdAt,
      updatedAt: params.updatedAt,
      messageCount: params.messages.length,
      engineSessionId: params.engineSessionId,
      engineMeta: params.engineMeta,
      imported: true,
      ...(params.archived !== undefined ? { archived: params.archived } : {}),
      ...(params.catalogSourceId !== undefined ? { catalogSourceId: params.catalogSourceId } : {}),
    };

    // Rewrite sessionId in all parts to use the conversation ID
    const rewrittenMessages = params.messages.map((msg) => ({
      ...msg,
      parts: msg.parts.map((p) => ({ ...p, sessionId: convId })),
    }));

    // Set preview from last text part
    for (let i = rewrittenMessages.length - 1; i >= 0; i--) {
      const textPart = rewrittenMessages[i].parts.find(
        (p): p is TextPart => p.type === "text",
      );
      if (textPart) {
        conv.preview = textPart.text.slice(0, PREVIEW_LENGTH);
        if (textPart.text.length > PREVIEW_LENGTH) conv.preview += "...";
        break;
      }
    }

    // Capture first user prompt for displayTitle fallback
    for (const m of rewrittenMessages) {
      if (m.role !== "user") continue;
      const tp = m.parts.find((p): p is TextPart => p.type === "text");
      if (tp) {
        conv.firstPrompt =
          tp.text.slice(0, 100) + (tp.text.length > 100 ? "…" : "");
        break;
      }
    }

    return this.withWriteLock(convId, () => this.withWriteLock(`${convId}.steps`, async () => {
      const currentRemoval = this.findSessionRemoval(params.engineType, params.engineSessionId, params.catalogSourceId);
      if (currentRemoval !== removal || (currentRemoval && (currentRemoval.kind === "local" || !params.restoreArchived))) {
        throw new Error("Engine session is suppressed");
      }
      const stepEntries = Object.entries(params.steps);
      // Publish the restored identity only after both files have been written.
      try {
        // Write messages file
        if (rewrittenMessages.length > 0 || removal) {
          await this.atomicWrite(this.getMessageFilePath(convId), rewrittenMessages, true);
        }

        // Write steps file
        if (stepEntries.length > 0 || removal) {
          // Truncate large tool outputs and rewrite sessionId
          const truncatedSteps: Record<string, UnifiedPart[]> = {};
          for (const [msgId, parts] of stepEntries) {
            truncatedSteps[msgId] = parts.map((s) => {
              const rewritten = { ...s, sessionId: convId } as UnifiedPart;
              return this.truncateStepOutput(rewritten);
            });
          }

          const stepsFile: StepsFile = {
            version: STEPS_FILE_VERSION,
            conversationId: convId,
            messages: truncatedSteps,
          };
          await this.atomicWrite(this.getStepsFilePath(convId), stepsFile, true);
        }
      } catch (err) {
        await this.deleteConversationFiles(convId);
        throw err;
      }

      if (this.findSessionRemoval(params.engineType, params.engineSessionId, params.catalogSourceId) !== removal) {
        await this.deleteConversationFiles(convId);
        throw new Error("Engine session was removed while importing");
      }

      if (removal) this.removals.delete(this.removalKey(removal.engineType, removal.engineSessionId, removal.sourceId));
      this.index.set(convId, conv);
      this.scheduleIndexWrite();

      conversationStoreLog.info(
        `Imported conversation ${convId} (${conv.engineType}, ${params.messages.length} msgs, ${stepEntries.length} msgs with steps)`,
      );
      return conv;
    }));
  }

  // -------------------------------------------------------------------------
  // Private — Write Lock
  // -------------------------------------------------------------------------

  /**
   * Serialize async writes per conversation to prevent concurrent file corruption.
   * Each conversation (or steps file) gets its own promise chain.
   */
  private async withWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLocks.get(key) ?? Promise.resolve();
    let resolve: () => void;
    const lock = new Promise<void>((r) => { resolve = r; });
    this.writeLocks.set(key, lock);

    // Wait for previous write to complete before starting ours
    await prev.catch(() => {}); // ignore previous errors

    try {
      return await fn();
    } finally {
      resolve!();
    }
  }

  // -------------------------------------------------------------------------
  // Private — Index Persistence
  // -------------------------------------------------------------------------

  /** Synchronous index load — called once at startup before app is ready */
  private loadIndex(): void {
    this.catalogs.clear();
    this.removals.clear();
    const indexPath = this.getIndexPath();

    if (!fs.existsSync(indexPath)) {
      conversationStoreLog.info("No index file found, starting fresh");
      return;
    }

    try {
      const raw = fs.readFileSync(indexPath, "utf-8");
      const data: ConversationIndex = JSON.parse(raw);

      if (data.version !== INDEX_VERSION) {
        conversationStoreLog.warn(
          `Index version mismatch (${data.version} vs ${INDEX_VERSION}), rebuilding`,
        );
        return;
      }

      for (const conv of data.conversations) {
        this.index.set(conv.id, conv);
      }
      for (const catalog of data.catalogs ?? []) {
        this.catalogs.set(JSON.stringify([catalog.engineType, catalog.sourceId]), catalog);
      }
      for (const removal of data.removals ?? []) {
        this.removals.set(this.removalKey(removal.engineType, removal.engineSessionId, removal.sourceId), removal);
        this.index.delete(removal.conversationId);
      }

      conversationStoreLog.info(
        `Index loaded: ${this.index.size} conversations`,
      );
    } catch (err) {
      conversationStoreLog.error("Failed to read index:", err);
    }
  }

  private async writeIndex(): Promise<void> {
    await this.withWriteLock("$index", async () => {
      this.indexDirty = false;

      const conversations = Array.from(this.index.values());
      conversations.sort((a, b) => b.updatedAt - a.updatedAt);

      const data: ConversationIndex = {
        version: INDEX_VERSION,
        updatedAt: new Date().toISOString(),
        conversations,
        ...(this.catalogs.size > 0 ? { catalogs: [...this.catalogs.values()] } : {}),
        ...(this.removals.size > 0 ? { removals: [...this.removals.values()] } : {}),
      };

      try {
        await this.atomicWrite(this.getIndexPath(), data, true);
      } catch (err) {
        this.indexDirty = true;
        throw err;
      }
    });
  }

  private scheduleIndexWrite(): void {
    this.indexDirty = true;

    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
    }

    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      void this.writeIndex().catch((err) => conversationStoreLog.error("Failed to persist conversation index:", err));
    }, INDEX_DEBOUNCE_MS);
  }

  // -------------------------------------------------------------------------
  // Private — File Paths
  // -------------------------------------------------------------------------

  private getIndexPath(): string {
    return path.join(this.basePath, "index.json");
  }

  private getMessageFilePath(id: string): string {
    return path.join(this.basePath, `${id}.json`);
  }

  private getStepsFilePath(id: string): string {
    return path.join(this.basePath, `${id}.steps.json`);
  }

  // -------------------------------------------------------------------------
  // Private — Message File I/O
  // -------------------------------------------------------------------------

  private async writeMessages(id: string, messages: ConversationMessage[]): Promise<void> {
    if (!this.index.has(id)) return;
    await this.atomicWrite(this.getMessageFilePath(id), messages);
  }

  // -------------------------------------------------------------------------
  // Private — Steps File I/O
  // -------------------------------------------------------------------------

  private async readStepsFile(id: string): Promise<StepsFile | null> {
    const filePath = this.getStepsFilePath(id);

    try {
      const raw = await fsp.readFile(filePath, "utf-8");
      return JSON.parse(raw) as StepsFile;
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        conversationStoreLog.error(`Failed to read steps for ${id}:`, err);
      }
      return null;
    }
  }

  private async writeStepsFile(id: string, stepsFile: StepsFile): Promise<void> {
    if (!this.index.has(id)) return;
    await this.atomicWrite(this.getStepsFilePath(id), stepsFile);
  }

  /**
   * Truncate large tool outputs in step parts to keep file sizes manageable.
   */
  private truncateStepOutput(step: UnifiedPart): UnifiedPart {
    if (step.type !== "tool") return step;

    const state = step.state;
    if (
      state.status === "completed" &&
      typeof state.output === "string" &&
      state.output.length > MAX_TOOL_OUTPUT_SIZE
    ) {
      return {
        ...step,
        state: {
          ...state,
          output:
            state.output.slice(0, MAX_TOOL_OUTPUT_SIZE) +
            `\n...[truncated, ${state.output.length - MAX_TOOL_OUTPUT_SIZE} chars omitted]`,
        },
      };
    }

    return step;
  }

  // -------------------------------------------------------------------------
  // Private — Utility
  // -------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "ConversationStore not initialized. Call init() after app.whenReady()",
      );
    }
  }

  private normalizeDir(dir: string): string {
    return dir.replaceAll("\\", "/");
  }

  /** Synchronous dir creation — used only in init() at startup */
  private ensureDirSync(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private async ensureDir(dirPath: string): Promise<void> {
    try {
      await fsp.mkdir(dirPath, { recursive: true });
    } catch {
      // directory already exists or other non-critical error
    }
  }

  private async safeDelete(filePath: string): Promise<void> {
    try {
      await fsp.rm(filePath, { force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }

  private async deleteConversationFiles(id: string): Promise<void> {
    const messages = this.getMessageFilePath(id);
    const steps = this.getStepsFilePath(id);
    await Promise.all([messages, `${messages}.tmp`, steps, `${steps}.tmp`].map((file) => fsp.rm(file, { force: true })));
  }

  /**
   * Atomic write: write to .tmp file first, then rename.
   * Uses async I/O to avoid blocking the main process event loop.
   */
  private async atomicWrite(filePath: string, data: unknown, throwOnError = false): Promise<void> {
    const dir = path.dirname(filePath);
    await this.ensureDir(dir);

    const tmpPath = filePath + ".tmp";
    try {
      await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      await fsp.rename(tmpPath, filePath);
    } catch (err) {
      conversationStoreLog.error(`Failed to write ${filePath}:`, err);
      try {
        await fsp.unlink(tmpPath);
      } catch {
        /* ignore */
      }
      if (throwOnError) throw err;
    }
  }
}

export const conversationStore = new ConversationStore();
