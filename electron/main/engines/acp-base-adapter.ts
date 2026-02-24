// ============================================================================
// ACP Base Adapter — Shared base for ACP-speaking engines (Copilot, Claude)
// Handles JSON-RPC over stdio, message routing, session/update aggregation.
// ============================================================================

import { spawn, ChildProcess } from "child_process";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { EngineAdapter } from "./engine-adapter";
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
  ToolPart,
  TextPart,
  ReasoningPart,
  PermissionOption,
} from "../../../src/types/unified";
import { inferToolFromAcp, inferToolKind } from "../../../src/types/tool-mapping";

// --- JSON-RPC types ---

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

// --- ACP-specific response types ---

interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    sessionCapabilities?: { list?: Record<string, never> };
  };
  agentInfo: { name: string; title: string; version: string };
  authMethods?: Array<{
    id: string;
    name: string;
    description: string;
    _meta?: Record<string, any>;
  }>;
}

interface AcpSessionNewResult {
  sessionId: string;
  models?: {
    availableModels: Array<{
      modelId: string;
      name: string;
      description: string;
      _meta?: Record<string, any>;
    }>;
    currentModelId?: string;
  };
  modes?: {
    availableModes: Array<{ id: string; name: string; description: string }>;
    currentModeId?: string;
  };
}

interface AcpSessionListResult {
  sessions: Array<{
    sessionId: string;
    cwd: string;
    title?: string;
    updatedAt?: string;
  }>;
}

// --- Message accumulation buffer ---

interface MessageBuffer {
  messageId: string;
  sessionId: string;
  parts: UnifiedPart[];
  textAccumulator: string;
  textPartId: string | null;
  /** Accumulator for reasoning chunks that arrive as streaming tokens */
  reasoningAccumulator: string;
  reasoningPartId: string | null;
  startTime: number;
}

/**
 * Abstract base class for ACP-speaking engine adapters.
 * Subclasses provide the binary path, args, and engine-specific overrides.
 */
export abstract class AcpBaseAdapter extends EngineAdapter {
  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private status: EngineStatus = "stopped";

  // ACP state
  private initResult: AcpInitializeResult | null = null;
  private models: UnifiedModelInfo[] = [];
  private modes: AgentMode[] = [];
  private currentModelId: string | null = null;
  private currentModeId: string | null = null;
  private authMethods: AuthMethod[] = [];
  private sessions = new Map<string, UnifiedSession>();

  // Message accumulation
  private messageBuffers = new Map<string, MessageBuffer>();

  // Track active prompt request IDs per session so cancel can resolve them
  private activePromptIds = new Map<string, number>();

  // Message history per session (ACP has no message history API)
  private messageHistory = new Map<string, UnifiedMessage[]>();

  // Permission handling
  private pendingPermissions = new Map<string, {
    rpcId: number;
    permission: UnifiedPermission;
  }>();

  // --- Abstract: subclass provides these ---

  /** The binary command to spawn (e.g., "copilot", "claude") */
  protected abstract getBinary(): string;

  /** Arguments for ACP mode (e.g., ["--acp"], ["acp"]) */
  protected abstract getArgs(): string[];

  /** Whether to use shell: true for spawn */
  protected getSpawnShell(): boolean {
    return true;
  }

  // --- JSON-RPC Communication ---

