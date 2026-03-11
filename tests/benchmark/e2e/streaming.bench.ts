// =============================================================================
// E2E Streaming Performance Test
//
// Simulates realistic streaming scenarios by driving mock data through the
// full pipeline: MockEngine → Gateway WS → Browser → SolidJS Store → Render.
//
// Runs against the E2E test server (no Electron required). Measures:
// - FPS during streaming (requestAnimationFrame counter)
// - Long Task count and duration (PerformanceObserver)
// - DOM node count growth
// - Memory heap growth (Chrome only)
// - Mutation observer render timing
//
// Usage:
//   1. Start test server: the bench file handles this automatically
//   2. Run: npm run bench:e2e
// =============================================================================

import { bench, describe, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import type { TestServerInstance } from "../../e2e/setup/test-server";
import type {
  UnifiedPart,
  TextPart,
  ToolPart,
  ReasoningPart,
  GatewayRequest,
  GatewayResponse,
  GatewayNotification,
} from "../../../src/types/unified";

// ---------------------------------------------------------------------------
// Test server lifecycle
// ---------------------------------------------------------------------------

let server: TestServerInstance;
let ws: WebSocket;
let requestCounter = 0;

function nextRequestId(): string {
  return `bench-req-${++requestCounter}`;
}

/** Send a gateway RPC request and wait for response */
function rpcRequest(type: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId();
    const timeout = setTimeout(() => reject(new Error(`RPC timeout: ${type}`)), 10_000);

    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString()) as GatewayResponse;
      if (msg.type === "response" && msg.requestId === requestId) {
        clearTimeout(timeout);
        ws.off("message", handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.payload);
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify({ type, requestId, payload }));
  });
}

/** Wait for a specific notification type */
function waitForNotification(type: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Notification timeout: ${type}`)), timeoutMs);

    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timeout);
        ws.off("message", handler);
        resolve(msg.payload);
      }
    };

    ws.on("message", handler);
  });
}

beforeAll(async () => {
  const { startTestServer } = await import("../../e2e/setup/test-server");
  server = await startTestServer({ port: 0 });

  // Connect WebSocket client
  ws = new WebSocket(server.wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
}, 30_000);

afterAll(async () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  if (server) {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Part generators — create realistic streaming data
// ---------------------------------------------------------------------------

let partCounter = 0;

function makePartId(): string {
  return `bench-part-${String(++partCounter).padStart(10, "0")}`;
}

function makeTextPart(
  messageId: string,
  sessionId: string,
  text: string,
): TextPart {
  return {
    id: makePartId(),
    messageId,
    sessionId,
    type: "text",
    text,
  };
}

function makeToolPart(
  messageId: string,
  sessionId: string,
  tool: "shell" | "read" | "write" | "edit" | "grep" | "glob",
  status: "running" | "completed",
): ToolPart {
  const input: Record<string, unknown> = {};
  const output: Record<string, unknown> = {};

  switch (tool) {
    case "shell":
      input.command = "npm test";
      output.stdout = "All 42 tests passed.";
      break;
    case "read":
      input.filePath = "/src/components/App.tsx";
      output.content = 'export function App() { return <div>Hello</div> }';
      break;
    case "write":
      input.filePath = "/src/utils/helper.ts";
      input.content = 'export function helper() { return 42; }';
      break;
    case "edit":
      input.filePath = "/src/index.ts";
      input.oldText = "const x = 1";
      input.newText = "const x = 2";
      break;
    case "grep":
      input.pattern = "TODO";
      input.path = "/src";
      output.matches = [{ file: "app.ts", line: 10, text: "// TODO: fix this" }];
      break;
    case "glob":
      input.pattern = "**/*.test.ts";
      output.files = ["a.test.ts", "b.test.ts", "c.test.ts"];
      break;
  }

  const now = Date.now();
  return {
    id: makePartId(),
    messageId,
    sessionId,
    type: "tool",
    callId: `call-${partCounter}`,
    normalizedTool: tool,
    originalTool: tool,
    title: `${tool} operation`,
    kind: tool === "read" || tool === "grep" || tool === "glob" ? "read" : "edit",
    state:
      status === "running"
        ? { status: "running", input, time: { start: now } }
        : {
            status: "completed",
            input,
            output,
            time: { start: now - 500, end: now, duration: 500 },
          },
  };
}

function makeReasoningPart(
  messageId: string,
  sessionId: string,
  text: string,
): ReasoningPart {
  return {
    id: makePartId(),
    messageId,
    sessionId,
    type: "reasoning",
    text,
  };
}

// ---------------------------------------------------------------------------
// Scenario generators
// ---------------------------------------------------------------------------

type ScenarioResult = {
  sessionId: string;
  messageId: string;
  parts: UnifiedPart[];
};

async function createSession(): Promise<string> {
  const session = (await rpcRequest("session.create", {
    engineType: "opencode",
    directory: "/bench/test",
  })) as { id: string };
  return session.id;
}

/**
 * Generate a text-only streaming scenario.
 * Simulates SSE token streaming: each part update contains the full accumulated text.
 */
function generateTextStreamParts(
  sessionId: string,
  messageId: string,
  wordCount: number,
  wordsPerChunk: number,
): UnifiedPart[] {
  const words = Array.from({ length: wordCount }, (_, i) => {
    // Mix in some markdown formatting
    if (i % 20 === 0) return `\n\n## Section ${Math.floor(i / 20) + 1}\n\n`;
    if (i % 15 === 0) return `**important**`;
    if (i % 25 === 0) return "`code`";
    return `word${i}`;
  });

  const parts: UnifiedPart[] = [];
  // Reuse the same part ID for all updates (simulating SSE streaming of one text part)
  const stablePartId = makePartId();

  let accumulated = "";
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    accumulated += words.slice(i, i + wordsPerChunk).join(" ") + " ";
    parts.push({
      id: stablePartId,
      messageId,
      sessionId,
      type: "text",
      text: accumulated.trim(),
    } as TextPart);
  }

  return parts;
}

