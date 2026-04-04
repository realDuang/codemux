// ============================================================================
// Engine Manager — Registry, routing, and project-engine bindings
// ============================================================================

import { EventEmitter } from "events";
import { EngineAdapter, type EngineAdapterEvents } from "../engines/engine-adapter";
import { conversationStore } from "../services/conversation-store";
import { getDefaultWorkspacePath } from "../services/default-workspace";
import { engineManagerLog, getDefaultEngineFromSettings } from "../services/logger";
import { timeId } from "../utils/id-gen";
import type {
  EngineType,
  EngineInfo,
  UnifiedSession,
  UnifiedMessage,
  UnifiedPart,
  TextPart,
  FilePart,
  ModelListResult,
  UnifiedProject,
  AgentMode,
  MessagePromptContent,
  PermissionReply,
  ConversationMeta,
  ConversationMessage,
  ImportableSession,
  SessionImportResult,
  SessionImportProgress,
  EngineCommand,
  CommandInvokeResult,
} from "../../../src/types/unified";

// --- Helpers ---

/** Normalize directory separators to forward slashes (Windows compat) */
function normalizeDir(dir: string): string {
  return dir ? dir.replaceAll("\\", "/") : "";
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
    title: conv.title,
    worktreeId: conv.worktreeId,
    projectId: `dir-${projectDir}`,
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
  /** engineSessionId → conversationId cache (populated on session creation / lookup) */
  private engineToConvMap = new Map<string, string>();
  /** Accumulate step-type parts during streaming: messageId → UnifiedPart[] */
  private stepPartsBuffer = new Map<string, UnifiedPart[]>();
  /** Accumulate content-type parts (text/file) during streaming: messageId → (TextPart|FilePart)[] */
  private contentPartsBuffer = new Map<string, Array<TextPart | FilePart>>();

  // --- Incremental step persistence ---
  /** messageIds whose step buffers have unsaved changes */
  private dirtySteps = new Set<string>();
  /** messageId → conversationId mapping for dirty step flush */
  private messageConvMap = new Map<string, string>();
  /** messageIds for which a placeholder assistant message has been persisted */
  private persistedPlaceholders = new Set<string>();
  /** Timer for debounced step flush (2s interval) */
  private stepFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STEP_FLUSH_INTERVAL_MS = 2000;

  /** Track which sessions have active sendMessage calls (for idle detection) */
  private activeSessions = new Set<string>();

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
    return this.adapters.get(engineType);
  }

  private getAdapterOrThrow(engineType: EngineType): EngineAdapter {
    const adapter = this.adapters.get(engineType);
    if (!adapter) {
      throw new Error(`No adapter registered for engine type: ${engineType}`);
    }
    return adapter;
  }

  /** Get adapter for a conversation by looking up its engine binding */
  private getAdapterForSession(sessionId: string): EngineAdapter {
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
    return this.getAdapterOrThrow(engineType);
  }

  /** Get adapter for a directory based on project binding */
  private getAdapterForDirectory(directory: string): EngineAdapter {
    const engineType = this.projectBindings.get(normalizeDir(directory));
    if (!engineType) {
      throw new Error(`No engine binding found for directory: ${directory}`);
    }
    return this.getAdapterOrThrow(engineType);
  }

  // --- Event Forwarding ---

  /**
   * Resolve engineSessionId → conversationId.
   * Uses in-memory cache first, then falls back to ConversationStore lookup.
   */
  private resolveConversationId(engineSessionId: string): string | null {
    const cached = this.engineToConvMap.get(engineSessionId);
    if (cached) return cached;
    const conv = conversationStore.findByEngineSession(engineSessionId);
    if (conv) {
      this.engineToConvMap.set(engineSessionId, conv.id);
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
    // --- message.part.updated: accumulate step parts + rewrite sessionId ---
    adapter.on("message.part.updated", (data) => {
      const { sessionId: engineSessionId, messageId, part } = data;
      const convId = this.resolveConversationId(engineSessionId);

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
      const convId = this.resolveConversationId(engineSessionId);

      if (convId) {
        // Persist the message
        this.persistMessage(convId, message);

        // Rewrite sessionId and forward to frontend
        const rewritten = this.rewriteSessionId(data, engineSessionId, convId);
        this.emit("message.updated", rewritten as any);
      } else {
        this.emit("message.updated", data);
      }
    });

    // --- session.updated: persist metadata changes then forward with rewrite ---
    adapter.on("session.updated", (data) => {
      const engineSessionId = data?.session?.id;
      const convId = engineSessionId ? this.resolveConversationId(engineSessionId) : null;

      if (convId) {
        // Persist title changes
        if (data.session.title) {
          const conv = conversationStore.get(convId);
          if (conv && this.isDefaultTitle(conv.title)) {
            conversationStore.rename(convId, data.session.title);
          }
        }
        // Persist engineMeta (e.g. ccSessionId for Claude Code session resumption)
        if (data.session.engineMeta) {
          conversationStore.setEngineSession(
            convId,
            conversationStore.get(convId)?.engineSessionId ?? "",
            data.session.engineMeta as Record<string, unknown>,
          );
        }
        this.emit("session.updated", this.rewriteSessionId(data as any, engineSessionId!, convId) as any);
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
        // Track permission → engine mapping for routing replies
        if (event === "permission.asked" && data?.permission?.id) {
          this.permissionEngineMap.set(data.permission.id, adapter.engineType);
          // Also store sessionId so adapters can resolve correct directory
          const permSid = data?.permission?.sessionId || data?.sessionId;
          if (permSid) this.permissionSessionMap.set(data.permission.id, permSid);
        }
        // Track question → engine mapping for routing replies
        if (event === "question.asked" && data?.question?.id) {
          this.questionEngineMap.set(data.question.id, adapter.engineType);
          // Also store sessionId so adapters can resolve correct directory
          const qSid = data?.question?.sessionId || data?.sessionId;
          if (qSid) this.questionSessionMap.set(data.question.id, qSid);
        }

        // Rewrite sessionId if applicable
        const engineSessionId =
          data?.sessionId || data?.session?.id || data?.permission?.sessionId || data?.question?.sessionId;
        if (engineSessionId) {
          const convId = this.resolveConversationId(engineSessionId);
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

  /**
   * Persist a UnifiedMessage to ConversationStore.
   * Splits content parts (text/file) into ConversationMessage and step parts into StepsFile.
   * Only persists completed assistant messages (those with time.completed).
   * User messages are persisted separately in persistUserMessage().
   */
  private async persistMessage(conversationId: string, message: UnifiedMessage): Promise<void> {
    // User messages are handled in persistUserMessage() to avoid duplicates
    if (message.role === "user") return;

    const isCompleted = !!message.time.completed;
    if (!isCompleted) return; // Skip incomplete assistant messages (initial empty emit)

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
      const bufferedContent = this.contentPartsBuffer.get(message.id) || [];
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
        parts: contentParts,
        tokens: message.tokens,
        cost: message.cost,
        costUnit: message.costUnit,
        modelId: message.modelId,
        error: message.error,
      };

      // Check if message already exists
      const existingMessages = await conversationStore.listMessages(conversationId);
      const existingIdx = existingMessages.findIndex((m) => m.id === message.id);

      if (existingIdx >= 0) {
        await conversationStore.updateMessage(conversationId, message.id, convMessage);
      } else {
        await conversationStore.appendMessage(conversationId, convMessage);
      }

      // Merge buffered step parts with any steps from the message itself
      const bufferedSteps = this.stepPartsBuffer.get(message.id) || [];
      const allSteps = [...stepParts];
      for (const bp of bufferedSteps) {
        if (!allSteps.some((s) => s.id === bp.id)) {
          const rewritten = bp.sessionId !== conversationId
            ? { ...bp, sessionId: conversationId }
            : bp;
          allSteps.push(rewritten);
        }
      }

      if (allSteps.length > 0) {
        await conversationStore.saveSteps(conversationId, message.id, allSteps);
      }

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

  /**
   * Incrementally persist dirty step buffers to disk.
   * Ensures a placeholder assistant message exists so that steps are
   * discoverable via listMessages() even if the message never completes.
   */
  private async flushDirtySteps(): Promise<void> {
    const toFlush = [...this.dirtySteps];
    this.dirtySteps.clear();

    for (const messageId of toFlush) {
      const convId = this.messageConvMap.get(messageId);
      if (!convId) continue;

      const steps = this.stepPartsBuffer.get(messageId);
      if (!steps || steps.length === 0) continue;

      try {
        // Ensure placeholder assistant message exists (once per message)
        if (!this.persistedPlaceholders.has(messageId)) {
          await conversationStore.ensureMessage(convId, {
            id: messageId,
            role: "assistant",
            time: { created: Date.now() },
            parts: [],
          });
          this.persistedPlaceholders.add(messageId);
        }

        // Rewrite sessionId in steps to use conversationId before persisting
        const rewrittenSteps = steps.map((s) =>
          s.sessionId !== convId ? { ...s, sessionId: convId } : s,
        );
        await conversationStore.saveSteps(convId, messageId, [...rewrittenSteps]);
      } catch (err) {
        engineManagerLog.error(`Failed to flush steps for ${messageId}:`, err);
        // Re-add to dirty set for retry on next schedule
        this.dirtySteps.add(messageId);
      }
    }
  }

  /**
   * Persist a user message from sendMessage() content.
   * Called before adapter.sendMessage() to ensure user messages are saved
   * even if the adapter doesn't emit user message events (e.g., OpenCode).
   */
  private async persistUserMessage(conversationId: string, content: MessagePromptContent[]): Promise<void> {
    try {
      const now = Date.now();
      const msgId = timeId("msg");

      // Build parts from prompt content (text + image placeholders)
      const parts: Array<TextPart> = [];
      let partIdx = 0;
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
          // Store image as a text placeholder — base64 data is not persisted
          // to avoid bloating conversation files
          parts.push({
            type: "text" as const,
            id: `${msgId}_p${partIdx++}`,
            messageId: msgId,
            sessionId: conversationId,
            text: `[Image: ${c.mimeType ?? "image"}]`,
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

      await conversationStore.appendMessage(conversationId, convMessage);

      engineManagerLog.debug(
        `Persisted user message ${msgId} to conversation ${conversationId}: ${parts.length} parts`,
      );
    } catch (err) {
      engineManagerLog.error(`Failed to persist user message for conversation ${conversationId}:`, err);
    }
  }

  // --- Project-Engine Bindings ---

  setProjectEngine(directory: string, engineType: EngineType): void {
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
      this.projectBindings.set(normalizeDir(dir), engine);
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
    const saved = getDefaultEngineFromSettings();
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

  // --- Sessions (backed by ConversationStore) ---

  async listSessions(engineTypeOrDirectory: string): Promise<UnifiedSession[]> {
    if (this.adapters.has(engineTypeOrDirectory as EngineType)) {
      // List all conversations for this engine type
      const convs = conversationStore.list({ engineType: engineTypeOrDirectory as EngineType });
      // Register all for routing
      for (const conv of convs) {
        this.sessionEngineMap.set(conv.id, conv.engineType);
      }
      return convs.map(convToSession);
    } else {
      // List conversations for a specific directory
      const convs = conversationStore.list({ directory: engineTypeOrDirectory });
      for (const conv of convs) {
        this.sessionEngineMap.set(conv.id, conv.engineType);
      }
      return convs.map(convToSession);
    }
  }

  async createSession(
    engineType: EngineType | undefined,
    directory: string,
    worktreeId?: string,
  ): Promise<UnifiedSession> {
    const resolvedType = engineType || this.getDefaultEngineType();
    const adapter = this.getAdapterOrThrow(resolvedType); // Validate engine exists

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

    const conv = conversationStore.create({
      engineType: resolvedType,
      directory: sessionDir,
      worktreeId,
      // Remember the original repo directory so worktree sessions group under the right project
      parentDirectory: worktreeId ? directory : undefined,
    });
    this.sessionEngineMap.set(conv.id, resolvedType);

    // Create the engine session immediately (not lazily on first sendMessage).
    // This ensures that engine-specific initialization (like fetching Copilot skills
    // or Claude V2 session init) happens at session creation time, so features
    // like slash command autocomplete work before the user sends a message.
    try {
      const engineSession = await adapter.createSession(conv.directory, conv.engineMeta);
      conversationStore.setEngineSession(conv.id, engineSession.id, engineSession.engineMeta);
      this.engineToConvMap.set(engineSession.id, conv.id);
    } catch (err) {
      // Clean up the orphaned conversation if engine session creation fails
      this.sessionEngineMap.delete(conv.id);
      conversationStore.delete(conv.id);
      throw err;
    }

    const session = convToSession(conv);
    // Broadcast to all connected clients (e.g., UI) so session lists update in real-time
    this.emit("session.created", { session });
    return session;
  }

  async getSession(sessionId: string): Promise<UnifiedSession | null> {
    const conv = conversationStore.get(sessionId);
    return conv ? convToSession(conv) : null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const conv = conversationStore.get(sessionId);
    if (!conv) return;

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
        const adapter = this.adapters.get(conv.engineType);
        if (adapter) {
          await adapter.deleteSession(conv.engineSessionId);
        }
      } catch {
        // Engine cleanup is best-effort
      }
      this.engineToConvMap.delete(conv.engineSessionId);
    }

    await conversationStore.delete(sessionId);
    this.sessionEngineMap.delete(sessionId);
  }

  /**
   * Delete a project and all its conversations.
   * Cleans up engine sessions best-effort, then removes conversations from store.
   */
  async deleteProject(projectId: string): Promise<void> {
    const allConvs = conversationStore.list();
    const projectConvs = allConvs.filter((conv) => {
      const derived = `dir-${normalizeDir(conv.directory)}`;
      return derived === projectId;
    });

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
          const adapter = this.adapters.get(conv.engineType);
          if (adapter) {
            await adapter.deleteSession(conv.engineSessionId);
          }
        } catch (err) {
          engineManagerLog.warn(`Failed to delete engine session for ${conv.id} during project delete:`, err);
        }
        this.engineToConvMap.delete(conv.engineSessionId);
      }
      await conversationStore.delete(conv.id);
      this.sessionEngineMap.delete(conv.id);
    }
  }

  async renameSession(sessionId: string, title: string): Promise<{ success: boolean }> {
    conversationStore.rename(sessionId, title);
    return { success: true };
  }

  // --- Messages ---

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: { mode?: string; modelId?: string },
  ): Promise<UnifiedMessage> {
    this.activeSessions.add(sessionId);
    try {
    const conv = conversationStore.get(sessionId);
    if (!conv) throw new Error(`Conversation not found: ${sessionId}`);

    const adapter = this.getAdapterForSession(sessionId);

    // Lazy engine session creation: first sendMessage triggers adapter.createSession()
    // Also re-create if the adapter lost track of the session (e.g. after app restart,
    // the persisted engineSessionId refers to a cs_ ID that only existed in runtime memory).
    let engineSessionId = conv.engineSessionId;
    if (!engineSessionId || !adapter.hasSession(engineSessionId)) {
      const engineSession = await adapter.createSession(conv.directory, conv.engineMeta);
      engineSessionId = engineSession.id;
      conversationStore.setEngineSession(sessionId, engineSessionId, engineSession.engineMeta);
    }

    // Cache the engineSessionId → conversationId mapping
    this.engineToConvMap.set(engineSessionId, sessionId);

    // Title fallback: derive title from first user message if still default.
    // Run BEFORE persistUserMessage — appendMessage has its own auto-title
    // logic that silently sets conv.title without emitting session.updated,
    // which would cause applyTitleFallback to skip (title no longer default).
    // Run BEFORE adapter.sendMessage so the sidebar updates immediately,
    // not after the (potentially long-running) engine processing completes.
    this.applyTitleFallback(sessionId, content);

    // Persist user message before sending to engine
    // (Some adapters like OpenCode don't emit user message events)
    await this.persistUserMessage(sessionId, content);

    const result = await adapter.sendMessage(engineSessionId, content, {
      ...options,
      directory: conv.directory,
    });

    // If the engine reported a stale session (no SSE response within timeout),
    // clear the engineSessionId so the next attempt creates a fresh session.
    if (result.staleSession) {
      engineManagerLog.warn(`Stale session detected for ${sessionId}, clearing engineSessionId`);
      conversationStore.clearEngineSession(sessionId);
      this.engineToConvMap.delete(engineSessionId);
    }

    return result;
    } finally {
      this.activeSessions.delete(sessionId);
    }
  }

  /** Check if a session is idle (not actively processing a message) */
  isSessionIdle(sessionId: string): boolean {
    return !this.activeSessions.has(sessionId);
  }

  async cancelMessage(sessionId: string): Promise<void> {
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

  /**
   * If a conversation still has no meaningful title (empty, or matches default
   * pattern), set it to the first user message text (truncated to 100 chars).
   */
  private applyTitleFallback(
    sessionId: string,
    content: MessagePromptContent[],
  ): void {
    const conv = conversationStore.get(sessionId);
    if (!conv) return;

    // Already has a real title — nothing to do
    if (conv.title && !this.isDefaultTitle(conv.title)) return;

    // Extract first text from the user prompt
    const firstText = content.find((c) => c.type === "text" && c.text)?.text;
    if (!firstText) return;

    const maxLen = 100;
    const title =
      firstText.length > maxLen
        ? firstText.slice(0, maxLen).trimEnd() + "…"
        : firstText;
    conversationStore.rename(sessionId, title);
    this.emit("session.updated", { session: convToSession(conversationStore.get(sessionId)!) });
  }

  private isDefaultTitle(title: string): boolean {
    // Match engine-generated default titles and ConversationStore's "Chat M-D HH:MM" format
    return /^(New session|New Chat|Child session|Chat \d)/.test(title);
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    const messages = await conversationStore.listMessages(sessionId);
    const stepsFile = await conversationStore.getAllSteps(sessionId);
    // Backfill costUnit for legacy Copilot data (cost stored without unit)
    const engineType = this.sessionEngineMap.get(sessionId);

    return messages.map((msg) => {
      // Content parts only — steps are lazy-loaded via getMessageSteps()
      const stepCount = (stepsFile?.messages[msg.id] ?? []).length;
      // Legacy Copilot messages have cost but no costUnit
      const costUnit = msg.costUnit ?? (msg.cost != null && engineType === "copilot" ? "premium_requests" : undefined);

      return {
        id: msg.id,
        sessionId,
        role: msg.role,
        time: msg.time,
        parts: msg.parts as UnifiedPart[],
        stepCount,
        tokens: msg.tokens,
        cost: msg.cost,
        costUnit,
        modelId: msg.modelId,
        error: msg.error,
      };
    });
  }

  async getMessageSteps(sessionId: string, messageId: string): Promise<UnifiedPart[]> {
    return await conversationStore.getSteps(sessionId, messageId);
  }

  // --- Slash Commands ---

  async listCommands(engineType: EngineType, sessionId?: string): Promise<EngineCommand[]> {
    const adapter = this.adapters.get(engineType);
    if (!adapter) return [];

    if (sessionId) {
      const conv = conversationStore.get(sessionId);
      return adapter.listCommands(conv?.engineSessionId ?? undefined, conv?.directory);
    }

    return adapter.listCommands();
  }

  async invokeCommand(
    sessionId: string,
    commandName: string,
    args: string,
    options?: { mode?: string; modelId?: string },
  ): Promise<CommandInvokeResult> {
    const conv = conversationStore.get(sessionId);
    if (!conv) throw new Error(`Conversation not found: ${sessionId}`);

    const adapter = this.getAdapterForSession(sessionId);

    // Lazy engine session creation (same pattern as sendMessage)
    let engineSessionId = conv.engineSessionId;
    if (!engineSessionId || !adapter.hasSession(engineSessionId)) {
      const engineSession = await adapter.createSession(conv.directory, conv.engineMeta);
      engineSessionId = engineSession.id;
      conversationStore.setEngineSession(sessionId, engineSessionId, engineSession.engineMeta);
    }
    this.engineToConvMap.set(engineSessionId, sessionId);

    // Persist user command message
    const commandText = `/${commandName}${args ? ` ${args}` : ""}`;
    this.applyTitleFallback(sessionId, [{ type: "text", text: commandText }]);
    await this.persistUserMessage(sessionId, [{ type: "text", text: commandText }]);

    const result = await adapter.invokeCommand(
      engineSessionId,
      commandName,
      args,
      { ...options, directory: conv.directory },
    );

    // If the adapter couldn't handle it, fall back to sendMessage
    if (!result.handledAsCommand) {
      const message = await adapter.sendMessage(
        engineSessionId,
        [{ type: "text", text: commandText }],
        { ...options, directory: conv.directory },
      );
      return { handledAsCommand: false, message };
    }

    return result;
  }

  // --- Models ---

  async listModels(engineType: EngineType): Promise<ModelListResult> {
    const adapter = this.getAdapterOrThrow(engineType);
    return adapter.listModels();
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const conv = conversationStore.get(sessionId);
    if (!conv?.engineSessionId) {
      throw new Error(`No engine session for conversation: ${sessionId}`);
    }
    const adapter = this.getAdapterForSession(sessionId);
    return adapter.setModel(conv.engineSessionId, modelId);
  }

  // --- Modes ---

  getModes(engineType: EngineType): AgentMode[] {
    const adapter = this.getAdapterOrThrow(engineType);
    return adapter.getModes();
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const conv = conversationStore.get(sessionId);
    if (!conv?.engineSessionId) {
      throw new Error(`No engine session for conversation: ${sessionId}`);
    }
    const adapter = this.getAdapterForSession(sessionId);
    return adapter.setMode(conv.engineSessionId, modeId);
  }

  // --- Permissions ---

  async replyPermission(
    permissionId: string,
    reply: PermissionReply,
  ): Promise<void> {
    // Look up engine by permissionId (registered when permission.asked was emitted)
    const engineType = this.permissionEngineMap.get(permissionId);
    if (!engineType) {
      throw new Error(`No engine binding found for permission: ${permissionId}`);
    }
    const adapter = this.getAdapterOrThrow(engineType);
    // Resolve the sessionId so the adapter can use the correct directory context
    const sessionId = this.permissionSessionMap.get(permissionId);
    this.permissionEngineMap.delete(permissionId);
    this.permissionSessionMap.delete(permissionId);
    return adapter.replyPermission(permissionId, reply, sessionId);
  }

  // --- Questions ---

  async replyQuestion(
    questionId: string,
    answers: string[][],
  ): Promise<void> {
    const engineType = this.questionEngineMap.get(questionId);
    if (!engineType) {
      throw new Error(`No engine binding found for question: ${questionId}`);
    }
    const adapter = this.getAdapterOrThrow(engineType);
    // Resolve the sessionId so the adapter can use the correct directory context
    const sessionId = this.questionSessionMap.get(questionId);
    this.questionEngineMap.delete(questionId);
    this.questionSessionMap.delete(questionId);
    return adapter.replyQuestion(questionId, answers, sessionId);
  }

  async rejectQuestion(
    questionId: string,
  ): Promise<void> {
    const engineType = this.questionEngineMap.get(questionId);
    if (!engineType) {
      throw new Error(`No engine binding found for question: ${questionId}`);
    }
    const adapter = this.getAdapterOrThrow(engineType);
    const sessionId = this.questionSessionMap.get(questionId);
    this.questionEngineMap.delete(questionId);
    this.questionSessionMap.delete(questionId);
    return adapter.rejectQuestion(questionId, sessionId);
  }

  // --- Projects ---

  async listProjects(engineType: EngineType): Promise<UnifiedProject[]> {
    // Derive projects from conversations for this engine type
    return conversationStore.deriveProjects().filter(p => p.engineType === engineType);
  }

  // --- Session Registration (for adapters that load existing sessions) ---

  registerSession(sessionId: string, engineType: EngineType): void {
    this.sessionEngineMap.set(sessionId, engineType);
  }

  // --- ConversationStore Integration ---

  /**
   * Rebuild routing tables from ConversationStore data.
   * Called once at startup, after conversationStore.init().
   */
  initFromStore(): void {
    for (const conv of conversationStore.list()) {
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
    return conversationStore.list().map(convToSession);
  }

  /** Return all projects derived from conversations, always including the default workspace */
  listAllProjects(): UnifiedProject[] {
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
    return projects;
  }

  // --- Historical Session Import ---

  /**
   * Preview importable sessions from an engine.
   * Returns all historical sessions with dedup flags marking already-imported ones.
   */
  async importPreview(engineType: EngineType, limit: number): Promise<ImportableSession[]> {
    const adapter = this.getAdapterOrThrow(engineType);
    const sessions = await adapter.listHistoricalSessions(limit);

    // Build dedup set: all known engine session IDs for this engine type
    const existingIds = conversationStore.findAllEngineSessionIds(engineType);

    for (const s of sessions) {
      // Check both the direct engine session ID and any nested IDs (e.g. Claude's ccSessionId)
      const ccId = s.engineMeta?.ccSessionId;
      s.alreadyImported =
        existingIds.has(s.engineSessionId) ||
        (typeof ccId === "string" && existingIds.has(ccId));
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
    const adapter = this.getAdapterOrThrow(engineType);

    const result: SessionImportResult = { imported: 0, skipped: 0, errors: [] };
    const total = sessions.length;

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];

      // If already imported, delete the old CodeMux conversation to allow reimport.
      // Only deletes local ConversationStore data — does NOT touch the engine session.
      const ccId = s.engineMeta?.ccSessionId;
      const existingConv = this.findImportedConversation(engineType, s.engineSessionId, ccId);
      if (existingConv) {
        engineManagerLog.info(`Reimporting: deleting old conversation ${existingConv.id} for engine session ${s.engineSessionId}`);
        await conversationStore.delete(existingConv.id);
        this.sessionEngineMap.delete(existingConv.id);
        if (existingConv.engineSessionId) {
          this.engineToConvMap.delete(existingConv.engineSessionId);
        }
      }

      try {
        // Fetch messages from engine
        const messages = await adapter.getHistoricalMessages(
          s.engineSessionId,
          s.directory,
          s.engineMeta,
        );

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
            error: msg.error,
          });

          if (stepParts.length > 0) {
            allSteps[msg.id] = stepParts;
          }
        }

        // Determine the engineSessionId to store
        // For Claude: store the cc_ prefixed ID, and keep ccSessionId in engineMeta
        const storedEngineSessionId = s.engineSessionId;

        const conv = await conversationStore.importConversation({
          engineType,
          directory: s.directory,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          engineSessionId: storedEngineSessionId,
          engineMeta: s.engineMeta,
          messages: convMessages,
          steps: allSteps,
        });

        // Register in routing tables
        this.sessionEngineMap.set(conv.id, engineType);
        this.engineToConvMap.set(storedEngineSessionId, conv.id);

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
      if (!conv.imported) continue;
      if (conv.engineSessionId === engineSessionId) return conv;
      if (typeof ccSessionId === "string" && conv.engineMeta?.ccSessionId === ccSessionId) return conv;
    }
    return null;
  }
}
