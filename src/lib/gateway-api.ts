/**
 * Gateway API — Frontend bridge between GatewayClient and SolidJS stores.
 *
 * This module connects to the main-process gateway via WebSocket, subscribes
 * to push notifications, and exposes typed methods for the frontend to use.
 */

import { gatewayClient } from "./gateway-client";
import { logger } from "./logger";
import type {
  EngineType,
  EngineInfo,
  EngineCapabilities,
  UnifiedSession,
  UnifiedMessage,
  UnifiedPart,
  ModelListResult,
  UnifiedProject,
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
} from "../types/unified";

// --- Notification callback types ---

export interface GatewayNotificationHandlers {
  onPartUpdated?: (sessionId: string, part: UnifiedPart) => void;
  onPartsBatch?: (sessionId: string, messageId: string, parts: UnifiedPart[]) => void;
  onMessageUpdated?: (sessionId: string, message: UnifiedMessage) => void;
  onSessionUpdated?: (session: UnifiedSession) => void;
  onSessionCreated?: (session: UnifiedSession) => void;
  onPermissionAsked?: (permission: UnifiedPermission) => void;
  onPermissionReplied?: (permissionId: string, optionId: string) => void;
  onQuestionAsked?: (question: UnifiedQuestion) => void;
  onQuestionReplied?: (questionId: string, answers: string[][]) => void;
  onEngineStatusChanged?: (engineType: EngineType, status: string, error?: string) => void;
  onMessageQueued?: (sessionId: string, messageId: string, queuePosition: number) => void;
  onMessageQueuedConsumed?: (sessionId: string, messageId: string) => void;
  onFileChanged?: (event: { type: string; path: string; directory: string }) => void;
  onCommandsChanged?: (engineType: EngineType, commands: EngineCommand[]) => void;
  onScheduledTaskFired?: (taskId: string, conversationId: string) => void;
  onScheduledTaskFailed?: (taskId: string, error: string) => void;
  onScheduledTasksChanged?: (tasks: ScheduledTask[]) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
}

// --- Gateway API singleton ---

class GatewayAPI {
  private handlers: GatewayNotificationHandlers = {};
  private initialized = false;
  private boundHandlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];

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
    this.unbindEvents();
    gatewayClient.disconnect();
    this.initialized = false;
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
      this.handlers.onConnected?.();
    });

    this.bind("disconnected", (reason) => {
      this.handlers.onDisconnected?.(reason);
    });

    this.bind("message.part.updated", (data) => {
      this.handlers.onPartUpdated?.(data.sessionId, data.part);
    });

    this.bind("message.parts.batch", (data) => {
      this.handlers.onPartsBatch?.(data.sessionId, data.messageId, data.parts);
    });

    this.bind("message.updated", (data) => {
      this.handlers.onMessageUpdated?.(data.sessionId, data.message);
    });

    this.bind("session.updated", (data) => {
      this.handlers.onSessionUpdated?.(data.session);
    });

    this.bind("session.created", (data) => {
      this.handlers.onSessionCreated?.(data.session);
    });

    this.bind("permission.asked", (data) => {
      this.handlers.onPermissionAsked?.(data.permission);
    });

    this.bind("permission.replied", (data) => {
      this.handlers.onPermissionReplied?.(data.permissionId, data.optionId);
    });

    this.bind("question.asked", (data) => {
      this.handlers.onQuestionAsked?.(data.question);
    });

    this.bind("question.replied", (data) => {
      this.handlers.onQuestionReplied?.(data.questionId, data.answers);
    });

    this.bind("engine.status.changed", (data) => {
      this.handlers.onEngineStatusChanged?.(data.engineType, data.status, data.error);
    });

    this.bind("message.queued", (data) => {
      this.handlers.onMessageQueued?.(data.sessionId, data.messageId, data.queuePosition);
    });

    this.bind("message.queued.consumed", (data) => {
      this.handlers.onMessageQueuedConsumed?.(data.sessionId, data.messageId);
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
  }

  // --- Engine ---

  listEngines(): Promise<EngineInfo[]> {
    return gatewayClient.listEngines();
  }

  getCapabilities(engineType: EngineType): Promise<EngineCapabilities> {
    return gatewayClient.getEngineCapabilities(engineType);
  }

  // --- Session ---

  listSessions(engineType: EngineType): Promise<UnifiedSession[]> {
    return gatewayClient.listSessions(engineType);
  }

  createSession(
    engineType: EngineType,
    directory: string,
    worktreeId?: string,
  ): Promise<UnifiedSession> {
    return gatewayClient.createSession({ engineType, directory, worktreeId });
  }

  getSession(sessionId: string): Promise<UnifiedSession> {
    return gatewayClient.getSession(sessionId);
  }

  deleteSession(sessionId: string): Promise<void> {
    return gatewayClient.deleteSession(sessionId);
  }

  renameSession(sessionId: string, title: string): Promise<void> {
    return gatewayClient.renameSession(sessionId, title);
  }

  // --- Message ---

  sendMessage(
    sessionId: string,
    text: string,
    options?: { mode?: string; modelId?: string; images?: import("../types/unified").ImageAttachment[]; reasoningEffort?: import("../types/unified").ReasoningEffort | null },
  ): Promise<UnifiedMessage> {
    const content: import("../types/unified").MessagePromptContent[] = [{ type: "text", text }];
    if (options?.images) {
      for (const img of options.images) {
        content.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
    }
    return gatewayClient.sendMessage({
      sessionId,
      content,
      mode: options?.mode,
      modelId: options?.modelId,
      reasoningEffort: options?.reasoningEffort,
    });
  }

  cancelMessage(sessionId: string): Promise<void> {
    return gatewayClient.cancelMessage(sessionId);
  }

  listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    return gatewayClient.listMessages(sessionId);
  }

  async getMessageSteps(sessionId: string, messageId: string): Promise<UnifiedPart[]> {
    return gatewayClient.getMessageSteps(sessionId, messageId);
  }

  // --- Model ---

  listModels(engineType: EngineType): Promise<ModelListResult> {
    return gatewayClient.listModels(engineType);
  }

  setModel(sessionId: string, modelId: string): Promise<void> {
    return gatewayClient.setModel({ sessionId, modelId });
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

  // --- Project ---

  listProjects(engineType: EngineType): Promise<UnifiedProject[]> {
    return gatewayClient.listProjects(engineType);
  }

  setProjectEngine(directory: string, engineType: EngineType): Promise<void> {
    return gatewayClient.setProjectEngine({ directory, engineType });
  }

  // --- Cross-engine (SessionStore) ---

  listAllSessions(): Promise<UnifiedSession[]> {
    return gatewayClient.listAllSessions();
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
    options?: { mode?: string; modelId?: string; reasoningEffort?: import("../types/unified").ReasoningEffort | null },
  ): Promise<CommandInvokeResult> {
    return gatewayClient.invokeCommand({ sessionId, commandName, args, ...options });
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
}

export const gateway = new GatewayAPI();
