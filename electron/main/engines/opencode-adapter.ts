// ============================================================================
// OpenCode Adapter — HTTP REST + SSE integration with OpenCode CLI
// Merges logic from opencode-process.ts (lifecycle) and opencode-client.ts (API)
// ============================================================================

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { EngineAdapter } from "./engine-adapter";
import { normalizeToolName, inferToolKind } from "../../../src/types/tool-mapping";
import type {
  EngineType,
  EngineStatus,
  EngineCapabilities,
  EngineInfo,
  AuthMethod,
  UnifiedSession,
  UnifiedMessage,
  UnifiedPart,
  UnifiedPermission,
  UnifiedModelInfo,
  UnifiedProject,
  AgentMode,
  MessagePromptContent,
  PermissionReply,
  PermissionOption,
  ToolPart,
} from "../../../src/types/unified";

// --- OpenCode API response types (from src/types/opencode.ts) ---

interface OcSession {
  id: string;
  slug?: string;
  projectID?: string;
  directory: string;
  parentID?: string;
  title?: string;
  version?: string;
  time: { created: number; updated: number; compacting?: number; archived?: number };
  summary?: { additions: number; deletions: number; files: number };
  share?: { url: string };
}

interface OcMessage {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: { created: number; completed?: number };
  cost?: number;
  path?: { root: string; cwd: string };
  summary?: boolean;
  tokens?: { input: number; output: number; cache: { read: number; write: number }; reasoning: number };
  modelID?: string;
  providerID?: string;
  mode?: "build" | "plan" | "compaction";
  agent?: string;
  system?: string;
  error?: string;
  parts: OcPart[];
}

type OcPart =
  | { id: string; messageID: string; sessionID: string; type: "text"; text: string; synthetic?: boolean }
  | { id: string; messageID: string; sessionID: string; type: "reasoning"; text: string }
  | { id: string; messageID: string; sessionID: string; type: "file"; mime: string; filename: string; url: string }
  | { id: string; messageID: string; sessionID: string; type: "step-start" }
  | { id: string; messageID: string; sessionID: string; type: "step-finish" }
  | { id: string; messageID: string; sessionID: string; type: "snapshot"; files: string[] }
  | { id: string; messageID: string; sessionID: string; type: "patch"; content: string; path: string }
  | { id: string; messageID: string; sessionID: string; type: "tool"; callID: string; tool: string; state: OcToolState };

type OcToolState =
  | { status: "pending" }
  | { status: "running"; input: any; time: { start: number } }
  | { status: "completed"; input: any; output: any; title?: string; time: { start: number; end: number; duration: number }; metadata?: any }
  | { status: "error"; input: any; output?: any; error: string; time: { start: number; end: number; duration: number } };

interface OcProvider {
  id: string;
  source: string;
  name: string;
  env: string[];
  options: Record<string, any>;
  models: Record<string, OcModel>;
}

interface OcModel {
  id: string;
  providerID: string;
  name: string;
  family: string;
  status: string;
  cost: { input: number; output: number; cache: { read: number; write: number } };
  limit: { context: number; output: number };
  capabilities: { temperature: boolean; reasoning: boolean; attachment: boolean; toolcall: boolean };
  release_date: string;
}

interface OcProviderResponse {
  all: OcProvider[];
  connected: string[];
  default: Record<string, string>;
  recent?: string[];
  favorite?: string[];
}

interface OcPermission {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
}

// --- SSE event parsed structure ---
interface SseEvent {
  type: string;
  data: any;
}

/**
 * OpenCode Engine Adapter
 * Manages the OpenCode CLI process and communicates via HTTP REST + SSE.
 */
export class OpenCodeAdapter extends EngineAdapter {
  readonly engineType: EngineType = "opencode";

  private child: ChildProcess | null = null;
  private port: number;
  private status: EngineStatus = "stopped";
  private sseAbort: AbortController | null = null;
  private sseRequest: http.ClientRequest | null = null;

  // Cached state
  private providers: OcProviderResponse | null = null;
  private sessions = new Map<string, UnifiedSession>();
  private currentDirectory: string | null = null;

