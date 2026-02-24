// ============================================================================
// Engine Manager — Registry, routing, and project-engine bindings
// ============================================================================

import { EventEmitter } from "events";
import { EngineAdapter, type EngineAdapterEvents } from "../engines/engine-adapter";
import type {
  EngineType,
  EngineInfo,
  UnifiedSession,
  UnifiedMessage,
  UnifiedModelInfo,
  UnifiedProject,
  UnifiedPermission,
  AgentMode,
  MessagePromptContent,
  PermissionReply,
} from "../../../src/types/unified";

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
  /** sessionId → engineType lookup for routing */
  private sessionEngineMap = new Map<string, EngineType>();

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

  /** Get adapter for a session by looking up its engine binding */
  private getAdapterForSession(sessionId: string): EngineAdapter {
    const engineType = this.sessionEngineMap.get(sessionId);
    if (!engineType) {
      throw new Error(`No engine binding found for session: ${sessionId}`);
    }
    return this.getAdapterOrThrow(engineType);
  }

  /** Get adapter for a directory based on project binding */
  private getAdapterForDirectory(directory: string): EngineAdapter {
    const engineType = this.projectBindings.get(directory);
    if (!engineType) {
      throw new Error(`No engine binding found for directory: ${directory}`);
    }
    return this.getAdapterOrThrow(engineType);
  }

  // --- Event Forwarding ---

  private forwardEvents(adapter: EngineAdapter): void {
    const events: (keyof EngineAdapterEvents)[] = [
      "message.part.updated",
      "message.updated",
      "session.updated",
      "session.created",
      "permission.asked",
      "permission.replied",
      "status.changed",
    ];

    for (const event of events) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapter.on(event, (data: any) => {
        this.emit(event, data);
      });
    }
  }

  // --- Project-Engine Bindings ---

  setProjectEngine(directory: string, engineType: EngineType): void {
    this.getAdapterOrThrow(engineType); // Validate engine exists
    this.projectBindings.set(directory, engineType);
  }

  getProjectEngine(directory: string): EngineType | undefined {
    return this.projectBindings.get(directory);
  }

  getProjectBindings(): Map<string, EngineType> {
    return new Map(this.projectBindings);
  }

  loadProjectBindings(bindings: Record<string, EngineType>): void {
    for (const [dir, engine] of Object.entries(bindings)) {
      this.projectBindings.set(dir, engine);
    }
  }

  // --- Lifecycle ---

  async startAll(): Promise<void> {
    const startPromises = Array.from(this.adapters.values()).map((adapter) =>
      adapter.start().catch((err) => {
        console.error(`Failed to start ${adapter.engineType}:`, err);
      }),
    );
    await Promise.all(startPromises);
  }

  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.adapters.values()).map((adapter) =>
      adapter.stop().catch((err) => {
        console.error(`Failed to stop ${adapter.engineType}:`, err);
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

  // --- Sessions ---

  async listSessions(engineTypeOrDirectory: string): Promise<UnifiedSession[]> {
    let sessions: UnifiedSession[];
    let engineType: EngineType;

    // If it's a known engine type, list all sessions for that engine
    if (this.adapters.has(engineTypeOrDirectory as EngineType)) {
      engineType = engineTypeOrDirectory as EngineType;
      const adapter = this.getAdapterOrThrow(engineType);
      sessions = await adapter.listSessions();
    } else {
      // Otherwise treat as directory path
      const adapter = this.getAdapterForDirectory(engineTypeOrDirectory);
      engineType = this.projectBindings.get(engineTypeOrDirectory)!;
      sessions = await adapter.listSessions(engineTypeOrDirectory);
    }

    // Register all returned sessions for future routing
    for (const session of sessions) {
      this.sessionEngineMap.set(session.id, engineType);
    }

    return sessions;
  }

  async createSession(
    engineType: EngineType,
    directory: string,
  ): Promise<UnifiedSession> {
    const adapter = this.getAdapterOrThrow(engineType);
    const session = await adapter.createSession(directory);
    // Register session → engine mapping for future routing
    this.sessionEngineMap.set(session.id, engineType);
    return session;
  }

  async getSession(sessionId: string): Promise<UnifiedSession | null> {
    const adapter = this.getAdapterForSession(sessionId);
    return adapter.getSession(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const adapter = this.getAdapterForSession(sessionId);
    await adapter.deleteSession(sessionId);
    this.sessionEngineMap.delete(sessionId);
  }

  // --- Messages ---

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: { mode?: string; modelId?: string },
  ): Promise<UnifiedMessage> {
    const adapter = this.getAdapterForSession(sessionId);
    return adapter.sendMessage(sessionId, content, options);
  }

  async cancelMessage(sessionId: string): Promise<void> {
    const adapter = this.getAdapterForSession(sessionId);
    return adapter.cancelMessage(sessionId);
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    const adapter = this.getAdapterForSession(sessionId);
    return adapter.listMessages(sessionId);
  }

  // --- Models ---

  async listModels(engineType: EngineType): Promise<UnifiedModelInfo[]> {
    const adapter = this.getAdapterOrThrow(engineType);
    return adapter.listModels();
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const adapter = this.getAdapterForSession(sessionId);
    return adapter.setModel(sessionId, modelId);
  }

  // --- Modes ---

  getModes(engineType: EngineType): AgentMode[] {
    const adapter = this.getAdapterOrThrow(engineType);
    return adapter.getModes();
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const adapter = this.getAdapterForSession(sessionId);
    return adapter.setMode(sessionId, modeId);
  }

  // --- Permissions ---

  async replyPermission(
    permissionId: string,
    reply: PermissionReply,
    sessionId: string,
  ): Promise<void> {
    const adapter = this.getAdapterForSession(sessionId);
    return adapter.replyPermission(permissionId, reply);
  }

  // --- Projects ---

  async listProjects(engineType: EngineType): Promise<UnifiedProject[]> {
    const adapter = this.getAdapterOrThrow(engineType);
    return adapter.listProjects();
  }

  // --- Session Registration (for adapters that load existing sessions) ---

  registerSession(sessionId: string, engineType: EngineType): void {
    this.sessionEngineMap.set(sessionId, engineType);
  }
}
