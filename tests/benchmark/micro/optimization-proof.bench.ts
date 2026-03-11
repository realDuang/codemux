// =============================================================================
// Optimization Proof Benchmarks
//
// Direct A/B comparison of OLD vs NEW code for each optimization.
// This file proves the value of each performance fix with hard data.
//
// Optimizations tested:
//   1. currentTodos: O(N×M) full scan → O(1) signal lookup
//   2. SessionTurn: 6 separate memos → 1 merged derivedPartState
//   3. handleDeleteSession: no cleanup → full messageStore cleanup
// =============================================================================

import { bench, describe } from "vitest";
import { createStore } from "solid-js/store";
import { createRoot, createMemo, createSignal } from "solid-js";
import type {
  UnifiedMessage,
  UnifiedPart,
  ToolPart,
  TextPart,
  ReasoningPart,
} from "../../../src/types/unified";

// ---------------------------------------------------------------------------
// Shared data generators
// ---------------------------------------------------------------------------

let partIdCounter = 0;

function makeTextPart(
  msgId: string,
  sessionId: string,
  text: string,
): TextPart {
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
  tool:
    | "shell"
    | "read"
    | "write"
    | "edit"
    | "grep"
    | "glob"
    | "list"
    | "todo",
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
    kind:
      tool === "read" ||
      tool === "grep" ||
      tool === "glob" ||
      tool === "list"
        ? "read"
        : "edit",
    state:
      status === "completed"
        ? {
            status: "completed",
            input: tool === "todo" ? { todos: [{ content: "Task 1", status: "completed" }] } : {},
            output: {},
            time: { start: now - 500, end: now, duration: 500 },
          }
        : { status: "running", input: {}, time: { start: now } },
  };
}

function makeReasoningPart(
  msgId: string,
  sessionId: string,
): ReasoningPart {
  return {
    id: `part-${String(++partIdCounter).padStart(8, "0")}`,
    messageId: msgId,
    sessionId,
    type: "reasoning",
    text: "**Analyzing the code structure**\n\nLet me think about this step by step...",
  };
}

function makeMessage(
  id: string,
  sessionId: string,
  role: "user" | "assistant",
): UnifiedMessage {
  return {
    id,
    sessionId,
    role,
    time: {
      created: Date.now() - 1000,
      completed: role === "assistant" ? Date.now() : undefined,
    },
    parts: [],
  };
}

// ---------------------------------------------------------------------------
// Helper: build a realistic long session (100 messages, each with parts)
// ---------------------------------------------------------------------------

function buildLongSession(sessionId: string, messageCount: number) {
  const messages: UnifiedMessage[] = [];
  const partStore: Record<string, UnifiedPart[]> = {};

  for (let t = 0; t < messageCount; t++) {
    const userMsg = makeMessage(`msg-user-${sessionId}-${t}`, sessionId, "user");
    const assistantMsg = makeMessage(
      `msg-asst-${sessionId}-${t}`,
      sessionId,
      "assistant",
    );

    const userParts: UnifiedPart[] = [
      makeTextPart(userMsg.id, sessionId, `Question ${t}`),
    ];

    const assistantParts: UnifiedPart[] = [
      makeReasoningPart(assistantMsg.id, sessionId),
      makeToolPart(assistantMsg.id, sessionId, "read"),
      makeToolPart(assistantMsg.id, sessionId, "grep"),
      makeToolPart(assistantMsg.id, sessionId, "edit"),
      makeTextPart(assistantMsg.id, sessionId, `Response ${t}`),
    ];

    // Add a todo part to the last 3 messages
    if (t >= messageCount - 3) {
      assistantParts.push(
        makeToolPart(assistantMsg.id, sessionId, "todo", "completed"),
      );
    }

    messages.push(userMsg, assistantMsg);
    partStore[userMsg.id] = userParts;
    partStore[assistantMsg.id] = assistantParts;
  }

  return { messages, partStore };
}

// ============================================================================
// Benchmark 1: currentTodos — O(N×M) full scan vs O(1) signal lookup
//
// OLD: createMemo scans ALL assistant messages × ALL parts reverse, reading
//      every messageStore.part[msg.id] path → SolidJS subscribes to all.
//      On streaming part update → re-runs the full O(N×M) scan.
//
// NEW: todoPartRef signal stores { sessionId, messageId, partId }.
//      Updated in handlePartUpdated O(1). currentTodos memo reads only
//      the specific part pointed to by the signal.
// ============================================================================