  // Message completion tracking: sessionId → resolve + collected parts
  private pendingMessages = new Map<string, {
    resolve: (msg: UnifiedMessage) => void;
    messageId: string | null;
    assistantParts: UnifiedPart[];
  }>();

  constructor(options?: { port?: number; binaryPath?: string }) {
    super();
    this.port = options?.port ?? 4096;
  }

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  // --- Binary resolution ---

  private getOpencodePath(): string {
    // In packaged Electron, use bundled binary
    try {
      const { app } = require("electron");
      if (app.isPackaged) {
        const platform = process.platform;
        const arch = process.arch;
        const binaryName = platform === "win32" ? "opencode.exe" : "opencode";
        return path.join(process.resourcesPath, "bin", `${platform}-${arch}`, binaryName);
      }
    } catch {
      // Not in Electron context
    }
    return "opencode"; // Use system PATH
  }

  // --- HTTP helpers ---

  private async httpRequest<T>(
    endpoint: string,
    options?: { method?: string; body?: string; directory?: string },
  ): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const dir = options?.directory ?? this.currentDirectory;
    if (dir) {
      headers["x-opencode-directory"] = dir;
    }

    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      method: options?.method ?? "GET",
      headers,
      body: options?.body,
    });

    if (!response.ok) {
      throw new Error(`OpenCode API error: ${response.status} ${response.statusText} (${endpoint})`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // --- SSE connection ---

  private connectSSE(directory: string): void {
    this.disconnectSSE();

    const sseUrl = `${this.baseUrl}/global/event?directory=${encodeURIComponent(directory)}`;
    this.sseAbort = new AbortController();

    // Use http.get for Node.js SSE consumption (no browser EventSource available)
    const url = new URL(sseUrl);
    this.sseRequest = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          console.error(`[OpenCode SSE] Unexpected status: ${res.statusCode}`);
          return;
        }

        let buffer = "";
        res.setEncoding("utf-8");

        res.on("data", (chunk: string) => {
          buffer += chunk;

          // SSE messages are separated by double newlines
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            this.parseSseMessage(part);
          }
        });

        res.on("end", () => {
          // SSE connection closed — reconnect after delay if still running
          if (this.status === "running" && this.currentDirectory) {
            setTimeout(() => {
              if (this.status === "running" && this.currentDirectory) {
                this.connectSSE(this.currentDirectory);
              }
            }, 2000);
          }
        });
      },
    );

    this.sseRequest.on("error", (err) => {
      if (this.status === "running") {
        console.error("[OpenCode SSE] Connection error:", err.message);
        // Reconnect after delay
        setTimeout(() => {
          if (this.status === "running" && this.currentDirectory) {
            this.connectSSE(this.currentDirectory);
          }
        }, 2000);
      }
    });
  }

  private disconnectSSE(): void {
    if (this.sseRequest) {
      this.sseRequest.destroy();
      this.sseRequest = null;
    }
    if (this.sseAbort) {
      this.sseAbort.abort();
      this.sseAbort = null;
    }
  }

  private parseSseMessage(raw: string): void {
    // SSE format: "data: {...json...}\n"
    // May have "event:" and "id:" fields which we ignore
    const lines = raw.split("\n");
    let jsonData = "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        jsonData += line.slice(6);
      } else if (line.startsWith("data:")) {
        jsonData += line.slice(5);
      }
    }

    if (!jsonData) return;

    try {
      const parsed = JSON.parse(jsonData);
      if (!parsed.payload) return;

      const eventType = parsed.payload.type as string;
      const properties = parsed.payload.properties;

      this.handleSseEvent(eventType, properties);
    } catch (e) {
      // Ignore unparseable SSE messages
    }
  }

  private handleSseEvent(type: string, properties: any): void {
    switch (type) {
      case "message.part.updated":
        this.handlePartUpdated(properties.part);
        break;

      case "message.updated":
        this.handleMessageUpdated(properties.info, properties.parts);
        break;

      case "session.updated":
        this.handleSessionUpdated(properties.info);
        break;

      case "session.created":
        this.handleSessionCreated(properties.info);
        break;

      case "permission.asked":
        this.handlePermissionAsked(properties);
        break;

      case "permission.replied":
        this.handlePermissionReplied(properties);
        break;
    }
  }

  // --- SSE event handlers ---

  private handlePartUpdated(ocPart: OcPart): void {
    const part = this.convertPart(ocPart);
    this.emit("message.part.updated", {
      sessionId: ocPart.sessionID,
      messageId: ocPart.messageID,
      part,
    });

    // Track parts for pending messages and detect completion via step-finish
    const pending = this.pendingMessages.get(ocPart.sessionID);
    if (pending) {
      // Skip user message parts (they have a different messageID from the assistant)
      if (pending.messageId === null) {
        // First assistant part — capture the messageID
        // User parts come first but step-start signals the assistant turn
        if (ocPart.type === "step-start") {
          pending.messageId = ocPart.messageID;
        }
      }

      if (pending.messageId && ocPart.messageID === pending.messageId) {
        // Collect assistant parts (update existing or add new)
        const existingIdx = pending.assistantParts.findIndex((p) => p.id === part.id);
        if (existingIdx >= 0) {
          pending.assistantParts[existingIdx] = part;
        } else {
          pending.assistantParts.push(part);
        }

        // step-finish signals the end of the assistant turn
        if (ocPart.type === "step-finish") {
          this.resolvePendingMessage(ocPart.sessionID);
        }
      }
    }
  }

  private handleMessageUpdated(ocMsg: OcMessage, ocParts?: OcPart[]): void {
    // Merge parts from the separate parts array if the message info has no parts
    if (ocParts && (!ocMsg.parts || ocMsg.parts.length === 0)) {
      ocMsg.parts = ocParts;
    }
    const message = this.convertMessage(ocMsg);
    this.emit("message.updated", {
      sessionId: ocMsg.sessionID,
      message,
    });

    // Resolve pending sendMessage() promise if this is the completed assistant message
    if (ocMsg.role === "assistant") {
      const pending = this.pendingMessages.get(ocMsg.sessionID);
      if (pending && (pending.messageId === null || pending.messageId === ocMsg.id)) {
        if (ocMsg.time?.completed || ocMsg.error) {
          // Use the full message from the event (it has all parts)
          this.pendingMessages.delete(ocMsg.sessionID);
          pending.resolve(message);
        } else {
          pending.messageId = ocMsg.id;
        }
      }
    }
  }

  /** Resolve a pending message with collected parts */
  private resolvePendingMessage(sessionId: string): void {
    const pending = this.pendingMessages.get(sessionId);
    if (!pending) return;

    this.pendingMessages.delete(sessionId);
    pending.resolve({
      id: pending.messageId ?? "",
      sessionId,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      parts: pending.assistantParts,
    });
  }

  private handleSessionUpdated(ocSession: OcSession): void {
    const session = this.convertSession(ocSession);
    this.sessions.set(session.id, session);
    this.emit("session.updated", { session });
  }

  private handleSessionCreated(ocSession: OcSession): void {
    const session = this.convertSession(ocSession);
    this.sessions.set(session.id, session);
    this.emit("session.created", { session });
  }

  private handlePermissionAsked(data: OcPermission): void {
    const options: PermissionOption[] = [
      { id: "once", label: "Allow once", type: "accept_once" },
      { id: "always", label: "Always allow", type: "accept_always" },
      { id: "reject", label: "Reject", type: "reject" },
    ];

    const permission: UnifiedPermission = {
      id: data.id,
      sessionId: data.sessionID,
      engineType: this.engineType,
      toolCallId: data.tool?.callID,
      title: data.permission,
      kind: "edit",
      rawInput: data.metadata,
      options,
      permission: data.permission,
      patterns: data.patterns,
    };

    this.emit("permission.asked", { permission });
  }

  private handlePermissionReplied(data: any): void {
    this.emit("permission.replied", {
      permissionId: data.id ?? data.requestID,
      optionId: data.reply ?? "unknown",
    });
  }

  // --- Type converters ---

  private convertSession(oc: OcSession): UnifiedSession {
    return {
      id: oc.id,
      engineType: this.engineType,
      directory: oc.directory,
      title: oc.title,
      parentId: oc.parentID,
      time: {
        created: oc.time.created,
        updated: oc.time.updated,
      },
      engineMeta: {
        slug: oc.slug,
        projectID: oc.projectID,
        version: oc.version,
        compacting: oc.time.compacting,
        archived: oc.time.archived,
        summary: oc.summary,
        share: oc.share,
      },
    };
  }

  private convertMessage(oc: OcMessage): UnifiedMessage {
    return {
      id: oc.id,
      sessionId: oc.sessionID,
      role: oc.role,
      time: {
        created: oc.time?.created ?? Date.now(),
        completed: oc.time?.completed,
      },
      parts: (oc.parts ?? []).map((p) => this.convertPart(p)),
      tokens: oc.tokens,
      cost: oc.cost,
      modelId: oc.modelID,
      providerId: oc.providerID,
      mode: oc.mode,
      error: oc.error,
      engineMeta: {
        path: oc.path,
        agent: oc.agent,
        system: oc.system,
        summary: oc.summary,
      },
    };
  }

  private convertPart(oc: OcPart): UnifiedPart {
    const base = { id: oc.id, messageId: oc.messageID, sessionId: oc.sessionID };

    switch (oc.type) {
      case "text":
        return { ...base, type: "text", text: oc.text, synthetic: oc.synthetic };
      case "reasoning":
        return { ...base, type: "reasoning", text: oc.text };
      case "file":
        return { ...base, type: "file", mime: oc.mime, filename: oc.filename, url: oc.url };
      case "step-start":
        return { ...base, type: "step-start" };
      case "step-finish":
        return { ...base, type: "step-finish" };
      case "snapshot":
        return { ...base, type: "snapshot", files: oc.files };
      case "patch":
        return { ...base, type: "patch", content: oc.content, path: oc.path };
      case "tool": {
        const normalizedTool = normalizeToolName("opencode", oc.tool);
        const kind = inferToolKind(undefined, normalizedTool);
        const part: ToolPart = {
          ...base,
          type: "tool",
          callId: oc.callID,
          normalizedTool,
          originalTool: oc.tool,
          title: (oc.state as any)?.title ?? oc.tool,
          kind,
          state: oc.state,
        };
        return part;
      }
    }
  }

  private convertProviders(response: OcProviderResponse): UnifiedModelInfo[] {
    const models: UnifiedModelInfo[] = [];
    for (const provider of response.all) {
      // Only include connected providers
      if (!response.connected.includes(provider.id)) continue;

      for (const model of Object.values(provider.models)) {
        models.push({
          // Encode as "providerId/modelId" so sendMessage can decode
          modelId: `${provider.id}/${model.id}`,
          name: model.name,
          description: `${model.family} (${provider.name})`,
          engineType: this.engineType,
          providerId: provider.id,
          providerName: provider.name,
          cost: model.cost,
          capabilities: model.capabilities,
          meta: {
            status: model.status,
            releaseDate: model.release_date,
            limits: model.limit,
            source: provider.source,
          },
        });
      }
    }
    return models;
  }

  // --- EngineAdapter Implementation ---

  async start(): Promise<void> {
    if (this.child) return;

    this.status = "starting";
    this.emit("status.changed", { engineType: this.engineType, status: this.status });

    const opencodePath = this.getOpencodePath();

    const args = ["serve", "--hostname", "127.0.0.1", "--port", this.port.toString(), "--cors"];

    if (process.platform === "win32") {
      // On Windows, use shell but pass as single command string to avoid DEP0190
      this.child = spawn(
        `${opencodePath} ${args.join(" ")}`,
        [],
        {
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
          shell: true,
        },
      );
    } else {
      this.child = spawn(
        opencodePath,
        args,
        {
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    }

    this.child.stdout?.on("data", (data) => {
      // OpenCode stdout logging
    });

    this.child.stderr?.on("data", (data) => {
      const text = data.toString().trim();
      if (text) console.error("[opencode stderr]", text);
    });

    this.child.on("close", (code) => {
      this.status = "stopped";
      this.child = null;
      this.disconnectSSE();
      this.emit("status.changed", { engineType: this.engineType, status: "stopped" });
    });

    this.child.on("error", (err) => {
      this.status = "error";
      this.child = null;
      this.emit("status.changed", {
        engineType: this.engineType,
        status: "error",
        error: err.message,
      });
    });

    // Wait for API to be ready
    await this.waitForReady();

    // Fetch initial provider data
    try {
      this.providers = await this.httpRequest<OcProviderResponse>("/provider");
    } catch {
      // Provider fetch may fail initially, will retry on listModels()
    }

    this.status = "running";
    this.emit("status.changed", { engineType: this.engineType, status: "running" });
  }

  private async waitForReady(timeout = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const response = await fetch(`${this.baseUrl}/provider`);
        if (response.ok) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("OpenCode service failed to start within timeout");
  }

  async stop(): Promise<void> {
    this.disconnectSSE();

    if (this.child) {
      const pid = this.child.pid;

      if (process.platform === "win32" && pid) {
        // On Windows, shell-spawned processes need taskkill /tree to kill the child process
        try {
          const { execSync } = require("child_process");
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
        } catch {
          // Process may already be gone
        }
      } else {
        this.child.kill("SIGTERM");
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.child) {
            if (process.platform !== "win32") {
              this.child.kill("SIGKILL");
            }
          }
          resolve();
        }, 5000);

        this.child?.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.child = null;
    }

    this.status = "stopped";

    // Reject any pending messages
    for (const [sessionId, pending] of this.pendingMessages) {
      pending.resolve({
        id: pending.messageId ?? "",
        sessionId,
        role: "assistant",
        time: { created: Date.now() },
        parts: pending.assistantParts,
        error: "Engine stopped",
      });
    }
    this.pendingMessages.clear();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/provider`);
      return response.ok;
    } catch {
      return false;
    }
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getInfo(): EngineInfo {
    return {
      type: this.engineType,
      name: "OpenCode",
      version: undefined,
      status: this.status,
      capabilities: this.getCapabilities(),
    };
  }

  getCapabilities(): EngineCapabilities {
    return {
      providerModelHierarchy: true,
      dynamicModes: false,
      messageCancellation: true,
      permissionAlways: true,
      imageAttachment: false,
      loadSession: true,
      listSessions: true,
      availableModes: this.getModes(),
    };
  }

  getAuthMethods(): AuthMethod[] {
    return []; // OpenCode uses env-based auth (API keys)
  }

  // --- Sessions ---

  async createSession(directory: string): Promise<UnifiedSession> {
    this.currentDirectory = directory;

    // Ensure SSE is connected for this directory
    this.connectSSE(directory);

    const ocSession = await this.httpRequest<OcSession>("/session", {
      method: "POST",
      body: JSON.stringify({ title: `Session - ${new Date().toISOString()}` }),
      directory,
    });

    const session = this.convertSession(ocSession);
    this.sessions.set(session.id, session);
    return session;
  }

  async listSessions(directory?: string): Promise<UnifiedSession[]> {
    const dir = directory ?? this.currentDirectory ?? "";
    const endpoint = dir
      ? `/session?directory=${encodeURIComponent(dir)}`
      : "/session";
    const ocSessions = await this.httpRequest<OcSession[]>(
      endpoint,
      dir ? { directory: dir } : undefined,
    );

    return ocSessions.map((oc) => {
      const session = this.convertSession(oc);
      this.sessions.set(session.id, session);
      return session;
    });
  }

  async getSession(sessionId: string): Promise<UnifiedSession | null> {
    // Try cache first
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;

    try {
      const oc = await this.httpRequest<OcSession>(`/session/${sessionId}`);
      const session = this.convertSession(oc);
      this.sessions.set(session.id, session);
      return session;
    } catch {
      return null;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.httpRequest(`/session/${sessionId}`, { method: "DELETE" });
    this.sessions.delete(sessionId);
  }

  // --- Messages ---

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: { mode?: string; modelId?: string },
  ): Promise<UnifiedMessage> {
    // Get session directory for SSE connection
    const session = this.sessions.get(sessionId);
    if (session && !this.sseRequest) {
      this.connectSSE(session.directory);
    }

    // Build OpenCode message body
    const parts = content.map((c) => {
      if (c.type === "text") return { type: "text" as const, text: c.text ?? "" };
      return { type: "text" as const, text: c.text ?? "" };
    });

    const body: any = { parts };
    if (options?.mode) body.agent = options.mode;
    if (options?.modelId) {
      // OpenCode modelId is encoded as "providerId/modelId"
      const slashIdx = options.modelId.indexOf("/");
      if (slashIdx > 0) {
        body.model = {
          providerID: options.modelId.slice(0, slashIdx),
          modelID: options.modelId.slice(slashIdx + 1),
        };
      }
    }

    const dir = session?.directory ?? this.currentDirectory;

    // Create a promise that will be resolved when SSE delivers step-finish or message.updated
    const messagePromise = new Promise<UnifiedMessage>((resolve) => {
      this.pendingMessages.set(sessionId, { resolve, messageId: null, assistantParts: [] });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.pendingMessages.has(sessionId)) {
          this.pendingMessages.delete(sessionId);
          resolve({
            id: "",
            sessionId,
            role: "assistant",
            time: { created: Date.now() },
            parts: [],
            error: "Message timeout",
          });
        }
      }, 300_000);
    });

    // Fire the POST (doesn't return the full message — content comes via SSE)
    await this.httpRequest(`/session/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify(body),
      directory: dir ?? undefined,
    });

    // Wait for SSE to deliver the complete assistant response
    return messagePromise;
  }

  async cancelMessage(sessionId: string): Promise<void> {
    const pending = this.pendingMessages.get(sessionId);
    if (pending) {
      this.pendingMessages.delete(sessionId);
      pending.resolve({
        id: pending.messageId ?? "",
        sessionId,
        role: "assistant",
        time: { created: Date.now() },
        parts: pending.assistantParts,
        error: "Cancelled",
      });
    }
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    // OpenCode API returns Array<{ info: Message, parts: Part[] }>
    const rawMessages = await this.httpRequest<Array<{ info: OcMessage; parts: OcPart[] }>>(
      `/session/${sessionId}/message`,
    );
    return rawMessages.map((wrapper) => {
      const oc = wrapper.info;
      if (!oc.parts || oc.parts.length === 0) {
        oc.parts = wrapper.parts;
      }
      return this.convertMessage(oc);
    });
  }

  // --- Models ---

  async listModels(): Promise<UnifiedModelInfo[]> {
    // Refresh provider data
    this.providers = await this.httpRequest<OcProviderResponse>("/provider");
    return this.convertProviders(this.providers);
  }

  async setModel(_sessionId: string, _modelId: string): Promise<void> {
    // OpenCode doesn't have per-session model switching via API
    // Model is specified per-message in sendMessage()
  }

  // --- Modes ---

  getModes(): AgentMode[] {
    return [
      { id: "build", label: "Build", description: "Default build mode" },
      { id: "plan", label: "Plan", description: "Planning mode — no file changes" },
    ];
  }

  async setMode(_sessionId: string, _modeId: string): Promise<void> {
    // Mode is specified per-message via agent field
  }

  // --- Permissions ---

  async replyPermission(permissionId: string, reply: PermissionReply): Promise<void> {
    // Map unified optionId to OpenCode reply format
    let ocReply: "once" | "always" | "reject";
    switch (reply.optionId) {
      case "once":
      case "accept_once":
      case "allow_once":
        ocReply = "once";
        break;
      case "always":
      case "accept_always":
      case "allow_always":
        ocReply = "always";
        break;
      default:
        ocReply = "reject";
        break;
    }

    await this.httpRequest(`/permission/${permissionId}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply: ocReply }),
    });

    this.emit("permission.replied", {
      permissionId,
      optionId: reply.optionId,
    });
  }

  // --- Projects ---

  async listProjects(): Promise<UnifiedProject[]> {
    try {
      const projects = await this.httpRequest<Array<{
        id: string;
        worktree: string;
        name?: string;
        icon?: { url?: string; override?: string; color?: string };
        time: { created: number; updated: number };
      }>>("/project");

      return projects.map((p) => ({
        id: p.id,
        directory: p.worktree,
        name: p.name,
        engineType: this.engineType as EngineType,
        engineMeta: { icon: p.icon },
      }));
    } catch {
      return [];
    }
  }
}
