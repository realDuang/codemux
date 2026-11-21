import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChatState, ChatSummary, SessionState, ModelSelection, Message, ActionEnvelope,
} from "@microsoft/agent-host-protocol";
import type { SendMessageOptions, SessionBackendEvents } from "../../../../shared/session-backend";
import type { SessionSource } from "../session-source";
import type {
  EngineType, EngineCapabilities, EngineCatalogSnapshot, SessionSourceState, MessagePromptContent,
  PermissionReply, ReasoningEffort, UnifiedMessage, UnifiedSession, UnifiedModelInfo,
} from "../../../../src/types/unified";
import { agentHostEndpointKey, discoverAgentHosts, type AgentHostEndpoint } from "./discovery";
import { AgentHostConnection, ROOT } from "./connection";
import { activity, inputAnswers, nativeChatId, projectChat, projectInputs, scopedId, type PermissionRoute, type QuestionRoute, type TurnProjectionCache } from "./projection";
import { SESSION_FLAGS, type Wire } from "./wire";
import { providerEngine, supportedEngines, agentHostCatalogId } from "./providers";

function unifiedEffort(value: unknown): ReasoningEffort | undefined {
  return value === "xhigh" ? "max" : value === "max" ? "ultra"
    : value === "low" || value === "medium" || value === "high" ? value : undefined;
}
interface Entry {
  provider: string;
  source: string;
  sessionUri: string;
  chatUri: string;
  session: UnifiedSession;
  host?: AgentHostConnection;
  attached: boolean;
  messages: Map<string, UnifiedMessage>;
  turns: TurnProjectionCache;
}
export interface AgentHostServiceOptions {
  enabled?: boolean;
  knownSessions?: () => UnifiedSession[];
  persistEnabled?: (enabled: boolean) => Promise<void>;
  discover?: () => Promise<AgentHostEndpoint[]>;
  createConnection?: (endpoint: AgentHostEndpoint, options: ConstructorParameters<typeof AgentHostConnection>[1]) => AgentHostConnection;
  pollMs?: number;
}

/** One connection pool and discovery loop per source, shared by every harness. */
export class AgentHostService extends EventEmitter<{ [K in keyof SessionBackendEvents]: Parameters<SessionBackendEvents[K]> }> implements SessionSource {
  private enabled: boolean;
  private running = false;
  private hosts = new Map<string, AgentHostConnection>();
  private entries = new Map<string, Entry>();
  private permissions = new Map<string, PermissionRoute>();
  private questions = new Map<string, QuestionRoute>();
  private queued = new Map<string, { sessionId: string; clientMessageId?: string; announced: boolean }>();
  private timer?: ReturnType<typeof setTimeout>;
  private publishing?: ReturnType<typeof setTimeout>;
  private dirty = new Set<string>();
  private refresh?: Promise<void>;
  private transition?: Promise<SessionSourceState>;
  private generation = 0;
  private revision = 0;
  private initialized = false;

