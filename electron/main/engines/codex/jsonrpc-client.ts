// ============================================================================
// Codex JSON-RPC 2.0 Stdio Client
//
// Thin client for communicating with the Codex app-server process over
// newline-delimited JSON-RPC on stdin/stdout.
// ============================================================================

import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import { codexLog } from "../../services/logger";

const IS_WIN = process.platform === "win32";

// --- JSON-RPC types ---

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// --- Client Events ---

export interface CodexClientEvents {
  /** Server → Client notification (no id, has method) */
  notification: (method: string, params: unknown) => void;
  /** Server → Client request (has id + method, expects response) */
  request: (id: number | string, method: string, params: unknown) => void;
  /** Client-level error */
  error: (error: Error) => void;
  /** Process exited */
  exit: (code: number | null, signal: string | null) => void;
}

export declare interface CodexJsonRpcClient {
  on<K extends keyof CodexClientEvents>(event: K, listener: CodexClientEvents[K]): this;
  off<K extends keyof CodexClientEvents>(event: K, listener: CodexClientEvents[K]): this;
  emit<K extends keyof CodexClientEvents>(event: K, ...args: Parameters<CodexClientEvents[K]>): boolean;
}

export interface CodexClientOptions {
  cliPath: string;
  args: string[];
  env?: Record<string, string | undefined>;
}

/**
 * JSON-RPC 2.0 client that communicates with the Codex app-server over stdio.
 */
export class CodexJsonRpcClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private rl: ReadlineInterface | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number | string, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly options: Required<Pick<CodexClientOptions, "cliPath" | "args">> & Pick<CodexClientOptions, "env">;
  private _running = false;

  constructor(options: CodexClientOptions) {
    super();
    this.options = {
      cliPath: options.cliPath,
      args: options.args,
      env: options.env,
    };
  }

  get running(): boolean {
    return this._running;
  }

  /**
   * Spawn the Codex app-server process and set up stdio communication.
   */
  async start(): Promise<void> {
    if (this._running) return;

    const { cliPath, args, env } = this.options;

    // Build clean child environment
    const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
    delete childEnv.ELECTRON_RUN_AS_NODE;

    codexLog.info(`Spawning Codex: ${cliPath} ${args.join(" ")}`);

    this.proc = spawn(cliPath, args, {
      shell: IS_WIN,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Attach EPIPE handlers to prevent uncaughtException
    this.proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") return;
      codexLog.warn("Codex stdin error:", err);
    });
    this.proc.stdout?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") return;
      codexLog.warn("Codex stdout error:", err);
    });
    this.proc.stderr?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") return;
      codexLog.warn("Codex stderr error:", err);
    });

    // Log stderr for debugging
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      codexLog.debug(`[Codex stderr] ${chunk.toString().trimEnd()}`);
    });

    // Set up line-by-line JSON parsing on stdout
    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => this.handleLine(line));

    // Handle process exit
    const proc = this.proc;
    this.proc.on("exit", (code, signal) => {
      this._running = false;
      this.cleanupAfterTermination(proc);
      this.rejectAllPending(new Error(`Codex process exited (code=${code}, signal=${signal})`));
      this.emit("exit", code, signal);
    });

    this.proc.on("error", (err) => {
      this._running = false;
      this.cleanupAfterTermination(proc);
      this.rejectAllPending(err);
      this.emit("error", err);
    });

    this._running = true;
  }

  /**
   * Stop the Codex process gracefully.
   */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc && !this.rl) return;

    this._running = false;
    this.rejectAllPending(new Error("Client stopped"));

    this.closeReadline();

    if (!proc) {
      this.proc = null;
      return;
    }

    return new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.killed) {
        if (this.proc === proc) {
          this.proc = null;
        }
        resolve();
        return;
      }

      let finished = false;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (this.proc === proc) {
          this.proc = null;
        }
        resolve();
      };

      timeout = setTimeout(() => {
        finish();
      }, 5000);

      proc.once("exit", () => {
        finish();
      });

      if (IS_WIN) {
        if (proc.pid) {
          spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
        }
      } else {
        proc.kill("SIGTERM");
      }
    });
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   * @param method The method name
   * @param params The params
   * @param timeout Request timeout in ms (default: 30000)
   */
  request(method: string, params?: unknown, timeout = 30_000): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timer });

      try {
        this.writeMessage(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  notify(method: string, params?: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    try {
      this.writeMessage(msg);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Respond to a server request with a result.
   */
  respond(id: number | string, result: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    try {
      this.writeMessage(msg);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Respond to a server request with an error.
   */
  respondError(id: number | string, code: number, message: string, data?: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message, data } };
    try {
      this.writeMessage(msg);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  // --- Internal ---

  private writeMessage(msg: JsonRpcMessage): void {
    if (!this.proc?.stdin?.writable) {
      throw new Error("Cannot write to Codex stdin: not writable");
    }
    codexLog.debug(`[→ Codex] ${summarizeMessageForLog(msg)}`);
    const json = JSON.stringify(msg);
    this.proc.stdin.write(json + "\n");
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      codexLog.debug(`[Codex] Non-JSON line: ${trimmed}`);
      return;
    }

    codexLog.debug(`[← Codex] ${summarizeMessageForLog(msg)}`);

    // Response to our request
    if ("id" in msg && msg.id != null && !("method" in msg)) {
      const response = msg as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        clearTimeout(pending.timer);
        if (response.error) {
          pending.reject(new Error(`${response.error.message} (code: ${response.error.code})`));
        } else {
          pending.resolve(response.result);
        }
      }
      return;
    }

    // Server request (has id + method)
    if ("id" in msg && msg.id != null && "method" in msg && msg.method) {
      this.emit("request", msg.id, msg.method, (msg as JsonRpcRequest).params);
      return;
    }

    // Server notification (no id, has method)
    if ("method" in msg && msg.method) {
      this.emit("notification", msg.method, (msg as JsonRpcNotification).params);
      return;
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private closeReadline(): void {
    if (!this.rl) return;
    this.rl.close();
    this.rl = null;
  }

  private cleanupAfterTermination(proc: ChildProcess | null): void {
    this.closeReadline();
    if (!proc || this.proc === proc) {
      this.proc = null;
    }
  }
}

function summarizeMessageForLog(msg: JsonRpcMessage): string {
  if ("method" in msg && typeof msg.method === "string") {
    const kind = "id" in msg && msg.id != null ? "request" : "notification";
    const id = "id" in msg && msg.id != null ? ` id=${String(msg.id)}` : "";
    const summary = summarizePayload("params" in msg ? msg.params : undefined);
    return `${kind} method=${msg.method}${id}${summary ? ` ${summary}` : ""}`;
  }

  if ("id" in msg && msg.id != null && !("method" in msg)) {
    if (msg.error) {
      return `response id=${String(msg.id)} error=${msg.error.code}`;
    }

    const summary = summarizePayload(msg.result);
    return `response id=${String(msg.id)}${summary ? ` ${summary}` : ""}`;
  }

  return "message";
}

function summarizePayload(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return `array(len=${value.length})`;
  if (typeof value === "string") return `string(len=${value.length})`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return `keys=${keys.slice(0, 5).join(",")}${keys.length > 5 ? ",…" : ""}`;
  }
  return `type=${typeof value}`;
}
