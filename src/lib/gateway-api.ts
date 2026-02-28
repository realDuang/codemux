/**
 * Gateway API — Frontend bridge between GatewayClient and SolidJS stores.
 *
 * This module connects to the main-process gateway via WebSocket, subscribes
 * to push notifications, and exposes typed methods for the frontend to use.
 */

import { gatewayClient } from "./gateway-client";
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
} from "../types/unified";

// --- Notification callback types ---

export interface GatewayNotificationHandlers {
  onPartUpdated?: (sessionId: string, part: UnifiedPart) => void;
  onMessageUpdated?: (sessionId: string, message: UnifiedMessage) => void;
  onSessionUpdated?: (session: UnifiedSession) => void;
  onSessionCreated?: (session: UnifiedSession) => void;
  onPermissionAsked?: (permission: UnifiedPermission) => void;
  onPermissionReplied?: (permissionId: string, optionId: string) => void;
  onQuestionAsked?: (question: UnifiedQuestion) => void;
  onQuestionReplied?: (questionId: string, answers: string[][]) => void;
  onEngineStatusChanged?: (engineType: EngineType, status: string, error?: string) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
}

// --- Gateway API singleton ---

class GatewayAPI {
  private handlers: GatewayNotificationHandlers = {};
  private initialized = false;
  private boundHandlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];

  /**
   * Initialize the gateway connection and subscribe to notifications.
   * Call once during app startup (e.g., in a top-level createEffect).
   */
  async init(handlers?: GatewayNotificationHandlers): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (handlers) {
      this.handlers = handlers;
    }

    this.bindEvents();

    try {
      await gatewayClient.connect();
    } catch (err) {
      console.error("[GatewayAPI] Failed to connect:", err);
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

  createSession(engineType: EngineType, directory: string): Promise<UnifiedSession> {
    return gatewayClient.createSession({ engineType, directory });
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
    options?: { mode?: string; modelId?: string },
  ): Promise<UnifiedMessage> {
    return gatewayClient.sendMessage({
      sessionId,
      content: [{ type: "text", text }],
      mode: options?.mode,
      modelId: options?.modelId,
    });
  }

  cancelMessage(sessionId: string): Promise<void> {
    return gatewayClient.cancelMessage(sessionId);
  }

  listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    return gatewayClient.listMessages(sessionId);
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

  deleteProject(projectId: string): Promise<void> {
    return gatewayClient.deleteProject(projectId) as Promise<any>;
  }

  importLegacyProjects(projects: UnifiedProject[]): Promise<void> {
    return gatewayClient.importLegacyProjects(projects) as Promise<any>;
  }
}

export const gateway = new GatewayAPI();