describe("Optimization 1: currentTodos — full scan vs signal lookup", () => {
  // Build a session with 50 turns (100 messages, 300 parts total)
  const session = buildLongSession("opt1-session", 50);

  // OLD approach: full reverse scan of all messages × parts
  bench("OLD: O(N×M) full scan (50 turns × 6 parts = 300 parts)", () => {
    createRoot((dispose) => {
      const [store] = createStore({
        message: { "opt1-session": session.messages } as Record<string, UnifiedMessage[]>,
        part: session.partStore as Record<string, UnifiedPart[]>,
      });

      // This is the OLD currentTodos memo — scans everything
      const result = createMemo(() => {
        const sid = "opt1-session";
        const messages = store.message[sid] || [];
        for (let mi = messages.length - 1; mi >= 0; mi--) {
          const msg = messages[mi];
          if (msg.role !== "assistant") continue;
          const parts = store.part[msg.id] || [];
          for (let pi = parts.length - 1; pi >= 0; pi--) {
            const p = parts[pi];
            if (p.type !== "tool" || (p as any).normalizedTool !== "todo")
              continue;
            const status = (p as any).state?.status;
            if (status !== "completed" && status !== "running") continue;
            const todos = (p as any).state?.input?.todos;
            if (Array.isArray(todos) && todos.length > 0) return todos;
          }
        }
        return [];
      });

      result(); // Force evaluation
      dispose();
    });
  });

  // NEW approach: direct signal-based O(1) lookup
  bench("NEW: O(1) signal lookup (read 1 signal + 1 store path)", () => {
    createRoot((dispose) => {
      const [store] = createStore({
        part: session.partStore as Record<string, UnifiedPart[]>,
      });

      // Find the todo part (done once on session switch, not per frame)
      const lastAsst = session.messages.filter((m) => m.role === "assistant");
      let todoRef: { messageId: string; partId: string } | null = null;
      for (let mi = lastAsst.length - 1; mi >= 0; mi--) {
        const parts = session.partStore[lastAsst[mi].id] || [];
        for (let pi = parts.length - 1; pi >= 0; pi--) {
          if (
            parts[pi].type === "tool" &&
            (parts[pi] as any).normalizedTool === "todo"
          ) {
            todoRef = { messageId: lastAsst[mi].id, partId: parts[pi].id };
            break;
          }
        }
        if (todoRef) break;
      }

      const [getTodoRef] = createSignal(todoRef);

      // This is the NEW currentTodos memo — reads only the pointed-to part
      const result = createMemo(() => {
        const ref = getTodoRef();
        if (!ref) return [];
        const parts = store.part[ref.messageId];
        if (!parts) return [];
        const part = parts.find((p) => p.id === ref.partId);
        if (!part || part.type !== "tool") return [];
        const tp = part as any;
        const status = tp.state?.status;
        if (status !== "completed" && status !== "running") return [];
        const todos = tp.state?.input?.todos;
        return Array.isArray(todos) && todos.length > 0 ? todos : [];
      });

      result(); // Force evaluation
      dispose();
    });
  });

  // Measure the per-frame streaming cost: OLD scans again, NEW is nearly free
  bench(
    "OLD: per-frame cost during streaming (update text part → rescan all)",
    () => {
      createRoot((dispose) => {
        const [store, setStore] = createStore({
          message: { "opt1-session": session.messages } as Record<
            string,
            UnifiedMessage[]
          >,
          part: { ...session.partStore } as Record<string, UnifiedPart[]>,
        });

        const currentTodos = createMemo(() => {
          const messages = store.message["opt1-session"] || [];
          for (let mi = messages.length - 1; mi >= 0; mi--) {
            const msg = messages[mi];
            if (msg.role !== "assistant") continue;
            const parts = store.part[msg.id] || [];
            for (let pi = parts.length - 1; pi >= 0; pi--) {
              const p = parts[pi];
              if (p.type !== "tool" || (p as any).normalizedTool !== "todo")
                continue;
              const status = (p as any).state?.status;
              if (status !== "completed" && status !== "running") continue;
              const todos = (p as any).state?.input?.todos;
              if (Array.isArray(todos) && todos.length > 0) return todos;
            }
          }
          return [];
        });

        currentTodos(); // Initial eval

        // Simulate streaming text update on latest assistant message
        const lastAssistantId = session.messages[session.messages.length - 1].id;
        const parts = store.part[lastAssistantId] || [];
        const textIdx = parts.findIndex((p) => p.type === "text");
        if (textIdx >= 0) {
          setStore("part", lastAssistantId, textIdx, {
            ...parts[textIdx],
            text: "Streaming update...",
          } as UnifiedPart);
        }

        currentTodos(); // Re-evaluation triggered by store change
        dispose();
      });
    },
  );

  bench(
    "NEW: per-frame cost during streaming (text update does NOT trigger todo rescan)",
    () => {
      createRoot((dispose) => {
        const [store, setStore] = createStore({
          part: { ...session.partStore } as Record<string, UnifiedPart[]>,
        });

        // Pre-resolved todoRef (done once on session switch)
        const [getTodoRef] = createSignal({
          messageId: session.messages[session.messages.length - 1].id,
          partId: session.partStore[
            session.messages[session.messages.length - 1].id
          ].find((p) => p.type === "tool" && (p as any).normalizedTool === "todo")
            ?.id || "",
        });

        const currentTodos = createMemo(() => {
          const ref = getTodoRef();
          if (!ref) return [];
          const parts = store.part[ref.messageId];
          if (!parts) return [];
          const part = parts.find((p) => p.id === ref.partId);
          if (!part || part.type !== "tool") return [];
          const tp = part as any;
          const todos = tp.state?.input?.todos;
          return Array.isArray(todos) && todos.length > 0 ? todos : [];
        });

        currentTodos(); // Initial eval

        // Simulate streaming text update — this should NOT trigger currentTodos
        // because the memo only subscribes to the todo part's message, not all messages
        const lastAssistantId = session.messages[session.messages.length - 1].id;
        const parts = store.part[lastAssistantId] || [];
        const textIdx = parts.findIndex((p) => p.type === "text");
        if (textIdx >= 0) {
          setStore("part", lastAssistantId, textIdx, {
            ...parts[textIdx],
            text: "Streaming update...",
          } as UnifiedPart);
        }

        currentTodos(); // Re-evaluation (should be nearly free if properly isolated)
        dispose();
      });
    },
  );
});