  constructor(private readonly options: AgentHostServiceOptions = {}) { super(); this.enabled = options.enabled === true; }
  async start() { this.running = true; this.seed(); if (this.enabled) await this.refreshHosts(); else this.publishCatalog(); }
  async stop() {
    this.running = false;
    this.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.publishing);
    this.publishing = undefined;
    this.dirty.clear();
    await Promise.all([...this.hosts.values()].map(host => host.close()));
    this.hosts.clear();
    await this.refresh;
    this.publishCatalog();
  }
  getCapabilities(): EngineCapabilities {
    return { authoritativeSessionState: true, sourceScopedMessageIds: true, confirmedSessionRemoval: true, providerModelHierarchy: false,
      dynamicModes: true, messageCancellation: true, permissionAlways: false, imageAttachment: true,
      loadSession: true, listSessions: true, modelSwitchable: true, customModelInput: false,
      messageEnqueue: true, slashCommands: false, availableModes: [],
      reasoningEffortOptions: ["low", "medium", "high", "max", "ultra"] };
  }
  getSessionCapabilities(id: string): EngineCapabilities {
    return this.entries.get(id)?.session.connection?.capabilities ?? this.getCapabilities();
  }
  getState(): SessionSourceState {
    const hosts = [...this.hosts.values()].filter(host => host.connected);
    const available = this.enabled && hosts.length > 0;
    const providers = [...new Set(hosts.flatMap(host => host.root?.agents.map(agent => agent.provider) ?? []))];
    return { id: "vscode", enabled: this.enabled, available, peerName: "Agent Host", kind: "attach",
      providers: providers.map(id => ({ id, engineType: providerEngine(id), supported: providerEngine(id) !== undefined })),
      status: !this.enabled ? "disabled" : available ? "connected" : this.refresh ? "connecting" : "unavailable" };
  }
  async setEnabled(enabled: boolean): Promise<SessionSourceState> {
    const previous = this.transition;
    const operation = (async () => {
      await previous?.catch(() => undefined);
      await this.options.persistEnabled?.(enabled);
      this.enabled = enabled;
      if (enabled) await this.start();
      else { await this.stop(); this.running = true; }
      return this.getState();
    })();
    this.transition = operation;
    try { return await operation; } finally { if (this.transition === operation) this.transition = undefined; }
  }

  private seed() {
    if (this.initialized) return;
    this.initialized = true;
    for (const session of this.options.knownSessions?.() ?? []) {
      const { ahpSource: source, ahpSession: sessionUri, ahpChat: chatUri } = session.engineMeta ?? {};
      // Old Copilot mirrors predate provider metadata; preserve their identities.
      const provider = session.engineMeta?.ahpProvider ?? (session.engineType === "copilot" ? "copilotcli" : undefined);
      if (typeof source !== "string" || typeof sessionUri !== "string" || typeof chatUri !== "string"
        || typeof provider !== "string" || providerEngine(provider) !== session.engineType
        || session.id !== nativeChatId(source, chatUri)) continue;
      this.entries.set(session.id, { provider, source, sessionUri, chatUri, session: { ...session,
        projectId: scopedId(source, session.directory), connection: this.connection() },
        attached: false, messages: new Map(), turns: new Map() });
    }
  }
  private connection(host?: AgentHostConnection, writable = true) {
    // Neither the registry nor the harness identifies the chat's creating application.
    return { source: "Agent Host", origin: undefined, executor: "Agent Host", shared: true, authoritative: true, localRemovalOnly: true,
      available: this.enabled && host?.connected === true, readOnly: !writable,
      models: [], modes: [],
      capabilities: { ...this.getCapabilities(), imageAttachment: false, modelSwitchable: false, dynamicModes: false },
      sharingStatus: this.enabled ? host?.connected ? "connected" as const : "unavailable" as const : "disabled" as const,
      runtimeVersion: host?.version };
  }
  private async refreshHosts(): Promise<void> {
    if (this.refresh) return this.refresh;
    const generation = this.generation;
    this.refresh = (async () => {
      const endpoints = await (this.options.discover ?? discoverAgentHosts)();
      if (!this.running || !this.enabled || generation !== this.generation) return;
      const present = new Set(endpoints.map(agentHostEndpointKey));
      for (const [key, host] of this.hosts) {
        if (!present.has(key) || !host.connected) { this.hosts.delete(key); await host.close(); }
      }
      for (const endpoint of endpoints) {
        if (generation !== this.generation || !this.enabled) return;
        const key = agentHostEndpointKey(endpoint);
        let host = this.hosts.get(key);
        if (!host) {
          const created = (this.options.createConnection ?? ((entry, options) => new AgentHostConnection(entry, options)))(endpoint, {
            onChange: (channel, action) => this.changed(created, channel, action),
            onCatalogChange: () => this.scheduleRefresh(),
            onClose: () => {
              for (const entry of this.entries.values()) if (entry.host === created) {
                entry.session = { ...entry.session, connection: this.connection(), activityStatus: "idle" };
                this.clearInputs(entry.session.id);
              }
              this.publishCatalog();
              this.scheduleRefresh();
            },
          });
          host = created;
          this.hosts.set(key, host);
          try { await host.connect(); } catch { await host.close(); continue; }
          if (generation !== this.generation || !this.enabled) { await host.close(); return; }
        }
        try {
          await host.request("ping", { channel: ROOT });
          const seen = new Set<string>(), cursors = new Set<string>();
          let cursor: string | undefined;
          do {
            const page = await host.request("listSessions", { channel: ROOT, limit: 100, ...(cursor ? { cursor } : {}) });
            for (const summary of page.items) {
              try {
                await host.subscribe(summary.resource);
                const session = host.sessions.get(summary.resource);
                if (session) {
                  seen.add(summary.resource);
                  this.catalogSession(host, summary.resource, session);
                }
              } catch { /* One inaccessible session must not disconnect other providers. */ }
            }
            cursor = page.nextCursor;
            if (cursor && cursors.has(cursor)) throw new Error("Repeated catalogue cursor.");
            if (cursor) cursors.add(cursor);
          } while (cursor && generation === this.generation);
          for (const entry of this.entries.values()) {
            if (entry.host === host && !seen.has(entry.sessionUri)) {
              entry.host = undefined;
              entry.session = { ...entry.session, connection: this.connection(), activityStatus: "idle" };
              this.clearInputs(entry.session.id);
            }
          }
          for (const entry of this.entries.values()) {
            if (entry.host === host && entry.attached) {
              try { await host.subscribe(entry.chatUri); }
              catch {
                entry.host = undefined;
                entry.session = { ...entry.session, connection: this.connection(), activityStatus: "idle" };
                this.clearInputs(entry.session.id);
              }
            }
          }
        } catch { await host.close(); }
      }
    })().finally(() => {
      this.refresh = undefined;
      this.publishCatalog();
      this.scheduleRefresh(this.options.pollMs ?? 5000);
    });
    return this.refresh;
  }
  private scheduleRefresh(delay = 200) {
    if (!this.running || !this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.refreshHosts().catch(() => this.scheduleRefresh(5000)); }, delay);
    this.timer.unref?.();
  }
  private catalogSession(host: AgentHostConnection, uri: string, session: SessionState) {
    const chats = session.chats ?? [];
    const admitted = new Set<string>();
    for (const chat of chats) {
      const provider = host.chats.get(chat.resource)?.provider ?? chat.provider ?? session.provider;
      if (!providerEngine(provider) || !host.root?.agents.some(agent => agent.provider === provider) || chat.interactivity === "hidden") continue;
      const id = nativeChatId(host.endpoint.source, chat.resource);
      const old = this.entries.get(id);
      // Two live writers claiming the same identity are ambiguous, not a failover.
      const competing = [...this.hosts.values()].some(other => other !== host && other.connected && other.endpoint.source === host.endpoint.source
        && [...other.sessions.values()].some(state => state.chats?.some(candidate =>
          candidate.resource === chat.resource)));
      // A native chat changing harness must not silently reuse a saved engine binding.
      if (old && old.provider !== provider) {
        old.host = undefined;
        old.session = { ...old.session, connection: this.connection(), activityStatus: "idle" };
        this.clearInputs(id);
        continue;
      }
      const entry: Entry = old ?? { provider, source: host.endpoint.source, sessionUri: uri, chatUri: chat.resource,
        session: {} as UnifiedSession, attached: false, messages: new Map(), turns: new Map() };
      entry.host = competing ? undefined : host;
      entry.sessionUri = uri;
      entry.session = this.describe(entry, session, host.chats.get(chat.resource) ?? chat);
      if (competing) this.clearInputs(id);
      this.entries.set(id, entry);
      admitted.add(chat.resource);
    }
    for (const entry of this.entries.values()) {
      if (entry.host === host && entry.sessionUri === uri && !admitted.has(entry.chatUri)) {
        entry.host = undefined;
        entry.session = { ...entry.session, connection: this.connection(), activityStatus: "idle" };
        this.clearInputs(entry.session.id);
      }
    }
  }
  private describe(entry: Entry, session: SessionState, chat: ChatSummary | ChatState): UnifiedSession {
    const id = nativeChatId(entry.source, entry.chatUri);
    let directory = "";
    try { directory = fileURLToPath((chat.workingDirectories ?? session.workingDirectories ?? [])[0]).replaceAll("\\", "/"); } catch { /* An empty workspace is valid. */ }
    const model = "draft" in chat ? chat.draft?.model : undefined;
    const values = { ...session.config?.values, ...("config" in chat ? chat.config?.values : {}) };
    const mode = typeof values.mode === "string" ? values.mode : undefined;
    const updated = Date.parse(chat.modifiedAt) || entry.session.time?.updated || Date.now();
    const last = "turns" in chat ? chat.activeTurn?.message.model ?? chat.turns.at(-1)?.message.model : undefined;
    const effort = (model ?? last)?.config?.thinkingLevel ?? (model ?? last)?.config?.reasoningEffort;
    const modeSchema = ("config" in chat ? chat.config?.schema : undefined)?.properties?.mode ?? session.config?.schema?.properties?.mode;
    const models = entry.host ? this.hostModels(entry.host, entry.provider) : entry.session.connection?.models ?? [];
    const modes = modeSchema?.enum?.filter((value): value is string => typeof value === "string")
      .map(id => ({ id, label: id })) ?? [];
    const selectedModel = entry.host?.root?.agents.find(agent => agent.provider === entry.provider)?.models
      .find(candidate => candidate.id === (model ?? last)?.id);
    return { id, engineType: providerEngine(entry.provider)!, title: chat.resource === session.defaultChat ? session.title : chat.title,
      directory, projectId: scopedId(entry.source, directory), time: { created: entry.session.time?.created ?? updated, updated },
      connection: { ...this.connection(entry.host, (chat.interactivity === undefined || chat.interactivity === "full")
        && !(chat.status & SESSION_FLAGS.archived)), canRename: chat.resource === session.defaultChat,
        models, modes,
        capabilities: { ...this.getCapabilities(), availableModes: modes,
          dynamicModes: !!(modeSchema?.chatMutable || modeSchema?.sessionMutable),
          modelSwitchable: models.length > 0, imageAttachment: selectedModel?.supportsVision === true,
          reasoningEffortOptions: models.find(candidate => candidate.modelId === (model ?? last)?.id)?.capabilities?.supportedReasoningEfforts ?? [],
        },
      },
      activityStatus: activity(chat.status), mode, modelId: (model ?? last)?.id ?? entry.session.modelId,
      reasoningEffort: unifiedEffort(effort),
      engineMeta: { ahpSource: entry.source, ahpSession: entry.sessionUri, ahpChat: entry.chatUri, ahpProvider: entry.provider },
    };
  }
  private changed(host: AgentHostConnection, channel: string, envelope?: ActionEnvelope) {
    if (channel === ROOT) {
      for (const [uri, session] of host.sessions) this.catalogSession(host, uri, session);
      this.publishCatalog();
    }
    const action = envelope?.action;
    const queueId = action?.type === "chat/turnStarted" ? action.queuedMessageId
      : action?.type === "chat/pendingMessageRemoved" ? action.id : undefined;
    const queued = queueId ? this.queued.get(queueId) : undefined;
    if (queueId && queued && this.entries.get(queued.sessionId)?.host === host) {
      this.queued.delete(queueId);
      if (queued.announced) this.emit("message.queued.consumed", { sessionId: queued.sessionId,
        messageId: scopedId(queued.sessionId, queueId), clientMessageId: queued.clientMessageId });
    }
    const session = host.sessions.get(channel);
    if (session) { this.catalogSession(host, channel, session); this.publishCatalog(); }
    for (const entry of this.entries.values()) if (entry.host === host && entry.chatUri === channel) this.dirty.add(entry.session.id);
    if (this.dirty.size && !this.publishing) this.publishing = setTimeout(() => {
      this.publishing = undefined;
      for (const id of this.dirty) { const entry = this.entries.get(id); if (entry) this.publishChat(entry); }
      this.dirty.clear();
    }, 30);
  }
  private publishChat(entry: Entry) {
    const chat = entry.host?.chats.get(entry.chatUri), session = entry.host?.sessions.get(entry.sessionUri);
    if (!chat || !session || !entry.host?.connected) return;
    if ((chat.provider ?? session.chats?.find(summary => summary.resource === entry.chatUri)?.provider ?? session.provider) !== entry.provider
      || !entry.host.root?.agents.some(agent => agent.provider === entry.provider) || chat.interactivity === "hidden") {
      entry.host = undefined;
      entry.session = { ...entry.session, connection: this.connection(), activityStatus: "idle" };
      this.clearInputs(entry.session.id);
      this.publishCatalog();
      return;
    }
    entry.session = this.describe(entry, session, chat);
    this.emit("session.updated", { session: entry.session });
    const messages = projectChat(entry.session.id, chat, entry.session.directory, entry.session.engineType, entry.turns);
    const present = new Set(messages.map(message => message.id));
    for (const id of entry.messages.keys()) if (!present.has(id)) {
      entry.messages.delete(id);
      this.emit("message.removed", { sessionId: entry.session.id, messageId: id });
    }
    for (const message of messages) {
      if (entry.messages.get(message.id) === message) continue;
      entry.messages.set(message.id, message);
      this.emit("message.updated", { sessionId: entry.session.id, message });
    }
    const inputs = projectInputs(entry.session.id, chat, entry.session.engineType);
    for (const [id, route] of this.permissions) if (route.permission.sessionId === entry.session.id && !inputs.permissions.some(next => next.permission.id === id)) {
      this.permissions.delete(id);
      this.emit("permission.replied", { permissionId: id, optionId: "" });
    }
    for (const [id, route] of this.questions) if (route.question.sessionId === entry.session.id && !inputs.questions.some(next => next.question.id === id)) {
      this.questions.delete(id);
      this.emit("question.replied", { questionId: id, answers: [] });
    }
    for (const route of inputs.permissions) {
      const previous = this.permissions.get(route.permission.id);
      this.permissions.set(route.permission.id, route);
      if (JSON.stringify(previous?.permission) !== JSON.stringify(route.permission)) this.emit("permission.asked", { permission: route.permission });
    }
    for (const route of inputs.questions) {
      const previous = this.questions.get(route.question.id);
      this.questions.set(route.question.id, route);
      if (JSON.stringify(previous?.question) !== JSON.stringify(route.question)) this.emit("question.asked", { question: route.question });
    }
  }
  private clearInputs(id: string) {
    for (const [key, queued] of this.queued) if (queued.sessionId === id) {
      this.queued.delete(key);
      if (queued.announced) this.emit("message.queued.consumed", { sessionId: id, messageId: scopedId(id, key), clientMessageId: queued.clientMessageId });
    }
    for (const [key, route] of this.permissions) if (route.permission.sessionId === id) {
      this.permissions.delete(key); this.emit("permission.replied", { permissionId: key, optionId: "" });
    }
    for (const [key, route] of this.questions) if (route.question.sessionId === id) {
      this.questions.delete(key); this.emit("question.replied", { questionId: key, answers: [] });
    }
  }
  private publishCatalog() { if (this.initialized) for (const engine of supportedEngines) this.emit("catalog.updated", this.catalog(engine)); }
  private catalog(engineType: EngineType): EngineCatalogSnapshot {
    const sessions = [...this.entries.values()].filter(entry => entry.session.engineType === engineType).map(entry => ({
      ...entry.session, ...(!this.enabled || !entry.host?.connected ? { connection: { ...entry.session.connection, ...this.connection() }, activityStatus: "idle" as const } : {}),
    }));
    const projects = [...new Map(sessions.map(session => [session.projectId!, {
      id: session.projectId!, directory: session.directory, roots: session.directory ? [session.directory] : [],
      name: session.directory ? `${basename(session.directory)} (Agent Host)` : "Agent Host",
    }])).values()];
    return { sourceId: agentHostCatalogId(engineType), engineType, revision: String(++this.revision), complete: true, projects, sessions };
  }
  async getCatalog(engineType: EngineType) { this.seed(); return this.catalog(engineType); }
  async listSessions(engineType: EngineType, directory?: string) { return this.catalog(engineType).sessions.filter(session => !directory || session.directory === directory.replaceAll("\\", "/")); }
  sessionEngine(id: string) { return this.entries.get(id)?.session.engineType; }
  hasSession(id: string) { const entry = this.entries.get(id); return this.enabled && entry?.host?.connected === true && entry.attached; }
  assertSessionCompatible(id: string, meta?: Record<string, unknown>) {
    if (!id.startsWith("ahp:v1:")) throw new Error("Unknown VS Code session identity.");
    if (meta?.ahpSource && meta.ahpChat && id !== nativeChatId(String(meta.ahpSource), String(meta.ahpChat))) throw new Error("VS Code session source does not match.");
  }
  private async attach(id: string, writable = false) {
    const entry = this.entries.get(id);
    if (!entry || !this.enabled || !entry.host?.connected || (writable && !entry.session.connection?.available))
      throw new Error("The original VS Code session is unavailable. Reopen VS Code and enable sharing to continue.");
    const host = entry.host;
    await host.subscribe(entry.sessionUri);
    await host.subscribe(entry.chatUri);
    if (entry.host !== host || !host.connected) throw new Error("The original VS Code executor changed. Refresh before continuing.");
    entry.attached = true;
    this.publishChat(entry);
    if (entry.host !== host) throw new Error("The original VS Code provider is unavailable.");
    if (writable && entry.session.connection?.readOnly) throw new Error("This VS Code chat is read-only.");
    return { entry, host, chat: host.chats.get(entry.chatUri)! };
  }
  async restoreSession(id: string) { return (await this.attach(id)).entry.session; }
  async getSession(id: string) { return this.entries.get(id)?.session ?? null; }
  async deleteSession(id: string) { this.clearInputs(id); this.entries.delete(id); }
  async removeSession(id: string): Promise<"local"> { await this.deleteSession(id); return "local"; }
  async listMessages(id: string): Promise<UnifiedMessage[]> {
    const { entry, host } = await this.attach(id);
    const seen = new Set<string>();
    let cursor = host.chats.get(entry.chatUri)?.turnsNextCursor;
    while (cursor) {
      if (seen.has(cursor)) throw new Error("VS Code did not advance its history cursor.");
      seen.add(cursor);
      await host.request("fetchTurns", { channel: entry.chatUri, cursor });
      cursor = host.chats.get(entry.chatUri)?.turnsNextCursor;
    }
    this.publishChat(entry);
    return projectChat(id, host.chats.get(entry.chatUri)!, entry.session.directory, entry.session.engineType);
  }
  async getHistoricalMessages(id: string) { return this.listMessages(id); }
  async sendMessage(id: string, content: MessagePromptContent[], options?: SendMessageOptions) {
    const { entry, host, chat } = await this.attach(id, true);
    if (options?.mode && options.mode !== entry.session.mode) await this.setMode(id, options.mode);
    const modelId = options?.modelId ?? chat.draft?.model?.id ?? entry.session.modelId;
    const previous = chat.draft?.model ?? chat.activeTurn?.message.model ?? chat.turns.at(-1)?.message.model;
    const model = modelId ? this.model(host, entry.provider, modelId, options?.reasoningEffort, previous) : undefined;
    const images = content.filter(part => part.type === "image");
    if (images.some(image => !image.data || !image.mimeType || !/^image\/(png|jpeg|gif|webp)$/.test(image.mimeType))) throw new Error("Invalid image attachment.");
    if (images.length && !host.root?.agents.find(agent => agent.provider === entry.provider)?.models
      .some(candidate => candidate.id === modelId && candidate.supportsVision === true)) throw new Error("This VS Code model does not advertise image support.");
    const message: Wire<Message> = { text: content.filter(part => part.type === "text").map(part => part.text).join("\n"),
      origin: { kind: "user" }, ...(model ? { model } : {}),
      attachments: images.map((image, index) => ({
        type: "embeddedResource", data: image.data!, contentType: image.mimeType!, label: `image-${index + 1}`,
      })),
    };
    const turnId = randomUUID();
    if (host.chats.get(entry.chatUri)?.activeTurn) {
      this.queued.set(turnId, { sessionId: id, clientMessageId: options?.clientMessageId, announced: false });
      try { await host.dispatch(entry.chatUri, { type: "chat/pendingMessageSet", kind: "queued", id: turnId, message }); }
      catch (error) { this.queued.delete(turnId); throw error; }
      const queued = this.queued.get(turnId);
      if (queued) {
        queued.announced = true;
        this.emit("message.queued", { sessionId: id, messageId: scopedId(id, turnId), queuePosition: host.chats.get(entry.chatUri)?.queuedMessages?.length ?? 1, clientMessageId: options?.clientMessageId });
      }
    } else await host.dispatch(entry.chatUri, { type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message });
    this.publishChat(entry);
    return projectChat(id, host.chats.get(entry.chatUri)!, entry.session.directory, entry.session.engineType).find(message => message.id === scopedId(id, turnId, "assistant"))
      ?? { id: scopedId(id, turnId), sessionId: id, role: "user" as const, parts: [], time: { created: Date.now() } };
  }
  async cancelMessage(id: string) {
    const { entry, host, chat } = await this.attach(id, true);
    if (chat.activeTurn) await host.dispatch(entry.chatUri, { type: "chat/turnCancelled",
      turnId: chat.activeTurn.id, duration: Math.max(0, Date.now() - Date.parse(chat.activeTurn.startedAt)) });
  }
  async renameSession(id: string, title: string) {
    const { entry, host } = await this.attach(id, true);
    if (host.sessions.get(entry.sessionUri)?.defaultChat !== entry.chatUri) throw new Error("Rename side chats in VS Code.");
    await host.dispatch(entry.sessionUri, { type: "session/titleChanged", title });
    this.catalogSession(host, entry.sessionUri, host.sessions.get(entry.sessionUri)!);
  }
  private hostModels(host: AgentHostConnection, provider: string): UnifiedModelInfo[] {
    return (host.root?.agents.find(agent => agent.provider === provider)?.models ?? []).filter(model => model.provider === provider).map(model => {
      const property = model.configSchema?.properties?.thinkingLevel ?? model.configSchema?.properties?.reasoningEffort;
      const efforts = (property?.enum ?? []).map(unifiedEffort).filter((value): value is ReasoningEffort => value !== undefined);
      return { modelId: model.id, name: model.name, engineType: providerEngine(provider)!,
        capabilities: { reasoning: efforts.length > 0, supportedReasoningEfforts: efforts, defaultReasoningEffort: unifiedEffort(property?.default) } };
    });
  }
  private model(host: AgentHostConnection, provider: string, id: string, effort?: ReasoningEffort | null, previous?: ModelSelection): ModelSelection {
    const model = host.root?.agents.find(agent => agent.provider === provider)?.models?.find(model => model.id === id && model.provider === provider);
    if (!model) throw new Error("This model is not available in the connected VS Code Host.");
    const config = { ...(previous?.id === id ? previous.config : {}) };
    if (effort !== undefined) {
      delete config.thinkingLevel;
      delete config.reasoningEffort;
      if (effort) {
        const key = model.configSchema?.properties?.thinkingLevel ? "thinkingLevel" : "reasoningEffort";
        const property = model.configSchema?.properties?.[key];
        const value = effort === "max" ? "xhigh" : effort === "ultra" ? "max" : effort;
        if (!property || (property.enum && !property.enum.includes(value))) throw new Error("This reasoning effort is not supported by the VS Code model.");
        config[key] = value;
      }
    }
    return { id, ...(Object.keys(config).length ? { config } : {}) };
  }
  async setModel(id: string, modelId: string) {
    const { entry, host, chat } = await this.attach(id, true);
    await host.dispatch(entry.chatUri, { type: "chat/draftChanged",
      draft: { ...chat.draft, text: chat.draft?.text ?? "", origin: { kind: "user" },
        model: this.model(host, entry.provider, modelId, undefined, chat.draft?.model) } });
    this.publishChat(entry);
  }
  async setMode(id: string, mode: string) {
    const { entry, host, chat } = await this.attach(id, true);
    const session = host.sessions.get(entry.sessionUri)!;
    const property = chat.config?.schema?.properties?.mode ?? session.config?.schema?.properties?.mode;
    if (!property || !property.enum?.includes(mode)) throw new Error("This mode is not available in VS Code.");
    if (property.chatMutable) await host.dispatch(entry.chatUri, { type: "chat/configChanged", config: { mode } });
    else if (property.sessionMutable) await host.dispatch(entry.sessionUri, { type: "session/configChanged", config: { mode } });
    else throw new Error("Change this mode in VS Code.");
    this.publishChat(entry);
  }
  async setReasoningEffort(id: string, effort: ReasoningEffort | null) {
    const { entry, host, chat } = await this.attach(id, true);
    const modelId = chat.draft?.model?.id ?? entry.session.modelId;
    if (!modelId) { if (effort) throw new Error("Choose a model before changing reasoning effort."); return; }
    const model = this.model(host, entry.provider, modelId, effort, chat.draft?.model ?? chat.activeTurn?.message.model ?? chat.turns.at(-1)?.message.model);
    await host.dispatch(entry.chatUri, { type: "chat/draftChanged",
      draft: { ...chat.draft, text: chat.draft?.text ?? "", origin: { kind: "user" }, model } });
    this.publishChat(entry);
  }
  getReasoningEffort(id: string) { return this.entries.get(id)?.session.reasoningEffort ?? null; }
  getPendingPermissions(id?: string) { return [...this.permissions.values()].filter(route => !id || route.permission.sessionId === id).map(route => route.permission); }
  getPendingQuestions(id?: string) { return [...this.questions.values()].filter(route => !id || route.question.sessionId === id).map(route => route.question); }
  async replyPermission(permissionId: string, reply: PermissionReply, sessionId?: string) {
    const pending = this.permissions.get(permissionId);
    if (!pending || (sessionId && pending.permission.sessionId !== sessionId)) throw new Error("This approval is no longer pending.");
    const { entry, host } = await this.attach(pending.permission.sessionId, true);
    const current = this.permissions.get(permissionId);
    const option = current?.permission.options.find(option => option.id === reply.optionId);
    if (!current || !option) throw new Error("This approval has changed. Refresh before replying.");
    const approved = option.type === "allow_once";
    if (current.tool.status === "pending-result-confirmation") await host.dispatch(entry.chatUri, {
      type: "chat/toolCallResultConfirmed", turnId: current.turnId, toolCallId: current.tool.toolCallId, approved,
    });
    else await host.dispatch(entry.chatUri, { type: "chat/toolCallConfirmed", turnId: current.turnId,
      toolCallId: current.tool.toolCallId, ...(current.tool.status === "pending-confirmation" && current.tool.options?.length ? { selectedOptionId: option.id } : {}),
      ...(approved ? { approved: true, confirmed: "user-action" } : { approved: false, reason: "denied" }) });
    this.publishChat(entry);
  }
  async replyQuestion(id: string, answers: string[][], sessionId?: string) {
    const pending = this.questions.get(id);
    if (!pending || (sessionId && pending.question.sessionId !== sessionId)) throw new Error("This question is no longer pending.");
    const { entry, host } = await this.attach(pending.question.sessionId, true);
    const current = this.questions.get(id);
    if (!current) throw new Error("This question has already been answered.");
    await host.dispatch(entry.chatUri, { type: "chat/inputCompleted", requestId: current.request.id,
      response: "accept", answers: inputAnswers(current.request, answers) });
    this.publishChat(entry);
  }
  async rejectQuestion(id: string, sessionId?: string) {
    const pending = this.questions.get(id);
    if (!pending || (sessionId && pending.question.sessionId !== sessionId)) throw new Error("This question is no longer pending.");
    const { entry, host } = await this.attach(pending.question.sessionId, true);
    if (!this.questions.has(id)) throw new Error("This question has already been answered.");
    await host.dispatch(entry.chatUri, { type: "chat/inputCompleted", requestId: pending.request.id, response: "decline" });
    this.publishChat(entry);
  }
}
