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
import { app } from "electron";
import { conversationStoreLog } from "./logger";
import { timeId } from "../utils/id-gen";
import type {
  EngineType,
  ConversationMeta,
  ConversationMessage,
  StepsFile,
  UnifiedPart,
  UnifiedProject,
  TextPart,
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
}

// =============================================================================
// Conversation Store
// =============================================================================

class ConversationStore {
  private basePath = "";
  private initialized = false;

  // In-memory index: id → ConversationMeta
  private index = new Map<string, ConversationMeta>();

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

    this.basePath = path.join(app.getPath("userData"), "conversations");
    this.ensureDirSync(this.basePath);
    this.loadIndex();
    this.initialized = true;
    conversationStoreLog.info(
      `Initialized at ${this.basePath}, ${this.index.size} conversations`,
    );
  }

  async flushAll(): Promise<void> {
    if (this.indexDirty) {
      if (this.indexTimer) {
        clearTimeout(this.indexTimer);
        this.indexTimer = null;
      }
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
    title?: string;
  }): ConversationMeta {
    this.ensureInitialized();

    const now = Date.now();
    const conv: ConversationMeta = {
      id: timeId("conv"),
      engineType: params.engineType,
      directory: params.directory,
      title: params.title || this.generateTitle(),
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
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

  rename(id: string, title: string): void {
    this.update(id, { title });
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

        // Auto-title from first user message
        if (messages.length === 1 && msg.role === "user") {
          const textPart = msg.parts.find(
            (p): p is TextPart => p.type === "text",
          );
          if (textPart) {
            conv.title =
              textPart.text.slice(0, 50) +
              (textPart.text.length > 50 ? "..." : "");
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
      const messages = await this.listMessages(id);
      const idx = messages.findIndex((m) => m.id === msgId);
      if (idx === -1) return;

      const { id: _id, ...allowed } = patch;
      Object.assign(messages[idx], allowed);
      await this.writeMessages(id, messages);
    });
  }

  /**
   * Idempotently ensure a message exists — creates it only if no message
   * with the same ID is present. Used for placeholder assistant messages
   * during incremental step persistence.
   */
  async ensureMessage(id: string, msg: ConversationMessage): Promise<void> {
    this.ensureInitialized();

    await this.withWriteLock(id, async () => {
      const messages = await this.listMessages(id);
      if (messages.some((m) => m.id === msg.id)) return;
      messages.push(msg);
      await this.writeMessages(id, messages);
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
   * Derive projects by grouping conversations by (directory, engineType).
   * Each unique combination becomes a virtual project.
   */
  deriveProjects(): UnifiedProject[] {
    this.ensureInitialized();
    const dirEngineMap = new Map<
      string,
      { directory: string; engineType: EngineType }
    >();

    for (const conv of this.index.values()) {
      if (!conv.directory || conv.directory === "/") continue;
      const key = `${conv.engineType}::${this.normalizeDir(conv.directory)}`;
      if (!dirEngineMap.has(key)) {
        dirEngineMap.set(key, {
          directory: conv.directory,
          engineType: conv.engineType,
        });
      }
    }

    const projects: UnifiedProject[] = [];
    for (const { directory, engineType } of dirEngineMap.values()) {
      const name =
        directory.split(/[/\\]/).filter(Boolean).pop() || directory;
      projects.push({
        id: `${engineType}-${this.normalizeDir(directory)}`,
        directory,
        name,
        engineType,
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

  clearEngineSession(id: string): void {
    const conv = this.index.get(id);
    if (!conv) return;

    conv.engineSessionId = undefined;
    this.scheduleIndexWrite();
  }

  findByEngineSession(engineSessionId: string): ConversationMeta | null {
    for (const conv of this.index.values()) {
      if (conv.engineSessionId === engineSessionId) return conv;
    }
    return null;
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

      conversationStoreLog.info(
        `Index loaded: ${this.index.size} conversations`,
      );
    } catch (err) {
      conversationStoreLog.error("Failed to read index:", err);
    }
  }

  private async writeIndex(): Promise<void> {
    this.indexDirty = false;

    const conversations = Array.from(this.index.values());
    conversations.sort((a, b) => b.updatedAt - a.updatedAt);

    const data: ConversationIndex = {
      version: INDEX_VERSION,
      updatedAt: new Date().toISOString(),
      conversations,
    };

    await this.atomicWrite(this.getIndexPath(), data);
  }

  private scheduleIndexWrite(): void {
    this.indexDirty = true;

    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
    }

    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      this.writeIndex();
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

  /**
   * Atomic write: write to .tmp file first, then rename.
   * Uses async I/O to avoid blocking the main process event loop.
   */
  private async atomicWrite(filePath: string, data: unknown): Promise<void> {
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
    }
  }

  private generateTitle(): string {
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const hour = now.getHours();
    const minute = now.getMinutes();
    return `Chat ${month}-${day} ${hour}:${minute.toString().padStart(2, "0")}`;
  }
}

export const conversationStore = new ConversationStore();