  private send(msg: object): void {
    if (!this.child?.stdin?.writable) {
      throw new Error("ACP process not running");
    }
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  private sendRequest(method: string, params?: any): Promise<any> & { requestId: number } {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0" as const, id, method, params: params ?? {} };
    this.send(msg);
    const promise = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout: ${method} (id=${id})`));
        }
      }, 120_000);
    }) as Promise<any> & { requestId: number };
    promise.requestId = id;
    return promise;
  }

  private sendResponse(id: number, result: any): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private sendErrorResponse(id: number, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private handleIncoming(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Response to our request (has id, no method)
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }

    // Notification from agent (has method, no id)
    if (msg.method && msg.id == null) {
      this.handleNotification(msg.method, msg.params);
      return;
    }

    // Reverse request from agent (has both method and id)
    if (msg.method && msg.id != null) {
      this.handleReverseRequest(msg.id, msg.method, msg.params);
      return;
    }
  }

  // --- Notification Handling ---

  private handleNotification(method: string, params: any): void {
    if (method === "session/update") {
      this.handleSessionUpdate(params);
    }
  }

  private handleSessionUpdate(params: any): void {
    const sessionId = params?.sessionId as string;
    const update = params?.update;
    if (!sessionId || !update) return;

    const type = update.sessionUpdate as string;

    switch (type) {
      case "agent_thought_chunk":
        this.handleThoughtChunk(sessionId, update);
        break;
      case "tool_call":
        this.handleToolCall(sessionId, update);
        break;
      case "tool_call_update":
        this.handleToolCallUpdate(sessionId, update);
        break;
      case "agent_message_chunk":
        this.handleMessageChunk(sessionId, update);
        break;
      case "session_info_update":
        this.handleSessionInfoUpdate(sessionId, update);
        break;
      default:
        console.warn(`[ACP] Unknown sessionUpdate type: "${type}"`, JSON.stringify(update).slice(0, 200));
        break;
    }
  }

  private getOrCreateBuffer(sessionId: string): MessageBuffer {
    let buf = this.messageBuffers.get(sessionId);
    if (!buf) {
      buf = {
        messageId: randomUUID(),
        sessionId,
        parts: [],
        textAccumulator: "",
        textPartId: null,
        reasoningAccumulator: "",
        reasoningPartId: null,
        startTime: Date.now(),
      };
      this.messageBuffers.set(sessionId, buf);
    }
    return buf;
  }

  private handleThoughtChunk(sessionId: string, update: any): void {
    const buf = this.getOrCreateBuffer(sessionId);
    const text = update.content?.text ?? "";
    buf.reasoningAccumulator += text;

    // Create or update reasoning part (accumulate like text)
    if (!buf.reasoningPartId) {
      buf.reasoningPartId = randomUUID();
    }

    const part: ReasoningPart = {
      id: buf.reasoningPartId,
      messageId: buf.messageId,
      sessionId,
      type: "reasoning",
      text: buf.reasoningAccumulator,
    };

    const existingIdx = buf.parts.findIndex((p) => p.id === buf.reasoningPartId);
    if (existingIdx >= 0) {
      buf.parts[existingIdx] = part;
    } else {
      buf.parts.push(part);
    }

    this.emit("message.part.updated", { sessionId, messageId: buf.messageId, part });
  }

  private handleToolCall(sessionId: string, update: any): void {
    const buf = this.getOrCreateBuffer(sessionId);
    // Flush any pending text and reasoning before a tool call
    this.flushTextAccumulator(buf, sessionId);
    this.flushReasoningAccumulator(buf);

    const toolCallId = update.toolCallId as string;
    const title = update.title ?? "";
    const rawInput = update.rawInput;
    const normalizedTool = inferToolFromAcp(title, rawInput);
    const kind = inferToolKind(update.kind, normalizedTool);

    const part: ToolPart = {
      id: randomUUID(),
      messageId: buf.messageId,
      sessionId,
      type: "tool",
      callId: toolCallId,
      normalizedTool,
      originalTool: title, // ACP doesn't provide tool name, use title
      title,
      kind,
      state: { status: "pending", time: { start: Date.now() } },
      locations: update.locations,
    };
    buf.parts.push(part);
    this.emit("message.part.updated", { sessionId, messageId: buf.messageId, part });
  }

  private handleToolCallUpdate(sessionId: string, update: any): void {
    const buf = this.messageBuffers.get(sessionId);
    if (!buf) return;

    const toolCallId = update.toolCallId as string;
    const partIndex = buf.parts.findIndex(
      (p) => p.type === "tool" && (p as ToolPart).callId === toolCallId,
    );
    if (partIndex === -1) return;

    const existing = buf.parts[partIndex] as ToolPart;
    const status = update.status as string;
    const now = Date.now();
    const startTime = (existing.state as any).time?.start ?? now;

    let updatedPart: ToolPart;

    if (status === "completed") {
      const rawOutput = update.rawOutput;
      updatedPart = {
        ...existing,
        state: {
          status: "completed",
          input: (existing.state as any).input ?? update.rawInput ?? null,
          output: rawOutput?.content ?? rawOutput ?? null,
          title: existing.title,
          time: { start: startTime, end: now, duration: now - startTime },
        },
        diff: rawOutput?.detailedContent ?? existing.diff,
      };
    } else if (status === "failed") {
      const rawOutput = update.rawOutput;
      updatedPart = {
        ...existing,
        state: {
          status: "error",
          input: (existing.state as any).input ?? null,
          output: rawOutput ?? null,
          error: rawOutput?.message ?? "Tool call failed",
          time: { start: startTime, end: now, duration: now - startTime },
        },
      };
    } else {
      // Handle "running" or other intermediate statuses — update state but keep it as running
      updatedPart = {
        ...existing,
        state: {
          ...existing.state,
          status: "running",
          input: update.rawInput ?? (existing.state as any).input ?? null,
          time: { start: startTime },
        },
      } as ToolPart;
    }

    buf.parts[partIndex] = updatedPart;
    this.emit("message.part.updated", {
      sessionId,
      messageId: buf.messageId,
      part: updatedPart,
    });
  }

  private handleMessageChunk(sessionId: string, update: any): void {
    const buf = this.getOrCreateBuffer(sessionId);
    const text = update.content?.text ?? "";
    buf.textAccumulator += text;

    // Create or update text part
    if (!buf.textPartId) {
      buf.textPartId = randomUUID();
    }

    const part: TextPart = {
      id: buf.textPartId,
      messageId: buf.messageId,
      sessionId,
      type: "text",
      text: buf.textAccumulator,
    };

    // Update or add in parts array
    const existingIdx = buf.parts.findIndex((p) => p.id === buf.textPartId);
    if (existingIdx >= 0) {
      buf.parts[existingIdx] = part;
    } else {
      buf.parts.push(part);
    }

    this.emit("message.part.updated", { sessionId, messageId: buf.messageId, part });
  }

  private handleSessionInfoUpdate(sessionId: string, update: any): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (update.title) session.title = update.title;
      session.time.updated = Date.now();
      this.emit("session.updated", { session });
    }
  }

  private flushTextAccumulator(buf: MessageBuffer, sessionId: string): void {
    if (buf.textAccumulator && buf.textPartId) {
      // Text part is already up to date from handleMessageChunk
      // Reset for next text segment
      buf.textAccumulator = "";
      buf.textPartId = null;
    }
  }

  /** Reset reasoning accumulator so next thought chunk starts a new reasoning part */
  private flushReasoningAccumulator(buf: MessageBuffer): void {
    if (buf.reasoningAccumulator && buf.reasoningPartId) {
      // Reasoning part is already up to date from handleThoughtChunk
      // Reset so next thought chunk starts a new part
      buf.reasoningAccumulator = "";
      buf.reasoningPartId = null;
    }
  }

  /** Finalize message buffer into a UnifiedMessage and clean up */
  private finalizeMessage(sessionId: string, stopReason?: string): UnifiedMessage {
    const buf = this.messageBuffers.get(sessionId);
    const now = Date.now();

    // Resolve any tool parts still in pending/running state — the prompt
    // has completed so the tools must have finished even if we never
    // received an explicit tool_call_update for them.
    if (buf?.parts) {
      for (let i = 0; i < buf.parts.length; i++) {
        const p = buf.parts[i];
        if (p.type === "tool") {
          const tp = p as ToolPart;
          if (tp.state.status === "pending" || tp.state.status === "running") {
            const startTime = (tp.state as any).time?.start ?? now;
            buf.parts[i] = {
              ...tp,
              state: {
                status: "completed",
                input: (tp.state as any).input ?? null,
                output: null,
                title: tp.title,
                time: { start: startTime, end: now, duration: now - startTime },
              },
            } as ToolPart;
          }
        }
      }
    }

    const message: UnifiedMessage = {
      id: buf?.messageId ?? randomUUID(),
      sessionId,
      role: "assistant",
      time: {
        created: buf?.startTime ?? now,
        completed: now,
      },
      parts: buf?.parts ?? [],
    };

    this.messageBuffers.delete(sessionId);
    return message;
  }

  // --- Reverse Request Handling ---

  private handleReverseRequest(id: number, method: string, params: any): void {
    switch (method) {
      case "session/request_permission":
      case "requestPermission":
        this.handlePermissionRequest(id, params);
        break;

      case "fs/read_text_file":
        this.handleFsRead(id, params);
        break;

      case "fs/write_text_file":
        this.handleFsWrite(id, params);
        break;

      default:
        // Unknown method - return error
        this.sendErrorResponse(id, -32601, `Method not supported: ${method}`);
        break;
    }
  }

  private handlePermissionRequest(rpcId: number, params: any): void {
    const sessionId = params?.sessionId as string;
    const toolCall = params?.toolCall;
    const acpOptions = params?.options as Array<{ optionId: string; kind: string; name: string }> | undefined;

    const permissionId = randomUUID();
    const diff = toolCall?.rawInput?.diff;

    // Map ACP options to unified PermissionOption format
    const options: PermissionOption[] = acpOptions
      ? acpOptions.map((o) => ({
          id: o.optionId,
          label: o.name,
          type: o.kind as PermissionOption["type"],
        }))
      : [
          { id: "allow_once", label: "Allow", type: "accept_once" },
          { id: "reject_once", label: "Reject", type: "reject" },
        ];

    const permission: UnifiedPermission = {
      id: permissionId,
      sessionId,
      engineType: this.engineType,
      toolCallId: toolCall?.toolCallId,
      title: toolCall?.title ?? "Permission request",
      kind: toolCall?.kind === "edit" ? "edit" : "read",
      diff,
      rawInput: toolCall?.rawInput,
      options,
    };

    this.pendingPermissions.set(permissionId, { rpcId, permission });
    this.emit("permission.asked", { permission });
  }

  private handleFsRead(id: number, params: any): void {
    const filePath = params?.path;
    try {
      let content = fs.readFileSync(filePath, "utf-8");
      const limit = params?.limit;
      const startLine = params?.line ?? 1;
      if (limit || startLine > 1) {
        const lines = content.split("\n");
        const start = Math.max(0, startLine - 1);
        const end = limit ? start + limit : lines.length;
        content = lines.slice(start, end).join("\n");
      }
      this.sendResponse(id, { content });
    } catch (err: any) {
      this.sendErrorResponse(id, -32000, `Failed to read file: ${err.message}`);
    }
  }

  private handleFsWrite(id: number, params: any): void {
    const filePath = params?.path;
    const content = params?.content;
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");
      this.sendResponse(id, { success: true });
    } catch (err: any) {
      this.sendErrorResponse(id, -32000, `Failed to write file: ${err.message}`);
    }
  }

  // --- EngineAdapter Implementation ---

  async start(): Promise<void> {
    if (this.child) return;

    this.status = "starting";
    this.emit("status.changed", {
      engineType: this.engineType,
      status: this.status,
    });

    const binary = this.getBinary();
    const args = this.getArgs();

    this.child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: this.getSpawnShell(),
    });

    this.rl = readline.createInterface({ input: this.child.stdout! });
    this.rl.on("line", (line) => this.handleIncoming(line));

    this.child.stderr?.on("data", (data) => {
      // Log stderr but don't treat as fatal
      const text = data.toString().trim();
      if (text) console.error(`[${this.engineType} stderr]`, text);
    });

    this.child.on("exit", (code) => {
      this.status = "stopped";
      this.child = null;
      this.rl = null;
      // Reject all pending requests before clearing
      for (const [id, { reject }] of this.pending) {
        reject(new Error(`Process exited with code ${code}`));
      }
      this.pending.clear();
      this.emit("status.changed", {
        engineType: this.engineType,
        status: "stopped",
      });
    });

    // Initialize handshake
    try {
      this.initResult = await this.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "opencode-remote", version: "0.1.0" },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      }) as AcpInitializeResult;

      this.authMethods = (this.initResult.authMethods ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        meta: m._meta,
      }));

      this.status = "running";
      this.emit("status.changed", {
        engineType: this.engineType,
        status: "running",
      });
    } catch (err: any) {
      this.status = "error";
      this.emit("status.changed", {
        engineType: this.engineType,
        status: "error",
        error: err.message,
      });
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill();
      this.child = null;
      this.rl = null;
      this.pending.clear();
      this.status = "stopped";
    }
  }

  async healthCheck(): Promise<boolean> {
    return this.child != null && this.status === "running";
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getInfo(): EngineInfo {
    return {
      type: this.engineType,
      name: this.initResult?.agentInfo?.title ?? this.engineType,
      version: this.initResult?.agentInfo?.version,
      status: this.status,
      capabilities: this.getCapabilities(),
      authMethods: this.authMethods,
    };
  }

  getAuthMethods(): AuthMethod[] {
    return this.authMethods;
  }

  // --- Sessions ---

  async createSession(directory: string): Promise<UnifiedSession> {
    const result = (await this.sendRequest("session/new", {
      cwd: directory,
      mcpServers: [],
    })) as AcpSessionNewResult;

    // Store models and modes from session response
    if (result.models) {
      this.models = result.models.availableModels.map((m) => ({
        modelId: m.modelId,
        name: m.name,
        description: m.description,
        engineType: this.engineType,
        providerId: this.engineType,
        providerName: this.initResult?.agentInfo?.title ?? this.engineType,
        meta: m._meta,
      }));
      this.currentModelId = result.models.currentModelId ?? null;
    }

    if (result.modes) {
      this.modes = result.modes.availableModes.map((m) => ({
        id: m.id,
        label: m.name,
        description: m.description,
      }));
      this.currentModeId = result.modes.currentModeId ?? null;
    }

    const session: UnifiedSession = {
      id: result.sessionId,
      engineType: this.engineType,
      directory,
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    };

    this.sessions.set(session.id, session);
    this.emit("session.created", { session });
    return session;
  }

  async listSessions(directory?: string): Promise<UnifiedSession[]> {
    try {
      const result = (await this.sendRequest("session/list", {
        cwd: directory ?? process.cwd(),
      })) as AcpSessionListResult;

      return result.sessions.map((s) => {
        const session: UnifiedSession = {
          id: s.sessionId,
          engineType: this.engineType,
          directory: s.cwd,
          title: s.title,
          time: {
            created: s.updatedAt ? new Date(s.updatedAt).getTime() : Date.now(),
            updated: s.updatedAt ? new Date(s.updatedAt).getTime() : Date.now(),
          },
        };
        this.sessions.set(session.id, session);
        return session;
      });
    } catch {
      return Array.from(this.sessions.values()).filter(
        (s) => s.directory === directory,
      );
    }
  }

  async getSession(sessionId: string): Promise<UnifiedSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async deleteSession(_sessionId: string): Promise<void> {
    this.sessions.delete(_sessionId);
    this.messageHistory.delete(_sessionId);
  }

  // --- Messages ---

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: { mode?: string; modelId?: string },
  ): Promise<UnifiedMessage> {
    // Create prompt content for ACP
    const prompt = content.map((c) => {
      if (c.type === "text") {
        return { type: "text" as const, text: c.text ?? "" };
      }
      if (c.type === "image" && c.data) {
        return { type: "image" as const, data: c.data };
      }
      return { type: "text" as const, text: c.text ?? "" };
    });

    // Create user message
    const userMessage: UnifiedMessage = {
      id: randomUUID(),
      sessionId,
      role: "user",
      time: { created: Date.now() },
      parts: content.map((c) => ({
        id: randomUUID(),
        messageId: "",
        sessionId,
        type: "text" as const,
        text: c.text ?? "",
      })),
    };
    // Fill messageId
    userMessage.parts.forEach((p) => {
      (p as any).messageId = userMessage.id;
    });
    this.emit("message.updated", { sessionId, message: userMessage });
    this.appendToHistory(sessionId, userMessage);

    // Send prompt and wait for completion
    const promptRequest = this.sendRequest("session/prompt", {
      sessionId,
      prompt,
      ...(options?.modelId ? { modelId: options.modelId } : {}),
      ...(options?.mode ? { modeId: options.mode } : {}),
    });
    this.activePromptIds.set(sessionId, promptRequest.requestId);

    let result: any;
    try {
      result = await promptRequest;
    } finally {
      this.activePromptIds.delete(sessionId);
    }

    // Finalize the assistant message from accumulated buffer
    const message = this.finalizeMessage(sessionId, (result as any)?.stopReason);
    message.modelId = this.currentModelId ?? undefined;
    message.mode = this.currentModeId ?? undefined;

    this.emit("message.updated", { sessionId, message });
    this.appendToHistory(sessionId, message);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.time.updated = Date.now();
    }

    return message;
  }

  async cancelMessage(sessionId: string): Promise<void> {
    try {
      await this.sendRequest("session/cancel", { sessionId });
    } catch {
      // Cancel may fail if no prompt is running
    }

    // Resolve the pending prompt request so sendMessage unblocks
    const promptId = this.activePromptIds.get(sessionId);
    if (promptId && this.pending.has(promptId)) {
      this.pending.get(promptId)!.resolve({ stopReason: "cancelled" });
      this.pending.delete(promptId);
      this.activePromptIds.delete(sessionId);
    }
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    return this.messageHistory.get(sessionId) ?? [];
  }

  private appendToHistory(sessionId: string, message: UnifiedMessage): void {
    if (!this.messageHistory.has(sessionId)) {
      this.messageHistory.set(sessionId, []);
    }
    this.messageHistory.get(sessionId)!.push(message);
  }

  // --- Models ---

  async listModels(): Promise<UnifiedModelInfo[]> {
    return this.models;
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.currentModelId = modelId;
    // ACP doesn't have a direct model set API — model is passed per prompt
  }

  // --- Modes ---

  getModes(): AgentMode[] {
    return this.modes;
  }

  async setMode(_sessionId: string, modeId: string): Promise<void> {
    this.currentModeId = modeId;
  }

  // --- Permissions ---

  async replyPermission(permissionId: string, reply: PermissionReply): Promise<void> {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      throw new Error(`No pending permission: ${permissionId}`);
    }

    // ACP expects: { outcome: { outcome: "selected", optionId: "..." } }
    // or: { outcome: { outcome: "cancelled" } }
    const isReject = reply.optionId === "reject_once" || reply.optionId === "reject_always" || reply.optionId === "reject";
    const result = isReject
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId: reply.optionId } };

    this.sendResponse(pending.rpcId, result);
    this.pendingPermissions.delete(permissionId);

    this.emit("permission.replied", {
      permissionId,
      optionId: reply.optionId,
    });
  }

  // --- Projects ---

  async listProjects(): Promise<UnifiedProject[]> {
    return [];
  }
}