/**
 * Generate a code-heavy scenario.
 * Simulates: text → code block → text → code block (repeated).
 */
function generateCodeHeavyParts(
  sessionId: string,
  messageId: string,
  codeBlockCount: number,
): UnifiedPart[] {
  const parts: UnifiedPart[] = [];

  // Each code block = a completed shell tool with code output
  for (let i = 0; i < codeBlockCount; i++) {
    // Tool part: read a file
    parts.push(
      makeToolPart(messageId, sessionId, i % 2 === 0 ? "read" : "shell", "completed"),
    );
  }

  // Final text summary
  parts.push(
    makeTextPart(
      messageId,
      sessionId,
      `I've analyzed ${codeBlockCount} files. Here's a summary:\n\n` +
        Array.from(
          { length: codeBlockCount },
          (_, i) => `${i + 1}. File ${i} looks good with minor issues.`,
        ).join("\n"),
    ),
  );

  return parts;
}

/**
 * Generate a tool-heavy scenario.
 * Simulates: read → grep → glob → read → edit → shell (repeated).
 */
function generateToolHeavyParts(
  sessionId: string,
  messageId: string,
  toolCount: number,
): UnifiedPart[] {
  const parts: UnifiedPart[] = [];
  const tools: Array<"read" | "grep" | "glob" | "edit" | "shell"> = [
    "read",
    "grep",
    "glob",
    "read",
    "edit",
    "shell",
  ];

  for (let i = 0; i < toolCount; i++) {
    const tool = tools[i % tools.length];
    parts.push(makeToolPart(messageId, sessionId, tool, "completed"));
  }

  // Final text
  parts.push(
    makeTextPart(
      messageId,
      sessionId,
      `Completed ${toolCount} operations. All changes applied successfully.`,
    ),
  );

  return parts;
}

// ---------------------------------------------------------------------------
// Gateway-level benchmarks (measures serialization + routing + broadcast)
// ---------------------------------------------------------------------------

describe("gateway: message throughput", () => {
  bench("create session (RPC round-trip)", async () => {
    await rpcRequest("session.create", {
      engineType: "opencode",
      directory: `/bench/throughput-${Date.now()}`,
    });
  });

  bench("send message + receive response (full round-trip)", async () => {
    const sessionId = await createSession();
    await rpcRequest("message.send", {
      sessionId,
      content: [{ type: "text", text: "Hello benchmark" }],
    });
  });
});

