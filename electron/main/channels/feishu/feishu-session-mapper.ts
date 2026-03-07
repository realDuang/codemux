// ============================================================================
// Feishu Session Mapper
// Maps Feishu group chats to CodeMux sessions (One Group = One Session).
// Manages P2P chat state, streaming sessions, and message deduplication.
// Persists group bindings to disk so they survive app restarts.
// ============================================================================

import fs from "fs";
import path from "path";
import { app } from "electron";
import type { EngineType } from "../../../../src/types/unified";
import type { GroupBinding, P2PChatState, PendingSelection, StreamingSession, TempSession } from "./feishu-types";
import { feishuLog } from "../../services/logger";

// --- Persistence helpers ---

/** Serializable subset of GroupBinding (excludes runtime-only fields) */
interface PersistedGroupBinding {
  chatId: string;
  conversationId: string;
  engineType: string;
  directory: string;
  projectId: string;
  ownerOpenId: string;
  createdAt: number;
}

function getBindingsFilePath(): string {
  const dir = app.isPackaged
    ? path.join(app.getPath("userData"), "channels")
    : path.join(process.cwd(), ".channels");
  return path.join(dir, "feishu-bindings.json");
}

export class FeishuSessionMapper {
  // --- Group Bindings (One Group = One Session) ---

  /** groupChatId → GroupBinding */
  private groupBindings = new Map<string, GroupBinding>();
  /** Reverse index: conversationId → groupChatId */
  private conversationToGroupIndex = new Map<string, string>();

  // --- P2P Chat State ---

  /** p2pChatId → P2PChatState */
  private p2pChats = new Map<string, P2PChatState>();
  /** Reverse index: openId → p2pChatId (for bot menu events) */
  private openIdToChatIndex = new Map<string, string>();

  // --- Deduplication ---

  /** Processed Feishu message IDs for deduplication (LRU-style) */
  private processedMessageIds = new Set<string>();
  private readonly MAX_PROCESSED_IDS = 1000;

  // --- Pending Selection by OpenId (for bot menu events before first P2P message) ---

  /** openId → PendingSelection (temporary, transferred to P2P chat on first message) */
  private pendingSelectionByOpenId = new Map<string, PendingSelection>();

  // --- Concurrency Guard ---

  /** Conversation IDs currently being created (prevents duplicate group creation) */
  private creatingGroups = new Set<string>();

  /** Reverse index: conversationId → p2pChatId (for temp session notification routing) */
  private tempConversationToChat = new Map<string, string>();

  // =========================================================================
  // Persistence — load / save group bindings to disk
  // =========================================================================

