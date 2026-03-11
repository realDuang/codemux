// =============================================================================
// Micro-benchmark: SolidJS Store Update Performance
//
// Measures the cost of the handlePartUpdated hot path:
//   binarySearch → setMessageStore("part", messageId, index, part)
//
// This is the most frequently executed code path during SSE streaming —
// every token update triggers it (~20-50 times/sec).
// =============================================================================

import { bench, describe } from "vitest";
import { createStore } from "solid-js/store";
import { createRoot, createMemo } from "solid-js";

// ---------------------------------------------------------------------------
// Helpers — mirror the real data shapes from unified.ts and Chat.tsx
// ---------------------------------------------------------------------------

interface MockPart {
  id: string;
  partId: string;
  messageId: string;
  sessionId: string;
  type: "text";
  text: string;
  role: string;
}

function makePart(index: number, messageId = "msg-1", sessionId = "sess-1"): MockPart {
  return {
    id: `part-${String(index).padStart(8, "0")}`,
    partId: `part-${index}`,
    messageId,
    sessionId,
    type: "text",
    text: `Content chunk ${index} — typical streaming content with some realistic length to match production payloads`,
    role: "assistant",
  };
}

/**
 * Binary search — identical to Chat.tsx implementation.
 * Returns { found, index } where index is the insertion point if not found.
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

// ---------------------------------------------------------------------------
// Benchmark: In-place update of existing part (most common during streaming)
// ---------------------------------------------------------------------------

describe("handlePartUpdated: update existing part in-place", () => {
  for (const size of [10, 50, 100, 500, 1000]) {
    bench(`${size} parts — find + update`, () => {
      createRoot((dispose) => {
        const parts = Array.from({ length: size }, (_, i) => makePart(i));
        const [store, setStore] = createStore({
          part: { "msg-1": parts } as Record<string, MockPart[]>,
        });

        // Target the part at ~middle position (realistic: streaming part is usually
        // the last text part, but binary search cost is O(log n) regardless)
        const targetIdx = Math.floor(size / 2);
        const targetId = `part-${String(targetIdx).padStart(8, "0")}`;
        const result = binarySearch(store.part["msg-1"], targetId, (p) => p.id);

        if (result.found) {
          setStore("part", "msg-1", result.index, {
            ...store.part["msg-1"][result.index],
            text: "Updated streaming content with new tokens appended to the end...",
          });
        }

        dispose();
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Benchmark: Splice-insert new part (happens when a new tool call starts)
// ---------------------------------------------------------------------------

describe("handlePartUpdated: splice-insert new part", () => {
  for (const size of [10, 50, 100, 500]) {
    bench(`${size} existing parts — insert at middle`, () => {
      createRoot((dispose) => {
        // Create parts with gaps (even indices) so we can insert at odd positions
        const parts = Array.from({ length: size }, (_, i) => makePart(i * 2));
        const [, setStore] = createStore({
          part: { "msg-1": parts } as Record<string, MockPart[]>,
        });

        // Insert a new part that belongs in the middle
        const newPart = makePart(size); // will sort somewhere in the middle due to padding
        setStore("part", "msg-1", (draft) => {
          const clone = [...draft];
          const pos = binarySearch(clone, newPart.id, (p) => p.id);
          clone.splice(pos.index, 0, newPart);
          return clone;
        });

        dispose();
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Benchmark: Update with downstream createMemos (realistic SessionTurn scenario)
//
// In production, SessionTurn has ~10 createMemo computations that read from
// messageStore.part[msgId]. Each store update triggers re-evaluation of all
// memos that depend on the changed path.
// ---------------------------------------------------------------------------

describe("handlePartUpdated: with downstream memos (realistic)", () => {
  for (const memoCount of [1, 5, 10]) {
    bench(`100 parts + ${memoCount} downstream memos`, () => {
      createRoot((dispose) => {
        const parts = Array.from({ length: 100 }, (_, i) => makePart(i));
        const [store, setStore] = createStore({
          part: { "msg-1": parts } as Record<string, MockPart[]>,
        });

        // Create memos that mirror SessionTurn's real computations
        const memos: Array<() => unknown> = [];

        if (memoCount >= 1) {
          // streamingTextPart: find last text part
          memos.push(createMemo(() => {
            const p = store.part["msg-1"];
            for (let i = p.length - 1; i >= 0; i--) {
              if (p[i].type === "text") return p[i];
            }
            return undefined;
          }));
        }

        if (memoCount >= 2) {
          // allTextParts: filter text parts
          memos.push(createMemo(() =>
            store.part["msg-1"].filter((p) => p.type === "text")
          ));
        }

        if (memoCount >= 3) {
          // partCount
          memos.push(createMemo(() => store.part["msg-1"].length));
        }

        if (memoCount >= 4) {
          // hasToolParts
          memos.push(createMemo(() =>
            store.part["msg-1"].some((p) => (p as any).type === "tool")
          ));
        }

        if (memoCount >= 5) {
          // groupedRenderItems (simplified — just iterate and categorize)
          memos.push(createMemo(() => {
            const items: Array<{ kind: string }> = [];
            for (const p of store.part["msg-1"]) {
              items.push({ kind: p.type === "text" ? "text" : "other" });
            }
            return items;
          }));
        }

        // Add more memos for higher counts (similar filter/reduce operations)
        for (let i = memos.length; i < memoCount; i++) {
          memos.push(createMemo(() =>
            store.part["msg-1"].reduce((acc, p) => acc + p.text.length, 0)
          ));
        }

        // Trigger an update
        setStore("part", "msg-1", 50, {
          ...store.part["msg-1"][50],
          text: "Updated content during streaming...",
        });

        // Force all memos to evaluate (SolidJS is lazy)
        for (const m of memos) m();

        dispose();
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Benchmark: Binary search alone (to isolate search cost from store cost)
// ---------------------------------------------------------------------------

describe("binarySearch isolation", () => {
  for (const size of [10, 100, 1000, 5000]) {
    const parts = Array.from({ length: size }, (_, i) => makePart(i));
    const targetId = `part-${String(Math.floor(size / 2)).padStart(8, "0")}`;

    bench(`${size} parts — find existing`, () => {
      binarySearch(parts, targetId, (p) => p.id);
    });

    bench(`${size} parts — find non-existing`, () => {
      binarySearch(parts, "part-99999999", (p) => p.id);
    });
  }
});

// ---------------------------------------------------------------------------
// Benchmark: Message array append (handleMessageUpdated creates placeholders)
// ---------------------------------------------------------------------------

describe("message array operations", () => {
  for (const size of [10, 50, 100]) {
    bench(`append message to ${size}-message array`, () => {
      createRoot((dispose) => {
        const messages = Array.from({ length: size }, (_, i) => ({
          id: `msg-${String(i).padStart(6, "0")}`,
          sessionId: "sess-1",
          role: "assistant" as const,
          time: { created: Date.now() },
          parts: [],
        }));
        const [, setStore] = createStore({
          message: { "sess-1": messages } as Record<string, typeof messages>,
        });

        const newMsg = {
          id: `msg-${String(size).padStart(6, "0")}`,
          sessionId: "sess-1",
          role: "assistant" as const,
          time: { created: Date.now() },
          parts: [],
        };

        setStore("message", "sess-1", (draft) => [...draft, newMsg]);

        dispose();
      });
    });
  }
});
