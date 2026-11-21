import { EngineAdapter, type EngineAdapterEvents } from "./engine-adapter";
import { AgentHostProviderAdapter } from "./agent-host-provider-adapter";
import type { AgentHostService } from "../session-sources/agent-host/service";
import { isAgentHostSession } from "../session-sources/agent-host/projection";
import type { CatalogProjectInput, CatalogProjectPatch, CodexServiceTier, EngineCatalogSnapshot, MessagePromptContent, PermissionReply, ReasoningEffort } from "../../../src/types/unified";

/** One public engine; a native AHP identity can never reach SDK resume/create. */
export class HostRoutedAdapter extends EngineAdapter {
  readonly engineType;
  private readonly external: AgentHostProviderAdapter;
  private nativeCatalog?: EngineCatalogSnapshot;
  private catalogPublication = 0;
  constructor(private readonly sdk: EngineAdapter, source: AgentHostService, private readonly nativeCatalogSourceId?: string) {
    super();
    this.engineType = sdk.engineType;
    this.external = new AgentHostProviderAdapter(sdk.engineType, source);
    const events = ["message.part.updated", "message.updated", "message.removed",
      "session.updated", "session.created", "session.removed", "permission.asked", "permission.replied",
      "question.asked", "question.replied", "message.queued", "message.queued.consumed", "commands.changed"] as const;
    for (const driver of [this.sdk, this.external]) for (const event of events) this.relay(driver, event);
    this.sdk.on("status.changed", data => {
      this.emit("status.changed", data);
    });
    this.sdk.on("catalog.updated", snapshot => {
      this.nativeCatalog = snapshot;
      void this.publishCatalog();
    });
    this.external.on("catalog.updated", () => { void this.publishCatalog(); });
  }
  private async publishCatalog() {
    const revision = ++this.catalogPublication;
    try {
      const catalog = await this.getCatalog();
      if (revision === this.catalogPublication) this.emit("catalog.updated", catalog);
    } catch { /* The native catalog is not ready yet. */ }
  }
  private relay<K extends keyof EngineAdapterEvents>(driver: EngineAdapter, event: K) {
    driver.on(event, ((...args: Parameters<EngineAdapterEvents[K]>) => { this.emit(event, ...args); }) as EngineAdapterEvents[K]);
  }
  private driver(id: string) { return isAgentHostSession(id) ? this.external : this.sdk; }
  async start() {
    await this.sdk.start();
    this.emit("status.changed", { engineType: this.engineType, status: this.getStatus() });
  }
  async stop() { await this.sdk.stop(); }
  async healthCheck() { return this.sdk.healthCheck(); }
  getStatus() { return this.sdk.getStatus(); }
  getInfo() { return { ...this.sdk.getInfo(), status: this.getStatus(), capabilities: this.getCapabilities(), sessionSharing: this.getSessionSharing() }; }
  getCapabilities() { return { ...this.sdk.getCapabilities(), externalSessionCatalog: true }; }
  getSessionCapabilities(id: string) { return this.driver(id).getSessionCapabilities(id); }
  getAuthMethods() { return this.sdk.getAuthMethods(); }
  getSessionSharing() { return this.sdk.getSessionSharing(); }
  async setSessionSharing(enabled: boolean) {
    const result = await this.sdk.setSessionSharing(enabled);
    this.emit("status.changed", { engineType: this.engineType, status: this.getStatus() });
    return result;
  }
  async getCatalog(): Promise<EngineCatalogSnapshot> {
    if (!this.sdk.getCapabilities().sessionCatalog) return this.external.getCatalog();
    const native = await this.sdk.getCatalog().catch((error): EngineCatalogSnapshot => {
      const previous = this.nativeCatalog;
      const sourceId = previous?.sourceId ?? this.nativeCatalogSourceId;
      if (!sourceId) throw error;
      return { sourceId, engineType: this.engineType, revision: "offline", complete: false,
        projects: previous?.projects ?? [],
        sessions: (previous?.sessions ?? []).map(session => ({ ...session, activityStatus: "idle",
          ...(session.connection ? { connection: { ...session.connection, available: false } } : {}) })),
      };
    });
    this.nativeCatalog = native;
    const external = await this.external.getCatalog();
    return { ...native, revision: `${native.revision}:${external.revision}`,
      projects: [...native.projects, ...external.projects], sessions: [...native.sessions, ...external.sessions] };
  }
  assertSessionCompatible(id: string, meta?: Record<string, unknown>) { this.driver(id).assertSessionCompatible(id, meta); }
  hasSession(id: string) { return this.driver(id).hasSession(id); }
  async listSessions(directory?: string) { return [...await this.sdk.listSessions(directory), ...await this.external.listSessions(directory)]; }
  createSession(directory: string, meta?: Record<string, unknown>) { return this.sdk.createSession(directory, meta); }
  restoreSession(id: string, directory: string, meta?: Record<string, unknown>) { return this.driver(id).restoreSession(id, directory, meta); }
  getSession(id: string) { return this.driver(id).getSession(id); }
  deleteSession(id: string) { return this.driver(id).deleteSession(id); }
  removeSession(id: string) { return this.driver(id).removeSession(id); }
  renameSession(id: string, title: string, directory?: string, meta?: Record<string, unknown>) { return this.driver(id).renameSession(id, title, directory, meta); }
  sendMessage(id: string, content: MessagePromptContent[], options?: Parameters<EngineAdapter["sendMessage"]>[2]) { return this.driver(id).sendMessage(id, content, options); }
  cancelMessage(id: string, directory?: string) { return this.driver(id).cancelMessage(id, directory); }
  listMessages(id: string) { return this.driver(id).listMessages(id); }
  getHistoricalMessages(id: string, directory: string, meta?: Record<string, unknown>) { return this.driver(id).getHistoricalMessages(id, directory, meta); }
  listHistoricalSessions(limit: number) { return this.sdk.listHistoricalSessions(limit); }
  listModels() { return this.sdk.listModels(); }
  setModel(id: string, model: string) { return this.driver(id).setModel(id, model); }
  getModes() { return this.sdk.getModes(); }
  setMode(id: string, mode: string) { return this.driver(id).setMode(id, mode); }
  setReasoningEffort(id: string, effort: ReasoningEffort | null) { return this.driver(id).setReasoningEffort(id, effort); }
  getReasoningEffort(id: string) { return this.driver(id).getReasoningEffort(id); }
  setServiceTier(id: string, tier: CodexServiceTier | null) { return this.driver(id).setServiceTier(id, tier); }
  getServiceTier(id: string) { return this.driver(id).getServiceTier(id); }
  setSessionArchived(id: string, archived: boolean) { return this.driver(id).setSessionArchived(id, archived); }
  createProject(input: CatalogProjectInput) { return this.sdk.createProject(input); }
  updateProject(id: string, patch: CatalogProjectPatch) { return this.sdk.updateProject(id, patch); }
  moveProject(id: string, before: string | null) { return this.sdk.moveProject(id, before); }
  deleteCatalogProject(id: string) { return this.sdk.deleteCatalogProject(id); }
  setSessionProject(id: string, project: string | null) { return this.driver(id).setSessionProject(id, project); }
  async replyPermission(id: string, reply: PermissionReply, sessionId?: string) {
    if (sessionId) return this.driver(sessionId).replyPermission(id, reply, sessionId);
    if (id.startsWith("ahp-") || this.external.getPendingPermissions().some(permission => permission.id === id)) return this.external.replyPermission(id, reply);
    return this.sdk.replyPermission(id, reply);
  }
  async getPendingPermissions(id?: string) {
    if (id) return this.driver(id).getPendingPermissions(id);
    return [...await this.sdk.getPendingPermissions(), ...this.external.getPendingPermissions()];
  }
  async replyQuestion(id: string, answers: string[][], sessionId?: string) {
    if (sessionId) return this.driver(sessionId).replyQuestion(id, answers, sessionId);
    if (id.startsWith("ahp-") || this.external.getPendingQuestions().some(question => question.id === id)) return this.external.replyQuestion(id, answers);
    return this.sdk.replyQuestion(id, answers);
  }
  async rejectQuestion(id: string, sessionId?: string) {
    if (sessionId) return this.driver(sessionId).rejectQuestion(id, sessionId);
    if (id.startsWith("ahp-") || this.external.getPendingQuestions().some(question => question.id === id)) return this.external.rejectQuestion(id);
    return this.sdk.rejectQuestion(id);
  }
  async getPendingQuestions(id?: string) {
    if (id) return this.driver(id).getPendingQuestions(id);
    return [...await this.sdk.getPendingQuestions(), ...this.external.getPendingQuestions()];
  }
  listProjects() { return this.sdk.listProjects(); }
  listCommands(id?: string, directory?: string) { return (id ? this.driver(id) : this.sdk).listCommands(id, directory); }
  invokeCommand(id: string, command: string, args: string, options?: Parameters<EngineAdapter["invokeCommand"]>[3]) { return this.driver(id).invokeCommand(id, command, args, options); }
}
