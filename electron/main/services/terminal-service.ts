// ============================================================================
// Integrated Terminal Service (PTY-backed, Gateway-routed)
//
// Spawns and manages node-pty child processes on the host. Terminals are
// owned by a WebSocket client (identified by clientId) so the gateway can
// scope notifications and clean up when the client disconnects.
//
// All RPC requests come in via the WebSocket gateway — there is NO Electron
// IPC path. This makes the same surface available to remote browser clients
// (Cloudflare Tunnel) just like other gateway requests.
// ============================================================================

import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type * as pty from "node-pty";
import { terminalLog } from "./logger";
import { listTerminalProfiles, getTerminalProfile } from "./terminal-profiles";
import type { TerminalInfo } from "../../../src/types/unified";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum total PTY processes allowed per WebSocket client. */
const DEFAULT_MAX_PER_CLIENT = 20;

/** Maximum PTY processes per (client, sessionId) pair. */
const DEFAULT_MAX_PER_SESSION = 5;

/** Bounds passed straight to the PTY library — sanity-clamped. */
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TerminalRecord {
  id: string;
  ownerClientId: string;
  sessionId?: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  pty: pty.IPty;
  createdAt: number;
}

export interface TerminalServiceEvents {
  /** PTY emitted output. */
  data: (payload: { terminalId: string; ownerClientId: string; data: string }) => void;
  /** PTY exited (process ended). */
  exit: (payload: {
    terminalId: string;
    ownerClientId: string;
    exitCode?: number;
    signal?: number;
  }) => void;
}

export interface TerminalCreateOptions {
  ownerClientId: string;
  cwd: string;
  cols: number;
  rows: number;
  sessionId?: string;
  /** Optional profile ID — when omitted, server falls back to the default. */
  profileId?: string;
}

