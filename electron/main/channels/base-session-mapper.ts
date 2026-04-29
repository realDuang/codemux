// ============================================================================
// BaseSessionMapper — Reusable state management for channel adapters
// Extracts common patterns from FeishuSessionMapper.
// Each channel adapter extends this with platform-specific fields.
// ============================================================================

import fs from "fs";
import path from "path";
import { app } from "electron";
import type { EngineType, UnifiedProject, UnifiedSession } from "../../../src/types/unified";
import type { StreamingSession } from "./streaming/streaming-types";
import { channelLog } from "../services/logger";

// --- Base Types (platform-agnostic) ---

/** Base group binding — maps a platform chat to a CodeMux session */
export interface BaseGroupBinding {
  /** Platform-specific chat/group ID */
  chatId: string;
  /** Bound CodeMux conversation ID */
  conversationId: string;
  /** Engine type for this session */
  engineType: EngineType;
  /** Project directory */
  directory: string;
  /** Project ID */
  projectId: string;
  /** Map of CodeMux messageId → StreamingSession */
  streamingSessions: Map<string, StreamingSession>;
  /** Timestamp when binding was created */
  createdAt: number;
}

/** Base P2P chat state */
export interface BaseP2PChatState {
  chatId: string;
  /** Platform-specific user ID */
  userId: string;
  /** Last selected project (for UX continuity) */
  lastSelectedProject?: {
    directory: string;
    engineType?: EngineType;
    projectId: string;
  };
  /** Pending selection state */
  pendingSelection?: BasePendingSelection;
  /** Temporary session for direct P2P interaction */
  tempSession?: BaseTempSession;
}

/** Temporary session bound to P2P chat */
export interface BaseTempSession {
  conversationId: string;
  engineType: EngineType;
  directory: string;
  projectId: string;
  lastActiveAt: number;
  streamingSession?: StreamingSession;
  messageQueue: string[];
  processing: boolean;
}

/** Pending selection context */
export interface BasePendingSelection {
  type: "project" | "session";
  projects?: UnifiedProject[];
  sessions?: UnifiedSession[];
  engineType?: EngineType;
  directory?: string;
  projectId?: string;
  projectName?: string;
}

/** Pending question state */
export interface BasePendingQuestion {
  questionId: string;
  sessionId: string;
}

/**
 * Serializable group binding for disk persistence.
 * Subclasses can extend this to persist additional fields.
 */
export interface PersistedBinding {
  chatId: string;
  conversationId: string;
  engineType: string;
  directory: string;
  projectId: string;
  createdAt: number;
  [key: string]: unknown;
}

// --- BaseSessionMapper ---

/**
 * Reusable session mapper base class.
 * Manages group bindings, P2P state, deduplication, and concurrency guards.
 *
 * @template B - Group binding type (extends BaseGroupBinding)
 * @template P - P2P chat state type (extends BaseP2PChatState)
 */
export class BaseSessionMapper<
  B extends BaseGroupBinding = BaseGroupBinding,
  P extends BaseP2PChatState = BaseP2PChatState,
