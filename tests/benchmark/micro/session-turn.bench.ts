// =============================================================================
// Micro-benchmark: SessionTurn Memo Cascade & Store Access Patterns
//
// SessionTurn.tsx has 17+ createMemo calls that ALL read from
// messageStore.part[msg.id]. This benchmark measures:
//
// 1. The groupedRenderItems computation (most complex memo)
// 2. The full memo cascade cost when a single part update arrives
//
// These are the actual algorithms from SessionTurn.tsx reproduced verbatim
// to benchmark in isolation.
// =============================================================================

import { bench, describe } from "vitest";
import { createStore } from "solid-js/store";
import { createRoot, createMemo } from "solid-js";
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
function createTurnData(sessionId: string, turnIndex: number) {
  const userMsg = makeMessage(`msg-user-${turnIndex}`, sessionId, "user");
  const assistantMsg = makeMessage(`msg-asst-${turnIndex}`, sessionId, "assistant");

  const userParts: UnifiedPart[] = [
    makeTextPart(userMsg.id, sessionId, `User question ${turnIndex}: explain the codebase`),
  ];

  // Complex: 11 parts including 4 context tools, reasoning, and edit/shell
  const assistantParts: UnifiedPart[] = [
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

  return { userMsg, assistantMsg, userParts, assistantParts };
}

// ---------------------------------------------------------------------------
// Shared algorithms from SessionTurn.tsx
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

// ---------------------------------------------------------------------------
// Benchmark: groupedRenderItems — complex turn (core grouping algorithm)
// ---------------------------------------------------------------------------

describe("groupedRenderItems computation", () => {
  const complexTurn = createTurnData("s-1", 0);
  const complexSteps = [{
    message: complexTurn.assistantMsg,
    parts: filterParts(complexTurn.assistantParts, false),
  }];

  bench("complex turn (11 parts, 3 types)", () => {
    computeGroupedRenderItems(complexSteps, complexTurn.assistantMsg.id, false);
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Full memo cascade simulation
//
// Simulates what happens when a single part update arrives during streaming:
// 1. Store update (setMessageStore)
// 2. All dependent memos recompute
//
// This is the MOST important benchmark — it directly measures the cost
// of one SSE token update propagating through SessionTurn's reactive graph.
// ---------------------------------------------------------------------------

describe("full memo cascade: single part update cost", () => {
  bench("complex turn — full reactive cascade", () => {
    createRoot((dispose) => {
      const sessionId = "bench-session";
      const td = createTurnData(sessionId, 0);

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
});
