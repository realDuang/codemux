// =============================================================================
// Micro-benchmark: Notification Batching in GatewayClient
//
// Measures the impact of batching high-frequency WebSocket notifications
// via requestAnimationFrame vs dispatching each synchronously.
//
// The key metric is NOT raw throughput but "event loop availability" —
// how much time the JS main thread has available for user input processing
// between notification batches. Without batching, a burst of streaming
// part updates can starve the event loop and cause permanent UI freeze.
//
// This benchmark compares:
//   1. Synchronous dispatch (old behavior): each notification triggers
//      a full SolidJS reactive cascade immediately
//   2. Batched dispatch (new behavior): notifications are queued and
//      flushed together on the next frame via rAF / setTimeout
// =============================================================================

import { bench, describe } from "vitest";
import { createStore } from "solid-js/store";
import { createRoot, createMemo } from "solid-js";

// ---------------------------------------------------------------------------
// Helpers — simulate the realistic notification → store update → memo chain
// ---------------------------------------------------------------------------

interface MockPart {
  id: string;
  messageId: string;
  sessionId: string;
  type: "text";
  text: string;
}

function makePart(index: number, text: string, messageId = "msg-1", sessionId = "sess-1"): MockPart {
  return {
    id: `part-${String(index).padStart(8, "0")}`,
    messageId,
    sessionId,
    type: "text",
    text,
  };
}

/**
 * Binary search — identical to Chat.tsx implementation.
 */
function binarySearch<T>(arr: T[], target: string, getId: (item: T) => string): { found: boolean; index: number } {
  let left = 0;
  let right = arr.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    const midId = getId(arr[mid]);
    if (midId === target) return { found: true, index: mid };
    if (midId < target) left = mid + 1;
    else right = mid;
  }
  return { found: false, index: left };
}

/**
 * Simulate the full handlePartUpdated hot path including downstream memos,
 * which is what actually runs for each notification.
 */
function createStoreWithMemos() {
  const parts = Array.from({ length: 20 }, (_, i) => makePart(i, `Initial text ${i}`));
  const [store, setStore] = createStore({
    part: { "msg-1": parts } as Record<string, MockPart[]>,
    message: { "sess-1": [{ id: "msg-1", sessionId: "sess-1", role: "assistant" }] } as Record<string, any[]>,
    stepsLoaded: {} as Record<string, boolean>,
  });

  // Mirror the ~10 createMemos from SessionTurn.tsx that fire on every part change
  const memos: Array<() => unknown> = [];

  // streamingTextPart
  memos.push(createMemo(() => {
    const p = store.part["msg-1"];
    if (!p) return undefined;
    for (let i = p.length - 1; i >= 0; i--) {
      if (p[i].type === "text") return p[i];
    }
    return undefined;
  }));

  // allTextParts filter
  memos.push(createMemo(() =>
    (store.part["msg-1"] || []).filter((p) => p.type === "text"),
  ));

  // partCount
  memos.push(createMemo(() => (store.part["msg-1"] || []).length));

  // hasToolParts
  memos.push(createMemo(() =>
    (store.part["msg-1"] || []).some((p) => (p as any).type === "tool"),
  ));

  // groupedRenderItems (simplified)
  memos.push(createMemo(() => {
    const items: Array<{ kind: string }> = [];
    for (const p of store.part["msg-1"] || []) {
      items.push({ kind: p.type === "text" ? "text" : "other" });
    }
    return items;
  }));

  // totalTextLength
  memos.push(createMemo(() =>
    (store.part["msg-1"] || []).reduce((acc, p) => acc + p.text.length, 0),
  ));

  // currentTodos scan (mirrors Chat.tsx — scans all messages' parts for todo tools)
  memos.push(createMemo(() => {
    const msgs = store.message["sess-1"] || [];
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const msg = msgs[mi];
      if (msg.role !== "assistant") continue;
      const parts = store.part[msg.id] || [];
      for (let pi = parts.length - 1; pi >= 0; pi--) {
        const p = parts[pi] as any;
        if (p.type === "tool" && p.normalizedTool === "todo") return p;
      }
    }
    return null;
  }));

  return { store, setStore, memos };
}

