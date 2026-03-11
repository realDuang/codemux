// =============================================================================
// Micro-benchmark: SessionTurn Memo Cascade & Store Access Patterns
//
// SessionTurn.tsx has 17+ createMemo calls that ALL read from
// messageStore.part[msg.id]. This benchmark measures:
//
// 1. The cost of SolidJS memo cascades when a single part update triggers
//    multiple downstream recomputations
// 2. How the number of memos scales with turn complexity
// 3. The filterParts function cost (called multiple times per turn)
// 4. The groupedRenderItems computation (most complex memo)
// 5. Memory leak potential: store growth without cleanup
//
// These are the actual algorithms from SessionTurn.tsx reproduced verbatim
// to benchmark in isolation.
// =============================================================================

import { bench, describe } from "vitest";
import { createStore } from "solid-js/store";
import { createRoot, createMemo, createSignal, createEffect } from "solid-js";
import { parsePatch } from "diff";
import type { UnifiedMessage, UnifiedPart, ToolPart, TextPart, ReasoningPart } from "../../../src/types/unified";

// ---------------------------------------------------------------------------
// Data generators — create realistic turn data
// ---------------------------------------------------------------------------

let partIdCounter = 0;

function makeTextPart(msgId: string, sessionId: string, text: string): TextPart {
  return {
    id: `part-${String(++partIdCounter).padStart(8, "0")}`,
    messageId: msgId,
    sessionId,
    type: "text",
    text,
  };
}

function makeToolPart(
  msgId: string,
  sessionId: string,
  tool: "shell" | "read" | "write" | "edit" | "grep" | "glob" | "list" | "todo",
  status: "completed" | "running" = "completed",
): ToolPart {
  const now = Date.now();
  return {
    id: `part-${String(++partIdCounter).padStart(8, "0")}`,
    messageId: msgId,
    sessionId,
    type: "tool",
    callId: `call-${partIdCounter}`,
    normalizedTool: tool,
    originalTool: tool,
    title: `${tool} operation`,
    kind: tool === "read" || tool === "grep" || tool === "glob" || tool === "list" ? "read" : "edit",
    state: status === "completed"
      ? { status: "completed", input: {}, output: {}, time: { start: now - 500, end: now, duration: 500 } }
      : { status: "running", input: {}, time: { start: now } },
  };
}

function makeReasoningPart(msgId: string, sessionId: string): ReasoningPart {
  return {
    id: `part-${String(++partIdCounter).padStart(8, "0")}`,
    messageId: msgId,
    sessionId,
    type: "reasoning",
    text: "**Analyzing the code structure**\n\nLet me think about this step by step...",
  };
}

function makeMessage(id: string, sessionId: string, role: "user" | "assistant"): UnifiedMessage {
  return {
    id,
    sessionId,
    role,
    time: { created: Date.now() - 1000, completed: role === "assistant" ? Date.now() : undefined },
    parts: [],
  };
}

/**
 * Create a realistic turn with varying complexity.
 * A "complex" turn has: reasoning + read + grep + glob + edit + shell + text response
 */
function createTurnData(sessionId: string, turnIndex: number, complexity: "simple" | "medium" | "complex") {
  const userMsg = makeMessage(`msg-user-${turnIndex}`, sessionId, "user");
  const assistantMsg = makeMessage(`msg-asst-${turnIndex}`, sessionId, "assistant");

  const userParts: UnifiedPart[] = [
    makeTextPart(userMsg.id, sessionId, `User question ${turnIndex}: explain the codebase`),
  ];

  let assistantParts: UnifiedPart[];

  switch (complexity) {
    case "simple":
      assistantParts = [
        makeTextPart(assistantMsg.id, sessionId, "Here's a simple explanation..."),
      ];
      break;
    case "medium":
      assistantParts = [
        makeReasoningPart(assistantMsg.id, sessionId),
        makeToolPart(assistantMsg.id, sessionId, "read"),
        makeToolPart(assistantMsg.id, sessionId, "grep"),
        makeTextPart(assistantMsg.id, sessionId, "Based on my analysis..."),
      ];
      break;
    case "complex":
      assistantParts = [
        makeReasoningPart(assistantMsg.id, sessionId),
        makeToolPart(assistantMsg.id, sessionId, "read"),
        makeToolPart(assistantMsg.id, sessionId, "read"),
        makeToolPart(assistantMsg.id, sessionId, "grep"),
        makeToolPart(assistantMsg.id, sessionId, "glob"),
        makeToolPart(assistantMsg.id, sessionId, "list"),
        makeToolPart(assistantMsg.id, sessionId, "edit"),
        makeToolPart(assistantMsg.id, sessionId, "write"),
        makeToolPart(assistantMsg.id, sessionId, "shell"),
        makeToolPart(assistantMsg.id, sessionId, "todo"),
        makeTextPart(assistantMsg.id, sessionId, "I've completed all the changes..."),
      ];
      break;
  }

  return { userMsg, assistantMsg, userParts, assistantParts };
}

