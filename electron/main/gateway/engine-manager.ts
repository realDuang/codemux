// ============================================================================
// Engine Manager — Registry, routing, and project-engine bindings
// ============================================================================

import { EventEmitter } from "events";
import { EngineAdapter, type EngineAdapterEvents } from "../engines/engine-adapter";
import { conversationStore } from "../services/conversation-store";
import { engineManagerLog } from "../services/logger";
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
} from "../../../src/types/unified";

// --- Helpers ---

/** Convert ConversationMeta → UnifiedSession for wire compatibility */
function convToSession(conv: ConversationMeta): UnifiedSession {
  return {
    id: conv.id,
    engineType: conv.engineType,
    directory: conv.directory,
    title: conv.title,
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
  /** engineSessionId → conversationId cache (populated on session creation / lookup) */
  private engineToConvMap = new Map<string, string>();
  /** Accumulate step-type parts during streaming: messageId → UnifiedPart[] */
  private stepPartsBuffer = new Map<string, UnifiedPart[]>();
  /** Accumulate content-type parts (text/file) during streaming: messageId → (TextPart|FilePart)[] */
  private contentPartsBuffer = new Map<string, Array<TextPart | FilePart>>();

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
    const engineType = this.projectBindings.get(directory.replaceAll("\\", "/"));
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
    ];

    for (const event of simpleEvents) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapter.on(event, (data: any) => {
        // Track permission → engine mapping for routing replies
        if (event === "permission.asked" && data?.permission?.id) {
          this.permissionEngineMap.set(data.permission.id, adapter.engineType);
        }
        // Track question → engine mapping for routing replies
        if (event === "question.asked" && data?.question?.id) {
          this.questionEngineMap.set(data.question.id, adapter.engineType);
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
  private persistMessage(conversationId: string, message: UnifiedMessage): void {
    // User messages are handled in persistUserMessage() to avoid duplicates
    if (message.role === "user") return;

    const isCompleted = !!message.time.completed;
    if (!isCompleted) return; // Skip incomplete assistant messages (initial empty emit)

    try {
      // Split parts into content vs steps
      const contentParts: Array<TextPart | FilePart> = [];
      const stepParts: UnifiedPart[] = [];

      for (const part of message.parts || []) {
        if (this.isContentPart(part)) {
          contentParts.push(part);
        } else {
          stepParts.push(part);
        }
      }

      // Merge buffered content parts (text/file sent via part.updated SSE,
      // which are often NOT included in message.updated's parts array).
      const bufferedContent = this.contentPartsBuffer.get(message.id) || [];
      for (const bp of bufferedContent) {
        if (!contentParts.some((p) => p.id === bp.id)) {
          contentParts.push(bp);
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
        modelId: message.modelId,
        error: message.error,
      };

      // Check if message already exists
      const existingMessages = conversationStore.listMessages(conversationId);
      const existingIdx = existingMessages.findIndex((m) => m.id === message.id);

      if (existingIdx >= 0) {
        conversationStore.updateMessage(conversationId, message.id, convMessage);
      } else {
        conversationStore.appendMessage(conversationId, convMessage);
      }

      // Merge buffered step parts with any steps from the message itself
      const bufferedSteps = this.stepPartsBuffer.get(message.id) || [];
      const allSteps = [...stepParts];
      for (const bp of bufferedSteps) {
        if (!allSteps.some((s) => s.id === bp.id)) {
          allSteps.push(bp);
        }
      }

      if (allSteps.length > 0) {
        conversationStore.saveSteps(conversationId, message.id, allSteps);
      }

      // Clean up buffers
      this.stepPartsBuffer.delete(message.id);
      this.contentPartsBuffer.delete(message.id);

      engineManagerLog.debug(
        `Persisted message ${message.id} (${message.role}) to conversation ${conversationId}: ${contentParts.length} content parts, ${allSteps.length} steps`,
      );
    } catch (err) {
      engineManagerLog.error(`Failed to persist message ${message.id}:`, err);
    }
  }

  /**
   * Persist a user message from sendMessage() content.
   * Called before adapter.sendMessage() to ensure user messages are saved
   * even if the adapter doesn't emit user message events (e.g., OpenCode).
   */
  private persistUserMessage(conversationId: string, content: MessagePromptContent[]): void {
    try {
      const now = Date.now();
      const msgId = timeId("msg");

      // Build text parts from prompt content
      const textParts: TextPart[] = content
        .filter((c) => c.type === "text" && c.text)
        .map((c, idx) => ({
          type: "text" as const,
          id: `${msgId}_p${idx}`,
          messageId: msgId,
          sessionId: conversationId,
          text: c.text!,
        }));

      if (textParts.length === 0) return;

      const convMessage: ConversationMessage = {
        id: msgId,
        role: "user",
        time: { created: now, completed: now },
        parts: textParts,
      };

      conversationStore.appendMessage(conversationId, convMessage);

      engineManagerLog.debug(
        `Persisted user message ${msgId} to conversation ${conversationId}: ${textParts.length} text parts`,
      );
    } catch (err) {
      engineManagerLog.error(`Failed to persist user message for conversation ${conversationId}:`, err);
    }
  }

  // --- Project-Engine Bindings ---

  setProjectEngine(directory: string, engineType: EngineType): void {
    this.getAdapterOrThrow(engineType); // Validate engine exists
    this.projectBindings.set(directory.replaceAll("\\", "/"), engineType);
  }

  getProjectEngine(directory: string): EngineType | undefined {
    return this.projectBindings.get(directory.replaceAll("\\", "/"));
  }

  getProjectBindings(): Map<string, EngineType> {
    return new Map(this.projectBindings);
  }

  loadProjectBindings(bindings: Record<string, EngineType>): void {
    for (const [dir, engine] of Object.entries(bindings)) {
      this.projectBindings.set(dir.replaceAll("\\", "/"), engine);
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
    engineType: EngineType,
    directory: string,
  ): Promise<UnifiedSession> {
    this.getAdapterOrThrow(engineType); // Validate engine exists
    const conv = conversationStore.create({ engineType, directory });
    this.sessionEngineMap.set(conv.id, engineType);
    return convToSession(conv);
  }

  async getSession(sessionId: string): Promise<UnifiedSession | null> {
    const conv = conversationStore.get(sessionId);
    return conv ? convToSession(conv) : null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const conv = conversationStore.get(sessionId);
    if (!conv) return;

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
    }

    conversationStore.delete(sessionId);
    this.sessionEngineMap.delete(sessionId);
  }

  /**
   * Delete a project and all its conversations.
   * Cleans up engine sessions best-effort, then removes conversations from store.
   */
  async deleteProject(projectId: string): Promise<void> {
    const allConvs = conversationStore.list();
    const projectConvs = allConvs.filter((conv) => {
      const derived = `${conv.engineType}-${conv.directory.replaceAll("\\", "/")}`;
      return derived === projectId;
    });

    for (const conv of projectConvs) {
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
      }
      conversationStore.delete(conv.id);
      this.sessionEngineMap.delete(conv.id);
    }
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    conversationStore.rename(sessionId, title);
  }

  // --- Messages ---

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: { mode?: string; modelId?: string },
  ): Promise<UnifiedMessage> {
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

    // Persist user message before sending to engine
    // (Some adapters like OpenCode don't emit user message events)
    this.persistUserMessage(sessionId, content);

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

    // Title fallback: derive title from first user message if still default
    this.applyTitleFallback(sessionId, content);

    return result;
  }

  async cancelMessage(sessionId: string): Promise<void> {
    const conv = conversationStore.get(sessionId);
    if (!conv?.engineSessionId) return;
    const adapter = this.getAdapterForSession(sessionId);
    return adapter.cancelMessage(conv.engineSessionId, conv.directory);
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
    // Match old engine-generated default titles and ConversationStore's "Chat M-D HH:MM" format
    return /^(New session|Child session|Chat \d)/.test(title);
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    const messages = conversationStore.listMessages(sessionId);
    const stepsFile = conversationStore.getAllSteps(sessionId);

    return messages.map((msg) => {
      // Merge content parts with step parts for full reconstruction
      const steps = stepsFile?.messages[msg.id] ?? [];
      const allParts: UnifiedPart[] = [...msg.parts, ...steps];
      // Sort by part ID for consistent ordering
      allParts.sort((a, b) => a.id.localeCompare(b.id));

      return {
        id: msg.id,
        sessionId,
        role: msg.role,
        time: msg.time,
        parts: allParts,
        tokens: msg.tokens,
        cost: msg.cost,
        modelId: msg.modelId,
        error: msg.error,
      };
    });
  }

  async getMessageSteps(sessionId: string, messageId: string): Promise<UnifiedPart[]> {
    return conversationStore.getSteps(sessionId, messageId);
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
    this.permissionEngineMap.delete(permissionId);
    return adapter.replyPermission(permissionId, reply);
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
    this.questionEngineMap.delete(questionId);
    return adapter.replyQuestion(questionId, answers);
  }

  async rejectQuestion(
    questionId: string,
  ): Promise<void> {
    const engineType = this.questionEngineMap.get(questionId);
    if (!engineType) {
      throw new Error(`No engine binding found for question: ${questionId}`);
    }
    const adapter = this.getAdapterOrThrow(engineType);
    this.questionEngineMap.delete(questionId);
    return adapter.rejectQuestion(questionId);
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
        const normDir = conv.directory.replaceAll("\\", "/");
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

  /** Return all projects derived from conversations */
  listAllProjects(): UnifiedProject[] {
    return conversationStore.deriveProjects();
  }
}
