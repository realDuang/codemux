import { EngineAdapter } from "./engine-adapter";
import type { EngineType, MessagePromptContent, PermissionReply, ReasoningEffort } from "../../../src/types/unified";
import type { AgentHostService } from "../session-sources/agent-host/service";
import { providerEngine } from "../session-sources/agent-host/providers";

/** Engine-scoped view of a shared host, never a connection or execution owner. */
export class AgentHostProviderAdapter extends EngineAdapter {
  constructor(readonly engineType: EngineType, private readonly source: AgentHostService) {
    super();
    const permissions = new Set<string>(), questions = new Set<string>();
    source.on("catalog.updated", snapshot => { if (snapshot.engineType === engineType) this.emit("catalog.updated", snapshot); });
    source.on("session.updated", data => { if (data.session.engineType === engineType) this.emit("session.updated", data); });
    source.on("message.updated", data => { if (source.sessionEngine(data.sessionId) === engineType) this.emit("message.updated", data); });
    source.on("message.removed", data => { if (source.sessionEngine(data.sessionId) === engineType) this.emit("message.removed", data); });
    source.on("message.queued", data => { if (source.sessionEngine(data.sessionId) === engineType) this.emit("message.queued", data); });
    source.on("message.queued.consumed", data => { if (source.sessionEngine(data.sessionId) === engineType) this.emit("message.queued.consumed", data); });
    source.on("permission.asked", data => {
      if (data.permission.engineType === engineType) { permissions.add(data.permission.id); this.emit("permission.asked", data); }
    });
    source.on("permission.replied", data => { if (permissions.delete(data.permissionId)) this.emit("permission.replied", data); });
    source.on("question.asked", data => {
      if (data.question.engineType === engineType) { questions.add(data.question.id); this.emit("question.asked", data); }
    });
    source.on("question.replied", data => { if (questions.delete(data.questionId)) this.emit("question.replied", data); });
  }
  private check(id: string) {
    if (this.source.sessionEngine(id) !== this.engineType) throw new Error("The original VS Code session is unavailable for this provider.");
    return this.source;
  }
  async start() {}
  async stop() {}
  async healthCheck() { return this.source.getState().providers.some(provider => provider.engineType === this.engineType) && this.source.getState().available; }
  getStatus() { return "running" as const; }
  getInfo() { return { type: this.engineType, name: this.engineType, status: this.getStatus(), capabilities: this.getCapabilities() }; }
  getCapabilities() { return this.source.getCapabilities(); }
  getSessionCapabilities(id: string) { return this.source.getSessionCapabilities(id); }
  getAuthMethods() { return []; }
  getModes() { return []; }
  getCatalog() { return this.source.getCatalog(this.engineType); }
  assertSessionCompatible(id: string, meta?: Record<string, unknown>) {
    this.source.assertSessionCompatible(id, meta);
    const owner = this.source.sessionEngine(id);
    if (owner && owner !== this.engineType) throw new Error("VS Code session provider does not match.");
    if (typeof meta?.ahpProvider === "string" && providerEngine(meta.ahpProvider) !== this.engineType) throw new Error("Saved VS Code provider does not match.");
  }
  hasSession(id: string) { return this.source.sessionEngine(id) === this.engineType && this.source.hasSession(id); }
  listSessions(directory?: string) { return this.source.listSessions(this.engineType, directory); }
  async createSession(): Promise<never> { throw new Error("Create externally owned chats in their original host."); }
  async restoreSession(id: string) { return this.check(id).restoreSession(id); }
  getSession(id: string) { return this.source.sessionEngine(id) === this.engineType ? this.source.getSession(id) : Promise.resolve(null); }
  async deleteSession(id: string) { return this.check(id).deleteSession(id); }
  async removeSession(id: string) { return this.check(id).removeSession(id); }
  async renameSession(id: string, title: string) { return this.check(id).renameSession(id, title); }
  async sendMessage(id: string, content: MessagePromptContent[], options?: Parameters<EngineAdapter["sendMessage"]>[2]) { return this.check(id).sendMessage(id, content, options); }
  async cancelMessage(id: string) { return this.check(id).cancelMessage(id); }
  async listMessages(id: string) { return this.check(id).listMessages(id); }
  async getHistoricalMessages(id: string) { return this.check(id).getHistoricalMessages(id); }
  async listModels() { return { models: [] }; }
  async setModel(id: string, model: string) { return this.check(id).setModel(id, model); }
  async setMode(id: string, mode: string) { return this.check(id).setMode(id, mode); }
  async setReasoningEffort(id: string, effort: ReasoningEffort | null) { return this.check(id).setReasoningEffort(id, effort); }
  getReasoningEffort(id: string) { return this.check(id).getReasoningEffort(id); }
  getPendingPermissions(id?: string) { return this.source.getPendingPermissions(id).filter(permission => permission.engineType === this.engineType); }
  getPendingQuestions(id?: string) { return this.source.getPendingQuestions(id).filter(question => question.engineType === this.engineType); }
  replyPermission(id: string, reply: PermissionReply, sessionId?: string) {
    const pending = this.getPendingPermissions(sessionId).find(permission => permission.id === id);
    if (!pending) return Promise.reject(new Error("This approval is no longer pending."));
    return this.source.replyPermission(id, reply, pending.sessionId);
  }
  replyQuestion(id: string, answers: string[][], sessionId?: string) {
    const pending = this.getPendingQuestions(sessionId).find(question => question.id === id);
    if (!pending) return Promise.reject(new Error("This question is no longer pending."));
    return this.source.replyQuestion(id, answers, pending.sessionId);
  }
  rejectQuestion(id: string, sessionId?: string) {
    const pending = this.getPendingQuestions(sessionId).find(question => question.id === id);
    if (!pending) return Promise.reject(new Error("This question is no longer pending."));
    return this.source.rejectQuestion(id, pending.sessionId);
  }
  async listProjects() { return (await this.getCatalog()).projects; }
}
