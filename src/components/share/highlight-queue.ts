/**
 * Serialised highlight queue.
 *
 * When many content components mount simultaneously (e.g. on session switch),
 * each one kicks off a shiki `codeToHtml` / `marked.parse` call inside a
 * `createResource` fetcher.  Without coordination these run back-to-back as
 * microtasks, monopolising the main thread for hundreds of milliseconds and
 * starving the browser's input pipeline (keyboard events, IME, caret blink).
 *
 * This module provides a simple FIFO queue that:
 *  1. Runs at most one highlight job at a time.
 *  2. Yields to the main thread (`setTimeout(0)`) between jobs so the browser
 *     can process pending input events.
 *
 * Usage:
 *   import { enqueueHighlight } from "./highlight-queue"
 *   const html = await enqueueHighlight(() => codeToHtml(...))
 */

type Job<T> = {
  work: () => T | Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

const queue: Job<any>[] = [];
let running = false;

async function drain(): Promise<void> {
  if (running) return;
  running = true;

  while (queue.length > 0) {
    const job = queue.shift()!;
    try {
      const result = await job.work();
      job.resolve(result);
    } catch (err) {
      job.reject(err);
    }
    // Yield to the main thread between jobs so keyboard/input events
    // are processed promptly.
    if (queue.length > 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  running = false;
}

/**
 * Enqueue a highlight job.  Returns a promise that resolves with the job's
 * return value once it has been executed.
 */
export function enqueueHighlight<T>(work: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({ work, resolve, reject });
    // Start draining on next microtick if not already running.
    // Using setTimeout(0) for the first job too, so the caller's
    // synchronous setup code finishes before we start heavy work.
    if (!running) {
      setTimeout(drain, 0);
    }
  });
}