// ---------------------------------------------------------------------------
// Benchmark: filterParts cost
//
// filterParts is called at least 3 times per turn:
//   1. filteredUserParts
//   2. allStepsParts (iterates all assistant msgs)
//   3. Inside groupedRenderItems (via allStepsParts dependency)
// ---------------------------------------------------------------------------

const CONTEXT_TOOLS = new Set(["read", "grep", "glob", "list"]);

function filterParts(parts: UnifiedPart[], isWorking: boolean): UnifiedPart[] {
  return parts.filter((x) => {
    if (!x) return false;
    if (x.type === "step-start") return false;
    if (x.type === "snapshot") return false;
    if (x.type === "patch") return false;
    if (x.type === "step-finish") return false;
    if (x.type === "text" && (x as any).synthetic === true) return false;
    if (x.type === "tool" && (x as ToolPart).normalizedTool === "todo") return false;
    if (x.type === "text" && !(x as any).text) return false;
    if (x.type === "tool" && !isWorking &&
      ((x as any).state?.status === "pending" || (x as any).state?.status === "running")
    ) return false;
    return true;
  });
}

describe("filterParts cost", () => {
  for (const partCount of [5, 20, 50, 100]) {
    const parts: UnifiedPart[] = [];
    for (let i = 0; i < partCount; i++) {
      if (i % 4 === 0) parts.push(makeTextPart("msg-1", "s-1", `Text ${i}`));
      else if (i % 4 === 1) parts.push(makeToolPart("msg-1", "s-1", "read"));
      else if (i % 4 === 2) parts.push(makeReasoningPart("msg-1", "s-1"));
      else parts.push(makeToolPart("msg-1", "s-1", "shell"));
    }

    bench(`filter ${partCount} parts`, () => {
      filterParts(parts, false);
    });
  }
});

// ---------------------------------------------------------------------------
// Benchmark: groupedRenderItems computation
//
// This is the most complex memo in SessionTurn. It:
//   1. Reads allStepsParts (which reads messageStore.part[msg.id] for each msg)
//   2. Iterates all parts, grouping consecutive context tools (read/grep/glob/list)
//   3. Produces RenderItem[] that the view consumes
//
// We replicate the exact algorithm from SessionTurn.tsx lines 671-744.
// ---------------------------------------------------------------------------

type ContextGroupItem = { part: ToolPart; action: string; detail: string };
type RenderItem =
  | { kind: "part"; part: UnifiedPart; index: number; message: UnifiedMessage }
  | { kind: "context-group"; items: ContextGroupItem[]; isStreaming: boolean; isLast: boolean };

function computeGroupedRenderItems(
  stepsParts: Array<{ message: UnifiedMessage; parts: UnifiedPart[] }>,
  lastAssistantMsgId: string | undefined,
  isWorking: boolean,
): RenderItem[] {
  const result: RenderItem[] = [];

  for (const item of stepsParts) {
    let contextBuf: ContextGroupItem[] = [];
    const isLastMsg = item.message.id === lastAssistantMsgId;

    const flushContext = (isStreamingTail: boolean) => {
      if (contextBuf.length === 0) return;
      if (contextBuf.length >= 2) {
        result.push({
          kind: "context-group",
          items: [...contextBuf],
          isStreaming: isStreamingTail,
          isLast: isStreamingTail,
        });
      } else {
        for (const c of contextBuf) {
          result.push({
            kind: "part",
            part: c.part as unknown as UnifiedPart,
            index: item.parts.indexOf(c.part as unknown as UnifiedPart),
            message: item.message,
          });
        }
      }
      contextBuf = [];
    };

    for (let pi = 0; pi < item.parts.length; pi++) {
      const p = item.parts[pi];

      if (p.type === "tool" && CONTEXT_TOOLS.has((p as ToolPart).normalizedTool)) {
        const tp = p as ToolPart;
        contextBuf.push({ part: tp, action: tp.normalizedTool, detail: "" });
      } else {
        flushContext(false);
        result.push({ kind: "part", part: p, index: pi, message: item.message });
      }
    }

    const isStreamingTail = isLastMsg && isWorking;
    flushContext(isStreamingTail);
  }
  return result;
}

