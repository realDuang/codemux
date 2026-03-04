// ============================================================================
// Feishu Session Mapper
// Maps Feishu group chats to CodeMux sessions (One Group = One Session).
// Manages P2P chat state, streaming sessions, and message deduplication.
// ============================================================================

import type { EngineType } from "../../../../src/types/unified";
import type { GroupBinding, P2PChatState, PendingSelection, StreamingSession } from "./feishu-types";
import { feishuLog } from "../../services/logger";

export class FeishuSessionMapper {
  // --- Group Bindings (One Group = One Session) ---

  /** groupChatId → GroupBinding */
  private groupBindings = new Map<string, GroupBinding>();
  /** Reverse index: sessionId → groupChatId */
  private sessionToGroupIndex = new Map<string, string>();

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

  /** Session IDs currently being created (prevents duplicate group creation) */
  private creatingGroups = new Set<string>();

  // =========================================================================
  // Group Binding Methods
  // =========================================================================

  /** Create a new group binding and update both maps */
  createGroupBinding(binding: GroupBinding): void {
    this.groupBindings.set(binding.chatId, binding);
    this.sessionToGroupIndex.set(binding.sessionId, binding.chatId);
    feishuLog.info(
      `Created group binding: chat=${binding.chatId} → session=${binding.sessionId} (${binding.engineType}:${binding.projectId})`,
    );
  }

  /** Get a group binding by group chat ID */
  getGroupBinding(groupChatId: string): GroupBinding | undefined {
    return this.groupBindings.get(groupChatId);
  }

  /** Find the group binding that owns a given session ID */
  findGroupBySessionId(sessionId: string): GroupBinding | undefined {
    const chatId = this.sessionToGroupIndex.get(sessionId);
    return chatId ? this.groupBindings.get(chatId) : undefined;
  }

  /** Find the group chat ID that owns a given session ID */
  findGroupChatIdBySessionId(sessionId: string): string | undefined {
    return this.sessionToGroupIndex.get(sessionId);
  }

  /** Check if a chat ID belongs to a bound group chat */
  isGroupChat(chatId: string): boolean {
    return this.groupBindings.has(chatId);
  }

  /** Check if a session ID already has a group binding */
  hasGroupForSession(sessionId: string): boolean {
    return this.sessionToGroupIndex.has(sessionId);
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
    this.sessionToGroupIndex.delete(binding.sessionId);
    this.groupBindings.delete(groupChatId);

    feishuLog.info(
      `Removed group binding: chat=${groupChatId} (session=${binding.sessionId})`,
    );
    return binding;
  }

  // =========================================================================
  // Concurrency Guard Methods
  // =========================================================================

  /**
   * Mark a session as currently being created.
   * @returns false if already being created (caller should abort), true otherwise
   */
  markCreating(sessionId: string): boolean {
    if (this.creatingGroups.has(sessionId)) {
      feishuLog.warn(`Session ${sessionId} is already being created, skipping`);
      return false;
    }
    this.creatingGroups.add(sessionId);
    return true;
  }

  /** Unmark a session as being created (call in finally block) */
  unmarkCreating(sessionId: string): void {
    this.creatingGroups.delete(sessionId);
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

  /** Get the streaming session for a CodeMux message (lookup by sessionId) */
  getStreamingSession(sessionId: string, messageId: string): StreamingSession | undefined {
    const binding = this.findGroupBySessionId(sessionId);
    return binding?.streamingSessions.get(messageId);
  }

  /** Remove a completed streaming session and clean up its timer */
  removeStreamingSession(sessionId: string, messageId: string): void {
    const binding = this.findGroupBySessionId(sessionId);
    if (binding) {
      const session = binding.streamingSessions.get(messageId);
      if (session?.patchTimer) {
        clearTimeout(session.patchTimer);
      }
      binding.streamingSessions.delete(messageId);
    }
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

  /** Clean up all streaming timers across all group bindings (for shutdown) */
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
  }
}
