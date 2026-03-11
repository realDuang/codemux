// =============================================================================
// Micro-benchmark: SolidJS Store Update Performance
//
// Measures the cost of the handlePartUpdated hot path:
//   binarySearch → setMessageStore("part", messageId, index, part)
//
// This is the most frequently executed code path during SSE streaming —
// every token update triggers it (~20-50 times/sec).
//
// Retained case: "100 parts + 10 downstream memos" — exercises the full
// hot path (binary search + store update + 10 memo recomputations),
// matching the real SessionTurn reactive graph.
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
// Benchmark: Update with 10 downstream createMemos (realistic SessionTurn)
//
// In production, SessionTurn has ~10 createMemo computations that read from
// messageStore.part[msgId]. Each store update triggers re-evaluation of all
// memos that depend on the changed path.
// ---------------------------------------------------------------------------

describe("handlePartUpdated: with downstream memos (realistic)", () => {
  bench("100 parts + 10 downstream memos", () => {
    createRoot((dispose) => {
      const parts = Array.from({ length: 100 }, (_, i) => makePart(i));
      const [store, setStore] = createStore({
        part: { "msg-1": parts } as Record<string, MockPart[]>,
      });

      // Create memos that mirror SessionTurn's real computations
      const memos: Array<() => unknown> = [];

      // streamingTextPart: find last text part
      memos.push(createMemo(() => {
        const p = store.part["msg-1"];
        for (let i = p.length - 1; i >= 0; i--) {
          if (p[i].type === "text") return p[i];
        }
        return undefined;
      }));

      // allTextParts: filter text parts
      memos.push(createMemo(() =>
        store.part["msg-1"].filter((p) => p.type === "text")
      ));

      // partCount
      memos.push(createMemo(() => store.part["msg-1"].length));

      // hasToolParts
      memos.push(createMemo(() =>
        store.part["msg-1"].some((p) => (p as any).type === "tool")
      ));

      // groupedRenderItems (simplified — just iterate and categorize)
      memos.push(createMemo(() => {
        const items: Array<{ kind: string }> = [];
        for (const p of store.part["msg-1"]) {
          items.push({ kind: p.type === "text" ? "text" : "other" });
        }
        return items;
      }));

      // Add more memos (similar filter/reduce operations)
      for (let i = memos.length; i < 10; i++) {
        memos.push(createMemo(() =>
          store.part["msg-1"].reduce((acc, p) => acc + p.text.length, 0)
        ));
      }

      // Trigger an update via binary search (realistic hot path)
      const targetId = `part-${String(50).padStart(8, "0")}`;
      const result = binarySearch(store.part["msg-1"], targetId, (p) => p.id);
      if (result.found) {
        setStore("part", "msg-1", result.index, {
          ...store.part["msg-1"][result.index],
          text: "Updated content during streaming...",
        });
      }

      // Force all memos to evaluate (SolidJS is lazy)
      for (const m of memos) m();

      dispose();
    });
  });
});