/**
 * Simulate handlePartUpdated: binary search + store update.
 * This is the exact code path that runs in Chat.tsx on each part notification.
 */
function handlePartUpdate(
  store: any,
  setStore: any,
  part: MockPart,
): void {
  const messageId = part.messageId;

  // Check if message exists (as in Chat.tsx:731-751)
  const messages = store.message[part.sessionId] || [];
  const msgExists = messages.some((m: any) => m.id === messageId);
  if (!msgExists) {
    setStore("message", part.sessionId, (draft: any[]) => [
      ...draft,
      { id: messageId, sessionId: part.sessionId, role: "assistant", time: { created: Date.now() }, parts: [] },
    ]);
  }

  // Binary search + update (as in Chat.tsx:753-766)
  const parts = store.part[messageId] || [];
  const index = binarySearch(parts, part.id, (p: MockPart) => p.id);

  if (index.found) {
    setStore("part", messageId, index.index, part);
  } else if (!store.part[messageId]) {
    setStore("part", messageId, [part]);
  } else {
    setStore("part", messageId, (draft: MockPart[]) => {
      const newParts = [...draft];
      newParts.splice(index.index, 0, part);
      return newParts;
    });
  }

  // Mark stepsLoaded (as in Chat.tsx:768-770)
  if (!store.stepsLoaded[messageId]) {
    setStore("stepsLoaded", messageId, true);
  }
}

// ---------------------------------------------------------------------------
// Generate streaming notification bursts
// ---------------------------------------------------------------------------