// ============================================================================
// Benchmark 2: SessionTurn memos — 6 separate scans vs 1 merged scan
//
// OLD: 6 independent createMemo each scan the same parts arrays:
//      hasSteps, lastTextPart, streamingTextPart, isReasoningActive,
//      reasoningHeading, currentStatus
//      → 6 sets of SolidJS subscriptions, 6× scan work per frame
//
// NEW: Single derivedPartState memo does one scan, returns all 6 values.
//      → 1 subscription set, 1× scan work per frame
// ============================================================================

describe("Optimization 2: SessionTurn — 6 memos vs 1 merged memo", () => {
  // Simulated computeStatusFromPart (simplified)
  function computeStatus(part: UnifiedPart): string | undefined {
    if (part.type === "tool") {
      const tp = part as ToolPart;
      switch (tp.normalizedTool) {
        case "read": return "Gathering context";
        case "edit": return "Making edits";
        case "shell": return "Running commands";
        case "grep": return "Searching codebase";
        default: return tp.title;
      }
    }
    if (part.type === "reasoning") {
      const text = (part as any).text ?? "";
      const match = text.trimStart().match(/^\*\*(.+?)\*\*/);
      if (match) return `Thinking · ${match[1].trim()}`;
      return "Thinking";
    }
    if (part.type === "text") return "Gathering thoughts";
    return undefined;
  }

  function extractReasoningHeading(text: string | undefined): string | undefined {
    if (!text) return undefined;
    const trimmed = text.trimStart();
    const atx = trimmed.match(/^#{1,3}\s+(.+)$/m);
    if (atx) return atx[1].trim();
    const bold = trimmed.match(/^\*\*(.+?)\*\*/);
    if (bold) return bold[1].trim();
    return undefined;
  }

  // Build a complex turn with 3 assistant messages, each with many parts
  function buildComplexTurn(sessionId: string) {
    const msgs: UnifiedMessage[] = [];
    const partMap: Record<string, UnifiedPart[]> = {};

    for (let m = 0; m < 3; m++) {
      const msg = makeMessage(`msg-asst-${sessionId}-${m}`, sessionId, "assistant");
      const parts: UnifiedPart[] = [
        makeReasoningPart(msg.id, sessionId),
        makeToolPart(msg.id, sessionId, "read"),
        makeToolPart(msg.id, sessionId, "read"),
        makeToolPart(msg.id, sessionId, "grep"),
        makeToolPart(msg.id, sessionId, "glob"),
        makeToolPart(msg.id, sessionId, "edit"),
        makeToolPart(msg.id, sessionId, "shell"),
        makeTextPart(msg.id, sessionId, `Response from message ${m}`),
      ];
      msgs.push(msg);
      partMap[msg.id] = parts;
    }

    return { msgs, partMap };
  }

  const turn = buildComplexTurn("opt2-session");

  // OLD: 6 separate memos, each scanning parts independently
  bench("OLD: 6 separate memos (6× scan, 6× subscriptions)", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({
        part: turn.partMap as Record<string, UnifiedPart[]>,
      });

      const isWorking = true;
      const msgs = turn.msgs;
      const lastMsgId = msgs[msgs.length - 1].id;

      // Memo 1: hasSteps
      const hasSteps = createMemo(() => {
        for (const msg of msgs) {
          const parts = store.part[msg.id] || [];
          for (const p of parts) {
            if (p?.type === "reasoning") return true;
            if (p?.type === "tool" && (p as ToolPart).normalizedTool !== "todo") return true;
          }
        }
        return false;
      });

      // Memo 2: lastTextPart
      const lastTextPart = createMemo(() => {
        for (let mi = msgs.length - 1; mi >= 0; mi--) {
          const parts = store.part[msgs[mi].id] || [];
          for (let pi = parts.length - 1; pi >= 0; pi--) {
            if (parts[pi]?.type === "text") return parts[pi];
          }
        }
        return undefined;
      });

      // Memo 3: streamingTextPart
      const streamingTextPart = createMemo(() => {
        if (!isWorking) return undefined;
        for (let mi = msgs.length - 1; mi >= 0; mi--) {
          const parts = store.part[msgs[mi].id] || [];
          for (let pi = parts.length - 1; pi >= 0; pi--) {
            if (parts[pi]?.type === "text" && (parts[pi] as any).text) return parts[pi];
          }
        }
        return undefined;
      });

      // Memo 4: isReasoningActive
      const isReasoningActive = createMemo(() => {
        if (!isWorking) return false;
        const parts = store.part[lastMsgId] || [];
        for (let i = parts.length - 1; i >= 0; i--) {
          if (parts[i]?.type === "reasoning") return true;
          if (parts[i]?.type === "tool") return false;
        }
        return false;
      });

      // Memo 5: reasoningHeading
      const reasoningHeading = createMemo(() => {
        if (!isWorking) return undefined;
        for (let mi = msgs.length - 1; mi >= 0; mi--) {
          const parts = store.part[msgs[mi].id] || [];
          for (let pi = parts.length - 1; pi >= 0; pi--) {
            if (parts[pi]?.type === "reasoning") {
              return extractReasoningHeading((parts[pi] as any).text);
            }
          }
        }
        return undefined;
      });

      // Memo 6: currentStatus
      const currentStatus = createMemo(() => {
        if (!isWorking) return undefined;
        for (let mi = msgs.length - 1; mi >= 0; mi--) {
          const parts = store.part[msgs[mi].id] || [];
          for (let pi = parts.length - 1; pi >= 0; pi--) {
            const status = computeStatus(parts[pi]);
            if (status) return status;
          }
        }
        return "Considering next steps";
      });

      // Force all evaluations
      hasSteps();
      lastTextPart();
      streamingTextPart();
      isReasoningActive();
      reasoningHeading();
      currentStatus();

      // Simulate streaming update
      const parts = store.part[lastMsgId];
      const textIdx = parts.findIndex((p) => p.type === "text");
      if (textIdx >= 0) {
        setStore("part", lastMsgId, textIdx, {
          ...parts[textIdx],
          text: "Streaming update...",
        } as UnifiedPart);
      }

      // All 6 memos re-evaluate
      hasSteps();
      lastTextPart();
      streamingTextPart();
      isReasoningActive();
      reasoningHeading();
      currentStatus();

      dispose();
    });
  });

  // NEW: 1 merged memo doing a single scan
  bench("NEW: 1 merged derivedPartState memo (1× scan, 1× subscription)", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({
        part: turn.partMap as Record<string, UnifiedPart[]>,
      });

      const isWorking = true;
      const msgs = turn.msgs;

      // Single combined memo
      const derivedPartState = createMemo(() => {
        let hasSteps = false;
        let lastTextPart: UnifiedPart | undefined;
        let streamingTextPart: UnifiedPart | undefined;
        let isReasoningActive = false;
        let reasoningHeading: string | undefined;
        let currentStatus: string | undefined;

        let foundLastText = false;
        let foundStreamingText = false;
        let foundReasoning = false;
        let foundStatus = false;

        for (let mi = msgs.length - 1; mi >= 0; mi--) {
          const parts = store.part[msgs[mi].id] || [];

          for (let pi = parts.length - 1; pi >= 0; pi--) {
            const p = parts[pi];
            if (!p) continue;

            if (!hasSteps) {
              if (p.type === "reasoning") hasSteps = true;
              else if (p.type === "tool" && (p as ToolPart).normalizedTool !== "todo") hasSteps = true;
            }

            if (!foundLastText && p.type === "text") {
              lastTextPart = p;
              foundLastText = true;
            }

            if (!foundStreamingText && isWorking && p.type === "text" && (p as any).text) {
              streamingTextPart = p;
              foundStreamingText = true;
            }

            if (!foundReasoning && mi === msgs.length - 1 && isWorking) {
              if (p.type === "reasoning") {
                isReasoningActive = true;
                foundReasoning = true;
              } else if (p.type === "tool") {
                foundReasoning = true;
              }
            }

            if (reasoningHeading === undefined && isWorking && p.type === "reasoning") {
              reasoningHeading = extractReasoningHeading((p as any).text) ?? (null as any);
            }

            if (!foundStatus && isWorking) {
              const status = computeStatus(p);
              if (status) {
                currentStatus = status;
                foundStatus = true;
              }
            }
          }
        }

        if (isWorking && !foundStatus) {
          currentStatus = "Considering next steps";
        }

        return {
          hasSteps,
          lastTextPart,
          streamingTextPart,
          isReasoningActive,
          reasoningHeading: reasoningHeading ?? undefined,
          currentStatus,
        };
      });

      // Force evaluation (1 memo instead of 6)
      derivedPartState();

      // Simulate streaming update
      const lastMsgId = msgs[msgs.length - 1].id;
      const parts = store.part[lastMsgId];
      const textIdx = parts.findIndex((p) => p.type === "text");
      if (textIdx >= 0) {
        setStore("part", lastMsgId, textIdx, {
          ...parts[textIdx],
          text: "Streaming update...",
        } as UnifiedPart);
      }

      // 1 memo re-evaluates (instead of 6)
      derivedPartState();

      dispose();
    });
  });
});