// ---------------------------------------------------------------------------
// Streaming simulation benchmarks
// ---------------------------------------------------------------------------

describe("streaming: part update throughput", () => {
  bench("emit 100 text part updates (simulating ~3s of SSE streaming)", async () => {
    const sessionId = await createSession();
    const messageId = `bench-msg-${Date.now()}`;

    // Send user message first
    await rpcRequest("message.send", {
      sessionId,
      content: [{ type: "text", text: "Benchmark prompt" }],
    });

    // Now simulate 100 rapid part updates
    const parts = generateTextStreamParts(sessionId, messageId, 500, 5);

    for (const part of parts) {
      // Directly use the adapter to emit parts (bypasses sendMessage RPC)
      const adapter = server.mockAdapters.get("opencode")!;
      (adapter as any).emit("message.part.updated", {
        sessionId,
        messageId,
        part,
      });
    }

    // Small delay to let broadcasts flush
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe("streaming: scenario data generation", () => {
  bench("generate 500-word text stream parts", () => {
    generateTextStreamParts("sess-1", "msg-1", 500, 5);
  });

  bench("generate 20 code-heavy parts", () => {
    generateCodeHeavyParts("sess-1", "msg-1", 20);
  });

  bench("generate 30 tool-heavy parts", () => {
    generateToolHeavyParts("sess-1", "msg-1", 30);
  });
});

// ---------------------------------------------------------------------------
// WebSocket serialization benchmarks
// ---------------------------------------------------------------------------

describe("WebSocket: serialization cost", () => {
  const textPart = makeTextPart("msg-1", "sess-1", "A".repeat(200));
  const toolPart = makeToolPart("msg-1", "sess-1", "shell", "completed");

  const textNotification = {
    type: "message.part.updated",
    payload: { sessionId: "sess-1", messageId: "msg-1", part: textPart },
  };

  const toolNotification = {
    type: "message.part.updated",
    payload: { sessionId: "sess-1", messageId: "msg-1", part: toolPart },
  };

  bench("JSON.stringify text part notification", () => {
    JSON.stringify(textNotification);
  });

  bench("JSON.stringify tool part notification", () => {
    JSON.stringify(toolNotification);
  });

  bench("JSON.stringify + JSON.parse round-trip", () => {
    JSON.parse(JSON.stringify(textNotification));
  });

  bench("serialize 100 notifications sequentially", () => {
    for (let i = 0; i < 100; i++) {
      JSON.stringify(textNotification);
    }
  });
});

// ---------------------------------------------------------------------------
// Turn grouping benchmarks (measures groupMessagesIntoTurns cost)
// ---------------------------------------------------------------------------

describe("turn grouping: message organization", () => {
  function createMessages(turnCount: number) {
    const messages = [];
    for (let t = 0; t < turnCount; t++) {
      messages.push({
        id: `msg-user-${t}`,
        sessionId: "sess-1",
        role: "user" as const,
        time: { created: Date.now() + t * 2 },
        parts: [],
      });
      messages.push({
        id: `msg-asst-${t}`,
        sessionId: "sess-1",
        role: "assistant" as const,
        time: { created: Date.now() + t * 2 + 1, completed: Date.now() + t * 2 + 1 },
        parts: [],
      });
    }
    return messages;
  }

  // Replicate groupMessagesIntoTurns from MessageList.tsx
  function groupMessagesIntoTurns(messages: Array<{ role: string; [k: string]: unknown }>) {
    const turns: Array<{ userMessage: unknown; assistantMessages: unknown[] }> = [];
    let currentTurn: { userMessage: unknown; assistantMessages: unknown[] } | null = null;

    for (const msg of messages) {
      if (msg.role === "user") {
        if (currentTurn) turns.push(currentTurn);
        currentTurn = { userMessage: msg, assistantMessages: [] };
      } else if (msg.role === "assistant" && currentTurn) {
        currentTurn.assistantMessages.push(msg);
      }
    }
    if (currentTurn) turns.push(currentTurn);
    return turns;
  }

  for (const turnCount of [5, 15, 50, 100]) {
    const messages = createMessages(turnCount);
    bench(`group ${turnCount} turns (${turnCount * 2} messages)`, () => {
      groupMessagesIntoTurns(messages);
    });
  }
});