describe("groupedRenderItems computation", () => {
  // Simple turn: 1 assistant message with few parts
  const simpleTurn = createTurnData("s-1", 0, "simple");
  const simpleSteps = [{
    message: simpleTurn.assistantMsg,
    parts: filterParts(simpleTurn.assistantParts, false),
  }];

  bench("simple turn (1 text part)", () => {
    computeGroupedRenderItems(simpleSteps, simpleTurn.assistantMsg.id, false);
  });

  // Medium turn: reasoning + read + grep + text
  const mediumTurn = createTurnData("s-1", 1, "medium");
  const mediumSteps = [{
    message: mediumTurn.assistantMsg,
    parts: filterParts(mediumTurn.assistantParts, false),
  }];

  bench("medium turn (4 parts, 2 context tools)", () => {
    computeGroupedRenderItems(mediumSteps, mediumTurn.assistantMsg.id, false);
  });

  // Complex turn: many tools including context tool groups
  const complexTurn = createTurnData("s-1", 2, "complex");
  const complexSteps = [{
    message: complexTurn.assistantMsg,
    parts: filterParts(complexTurn.assistantParts, false),
  }];

  bench("complex turn (11 parts, 4 context tools grouped)", () => {
    computeGroupedRenderItems(complexSteps, complexTurn.assistantMsg.id, false);
  });

  // Multi-message turn: simulates ACP engines that produce multiple assistant messages
  const multiMsgSteps = Array.from({ length: 5 }, (_, i) => {
    const td = createTurnData("s-1", i + 10, "complex");
    return {
      message: td.assistantMsg,
      parts: filterParts(td.assistantParts, false),
    };
  });

  bench("multi-message turn (5 messages × 11 parts each)", () => {
    computeGroupedRenderItems(multiMsgSteps, multiMsgSteps[4].message.id, false);
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Full memo cascade simulation
//
// Simulates what happens when a single part update arrives during streaming:
// 1. Store update (setMessageStore)
// 2. All dependent memos recompute
// 3. Compare: how many memos actually produce different output?
//
// This is the MOST important benchmark — it directly measures the cost
// of one SSE token update propagating through SessionTurn's reactive graph.
// ---------------------------------------------------------------------------

describe("full memo cascade: single part update cost", () => {
  for (const complexity of ["simple", "medium", "complex"] as const) {
    bench(`${complexity} turn — update last text part (streaming hot path)`, () => {
      createRoot((dispose) => {
        const sessionId = "bench-session";
        const td = createTurnData(sessionId, 0, complexity);

        // Setup store with initial data
        const [store, setStore] = createStore({
          part: {
            [td.userMsg.id]: td.userParts,
            [td.assistantMsg.id]: td.assistantParts,
          } as Record<string, UnifiedPart[]>,
        });

        // Simulate the key memos from SessionTurn
        const userParts = createMemo(() => store.part[td.userMsg.id] || []);
        const lastTextPart = createMemo(() => {
          const parts = store.part[td.assistantMsg.id] || [];
          for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i]?.type === "text") return parts[i];
          }
          return undefined;
        });
        const streamingTextPart = createMemo(() => {
          const parts = store.part[td.assistantMsg.id] || [];
          for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i]?.type === "text" && (parts[i] as any).text) return parts[i];
          }
          return undefined;
        });
        const hasSteps = createMemo(() => {
          const parts = store.part[td.assistantMsg.id] || [];
          for (const p of parts) {
            if (p?.type === "reasoning") return true;
            if (p?.type === "tool" && (p as ToolPart).normalizedTool !== "todo") return true;
          }
          return false;
        });
        const isReasoningActive = createMemo(() => {
          const parts = store.part[td.assistantMsg.id] || [];
          for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i]?.type === "reasoning") return true;
            if (parts[i]?.type === "tool") return false;
          }
          return false;
        });
        const allStepsParts = createMemo(() => {
          const parts = store.part[td.assistantMsg.id] || [];
          const filtered = filterParts(parts, true);
          const responseText = streamingTextPart();
          return responseText ? filtered.filter(p => p.id !== responseText.id) : filtered;
        });
        const groupedItems = createMemo(() =>
          computeGroupedRenderItems(
            [{ message: td.assistantMsg, parts: allStepsParts() }],
            td.assistantMsg.id,
            true,
          ),
        );

        // Force initial evaluation
        userParts();
        lastTextPart();
        streamingTextPart();
        hasSteps();
        isReasoningActive();
        groupedItems();

        // NOW: simulate a streaming text update (the hottest path)
        const textPartIndex = td.assistantParts.findIndex(p => p.type === "text");
        if (textPartIndex >= 0) {
          setStore("part", td.assistantMsg.id, textPartIndex, {
            ...td.assistantParts[textPartIndex],
            text: "Updated streaming content with more words...",
          } as UnifiedPart);
        }

        // Force re-evaluation of all memos
        userParts();
        lastTextPart();
        streamingTextPart();
        hasSteps();
        isReasoningActive();
        groupedItems();

        dispose();
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Benchmark: Memory — store growth without cleanup
//
// When sessions are deleted, messageStore.part/message/expanded/stepsLoaded
// entries are NOT cleaned up. This simulates the accumulation.
// ---------------------------------------------------------------------------

describe("memory: store growth without cleanup", () => {
  bench("simulate 50 sessions without cleanup (measure store size)", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore<{
        part: Record<string, UnifiedPart[]>;
        message: Record<string, UnifiedMessage[]>;
        stepsLoaded: Record<string, boolean>;
        expanded: Record<string, boolean>;
      }>({
        part: {},
        message: {},
        stepsLoaded: {},
        expanded: {},
      });

      // Simulate 50 sessions being created and used
      for (let s = 0; s < 50; s++) {
        const sessionId = `session-${s}`;
        const messages: UnifiedMessage[] = [];

        // Each session has 5 turns (10 messages)
        for (let t = 0; t < 5; t++) {
          const td = createTurnData(sessionId, t, "complex");
          messages.push(td.userMsg, td.assistantMsg);
          setStore("part", td.userMsg.id, td.userParts);
          setStore("part", td.assistantMsg.id, td.assistantParts);
          setStore("stepsLoaded", td.assistantMsg.id, true);
          setStore("expanded", `steps-${td.userMsg.id}`, false);
        }

        setStore("message", sessionId, messages);
      }

      // Count total entries (this is what accumulates without cleanup)
      const partKeys = Object.keys(store.part).length;
      const msgKeys = Object.keys(store.message).length;
      const stepsKeys = Object.keys(store.stepsLoaded).length;
      const expandedKeys = Object.keys(store.expanded).length;

      // Force reads to ensure reactivity is established
      void partKeys;
      void msgKeys;
      void stepsKeys;
      void expandedKeys;

      dispose();
    });
  });

  bench("simulate 50 sessions WITH cleanup (compare store size)", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore<{
        part: Record<string, UnifiedPart[]>;
        message: Record<string, UnifiedMessage[]>;
        stepsLoaded: Record<string, boolean>;
        expanded: Record<string, boolean>;
      }>({
        part: {},
        message: {},
        stepsLoaded: {},
        expanded: {},
      });

      // Simulate 50 sessions — but only keep the last 10 (cleanup others)
      for (let s = 0; s < 50; s++) {
        const sessionId = `session-${s}`;
        const messages: UnifiedMessage[] = [];

        for (let t = 0; t < 5; t++) {
          const td = createTurnData(sessionId, t, "complex");
          messages.push(td.userMsg, td.assistantMsg);
          setStore("part", td.userMsg.id, td.userParts);
          setStore("part", td.assistantMsg.id, td.assistantParts);
          setStore("stepsLoaded", td.assistantMsg.id, true);
          setStore("expanded", `steps-${td.userMsg.id}`, false);
        }

        setStore("message", sessionId, messages);

        // Cleanup: if we have more than 10 sessions, remove the oldest
        if (s >= 10) {
          const oldSessionId = `session-${s - 10}`;
          const oldMessages = store.message[oldSessionId] || [];
          // Clean up parts, stepsLoaded, expanded for all messages in old session
          for (const msg of oldMessages) {
            setStore("part", msg.id, undefined as any);
            setStore("stepsLoaded", msg.id, undefined as any);
            setStore("expanded", `steps-${msg.id}`, undefined as any);
          }
          setStore("message", oldSessionId, undefined as any);
        }
      }

      dispose();
    });
  });
});

