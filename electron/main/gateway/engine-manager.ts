// ============================================================================
// Engine Manager — Registry, routing, and project-engine bindings
// ============================================================================

import { EventEmitter } from "events";
import { EngineAdapter, type EngineAdapterEvents } from "../engines/engine-adapter";
import { sessionStore } from "../services/session-store";
import { engineManagerLog } from "../services/logger";
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
  /** permissionId → engineType lookup for routing permission replies */
  private permissionEngineMap = new Map<string, EngineType>();

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
    const engineType = this.projectBindings.get(directory.replaceAll("\\", "/"));
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
        // Track permission → engine mapping for routing replies
        if (event === "permission.asked" && data?.permission?.id) {
          this.permissionEngineMap.set(data.permission.id, adapter.engineType);
        }
        this.emit(event, data);
      });
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
    const result = await adapter.sendMessage(sessionId, content, options);

    // Title fallback: if the session still has no meaningful title after the
    // first assistant reply, derive one from the user's first message text.
    this.applyTitleFallback(sessionId, content);

    return result;
  }

  async cancelMessage(sessionId: string): Promise<void> {
    const adapter = this.getAdapterForSession(sessionId);
    return adapter.cancelMessage(sessionId);
  }

  /**
   * If a session still has no meaningful title (empty, or matches the default
   * "New session - <ISO>" / "Child session - <ISO>" pattern), set it to the
   * first user message text (truncated to 100 chars).
   */
  private applyTitleFallback(
    sessionId: string,
    content: MessagePromptContent[],
  ): void {
    const session = sessionStore.getSession(sessionId);
    if (!session) return;

    // Already has a real title — nothing to do
    if (session.title && !this.isDefaultTitle(session.title)) return;

    // Extract first text from the user prompt
    const firstText = content.find((c) => c.type === "text" && c.text)?.text;
    if (!firstText) return;

    const maxLen = 100;
    session.title =
      firstText.length > maxLen
        ? firstText.slice(0, maxLen).trimEnd() + "…"
        : firstText;
    sessionStore.upsertSession(session);
    this.emit("session.updated", { session });
  }

  private isDefaultTitle(title: string): boolean {
    return /^(New session|Child session)( - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z)?$/.test(
      title,
    );
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

  // --- Projects ---

  async listProjects(engineType: EngineType): Promise<UnifiedProject[]> {
    const adapter = this.getAdapterOrThrow(engineType);
    return adapter.listProjects();
  }

  // --- Session Registration (for adapters that load existing sessions) ---

  registerSession(sessionId: string, engineType: EngineType): void {
    this.sessionEngineMap.set(sessionId, engineType);
  }

  // --- SessionStore Integration ---

  /**
   * Rebuild routing tables from persisted SessionStore data.
   * Called once at startup, after sessionStore.init().
   */
  initFromStore(): void {
    for (const session of sessionStore.getAllSessions()) {
      this.sessionEngineMap.set(session.id, session.engineType);
      // Derive project bindings from sessions
      if (session.directory) {
        const normDir = session.directory.replaceAll("\\", "/");
        if (normDir && normDir !== "/") {
          this.projectBindings.set(normDir, session.engineType);
        }
      }
    }
    engineManagerLog.info(
      `Restored ${this.sessionEngineMap.size} session routes, ${this.projectBindings.size} project bindings from sessions`,
    );
  }

  /** Return all sessions from persistent store (all engines) */
  listAllSessions(): UnifiedSession[] {
    return sessionStore.getAllSessions();
  }

  /** Return all visible projects from persistent store (all engines) */
  listAllProjects(): UnifiedProject[] {
    return sessionStore.getVisibleProjects();
  }
}