  /** Load persisted group bindings from disk (call once at startup) */
  loadBindings(): void {
    const filePath = getBindingsFilePath();
    if (!fs.existsSync(filePath)) return;

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const items: PersistedGroupBinding[] = JSON.parse(raw);
      for (const item of items) {
        const binding: GroupBinding = {
          chatId: item.chatId,
          conversationId: item.conversationId,
          engineType: item.engineType as EngineType,
          directory: item.directory,
          projectId: item.projectId,
          ownerOpenId: item.ownerOpenId,
          streamingSessions: new Map(),
          createdAt: item.createdAt,
        };
        this.groupBindings.set(binding.chatId, binding);
        this.conversationToGroupIndex.set(binding.conversationId, binding.chatId);
      }
      feishuLog.info(`Loaded ${items.length} persisted group bindings`);
    } catch (err) {
      feishuLog.error("Failed to load group bindings:", err);
    }
  }

  /** Persist current group bindings to disk */
  private saveBindings(): void {
    const filePath = getBindingsFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const items: PersistedGroupBinding[] = [];
    for (const b of this.groupBindings.values()) {
      items.push({
        chatId: b.chatId,
        conversationId: b.conversationId,
        engineType: b.engineType,
        directory: b.directory,
        projectId: b.projectId,
        ownerOpenId: b.ownerOpenId,
        createdAt: b.createdAt,
      });
    }

    try {
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(items, null, 2));
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      feishuLog.error("Failed to save group bindings:", err);
    }
  }

  // =========================================================================
  // Group Binding Methods
  // =========================================================================

  /** Create a new group binding and update both maps */
  createGroupBinding(binding: GroupBinding): void {
    this.groupBindings.set(binding.chatId, binding);
    this.conversationToGroupIndex.set(binding.conversationId, binding.chatId);
    this.saveBindings();
    feishuLog.info(
      `Created group binding: chat=${binding.chatId} → conversation=${binding.conversationId} (${binding.engineType}:${binding.projectId})`,
    );
  }

  /** Get a group binding by group chat ID */
  getGroupBinding(groupChatId: string): GroupBinding | undefined {
    return this.groupBindings.get(groupChatId);
  }

  /** Find the group binding that owns a given conversation ID */
  findGroupByConversationId(conversationId: string): GroupBinding | undefined {
    const chatId = this.conversationToGroupIndex.get(conversationId);
    return chatId ? this.groupBindings.get(chatId) : undefined;
  }

  /** Find the group chat ID that owns a given conversation ID */
  findGroupChatIdByConversationId(conversationId: string): string | undefined {
    return this.conversationToGroupIndex.get(conversationId);
  }

  /** Check if a chat ID belongs to a bound group chat */
  isGroupChat(chatId: string): boolean {
    return this.groupBindings.has(chatId);
  }

  /** Check if a conversation ID already has a group binding */
  hasGroupForConversation(conversationId: string): boolean {
    return this.conversationToGroupIndex.has(conversationId);
  }

  /** Remove a group binding, clean up streaming timers, and update both maps */
  removeGroupBinding(groupChatId: string): GroupBinding | undefined {
    const binding = this.groupBindings.get(groupChatId);
    if (!binding) {
      return undefined;
    }

    // Clean up all streaming timers in this binding
    for (const session of binding.streamingSessions.values()) {
      if (session.patchTimer) {
        clearTimeout(session.patchTimer);
        session.patchTimer = null;
      }
    }
    binding.streamingSessions.clear();

    // Remove from both maps
    this.conversationToGroupIndex.delete(binding.conversationId);
    this.groupBindings.delete(groupChatId);
    this.saveBindings();

    feishuLog.info(
      `Removed group binding: chat=${groupChatId} (conversation=${binding.conversationId})`,
    );
    return binding;
  }

  // =========================================================================
  // Concurrency Guard Methods
  // =========================================================================

  /**
   * Mark a conversation as currently being created.
   * @returns false if already being created (caller should abort), true otherwise
   */
  markCreating(conversationId: string): boolean {
    if (this.creatingGroups.has(conversationId)) {
      feishuLog.warn(`Conversation ${conversationId} is already being created, skipping`);
      return false;
    }
    this.creatingGroups.add(conversationId);
    return true;
  }

  /** Unmark a conversation as being created (call in finally block) */
  unmarkCreating(conversationId: string): void {
    this.creatingGroups.delete(conversationId);
  }

  // =========================================================================
  // P2P Chat State Methods
  // =========================================================================

  /** Get or create P2P chat state for a direct message chat */
  getOrCreateP2PChat(chatId: string, openId: string): P2PChatState {
    let state = this.p2pChats.get(chatId);
    if (!state) {
      state = { chatId, openId };
      this.p2pChats.set(chatId, state);
      feishuLog.info(`Created P2P chat state: chat=${chatId} openId=${openId}`);
    }
    return state;
  }

  /** Get P2P chat state (returns undefined if not found) */
  getP2PChat(chatId: string): P2PChatState | undefined {
    return this.p2pChats.get(chatId);
  }

  /** Update the last selected project for a P2P chat */
  setP2PLastProject(
    chatId: string,
    project: { directory: string; engineType: EngineType; projectId: string },
  ): void {
    const state = this.p2pChats.get(chatId);
    if (state) {
      state.lastSelectedProject = project;
      feishuLog.info(
        `P2P chat ${chatId} last project: ${project.projectId} (${project.engineType})`,
      );
    }
  }

  /** Set pending selection state for text-based command interaction */
  setPendingSelection(
    chatId: string,
    selection: PendingSelection,
  ): void {
    const state = this.p2pChats.get(chatId);
    if (state) {
      state.pendingSelection = selection;
    }
  }

  /** Get pending selection state */
  getPendingSelection(
    chatId: string,
  ): PendingSelection | undefined {
    return this.p2pChats.get(chatId)?.pendingSelection;
  }

  /** Clear pending selection state */
  clearPendingSelection(chatId: string): void {
    const state = this.p2pChats.get(chatId);
    if (state) {
      state.pendingSelection = undefined;
    }
  }

  // =========================================================================
  // OpenId Mapping Methods
  // =========================================================================

  /** Record the open_id → chat_id mapping (for P2P chats, used by bot menu events) */
  setOpenIdMapping(openId: string, chatId: string): void {
    this.openIdToChatIndex.set(openId, chatId);
  }

  /** Get chat_id by open_id (P2P chat lookup for bot menu events) */
  getChatIdByOpenId(openId: string): string | undefined {
    return this.openIdToChatIndex.get(openId);
  }

  // =========================================================================
  // Pending Selection by OpenId (bot menu before first P2P message)
  // =========================================================================

  /** Store pending selection keyed by openId (when chatId is not yet known) */
  setPendingSelectionByOpenId(openId: string, selection: PendingSelection): void {
    this.pendingSelectionByOpenId.set(openId, selection);
  }

  /** Get and clear pending selection by openId (transfer to chat on first message) */
  takePendingSelectionByOpenId(openId: string): PendingSelection | undefined {
    const selection = this.pendingSelectionByOpenId.get(openId);
    if (selection) {
      this.pendingSelectionByOpenId.delete(openId);
    }
    return selection;
  }

  // =========================================================================
  // Streaming Session Methods
  // =========================================================================

  /** Register a streaming session on a group binding */
  registerStreamingSession(
    groupChatId: string,
    messageId: string,
    session: StreamingSession,
  ): void {
    const binding = this.groupBindings.get(groupChatId);
    if (binding) {
      binding.streamingSessions.set(messageId, session);
    } else {
      feishuLog.warn(
        `Cannot register streaming session: group ${groupChatId} not found`,
      );
    }
  }

  /** Get the streaming session for a CodeMux message (lookup by conversationId) */
  getStreamingSession(conversationId: string, messageId: string): StreamingSession | undefined {
    const binding = this.findGroupByConversationId(conversationId);
    return binding?.streamingSessions.get(messageId);
  }

  /** Remove a completed streaming session and clean up its timer */
  removeStreamingSession(conversationId: string, messageId: string): void {
    const binding = this.findGroupByConversationId(conversationId);
    if (binding) {
      const session = binding.streamingSessions.get(messageId);
      if (session?.patchTimer) {
        clearTimeout(session.patchTimer);
      }
      binding.streamingSessions.delete(messageId);
    }
  }

  // =========================================================================
  // Temp Session Methods (P2P direct interaction, no group)
  // =========================================================================

  /** Set or replace the temp session for a P2P chat */
  setTempSession(chatId: string, tempSession: TempSession): void {
    const state = this.p2pChats.get(chatId);
    if (state) {
      // Remove old reverse index if exists
      if (state.tempSession) {
        this.tempConversationToChat.delete(state.tempSession.conversationId);
      }
      state.tempSession = tempSession;
      this.tempConversationToChat.set(tempSession.conversationId, chatId);
      feishuLog.info(
        `P2P chat ${chatId} temp session: ${tempSession.conversationId} (${tempSession.engineType})`,
      );
    }
  }

  /** Get the temp session for a P2P chat */
  getTempSession(chatId: string): TempSession | undefined {
    return this.p2pChats.get(chatId)?.tempSession;
  }

  /** Clear the temp session for a P2P chat */
  clearTempSession(chatId: string): void {
    const state = this.p2pChats.get(chatId);
    if (state?.tempSession) {
      // Clean up streaming timer
      if (state.tempSession.streamingSession?.patchTimer) {
        clearTimeout(state.tempSession.streamingSession.patchTimer);
      }
      this.tempConversationToChat.delete(state.tempSession.conversationId);
      state.tempSession = undefined;
      feishuLog.info(`P2P chat ${chatId} temp session cleared`);
    }
  }

  /** Find the P2P chat ID that owns a temp session with the given conversation ID */
  findP2PChatByTempConversation(conversationId: string): string | undefined {
    return this.tempConversationToChat.get(conversationId);
  }

  // =========================================================================
  // Deduplication
  // =========================================================================

  /** Check and record a Feishu message ID for deduplication */
  isDuplicate(feishuMessageId: string): boolean {
    if (this.processedMessageIds.has(feishuMessageId)) {
      return true;
    }

    // LRU eviction: remove oldest entries when limit reached
    if (this.processedMessageIds.size >= this.MAX_PROCESSED_IDS) {
      const first = this.processedMessageIds.values().next().value;
      if (first) this.processedMessageIds.delete(first);
    }

    this.processedMessageIds.add(feishuMessageId);
    return false;
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  /** Clean up all streaming timers across all bindings and temp sessions (for shutdown) */
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
}