// ---------------------------------------------------------------------------
// Benchmark: diff parsing (ContentDiff)
//
// The `diff` library's parsePatch is called in a createMemo inside ContentDiff.
// Large diffs (e.g., refactoring a 500-line file) could be expensive.
// ---------------------------------------------------------------------------

describe("diff parsing (ContentDiff)", () => {
  function generateUnifiedDiff(changedLines: number, contextLines: number = 3): string {
    const lines: string[] = [
      "--- a/src/components/App.tsx",
      "+++ b/src/components/App.tsx",
      `@@ -1,${changedLines + contextLines * 2} +1,${changedLines + contextLines * 2} @@`,
    ];

    // Context before
    for (let i = 0; i < contextLines; i++) {
      lines.push(` const line${i} = "unchanged";`);
    }

    // Changed lines
    for (let i = 0; i < changedLines; i++) {
      lines.push(`-const old${i} = "before";`);
      lines.push(`+const new${i} = "after";`);
    }

    // Context after
    for (let i = 0; i < contextLines; i++) {
      lines.push(` const after${i} = "unchanged";`);
    }

    return lines.join("\n");
  }

  for (const lineCount of [5, 20, 50, 200]) {
    const diff = generateUnifiedDiff(lineCount);
    bench(`parsePatch: ${lineCount} changed lines (${diff.length} chars)`, () => {
      parsePatch(diff);
    });
  }

  // Also test the full ContentDiff pipeline: parsePatch + line classification
  bench("full ContentDiff pipeline: 50 changed lines (parse + classify)", () => {
    const diff = generateUnifiedDiff(50);
    const patches = parsePatch(diff);
    const unifiedLines: Array<{ content: string; type: string; oldLineNo?: number; newLineNo?: number }> = [];

    for (const patch of patches) {
      for (const hunk of patch.hunks) {
        let oldLineNo = hunk.oldStart;
        let newLineNo = hunk.newStart;
        for (const line of hunk.lines) {
          const content = line.slice(1);
          const prefix = line[0];
          if (prefix === "-") {
            unifiedLines.push({ content, type: "removed", oldLineNo: oldLineNo++ });
          } else if (prefix === "+") {
            unifiedLines.push({ content, type: "added", newLineNo: newLineNo++ });
          } else if (prefix === " ") {
            unifiedLines.push({ content: content || " ", type: "unchanged", oldLineNo: oldLineNo++, newLineNo: newLineNo++ });
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Benchmark: attachCopyButtons DOM simulation
//
// ContentMarkdown calls attachCopyButtons(container) in a createEffect
// every time displayHtml() changes (~6-7 times/sec during streaming).
// Each call does querySelectorAll("pre") + iterates all <pre> elements.
//
// We can't do real DOM here, but we can benchmark the analogous
// array-scan + dedup check pattern.
// ---------------------------------------------------------------------------

describe("attachCopyButtons simulation", () => {
  bench("scan 10 pre elements + check for existing buttons", () => {
    // Simulate: querySelectorAll("pre") returns 10 elements
    // Each element needs: querySelector("[data-component='copy-button']") check
    const pres = Array.from({ length: 10 }, (_, i) => ({
      id: `pre-${i}`,
      hasButton: i < 5, // half already have buttons
    }));

    let attached = 0;
    for (const pre of pres) {
      if (!pre.hasButton) {
        attached++;
        // Simulate createElement + appendChild (just track count)
      }
    }
  });

  bench("scan 50 pre elements (heavy response with many code blocks)", () => {
    const pres = Array.from({ length: 50 }, (_, i) => ({
      id: `pre-${i}`,
      hasButton: i < 25,
    }));

    let attached = 0;
    for (const pre of pres) {
      if (!pre.hasButton) {
        attached++;
      }
    }
  });
});