/** Lazy import wrapper so unit tests can inject a mock. */
export type PtyModule = Pick<typeof pty, "spawn">;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TerminalService extends EventEmitter {
  private terminals = new Map<string, TerminalRecord>();
  private ptyModule: PtyModule | null;
  private readonly maxPerClient: number;
  private readonly maxPerSession: number;

  constructor(options?: {
    ptyModule?: PtyModule;
    maxPerClient?: number;
    maxPerSession?: number;
  }) {
    super();
    this.ptyModule = options?.ptyModule ?? null;
    this.maxPerClient = options?.maxPerClient ?? DEFAULT_MAX_PER_CLIENT;
    this.maxPerSession = options?.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
  }

  // -- Typed event API (delegates to EventEmitter) ---------------------------

  override on<K extends keyof TerminalServiceEvents>(
    event: K,
    listener: TerminalServiceEvents[K],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override off<K extends keyof TerminalServiceEvents>(
    event: K,
    listener: TerminalServiceEvents[K],
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof TerminalServiceEvents>(
    event: K,
    ...args: Parameters<TerminalServiceEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  // -- Public API ------------------------------------------------------------

  /**
   * Spawn a new PTY. Throws if `cwd` is invalid or limits are exceeded.
   */
  create(options: TerminalCreateOptions): TerminalInfo {
    const { ownerClientId, sessionId } = options;
    const cols = clampDimension(options.cols);
    const rows = clampDimension(options.rows);

    // Per-client / per-session limits (defense against runaway tab creation).
    const ownedCount = this.countByOwner(ownerClientId);
    if (ownedCount >= this.maxPerClient) {
      throw new Error(
        `Per-client terminal limit reached (${this.maxPerClient}). Close existing terminals before opening a new one.`,
      );
    }
    if (sessionId) {
      const sessionCount = this.countBySession(ownerClientId, sessionId);
      if (sessionCount >= this.maxPerSession) {
        throw new Error(
          `Per-session terminal limit reached (${this.maxPerSession}).`,
        );
      }
    }

    const cwd = validateCwd(options.cwd);

    // Resolve which shell to spawn. Profile selection cascades:
    //   explicit profileId > settings default > platform fallback.
    let shell = getDefaultShell();
    let shellArgs: string[] = [];
    let extraEnv: Record<string, string> = {};
    const requestedId = options.profileId ?? listTerminalProfiles().defaultProfileId ?? null;
    const profile = requestedId ? getTerminalProfile(requestedId) : null;
    if (profile) {
      shell = profile.path;
      shellArgs = profile.args ? [...profile.args] : [];
      extraEnv = profile.env ?? {};
    }
    const env = { ...buildPtyEnv(), ...extraEnv };

    const ptyMod = this.getPtyModule();
    const ptyProcess = ptyMod.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
    });

    const id = `term-${randomUUID()}`;
    const record: TerminalRecord = {
      id,
      ownerClientId,
      sessionId,
      cwd,
      shell,
      cols,
      rows,
      pty: ptyProcess,
      createdAt: Date.now(),
    };
    this.terminals.set(id, record);

    ptyProcess.onData((data: string) => {
      // Forward output as-is. xterm.js handles ANSI sequences client-side.
      this.emit("data", { terminalId: id, ownerClientId, data });
    });

    ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      this.terminals.delete(id);
      terminalLog.debug(
        `Terminal ${id} (pid ${ptyProcess.pid}) exited code=${exitCode} signal=${signal ?? "-"}`,
      );
      this.emit("exit", {
        terminalId: id,
        ownerClientId,
        exitCode,
        signal,
      });
    });

    terminalLog.info(
      `Terminal ${id} spawned: shell=${shell} cwd=${cwd} pid=${ptyProcess.pid} owner=${ownerClientId}`,
    );

    return this.toInfo(record);
  }

  write(terminalId: string, data: string, ownerClientId: string): void {
    const term = this.requireOwned(terminalId, ownerClientId);
    term.pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number, ownerClientId: string): void {
    const term = this.requireOwned(terminalId, ownerClientId);
    const c = clampDimension(cols);
    const r = clampDimension(rows);
    if (c === term.cols && r === term.rows) return;
    term.cols = c;
    term.rows = r;
    try {
      term.pty.resize(c, r);
    } catch (err) {
      // node-pty throws if the process has already exited; treat as no-op.
      terminalLog.debug(`Resize failed for ${terminalId}:`, (err as Error).message);
    }
  }

  destroy(terminalId: string, ownerClientId: string): void {
    const term = this.terminals.get(terminalId);
    if (!term) return;
    if (term.ownerClientId !== ownerClientId) {
      throw new Error("Terminal not owned by this client");
    }
    this.killAndForget(term);
  }

  /** List terminals owned by a given client, optionally filtered by session. */
  list(ownerClientId: string, sessionId?: string): TerminalInfo[] {
    const out: TerminalInfo[] = [];
    for (const term of this.terminals.values()) {
      if (term.ownerClientId !== ownerClientId) continue;
      if (sessionId !== undefined && term.sessionId !== sessionId) continue;
      out.push(this.toInfo(term));
    }
    return out;
  }

  /** Destroy every terminal owned by a given client (e.g. on WS disconnect). */
  destroyByOwner(ownerClientId: string): number {
    let destroyed = 0;
    for (const term of [...this.terminals.values()]) {
      if (term.ownerClientId === ownerClientId) {
        this.killAndForget(term);
        destroyed++;
      }
    }
    if (destroyed > 0) {
      terminalLog.info(`Destroyed ${destroyed} terminal(s) for owner ${ownerClientId}`);
    }
    return destroyed;
  }

  /** Destroy every active terminal (e.g. on app shutdown). */
  destroyAll(): number {
    const total = this.terminals.size;
    for (const term of [...this.terminals.values()]) {
      this.killAndForget(term);
    }
    if (total > 0) {
      terminalLog.info(`Destroyed all ${total} terminal(s)`);
    }
    return total;
  }

  /** Number of currently active terminals (test helper). */
  count(): number {
    return this.terminals.size;
  }

  // -- Internals -------------------------------------------------------------

  private requireOwned(terminalId: string, ownerClientId: string): TerminalRecord {
    const term = this.terminals.get(terminalId);
    if (!term) throw new Error(`Terminal ${terminalId} not found`);
    if (term.ownerClientId !== ownerClientId) {
      throw new Error("Terminal not owned by this client");
    }
    return term;
  }

  private countByOwner(ownerClientId: string): number {
    let n = 0;
    for (const t of this.terminals.values()) if (t.ownerClientId === ownerClientId) n++;
    return n;
  }

  private countBySession(ownerClientId: string, sessionId: string): number {
    let n = 0;
    for (const t of this.terminals.values()) {
      if (t.ownerClientId === ownerClientId && t.sessionId === sessionId) n++;
    }
    return n;
  }

  private killAndForget(term: TerminalRecord): void {
    this.terminals.delete(term.id);
    try {
      term.pty.kill();
    } catch (err) {
      terminalLog.debug(`PTY ${term.id} kill error:`, (err as Error).message);
    }
  }

  private toInfo(term: TerminalRecord): TerminalInfo {
    return {
      terminalId: term.id,
      sessionId: term.sessionId,
      cwd: term.cwd,
      cols: term.cols,
      rows: term.rows,
      pid: term.pty.pid,
      shell: term.shell,
      createdAt: term.createdAt,
    };
  }

  private getPtyModule(): PtyModule {
    if (!this.ptyModule) {
      // Lazy require to keep `node-pty` out of the renderer bundle and to
      // allow tests to construct the service without the native binding.
      this.ptyModule = require("node-pty") as PtyModule;
    }
    return this.ptyModule;
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Resolve and validate a working directory.
 * - Normalizes via `path.resolve`
 * - Verifies the path exists and is a directory
 * Throws on failure with a user-facing error message.
 */
export function validateCwd(cwd: string): string {
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    throw new Error("cwd must be a non-empty string");
  }
  const resolved = path.resolve(cwd);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`cwd does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`cwd is not a directory: ${resolved}`);
  }
  return resolved;
}

export function getDefaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/bash";
}

/**
 * Build the env passed to the PTY.
 * - Inherit current process env
 * - On Linux, default LANG/LC_* to en_US.UTF-8 if missing — fixes garbled
 *   non-ASCII output observed in the original PR. Other platforms set their
 *   own locale via the user's shell init files.
 */
export function buildPtyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  if (process.platform === "linux") {
    if (!env.LANG) env.LANG = "en_US.UTF-8";
    if (!env.LC_CTYPE) env.LC_CTYPE = env.LANG;
    if (!env.LC_ALL) env.LC_ALL = env.LANG;
  }
  // node-pty sets TERM internally based on `name`, but make sure downstream
  // tools that inspect env see a sensible default.
  if (!env.TERM) env.TERM = "xterm-256color";
  return env;
}

function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return MIN_DIMENSION;
  const n = Math.floor(value);
  if (n < MIN_DIMENSION) return MIN_DIMENSION;
  if (n > MAX_DIMENSION) return MAX_DIMENSION;
  return n;
}

// Singleton — created lazily so test suites can construct their own.
let singleton: TerminalService | null = null;

export function getTerminalService(): TerminalService {
  if (!singleton) singleton = new TerminalService();
  return singleton;
}

/** Test helper: replace the singleton (e.g. with an injected mock pty). */
export function __setTerminalServiceForTests(svc: TerminalService | null): void {
  singleton = svc;
}

// Avoid unused-import warnings on platforms where `os` is not directly used.
void os;
