// ============================================================================
// OpenCode Adapter — Integration via @opencode-ai/sdk (v2)
//
// Uses the official SDK for all communication with the OpenCode server.
// No raw HTTP requests, no manual SSE parsing, no hand-maintained types.
// ============================================================================

import * as net from "net";
import { execFile, spawn } from "child_process";
import {
  createOpencodeClient,
  type OpencodeClient,
  type ServerOptions,
  type Session as SdkSession,
  type Event as SdkEvent,
  type GlobalEvent as SdkGlobalEvent,
  type Part as SdkPart,
  type ToolState as SdkToolState,
  type ProviderListResponse,
  type QuestionRequest as SdkQuestionRequest,
} from "@opencode-ai/sdk/v2";

const IS_WIN = process.platform === "win32";

/**
 * Local replacement for SDK's createOpencodeServer().
 * The SDK's version uses spawn() without shell:true, which fails on Windows
 * because `opencode` is installed as `opencode.cmd` and Node's spawn without
 * shell can't resolve .cmd files.
 *
 * On non-Windows platforms this behaves identically to the SDK version.
 */
function createOpencodeServer(options?: ServerOptions): Promise<{ url: string; close(): void }> {
  const opts = Object.assign(
    { hostname: "127.0.0.1", port: 4096, timeout: 5000 },
    options ?? {},
  );

  const args = [`serve`, `--hostname=${opts.hostname}`, `--port=${opts.port}`];
  if (opts.config?.logLevel) args.push(`--log-level=${opts.config.logLevel}`);

  // Build a clean env for the child process:
  // - Remove ELECTRON_RUN_AS_NODE which leaks from Electron/Halo and can
  //   interfere with Bun's uv_spawn when opencode tries to execute bash.
  // - Inject OPENCODE_CONFIG_CONTENT for config overlay.
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(opts.config ?? {});

  // On Windows, spawn() can't resolve .cmd files without shell:true.
  // We build the full command string to avoid the DEP0190 deprecation warning
  // (passing args array + shell:true triggers it).
  const proc = IS_WIN
    ? spawn(
        `opencode ${args.join(" ")}`,
        [],
        {
          signal: opts.signal,
          shell: true,
          env: childEnv,
        },
      )
    : spawn(`opencode`, args, {
        signal: opts.signal,
        env: childEnv,
      });

  const url = new Promise<string>((resolve, reject) => {
    const id = setTimeout(() => {
      reject(new Error(`Timeout waiting for server to start after ${opts.timeout}ms`));
    }, opts.timeout);

    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.startsWith("opencode server listening")) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (!match) {
            throw new Error(`Failed to parse server url from output: ${line}`);
          }
          clearTimeout(id);
          resolve(match[1]);
          return;
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    // Attach error handlers to stdio streams to prevent EPIPE from becoming
    // an uncaughtException when the child process exits before we finish
    // reading/writing. Without these, broken-pipe errors bubble up and
    // electron-log's default handler shows an error dialog to the user.
    proc.stdout?.on("error", () => {});
    proc.stderr?.on("error", () => {});
    proc.stdin?.on("error", () => {});

    proc.on("exit", (code) => {
      clearTimeout(id);
      let msg = `Server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });

    proc.on("error", (error) => {
      clearTimeout(id);
      reject(error);
    });

    if (opts.signal) {
      opts.signal.addEventListener("abort", () => {
        clearTimeout(id);
        reject(new Error("Aborted"));
      });
    }
  });

  return url.then((resolvedUrl) => ({
    url: resolvedUrl,
    close() {
      if (IS_WIN) {
        // On Windows, proc.kill() sends SIGTERM which doesn't reliably kill
        // child processes spawned via .cmd. Use taskkill /T to kill the process tree.
        if (proc.pid) {
          spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
        }
      } else {
        proc.kill();
      }
    },
  }));
}
import { EngineAdapter } from "./engine-adapter";
import { openCodeLog } from "../services/logger";
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
  UnifiedQuestion,
  UnifiedModelInfo,
  ModelListResult,
  UnifiedProject,
  AgentMode,
  MessagePromptContent,
  PermissionReply,
  PermissionOption,
  QuestionInfo,
  ToolPart,
} from "../../../src/types/unified";

/**
 * OpenCode Engine Adapter
 * Manages the OpenCode server process via SDK and communicates via SDK client.
 */
export class OpenCodeAdapter extends EngineAdapter {
  readonly engineType: EngineType = "opencode";

  private server: { url: string; close(): void } | null = null;
  private port: number;
  private status: EngineStatus = "stopped";
  private version: string | undefined;
  private connectedProviders: string[] = [];
  private client: OpencodeClient | null = null;

  // SSE event loop abort
  private sseAbortController: AbortController | null = null;

  // Cached state
  private sessions = new Map<string, UnifiedSession>();
  private currentDirectory: string | null = null;

  // Message completion tracking: sessionId → resolve + collected parts
  private pendingMessages = new Map<string, {
    resolve: (msg: UnifiedMessage) => void;
    messageId: string | null;
    assistantParts: UnifiedPart[];
    timeoutTimer: ReturnType<typeof setTimeout> | null;
    firstEventTimer: ReturnType<typeof setTimeout> | null;
    promptSent: boolean;
  }>();

  // Sessions that have been cancelled — ignore SSE events for these until next sendMessage
  private cancelledSessions = new Set<string>();

  // Cache of SDK parts by partID for applying message.part.delta increments
  private partCache = new Map<string, SdkPart>();

  // Cache of the last emitted assistant message per session, used to construct the
  // final message when session.status: idle arrives (see resolveSessionIdle).
  private lastEmittedMessage = new Map<string, UnifiedMessage>();

  constructor(options?: { port?: number }) {
    super();
    this.port = options?.port ?? 4096;
  }

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  // --- SDK client management ---

  private createClient(directory?: string): OpencodeClient {
    return createOpencodeClient({
      baseUrl: this.baseUrl,
      ...(directory ? { directory } : {}),
    });
  }

  private ensureClient(): OpencodeClient {
    if (!this.client) {
      this.client = this.createClient(this.currentDirectory ?? undefined);
    }
    return this.client;
  }

  /**
   * Recreate the client with a new directory context.
   * The SDK bakes the x-opencode-directory header into the client instance,
   * so we need a fresh client when switching directories.
   */
  private switchDirectory(directory: string): void {
    if (this.currentDirectory === directory && this.client) return;
    this.currentDirectory = directory;
    this.client = this.createClient(directory);
  }

  // --- Version fetch ---

  private fetchVersion(): Promise<string | undefined> {
    return new Promise((resolve) => {
      execFile("opencode", ["--version"], { timeout: 5000, shell: IS_WIN }, (err, stdout) => {
        if (err) {
          resolve(undefined);
          return;
        }
        const ver = stdout.trim();
        resolve(ver || undefined);
      });
    });
  }

  /**
   * Check if the target port is already occupied and try to kill the occupying process.
   * This handles orphaned opencode processes from previous crashes or unclean exits.
   */
  private async killOrphanedProcess(): Promise<void> {
    const inUse = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
      socket.connect(this.port, "127.0.0.1");
    });

    if (!inUse) return;

    openCodeLog.warn(`Port ${this.port} is already in use, attempting to kill orphaned process...`);

    if (IS_WIN) {
      // On Windows, find the PID via PowerShell and kill it
      await new Promise<void>((resolve) => {
        const ps = `Get-NetTCPConnection -LocalPort ${this.port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`;
        execFile("powershell", ["-NoProfile", "-Command", ps], { timeout: 5000 }, (err) => {
          if (err) openCodeLog.warn("Failed to kill orphaned process:", err.message);
          resolve();
        });
      });
    } else {
      // On Unix, use fuser or lsof
      await new Promise<void>((resolve) => {
        execFile("fuser", ["-k", `${this.port}/tcp`], { timeout: 5000 }, (err) => {
          if (err) openCodeLog.warn("Failed to kill orphaned process:", err.message);
          resolve();
        });
      });
    }

    // Brief wait for port to be released
    await new Promise((r) => setTimeout(r, 500));
  }

  // --- SSE connection via SDK (global event stream, all projects) ---

  private connectSSE(): void {
    this.disconnectSSE();

    this.sseAbortController = new AbortController();
    const signal = this.sseAbortController.signal;

    // Global events don't need a directory — they receive events from all projects.
    // Use a bare client (no directory header) for SSE.
    const sseClient = this.createClient();

    const startStream = async () => {
      try {
        const result = await sseClient.global.event();

        for await (const globalEvent of result.stream) {
          if (signal.aborted) break;

          const event = globalEvent as SdkGlobalEvent;
          if (event?.payload) {
            this.handleSdkEvent(event.payload);
          }
        }
      } catch (err: any) {
        if (signal.aborted) return;
        openCodeLog.error("SSE stream error:", err?.message ?? err);
      }

      // Reconnect after delay if still running
      if (!signal.aborted && this.status === "running") {
        setTimeout(() => {
          if (!signal.aborted && this.status === "running") {
            this.connectSSE();
          }
        }, 2000);
      }
    };

    startStream();
  }

  private disconnectSSE(): void {
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }
  }

  // --- SSE event dispatch ---

  /** Clear the first-event timer for a session (called when any SSE event arrives) */
  private clearFirstEventTimer(sessionId: string): void {
    const pending = this.pendingMessages.get(sessionId);
    if (pending?.firstEventTimer) {
      clearTimeout(pending.firstEventTimer);
      pending.firstEventTimer = null;
    }
  }

  private handleSdkEvent(event: SdkEvent): void {
    switch (event.type) {
      case "message.part.updated":
        this.handlePartUpdated(event.properties.part);
        break;

      case "message.part.delta":
        this.handlePartDelta(event.properties as any);
        break;

      case "message.updated":
        this.handleMessageUpdated(event.properties.info);
        break;

      case "session.updated":
        this.handleSessionUpdated(event.properties.info);
        break;

      case "session.created":
        this.handleSessionCreated(event.properties.info);
        break;

      case "permission.asked":
        this.handlePermissionAsked(event.properties);
        break;

      case "permission.replied":
        this.handlePermissionReplied(event.properties);
        break;

      case "question.asked":
        this.handleQuestionAsked(event.properties);
        break;

      case "question.replied":
        this.handleQuestionReplied(event.properties);
        break;

      case "question.rejected":
        this.handleQuestionRejected(event.properties);
        break;

      case "session.status":
        this.handleSessionStatus(event.properties as any);
        break;

      case "session.idle":
        this.handleSessionIdleEvent(event.properties as any);
        break;
    }
  }

  // --- SSE event handlers ---

  private handlePartUpdated(sdkPart: SdkPart): void {
    if (!sdkPart) return;

    const sessionID = (sdkPart as any).sessionID;
    const messageID = (sdkPart as any).messageID;
    const partID = (sdkPart as any).id;

    // Ignore SSE events for cancelled sessions
    if (sessionID && this.cancelledSessions.has(sessionID)) return;

    // First SSE event for this session — clear the first-event timeout
    if (sessionID) this.clearFirstEventTimer(sessionID);

    // Cache the SDK part for delta accumulation
    if (partID) {
      this.partCache.set(partID, { ...sdkPart });
    }

    const part = this.convertPart(sdkPart);
    this.emit("message.part.updated", {
      sessionId: sessionID,
      messageId: messageID,
      part,
    });

    // Track parts for pending messages and detect completion via step-finish
    if (sessionID) {
      const pending = this.pendingMessages.get(sessionID);
      if (pending) {
        if (pending.messageId === null) {
          if (sdkPart.type === "step-start") {
            pending.messageId = messageID;
          }
        }

        if (pending.messageId && messageID === pending.messageId) {
          const existingIdx = pending.assistantParts.findIndex((p) => p.id === part.id);
          if (existingIdx >= 0) {
            pending.assistantParts[existingIdx] = part;
          } else {
            pending.assistantParts.push(part);
          }
        }
      }
    }
  }

  private handlePartDelta(props: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: string;
    delta: string;
  }): void {
    const { sessionID, messageID, partID, field, delta } = props;
    if (!sessionID || !partID) return;

    // Ignore SSE events for cancelled sessions
    if (this.cancelledSessions.has(sessionID)) return;

    // First SSE event for this session — clear the first-event timeout
    this.clearFirstEventTimer(sessionID);

    // Get or create cached part
    let cached = this.partCache.get(partID);
    if (!cached) {
      // Part not seen yet — create a minimal placeholder based on field
      const placeholder = {
        type: field === "reasoning" ? "reasoning" : "text",
        id: partID,
        messageID,
        sessionID,
      } as SdkPart;
      if (field === "text" || field === "reasoning") {
        (placeholder as any)[field] = "";
      }
      this.partCache.set(partID, placeholder);
      cached = placeholder;
    }

    // Append delta to the specified field
    if (field in (cached as any)) {
      (cached as any)[field] = ((cached as any)[field] ?? "") + delta;
    } else {
      (cached as any)[field] = delta;
    }

    // Convert and re-emit as message.part.updated so the frontend receives
    // the accumulated text progressively
    const part = this.convertPart(cached);
    this.emit("message.part.updated", {
      sessionId: sessionID,
      messageId: messageID,
      part,
    });
  }

  private handleMessageUpdated(sdkMsg: any): void {
    const sessionID = sdkMsg?.sessionID;
    if (!sessionID) return;

    // Ignore SSE events for cancelled sessions
    if (this.cancelledSessions.has(sessionID)) return;

    // First SSE event for this session — clear the first-event timeout
    this.clearFirstEventTimer(sessionID);

    // Skip user messages — the frontend already handles them via optimistic insert.
    // OpenCode SSE pushes message.updated for all roles, but re-emitting user messages
    // causes duplicates in the UI.
    if (sdkMsg.role === "user") return;

    const message = this.convertMessage(sdkMsg);

    if (sdkMsg.role === "assistant") {
      const pending = this.pendingMessages.get(sessionID);
      if (pending) {
        // Track the message ID for this pending turn
        if (pending.messageId === null || pending.messageId === sdkMsg.id) {
          pending.messageId = sdkMsg.id;
        }

        if (sdkMsg.time?.completed || sdkMsg.error) {
          // Cache the full message for resolveSessionIdle to use later.
          // DON'T resolve the pending promise here — wait for session.status: idle
          // which is the authoritative signal that the entire agent loop has finished.
          // Resolving here causes the stop button to disappear prematurely when
          // intermediate assistant messages complete during multi-step agent loops.
          this.lastEmittedMessage.set(sessionID, message);

          // Emit a stripped copy without time.completed and error so the frontend
          // (Chat.tsx:899-904) doesn't clear the sending state prematurely.
          const strippedMessage: UnifiedMessage = {
            ...message,
            time: { created: message.time.created },
            error: undefined,
          };
          this.emit("message.updated", {
            sessionId: sessionID,
            message: strippedMessage,
          });
          return;
        }
      }
    }

    this.emit("message.updated", {
      sessionId: sessionID,
      message,
    });
  }

  private handleSessionStatus(data: { sessionID: string; status: { type: string } }): void {
    const sessionID = data?.sessionID;
    if (!sessionID) return;
    if (this.cancelledSessions.has(sessionID)) return;

    if (data.status?.type === "idle") {
      this.resolveSessionIdle(sessionID);
    }
  }

  private handleSessionIdleEvent(data: { sessionID: string }): void {
    const sessionID = data?.sessionID;
    if (!sessionID) return;
    if (this.cancelledSessions.has(sessionID)) return;

    // session.idle is the deprecated form of session.status: idle.
    // Both are emitted by OpenCode — handle whichever arrives first.
    this.resolveSessionIdle(sessionID);
  }

  /**
   * Called when OpenCode signals that a session's agent loop has fully completed.
   * This is the authoritative "turn done" signal — resolves the pending sendMessage
   * promise and emits the final message with time.completed to the frontend.
   */
  private resolveSessionIdle(sessionID: string): void {
    const pending = this.pendingMessages.get(sessionID);
    if (!pending) return;

    // Ignore idle events that arrive before promptAsync has been sent.
    // This happens when the pre-prompt abort triggers a session.status: idle
    // SSE event that races with the pending entry registration.
    if (!pending.promptSent) return;

    if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
    if (pending.firstEventTimer) clearTimeout(pending.firstEventTimer);
    this.pendingMessages.delete(sessionID);

    // Use the last cached message (which has the real time.completed from OpenCode),
    // or fall back to constructing one from accumulated parts.
    const cachedMessage = this.lastEmittedMessage.get(sessionID);
    this.lastEmittedMessage.delete(sessionID);

    const finalMessage: UnifiedMessage = cachedMessage
      ? { ...cachedMessage, time: { ...cachedMessage.time, completed: cachedMessage.time.completed ?? Date.now() } }
      : {
          id: pending.messageId ?? "",
          sessionId: sessionID,
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
          parts: pending.assistantParts,
        };

    // Re-emit the message WITH time.completed so the frontend gets the definitive
    // "turn done" signal (Chat.tsx:899-904 will clear the sending state).
    this.emit("message.updated", {
      sessionId: sessionID,
      message: finalMessage,
    });

    pending.resolve(finalMessage);
  }

  private handleSessionUpdated(sdkSession: SdkSession): void {
    const session = this.convertSession(sdkSession);
    this.sessions.set(session.id, session);
    this.emit("session.updated", { session });
  }

  private handleSessionCreated(sdkSession: SdkSession): void {
    const session = this.convertSession(sdkSession);
    this.sessions.set(session.id, session);
    this.emit("session.created", { session });
  }

  private handlePermissionAsked(data: any): void {
    const options: PermissionOption[] = [
      { id: "once", label: "Allow once", type: "accept_once" },
      { id: "always", label: "Always allow", type: "accept_always" },
      { id: "reject", label: "Reject", type: "reject" },
    ];

    const permission: UnifiedPermission = {
      id: data.id,
      sessionId: data.sessionID,
      engineType: this.engineType,
      toolCallId: data.callID,
      title: data.title ?? data.type ?? "Permission request",
      kind: "edit",
      rawInput: data.metadata,
      options,
      permission: data.type,
      patterns: data.pattern ? (Array.isArray(data.pattern) ? data.pattern : [data.pattern]) : [],
    };

    this.emit("permission.asked", { permission });
  }

  private handlePermissionReplied(data: any): void {
    this.emit("permission.replied", {
      permissionId: data.permissionID ?? data.id,
      optionId: data.response ?? "unknown",
    });
  }

  private handleQuestionAsked(data: SdkQuestionRequest): void {
    const questions: QuestionInfo[] = (data.questions || []).map((q) => ({
      question: q.question,
      header: q.header,
      options: (q.options || []).map((o) => ({
        label: o.label,
        description: o.description,
      })),
      multiple: q.multiple,
      custom: q.custom,
    }));

    const question: UnifiedQuestion = {
      id: data.id,
      sessionId: data.sessionID,
      engineType: this.engineType,
      toolCallId: data.tool?.callID,
      questions,
    };

    this.emit("question.asked", { question });
  }

  private handleQuestionReplied(data: any): void {
    this.emit("question.replied", {
      questionId: data.requestID ?? data.id,
      answers: data.answers ?? [],
    });
  }

  private handleQuestionRejected(data: any): void {
    this.emit("question.replied", {
      questionId: data.requestID ?? data.id,
      answers: [],
    });
  }

  // --- Type converters ---

  private convertSession(sdk: SdkSession): UnifiedSession {
    return {
      id: sdk.id,
      engineType: this.engineType,
      directory: sdk.directory.replaceAll("\\", "/"),
      title: sdk.title,
      parentId: sdk.parentID,
      time: {
        created: sdk.time.created,
        updated: sdk.time.updated,
      },
      engineMeta: {
        slug: sdk.slug,
        projectID: sdk.projectID,
        version: sdk.version,
        compacting: sdk.time.compacting,
        summary: sdk.summary,
        share: sdk.share,
      },
    };
  }

  private convertMessage(sdk: any): UnifiedMessage {
    // SDK Message is a union of UserMessage | AssistantMessage
    // Both have id, sessionID, role, time
    const errorStr = sdk.error
      ? (typeof sdk.error === "string" ? sdk.error : sdk.error.message ?? sdk.error.name ?? "Error")
      : undefined;

    // Normalize OpenCode's abort error to the unified "Cancelled" convention
    // so the frontend uses a single check (error === "Cancelled") across all engines.
    const normalizedError = errorStr && (
      errorStr === "MessageAbortedError" || (sdk.error?.name === "MessageAbortedError")
    ) ? "Cancelled" : errorStr;

    return {
      id: sdk.id,
      sessionId: sdk.sessionID,
      role: sdk.role,
      time: {
        created: sdk.time?.created ?? Date.now(),
        completed: sdk.time?.completed,
      },
      parts: (sdk.parts ?? []).filter(Boolean).map((p: SdkPart) => this.convertPart(p)),
      tokens: sdk.tokens,
      cost: sdk.cost,
      modelId: sdk.modelID,
      providerId: sdk.providerID,
      mode: sdk.mode,
      error: normalizedError,
      engineMeta: {
        path: sdk.path,
        agent: sdk.agent,
        system: sdk.system,
        summary: sdk.summary,
      },
    };
  }

  private convertPart(sdk: SdkPart): UnifiedPart {
    const base = {
      id: (sdk as any).id ?? "",
      messageId: (sdk as any).messageID ?? "",
      sessionId: (sdk as any).sessionID ?? "",
    };

    switch (sdk.type) {
      case "text":
        return { ...base, type: "text", text: sdk.text, synthetic: sdk.synthetic };
      case "reasoning":
        return { ...base, type: "reasoning", text: sdk.text };
      case "file":
        return { ...base, type: "file", mime: sdk.mime, filename: sdk.filename ?? "", url: sdk.url };
      case "step-start":
        return { ...base, type: "step-start" };
      case "step-finish":
        return { ...base, type: "step-finish" };
      case "snapshot":
        // SDK SnapshotPart has `snapshot: string` (single hash), unified has `files: string[]`
        return { ...base, type: "snapshot", files: sdk.snapshot ? [sdk.snapshot] : [] };
      case "patch":
        // SDK PatchPart has `hash: string, files: string[]`, unified has `content: string, path: string`
        return { ...base, type: "patch", content: sdk.hash ?? "", path: (sdk.files?.[0] ?? "") };
      case "tool": {
        const normalizedTool = normalizeToolName("opencode", sdk.tool);
        const kind = inferToolKind(undefined, normalizedTool);
        const state = sdk.state as SdkToolState;
        const part: ToolPart = {
          ...base,
          type: "tool",
          callId: sdk.callID,
          normalizedTool,
          originalTool: sdk.tool,
          title: (state as any)?.title ?? sdk.tool,
          kind,
          state: this.convertToolState(state),
        };
        return part;
      }
      default:
        // Handle new part types (agent, retry, compaction, subtask) gracefully
        // by falling back to a text representation
        return { ...base, type: "text", text: `[${(sdk as any).type}]` };
    }
  }

  private convertToolState(sdkState: SdkToolState): import("../../../src/types/unified").ToolState {
    switch (sdkState.status) {
      case "pending":
        return { status: "pending", input: sdkState.input };
      case "running":
        return {
          status: "running",
          input: sdkState.input,
          time: { start: sdkState.time.start },
        };
      case "completed":
        return {
          status: "completed",
          input: sdkState.input,
          output: sdkState.output,
          title: sdkState.title,
          time: {
            start: sdkState.time.start,
            end: sdkState.time.end,
            duration: sdkState.time.end - sdkState.time.start,
          },
          metadata: sdkState.metadata,
        };
      case "error":
        return {
          status: "error",
          input: sdkState.input,
          error: sdkState.error,
          time: {
            start: sdkState.time.start,
            end: sdkState.time.end,
            duration: sdkState.time.end - sdkState.time.start,
          },
        };
    }
  }

  private convertProviders(response: ProviderListResponse): UnifiedModelInfo[] {
    const models: UnifiedModelInfo[] = [];
    for (const provider of response.all) {
      // Only include connected providers
      if (!response.connected.includes(provider.id)) continue;

      for (const model of Object.values(provider.models)) {
        models.push({
          modelId: `${provider.id}/${model.id}`,
          name: model.name,
          description: `${model.family ?? ""} (${provider.name})`.trim(),
          engineType: this.engineType,
          providerId: provider.id,
          providerName: provider.name,
          cost: model.cost ? {
            input: model.cost.input,
            output: model.cost.output,
            cache: {
              read: model.cost.cache_read ?? 0,
              write: model.cost.cache_write ?? 0,
            },
          } : undefined,
          capabilities: {
            temperature: model.temperature,
            reasoning: model.reasoning,
            attachment: model.attachment,
            toolcall: model.tool_call,
          },
          meta: {
            status: model.status,
            releaseDate: model.release_date,
            limits: model.limit,
          },
        });
      }
    }
    return models;
  }

  // --- EngineAdapter Implementation ---

  async start(): Promise<void> {
    if (this.server) return;

    this.status = "starting";
    this.emit("status.changed", { engineType: this.engineType, status: this.status });

    // Use SDK to spawn and manage the OpenCode server process
    try {
      // Clean up any orphaned opencode process on our port (e.g. from a previous crash)
      await this.killOrphanedProcess();

      this.server = await createOpencodeServer({
        hostname: "127.0.0.1",
        port: this.port,
        timeout: 15000,
        config: {
          server: {
            cors: ["*"],
          },
        },
      });
      openCodeLog.info(`OpenCode server started at ${this.server.url}`);
    } catch (err: any) {
      this.status = "error";
      this.emit("status.changed", {
        engineType: this.engineType,
        status: "error",
        error: err.message,
      });
      throw err;
    }

    // Initialize the SDK client
    this.client = this.createClient();

    // Start SSE event stream (global, all projects)
    this.connectSSE();

    // Fetch initial provider data via SDK
    try {
      const providerResult = await this.ensureClient().provider.list();
      if (providerResult.data) {
        const connected = providerResult.data.connected ?? [];
        this.connectedProviders = providerResult.data.all
          .filter(p => connected.includes(p.id))
          .map(p => p.name);
        openCodeLog.info(`Connected providers: ${this.connectedProviders.join(", ") || "none"}`);
      }
    } catch {
      // Provider fetch may fail initially, will retry on listModels()
    }

    // Fetch CLI version
    try {
      this.version = await this.fetchVersion();
    } catch {
      // Version fetch is non-critical
    }

    this.status = "running";
    this.emit("status.changed", { engineType: this.engineType, status: "running" });
  }

  async stop(): Promise<void> {
    this.disconnectSSE();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    this.status = "stopped";
    this.client = null;

    // Reject any pending messages
    for (const [sessionId, pending] of this.pendingMessages) {
      if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
      if (pending.firstEventTimer) clearTimeout(pending.firstEventTimer);
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
    this.lastEmittedMessage.clear();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.ensureClient().global.health();
      return !!result.data;
    } catch {
      return false;
    }
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getInfo(): EngineInfo {
    const hasProviders = this.connectedProviders.length > 0;
    return {
      type: this.engineType,
      name: "OpenCode",
      version: this.version,
      status: this.status,
      capabilities: this.getCapabilities(),
      authenticated: hasProviders,
      authMessage: hasProviders
        ? this.connectedProviders.join(", ")
        : undefined,
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
      modelSwitchable: true,
      availableModes: this.getModes(),
    };
  }

  getAuthMethods(): AuthMethod[] {
    return []; // OpenCode uses env-based auth (API keys)
  }

  // --- Sessions ---

  async createSession(directory: string): Promise<UnifiedSession> {
    this.switchDirectory(directory);

    const client = this.ensureClient();
    const result = await client.session.create({ directory });
    if (result.error) {
      throw new Error(`Failed to create session: ${JSON.stringify(result.error)}`);
    }

    const session = this.convertSession(result.data);
    this.sessions.set(session.id, session);
    return session;
  }

  async listSessions(directory?: string): Promise<UnifiedSession[]> {
    // When a specific directory is provided, list sessions for that project only.
    if (directory) {
      return this.listSessionsForDirectory(directory);
    }

    // No directory — list sessions across ALL known projects.
    // OpenCode requires a project directory context for session.list(),
    // so we fetch the project list first, then list sessions per-project.
    try {
      const projects = await this.listProjects();
      if (projects.length === 0) {
        return [];
      }

      const allSessions: UnifiedSession[] = [];
      for (const project of projects) {
        try {
          const sessions = await this.listSessionsForDirectory(project.directory);
          allSessions.push(...sessions);
        } catch (err: any) {
          openCodeLog.warn(`Failed to list sessions for project ${project.directory}:`, err?.message);
        }
      }

      return allSessions;
    } catch (err: any) {
      openCodeLog.warn("Failed to list projects for session enumeration:", err?.message);
      return [];
    }
  }

  private async listSessionsForDirectory(directory: string): Promise<UnifiedSession[]> {
    const client = this.createClient(directory);
    const result = await client.session.list({ directory });
    if (result.error) {
      throw new Error(`Failed to list sessions: ${JSON.stringify(result.error)}`);
    }

    const sessions = (result.data ?? []).map((sdk: SdkSession) => {
      const session = this.convertSession(sdk);
      this.sessions.set(session.id, session);
      return session;
    });
    return sessions;
  }

  async getSession(sessionId: string): Promise<UnifiedSession | null> {
    // Try cache first
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;

    try {
      const client = this.ensureClient();
      const result = await client.session.get({ sessionID: sessionId });
      if (result.error) return null;

      const session = this.convertSession(result.data);
      this.sessions.set(session.id, session);
      return session;
    } catch {
      return null;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Use the session's directory to create a client with the correct project context
    const session = this.sessions.get(sessionId);
    const client = session?.directory
      ? this.createClient(session.directory)
      : this.ensureClient();
    await client.session.delete({ sessionID: sessionId });
    this.sessions.delete(sessionId);
  }

  // --- Messages ---

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: { mode?: string; modelId?: string; directory?: string },
  ): Promise<UnifiedMessage> {
    // Clear cancelled state — a new message means the user wants to interact again
    this.cancelledSessions.delete(sessionId);

    const session = this.sessions.get(sessionId);

    // Build prompt parts
    const parts = content.map((c) => ({
      type: "text" as const,
      text: c.text ?? "",
    }));

    // Build model spec if provided
    let model: { providerID: string; modelID: string } | undefined;
    if (options?.modelId) {
      const slashIdx = options.modelId.indexOf("/");
      if (slashIdx > 0) {
        model = {
          providerID: options.modelId.slice(0, slashIdx),
          modelID: options.modelId.slice(slashIdx + 1),
        };
      }
    }

    const dir = session?.directory ?? options?.directory ?? this.currentDirectory ?? undefined;

    // Pre-prompt abort: clear any residual unfinished state in OpenCode.
    // This is harmless if the session is already idle, but critical for sessions
    // that were left in a "busy" state after a previous cancel or crash.
    // IMPORTANT: Must happen BEFORE registering the pending entry, otherwise the
    // abort's "session.status: idle" SSE event would consume the pending entry,
    // causing subsequent SSE events to bypass the stripping logic in
    // handleMessageUpdated (L515-543), which results in premature time.completed
    // emissions and broken step visibility in the UI.
    const client = dir ? this.createClient(dir) : this.ensureClient();
    await client.session.abort({ sessionID: sessionId }).catch(() => {});

    // Create a promise that will be resolved when SSE delivers step-finish or message.updated
    const messagePromise = new Promise<UnifiedMessage>((resolve) => {
      const entry = {
        resolve,
        messageId: null as string | null,
        assistantParts: [] as UnifiedPart[],
        timeoutTimer: null as ReturnType<typeof setTimeout> | null,
        firstEventTimer: null as ReturnType<typeof setTimeout> | null,
        promptSent: false,
      };
      this.pendingMessages.set(sessionId, entry);

      // Timeout after 5 minutes
      entry.timeoutTimer = setTimeout(() => {
        if (this.pendingMessages.has(sessionId)) {
          if (entry.firstEventTimer) clearTimeout(entry.firstEventTimer);
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

    // Fire async prompt via SDK (returns 204, response comes via SSE)
    const promptResult = await client.session.promptAsync({
      sessionID: sessionId,
      directory: dir,
      parts,
      agent: options?.mode,
      model,
    });

    // SDK uses ThrowOnError=false by default, so errors are returned in the result
    // rather than thrown. If promptAsync failed, clean up and throw immediately
    // instead of waiting for SSE (which will never arrive).
    const promptError = (promptResult as any).error;
    if (promptError) {
      const pending = this.pendingMessages.get(sessionId);
      if (pending?.timeoutTimer) clearTimeout(pending.timeoutTimer);
      if (pending?.firstEventTimer) clearTimeout(pending.firstEventTimer);
      this.pendingMessages.delete(sessionId);
      const errMsg = typeof promptError === "string"
        ? promptError
        : JSON.stringify(promptError);
      throw new Error(`Failed to send message: ${errMsg}`);
    }

    // Start first-event timer: if no SSE event arrives within 30s, the session
    // is likely stale (e.g., left in busy state after a crash or failed abort).
    const pending = this.pendingMessages.get(sessionId);
    if (pending) {
      // Mark prompt as sent so resolveSessionIdle knows this idle event is real
      // (not from the pre-prompt abort).
      pending.promptSent = true;

      pending.firstEventTimer = setTimeout(() => {
        if (this.pendingMessages.has(sessionId)) {
          openCodeLog.warn(`No SSE response within 30s for session ${sessionId} — session may be stale`);
          if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
          this.pendingMessages.delete(sessionId);
          pending.resolve({
            id: "",
            sessionId,
            role: "assistant",
            time: { created: Date.now() },
            parts: [],
            error: "No response from engine",
            staleSession: true,
          });
        }
      }, 30_000);
    }

    // Wait for SSE to deliver the complete assistant response
    return messagePromise;
  }

  async cancelMessage(sessionId: string, directory?: string): Promise<void> {
    // Fire abort via SDK to kill running processes ASAP.
    // Don't add to cancelledSessions — let OpenCode's abort response (message.updated
    // with error + session.status: idle) flow through SSE naturally so the frontend
    // gets the correct error state. The cancelledSessions mechanism would block these
    // events, leaving the frontend without an error banner or completed timestamp.
    // Use the session's directory to create a client with the correct project context.
    // OpenCode's state is scoped per-directory — sending abort with the wrong directory
    // causes SessionPrompt.cancel() to silently miss the session's AbortController.
    const session = this.sessions.get(sessionId);
    const dir = session?.directory ?? directory;
    const client = dir
      ? this.createClient(dir)
      : this.ensureClient();
    client.session.abort({ sessionID: sessionId }).catch((err: any) => {
      openCodeLog.warn("cancelMessage abort call failed:", err);
    });

    // Remove pending state so that subsequent SSE events (the abort error message,
    // session.status: idle) are NOT suppressed by handleMessageUpdated's stripping
    // logic (which only activates when a pending entry exists).
    const pending = this.pendingMessages.get(sessionId);
    if (pending) {
      if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
      if (pending.firstEventTimer) clearTimeout(pending.firstEventTimer);
      this.pendingMessages.delete(sessionId);
      this.lastEmittedMessage.delete(sessionId);

      // Resolve the sendMessage promise immediately so the UI unblocks.
      // The actual error/completed state will arrive via SSE shortly.
      pending.resolve({
        id: pending.messageId ?? "",
        sessionId,
        role: "assistant",
        time: { created: Date.now(), completed: Date.now() },
        parts: pending.assistantParts,
        error: "Cancelled",
      });
    }
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    const client = this.ensureClient();
    const result = await client.session.messages({ sessionID: sessionId });
    if (result.error) {
      throw new Error(`Failed to list messages: ${JSON.stringify(result.error)}`);
    }

    // SDK returns Array<{ info: Message, parts: Part[] }>
    return (result.data ?? []).map((wrapper: any) => {
      const msg = wrapper.info ?? wrapper;
      if (wrapper.parts && (!msg.parts || msg.parts.length === 0)) {
        msg.parts = wrapper.parts;
      }
      return this.convertMessage(msg);
    });
  }

  // --- Models ---

  async listModels(): Promise<ModelListResult> {
    const client = this.ensureClient();
    const result = await client.provider.list();
    if (result.error || !result.data) {
      throw new Error(`Failed to list providers: ${JSON.stringify(result.error)}`);
    }
    return { models: this.convertProviders(result.data) };
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
    let replyValue: "once" | "always" | "reject";
    switch (reply.optionId) {
      case "once":
      case "accept_once":
      case "allow_once":
        replyValue = "once";
        break;
      case "always":
      case "accept_always":
      case "allow_always":
        replyValue = "always";
        break;
      default:
        replyValue = "reject";
        break;
    }

    const client = this.ensureClient();
    await client.permission.reply({
      requestID: permissionId,
      reply: replyValue,
    });

    this.emit("permission.replied", {
      permissionId,
      optionId: reply.optionId,
    });
  }

  // --- Questions ---

  async replyQuestion(questionId: string, answers: string[][]): Promise<void> {
    const client = this.ensureClient();
    await client.question.reply({
      requestID: questionId,
      answers,
    });

    this.emit("question.replied", {
      questionId,
      answers,
    });
  }

  async rejectQuestion(questionId: string): Promise<void> {
    const client = this.ensureClient();
    await client.question.reject({
      requestID: questionId,
    });

    this.emit("question.replied", {
      questionId,
      answers: [],
    });
  }

  // --- Projects ---

  async listProjects(): Promise<UnifiedProject[]> {
    try {
      const client = this.ensureClient();
      const result = await client.project.list();
      if (result.error) return [];

      return (result.data ?? []).map((p) => ({
        id: p.id,
        directory: p.worktree.replaceAll("\\", "/"),
        name: p.name,
        engineType: this.engineType as EngineType,
        engineMeta: { icon: p.icon },
      }));
    } catch {
      return [];
    }
  }
}
