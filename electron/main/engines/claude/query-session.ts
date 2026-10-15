/**
 * Claude Code persistent session built on the stable `query()` API.
 *
 * Replaces the SDK's `unstable_v2_createSession` / `unstable_v2_resumeSession`.
 * The V2 session API was experimental and is removed in Agent SDK 0.3.142+;
 * on 0.2.x it also silently drops most options — its constructor rebuilds the
 * transport options from a fixed whitelist, so `systemPrompt`, `effort`,
 * `thinking`, `stderr`, `includePartialMessages`, `mcpServers` never reach the
 * CLI, and `settingSources` defaults to `[]` (no CLAUDE.md, no user/project
 * settings, no settings-defined MCP servers or hooks).
 *
 * `query()` in streaming-input mode (an AsyncIterable of user messages) keeps
 * the CLI subprocess alive across turns exactly like a V2 session did, while
 * honouring the full `Options` surface. This class mirrors the V2
 * `send()` / `stream()` / `close()` contract so the adapter's turn loop is
 * unchanged, and exposes the underlying `Query` as `.query` (interrupt,
 * setPermissionMode, setModel, transport) just like the V2 object did.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** Grace period between closing stdin and force-aborting the CLI process. */
const CLOSE_ABORT_DELAY_MS = 5_000;

/** Minimal async queue used as the streaming-input prompt for query(). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private ended = false;

  push(item: SDKUserMessage): void {
    if (this.ended) throw new Error("Cannot send to closed session");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export interface ClaudeSession {
  readonly sessionId: string;
  /** Underlying SDK Query (interrupt / setPermissionMode / setModel / transport). */
  readonly query: Query;
  send(message: string | SDKUserMessage): Promise<void>;
  /** Yields messages for one turn; returns after (and including) the `result` message. */
  stream(): AsyncGenerator<SDKMessage, void>;
  close(): void;
}

export class ClaudeQuerySession implements ClaudeSession {
  readonly query: Query;
  private readonly input = new InputQueue();
  private iterator: AsyncIterator<SDKMessage> | null = null;
  private closed = false;
  private _sessionId: string | null;

  constructor(options: Options) {
    this._sessionId = options.resume ?? null;
    this.query = sdkQuery({ prompt: this.input, options });
  }

  get sessionId(): string {
    if (this._sessionId === null) {
      throw new Error("Session ID not available until after receiving messages");
    }
    return this._sessionId;
  }

  async send(message: string | SDKUserMessage): Promise<void> {
    if (this.closed) throw new Error("Cannot send to closed session");
    const userMessage: SDKUserMessage =
      typeof message === "string"
        ? {
            type: "user",
            session_id: "",
            message: { role: "user", content: [{ type: "text", text: message }] },
            parent_tool_use_id: null,
          }
        : message;
    this.input.push(userMessage);
  }

  async *stream(): AsyncGenerator<SDKMessage, void> {
    if (!this.iterator) this.iterator = this.query[Symbol.asyncIterator]();
    while (true) {
      const { value, done } = await this.iterator.next();
      if (done) return;
      if (value.type === "system" && (value as { subtype?: string }).subtype === "init") {
        this._sessionId = value.session_id;
      }
      yield value;
      if (value.type === "result") return;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Closing stdin lets the CLI flush and exit gracefully; force-close the
    // query afterwards in case the process hangs.
    this.input.end();
    const timer = setTimeout(() => {
      try {
        this.query.close();
      } catch {
        // already closed
      }
    }, CLOSE_ABORT_DELAY_MS);
    (timer as { unref?: () => void }).unref?.();
  }
}

export function createClaudeSession(options: Options): ClaudeSession {
  return new ClaudeQuerySession(options);
}

export function resumeClaudeSession(sessionId: string, options: Options): ClaudeSession {
  return new ClaudeQuerySession({ ...options, resume: sessionId });
}