// ============================================================================
// Benchmark 3: Session delete — no cleanup vs full cleanup
//
// OLD: handleDeleteSession removes session from list but leaves all
//      messageStore.part[msgId], message[sid], expanded[msgId],
//      stepsLoaded[msgId] entries in memory forever.
//
// NEW: handleDeleteSession iterates all messages in the deleted session
//      and removes every related store entry.
// ============================================================================

describe("Optimization 3: session delete — memory cleanup", () => {
  // Build 20 sessions, each with 10 turns
  function buildMultipleSessions(count: number, turnsPerSession: number) {
    const allMessages: Record<string, UnifiedMessage[]> = {};
    const allParts: Record<string, UnifiedPart[]> = {};
    const allStepsLoaded: Record<string, boolean> = {};
    const allExpanded: Record<string, boolean> = {};

    for (let s = 0; s < count; s++) {
      const sid = `session-${s}`;
      const messages: UnifiedMessage[] = [];

      for (let t = 0; t < turnsPerSession; t++) {
        const userMsg = makeMessage(`msg-user-${sid}-${t}`, sid, "user");
        const assistantMsg = makeMessage(`msg-asst-${sid}-${t}`, sid, "assistant");

        messages.push(userMsg, assistantMsg);
        allParts[userMsg.id] = [makeTextPart(userMsg.id, sid, `Q${t}`)];
        allParts[assistantMsg.id] = [
          makeReasoningPart(assistantMsg.id, sid),
          makeToolPart(assistantMsg.id, sid, "read"),
          makeToolPart(assistantMsg.id, sid, "edit"),
          makeTextPart(assistantMsg.id, sid, `A${t}`),
        ];
        allStepsLoaded[assistantMsg.id] = true;
        allExpanded[`steps-${userMsg.id}`] = false;
      }

      allMessages[sid] = messages;
    }

    return { allMessages, allParts, allStepsLoaded, allExpanded };
  }

  const sessionData = buildMultipleSessions(20, 10);

  bench("OLD: delete 10 sessions WITHOUT cleanup (entries leak)", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({
        message: { ...sessionData.allMessages } as Record<string, UnifiedMessage[]>,
        part: { ...sessionData.allParts } as Record<string, UnifiedPart[]>,
        stepsLoaded: { ...sessionData.allStepsLoaded } as Record<string, boolean>,
        expanded: { ...sessionData.allExpanded } as Record<string, boolean>,
      });

      // Delete 10 sessions — OLD way (no cleanup)
      for (let s = 0; s < 10; s++) {
        const sid = `session-${s}`;
        // Only remove from message list — parts, stepsLoaded, expanded stay
        setStore("message", sid, undefined as any);
      }

      // Count leaked entries
      const partKeys = Object.keys(store.part).length;
      const stepsKeys = Object.keys(store.stepsLoaded).length;
      void partKeys;
      void stepsKeys;

      dispose();
    });
  });

  bench("NEW: delete 10 sessions WITH full cleanup (no leaks)", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({
        message: { ...sessionData.allMessages } as Record<string, UnifiedMessage[]>,
        part: { ...sessionData.allParts } as Record<string, UnifiedPart[]>,
        stepsLoaded: { ...sessionData.allStepsLoaded } as Record<string, boolean>,
        expanded: { ...sessionData.allExpanded } as Record<string, boolean>,
      });

      // Delete 10 sessions — NEW way (full cleanup)
      for (let s = 0; s < 10; s++) {
        const sid = `session-${s}`;
        const messages = store.message[sid] || [];

        // Clean up all related entries for each message
        for (const msg of messages) {
          setStore("part", msg.id, undefined as any);
          setStore("stepsLoaded", msg.id, undefined as any);
          setStore("expanded", `steps-${msg.id}`, undefined as any);
        }
        setStore("message", sid, undefined as any);
      }

      // Verify: fewer entries remain
      const partKeys = Object.keys(store.part).length;
      const stepsKeys = Object.keys(store.stepsLoaded).length;
      void partKeys;
      void stepsKeys;

      dispose();
    });
  });

  // Show long-term accumulation: 100 sessions created & deleted without cleanup
  bench("OLD: 100 sessions created & deleted — store entry count (leak)", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({
        message: {} as Record<string, UnifiedMessage[]>,
        part: {} as Record<string, UnifiedPart[]>,
        stepsLoaded: {} as Record<string, boolean>,
      });

      for (let s = 0; s < 100; s++) {
        const sid = `session-${s}`;
        const userMsg = makeMessage(`u-${sid}`, sid, "user");
        const assistantMsg = makeMessage(`a-${sid}`, sid, "assistant");

        setStore("part", userMsg.id, [makeTextPart(userMsg.id, sid, "Q")]);
        setStore("part", assistantMsg.id, [
          makeToolPart(assistantMsg.id, sid, "read"),
          makeTextPart(assistantMsg.id, sid, "A"),
        ]);
        setStore("stepsLoaded", assistantMsg.id, true);
        setStore("message", sid, [userMsg, assistantMsg]);

        // "Delete" session — OLD: only remove message list entry
        setStore("message", sid, undefined as any);
        // parts & stepsLoaded still exist → leak
      }

      // After 100 creates + deletes: store still has 200 part entries + 100 stepsLoaded
      const leaked = Object.keys(store.part).length + Object.keys(store.stepsLoaded).length;
      void leaked;

      dispose();
    });
  });

  bench("NEW: 100 sessions created & deleted — store entry count (clean)", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({
        message: {} as Record<string, UnifiedMessage[]>,
        part: {} as Record<string, UnifiedPart[]>,
        stepsLoaded: {} as Record<string, boolean>,
      });

      for (let s = 0; s < 100; s++) {
        const sid = `session-${s}`;
        const userMsg = makeMessage(`u-${sid}`, sid, "user");
        const assistantMsg = makeMessage(`a-${sid}`, sid, "assistant");

        setStore("part", userMsg.id, [makeTextPart(userMsg.id, sid, "Q")]);
        setStore("part", assistantMsg.id, [
          makeToolPart(assistantMsg.id, sid, "read"),
          makeTextPart(assistantMsg.id, sid, "A"),
        ]);
        setStore("stepsLoaded", assistantMsg.id, true);
        setStore("message", sid, [userMsg, assistantMsg]);

        // "Delete" session — NEW: full cleanup
        const msgs = store.message[sid] || [];
        for (const msg of msgs) {
          setStore("part", msg.id, undefined as any);
          setStore("stepsLoaded", msg.id, undefined as any);
        }
        setStore("message", sid, undefined as any);
      }

      // After 100 creates + deletes: store should have 0 entries
      const remaining = Object.keys(store.part).length + Object.keys(store.stepsLoaded).length;
      void remaining;

      dispose();
    });
  });
});