> {
  // --- Group Bindings ---
  protected groupBindings = new Map<string, B>();
  protected conversationToGroupIndex = new Map<string, string>();

  // --- P2P Chat State ---
  protected p2pChats = new Map<string, P>();
  protected userIdToChatIndex = new Map<string, string>();

  // --- Temp session reverse index ---
  protected tempConversationToChat = new Map<string, string>();

  // --- Deduplication ---
  private processedMessageIds = new Set<string>();
  private readonly maxProcessedIds: number;

  // --- Concurrency Guard ---
  private creatingGroups = new Set<string>();

  // --- Pending Questions ---
  private pendingQuestions = new Map<string, BasePendingQuestion>();

  // --- Standalone Pending Selections (for non-P2P chats like group chats) ---
  private standalonePendingSelections = new Map<string, BasePendingSelection>();

  // --- Persistence ---
  private readonly channelType: string;
  private readonly bindingsFileName: string;

  constructor(channelType: string, options?: { maxProcessedIds?: number }) {
    this.channelType = channelType;
    this.bindingsFileName = `${channelType}-bindings.json`;
    this.maxProcessedIds = options?.maxProcessedIds ?? 1000;
  }

  // =========================================================================
  // Persistence
  // =========================================================================

  private getBindingsFilePath(): string {
    const dir = path.join(app.getPath("userData"), "channels");
    return path.join(dir, this.bindingsFileName);
  }

  /** Convert a persisted binding to a runtime binding. Override for custom fields. */
  protected deserializeBinding(item: PersistedBinding): B {
    return {
      chatId: item.chatId,
      conversationId: item.conversationId,
      engineType: item.engineType as EngineType,
      directory: item.directory,
      projectId: item.projectId,
      streamingSessions: new Map(),
      createdAt: item.createdAt,
    } as B;
  }

  /** Convert a runtime binding to a persisted binding. Override for custom fields. */
  protected serializeBinding(binding: B): PersistedBinding {
    return {
      chatId: binding.chatId,
      conversationId: binding.conversationId,
      engineType: binding.engineType,
      directory: binding.directory,
      projectId: binding.projectId,
      createdAt: binding.createdAt,
    };
  }

  /** Load persisted bindings from disk */
  loadBindings(): void {
    const filePath = this.getBindingsFilePath();
    if (!fs.existsSync(filePath)) return;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const items: PersistedBinding[] = JSON.parse(raw);
      for (const item of items) {
        const binding = this.deserializeBinding(item);
        this.groupBindings.set(binding.chatId, binding);
        this.conversationToGroupIndex.set(binding.conversationId, binding.chatId);
      }
      channelLog.info(`[${this.channelType}] Loaded ${items.length} persisted group bindings`);
    } catch (err) {
      channelLog.error(`[${this.channelType}] Failed to load group bindings:`, err);
    }
  }

  /** Persist current bindings to disk */
  protected saveBindings(): void {
    const filePath = this.getBindingsFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const items = Array.from(this.groupBindings.values()).map((b) => this.serializeBinding(b));
    try {
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(items, null, 2));
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      channelLog.error(`[${this.channelType}] Failed to save group bindings:`, err);
    }
  }

  // =========================================================================
  // Group Binding Methods
  // =========================================================================

  createGroupBinding(binding: B): void {
    this.groupBindings.set(binding.chatId, binding);
    this.conversationToGroupIndex.set(binding.conversationId, binding.chatId);
    this.saveBindings();
    channelLog.info(
      `[${this.channelType}] Created group binding: chat=${binding.chatId} → conversation=${binding.conversationId}`,
    );
  }

  getGroupBinding(groupChatId: string): B | undefined {
    return this.groupBindings.get(groupChatId);
  }

  findGroupByConversationId(conversationId: string): B | undefined {
    const chatId = this.conversationToGroupIndex.get(conversationId);
    return chatId ? this.groupBindings.get(chatId) : undefined;
  }

  isGroupChat(chatId: string): boolean {
    return this.groupBindings.has(chatId);
  }

  hasGroupForConversation(conversationId: string): boolean {
    return this.conversationToGroupIndex.has(conversationId);
  }

  removeGroupBinding(groupChatId: string): B | undefined {
    const binding = this.groupBindings.get(groupChatId);
    if (!binding) return undefined;
    for (const session of binding.streamingSessions.values()) {
      if (session.patchTimer) {
        clearTimeout(session.patchTimer);
        session.patchTimer = null;
      }
    }
    binding.streamingSessions.clear();
    this.conversationToGroupIndex.delete(binding.conversationId);
    this.groupBindings.delete(groupChatId);
    this.saveBindings();
    channelLog.info(`[${this.channelType}] Removed group binding: chat=${groupChatId}`);
    return binding;
  }

  // =========================================================================
  // Concurrency Guard
  // =========================================================================

  markCreating(conversationId: string): boolean {
    if (this.creatingGroups.has(conversationId)) return false;
    this.creatingGroups.add(conversationId);
    return true;
  }

  unmarkCreating(conversationId: string): void {
    this.creatingGroups.delete(conversationId);
  }

  // =========================================================================
  // P2P Chat State
  // =========================================================================

  getOrCreateP2PChat(chatId: string, userId: string): P {
    let state = this.p2pChats.get(chatId);
    if (!state) {
      state = { chatId, userId } as P;
      this.p2pChats.set(chatId, state);
    }
    return state;
  }

  getP2PChat(chatId: string): P | undefined {
    return this.p2pChats.get(chatId);
  }

  setP2PLastProject(
    chatId: string,
    project: { directory: string; engineType?: EngineType; projectId: string },
  ): void {
    const state = this.p2pChats.get(chatId);
    if (state) {
      state.lastSelectedProject = project;
    }
  }

  setPendingSelection(chatId: string, selection: BasePendingSelection): void {
    const state = this.p2pChats.get(chatId);
    if (state) {
      state.pendingSelection = selection;
    } else {
      this.standalonePendingSelections.set(chatId, selection);
    }
  }

  getPendingSelection(chatId: string): BasePendingSelection | undefined {
    return this.p2pChats.get(chatId)?.pendingSelection
      ?? this.standalonePendingSelections.get(chatId);
  }

  clearPendingSelection(chatId: string): void {
    const state = this.p2pChats.get(chatId);
    if (state) {
      state.pendingSelection = undefined;
    }
    this.standalonePendingSelections.delete(chatId);
  }

  // =========================================================================
  // User ID Mapping (for bot menu events / platform-specific routing)
  // =========================================================================

  setUserIdMapping(userId: string, chatId: string): void {
    this.userIdToChatIndex.set(userId, chatId);
  }

  getChatIdByUserId(userId: string): string | undefined {
    return this.userIdToChatIndex.get(userId);
  }

  // =========================================================================
  // Streaming Sessions
  // =========================================================================

  registerStreamingSession(
    groupChatId: string,
    messageId: string,
    session: StreamingSession,
  ): void {
    const binding = this.groupBindings.get(groupChatId);
    if (binding) {
      binding.streamingSessions.set(messageId, session);
    }
  }

  getStreamingSession(conversationId: string, messageId: string): StreamingSession | undefined {
    const binding = this.findGroupByConversationId(conversationId);
    return binding?.streamingSessions.get(messageId);
  }

  removeStreamingSession(conversationId: string, messageId: string): void {
    const binding = this.findGroupByConversationId(conversationId);
    if (binding) {
      const session = binding.streamingSessions.get(messageId);
      if (session?.patchTimer) clearTimeout(session.patchTimer);
      binding.streamingSessions.delete(messageId);
    }
  }

  // =========================================================================
  // Temp Sessions
  // =========================================================================

  setTempSession(chatId: string, tempSession: BaseTempSession): void {
    const state = this.p2pChats.get(chatId);
    if (state) {
      if (state.tempSession) {
        this.tempConversationToChat.delete(state.tempSession.conversationId);
      }
      state.tempSession = tempSession;
      this.tempConversationToChat.set(tempSession.conversationId, chatId);
    }
  }

  getTempSession(chatId: string): BaseTempSession | undefined {
    return this.p2pChats.get(chatId)?.tempSession;
  }

  clearTempSession(chatId: string): void {
    const state = this.p2pChats.get(chatId);
    if (state?.tempSession) {
      if (state.tempSession.streamingSession?.patchTimer) {
        clearTimeout(state.tempSession.streamingSession.patchTimer);
      }
      this.tempConversationToChat.delete(state.tempSession.conversationId);
      state.tempSession = undefined;
    }
  }

  findP2PChatByTempConversation(conversationId: string): string | undefined {
    return this.tempConversationToChat.get(conversationId);
  }

  // =========================================================================
  // Pending Questions
  // =========================================================================

  setPendingQuestion(chatId: string, question: BasePendingQuestion): void {
    this.pendingQuestions.set(chatId, question);
  }

  getPendingQuestion(chatId: string): BasePendingQuestion | undefined {
    return this.pendingQuestions.get(chatId);
  }

  clearPendingQuestion(chatId: string): void {
    this.pendingQuestions.delete(chatId);
  }

  // =========================================================================
  // Deduplication
  // =========================================================================

  isDuplicate(messageId: string): boolean {
    if (this.processedMessageIds.has(messageId)) return true;
    if (this.processedMessageIds.size >= this.maxProcessedIds) {
      const first = this.processedMessageIds.values().next().value;
      if (first) this.processedMessageIds.delete(first);
    }
    this.processedMessageIds.add(messageId);
    return false;
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  cleanup(): void {
    for (const binding of this.groupBindings.values()) {
      for (const session of binding.streamingSessions.values()) {
        if (session.patchTimer) {
          clearTimeout(session.patchTimer);
          session.patchTimer = null;
        }
      }
      binding.streamingSessions.clear();
    }
    for (const state of this.p2pChats.values()) {
      if (state.tempSession?.streamingSession?.patchTimer) {
        clearTimeout(state.tempSession.streamingSession.patchTimer);
        state.tempSession.streamingSession.patchTimer = null;
      }
    }
  }

  /**
   * Drop all in-memory state AND wipe the persisted bindings file.
   * Use when the channel needs to fully forget its tenant — e.g. iLink logout
   * or token-expiry auto-cleanup. Pending streaming timers are cleared first
   * to avoid leaks, then the bindings JSON is overwritten with an empty list.
   */
  clearAllBindings(): void {
    this.cleanup();
    this.groupBindings.clear();
    this.conversationToGroupIndex.clear();
    this.p2pChats.clear();
    this.userIdToChatIndex.clear();
    this.tempConversationToChat.clear();
    this.processedMessageIds.clear();
    this.creatingGroups.clear();
    this.pendingQuestions.clear();
    this.standalonePendingSelections.clear();
    this.saveBindings();
    channelLog.info(`[${this.channelType}] Cleared all bindings (memory + disk)`);
  }
}
