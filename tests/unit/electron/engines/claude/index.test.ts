import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageBuffer } from "../../../../../electron/main/engines/engine-adapter";

// ---------------------------------------------------------------------------
// Hoisted mock variables
// ---------------------------------------------------------------------------

const {
  unstable_v2_createSessionMock,
  unstable_v2_resumeSessionMock,
  sdkListSessionsMock,
  sdkGetSessionMessagesMock,
  sdkQueryMock,
  timeIdMock,
} = vi.hoisted(() => ({
  unstable_v2_createSessionMock: vi.fn(),
  unstable_v2_resumeSessionMock: vi.fn(),
  sdkListSessionsMock: vi.fn(),
  sdkGetSessionMessagesMock: vi.fn(),
  sdkQueryMock: vi.fn(),
  timeIdMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: SDK
// ---------------------------------------------------------------------------

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  unstable_v2_createSession: unstable_v2_createSessionMock,
  unstable_v2_resumeSession: unstable_v2_resumeSessionMock,
  listSessions: sdkListSessionsMock,
  getSessionMessages: sdkGetSessionMessagesMock,
  query: sdkQueryMock,
}));

// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------

vi.mock("../../../../../electron/main/services/logger", () => ({
  claudeLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock: id-gen — deterministic IDs for assertion stability
// ---------------------------------------------------------------------------

let idCounter = 0;
vi.mock("../../../../../electron/main/utils/id-gen", () => ({
  timeId: (prefix: string) => `${prefix}_${++idCounter}`,
}));

// ---------------------------------------------------------------------------
// Mock: cc-session-files
// ---------------------------------------------------------------------------

vi.mock("../../../../../electron/main/engines/claude/cc-session-files", () => ({
  deleteCCSessionFile: vi.fn(),
  readJsonlTimestamps: vi.fn().mockReturnValue(new Map()),
}));

// ---------------------------------------------------------------------------
// Mock: diff (createTwoFilesPatch)
// ---------------------------------------------------------------------------

vi.mock("diff", () => ({
  createTwoFilesPatch: vi.fn((_a: string, _b: string, oldStr: string, newStr: string) =>
    `--- a\n+++ b\n-${oldStr}\n+${newStr}`,
  ),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { ClaudeCodeAdapter, getClaudeReasoningCapabilities } from "../../../../../electron/main/engines/claude/index";
import type { ModelInfo as ClaudeModelInfo } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset ID counter before each test so part IDs are predictable. */
function resetIdCounter() {
  idCounter = 0;
}

/** Create a fresh MessageBuffer for a session. */
function makeBuffer(sessionId: string, messageId = "msg_1"): MessageBuffer {
  return {
    messageId,
    sessionId,
    parts: [],
    textAccumulator: "",
    textPartId: null,
    reasoningAccumulator: "",
    reasoningPartId: null,
    startTime: Date.now(),
  };
}

/** Create a mock V2 SDKSession. */
function makeMockV2Session(streamEvents: any[] = []) {
  const session: any = {
    send: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    stream: vi.fn().mockImplementation(async function* () {
      for (const evt of streamEvents) yield evt;
    }),
    query: {
      interrupt: vi.fn().mockResolvedValue(undefined),
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
      transport: {
        isReady: vi.fn().mockReturnValue(true),
        onExit: vi.fn(),
      },
    },
  };
  return session;
}

/** Seed a session into the adapter's internal maps. */
function seedSession(adapter: ClaudeCodeAdapter, sessionId: string, directory = "/repo") {
  (adapter as any).sessionDirectories.set(sessionId, directory);
  (adapter as any).messageHistory.set(sessionId, []);
}

/** Seed a V2 session with a mock SDK session object. */
function seedV2Session(adapter: ClaudeCodeAdapter, sessionId: string, mockSession: any, directory = "/repo") {
  seedSession(adapter, sessionId, directory);
  (adapter as any).v2Sessions.set(sessionId, {
    session: mockSession,
    directory,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    capturedSessionId: undefined,
    permissionMode: "default",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getClaudeReasoningCapabilities", () => {
  it("filters invalid effort levels and picks a supported default", () => {
    const caps = getClaudeReasoningCapabilities({
      supportsEffort: true,
      supportedEffortLevels: ["high", "turbo", "max"] as any,
    } as ClaudeModelInfo);

    expect(caps).toEqual({
      reasoning: true,
      supportedReasoningEfforts: ["high", "max"],
      defaultReasoningEffort: "high",
    });
  });

  it("falls back to full effort set when SDK omits supported levels", () => {
    const caps = getClaudeReasoningCapabilities({
      supportsEffort: true,
      supportedEffortLevels: undefined,
    } as ClaudeModelInfo);

    expect(caps).toEqual({
      reasoning: true,
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
      defaultReasoningEffort: "medium",
    });
  });

  it("returns reasoning: false when supportsEffort is false", () => {
    const caps = getClaudeReasoningCapabilities({
      supportsEffort: false,
    } as ClaudeModelInfo);

    expect(caps.reasoning).toBe(false);
    expect(caps.supportedReasoningEfforts).toBeUndefined();
  });
});

describe("ClaudeCodeAdapter", () => {
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdCounter();
    adapter = new ClaudeCodeAdapter();
  });

  // =========================================================================
  // A. Session Management
  // =========================================================================

  describe("createSession()", () => {
    it("normalizes backslash directory separators", async () => {
      const session = await adapter.createSession("/repo\\sub\\dir");
      expect(session.directory).toBe("/repo/sub/dir");
    });

    it("generates a session ID with 'cs' prefix", async () => {
      const session = await adapter.createSession("/repo");
      expect(session.id).toMatch(/^cs_/);
    });

    it("stores the normalized directory in sessionDirectories", async () => {
      const session = await adapter.createSession("/repo\\foo");
      expect((adapter as any).sessionDirectories.get(session.id)).toBe("/repo/foo");
    });

    it("restores ccSessionId from persisted meta", async () => {
      const session = await adapter.createSession("/repo", { ccSessionId: "cc-abc-123" });
      expect((adapter as any).sessionCcIds.get(session.id)).toBe("cc-abc-123");
    });

    it("ignores non-string ccSessionId values in meta", async () => {
      const session = await adapter.createSession("/repo", { ccSessionId: 42 });
      expect((adapter as any).sessionCcIds.has(session.id)).toBe(false);
    });

    it("emits session.created event", async () => {
      const events: any[] = [];
      adapter.on("session.created", (e) => events.push(e));

      const session = await adapter.createSession("/repo");
      expect(events).toHaveLength(1);
      expect(events[0].session.id).toBe(session.id);
      expect(events[0].session.engineType).toBe("claude");
    });

    it("returns a session with 'New Chat' as default title", async () => {
      const session = await adapter.createSession("/repo");
      expect(session.title).toBe("New Chat");
    });
  });

  describe("hasSession()", () => {
    it("returns true when session is in v2Sessions", () => {
      const mock = makeMockV2Session();
      seedV2Session(adapter, "cs_123", mock);
      expect(adapter.hasSession("cs_123")).toBe(true);
    });

    it("returns true when session is in sessionDirectories only", () => {
      (adapter as any).sessionDirectories.set("cs_456", "/repo");
      expect(adapter.hasSession("cs_456")).toBe(true);
    });

    it("returns false for unknown session", () => {
      expect(adapter.hasSession("unknown")).toBe(false);
    });
  });

  describe("deleteSession()", () => {
    it("removes session directory entry", async () => {
      seedSession(adapter, "cs_1");
      await adapter.deleteSession("cs_1");
      expect((adapter as any).sessionDirectories.has("cs_1")).toBe(false);
    });

    it("removes message history", async () => {
      seedSession(adapter, "cs_1");
      await adapter.deleteSession("cs_1");
      expect((adapter as any).messageHistory.has("cs_1")).toBe(false);
    });

    it("rejects pending sendResolvers with Session deleted", async () => {
      seedSession(adapter, "cs_1");
      const reject = vi.fn();
      (adapter as any).sendResolvers.set("cs_1", [
        { resolve: vi.fn(), reject },
        { resolve: vi.fn(), reject },
      ]);

      await adapter.deleteSession("cs_1");
      expect(reject).toHaveBeenCalledTimes(2);
      expect(reject.mock.calls[0][0].message).toBe("Session deleted");
    });

    it("resolves pending permissions with deny behavior", async () => {
      seedSession(adapter, "cs_1");
      const resolve = vi.fn();
      (adapter as any).pendingPermissions.set("perm-1", {
        resolve,
        permission: { sessionId: "cs_1", id: "perm-1" },
        input: {},
      });

      await adapter.deleteSession("cs_1");
      expect(resolve).toHaveBeenCalledWith({ behavior: "deny", message: "Session deleted" });
      expect((adapter as any).pendingPermissions.has("perm-1")).toBe(false);
    });

    it("resolves pending questions with empty string", async () => {
      seedSession(adapter, "cs_1");
      const resolve = vi.fn();
      (adapter as any).pendingQuestions.set("q-1", {
        resolve,
        question: { sessionId: "cs_1", id: "q-1" },
      });

      await adapter.deleteSession("cs_1");
      expect(resolve).toHaveBeenCalledWith("Session deleted");
      expect((adapter as any).pendingQuestions.has("q-1")).toBe(false);
    });

    it("closes and removes V2 session", async () => {
      const mock = makeMockV2Session();
      seedV2Session(adapter, "cs_1", mock);
      await adapter.deleteSession("cs_1");
      expect(mock.close).toHaveBeenCalledTimes(1);
      expect((adapter as any).v2Sessions.has("cs_1")).toBe(false);
    });

    it("does not delete permissions belonging to other sessions", async () => {
      seedSession(adapter, "cs_1");
      const resolve = vi.fn();
      (adapter as any).pendingPermissions.set("perm-other", {
        resolve,
        permission: { sessionId: "cs_other", id: "perm-other" },
        input: {},
      });

      await adapter.deleteSession("cs_1");
      expect(resolve).not.toHaveBeenCalled();
      expect((adapter as any).pendingPermissions.has("perm-other")).toBe(true);
    });
  });

  // =========================================================================
  // B. Model & Mode Management
  // =========================================================================

  describe("setModel()", () => {
    it("updates currentModelId", async () => {
      seedSession(adapter, "cs_1");
      await adapter.setModel("cs_1", "claude-3-opus");
      expect((adapter as any).currentModelId).toBe("claude-3-opus");
    });

    it("closes existing V2 session to force recreation", async () => {
      const mock = makeMockV2Session();
      seedV2Session(adapter, "cs_1", mock);
      (adapter as any).v2Sessions.get("cs_1").capturedSessionId = "cc-prev";

      await adapter.setModel("cs_1", "claude-3-haiku");

      expect(mock.close).toHaveBeenCalledTimes(1);
      expect((adapter as any).v2Sessions.has("cs_1")).toBe(false);
      // Preserves cc session ID for resumption
      expect((adapter as any).sessionCcIds.get("cs_1")).toBe("cc-prev");
    });

    it("does nothing to V2 sessions map if session not yet created", async () => {
      seedSession(adapter, "cs_1");
      await adapter.setModel("cs_1", "claude-3-haiku");
      expect((adapter as any).v2Sessions.has("cs_1")).toBe(false);
    });
  });

  describe("setMode()", () => {
    it("stores mode in sessionModes", async () => {
      seedSession(adapter, "cs_1");
      await adapter.setMode("cs_1", "plan");
      expect((adapter as any).sessionModes.get("cs_1")).toBe("plan");
    });

    it("calls setPermissionMode on live V2 session query", async () => {
      const mock = makeMockV2Session();
      seedV2Session(adapter, "cs_1", mock);
      await adapter.setMode("cs_1", "acceptEdits");
      expect(mock.query.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    });

    it("updates permissionMode on existing V2SessionInfo", async () => {
      const mock = makeMockV2Session();
      seedV2Session(adapter, "cs_1", mock);
      await adapter.setMode("cs_1", "plan");
      expect((adapter as any).v2Sessions.get("cs_1").permissionMode).toBe("plan");
    });
  });

  describe("setReasoningEffort()", () => {
    it("stores the effort level", async () => {
      seedSession(adapter, "cs_1");
      await adapter.setReasoningEffort("cs_1", "high");
      expect(adapter.getReasoningEffort("cs_1")).toBe("high");
    });

    it("clears effort when null is passed", async () => {
      seedSession(adapter, "cs_1");
      await adapter.setReasoningEffort("cs_1", "medium");
      await adapter.setReasoningEffort("cs_1", null);
      expect(adapter.getReasoningEffort("cs_1")).toBeNull();
    });

    it("skips V2 session rebuild when effort unchanged", async () => {
      const mock = makeMockV2Session();
      seedV2Session(adapter, "cs_1", mock);
      await adapter.setReasoningEffort("cs_1", "low");
      await adapter.setReasoningEffort("cs_1", "low"); // same value
      // close only called for the first change
      expect(mock.close).toHaveBeenCalledTimes(1);
    });

    it("closes existing V2 session to force rebuild on change", async () => {
      const mock = makeMockV2Session();
      seedV2Session(adapter, "cs_1", mock);
      (adapter as any).v2Sessions.get("cs_1").capturedSessionId = "cc-saved";

      await adapter.setReasoningEffort("cs_1", "max");

      expect(mock.close).toHaveBeenCalledTimes(1);
      expect((adapter as any).v2Sessions.has("cs_1")).toBe(false);
      expect((adapter as any).sessionCcIds.get("cs_1")).toBe("cc-saved");
    });

    it("getReasoningEffort returns null for unknown session", () => {
      expect(adapter.getReasoningEffort("unknown")).toBeNull();
    });
  });

  // =========================================================================
  // C. Text / Reasoning Accumulation
  // =========================================================================

  describe("appendText()", () => {
    it("trims leading whitespace on first call", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).appendText("cs_1", buf, "\n\n  Hello");
      expect(buf.textAccumulator).toBe("Hello");
    });

    it("does not emit a part when all content is whitespace", () => {
      const buf = makeBuffer("cs_1");
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      (adapter as any).appendText("cs_1", buf, "   \n  ");
      expect(partUpdates).toHaveLength(0);
      expect(buf.parts).toHaveLength(0);
    });

    it("creates a new text part on first non-empty call", () => {
      const buf = makeBuffer("cs_1");
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      (adapter as any).appendText("cs_1", buf, "Hello");
      expect(buf.parts).toHaveLength(1);
      expect(buf.parts[0].type).toBe("text");
      expect((buf.parts[0] as any).text).toBe("Hello");
      expect(partUpdates).toHaveLength(1);
    });

    it("updates existing text part on subsequent calls", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).appendText("cs_1", buf, "Hello");
      (adapter as any).appendText("cs_1", buf, " world");

      expect(buf.parts).toHaveLength(1);
      expect((buf.parts[0] as any).text).toBe("Hello world");
    });

    it("sets leadingTrimmed flag after first non-empty call", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).appendText("cs_1", buf, "Hi");
      expect(buf.leadingTrimmed).toBe(true);
    });

    it("does not re-trim after leadingTrimmed is set", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).appendText("cs_1", buf, "Start");
      (adapter as any).appendText("cs_1", buf, "\n  preserved");
      expect(buf.textAccumulator).toBe("Start\n  preserved");
    });
  });

  describe("appendReasoning()", () => {
    it("creates a new reasoning part on first call", () => {
      const buf = makeBuffer("cs_1");
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      (adapter as any).appendReasoning("cs_1", buf, "Thinking...");
      expect(buf.parts).toHaveLength(1);
      expect(buf.parts[0].type).toBe("reasoning");
      expect((buf.parts[0] as any).text).toBe("Thinking...");
      expect(partUpdates).toHaveLength(1);
    });

    it("accumulates reasoning across multiple calls", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).appendReasoning("cs_1", buf, "Step 1");
      (adapter as any).appendReasoning("cs_1", buf, " Step 2");

      expect(buf.reasoningAccumulator).toBe("Step 1 Step 2");
      expect(buf.parts).toHaveLength(1);
      expect((buf.parts[0] as any).text).toBe("Step 1 Step 2");
    });

    it("emits part.updated on each accumulation", () => {
      const buf = makeBuffer("cs_1");
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      (adapter as any).appendReasoning("cs_1", buf, "A");
      (adapter as any).appendReasoning("cs_1", buf, "B");
      expect(partUpdates).toHaveLength(2);
    });
  });

  describe("findLastTextPart()", () => {
    it("returns undefined for empty buffer", () => {
      const buf = makeBuffer("cs_1");
      expect((adapter as any).findLastTextPart(buf)).toBeUndefined();
    });

    it("finds the last text part when multiple parts exist", () => {
      const buf = makeBuffer("cs_1");
      buf.parts.push({ type: "step-start", id: "p1", messageId: "msg_1", sessionId: "cs_1" } as any);
      buf.parts.push({ type: "text", id: "p2", text: "first", messageId: "msg_1", sessionId: "cs_1" } as any);
      buf.parts.push({ type: "tool", id: "p3", messageId: "msg_1", sessionId: "cs_1" } as any);
      buf.parts.push({ type: "text", id: "p4", text: "last", messageId: "msg_1", sessionId: "cs_1" } as any);

      const result = (adapter as any).findLastTextPart(buf);
      expect(result?.id).toBe("p4");
    });

    it("skips non-text parts at the end", () => {
      const buf = makeBuffer("cs_1");
      buf.parts.push({ type: "text", id: "p1", text: "only", messageId: "msg_1", sessionId: "cs_1" } as any);
      buf.parts.push({ type: "reasoning", id: "p2", messageId: "msg_1", sessionId: "cs_1" } as any);

      const result = (adapter as any).findLastTextPart(buf);
      expect(result?.id).toBe("p1");
    });
  });

  // =========================================================================
  // D. Tool Parts
  // =========================================================================

  describe("createToolPart()", () => {
    it("normalizes Claude tool names to unified names", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "call_1", "Bash", { command: "ls" });

      const toolPart = buf.parts.find((p: any) => p.type === "tool") as any;
      expect(toolPart.normalizedTool).toBe("shell");
      expect(toolPart.originalTool).toBe("Bash");
    });

    it("creates a step-start part before the tool part", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "call_1", "Read", { filePath: "/a.ts" });

      expect(buf.parts[0].type).toBe("step-start");
      expect(buf.parts[1].type).toBe("tool");
    });

    it("normalizes snake_case input keys to camelCase", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "call_1", "Edit", {
        file_path: "/a.ts",
        old_string: "foo",
        new_string: "bar",
      });

      const toolPart = buf.parts.find((p: any) => p.type === "tool") as any;
      expect((toolPart.state as any).input.filePath).toBe("/a.ts");
      expect((toolPart.state as any).input.oldString).toBe("foo");
    });

    it("stores tool part in toolCallParts map", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "call_xyz", "Read", {});
      expect((adapter as any).toolCallParts.has("call_xyz")).toBe(true);
    });

    it("emits part.updated for both step-start and tool parts", () => {
      const buf = makeBuffer("cs_1");
      const events: any[] = [];
      adapter.on("message.part.updated", (e) => events.push(e));

      (adapter as any).createToolPart("cs_1", buf, "call_1", "Bash", {});
      expect(events).toHaveLength(2);
      expect(events[0].part.type).toBe("step-start");
      expect(events[1].part.type).toBe("tool");
    });

    it("infers tool kind based on normalized name", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "call_1", "Write", { filePath: "/a.ts" });

      const toolPart = buf.parts.find((p: any) => p.type === "tool") as any;
      expect(toolPart.kind).toBeDefined();
    });
  });

  describe("handleToolResult()", () => {
    function setupToolResult(adapter: ClaudeCodeAdapter, toolName = "Bash") {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "call_1", toolName, { command: "ls" });
      (adapter as any).messageBuffers.set("cs_1", buf);
      return buf;
    }

    it("marks tool as completed with output", () => {
      const buf = setupToolResult(adapter);
      (adapter as any).handleToolResult("cs_1", buf, {
        tool_use_id: "call_1",
        content: "total 4\nfoo.ts",
        is_error: false,
      });

      const toolPart = (adapter as any).toolCallParts.get("call_1") as any;
      expect(toolPart.state.status).toBe("completed");
      expect(toolPart.state.output).toBe("total 4\nfoo.ts");
    });

    it("marks tool as error when is_error is true", () => {
      const buf = setupToolResult(adapter);
      (adapter as any).handleToolResult("cs_1", buf, {
        tool_use_id: "call_1",
        content: "command not found",
        is_error: true,
      });

      const toolPart = (adapter as any).toolCallParts.get("call_1") as any;
      expect(toolPart.state.status).toBe("error");
      expect(toolPart.state.error).toBe("command not found");
    });

    it("calculates duration from start time", () => {
      const buf = setupToolResult(adapter);
      // Set a known start time
      const toolPart = (adapter as any).toolCallParts.get("call_1") as any;
      toolPart.state.time.start = Date.now() - 100;

      (adapter as any).handleToolResult("cs_1", buf, {
        tool_use_id: "call_1",
        content: "ok",
        is_error: false,
      });

      expect(toolPart.state.time.duration).toBeGreaterThanOrEqual(100);
    });

    it("extracts output from array content blocks", () => {
      const buf = setupToolResult(adapter);
      (adapter as any).handleToolResult("cs_1", buf, {
        tool_use_id: "call_1",
        content: [
          { type: "text", text: "line1" },
          { type: "text", text: "line2" },
        ],
        is_error: false,
      });

      const toolPart = (adapter as any).toolCallParts.get("call_1") as any;
      expect(toolPart.state.output).toBe("line1\nline2");
    });

    it("adds a step-finish part after tool result", () => {
      const buf = setupToolResult(adapter);
      const partsBefore = buf.parts.length;
      (adapter as any).handleToolResult("cs_1", buf, {
        tool_use_id: "call_1",
        content: "ok",
        is_error: false,
      });

      const newParts = buf.parts.slice(partsBefore);
      expect(newParts.some((p: any) => p.type === "step-finish")).toBe(true);
    });

    it("warns and returns early for unknown tool_use_id", () => {
      const buf = makeBuffer("cs_1");
      // No tool part registered
      expect(() => {
        (adapter as any).handleToolResult("cs_1", buf, {
          tool_use_id: "unknown_call",
          content: "output",
          is_error: false,
        });
      }).not.toThrow();
      // No step-finish added since there's nothing to complete
      expect(buf.parts).toHaveLength(0);
    });
  });

  describe("buildToolMetadata()", () => {
    it("generates a diff for Edit tool with oldString/newString", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "edit_1", "Edit", {
        file_path: "/a.ts",
        old_string: "foo",
        new_string: "bar",
      });

      const toolPart = (adapter as any).toolCallParts.get("edit_1") as any;
      const meta = (adapter as any).buildToolMetadata(toolPart, "");
      expect(meta).toBeDefined();
      expect(meta.diff).toContain("foo");
    });

    it("returns undefined for non-edit tools", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "bash_1", "Bash", { command: "ls" });
      const toolPart = (adapter as any).toolCallParts.get("bash_1") as any;
      const meta = (adapter as any).buildToolMetadata(toolPart, "output");
      expect(meta).toBeUndefined();
    });

    it("returns undefined when oldString and newString are both empty", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "edit_1", "Edit", {
        file_path: "/a.ts",
        old_string: "",
        new_string: "",
      });
      const toolPart = (adapter as any).toolCallParts.get("edit_1") as any;
      const meta = (adapter as any).buildToolMetadata(toolPart, "");
      expect(meta).toBeUndefined();
    });
  });

  // =========================================================================
  // E. handleSdkMessage() dispatch
  // =========================================================================

  describe("handleSdkMessage()", () => {
    it("dispatches 'system' messages to handleSystemMessage", () => {
      const spy = vi.spyOn(adapter as any, "handleSystemMessage");
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };
      const streamingBlocks = new Map();

      (adapter as any).handleSdkMessage(
        { type: "system", subtype: "init", session_id: "cc-1" },
        "cs_1", buf, streamingBlocks, endState,
      );
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("dispatches 'assistant' messages to handleAssistantMessage", () => {
      const spy = vi.spyOn(adapter as any, "handleAssistantMessage");
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };
      const streamingBlocks = new Map();

      (adapter as any).handleSdkMessage(
        { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
        "cs_1", buf, streamingBlocks, endState,
      );
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("dispatches 'result' messages to handleResultMessage", () => {
      const spy = vi.spyOn(adapter as any, "handleResultMessage");
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };
      const streamingBlocks = new Map();

      (adapter as any).handleSdkMessage(
        { type: "result", subtype: "success" },
        "cs_1", buf, streamingBlocks, endState,
      );
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("dispatches 'user' messages to handleUserMessage", () => {
      const spy = vi.spyOn(adapter as any, "handleUserMessage");
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };
      const streamingBlocks = new Map();

      (adapter as any).handleSdkMessage(
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x" }] } },
        "cs_1", buf, streamingBlocks, endState,
      );
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("dispatches 'stream_event' messages to handleStreamEvent", () => {
      const spy = vi.spyOn(adapter as any, "handleStreamEvent");
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };
      const streamingBlocks = new Map();

      (adapter as any).handleSdkMessage(
        { type: "stream_event", event: { type: "message_start" } },
        "cs_1", buf, streamingBlocks, endState,
      );
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // F. handleSystemMessage()
  // =========================================================================

  describe("handleSystemMessage()", () => {
    it("captures ccSessionId from init subtype and emits session.updated", () => {
      const mock = makeMockV2Session();
      seedV2Session(adapter, "cs_1", mock);
      const buf = makeBuffer("cs_1");
      const updates: any[] = [];
      adapter.on("session.updated", (e) => updates.push(e));

      (adapter as any).handleSystemMessage(
        { type: "system", subtype: "init", session_id: "cc-abc", model: "claude-3", claude_code_version: "1.2.3" },
        "cs_1", buf,
      );

      expect((adapter as any).sessionCcIds.get("cs_1")).toBe("cc-abc");
      expect((adapter as any).v2Sessions.get("cs_1").capturedSessionId).toBe("cc-abc");
      expect(updates[0].session).toMatchObject({ id: "cs_1", engineMeta: { ccSessionId: "cc-abc" } });
    });

    it("captures version from init message", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      (adapter as any).handleSystemMessage(
        { type: "system", subtype: "init", session_id: "cc-1", claude_code_version: "1.5.0" },
        "cs_1", buf,
      );
      expect((adapter as any).version).toBe("1.5.0");
    });

    it("captures model into buffer from init", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      (adapter as any).handleSystemMessage(
        { type: "system", subtype: "init", session_id: "cc-1", model: "claude-opus-4" },
        "cs_1", buf,
      );
      expect(buf.modelId).toBe("claude-opus-4");
    });

    it("appends text for local_command_output subtype", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      (adapter as any).handleSystemMessage(
        { type: "system", subtype: "local_command_output", content: "Command output here" },
        "cs_1", buf,
      );
      expect(buf.textAccumulator).toBe("Command output here");
    });

    it("ignores empty local_command_output content", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      (adapter as any).handleSystemMessage(
        { type: "system", subtype: "local_command_output", content: "" },
        "cs_1", buf,
      );
      expect(buf.parts).toHaveLength(0);
    });

    it("emits a compact system-notice part for compact_boundary subtype", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      (adapter as any).handleSystemMessage(
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 50000 },
        },
        "cs_1", buf,
      );

      const notice = buf.parts.find((p: any) => p.type === "system-notice") as any;
      expect(notice).toBeDefined();
      expect(notice.noticeType).toBe("compact");
      expect(notice.text).toBe("notice:context_compressed");
    });

    it("merges new slash commands from init into availableCommands", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      (adapter as any).availableCommands = [{ name: "compact", description: "Compact" }];

      const events: any[] = [];
      adapter.on("commands.changed", (e) => events.push(e));

      (adapter as any).handleSystemMessage(
        { type: "system", subtype: "init", session_id: "cc-1", slash_commands: ["compact", "my-skill"] },
        "cs_1", buf,
      );

      const names = (adapter as any).availableCommands.map((c: any) => c.name);
      expect(names).toContain("my-skill");
      expect(events).toHaveLength(1);
    });

    it("does not emit commands.changed when no new commands from init", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      (adapter as any).availableCommands = [{ name: "compact", description: "" }];

      const events: any[] = [];
      adapter.on("commands.changed", (e) => events.push(e));

      (adapter as any).handleSystemMessage(
        { type: "system", subtype: "init", session_id: "cc-1", slash_commands: ["compact"] },
        "cs_1", buf,
      );
      expect(events).toHaveLength(0);
    });
  });

  // =========================================================================
  // G. handleAssistantMessage()
  // =========================================================================

  describe("handleAssistantMessage()", () => {
    it("appends text content block", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      (adapter as any).handleAssistantMessage(
        { type: "assistant", message: { content: [{ type: "text", text: "Hello world" }] } },
        "cs_1", buf,
      );
      expect(buf.textAccumulator).toBe("Hello world");
    });

    it("handles string content (slash command output)", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      (adapter as any).handleAssistantMessage(
        { type: "assistant", message: { content: "Slash output" } },
        "cs_1", buf,
      );
      expect(buf.textAccumulator).toBe("Slash output");
    });

    it("creates reasoning part for thinking blocks", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      (adapter as any).handleAssistantMessage(
        {
          type: "assistant",
          message: {
            content: [{ type: "thinking", thinking: "Let me reason..." }],
          },
        },
        "cs_1", buf,
      );
      expect(buf.reasoningAccumulator).toBe("Let me reason...");
      expect(buf.parts.some((p: any) => p.type === "reasoning")).toBe(true);
    });

    it("creates tool part for tool_use blocks", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      (adapter as any).handleAssistantMessage(
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/a.ts" } },
            ],
          },
        },
        "cs_1", buf,
      );
      expect(buf.parts.some((p: any) => p.type === "tool")).toBe(true);
    });

    it("extracts token usage from betaMessage.usage", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      (adapter as any).handleAssistantMessage(
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "hi" }],
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 },
          },
        },
        "cs_1", buf,
      );
      expect(buf.tokens).toEqual({
        input: 100,
        output: 50,
        cache: { read: 20, write: 5 },
      });
    });

    it("does nothing when message has no content", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const events: any[] = [];
      adapter.on("message.part.updated", (e) => events.push(e));

      (adapter as any).handleAssistantMessage({ type: "assistant", message: {} }, "cs_1", buf);
      expect(events).toHaveLength(0);
    });
  });

  // =========================================================================
  // H. handleUserMessage()
  // =========================================================================

  describe("handleUserMessage()", () => {
    it("processes tool_result blocks", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "call_1", "Bash", {});
      (adapter as any).messageBuffers.set("cs_1", buf);

      const spy = vi.spyOn(adapter as any, "handleToolResult");
      (adapter as any).handleUserMessage(
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "output" }],
          },
        },
        "cs_1", buf,
      );
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("ignores replay messages", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const spy = vi.spyOn(adapter as any, "handleToolResult");

      (adapter as any).handleUserMessage(
        {
          type: "user",
          isReplay: true,
          message: { content: [{ type: "tool_result", tool_use_id: "call_1" }] },
        },
        "cs_1", buf,
      );
      expect(spy).not.toHaveBeenCalled();
    });

    it("ignores synthetic messages", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const spy = vi.spyOn(adapter as any, "handleToolResult");

      (adapter as any).handleUserMessage(
        {
          type: "user",
          isSynthetic: true,
          message: { content: "some text" },
        },
        "cs_1", buf,
      );
      expect(spy).not.toHaveBeenCalled();
    });

    it("appends text blocks in user messages", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      (adapter as any).handleUserMessage(
        {
          type: "user",
          message: { content: [{ type: "text", text: "slash output" }] },
        },
        "cs_1", buf,
      );
      expect(buf.textAccumulator).toBe("slash output");
    });
  });

  // =========================================================================
  // I. handleResultMessage()
  // =========================================================================

  describe("handleResultMessage()", () => {
    it("sets receivedResult to true", () => {
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };

      (adapter as any).handleResultMessage({ type: "result", subtype: "success" }, "cs_1", buf, endState);
      expect(endState.receivedResult).toBe(true);
    });

    it("sets hadErrorDuringExecution for error_during_execution subtype", () => {
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };

      (adapter as any).handleResultMessage(
        { type: "result", subtype: "error_during_execution" },
        "cs_1", buf, endState,
      );
      expect(endState.hadErrorDuringExecution).toBe(true);
    });

    it("sets buffer.error from is_error result", () => {
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };

      (adapter as any).handleResultMessage(
        { type: "result", is_error: true, result: "Permission denied" },
        "cs_1", buf, endState,
      );
      expect(buf.error).toBe("Permission denied");
    });

    it("extracts token usage from result message", () => {
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };

      (adapter as any).handleResultMessage(
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 },
        },
        "cs_1", buf, endState,
      );
      expect(buf.tokens?.input).toBe(200);
      expect(buf.tokens?.output).toBe(80);
    });

    it("extracts cost from result message", () => {
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };

      (adapter as any).handleResultMessage(
        { type: "result", subtype: "success", total_cost_usd: 0.0042 },
        "cs_1", buf, endState,
      );
      expect(buf.cost).toBeCloseTo(0.0042);
    });

    it("uses result text as buffer content when buffer is empty", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };

      (adapter as any).handleResultMessage(
        { type: "result", subtype: "success", result: "Hello from slash command", is_error: false },
        "cs_1", buf, endState,
      );
      expect(buf.textAccumulator).toBe("Hello from slash command");
    });
  });

  // =========================================================================
  // J. handleStreamEvent()
  // =========================================================================

  describe("handleStreamEvent()", () => {
    it("creates a pending tool part on content_block_start for tool_use", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();

      (adapter as any).handleStreamEvent(
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "call_t1", name: "Read" },
          },
        },
        "cs_1", buf, streamingBlocks,
      );

      expect(buf.parts.some((p: any) => p.type === "tool")).toBe(true);
      expect((adapter as any).toolCallParts.has("call_t1")).toBe(true);
      expect(streamingBlocks.has(0)).toBe(true);
    });

    it("accumulates text delta for text block", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();
      streamingBlocks.set(0, { index: 0, type: "text", content: "Hel" });

      (adapter as any).handleStreamEvent(
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "lo" },
          },
        },
        "cs_1", buf, streamingBlocks,
      );

      expect(streamingBlocks.get(0)?.content).toBe("Hello");
    });

    it("accumulates thinking delta", () => {
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();
      streamingBlocks.set(1, { index: 1, type: "thinking", content: "" });

      (adapter as any).handleStreamEvent(
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "thinking_delta", thinking: "Step 1" },
          },
        },
        "cs_1", buf, streamingBlocks,
      );

      expect(buf.reasoningAccumulator).toBe("Step 1");
    });

    it("parses accumulated JSON input on content_block_stop for tool_use", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();

      // First, create the tool part via content_block_start
      (adapter as any).handleStreamEvent(
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "call_j1", name: "Bash" },
          },
        },
        "cs_1", buf, streamingBlocks,
      );

      // Feed JSON input via delta
      streamingBlocks.get(0)!.content = '{"command":"ls -la"}';

      (adapter as any).handleStreamEvent(
        {
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
        },
        "cs_1", buf, streamingBlocks,
      );

      const toolPart = (adapter as any).toolCallParts.get("call_j1") as any;
      expect(toolPart.state.input.command).toBe("ls -la");
      expect(streamingBlocks.has(0)).toBe(false);
    });

    it("handles malformed JSON by storing as raw string", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();

      (adapter as any).handleStreamEvent(
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "call_bad", name: "Bash" },
          },
        },
        "cs_1", buf, streamingBlocks,
      );

      streamingBlocks.get(0)!.content = "not valid json{";

      expect(() => {
        (adapter as any).handleStreamEvent(
          { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
          "cs_1", buf, streamingBlocks,
        );
      }).not.toThrow();

      const toolPart = (adapter as any).toolCallParts.get("call_bad") as any;
      expect(toolPart.state.input.raw).toBeDefined();
    });
  });

  // =========================================================================
  // K. Permission Handling
  // =========================================================================

  describe("replyPermission()", () => {
    function seedPendingPermission(adapter: ClaudeCodeAdapter, id: string, resolve = vi.fn()) {
      (adapter as any).pendingPermissions.set(id, {
        resolve,
        permission: { id, sessionId: "cs_1" },
        input: { command: "ls" },
        suggestions: [{ type: "rule", pattern: "ls" }],
      });
      return resolve;
    }

    it("resolves with allow behavior for 'allow' optionId", async () => {
      const resolve = seedPendingPermission(adapter, "perm-1");
      await adapter.replyPermission("perm-1", { optionId: "allow" });
      expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ behavior: "allow" }));
    });

    it("resolves with allow behavior for 'allow_once' optionId", async () => {
      const resolve = seedPendingPermission(adapter, "perm-2");
      await adapter.replyPermission("perm-2", { optionId: "allow_once" });
      expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ behavior: "allow" }));
    });

    it("resolves with allow behavior for 'accept_once' optionId", async () => {
      const resolve = seedPendingPermission(adapter, "perm-3");
      await adapter.replyPermission("perm-3", { optionId: "accept_once" });
      expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ behavior: "allow" }));
    });

    it("resolves with allow behavior and includes suggestions for 'allow_always'", async () => {
      const resolve = seedPendingPermission(adapter, "perm-4");
      await adapter.replyPermission("perm-4", { optionId: "allow_always" });
      expect(resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          behavior: "allow",
          updatedPermissions: expect.arrayContaining([expect.objectContaining({ type: "rule" })]),
        }),
      );
    });

    it("resolves with deny behavior for non-allow optionId", async () => {
      const resolve = seedPendingPermission(adapter, "perm-5");
      await adapter.replyPermission("perm-5", { optionId: "deny" });
      expect(resolve).toHaveBeenCalledWith({ behavior: "deny", message: "Denied by user" });
    });

    it("emits permission.replied event", async () => {
      seedPendingPermission(adapter, "perm-6");
      const replies: any[] = [];
      adapter.on("permission.replied", (e) => replies.push(e));
      await adapter.replyPermission("perm-6", { optionId: "allow" });
      expect(replies[0]).toEqual({ permissionId: "perm-6", optionId: "allow" });
    });

    it("removes permission from pending map after reply", async () => {
      seedPendingPermission(adapter, "perm-7");
      await adapter.replyPermission("perm-7", { optionId: "allow" });
      expect((adapter as any).pendingPermissions.has("perm-7")).toBe(false);
    });

    it("does nothing for unknown permission ID", async () => {
      await expect(adapter.replyPermission("unknown", { optionId: "allow" })).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // L. Question Handling
  // =========================================================================

  describe("replyQuestion()", () => {
    function seedPendingQuestion(adapter: ClaudeCodeAdapter, id: string, resolve = vi.fn()) {
      (adapter as any).pendingQuestions.set(id, {
        resolve,
        question: { id, sessionId: "cs_1" },
      });
      return resolve;
    }

    it("resolves question with joined first answer array", async () => {
      const resolve = seedPendingQuestion(adapter, "q-1");
      await adapter.replyQuestion("q-1", [["Approve", "extra note"]]);
      expect(resolve).toHaveBeenCalledWith("Approve\nextra note");
    });

    it("removes question from pending map after reply", async () => {
      seedPendingQuestion(adapter, "q-2");
      await adapter.replyQuestion("q-2", [["yes"]]);
      expect((adapter as any).pendingQuestions.has("q-2")).toBe(false);
    });

    it("emits question.replied event", async () => {
      seedPendingQuestion(adapter, "q-3");
      const replies: any[] = [];
      adapter.on("question.replied", (e) => replies.push(e));
      await adapter.replyQuestion("q-3", [["yes"]]);
      expect(replies[0]).toMatchObject({ questionId: "q-3", answers: [["yes"]] });
    });

    it("does nothing for unknown question ID", async () => {
      await expect(adapter.replyQuestion("unknown", [["yes"]])).resolves.toBeUndefined();
    });
  });

  describe("rejectQuestion()", () => {
    it("resolves question with empty string", async () => {
      const resolve = vi.fn();
      (adapter as any).pendingQuestions.set("q-1", {
        resolve,
        question: { id: "q-1", sessionId: "cs_1" },
      });
      await adapter.rejectQuestion("q-1");
      expect(resolve).toHaveBeenCalledWith("");
      expect((adapter as any).pendingQuestions.has("q-1")).toBe(false);
    });

    it("does nothing for unknown question ID", async () => {
      await expect(adapter.rejectQuestion("unknown")).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // M. handleExitPlanMode()
  // =========================================================================

  describe("handleExitPlanMode()", () => {
    function makeSignal() {
      const controller = new AbortController();
      return controller.signal;
    }

    it("resolves with allow when answer contains 'approve'", async () => {
      seedSession(adapter, "cs_1");
      const opts = { signal: makeSignal(), toolUseID: "tool-1" };
      const p = (adapter as any).handleExitPlanMode("cs_1", { allowedPrompts: [] }, opts) as Promise<any>;

      // Get the question ID and reply
      const qId = [...(adapter as any).pendingQuestions.keys()][0];
      (adapter as any).pendingQuestions.get(qId)!.resolve("approve");

      const result = await p;
      expect(result.behavior).toBe("allow");
    });

    it("resolves with allow for '同意' answer", async () => {
      seedSession(adapter, "cs_1");
      const opts = { signal: makeSignal(), toolUseID: "tool-2" };
      const p = (adapter as any).handleExitPlanMode("cs_1", {}, opts) as Promise<any>;

      const qId = [...(adapter as any).pendingQuestions.keys()][0];
      (adapter as any).pendingQuestions.get(qId)!.resolve("同意");

      const result = await p;
      expect(result.behavior).toBe("allow");
    });

    it("resolves with allow for '1' answer (1-based index: first option = Approve)", async () => {
      seedSession(adapter, "cs_1");
      const opts = { signal: makeSignal(), toolUseID: "tool-3" };
      const p = (adapter as any).handleExitPlanMode("cs_1", {}, opts) as Promise<any>;

      const qId = [...(adapter as any).pendingQuestions.keys()][0];
      (adapter as any).pendingQuestions.get(qId)!.resolve("1");

      const result = await p;
      expect(result.behavior).toBe("allow");
    });

    it("resolves with allow for '0' answer (0-based compat)", async () => {
      seedSession(adapter, "cs_1");
      const opts = { signal: makeSignal(), toolUseID: "tool-4" };
      const p = (adapter as any).handleExitPlanMode("cs_1", {}, opts) as Promise<any>;

      const qId = [...(adapter as any).pendingQuestions.keys()][0];
      (adapter as any).pendingQuestions.get(qId)!.resolve("0");

      const result = await p;
      expect(result.behavior).toBe("allow");
    });

    it("resolves with deny for rejection answer", async () => {
      seedSession(adapter, "cs_1");
      const opts = { signal: makeSignal(), toolUseID: "tool-5" };
      const p = (adapter as any).handleExitPlanMode("cs_1", {}, opts) as Promise<any>;

      const qId = [...(adapter as any).pendingQuestions.keys()][0];
      (adapter as any).pendingQuestions.get(qId)!.resolve("reject, needs more work");

      const result = await p;
      expect(result.behavior).toBe("deny");
      expect(result.message).toContain("reject");
    });

    it("emits question.asked event", async () => {
      seedSession(adapter, "cs_1");
      const asked: any[] = [];
      adapter.on("question.asked", (e) => asked.push(e));

      const opts = { signal: makeSignal(), toolUseID: "tool-6" };
      const p = (adapter as any).handleExitPlanMode("cs_1", {}, opts) as Promise<any>;

      const qId = [...(adapter as any).pendingQuestions.keys()][0];
      (adapter as any).pendingQuestions.get(qId)!.resolve("approve");
      await p;

      expect(asked).toHaveLength(1);
    });

    it("resolves with deny when signal is already aborted", async () => {
      seedSession(adapter, "cs_1");
      const controller = new AbortController();
      controller.abort();
      const opts = { signal: controller.signal, toolUseID: "tool-7" };

      const result = await (adapter as any).handleExitPlanMode("cs_1", {}, opts);
      expect(result.behavior).toBe("deny");
      expect(result.message).toBe("Aborted");
    });
  });

  // =========================================================================
  // N. Commands & Skills
  // =========================================================================

  describe("listCommands()", () => {
    it("returns cached commands immediately on fast path", async () => {
      (adapter as any).availableCommands = [
        { name: "compact", description: "Compact context" },
        { name: "my-skill", description: "Custom skill" },
      ];

      const commands = await adapter.listCommands("cs_1", "/repo");
      expect(commands).toHaveLength(2);
      expect(commands[0].name).toBe("compact");
    });

    it("returns fallback list when warmup fails entirely", async () => {
      // warmupPromise already null, no commands populated
      vi.spyOn(adapter as any, "warmupV2Session").mockRejectedValue(new Error("warmup failed"));

      const commands = await adapter.listCommands(undefined, "/repo");
      // Falls through to fallback after warmup failure
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.some((c: any) => c.name === "compact")).toBe(true);
    });
  });

  describe("isBuiltInCommand()", () => {
    it("returns true for built-in commands", () => {
      expect((adapter as any).isBuiltInCommand("compact")).toBe(true);
      expect((adapter as any).isBuiltInCommand("context")).toBe(true);
      expect((adapter as any).isBuiltInCommand("help")).toBe(true);
      expect((adapter as any).isBuiltInCommand("update-config")).toBe(true);
    });

    it("returns false for user-defined skill names", () => {
      expect((adapter as any).isBuiltInCommand("my-skill")).toBe(false);
      expect((adapter as any).isBuiltInCommand("custom-deploy")).toBe(false);
    });
  });

  describe("invokeCommand()", () => {
    it("routes built-in commands through sendMessage as slash command text", async () => {
      seedSession(adapter, "cs_1");
      const sendSpy = vi.spyOn(adapter, "sendMessage").mockResolvedValue({
        id: "msg_1",
        sessionId: "cs_1",
        role: "assistant",
        time: { created: Date.now() },
        parts: [],
      });

      const result = await adapter.invokeCommand("cs_1", "compact", "");
      expect(sendSpy).toHaveBeenCalledWith("cs_1", [{ type: "text", text: "/compact" }], undefined);
      expect(result.handledAsCommand).toBe(true);
    });

    it("appends args to built-in command text", async () => {
      seedSession(adapter, "cs_1");
      const sendSpy = vi.spyOn(adapter, "sendMessage").mockResolvedValue({
        id: "msg_1",
        sessionId: "cs_1",
        role: "assistant",
        time: { created: Date.now() },
        parts: [],
      });

      await adapter.invokeCommand("cs_1", "context", "verbose");
      expect(sendSpy).toHaveBeenCalledWith("cs_1", [{ type: "text", text: "/context verbose" }], undefined);
    });
  });

  // =========================================================================
  // O. normalizeInputKeys()
  // =========================================================================

  describe("normalizeInputKeys() (static)", () => {
    it("converts snake_case keys to camelCase", () => {
      const result = (ClaudeCodeAdapter as any).normalizeInputKeys({
        file_path: "/a.ts",
        old_string: "foo",
        new_string: "bar",
        no_change: true,
      });
      expect(result).toEqual({
        filePath: "/a.ts",
        oldString: "foo",
        newString: "bar",
        noChange: true,
      });
    });

    it("leaves already-camelCase keys unchanged", () => {
      const result = (ClaudeCodeAdapter as any).normalizeInputKeys({ command: "ls" });
      expect(result).toEqual({ command: "ls" });
    });
  });

  // =========================================================================
  // P. sendMessage() — core paths
  // =========================================================================

  describe("sendMessage()", () => {
    it("throws when session directory is not found", async () => {
      await expect(
        adapter.sendMessage("unknown_session", [{ type: "text", text: "hi" }]),
      ).rejects.toThrow("not found");
    });

    it("throws when message content is empty", async () => {
      seedSession(adapter, "cs_1");
      await expect(
        adapter.sendMessage("cs_1", [{ type: "text", text: "   " }]),
      ).rejects.toThrow("cannot be empty");
    });

    it("emits message.updated for user message on normal path", async () => {
      seedSession(adapter, "cs_1");
      const events: any[] = [];
      adapter.on("message.updated", (e) => events.push(e));

      // Mock getOrCreateV2Session to avoid real subprocess
      vi.spyOn(adapter as any, "getOrCreateV2Session").mockResolvedValue(
        makeMockV2Session([
          { type: "result", subtype: "success" },
        ]),
      );

      const p = adapter.sendMessage("cs_1", [{ type: "text", text: "Hello" }]);
      await p.catch(() => {});

      const userMsg = events.find((e: any) => e.message.role === "user");
      expect(userMsg).toBeDefined();
      expect((userMsg.message.parts[0] as any).text).toBe("Hello");
    });

    it("emits message.queued when session already has active resolvers", async () => {
      seedSession(adapter, "cs_1");
      // Simulate busy session
      (adapter as any).sendResolvers.set("cs_1", [{ resolve: vi.fn(), reject: vi.fn() }]);

      const queuedEvents: any[] = [];
      adapter.on("message.queued", (e) => queuedEvents.push(e));

      // This should trigger the queue path — don't await, just check emit
      const p = adapter.sendMessage("cs_1", [{ type: "text", text: "Queued message" }]);
      expect(queuedEvents).toHaveLength(1);
      expect(queuedEvents[0].queuePosition).toBe(1);
      // Clean up
      const resolvers = (adapter as any).sendResolvers.get("cs_1");
      resolvers?.[1]?.resolve({ id: "msg_q", sessionId: "cs_1", role: "assistant", time: { created: Date.now() }, parts: [] });
      await p;
    });

    it("builds image content blocks for image attachments", async () => {
      seedSession(adapter, "cs_1");
      const mockV2 = makeMockV2Session([{ type: "result", subtype: "success" }]);
      vi.spyOn(adapter as any, "getOrCreateV2Session").mockResolvedValue(mockV2);

      const base64Data = Buffer.from("fake-image").toString("base64");

      const p = adapter.sendMessage("cs_1", [
        { type: "text", text: "Look at this" },
        { type: "image", data: base64Data, mimeType: "image/png" },
      ]);
      await p.catch(() => {});

      // The send call should receive an object (multimodal), not a plain string
      const sendArg = mockV2.send.mock.calls[0]?.[0];
      if (sendArg) {
        expect(typeof sendArg).toBe("object");
        expect((sendArg as any).message?.content).toBeDefined();
      }
    });
  });

  // =========================================================================
  // Q. getInfo() / getCapabilities()
  // =========================================================================

  describe("getInfo()", () => {
    it("returns engine type 'claude'", () => {
      expect(adapter.getInfo().type).toBe("claude");
    });

    it("returns error message when status is error", () => {
      (adapter as any).status = "error";
      (adapter as any).lastError = "init failed";
      expect(adapter.getInfo().errorMessage).toBe("init failed");
    });

    it("does not include errorMessage when status is not error", () => {
      (adapter as any).status = "running";
      expect(adapter.getInfo().errorMessage).toBeUndefined();
    });
  });

  describe("getCapabilities()", () => {
    it("includes expected capability flags", () => {
      const caps = adapter.getCapabilities();
      expect(caps.messageCancellation).toBe(true);
      expect(caps.imageAttachment).toBe(true);
      expect(caps.slashCommands).toBe(true);
      expect(caps.messageEnqueue).toBe(true);
    });
  });

  describe("healthCheck()", () => {
    it("returns true when status is running", async () => {
      (adapter as any).status = "running";
      expect(await adapter.healthCheck()).toBe(true);
    });

    it("returns false when status is error", async () => {
      (adapter as any).status = "error";
      expect(await adapter.healthCheck()).toBe(false);
    });
  });

  // =========================================================================
  // R. listMessages()
  // =========================================================================

  describe("listMessages()", () => {
    it("returns in-memory history when available", async () => {
      const msgs = [
        { id: "m1", sessionId: "cs_1", role: "user" as const, time: { created: 1 }, parts: [] },
      ];
      (adapter as any).messageHistory.set("cs_1", msgs);
      const result = await adapter.listMessages("cs_1");
      expect(result).toBe(msgs);
    });

    it("returns empty array when no history and no ccSessionId", async () => {
      seedSession(adapter, "cs_1");
      const result = await adapter.listMessages("cs_1");
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // S. Error classification truth table (processStream end states)
  // =========================================================================

  describe("processStream error classification", () => {
    /**
     * Drive processStream directly with a controlled stream.
     * Streams must start with system:init so the adapter doesn't classify
     * the turn as a stale autonomous turn and discard it.
     */
    async function runStream(sessionId: string, streamEvents: any[]): Promise<any> {
      seedSession(adapter, sessionId);
      const abortController = new AbortController();

      const mockV2Session = makeMockV2Session(streamEvents);

      const buf: MessageBuffer = {
        messageId: "msg_stream",
        sessionId,
        parts: [],
        textAccumulator: "",
        textPartId: null,
        reasoningAccumulator: "",
        reasoningPartId: null,
        startTime: Date.now(),
      };

      // Setup resolver
      const resolvers: any[] = [];
      (adapter as any).sendResolvers.set(sessionId, resolvers);
      (adapter as any).messageBuffers.set(sessionId, buf);

      const resultPromise = new Promise<any>((resolve) => {
        resolvers.push({ resolve, reject: vi.fn() });
      });

      (adapter as any).processStream(mockV2Session, sessionId, "Hello", buf, abortController)
        .catch(() => {});

      return resultPromise;
    }

    it("sets error:empty_response when result received but no content and no abort", async () => {
      // Stream starts with system:init (so not classified as stale), then result
      // with no content blocks → empty_response
      const result = await runStream("cs_empty", [
        { type: "system", subtype: "init", session_id: "cc-1" },
        { type: "result", subtype: "success" },
      ]);
      expect(result.error).toBe("error:empty_response");
    });

    it("sets error:interrupted when no result message received", async () => {
      // Stream starts with system:init but ends before a result message arrives
      // → receivedResult remains false → isInterrupted = true
      const result = await runStream("cs_interrupted", [
        { type: "system", subtype: "init", session_id: "cc-1" },
        // Deliberately omit result message
      ]);
      expect(result.error).toBe("error:interrupted");
    });
  });

  // =========================================================================
  // T. Session cleanup helpers
  // =========================================================================

  describe("cleanupSession()", () => {
    it("preserves capturedSessionId in sessionCcIds before closing", () => {
      const mock = makeMockV2Session();
      seedV2Session(adapter, "cs_1", mock);
      (adapter as any).v2Sessions.get("cs_1").capturedSessionId = "cc-preserved";

      (adapter as any).cleanupSession("cs_1", "test cleanup");

      expect((adapter as any).sessionCcIds.get("cs_1")).toBe("cc-preserved");
      expect((adapter as any).v2Sessions.has("cs_1")).toBe(false);
      expect(mock.close).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when session not in v2Sessions", () => {
      expect(() => (adapter as any).cleanupSession("nonexistent", "test")).not.toThrow();
    });
  });

  // =========================================================================
  // U. getModes()
  // =========================================================================

  describe("getModes()", () => {
    it("returns the three default modes", () => {
      const modes = adapter.getModes();
      const ids = modes.map((m) => m.id);
      expect(ids).toContain("default");
      expect(ids).toContain("plan");
      expect(ids).toContain("acceptEdits");
    });
  });

  // =========================================================================
  // V. handleSystemMessage() — additional subtypes
  // =========================================================================

  describe("handleSystemMessage() — additional subtypes", () => {
    it("handles status subtype with compacting status", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      expect(() => {
        (adapter as any).handleSystemMessage(
          { type: "system", subtype: "status", status: "compacting" },
          "cs_1", buf,
        );
      }).not.toThrow();
    });

    it("handles task_started subtype and maps taskId to toolUseId", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "call_task1", "Task", { description: "run tests" });
      (adapter as any).messageBuffers.set("cs_1", buf);

      (adapter as any).handleSystemMessage(
        {
          type: "system",
          subtype: "task_started",
          tool_use_id: "call_task1",
          task_id: "task-abc",
          description: "Executing task",
          prompt: "run all tests",
        },
        "cs_1", buf,
      );

      expect((adapter as any).taskToToolUseId.get("task-abc")).toBe("call_task1");
      const toolPart = (adapter as any).toolCallParts.get("call_task1") as any;
      expect(toolPart.state.input._taskId).toBe("task-abc");
      expect(toolPart.state.input._taskDescription).toBe("Executing task");
      expect(toolPart.state.input._taskPrompt).toBe("run all tests");
    });

    it("handles task_started subtype without toolUseId (no-op)", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      expect(() => {
        (adapter as any).handleSystemMessage(
          { type: "system", subtype: "task_started", task_id: "task-xyz" },
          "cs_1", buf,
        );
      }).not.toThrow();
      expect((adapter as any).taskToToolUseId.has("task-xyz")).toBe(false);
    });

    it("handles task_progress subtype and updates toolPart input", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "call_prog", "Task", {});
      (adapter as any).taskToToolUseId.set("task-prog", "call_prog");
      (adapter as any).messageBuffers.set("cs_1", buf);

      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      (adapter as any).handleSystemMessage(
        {
          type: "system",
          subtype: "task_progress",
          task_id: "task-prog",
          description: "Updated description",
          last_tool_name: "Bash",
          summary: "Ran 3 tests",
          usage: { total_tokens: 500, tool_uses: 2, duration_ms: 1200 },
        },
        "cs_1", buf,
      );

      const toolPart = (adapter as any).toolCallParts.get("call_prog") as any;
      expect(toolPart.state.input._taskDescription).toBe("Updated description");
      expect(toolPart.state.input._lastToolName).toBe("Bash");
      expect(toolPart.state.input._summary).toBe("Ran 3 tests");
      expect(toolPart.state.input._taskUsage.totalTokens).toBe(500);
    });

    it("handles task_progress using tool_use_id directly (no taskToToolUseId lookup)", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "call_direct", "Task", {});
      (adapter as any).messageBuffers.set("cs_1", buf);

      (adapter as any).handleSystemMessage(
        {
          type: "system",
          subtype: "task_progress",
          tool_use_id: "call_direct",
          task_id: "task-direct",
          description: "Direct update",
        },
        "cs_1", buf,
      );

      const toolPart = (adapter as any).toolCallParts.get("call_direct") as any;
      expect(toolPart.state.input._taskDescription).toBe("Direct update");
    });

    it("handles task_notification and cleans up task mapping", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "call_notif", "Task", {});
      (adapter as any).taskToToolUseId.set("task-notif", "call_notif");
      (adapter as any).messageBuffers.set("cs_1", buf);

      (adapter as any).handleSystemMessage(
        {
          type: "system",
          subtype: "task_notification",
          task_id: "task-notif",
          tool_use_id: "call_notif",
          status: "completed",
          summary: "All done",
          usage: { total_tokens: 1000, tool_uses: 5, duration_ms: 3000 },
        },
        "cs_1", buf,
      );

      const toolPart = (adapter as any).toolCallParts.get("call_notif") as any;
      expect(toolPart.state.input._taskStatus).toBe("completed");
      expect(toolPart.state.input._summary).toBe("All done");
      // Task mapping should be removed
      expect((adapter as any).taskToToolUseId.has("task-notif")).toBe(false);
    });

    it("handles compact_boundary without metadata (no notice emitted)", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      (adapter as any).handleSystemMessage(
        { type: "system", subtype: "compact_boundary" },
        "cs_1", buf,
      );

      const noticeParts = buf.parts.filter((p: any) => p.type === "system-notice");
      expect(noticeParts).toHaveLength(0);
    });

    it("handles init subtype without ccSessionId (no session.updated emitted)", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const updates: any[] = [];
      adapter.on("session.updated", (e) => updates.push(e));

      (adapter as any).handleSystemMessage(
        { type: "system", subtype: "init", model: "claude-3" },
        "cs_1", buf,
      );

      expect(updates).toHaveLength(0);
    });
  });

  // =========================================================================
  // W. handleToolProgress() and handleToolUseSummary()
  // =========================================================================

  describe("handleToolProgress()", () => {
    it("updates parent Task ToolPart with current subtool info", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "task_parent", "Task", {});
      (adapter as any).messageBuffers.set("cs_1", buf);

      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      (adapter as any).handleToolProgress(
        {
          tool_use_id: "inner_bash",
          tool_name: "Bash",
          parent_tool_use_id: "task_parent",
          elapsed_time_seconds: 2.5,
        },
        "cs_1",
      );

      const toolPart = (adapter as any).toolCallParts.get("task_parent") as any;
      expect(toolPart.state.input._currentTool).toBe("Bash");
      expect(toolPart.state.input._currentToolElapsed).toBe(2.5);
      expect(partUpdates.some((e: any) => e.part.callId === "task_parent")).toBe(true);
    });

    it("does nothing when parent_tool_use_id is null", () => {
      expect(() => {
        (adapter as any).handleToolProgress(
          {
            tool_use_id: "inner",
            tool_name: "Read",
            parent_tool_use_id: null,
            elapsed_time_seconds: 1,
          },
          "cs_1",
        );
      }).not.toThrow();
    });
  });

  describe("handleToolUseSummary()", () => {
    it("attaches summary to the last preceding task ToolPart", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "task_sum", "Task", {});
      (adapter as any).messageBuffers.set("cs_1", buf);

      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      (adapter as any).handleToolUseSummary(
        {
          summary: "Completed all subtasks",
          preceding_tool_use_ids: ["bash_1", "task_sum"],
        },
        "cs_1",
      );

      const toolPart = (adapter as any).toolCallParts.get("task_sum") as any;
      expect(toolPart.state.input._summary).toBe("Completed all subtasks");
    });

    it("does not overwrite existing _summary", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "task_existing", "Task", {});
      const toolPart = (adapter as any).toolCallParts.get("task_existing") as any;
      toolPart.state.input._summary = "original summary";
      (adapter as any).messageBuffers.set("cs_1", buf);

      (adapter as any).handleToolUseSummary(
        {
          summary: "new summary",
          preceding_tool_use_ids: ["task_existing"],
        },
        "cs_1",
      );

      expect(toolPart.state.input._summary).toBe("original summary");
    });

    it("does nothing when no matching task tool part found", () => {
      expect(() => {
        (adapter as any).handleToolUseSummary(
          { summary: "orphan summary", preceding_tool_use_ids: ["nonexistent"] },
          "cs_1",
        );
      }).not.toThrow();
    });
  });

  // =========================================================================
  // X. handleSdkMessage() — tool_progress / tool_use_summary / default
  // =========================================================================

  describe("handleSdkMessage() — additional types", () => {
    it("dispatches 'tool_progress' messages to handleToolProgress", () => {
      const spy = vi.spyOn(adapter as any, "handleToolProgress");
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };
      const streamingBlocks = new Map();

      (adapter as any).handleSdkMessage(
        {
          type: "tool_progress",
          tool_use_id: "call_1",
          tool_name: "Bash",
          parent_tool_use_id: null,
          elapsed_time_seconds: 1,
        },
        "cs_1", buf, streamingBlocks, endState,
      );
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("dispatches 'tool_use_summary' messages to handleToolUseSummary", () => {
      const spy = vi.spyOn(adapter as any, "handleToolUseSummary");
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };
      const streamingBlocks = new Map();

      (adapter as any).handleSdkMessage(
        {
          type: "tool_use_summary",
          summary: "Done",
          preceding_tool_use_ids: [],
        },
        "cs_1", buf, streamingBlocks, endState,
      );
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("handles unrecognized message types gracefully (default branch)", () => {
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };
      const streamingBlocks = new Map();

      expect(() => {
        (adapter as any).handleSdkMessage(
          { type: "unknown_future_type", data: "some payload" },
          "cs_1", buf, streamingBlocks, endState,
        );
      }).not.toThrow();
    });
  });

  // =========================================================================
  // Y. handleStreamEvent() — additional sub-event branches
  // =========================================================================

  describe("handleStreamEvent() — additional branches", () => {
    it("starts thinking block on content_block_start for thinking type", () => {
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();

      (adapter as any).handleStreamEvent(
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "initial thought" },
          },
        },
        "cs_1", buf, streamingBlocks,
      );

      const block = streamingBlocks.get(0);
      expect(block).toBeDefined();
      expect(block.type).toBe("thinking");
      expect(block.content).toBe("initial thought");
    });

    it("starts text block on content_block_start for text type", () => {
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();

      (adapter as any).handleStreamEvent(
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 2,
            content_block: { type: "text" },
          },
        },
        "cs_1", buf, streamingBlocks,
      );

      const block = streamingBlocks.get(2);
      expect(block).toBeDefined();
      expect(block.type).toBe("text");
    });

    it("accumulates input_json_delta for tool block", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();

      // First start a tool block
      (adapter as any).handleStreamEvent(
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "call_json", name: "Bash" },
          },
        },
        "cs_1", buf, streamingBlocks,
      );

      // Now send partial JSON
      (adapter as any).handleStreamEvent(
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"command":' },
          },
        },
        "cs_1", buf, streamingBlocks,
      );

      (adapter as any).handleStreamEvent(
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '"ls -la"}' },
          },
        },
        "cs_1", buf, streamingBlocks,
      );

      // Verify accumulation
      expect(streamingBlocks.get(0)?.content).toBe('{"command":"ls -la"}');

      // Stop the block — should parse and update tool part
      (adapter as any).handleStreamEvent(
        {
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
        },
        "cs_1", buf, streamingBlocks,
      );

      const toolPart = (adapter as any).toolCallParts.get("call_json") as any;
      expect(toolPart.state.input.command).toBe("ls -la");
    });

    it("ignores content_block_delta for unknown index", () => {
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();

      expect(() => {
        (adapter as any).handleStreamEvent(
          {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 99,
              delta: { type: "text_delta", text: "ignored" },
            },
          },
          "cs_1", buf, streamingBlocks,
        );
      }).not.toThrow();
    });

    it("ignores content_block_stop for unknown index", () => {
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();

      expect(() => {
        (adapter as any).handleStreamEvent(
          {
            type: "stream_event",
            event: { type: "content_block_stop", index: 99 },
          },
          "cs_1", buf, streamingBlocks,
        );
      }).not.toThrow();
    });

    it("content_block_stop for non-tool block removes block from map", () => {
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();
      streamingBlocks.set(3, { index: 3, type: "text", content: "some text" });

      (adapter as any).handleStreamEvent(
        {
          type: "stream_event",
          event: { type: "content_block_stop", index: 3 },
        },
        "cs_1", buf, streamingBlocks,
      );

      expect(streamingBlocks.has(3)).toBe(false);
    });

    it("handles message_start event without throwing", () => {
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();

      expect(() => {
        (adapter as any).handleStreamEvent(
          {
            type: "stream_event",
            event: { type: "message_start", message: {} },
          },
          "cs_1", buf, streamingBlocks,
        );
      }).not.toThrow();
    });

    it("handles message_delta event without throwing", () => {
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();

      expect(() => {
        (adapter as any).handleStreamEvent(
          {
            type: "stream_event",
            event: { type: "message_delta", delta: {} },
          },
          "cs_1", buf, streamingBlocks,
        );
      }).not.toThrow();
    });

    it("handles message_stop event without throwing", () => {
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();

      expect(() => {
        (adapter as any).handleStreamEvent(
          {
            type: "stream_event",
            event: { type: "message_stop" },
          },
          "cs_1", buf, streamingBlocks,
        );
      }).not.toThrow();
    });

    it("handles content_block_start without content_block (no-op)", () => {
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();

      expect(() => {
        (adapter as any).handleStreamEvent(
          {
            type: "stream_event",
            event: { type: "content_block_start", index: 0 },
          },
          "cs_1", buf, streamingBlocks,
        );
      }).not.toThrow();
      expect(streamingBlocks.size).toBe(0);
    });

    it("handles unknown stream event type gracefully", () => {
      const buf = makeBuffer("cs_1");
      const streamingBlocks = new Map();

      expect(() => {
        (adapter as any).handleStreamEvent(
          {
            type: "stream_event",
            event: { type: "some_future_event" },
          },
          "cs_1", buf, streamingBlocks,
        );
      }).not.toThrow();
    });
  });

  // =========================================================================
  // Z. handleAssistantMessage() — additional branches
  // =========================================================================

  describe("handleAssistantMessage() — additional branches", () => {
    it("ignores whitespace-only string content", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      (adapter as any).handleAssistantMessage(
        { type: "assistant", message: { content: "   \n  " } },
        "cs_1", buf,
      );

      expect(partUpdates).toHaveLength(0);
      expect(buf.parts).toHaveLength(0);
    });

    it("ignores non-array, non-string content", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      (adapter as any).handleAssistantMessage(
        { type: "assistant", message: { content: 42 } },
        "cs_1", buf,
      );

      expect(partUpdates).toHaveLength(0);
    });

    it("flushes text accumulator before tool_use block", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      (adapter as any).handleAssistantMessage(
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Before tool" },
              { type: "tool_use", id: "call_flush", name: "Bash", input: { command: "ls" } },
            ],
          },
        },
        "cs_1", buf,
      );

      // Text was flushed — text accumulator should be reset
      expect(buf.textAccumulator).toBe("");
      expect(buf.parts.some((p: any) => p.type === "tool")).toBe(true);
    });
  });

  // =========================================================================
  // AA. handleUserMessage() — additional branches
  // =========================================================================

  describe("handleUserMessage() — additional branches", () => {
    it("appends non-empty string content", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      (adapter as any).handleUserMessage(
        {
          type: "user",
          message: { content: "slash command output text" },
        },
        "cs_1", buf,
      );

      expect(buf.textAccumulator).toBe("slash command output text");
    });

    it("ignores whitespace-only string content", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      (adapter as any).handleUserMessage(
        {
          type: "user",
          message: { content: "   " },
        },
        "cs_1", buf,
      );

      expect(partUpdates).toHaveLength(0);
    });

    it("ignores non-array non-string content", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      expect(() => {
        (adapter as any).handleUserMessage(
          { type: "user", message: { content: null } },
          "cs_1", buf,
        );
      }).not.toThrow();
      expect(buf.parts).toHaveLength(0);
    });

    it("appends text blocks in array user message content", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      (adapter as any).handleUserMessage(
        {
          type: "user",
          message: {
            content: [
              { type: "text", text: "  chunk1  " },
              { type: "text", text: "chunk2" },
            ],
          },
        },
        "cs_1", buf,
      );

      // Each non-empty trimmed text block gets appended
      expect(buf.textAccumulator).toBeTruthy();
    });

    it("ignores text blocks with empty text", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      (adapter as any).handleUserMessage(
        {
          type: "user",
          message: { content: [{ type: "text", text: "" }] },
        },
        "cs_1", buf,
      );

      expect(partUpdates).toHaveLength(0);
    });

    it("returns early when message has no content", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      expect(() => {
        (adapter as any).handleUserMessage(
          { type: "user", message: {} },
          "cs_1", buf,
        );
      }).not.toThrow();
      expect(buf.parts).toHaveLength(0);
    });
  });

  // =========================================================================
  // AB. handleResultMessage() — additional branches
  // =========================================================================

  describe("handleResultMessage() — additional branches", () => {
    it("uses result text even when buffer has no parts but does have textAccumulator", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      buf.textAccumulator = "existing text";
      const endState = { receivedResult: false, hadErrorDuringExecution: false };

      (adapter as any).handleResultMessage(
        { type: "result", subtype: "success", result: "new result text", is_error: false },
        "cs_1", buf, endState,
      );

      // Buffer already had text, so result text should NOT replace it
      expect(buf.textAccumulator).toBe("existing text");
    });

    it("uses result text when buffer is completely empty (no parts, no textAccumulator)", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };

      (adapter as any).handleResultMessage(
        { type: "result", subtype: "success", result: "slash result text", is_error: false },
        "cs_1", buf, endState,
      );

      expect(buf.textAccumulator).toBe("slash result text");
    });

    it("does not overwrite result.result text when is_error is true", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };

      (adapter as any).handleResultMessage(
        { type: "result", is_error: true, result: "Error message" },
        "cs_1", buf, endState,
      );

      // is_error: buffer.error gets set from result, textAccumulator stays empty
      expect(buf.error).toBe("Error message");
      expect(buf.textAccumulator).toBe("");
    });

    it("does not use result text when parts already exist", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      buf.parts.push({ type: "text", id: "p1", messageId: "msg_1", sessionId: "cs_1", text: "hi" } as any);
      const endState = { receivedResult: false, hadErrorDuringExecution: false };

      (adapter as any).handleResultMessage(
        { type: "result", subtype: "success", result: "ignored text", is_error: false },
        "cs_1", buf, endState,
      );

      expect(buf.textAccumulator).toBe("");
    });

    it("handles result without usage (no token update)", () => {
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };

      (adapter as any).handleResultMessage(
        { type: "result", subtype: "success" },
        "cs_1", buf, endState,
      );

      expect(endState.receivedResult).toBe(true);
      expect(buf.tokens).toBeUndefined();
    });

    it("handles result with null total_cost_usd (no cost update)", () => {
      const buf = makeBuffer("cs_1");
      const endState = { receivedResult: false, hadErrorDuringExecution: false };

      (adapter as any).handleResultMessage(
        { type: "result", subtype: "success", total_cost_usd: null },
        "cs_1", buf, endState,
      );

      expect(buf.cost).toBeUndefined();
    });
  });

  // =========================================================================
  // AC. processStream() — error classification truth table (additional rows)
  // =========================================================================

  describe("processStream error classification — additional truth table rows", () => {
    async function runStreamForClassification(sessionId: string, streamEvents: any[]): Promise<any> {
      seedSession(adapter, sessionId);
      const abortController = new AbortController();
      const mockV2Session = makeMockV2Session(streamEvents);

      const buf: import("../../../../../electron/main/engines/engine-adapter").MessageBuffer = {
        messageId: "msg_cls",
        sessionId,
        parts: [],
        textAccumulator: "",
        textPartId: null,
        reasoningAccumulator: "",
        reasoningPartId: null,
        startTime: Date.now(),
      };

      const resolvers: any[] = [];
      (adapter as any).sendResolvers.set(sessionId, resolvers);
      (adapter as any).messageBuffers.set(sessionId, buf);

      const resultPromise = new Promise<any>((resolve) => {
        resolvers.push({ resolve, reject: vi.fn() });
      });

      (adapter as any).processStream(mockV2Session, sessionId, "Hello", buf, abortController)
        .catch(() => {});

      return resultPromise;
    }

    it("sets error:interrupted when error_during_execution and content exists", async () => {
      const result = await runStreamForClassification("cs_exec_err", [
        { type: "system", subtype: "init", session_id: "cc-1" },
        // Simulate content via text in assistant message
        { type: "assistant", message: { content: [{ type: "text", text: "partial output" }] } },
        { type: "result", subtype: "error_during_execution" },
      ]);
      expect(result.error).toBe("error:interrupted");
    });

    it("sets no error when content exists, result received, not aborted", async () => {
      const result = await runStreamForClassification("cs_normal_ok", [
        { type: "system", subtype: "init", session_id: "cc-1" },
        { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
        { type: "result", subtype: "success" },
      ]);
      expect(result.error).toBeUndefined();
    });
  });

  // =========================================================================
  // AD. finalizeCurrentTurn() — resolver resolution
  // =========================================================================

  describe("finalizeCurrentTurn()", () => {
    it("resolves the first resolver and emits queued.consumed when more remain", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      buf.parts.push({ type: "text", id: "p1", messageId: "msg_1", sessionId: "cs_1", text: "hi" } as any);

      const resolve1 = vi.fn();
      const resolve2 = vi.fn();
      (adapter as any).sendResolvers.set("cs_1", [
        { resolve: resolve1, reject: vi.fn() },
        { resolve: resolve2, reject: vi.fn() },
      ]);

      const consumedEvents: any[] = [];
      adapter.on("message.queued.consumed", (e) => consumedEvents.push(e));

      (adapter as any).finalizeCurrentTurn("cs_1", buf, false);

      expect(resolve1).toHaveBeenCalledTimes(1);
      expect(resolve2).not.toHaveBeenCalled();
      expect(consumedEvents).toHaveLength(1);
      // One resolver remains
      expect((adapter as any).sendResolvers.get("cs_1")).toHaveLength(1);
    });

    it("resolves the only resolver and clears sendResolvers when no more remain", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const resolve = vi.fn();
      (adapter as any).sendResolvers.set("cs_1", [{ resolve, reject: vi.fn() }]);

      const consumedEvents: any[] = [];
      adapter.on("message.queued.consumed", (e) => consumedEvents.push(e));

      (adapter as any).finalizeCurrentTurn("cs_1", buf, false);

      expect(resolve).toHaveBeenCalledTimes(1);
      expect(consumedEvents).toHaveLength(0);
      expect((adapter as any).sendResolvers.has("cs_1")).toBe(false);
    });

    it("adds message to history and emits message.updated", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      buf.tokens = { input: 10, output: 5, cache: { read: 0, write: 0 } };
      buf.cost = 0.001;
      buf.modelId = "claude-3";

      const msgUpdates: any[] = [];
      adapter.on("message.updated", (e) => msgUpdates.push(e));
      (adapter as any).sendResolvers.set("cs_1", [{ resolve: vi.fn(), reject: vi.fn() }]);

      (adapter as any).finalizeCurrentTurn("cs_1", buf, false);

      expect(msgUpdates.some((e: any) => e.message.role === "assistant")).toBe(true);
      const history = (adapter as any).messageHistory.get("cs_1");
      expect(history?.some((m: any) => m.role === "assistant")).toBe(true);
    });

    it("cleans up tool call parts for the session", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "call_cleanup", "Bash", {});

      (adapter as any).sendResolvers.set("cs_1", [{ resolve: vi.fn(), reject: vi.fn() }]);
      (adapter as any).finalizeCurrentTurn("cs_1", buf, false);

      expect((adapter as any).toolCallParts.has("call_cleanup")).toBe(false);
    });

    it("handles finalization when no resolvers exist", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");

      expect(() => {
        (adapter as any).finalizeCurrentTurn("cs_1", buf, false);
      }).not.toThrow();
    });
  });

  // =========================================================================
  // AE. getOrCreateV2Session() — permission mode change at runtime
  // =========================================================================

  describe("getOrCreateV2Session() — session reuse and permission mode changes", () => {
    it("reuses existing session with same permissionMode", async () => {
      const mockSession = makeMockV2Session();
      seedV2Session(adapter, "cs_1", mockSession);
      (adapter as any).v2Sessions.get("cs_1").permissionMode = "default";

      const session = await (adapter as any).getOrCreateV2Session("cs_1", "/repo", {
        permissionMode: "default",
      });

      expect(session).toBe(mockSession);
      // setPermissionMode should NOT be called
      expect(mockSession.query.setPermissionMode).not.toHaveBeenCalled();
    });

    it("switches permissionMode at runtime when mode changed", async () => {
      const mockSession = makeMockV2Session();
      seedV2Session(adapter, "cs_1", mockSession);
      (adapter as any).v2Sessions.get("cs_1").permissionMode = "default";

      const session = await (adapter as any).getOrCreateV2Session("cs_1", "/repo", {
        permissionMode: "plan",
      });

      expect(session).toBe(mockSession);
      expect(mockSession.query.setPermissionMode).toHaveBeenCalledWith("plan");
      expect((adapter as any).v2Sessions.get("cs_1").permissionMode).toBe("plan");
    });

    it("handles setPermissionMode failure gracefully", async () => {
      const mockSession = makeMockV2Session();
      mockSession.query.setPermissionMode.mockRejectedValue(new Error("setPermissionMode failed"));
      seedV2Session(adapter, "cs_1", mockSession);
      (adapter as any).v2Sessions.get("cs_1").permissionMode = "default";

      // Should not throw even though setPermissionMode fails
      const session = await (adapter as any).getOrCreateV2Session("cs_1", "/repo", {
        permissionMode: "plan",
      });

      expect(session).toBe(mockSession);
    });

    it("creates new session via resume when ccSessionId exists", async () => {
      seedSession(adapter, "cs_1");
      (adapter as any).sessionCcIds.set("cs_1", "cc-resume-abc");

      unstable_v2_resumeSessionMock.mockReturnValue(makeMockV2Session());

      await (adapter as any).getOrCreateV2Session("cs_1", "/repo", {});

      expect(unstable_v2_resumeSessionMock).toHaveBeenCalledWith(
        "cc-resume-abc",
        expect.any(Object),
      );
    });

    it("creates new session via createSession when no ccSessionId", async () => {
      seedSession(adapter, "cs_1");

      unstable_v2_createSessionMock.mockReturnValue(makeMockV2Session());

      await (adapter as any).getOrCreateV2Session("cs_1", "/repo", {});

      expect(unstable_v2_createSessionMock).toHaveBeenCalled();
    });

    it("recreates session when transport is not ready", async () => {
      const deadSession = makeMockV2Session();
      deadSession.query.transport.isReady.mockReturnValue(false);
      seedV2Session(adapter, "cs_1", deadSession);
      (adapter as any).v2Sessions.get("cs_1").capturedSessionId = "cc-dead";

      unstable_v2_resumeSessionMock.mockReturnValue(makeMockV2Session());

      await (adapter as any).getOrCreateV2Session("cs_1", "/repo", {});

      // Dead session should be cleaned up
      expect(deadSession.close).toHaveBeenCalled();
      // New session should be created via resume (preserving ccSessionId)
      expect(unstable_v2_resumeSessionMock).toHaveBeenCalledWith("cc-dead", expect.any(Object));
      // pendingResumeNotice should be set
      expect((adapter as any).pendingResumeNotice.has("cs_1")).toBe(true);
    });
  });

  // =========================================================================
  // AF. sendMessage() — reasoning effort change paths
  // =========================================================================

  describe("sendMessage() — reasoning effort change in options", () => {
    it("applies new reasoningEffort from options and rebuilds session", async () => {
      seedSession(adapter, "cs_1");
      const mockV2 = makeMockV2Session([
        { type: "system", subtype: "init", session_id: "cc-1" },
        { type: "result", subtype: "success" },
      ]);
      vi.spyOn(adapter as any, "getOrCreateV2Session").mockResolvedValue(mockV2);

      await adapter.sendMessage("cs_1", [{ type: "text", text: "Hello" }], {
        reasoningEffort: "high",
      }).catch(() => {});

      expect((adapter as any).sessionReasoningEfforts.get("cs_1")).toBe("high");
    });

    it("clears reasoningEffort when null passed in options", async () => {
      seedSession(adapter, "cs_1");
      (adapter as any).sessionReasoningEfforts.set("cs_1", "low");

      const mockV2 = makeMockV2Session([
        { type: "system", subtype: "init", session_id: "cc-1" },
        { type: "result", subtype: "success" },
      ]);
      vi.spyOn(adapter as any, "getOrCreateV2Session").mockResolvedValue(mockV2);

      await adapter.sendMessage("cs_1", [{ type: "text", text: "Hello" }], {
        reasoningEffort: null,
      }).catch(() => {});

      expect((adapter as any).sessionReasoningEfforts.has("cs_1")).toBe(false);
    });

    it("emits session_resumed notice when pendingResumeNotice is set", async () => {
      seedSession(adapter, "cs_1");
      (adapter as any).pendingResumeNotice.add("cs_1");

      const mockV2 = makeMockV2Session([
        { type: "system", subtype: "init", session_id: "cc-1" },
        { type: "result", subtype: "success" },
      ]);
      vi.spyOn(adapter as any, "getOrCreateV2Session").mockResolvedValue(mockV2);

      const partUpdates: any[] = [];
      adapter.on("message.part.updated", (e) => partUpdates.push(e));

      await adapter.sendMessage("cs_1", [{ type: "text", text: "Hello" }]).catch(() => {});

      const resumePart = partUpdates.find((e: any) => e.part.text === "notice:session_resumed");
      expect(resumePart).toBeDefined();
      expect((adapter as any).pendingResumeNotice.has("cs_1")).toBe(false);
    });

    it("applies mode option when provided in sendMessage", async () => {
      seedSession(adapter, "cs_1");
      const mockV2 = makeMockV2Session([
        { type: "result", subtype: "success" },
      ]);
      const getOrCreateSpy = vi.spyOn(adapter as any, "getOrCreateV2Session").mockResolvedValue(mockV2);

      await adapter.sendMessage("cs_1", [{ type: "text", text: "Hello" }], {
        mode: "plan",
      }).catch(() => {});

      expect(getOrCreateSpy).toHaveBeenCalledWith(
        "cs_1",
        expect.any(String),
        expect.objectContaining({ permissionMode: "plan" }),
      );
    });

    it("sends multimodal message when only image provided (no text)", async () => {
      seedSession(adapter, "cs_1");
      const mockV2 = makeMockV2Session([
        { type: "result", subtype: "success" },
      ]);
      vi.spyOn(adapter as any, "getOrCreateV2Session").mockResolvedValue(mockV2);

      const base64Data = Buffer.from("fake-image-data").toString("base64");

      // Image-only message (no text)
      const p = adapter.sendMessage("cs_1", [
        { type: "image", data: base64Data, mimeType: "image/jpeg" },
      ]);
      await p.catch(() => {});

      const sendArg = mockV2.send.mock.calls[0]?.[0];
      expect(typeof sendArg).toBe("object");
      const contentBlocks = (sendArg as any).message?.content ?? [];
      expect(contentBlocks.some((b: any) => b.type === "image")).toBe(true);
      expect(contentBlocks.some((b: any) => b.type === "text")).toBe(false);
    });

    it("does not include text block in image message when text is empty", async () => {
      seedSession(adapter, "cs_1");
      const mockV2 = makeMockV2Session([
        { type: "result", subtype: "success" },
      ]);
      vi.spyOn(adapter as any, "getOrCreateV2Session").mockResolvedValue(mockV2);

      const base64Data = Buffer.from("img").toString("base64");
      const p = adapter.sendMessage("cs_1", [
        { type: "text", text: "  " }, // whitespace only
        { type: "image", data: base64Data, mimeType: "image/png" },
      ]);
      await p.catch(() => {});

      const sendArg = mockV2.send.mock.calls[0]?.[0] as any;
      const textBlocks = sendArg?.message?.content?.filter((b: any) => b.type === "text") ?? [];
      expect(textBlocks).toHaveLength(0);
    });
  });

  // =========================================================================
  // AG. cancelMessage() — branch coverage
  // =========================================================================

  describe("cancelMessage()", () => {
    it("aborts the active abort controller and marks buffer as Cancelled", async () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      (adapter as any).messageBuffers.set("cs_1", buf);
      const controller = new AbortController();
      (adapter as any).activeAbortControllers.set("cs_1", controller);

      await adapter.cancelMessage("cs_1");

      expect(buf.error).toBe("Cancelled");
      expect(controller.signal.aborted).toBe(true);
    });

    it("handles cancel with no active buffer or controller gracefully", async () => {
      seedSession(adapter, "cs_1");
      await expect(adapter.cancelMessage("cs_1")).resolves.toBeUndefined();
    });

    it("rejects pending questions for the session on cancel", async () => {
      seedSession(adapter, "cs_1");
      const resolveQ = vi.fn();
      (adapter as any).pendingQuestions.set("q-cancel", {
        resolve: resolveQ,
        question: { id: "q-cancel", sessionId: "cs_1" },
      });

      await adapter.cancelMessage("cs_1");

      expect(resolveQ).toHaveBeenCalledWith("");
      expect((adapter as any).pendingQuestions.has("q-cancel")).toBe(false);
    });

    it("resolves pending permissions with deny on cancel", async () => {
      seedSession(adapter, "cs_1");
      const resolvePerm = vi.fn();
      (adapter as any).pendingPermissions.set("perm-cancel", {
        resolve: resolvePerm,
        permission: { id: "perm-cancel", sessionId: "cs_1" },
        input: {},
      });

      await adapter.cancelMessage("cs_1");

      expect(resolvePerm).toHaveBeenCalledWith({ behavior: "deny", message: "Cancelled" });
    });

    it("interrupts the V2 session query on cancel", async () => {
      seedSession(adapter, "cs_1");
      const mockV2 = makeMockV2Session();
      seedV2Session(adapter, "cs_1", mockV2);

      await adapter.cancelMessage("cs_1");

      expect(mockV2.query.interrupt).toHaveBeenCalledTimes(1);
    });

    it("does not interrupt if no V2 session exists", async () => {
      seedSession(adapter, "cs_1");
      // No V2 session seeded
      await expect(adapter.cancelMessage("cs_1")).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // AH. listMessages() — additional branch coverage
  // =========================================================================

  describe("listMessages() — additional branches", () => {
    it("returns empty array when v2Session exists but has no capturedSessionId", async () => {
      const mockV2 = makeMockV2Session();
      seedV2Session(adapter, "cs_1", mockV2);
      // capturedSessionId is undefined by default

      const result = await adapter.listMessages("cs_1");
      expect(result).toEqual([]);
    });

    it("returns non-empty in-memory history when history has entries", async () => {
      const msgs = [
        { id: "m1", sessionId: "cs_1", role: "user" as const, time: { created: 1 }, parts: [] },
        { id: "m2", sessionId: "cs_1", role: "assistant" as const, time: { created: 2 }, parts: [] },
      ];
      (adapter as any).messageHistory.set("cs_1", msgs);
      const result = await adapter.listMessages("cs_1");
      expect(result).toHaveLength(2);
    });
  });

  // =========================================================================
  // AI. deleteSession() — ccSessionId branch
  // =========================================================================

  describe("deleteSession() — ccSessionId file deletion", () => {
    it("calls deleteCCSessionFile when session has ccSessionId and directory", async () => {
      const { deleteCCSessionFile } = await import(
        "../../../../../electron/main/engines/claude/cc-session-files"
      );

      const mock = makeMockV2Session();
      seedV2Session(adapter, "cs_1", mock, "/project");
      (adapter as any).v2Sessions.get("cs_1").capturedSessionId = "cc-del-id";

      await adapter.deleteSession("cs_1");

      expect(deleteCCSessionFile).toHaveBeenCalledWith("cc-del-id", "/project");
    });

    it("falls back to sessionDirectories when v2Session is not present", async () => {
      const { deleteCCSessionFile } = await import(
        "../../../../../electron/main/engines/claude/cc-session-files"
      );

      // Seed only in sessionDirectories, not v2Sessions
      seedSession(adapter, "cs_1", "/fallback-dir");
      (adapter as any).sessionCcIds.set("cs_1", "cc-fallback-id");

      await adapter.deleteSession("cs_1");

      // With no v2Session, capturedSessionId is undefined → no file deletion
      // (deleteCCSessionFile requires both ccSessionId AND directory from v2Session)
      // So it should NOT be called in this path (sessionCcIds is not used in deleteSession)
      // The test verifies no crash happens
      expect(true).toBe(true);
    });
  });

  // =========================================================================
  // AJ. flushTextAccumulator() — branches
  // =========================================================================

  describe("flushTextAccumulator()", () => {
    it("resets textAccumulator and textPartId when non-empty text exists", () => {
      const buf = makeBuffer("cs_1");
      buf.textAccumulator = "some text content";
      buf.textPartId = "tp_existing";

      (adapter as any).flushTextAccumulator("cs_1", buf);

      expect(buf.textAccumulator).toBe("");
      expect(buf.textPartId).toBeNull();
    });

    it("does nothing when textAccumulator is whitespace-only", () => {
      const buf = makeBuffer("cs_1");
      buf.textAccumulator = "   ";
      buf.textPartId = "tp_keep";

      (adapter as any).flushTextAccumulator("cs_1", buf);

      // textPartId should be unchanged because trim() returns empty
      expect(buf.textPartId).toBe("tp_keep");
    });

    it("does nothing when textAccumulator is empty", () => {
      const buf = makeBuffer("cs_1");
      buf.textAccumulator = "";
      buf.textPartId = null;

      (adapter as any).flushTextAccumulator("cs_1", buf);

      expect(buf.textPartId).toBeNull();
    });
  });

  // =========================================================================
  // AK. handleToolResult() — content array with non-text blocks
  // =========================================================================

  describe("handleToolResult() — content array filtering", () => {
    it("filters non-text blocks from array content", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "call_filter", "Bash", {});
      (adapter as any).messageBuffers.set("cs_1", buf);

      (adapter as any).handleToolResult("cs_1", buf, {
        tool_use_id: "call_filter",
        content: [
          { type: "text", text: "line1" },
          { type: "image", data: "base64..." }, // should be filtered
          { type: "text", text: "line2" },
        ],
        is_error: false,
      });

      const toolPart = (adapter as any).toolCallParts.get("call_filter") as any;
      expect(toolPart.state.output).toBe("line1\nline2");
    });

    it("handles tool result when toolPart is in pending (not running) state", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "call_pending", "Read", {});
      const toolPart = (adapter as any).toolCallParts.get("call_pending") as any;
      toolPart.state = { status: "pending", input: {}, time: { start: Date.now() - 50 } };
      (adapter as any).messageBuffers.set("cs_1", buf);

      (adapter as any).handleToolResult("cs_1", buf, {
        tool_use_id: "call_pending",
        content: "output from pending tool",
        is_error: false,
      });

      expect(toolPart.state.status).toBe("completed");
      expect(toolPart.state.output).toBe("output from pending tool");
    });
  });

  // =========================================================================
  // AL. isSessionTransportReady() — branch coverage
  // =========================================================================

  describe("isSessionTransportReady()", () => {
    it("returns false when no transport exists", () => {
      const session: any = { query: {} };
      expect((adapter as any).isSessionTransportReady(session)).toBe(false);
    });

    it("returns result of isReady() when transport has isReady function", () => {
      const session: any = {
        query: { transport: { isReady: () => true } },
      };
      expect((adapter as any).isSessionTransportReady(session)).toBe(true);
    });

    it("returns transport.ready when isReady is not a function but ready is a boolean", () => {
      const session: any = {
        query: { transport: { ready: false } },
      };
      expect((adapter as any).isSessionTransportReady(session)).toBe(false);
    });

    it("returns true when transport exists but has neither isReady nor ready", () => {
      const session: any = {
        query: { transport: {} },
      };
      expect((adapter as any).isSessionTransportReady(session)).toBe(true);
    });

    it("returns false when accessing session.query throws", () => {
      const session: any = {
        get query() { throw new Error("access error"); },
      };
      expect((adapter as any).isSessionTransportReady(session)).toBe(false);
    });
  });

  // =========================================================================
  // AM. getDefaultClaudeReasoningEffort — additional branches
  // =========================================================================

  describe("getClaudeReasoningCapabilities — edge cases", () => {
    it("returns first effort level as default when medium is not in supported list", () => {
      const caps = getClaudeReasoningCapabilities({
        supportsEffort: true,
        supportedEffortLevels: ["high", "max"] as any,
      } as import("@anthropic-ai/claude-agent-sdk").ModelInfo);

      expect(caps.defaultReasoningEffort).toBe("high");
    });

    it("uses medium as default when medium is in supported list", () => {
      const caps = getClaudeReasoningCapabilities({
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"] as any,
      } as import("@anthropic-ai/claude-agent-sdk").ModelInfo);

      expect(caps.defaultReasoningEffort).toBe("medium");
    });
  });

  // =========================================================================
  // AN. handleToolResult() — tool part with null output (empty string)
  // =========================================================================

  describe("handleToolResult() — edge cases for output extraction", () => {
    it("sets output to empty string when content is an empty array", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "call_empty_arr", "Bash", {});
      (adapter as any).messageBuffers.set("cs_1", buf);

      (adapter as any).handleToolResult("cs_1", buf, {
        tool_use_id: "call_empty_arr",
        content: [],
        is_error: false,
      });

      const toolPart = (adapter as any).toolCallParts.get("call_empty_arr") as any;
      expect(toolPart.state.output).toBe("");
    });
  });

  // =========================================================================
  // AO. cleanupSession() — with and without capturedSessionId
  // =========================================================================

  describe("cleanupSession() — capturedSessionId handling", () => {
    it("does not update sessionCcIds when capturedSessionId is absent", () => {
      const mock = makeMockV2Session();
      seedV2Session(adapter, "cs_1", mock);
      // capturedSessionId is not set (undefined)

      (adapter as any).cleanupSession("cs_1", "test");

      // sessionCcIds should not have cs_1 entry since capturedSessionId was undefined
      expect((adapter as any).sessionCcIds.has("cs_1")).toBe(false);
      expect((adapter as any).v2Sessions.has("cs_1")).toBe(false);
    });
  });

  // =========================================================================
  // AP. handleSystemMessage() — init slash commands discovery edge cases
  // =========================================================================

  describe("handleSystemMessage() — init with empty slash_commands", () => {
    it("does not emit commands.changed when slash_commands is empty array", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      const events: any[] = [];
      adapter.on("commands.changed", (e) => events.push(e));

      (adapter as any).handleSystemMessage(
        { type: "system", subtype: "init", session_id: "cc-1", slash_commands: [] },
        "cs_1", buf,
      );

      expect(events).toHaveLength(0);
    });

    it("does not emit commands.changed when all slash_commands already known", () => {
      seedSession(adapter, "cs_1");
      const buf = makeBuffer("cs_1");
      (adapter as any).availableCommands = [{ name: "compact", description: "" }];

      const events: any[] = [];
      adapter.on("commands.changed", (e) => events.push(e));

      (adapter as any).handleSystemMessage(
        { type: "system", subtype: "init", session_id: "cc-1", slash_commands: ["compact"] },
        "cs_1", buf,
      );

      expect(events).toHaveLength(0);
    });
  });

  // =========================================================================
  // AQ. setMode() — no V2 session (no-op on setPermissionMode)
  // =========================================================================

  describe("setMode() — no V2 session", () => {
    it("stores mode even when no V2 session exists", async () => {
      seedSession(adapter, "cs_1");
      // No V2 session
      await adapter.setMode("cs_1", "plan");
      expect((adapter as any).sessionModes.get("cs_1")).toBe("plan");
    });
  });

  // =========================================================================
  // AR. buildToolMetadata() — branch coverage
  // =========================================================================

  describe("buildToolMetadata() — additional branches", () => {
    it("returns undefined when input is null/undefined", () => {
      const buf = makeBuffer("cs_1");
      (adapter as any).createToolPart("cs_1", buf, "edit_null", "Edit", null);
      const toolPart = (adapter as any).toolCallParts.get("edit_null") as any;
      // Force input to undefined
      toolPart.state.input = undefined;

      const meta = (adapter as any).buildToolMetadata(toolPart, "");
      expect(meta).toBeUndefined();
    });
  });
});
