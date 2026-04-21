// ============================================================================
// UserChannel — Shared human-in-the-loop message channel for orchestrators.
// Allows users to inject messages into any orchestration loop (Light/Heavy Brain).
// The orchestration loop races user messages against task completions.
// ============================================================================

/**
 * A channel for receiving user messages during orchestration.
 * The orchestrator creates a channel, then races `waitForMessage()` against
 * task completions. External code calls `send()` to inject a user message.
 */
export class UserChannel {
  /** Pending resolve callback — set when the orchestrator is waiting */
  private waitResolve: ((text: string) => void) | null = null;
  /** Buffered message — set when a message arrives while not waiting */
  private pendingMessage: string | null = null;

  /**
   * Send a user message into the channel.
   * If the orchestrator is currently waiting (in Promise.race), resolves immediately.
   * Otherwise buffers until the next waitForMessage() call.
   */
  send(text: string): void {
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = null;
      resolve(text);
    } else {
      // Buffer — next waitForMessage() will return immediately
      this.pendingMessage = text;
    }
  }

  /**
   * Check if there's a buffered message without consuming it.
   */
  hasPending(): boolean {
    return this.pendingMessage !== null;
  }

  /**
   * Consume and return the buffered message, if any.
   */
  takePending(): string | null {
    const msg = this.pendingMessage;
    this.pendingMessage = null;
    return msg;
  }

  /**
   * Returns a promise that resolves when a user message arrives.
   * Used in Promise.race alongside task completion promises.
   * If a message is already buffered, resolves immediately.
   */
  waitForMessage(): Promise<string> {
    // Return buffered message immediately
    if (this.pendingMessage !== null) {
      const msg = this.pendingMessage;
      this.pendingMessage = null;
      return Promise.resolve(msg);
    }

    return new Promise<string>((resolve) => {
      this.waitResolve = resolve;
    });
  }

  /**
   * Cancel any pending wait (e.g. when orchestration ends).
   * Does not reject — just clears the callback so GC can collect the promise.
   */
  dispose(): void {
    this.waitResolve = null;
    this.pendingMessage = null;
  }
}