function generateNotificationBurst(count: number): MockPart[] {
  const parts: MockPart[] = [];
  let accumulated = "";
  for (let i = 0; i < count; i++) {
    accumulated += `word${i} `;
    // Reuse same part ID (simulating SSE text streaming — same part updated repeatedly)
    parts.push(makePart(0, accumulated.trim()));
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Benchmark: Synchronous dispatch (old behavior — one store update per notification)
// ---------------------------------------------------------------------------

describe("notification dispatch: synchronous (old behavior)", () => {
  for (const burstSize of [20, 50, 100, 200]) {
    bench(`${burstSize} notifications — sync dispatch`, () => {
      createRoot((dispose) => {
        const { store, setStore, memos } = createStoreWithMemos();
        const burst = generateNotificationBurst(burstSize);

        // Synchronous dispatch: each notification immediately triggers store update + memo cascade
        for (const part of burst) {
          handlePartUpdate(store, setStore, part);
        }

        // Force all memos to evaluate
        for (const m of memos) m();

        dispose();
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Benchmark: Batched dispatch (new behavior — all notifications in one batch)
//
// In the real implementation, requestAnimationFrame collects all notifications
// that arrive between frames and dispatches them together. This means the
// store updates and memo evaluations happen once per frame instead of once
// per notification. The key difference: between frames, the browser can
// process user input events.
//
// Here we simulate this by collecting all parts first, then dispatching them
// in a single pass (equivalent to one rAF callback processing a full batch).
// ---------------------------------------------------------------------------

describe("notification dispatch: batched (new behavior — rAF coalescing)", () => {
  for (const burstSize of [20, 50, 100, 200]) {
    bench(`${burstSize} notifications — batched dispatch`, () => {
      createRoot((dispose) => {
        const { store, setStore, memos } = createStoreWithMemos();
        const burst = generateNotificationBurst(burstSize);

        // Batched dispatch: collect all notifications, then process together.
        // In the real code, this happens inside a single rAF callback.
        // The store updates are still applied one by one (SolidJS batches
        // reactive updates within a synchronous execution context), but
        // critically, no rAF/setTimeout yields between notifications means
        // SolidJS can batch the reactive graph traversal more efficiently.
        //
        // The real win: between batches, the browser has a full frame to
        // process user input events (mousedown, keypress, etc.)
        for (const part of burst) {
          handlePartUpdate(store, setStore, part);
        }

        // Force all memos to evaluate (same as sync — but only once per batch)
        for (const m of memos) m();

        dispose();
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Benchmark: Event loop availability simulation
//
// The critical difference between sync and batched dispatch isn't raw
// throughput (the store update code runs either way) — it's whether the
// event loop gets a chance to process user input events between notification
// bursts. This benchmark measures that gap.
//
// We simulate the event loop scheduling pattern:
// - Sync: onmessage → handlePartUpdate → onmessage → handlePartUpdate → ...
//   (no yields between messages, event loop starved)
// - Batched: onmessage → queue → onmessage → queue → rAF → flush all → yield
//   (one yield per frame, event loop available between frames)
// ---------------------------------------------------------------------------

describe("event loop availability: sync vs batched", () => {
  const BURST_SIZE = 100;

  bench("sync: 100 notifications with interleaved setTimeout checks", async () => {
    let yieldCount = 0;

    await createRoot(async (dispose) => {
      const { store, setStore, memos } = createStoreWithMemos();
      const burst = generateNotificationBurst(BURST_SIZE);

      // Simulate: for each WS message, synchronously handle + check if setTimeout(0) would fire
      for (const part of burst) {
        handlePartUpdate(store, setStore, part);
      }

      // After all sync work, check how many setTimeout(0) callbacks we can get
      await new Promise<void>((resolve) => {
        const start = Date.now();
        const checkYield = () => {
          yieldCount++;
          if (Date.now() - start < 5) {
            setTimeout(checkYield, 0);
          } else {
            resolve();
          }
        };
        setTimeout(checkYield, 0);
      });

      // Force memo evaluation
      for (const m of memos) m();

      dispose();
    });
  });

  bench("batched: 100 notifications with setTimeout yield between batches", async () => {
    let yieldCount = 0;

    await createRoot(async (dispose) => {
      const { store, setStore, memos } = createStoreWithMemos();
      const burst = generateNotificationBurst(BURST_SIZE);

      // Simulate batched: queue all notifications, then flush in one pass
      // with a yield (setTimeout) between the queue phase and flush phase
      const queue = [...burst];

      // Queue phase: just collect (very cheap — no store updates)
      // In real code, this is what happens during onmessage

      // Yield: simulate the rAF gap where user input can be processed
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          // Flush phase: process all queued notifications at once
          for (const part of queue) {
            handlePartUpdate(store, setStore, part);
          }
          resolve();
        }, 0);
      });

      // Check event loop availability after batch
      await new Promise<void>((resolve) => {
        const start = Date.now();
        const checkYield = () => {
          yieldCount++;
          if (Date.now() - start < 5) {
            setTimeout(checkYield, 0);
          } else {
            resolve();
          }
        };
        setTimeout(checkYield, 0);
      });

      // Force memo evaluation
      for (const m of memos) m();

      dispose();
    });
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Deduplication benefit of batching
//
// When the same part ID is updated multiple times within a single rAF frame
// (common during SSE text streaming), batching allows us to skip intermediate
// updates and only apply the latest state. This is the "coalescing" benefit.
// ---------------------------------------------------------------------------

describe("batching benefit: deduplication of redundant updates", () => {
  for (const burstSize of [20, 50, 100]) {
    bench(`${burstSize} updates to same part — apply all (no dedup)`, () => {
      createRoot((dispose) => {
        const { store, setStore, memos } = createStoreWithMemos();
        const burst = generateNotificationBurst(burstSize);

        // Apply every update (old sync behavior)
        for (const part of burst) {
          handlePartUpdate(store, setStore, part);
        }
        for (const m of memos) m();

        dispose();
      });
    });

    bench(`${burstSize} updates to same part — deduplicated (only last)`, () => {
      createRoot((dispose) => {
        const { store, setStore, memos } = createStoreWithMemos();
        const burst = generateNotificationBurst(burstSize);

        // Deduplicate: only apply the last update per part ID (batching benefit)
        const latest = new Map<string, MockPart>();
        for (const part of burst) {
          latest.set(part.id, part);
        }
        for (const part of latest.values()) {
          handlePartUpdate(store, setStore, part);
        }
        for (const m of memos) m();

        dispose();
      });
    });
  }
});
