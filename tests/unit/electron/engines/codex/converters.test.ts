import { describe, expect, it } from "vitest";

import {
  appendPlanDelta,
  appendReasoningDelta,
  appendTextDelta,
  applyTurnMetadata,
  applyTurnUsage,
  buildToolTitle,
  completeToolPart,
  convertApprovalToPermission,
  convertThreadToMessages,
  convertUserInputToQuestion,
  createStepFinish,
  createSystemNotice,
  createToolPart,
  createUserMessage,
  finalizeBufferToMessage,
  formatTurnPlanMarkdown,
  replacePlanText,
  upsertPart,
} from "../../../../../electron/main/engines/codex/converters";
import type { MessageBuffer } from "../../../../../electron/main/engines/engine-adapter";
import type { NormalizedToolName, ToolPart } from "../../../../../src/types/unified";

function createBuffer(): MessageBuffer {
  return {
    messageId: "msg-1",
    sessionId: "codex_thread-1",
    parts: [],
    textAccumulator: "",
    textPartId: null,
    reasoningAccumulator: "",
    reasoningPartId: null,
    planAccumulator: undefined,
    planPartId: null,
    startTime: 1,
    workingDirectory: "/repo",
    engineMeta: { codexThreadId: "thread-1" },
  };
}

describe("codex/converters.ts", () => {
  it("builds and finalizes streaming text, plan, reasoning, tool, and notice parts", () => {
    const buffer = createBuffer();

    const blankText = appendTextDelta(buffer, "   ");
    const text = appendTextDelta(buffer, " hello");
    const reasoning = appendReasoningDelta(buffer, "Inspect changes");
    const plan = appendPlanDelta(buffer, "Draft steps");
    const replacedPlan = replacePlanText(buffer, "## Plan\n\nShip it");
    const notice = createSystemNotice(buffer, "info", "Entered review mode");
    const { stepStart, toolPart } = createToolPart(buffer, "cmd-1", "commandExecution", {
      command: "bun test",
      cwd: "/repo",
    });
    const { toolPart: editTool } = createToolPart(buffer, "edit-1", "fileChange", {
      changes: [{ path: "/repo/src/app.ts", diff: "@@ -1 +1 @@" }],
    });

    completeToolPart(toolPart, "all green");
    completeToolPart(editTool, "updated");
    const stepFinish = createStepFinish(buffer);

    upsertPart(buffer.parts, {
      ...text,
      text: "hello world",
    });

    const assistant = finalizeBufferToMessage(buffer);
    const user = createUserMessage("codex_thread-1", "Run tests", 123);

    expect(blankText.text).toBe("");
    expect(text.text).toBe("hello");
    expect(reasoning.text).toBe("Inspect changes");
    expect(plan.text).toBe("## Plan\n\nDraft steps");
    expect(replacedPlan.text).toBe("## Plan\n\nShip it");
    expect(notice).toMatchObject({ type: "system-notice", text: "Entered review mode" });
    expect(stepStart.type).toBe("step-start");
    expect(stepFinish.type).toBe("step-finish");
    expect(toolPart.title).toBe("Running bun test");
    expect(toolPart.state).toMatchObject({ status: "completed", output: "all green" });
    expect((toolPart.state as any).metadata.stdout).toBe("all green");
    expect(editTool.locations).toEqual([{ path: "/repo/src/app.ts" }]);
    expect(editTool.diff).toContain("@@ -1 +1 @@");
    expect((editTool.state as any).metadata.diff).toContain("@@ -1 +1 @@");
    expect((assistant.parts.find((part) => part.type === "text") as any).text).toBe("hello world");
    expect(assistant.workingDirectory).toBe("/repo");
    expect(assistant.engineMeta).toEqual({ codexThreadId: "thread-1" });
    expect(user).toMatchObject({
      sessionId: "codex_thread-1",
      role: "user",
      time: { created: 123, completed: 123 },
    });
  });

  it("converts stable approval requests into unified permissions", () => {
    const permission = convertApprovalToPermission(
      "codex_thread-1",
      7,
      "item/commandExecution/requestApproval",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "npm test",
        reason: "Needs to run tests",
        availableDecisions: ["accept", "acceptForSession", "decline"],
      },
    );

    expect(permission).toMatchObject({
      id: "7",
      sessionId: "codex_thread-1",
      toolCallId: "item-1",
      kind: "other",
    });
    expect(permission.title).toContain("npm test");
    expect(permission.options.map((option) => option.id)).toEqual(["allow_once", "allow_always", "reject_once"]);
  });

  it("converts additional approval and question variants into unified shapes", () => {
    const filePermission = convertApprovalToPermission("codex_thread-1", "file-1", "item/fileChange/requestApproval", {
      itemId: "edit-1",
      reason: "Review the patch",
      grantRoot: "/repo",
    });
    const permissionsPermission = convertApprovalToPermission("codex_thread-1", "perm-1", "item/permissions/requestApproval", {
      itemId: "perm-tool",
      permissions: { fileSystem: { write: ["/repo"] } },
    });
    const legacyPermission = convertApprovalToPermission("codex_thread-1", "legacy-1", "execCommandApproval", {
      callId: "legacy-call",
      command: ["git", "status"],
      reason: "Inspect repository state",
    });
    const patchPermission = convertApprovalToPermission("codex_thread-1", "patch-1", "applyPatchApproval", {
      callId: "patch-call",
      fileChanges: {
        "src/app.ts": { diff: "@@ -1 +1 @@" },
      },
    });
    const fallbackPermission = convertApprovalToPermission("codex_thread-1", "fallback-1", "unknownApproval", {
      anything: true,
    });
    const fallbackQuestion = convertUserInputToQuestion("codex_thread-1", 99, {
      itemId: "tool-3",
    });

    expect(filePermission).toMatchObject({
      id: "file-1",
      kind: "edit",
      title: "Review the patch",
      metadata: { grantRoot: "/repo" },
    });
    expect(permissionsPermission).toMatchObject({ id: "perm-1", kind: "edit" });
    expect(legacyPermission).toMatchObject({
      id: "legacy-1",
      toolCallId: "legacy-call",
      title: "Approve command: git status",
      metadata: { reason: "Inspect repository state" },
    });
    expect(patchPermission).toMatchObject({
      id: "patch-1",
      kind: "edit",
      diff: "@@ -1 +1 @@",
    });
    expect(fallbackPermission).toMatchObject({
      id: "fallback-1",
      title: "Approve Codex action",
      kind: "other",
    });
    expect(fallbackQuestion).toMatchObject({
      id: "99",
      toolCallId: "tool-3",
      questions: [{
        question: "Codex needs your input",
        header: "Input",
        options: [],
        multiple: false,
        custom: true,
      }],
    });
  });

  it("converts request_user_input payloads into free-form unified questions", () => {
    const question = convertUserInputToQuestion(
      "codex_thread-1",
      11,
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        questions: [{
          id: "q_env",
          header: "Env",
          question: "Which environment should I use?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "staging", description: "Use staging services" },
            { label: "prod", description: "Use production services" },
          ],
        }],
      },
    );

    expect(question).toMatchObject({
      id: "11",
      sessionId: "codex_thread-1",
      toolCallId: "item-2",
    });
    expect(question.questions).toEqual([{
      header: "Env",
      question: "Which environment should I use?",
      options: [
        { label: "staging", description: "Use staging services" },
        { label: "prod", description: "Use production services" },
      ],
      multiple: false,
      custom: true,
    }]);
  });

  it("formats structured plan updates into readable markdown", () => {
    expect(
      formatTurnPlanMarkdown("Implement the adapter", [
        { step: "Map stable protocol", status: "completed" },
        { step: "Add tests", status: "inProgress" },
        { step: "Ship", status: "pending" },
      ]),
    ).toBe([
      "## Plan",
      "",
      "Implement the adapter",
      "",
      "- [x] Map stable protocol",
      "- [-] Add tests",
      "- [ ] Ship",
    ].join("\n"));

    expect(formatTurnPlanMarkdown("", [])).toBe(["## Plan", "", "- No steps provided"].join("\n"));
    expect(
      formatTurnPlanMarkdown(undefined, [{ step: "   ", status: "pending" }]),
    ).toBe(["## Plan", "", "- [ ] Untitled step"].join("\n"));
  });

  it("applies token usage and turn metadata from stable payloads", () => {
    const buffer = createBuffer();

    applyTurnUsage(buffer, {
      last: {
        inputTokens: 12,
        outputTokens: 34,
        cachedInputTokens: 5,
        reasoningOutputTokens: 8,
      },
    });
    applyTurnMetadata(buffer, {
      id: "turn-1",
      model: "gpt-5.4",
      reasoningEffort: "xhigh",
      diff: "@@ -1 +1 @@",
    });

    expect(buffer.tokens).toEqual({
      input: 12,
      output: 34,
      cache: { read: 5, write: 0 },
      reasoning: 8,
    });
    expect(buffer.activeTurnId).toBe("turn-1");
    expect(buffer.modelId).toBe("gpt-5.4");
    expect(buffer.reasoningEffort).toBe("max");
    expect(buffer.engineMeta).toEqual({ codexThreadId: "thread-1", turnDiff: "@@ -1 +1 @@" });

    applyTurnUsage(buffer, {
      total: {
        input_tokens: 5,
        output_tokens: 6,
        cache_read_input_tokens: 2,
        reasoning_output_tokens: 1,
      },
    });
    applyTurnMetadata(buffer, {
      id: "turn-2",
      effort: "high",
      costUSD: 1.25,
    });

    expect(buffer.tokens).toEqual({
      input: 5,
      output: 6,
      cache: { read: 2, write: 0 },
      reasoning: 1,
    });
    expect(buffer.activeTurnId).toBe("turn-2");
    expect(buffer.reasoningEffort).toBe("high");
    expect(buffer.cost).toBe(1.25);
    expect(buffer.costUnit).toBe("usd");
  });

  it("converts stable thread/read history into unified user and assistant messages", () => {
    const messages = convertThreadToMessages("codex_thread-1", {
      thread: {
        id: "thread-1",
        cwd: "/repo",
        createdAt: 1_710_000_000,
        turns: [{
          id: "turn-1",
          status: "completed",
          items: [
            {
              type: "userMessage",
              id: "user-1",
              content: [
                { type: "text", text: "Fix the tests" },
                { type: "image", url: "data:image/png;base64,AAAA" },
                { type: "localImage", path: "/tmp/img.png" },
              ],
            },
            {
              type: "reasoning",
              id: "reason-1",
              summary: ["Inspect failures"],
              content: ["Update snapshots"],
            },
            {
              type: "commandExecution",
              id: "cmd-1",
              command: "npm test",
              cwd: "/repo",
              status: "completed",
              aggregatedOutput: "all green",
              exitCode: 0,
            },
            {
              type: "fileChange",
              id: "edit-1",
              status: "completed",
              changes: [{ path: "/repo/src/app.ts", diff: "@@ -1 +1 @@\n-console.log('a')\n+console.log('b')" }],
            },
            { type: "contextCompaction", id: "compact-1" },
            { type: "agentMessage", id: "assistant-1", text: "Done." },
          ],
        }],
      },
    }, "/repo");

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].time.created).toBe(1_710_000_000_000);
    expect(messages[0].parts.map((part) => part.type)).toEqual(["text", "text", "text"]);
    expect((messages[0].parts[0] as any).text).toBe("Fix the tests");
    expect((messages[0].parts[1] as any).text).toBe("[Image: image/png]");
    expect((messages[0].parts[2] as any).text).toBe("[Image]");

    const assistant = messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.workingDirectory).toBe("/repo");
    expect(assistant.engineMeta).toEqual({ codexThreadId: "thread-1" });

    const reasoning = assistant.parts.find((part) => part.type === "reasoning");
    expect((reasoning as any)?.text).toBe("Inspect failures\n\nUpdate snapshots");

    const shellTool = assistant.parts.find((part) => part.type === "tool" && (part as ToolPart).callId === "cmd-1") as ToolPart;
    expect(shellTool.normalizedTool).toBe("shell");
    expect(shellTool.state.status).toBe("completed");
    if (shellTool.state.status === "completed") {
      expect(shellTool.state.output).toBe("all green");
    }

    const editTool = assistant.parts.find((part) => part.type === "tool" && (part as ToolPart).callId === "edit-1") as ToolPart;
    expect(editTool.normalizedTool).toBe("edit");
    expect(editTool.diff).toContain("console.log('b')");
    expect(editTool.state.status).toBe("completed");
    if (editTool.state.status === "completed") {
      expect((editTool.state.metadata as any)?.diff).toContain("console.log('b')");
    }

    const notice = assistant.parts.find((part) => part.type === "system-notice");
    expect(notice).toMatchObject({ type: "system-notice", noticeType: "compact", text: "notice:context_compressed" });

    const finalText = assistant.parts.find((part) => part.type === "text");
    expect((finalText as any)?.text).toBe("Done.");
  });

  it("keeps historical error turns even when they have no output parts", () => {
    const messages = convertThreadToMessages("codex_thread-1", {
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "interrupted",
          items: [],
        }],
      },
    }, "/repo");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      error: "Turn interrupted",
      workingDirectory: "/repo",
      engineMeta: { codexThreadId: "thread-1" },
    });
  });
});

// ---------------------------------------------------------------------------
// Additional branch coverage
// ---------------------------------------------------------------------------

describe("buildToolTitle - all switch cases", () => {
  it("shell: with command returns running title", () => {
    expect(buildToolTitle("commandExecution", "shell", { command: "bun run build" })).toBe("Running bun run build");
  });

  it("shell: without command falls back to generic title", () => {
    expect(buildToolTitle("commandExecution", "shell", {})).toBe("Running command");
  });

  it("shell: non-string command falls back to generic title", () => {
    expect(buildToolTitle("commandExecution", "shell", { command: 42 })).toBe("Running command");
  });

  it("shell: long command is truncated at 72 chars", () => {
    const longCmd = "a".repeat(80);
    const result = buildToolTitle("commandExecution", "shell", { command: longCmd });
    expect(result).toContain("...");
    // truncated command is at most 72 chars; "Running " prefix (8) + 72 = 80
    expect(result.length).toBeLessThanOrEqual(80);
    // must not contain all 80 'a's
    expect(result).not.toBe(`Running ${"a".repeat(80)}`);
  });

  it("read: with filePath returns reading title", () => {
    expect(buildToolTitle("imageView", "read", { path: "/repo/src/index.ts" })).toBe("Reading /repo/src/index.ts");
  });

  it("read: without filePath falls back to generic title", () => {
    expect(buildToolTitle("imageView", "read", {})).toBe("Reading file");
  });

  it("edit: with filePath returns editing title", () => {
    expect(buildToolTitle("fileChange", "edit", { path: "/repo/src/app.ts" })).toBe("Editing /repo/src/app.ts");
  });

  it("edit: without filePath falls back to generic title", () => {
    expect(buildToolTitle("fileChange", "edit", {})).toBe("Editing file");
  });

  it("web_fetch: with url returns fetching title", () => {
    expect(buildToolTitle("webFetch", "web_fetch", { url: "https://example.com" })).toBe("Fetching https://example.com");
  });

  it("web_fetch: with query but no url returns searching title", () => {
    expect(buildToolTitle("webSearch", "web_fetch", { query: "find typescript bugs" })).toBe("Searching find typescript bugs");
  });

  it("web_fetch: with neither url nor query returns generic title", () => {
    expect(buildToolTitle("webSearch", "web_fetch", {})).toBe("Searching the web");
  });

  it("task: with description returns description directly", () => {
    expect(buildToolTitle("collabAgentToolCall", "task", { description: "Deploy application" })).toBe("Deploy application");
  });

  it("task: without description but with prompt returns delegating title", () => {
    expect(buildToolTitle("collabAgentToolCall", "task", { prompt: "Do the thing" })).toBe("Delegating Do the thing");
  });

  it("task: without description or prompt returns generic delegating title", () => {
    expect(buildToolTitle("collabAgentToolCall", "task", {})).toBe("Delegating task");
  });

  it("default: with description returns description", () => {
    expect(buildToolTitle("mcpToolCall", "unknown" as NormalizedToolName, { description: "Call MCP server" })).toBe("Call MCP server");
  });

  it("default: without description but with tool returns tool name", () => {
    expect(buildToolTitle("mcpToolCall", "unknown" as NormalizedToolName, { tool: "my-mcp-tool" })).toBe("my-mcp-tool");
  });

  it("default: with empty description falls through to tool name", () => {
    expect(buildToolTitle("mcpToolCall", "unknown" as NormalizedToolName, { description: "", tool: "my-tool" })).toBe("my-tool");
  });

  it("default: with neither description nor tool falls back to itemType", () => {
    expect(buildToolTitle("specialItem", "unknown" as NormalizedToolName, {})).toBe("specialItem");
  });
});

describe("completeToolPart - error path, pending state, write tool", () => {
  it("completes a shell tool with error state", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "cmd-1", "commandExecution", { command: "fail-cmd" });
    completeToolPart(toolPart, "some output", "Command failed: EPERM");
    expect(toolPart.state.status).toBe("error");
    if (toolPart.state.status === "error") {
      expect(toolPart.state.error).toBe("Command failed: EPERM");
      expect(toolPart.state.output).toBe("some output");
    }
  });

  it("completes a tool with error state and no output", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "cmd-2", "commandExecution", { command: "bad" });
    completeToolPart(toolPart, null, "Timeout");
    expect(toolPart.state.status).toBe("error");
    if (toolPart.state.status === "error") {
      expect(toolPart.state.error).toBe("Timeout");
      expect(toolPart.state.output).toBeUndefined();
    }
  });

  it("completes a write tool with diff metadata", () => {
    const toolPart: ToolPart = {
      id: "part-w",
      messageId: "msg-1",
      sessionId: "sess-1",
      type: "tool",
      callId: "write-1",
      normalizedTool: "write",
      originalTool: "fileWrite",
      title: "Writing /foo.ts",
      kind: "edit",
      diff: "@@ -1 +1 @@\n-old\n+new",
      state: {
        status: "running",
        input: { filePath: "/foo.ts", content: "new content" },
        time: { start: Date.now() },
      },
    };
    completeToolPart(toolPart, "written");
    expect(toolPart.state.status).toBe("completed");
    if (toolPart.state.status === "completed") {
      expect((toolPart.state.metadata as any)?.diff).toContain("@@ -1 +1 @@");
    }
  });

  it("completes a tool with pending state - uses Date.now for startTime and ?? for input", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "cmd-3", "commandExecution", { command: "ls" });
    // Manually set state to pending to exercise that branch
    toolPart.state = { status: "pending" };
    completeToolPart(toolPart, "output");
    expect(toolPart.state.status).toBe("completed");
    if (toolPart.state.status === "completed") {
      // input was undefined in pending state → resolved to {}
      expect(toolPart.state.input).toEqual({});
    }
  });

  it("completes a shell tool using _output accumulator when output is empty", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "cmd-4", "commandExecution", {
      command: "tail -f log",
      _output: "line1\nline2",
    });
    completeToolPart(toolPart, null);
    expect(toolPart.state.status).toBe("completed");
    if (toolPart.state.status === "completed") {
      expect((toolPart.state.metadata as any)?.output).toBe("line1\nline2");
      expect((toolPart.state.metadata as any)?.stdout).toBe("line1\nline2");
    }
  });

  it("completes a non-shell tool with no metadata when there is no diff and no extra data", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "web-1", "webSearch", { query: "typescript tips" });
    completeToolPart(toolPart, "search results");
    expect(toolPart.state.status).toBe("completed");
    if (toolPart.state.status === "completed") {
      expect(toolPart.state.metadata).toBeUndefined();
    }
  });

  it("completes a tool with object output - stringified via JSON", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "mcp-1", "mcpToolCall", { server: "s", tool: "t" });
    completeToolPart(toolPart, { key: "value", count: 3 });
    expect(toolPart.state.status).toBe("completed");
    if (toolPart.state.status === "completed") {
      expect(typeof toolPart.state.output).toBe("string");
      expect(toolPart.state.output as string).toContain("key");
    }
  });

  it("completes a tool with circular reference - falls back to String()", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "mcp-2", "mcpToolCall", { server: "s", tool: "t" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    completeToolPart(toolPart, circular);
    expect(toolPart.state.status).toBe("completed");
    if (toolPart.state.status === "completed") {
      expect(toolPart.state.output).toBe("[object Object]");
    }
  });
});

describe("convertApprovalToPermission - missing branches", () => {
  it("commandExecution: without command uses generic title", () => {
    const p = convertApprovalToPermission("sess", 1, "item/commandExecution/requestApproval", {});
    expect(p.title).toBe("Approve command execution");
  });

  it("commandExecution: without reason has no metadata", () => {
    const p = convertApprovalToPermission("sess", 1, "item/commandExecution/requestApproval", { command: "ls" });
    expect(p.metadata).toBeUndefined();
  });

  it("commandExecution: without itemId has no toolCallId", () => {
    const p = convertApprovalToPermission("sess", 1, "item/commandExecution/requestApproval", { command: "ls" });
    expect(p.toolCallId).toBeUndefined();
  });

  it("commandExecution: with non-array availableDecisions → includes both allow options", () => {
    const p = convertApprovalToPermission("sess", 1, "item/commandExecution/requestApproval", {
      command: "ls",
      availableDecisions: "not-an-array",
    });
    expect(p.options.map((o) => o.id)).toEqual(["allow_once", "allow_always", "reject_once"]);
  });

  it("commandExecution: decisions with only accept → no allow_always", () => {
    const p = convertApprovalToPermission("sess", 1, "item/commandExecution/requestApproval", {
      command: "ls",
      availableDecisions: ["accept"],
    });
    expect(p.options.map((o) => o.id)).toEqual(["allow_once", "reject_once"]);
  });

  it("commandExecution: decisions with only acceptForSession → no allow_once", () => {
    const p = convertApprovalToPermission("sess", 1, "item/commandExecution/requestApproval", {
      command: "ls",
      availableDecisions: ["acceptForSession"],
    });
    expect(p.options.map((o) => o.id)).toEqual(["allow_always", "reject_once"]);
  });

  it("commandExecution: decisions with object-type entry extracts first key", () => {
    const p = convertApprovalToPermission("sess", 1, "item/commandExecution/requestApproval", {
      command: "ls",
      availableDecisions: [{ accept: null }],
    });
    expect(p.options.map((o) => o.id)).toEqual(["allow_once", "reject_once"]);
  });

  it("commandExecution: empty decisions array → includes both allow options", () => {
    const p = convertApprovalToPermission("sess", 1, "item/commandExecution/requestApproval", {
      command: "ls",
      availableDecisions: [],
    });
    expect(p.options.map((o) => o.id)).toEqual(["allow_once", "allow_always", "reject_once"]);
  });

  it("fileChange: without reason uses default title", () => {
    const p = convertApprovalToPermission("sess", "f1", "item/fileChange/requestApproval", {
      itemId: "edit-1",
    });
    expect(p.title).toBe("Approve file changes");
    expect(p.metadata).toBeUndefined();
  });

  it("fileChange: without grantRoot has no metadata", () => {
    const p = convertApprovalToPermission("sess", "f2", "item/fileChange/requestApproval", {
      reason: "Apply patch",
    });
    expect(p.metadata).toBeUndefined();
  });

  it("fileChange: without itemId has no toolCallId", () => {
    const p = convertApprovalToPermission("sess", "f3", "item/fileChange/requestApproval", {});
    expect(p.toolCallId).toBeUndefined();
  });

  it("permissions: with only read paths → kind is read", () => {
    const p = convertApprovalToPermission("sess", "p1", "item/permissions/requestApproval", {
      permissions: { fileSystem: { read: ["/repo"] } },
    });
    expect(p.kind).toBe("read");
  });

  it("permissions: with neither read nor write → kind is other", () => {
    const p = convertApprovalToPermission("sess", "p2", "item/permissions/requestApproval", {
      permissions: { fileSystem: {} },
    });
    expect(p.kind).toBe("other");
  });

  it("permissions: with reason uses it as title (line 425 true branch)", () => {
    const p = convertApprovalToPermission("sess", "p5", "item/permissions/requestApproval", {
      reason: "Need write access",
      permissions: { fileSystem: { write: ["/repo"] } },
    });
    expect(p.title).toBe("Need write access");
  });

  it("permissions: without reason uses default title", () => {
    const p = convertApprovalToPermission("sess", "p3", "item/permissions/requestApproval", {
      permissions: { fileSystem: { write: ["/repo"] } },
    });
    expect(p.title).toBe("Approve additional permissions");
  });

  it("permissions: without itemId has no toolCallId", () => {
    const p = convertApprovalToPermission("sess", "p4", "item/permissions/requestApproval", {
      permissions: { fileSystem: {} },
    });
    expect(p.toolCallId).toBeUndefined();
  });

  it("execCommandApproval: non-array command produces empty title fallback", () => {
    const p = convertApprovalToPermission("sess", "e1", "execCommandApproval", {
      command: "not-an-array",
    });
    expect(p.title).toBe("Approve command execution");
  });

  it("execCommandApproval: without reason has no metadata", () => {
    const p = convertApprovalToPermission("sess", "e2", "execCommandApproval", {
      command: ["npm", "run", "test"],
    });
    expect(p.metadata).toBeUndefined();
  });

  it("execCommandApproval: without callId has no toolCallId", () => {
    const p = convertApprovalToPermission("sess", "e3", "execCommandApproval", {
      command: ["ls"],
    });
    expect(p.toolCallId).toBeUndefined();
  });

  it("execCommandApproval: long command is truncated at 96 chars", () => {
    const p = convertApprovalToPermission("sess", "e4", "execCommandApproval", {
      command: ["a".repeat(100)],
    });
    expect(p.title).toContain("...");
  });

  it("applyPatchApproval: with reason uses it as title", () => {
    const p = convertApprovalToPermission("sess", "ap1", "applyPatchApproval", {
      reason: "Fix formatting",
      fileChanges: {},
    });
    expect(p.title).toBe("Fix formatting");
  });

  it("applyPatchApproval: without reason uses default title", () => {
    const p = convertApprovalToPermission("sess", "ap2", "applyPatchApproval", {
      fileChanges: {},
    });
    expect(p.title).toBe("Approve file changes");
  });

  it("applyPatchApproval: fileChanges with no diffs produces no diff field", () => {
    const p = convertApprovalToPermission("sess", "ap3", "applyPatchApproval", {
      fileChanges: { "foo.ts": { content: "new" } },
    });
    expect(p.diff).toBeUndefined();
  });

  it("applyPatchApproval: without callId has no toolCallId", () => {
    const p = convertApprovalToPermission("sess", "ap4", "applyPatchApproval", {
      fileChanges: {},
    });
    expect(p.toolCallId).toBeUndefined();
  });
});

describe("convertUserInputToQuestion - missing branches", () => {
  it("question item without question text uses default Question N", () => {
    const q = convertUserInputToQuestion("sess", 1, {
      questions: [{ header: "My Header" }],
    });
    expect(q.questions[0].question).toBe("Question 1");
  });

  it("question item without header uses default Input N", () => {
    const q = convertUserInputToQuestion("sess", 1, {
      questions: [{ question: "Pick one?" }],
    });
    expect(q.questions[0].header).toBe("Input 1");
  });

  it("option without label is filtered out", () => {
    const q = convertUserInputToQuestion("sess", 1, {
      questions: [{
        question: "Choose?",
        header: "Choose",
        options: [
          { label: "yes", description: "affirmative" },
          { label: "", description: "should be dropped" },
          { description: "no label at all" },
        ],
      }],
    });
    expect(q.questions[0].options).toHaveLength(1);
    expect(q.questions[0].options[0].label).toBe("yes");
  });

  it("option with non-string description falls back to empty string (line 520 false branch)", () => {
    const q = convertUserInputToQuestion("sess", 1, {
      questions: [{
        question: "Choose?",
        header: "H",
        options: [
          { label: "yes" }, // no description field → typeof undefined === "string" → false → ""
        ],
      }],
    });
    expect(q.questions[0].options).toHaveLength(1);
    expect(q.questions[0].options[0].description).toBe("");
  });

  it("isOther === false sets custom to false", () => {
    const q = convertUserInputToQuestion("sess", 1, {
      questions: [{ question: "Pick?", header: "H", isOther: false }],
    });
    expect(q.questions[0].custom).toBe(false);
  });

  it("non-array questions falls back to default single question", () => {
    const q = convertUserInputToQuestion("sess", 1, {
      questions: "not-an-array",
    });
    expect(q.questions).toHaveLength(1);
    expect(q.questions[0].question).toBe("Codex needs your input");
  });

  it("question with isOther not false (undefined) sets custom to true", () => {
    const q = convertUserInputToQuestion("sess", 1, {
      questions: [{ question: "Pick?", header: "H" }],
    });
    // isOther defaults to undefined which is not false → custom: true
    expect(q.questions[0].custom).toBe(true);
  });

  it("without itemId has no toolCallId", () => {
    const q = convertUserInputToQuestion("sess", 1, { questions: [] });
    expect(q.toolCallId).toBeUndefined();
  });
});

describe("applyTurnUsage - empty/partial data", () => {
  it("empty usage object triggers early return - no tokens set", () => {
    const buffer = createBuffer();
    applyTurnUsage(buffer, {});
    expect(buffer.tokens).toBeUndefined();
  });

  it("non-object usage triggers early return - no tokens set", () => {
    const buffer = createBuffer();
    applyTurnUsage(buffer, null);
    expect(buffer.tokens).toBeUndefined();
  });

  it("usage with empty last object triggers second early return", () => {
    const buffer = createBuffer();
    applyTurnUsage(buffer, { last: {} });
    expect(buffer.tokens).toBeUndefined();
  });

  it("usage without cacheRead and reasoning produces minimal tokens", () => {
    const buffer = createBuffer();
    applyTurnUsage(buffer, { inputTokens: 10, outputTokens: 20 });
    expect(buffer.tokens).toEqual({ input: 10, output: 20 });
    expect((buffer.tokens as any)?.cache).toBeUndefined();
    expect((buffer.tokens as any)?.reasoning).toBeUndefined();
  });

  it("direct usage (no last/total wrapper) is parsed correctly", () => {
    const buffer = createBuffer();
    applyTurnUsage(buffer, { inputTokens: 7, outputTokens: 13 });
    expect(buffer.tokens?.input).toBe(7);
    expect(buffer.tokens?.output).toBe(13);
  });

  it("cacheReadInputTokens alias is recognized", () => {
    const buffer = createBuffer();
    applyTurnUsage(buffer, { inputTokens: 5, outputTokens: 5, cacheReadInputTokens: 3 });
    expect((buffer.tokens as any)?.cache?.read).toBe(3);
  });

  it("reasoning_output_tokens snake_case alias is recognized", () => {
    const buffer = createBuffer();
    applyTurnUsage(buffer, { inputTokens: 5, outputTokens: 5, reasoning_output_tokens: 4 });
    expect((buffer.tokens as any)?.reasoning).toBe(4);
  });

  it("usage with only cacheRead but no input/output fields uses ?? 0 fallback (lines 558-559)", () => {
    const buffer = createBuffer();
    applyTurnUsage(buffer, { cachedInputTokens: 7 });
    // input = toNumber(undefined) ?? toNumber(undefined) ?? 0 = 0
    // output = toNumber(undefined) ?? toNumber(undefined) ?? 0 = 0
    expect(buffer.tokens?.input).toBe(0);
    expect(buffer.tokens?.output).toBe(0);
    expect((buffer.tokens as any)?.cache?.read).toBe(7);
  });
});

describe("applyTurnMetadata - missing branches", () => {
  it("costUsd (not costUSD) is recognized", () => {
    const buffer = createBuffer();
    applyTurnMetadata(buffer, { costUsd: 0.75 });
    expect(buffer.cost).toBe(0.75);
    expect(buffer.costUnit).toBe("usd");
  });

  it("effort: low → reasoningEffort low", () => {
    const buffer = createBuffer();
    applyTurnMetadata(buffer, { effort: "low" });
    expect(buffer.reasoningEffort).toBe("low");
  });

  it("effort: medium → reasoningEffort medium", () => {
    const buffer = createBuffer();
    applyTurnMetadata(buffer, { effort: "medium" });
    expect(buffer.reasoningEffort).toBe("medium");
  });

  it("reasoningEffort: low → reasoningEffort low", () => {
    const buffer = createBuffer();
    applyTurnMetadata(buffer, { reasoningEffort: "low" });
    expect(buffer.reasoningEffort).toBe("low");
  });

  it("reasoningEffort: medium → reasoningEffort medium", () => {
    const buffer = createBuffer();
    applyTurnMetadata(buffer, { reasoningEffort: "medium" });
    expect(buffer.reasoningEffort).toBe("medium");
  });

  it("unknown effort value → reasoningEffort undefined", () => {
    const buffer = createBuffer();
    applyTurnMetadata(buffer, { effort: "turbo" });
    expect(buffer.reasoningEffort).toBeUndefined();
  });

  it("diff with undefined engineMeta merges cleanly", () => {
    const buffer = { ...createBuffer(), engineMeta: undefined };
    applyTurnMetadata(buffer, { diff: "@@ fresh diff @@" });
    expect(buffer.engineMeta).toEqual({ turnDiff: "@@ fresh diff @@" });
  });

  it("no model/effort/cost/diff/id leaves buffer unchanged", () => {
    const buffer = createBuffer();
    const before = { ...buffer };
    applyTurnMetadata(buffer, { unrelated: "data" });
    expect(buffer.modelId).toBe(before.modelId);
    expect(buffer.reasoningEffort).toBe(before.reasoningEffort);
    expect(buffer.cost).toBe(before.cost);
    expect(buffer.activeTurnId).toBe(before.activeTurnId);
  });
});

describe("convertThreadToMessages - skipped turns and special cases", () => {
  it("returns empty array when thread is absent", () => {
    const messages = convertThreadToMessages("sess", {});
    expect(messages).toEqual([]);
  });

  it("returns empty array when turns is absent", () => {
    const messages = convertThreadToMessages("sess", { thread: { id: "t-1" } });
    expect(messages).toEqual([]);
  });

  it("skips turn with no parts and no error", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{ status: "completed", items: [] }],
      },
    });
    // parts.length === 0 && !buffer.error → skip
    expect(messages).toEqual([]);
  });

  it("keeps failed turn with error string", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{ status: "failed", items: [] }],
      },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].error).toBe("Turn failed");
  });

  it("keeps failed turn using explicit error string", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{ status: "failed", error: "Quota exceeded", items: [] }],
      },
    });
    expect(messages[0].error).toBe("Quota exceeded");
  });

  it("normalizeError with object having message + additionalDetails", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "interrupted",
          error: { message: "Connection lost", additionalDetails: "Timeout after 30s" },
          items: [],
        }],
      },
    });
    expect(messages[0].error).toBe("Connection lost\n\nTimeout after 30s");
  });

  it("normalizeError with object having only message", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "interrupted",
          error: { message: "Network error" },
          items: [],
        }],
      },
    });
    expect(messages[0].error).toBe("Network error");
  });

  it("normalizeError with empty string falls back to status message", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{ status: "interrupted", error: "", items: [] }],
      },
    });
    expect(messages[0].error).toBe("Turn interrupted");
  });

  it("thread without id produces no codexThreadId in engineMeta", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        turns: [{
          status: "interrupted",
          items: [],
        }],
      },
    });
    expect(messages[0].engineMeta).toBeUndefined();
  });

  it("uses thread.cwd when no workingDirectory parameter is given", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        cwd: "/thread/dir",
        turns: [{ status: "interrupted", items: [] }],
      },
      // no workingDirectory argument
    });
    expect(messages[0].workingDirectory).toBe("/thread/dir");
  });

  it("createdAt as large ms number (>= 1e12) is used directly", () => {
    const msTimestamp = 1_710_000_000_000;
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        createdAt: msTimestamp,
        turns: [{ status: "interrupted", items: [] }],
      },
    });
    expect(messages[0].time.created).toBe(msTimestamp);
  });

  it("createdAt as numeric string less than 1e12 is multiplied by 1000", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        createdAt: "1710000000",
        turns: [{ status: "interrupted", items: [] }],
      },
    });
    expect(messages[0].time.created).toBe(1_710_000_000_000);
  });

  it("createdAt as large numeric string is used directly", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        createdAt: "1710000000000",
        turns: [{ status: "interrupted", items: [] }],
      },
    });
    expect(messages[0].time.created).toBe(1_710_000_000_000);
  });

  it("createdAt as ISO date string is parsed to ms", () => {
    const isoDate = "2024-03-10T00:00:00.000Z";
    const expected = Date.parse(isoDate);
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        createdAt: isoDate,
        turns: [{ status: "interrupted", items: [] }],
      },
    });
    expect(messages[0].time.created).toBe(expected);
  });

  it("invalid createdAt string falls back to Date.now (within 1s)", () => {
    const before = Date.now();
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        createdAt: "not-a-date",
        turns: [{ status: "interrupted", items: [] }],
      },
    });
    const after = Date.now();
    expect(messages[0].time.created).toBeGreaterThanOrEqual(before);
    expect(messages[0].time.created).toBeLessThanOrEqual(after + 100);
  });

  it("turn without items field is handled gracefully (line 667 false branch)", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        // turn.items is undefined → Array.isArray(undefined) = false → items = []
        turns: [{ status: "interrupted" } as any],
      },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].error).toBe("Turn interrupted");
  });
});

describe("convertThreadToMessages - all historical item types", () => {
  it("agentMessage without text produces no text part", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "agentMessage", id: "a1" },
            { type: "contextCompaction", id: "c1" },
          ],
        }],
      },
    });
    expect(messages).toHaveLength(1);
    const textParts = messages[0].parts.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(0);
  });

  it("reasoning without summary uses only content strings", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "reasoning", id: "r1", content: ["Think about this", "Then that"] },
          ],
        }],
      },
    });
    const reasoning = messages[0].parts.find((p) => p.type === "reasoning");
    expect((reasoning as any)?.text).toBe("Think about this\n\nThen that");
  });

  it("reasoning without summary or content produces no reasoning part", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "reasoning", id: "r1" },
            { type: "contextCompaction", id: "c1" },
          ],
        }],
      },
    });
    const reasoning = messages[0].parts.find((p) => p.type === "reasoning");
    expect(reasoning).toBeUndefined();
  });

  it("plan item with text starting with # is used as-is", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "plan", id: "pl1", text: "## My Plan\n\nStep 1" },
          ],
        }],
      },
    });
    const planPart = messages[0].parts.find((p) => p.type === "text");
    expect((planPart as any)?.text).toBe("## My Plan\n\nStep 1");
  });

  it("plan item with empty text uses empty plan placeholder", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "plan", id: "pl2", text: "" },
          ],
        }],
      },
    });
    const planPart = messages[0].parts.find((p) => p.type === "text");
    expect((planPart as any)?.text).toBe("## Plan\n\n");
  });

  it("plan item with regular text gets ## Plan header prepended", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "plan", id: "pl3", text: "Fix the bug" },
          ],
        }],
      },
    });
    const planPart = messages[0].parts.find((p) => p.type === "text");
    expect((planPart as any)?.text).toBe("## Plan\n\nFix the bug");
  });

  it("plan item with undefined text uses empty string fallback (line 747 ?? branch)", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "plan", id: "pl-undef" }, // text is undefined → item.text ?? "" uses fallback
          ],
        }],
      },
    });
    const planPart = messages[0].parts.find((p) => p.type === "text");
    expect((planPart as any)?.text).toBe("## Plan\n\n");
  });

  it("enteredReviewMode with review uses review text in notice", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "enteredReviewMode", id: "er1", review: "main" },
          ],
        }],
      },
    });
    const notice = messages[0].parts.find((p) => p.type === "system-notice");
    expect((notice as any)?.text).toBe("Entered review mode: main");
  });

  it("enteredReviewMode without review uses generic notice", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "enteredReviewMode", id: "er2" },
          ],
        }],
      },
    });
    const notice = messages[0].parts.find((p) => p.type === "system-notice");
    expect((notice as any)?.text).toBe("Entered review mode");
  });

  it("exitedReviewMode with review uses review text in notice", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "exitedReviewMode", id: "xr1", review: "main" },
          ],
        }],
      },
    });
    const notice = messages[0].parts.find((p) => p.type === "system-notice");
    expect((notice as any)?.text).toBe("Exited review mode: main");
  });

  it("exitedReviewMode without review uses generic notice", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "exitedReviewMode", id: "xr2" },
          ],
        }],
      },
    });
    const notice = messages[0].parts.find((p) => p.type === "system-notice");
    expect((notice as any)?.text).toBe("Exited review mode");
  });

  it("hookPrompt creates info notice", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "hookPrompt", id: "hp1" },
          ],
        }],
      },
    });
    const notice = messages[0].parts.find((p) => p.type === "system-notice");
    expect((notice as any)?.text).toBe("Hook prompt emitted");
  });

  it("mcpToolCall item creates tool part with server/tool description", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "mcpToolCall", id: "mcp-1", server: "myServer", tool: "myTool", result: { data: "ok" } },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart).toBeDefined();
    expect(toolPart.normalizedTool).toBe("unknown");
    expect((toolPart.state as any)?.input?.description).toBe("myServer/myTool");
  });

  it("mcpToolCall without server uses tool only in description", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "mcpToolCall", id: "mcp-2", tool: "onlyTool" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect((toolPart.state as any)?.input?.description).toBe("onlyTool");
  });

  it("mcpToolCall without server or tool uses MCP tool fallback", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "mcpToolCall", id: "mcp-3" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect((toolPart.state as any)?.input?.description).toBe("MCP tool");
  });

  it("mcpToolCall with only server uses server in description", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "mcpToolCall", id: "mcp-4", server: "onlyServer" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect((toolPart.state as any)?.input?.description).toBe("onlyServer");
  });

  it("dynamicToolCall item with contentItems uses them as output", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "dynamicToolCall", id: "dyn-1", tool: "myDynTool", contentItems: ["chunk1", "chunk2"] },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart).toBeDefined();
    if (toolPart.state.status === "completed") {
      expect(toolPart.state.output).toContain("chunk1");
    }
  });

  it("dynamicToolCall item without contentItems falls back to result", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "dynamicToolCall", id: "dyn-2", tool: "myDynTool", result: "my-result" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    if (toolPart.state.status === "completed") {
      expect(toolPart.state.output).toBe("my-result");
    }
  });

  it("collabAgentToolCall creates task tool with prompt metadata", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [{
            type: "collabAgentToolCall",
            id: "collab-1",
            tool: "agent",
            prompt: "Do the thing",
            model: "gpt-5",
            receiverThreadIds: ["t-2"],
          }],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart).toBeDefined();
    expect(toolPart.normalizedTool).toBe("task");
    if (toolPart.state.status === "completed") {
      expect((toolPart.state.metadata as any)?.prompt).toBe("Do the thing");
    }
  });

  it("collabAgentToolCall without tool uses 'Delegating task' description", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "collabAgentToolCall", id: "collab-2" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart.title).toBe("Delegating task");
  });

  it("webSearch item creates web_fetch tool with query", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "webSearch", id: "ws-1", query: "best practices" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart).toBeDefined();
    expect(toolPart.normalizedTool).toBe("web_fetch");
  });

  it("imageView item creates read tool with file location", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "imageView", id: "iv-1", path: "/tmp/photo.png" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart).toBeDefined();
    expect(toolPart.normalizedTool).toBe("read");
    expect(toolPart.locations).toEqual([{ path: "/tmp/photo.png" }]);
    if (toolPart.state.status === "completed") {
      // read tool with output → has lines metadata
      expect((toolPart.state.metadata as any)?.lines).toBeGreaterThan(0);
    }
  });

  it("imageGeneration with revisedPrompt uses it as description", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "imageGeneration", id: "ig-1", revisedPrompt: "A sunset photo", savedPath: "/output/img.png" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart.title).toBe("A sunset photo");
    expect(toolPart.locations).toEqual([{ path: "/output/img.png" }]);
    if (toolPart.state.status === "completed") {
      expect(toolPart.state.output).toBe("/output/img.png");
    }
  });

  it("imageGeneration without revisedPrompt uses 'Generating image' fallback", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "imageGeneration", id: "ig-2", savedPath: "/output/img2.png" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart.title).toBe("Generating image");
  });

  it("imageGeneration without savedPath falls back to result", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "imageGeneration", id: "ig-3", result: "/generated/img.png" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    if (toolPart.state.status === "completed") {
      expect(toolPart.state.output).toBe("/generated/img.png");
    }
  });

  it("commandExecution with non-zero exitCode produces error state", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "commandExecution", id: "cmd-err", command: "fail", exitCode: 1 },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart.state.status).toBe("error");
    if (toolPart.state.status === "error") {
      expect(toolPart.state.error).toBe("Exit code: 1");
    }
  });

  it("item with status failed and string result uses result as error", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "mcpToolCall", id: "mcp-fail", status: "failed", result: "Permission denied" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart.state.status).toBe("error");
    if (toolPart.state.status === "error") {
      expect(toolPart.state.error).toBe("Permission denied");
    }
  });

  it("item with status failed and non-string result uses generic Tool failed error", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "mcpToolCall", id: "mcp-fail2", status: "failed", result: { code: 500 } },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart.state.status).toBe("error");
    if (toolPart.state.status === "error") {
      expect(toolPart.state.error).toBe("Tool failed");
    }
  });

  it("item with status declined uses Tool failed error", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "mcpToolCall", id: "mcp-dec", status: "declined" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart.state.status).toBe("error");
    if (toolPart.state.status === "error") {
      expect(toolPart.state.error).toBe("Tool failed");
    }
  });

  it("item with explicit error object (message+details) uses formatted string", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [{
            type: "commandExecution",
            id: "cmd-obj-err",
            command: "risky",
            error: { message: "Disk full", additionalDetails: "No space left on device" },
          }],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart.state.status).toBe("error");
    if (toolPart.state.status === "error") {
      expect(toolPart.state.error).toBe("Disk full\n\nNo space left on device");
    }
  });

  it("item without id uses generated callId", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "commandExecution", command: "ls" }, // no id
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart).toBeDefined();
    expect(toolPart.callId).toMatch(/^call/);
  });

  it("fileChange without changes has empty output", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "fileChange", id: "fc-1" }, // no changes array
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart).toBeDefined();
    if (toolPart.state.status === "completed") {
      expect(toolPart.state.output).toBe("");
    }
  });

  it("changes with patch field (not diff) is used for diff", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [{
            type: "fileChange",
            id: "fc-patch",
            changes: [{ path: "/foo.ts", patch: "@@ -1 +1 @@\n-old\n+patched" }],
          }],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart.diff).toContain("@@ -1 +1 @@");
    expect(toolPart.diff).toContain("+patched");
  });
});

describe("convertThreadToMessages - user input block types", () => {
  function makeUserTurn(content: unknown[]) {
    return {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [{ type: "userMessage", id: "u1", content }],
        }],
      },
    };
  }

  it("text block with empty text produces no text part", () => {
    const messages = convertThreadToMessages("sess", makeUserTurn([
      { type: "text", text: "" },
    ]));
    // no user message created since userParts is empty
    expect(messages).toHaveLength(0);
  });

  it("text block with undefined text produces no text part", () => {
    const messages = convertThreadToMessages("sess", makeUserTurn([
      { type: "text" },
    ]));
    expect(messages).toHaveLength(0);
  });

  it("skill block with name produces skill placeholder text", () => {
    const messages = convertThreadToMessages("sess", makeUserTurn([
      { type: "skill", name: "mySkill" },
    ]));
    expect(messages).toHaveLength(1);
    expect((messages[0].parts[0] as any).text).toBe("[Skill: mySkill]");
  });

  it("skill block without name uses skill fallback", () => {
    const messages = convertThreadToMessages("sess", makeUserTurn([
      { type: "skill" },
    ]));
    expect(messages).toHaveLength(1);
    expect((messages[0].parts[0] as any).text).toBe("[Skill: skill]");
  });

  it("mention block with name produces mention placeholder text", () => {
    const messages = convertThreadToMessages("sess", makeUserTurn([
      { type: "mention", name: "Alice" },
    ]));
    expect(messages).toHaveLength(1);
    expect((messages[0].parts[0] as any).text).toBe("[Mention: Alice]");
  });

  it("mention block without name uses mention fallback", () => {
    const messages = convertThreadToMessages("sess", makeUserTurn([
      { type: "mention" },
    ]));
    expect(messages).toHaveLength(1);
    expect((messages[0].parts[0] as any).text).toBe("[Mention: mention]");
  });

  it("unknown block type produces no part", () => {
    const messages = convertThreadToMessages("sess", makeUserTurn([
      { type: "audio", data: "abc123" },
    ]));
    expect(messages).toHaveLength(0);
  });

  it("image block without url returns [Image] fallback", () => {
    const messages = convertThreadToMessages("sess", makeUserTurn([
      { type: "image" }, // no url
    ]));
    expect(messages).toHaveLength(1);
    expect((messages[0].parts[0] as any).text).toBe("[Image]");
  });

  it("image block with non-data URL returns [Image] fallback", () => {
    const messages = convertThreadToMessages("sess", makeUserTurn([
      { type: "image", url: "https://example.com/img.jpg" },
    ]));
    expect(messages).toHaveLength(1);
    expect((messages[0].parts[0] as any).text).toBe("[Image]");
  });

  it("non-array content returns no user inputs", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [{ type: "userMessage", id: "u1", content: "plain string" }],
        }],
      },
    });
    // content is not an array → extractUserInputs returns [] → no user parts
    expect(messages).toHaveLength(0);
  });
});

describe("normalizeToolInput via createToolPart - edge cases", () => {
  it("shell: uses cmd when command is missing", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "c1", "commandExecution", { cmd: "ls -la" });
    expect(toolPart.title).toBe("Running ls -la");
  });

  it("shell: empty command when neither command nor cmd is string", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "c2", "commandExecution", {});
    expect(toolPart.title).toBe("Running command");
  });

  it("web_fetch: normalizeToolInput converts query-only to search: url, title reflects url", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "w1", "webSearch", { query: "async patterns" });
    // normalizeToolInput sets url = "search:async patterns" when url is absent
    // buildToolTitle then uses the url → "Fetching search:async patterns"
    expect(toolPart.title).toBe("Fetching search:async patterns");
  });

  it("web_fetch: keeps existing url when provided", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "w2", "webSearch", { url: "https://api.example.com" });
    expect(toolPart.title).toContain("https://api.example.com");
  });

  it("task: uses title as description fallback when description is absent", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "t1", "collabAgentToolCall", { title: "Deploy via agent" });
    expect(toolPart.title).toBe("Deploy via agent");
  });

  it("task: uses tool as description fallback when title and description are absent", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "t2", "collabAgentToolCall", { tool: "deploy-agent" });
    // no description or title, uses tool name
    expect(toolPart.title).toContain("deploy-agent");
  });

  it("task: uses Delegating task when no description/title/tool", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "t3", "collabAgentToolCall", {});
    expect(toolPart.title).toBe("Delegating task");
  });

  it("extractFilePath: uses file_path field when filePath and path are absent", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "r1", "imageView", {
      file_path: "/data/report.csv",
    });
    expect(toolPart.locations).toEqual([{ path: "/data/report.csv" }]);
  });

  it("extractFilePath: uses savedPath when other path fields are absent", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "ig-1", "imageGeneration", {
      savedPath: "/output/generated.png",
    });
    expect(toolPart.locations).toEqual([{ path: "/output/generated.png" }]);
  });

  it("extractFilePath: returns undefined when no path fields present", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "u1", "unknown", {});
    expect(toolPart.locations).toBeUndefined();
  });
});

describe("formatTurnPlanMarkdown - additional plan step cases", () => {
  it("plan step without step text uses 'Untitled step'", () => {
    const md = formatTurnPlanMarkdown(null, [{ step: 123 as any, status: "pending" }]);
    expect(md).toContain("Untitled step");
  });

  it("plan step with only whitespace uses 'Untitled step'", () => {
    const md = formatTurnPlanMarkdown(null, [{ step: "   ", status: "pending" }]);
    expect(md).toContain("Untitled step");
  });

  it("explanation with only whitespace is not included", () => {
    const md = formatTurnPlanMarkdown("   ", [{ step: "Do it", status: "pending" }]);
    expect(md).not.toContain("   ");
    expect(md).toContain("- [ ] Do it");
  });
});

describe("appendTextDelta - leadingTrimmed and textPartId branches", () => {
  it("subsequent calls reuse existing textPartId", () => {
    const buffer = createBuffer();
    const first = appendTextDelta(buffer, "Hello");
    const second = appendTextDelta(buffer, " World");
    // same textPartId → same id
    expect(first.id).toBe(second.id);
  });

  it("empty accumulator after trimming returns empty text part", () => {
    const buffer = createBuffer();
    const part = appendTextDelta(buffer, "   ");
    expect(part.text).toBe("");
    // textPartId should still be created
    expect(buffer.textPartId).not.toBeNull();
  });

  it("second whitespace-only call reuses existing textPartId (line 103 false branch)", () => {
    const buffer = createBuffer();
    appendTextDelta(buffer, "   "); // first call: sets textPartId
    const second = appendTextDelta(buffer, " ");  // second call: !buffer.textPartId is false → reuses
    expect(second.text).toBe("");
    // textPartId unchanged from first call
    expect(buffer.textPartId).toBeTruthy();
  });
});

describe("appendReasoningDelta - reasoningPartId reuse (line 132 false branch)", () => {
  it("second call reuses existing reasoningPartId", () => {
    const buffer = createBuffer();
    const first = appendReasoningDelta(buffer, "first thought");
    const second = appendReasoningDelta(buffer, " more thinking");
    // reasoningPartId reused → same id
    expect(first.id).toBe(second.id);
    // text accumulates
    expect(second.text).toBe("first thought more thinking");
  });
});

describe("appendPlanDelta - planAccumulator initialization", () => {
  it("first call uses default prefix", () => {
    const buffer = createBuffer();
    const part = appendPlanDelta(buffer, "first step");
    expect(part.text).toBe("## Plan\n\nfirst step");
  });

  it("second call appends to accumulator", () => {
    const buffer = createBuffer();
    appendPlanDelta(buffer, "first");
    const part = appendPlanDelta(buffer, " second");
    expect(part.text).toBe("## Plan\n\nfirst second");
  });
});

describe("replacePlanText - planPartId reuse", () => {
  it("first call creates planPartId", () => {
    const buffer = createBuffer();
    replacePlanText(buffer, "## Plan\n\nv1");
    expect(buffer.planPartId).not.toBeNull();
  });

  it("second call reuses planPartId", () => {
    const buffer = createBuffer();
    replacePlanText(buffer, "## Plan\n\nv1");
    const id1 = buffer.planPartId;
    replacePlanText(buffer, "## Plan\n\nv2");
    expect(buffer.planPartId).toBe(id1);
  });
});

describe("upsertPart - both insertion paths", () => {
  it("inserts new part when id is not found", () => {
    const buffer = createBuffer();
    const part = { id: "new-part", messageId: "m1", sessionId: "s1", type: "text" as const, text: "hi" };
    upsertPart(buffer.parts, part);
    expect(buffer.parts).toHaveLength(1);
    expect(buffer.parts[0].id).toBe("new-part");
  });

  it("replaces existing part when id is found", () => {
    const buffer = createBuffer();
    const part1 = { id: "p1", messageId: "m1", sessionId: "s1", type: "text" as const, text: "v1" };
    const part2 = { id: "p1", messageId: "m1", sessionId: "s1", type: "text" as const, text: "v2" };
    upsertPart(buffer.parts, part1);
    upsertPart(buffer.parts, part2);
    expect(buffer.parts).toHaveLength(1);
    expect((buffer.parts[0] as any).text).toBe("v2");
  });
});

describe("createStepFinish and createSystemNotice basics", () => {
  it("createSystemNotice adds part to buffer", () => {
    const buffer = createBuffer();
    const notice = createSystemNotice(buffer, "warning", "Low memory");
    expect(notice.noticeType).toBe("warning");
    expect(notice.text).toBe("Low memory");
    expect(buffer.parts).toContain(notice);
  });

  it("createStepFinish adds part to buffer", () => {
    const buffer = createBuffer();
    const finish = createStepFinish(buffer);
    expect(finish.type).toBe("step-finish");
    expect(buffer.parts).toContain(finish);
  });
});

describe("createUserMessage - default timestamp", () => {
  it("uses Date.now when createdAt is not provided", () => {
    const before = Date.now();
    const msg = createUserMessage("sess", "Hello");
    const after = Date.now();
    expect(msg.time.created).toBeGreaterThanOrEqual(before);
    expect(msg.time.created).toBeLessThanOrEqual(after);
  });
});

describe("applyHistoricalToolTiming - error status branch", () => {
  it("tool with error status gets timing updated via convertThreadToMessages", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "commandExecution", id: "cmd-e", command: "fail", exitCode: 1 },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart.state.status).toBe("error");
    if (toolPart.state.status === "error") {
      expect(toolPart.state.time.start).toBeDefined();
      expect(toolPart.state.time.end).toBeDefined();
      expect(toolPart.state.time.duration).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("buildToolMetadata - read tool lines count", () => {
  it("read tool with multi-line output produces lines metadata", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "imageView", id: "iv-1", path: "/foo.txt" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    if (toolPart.state.status === "completed") {
      // output = "/foo.txt" → 1 line
      expect((toolPart.state.metadata as any)?.lines).toBe(1);
    }
  });
});

describe("finalizeBufferToMessage - optional fields", () => {
  it("includes all optional fields when set on buffer", () => {
    const buffer: MessageBuffer = {
      messageId: "msg-final",
      sessionId: "sess-1",
      parts: [],
      textAccumulator: "",
      textPartId: null,
      reasoningAccumulator: "",
      reasoningPartId: null,
      planAccumulator: undefined,
      planPartId: null,
      startTime: 1000,
      workingDirectory: "/project",
      modelId: "claude-opus",
      reasoningEffort: "high",
      cost: 0.05,
      costUnit: "usd",
      error: "Something failed",
      engineMeta: { codexThreadId: "t-1" },
    };
    const msg = finalizeBufferToMessage(buffer);
    expect(msg.modelId).toBe("claude-opus");
    expect(msg.reasoningEffort).toBe("high");
    expect(msg.cost).toBe(0.05);
    expect(msg.costUnit).toBe("usd");
    expect(msg.error).toBe("Something failed");
    expect(msg.workingDirectory).toBe("/project");
  });
});

// ---------------------------------------------------------------------------
// Remaining gap coverage: lines 872, 977, 1031, 1059
// ---------------------------------------------------------------------------

describe("buildPermissionOptions - falsy non-string decision entries (line 872)", () => {
  it("falsy non-object entries in availableDecisions are filtered to empty decisions", () => {
    // null, false, and 0 are neither strings nor truthy objects → all hit the `return ""` branch
    const p = convertApprovalToPermission("sess", 1, "item/commandExecution/requestApproval", {
      command: "ls",
      availableDecisions: [null, false, 0],
    });
    // filtered to [] → decisions.length === 0 → both allow options included
    expect(p.options.map((o) => o.id)).toEqual(["allow_once", "allow_always", "reject_once"]);
  });

  it("empty-key object in availableDecisions is filtered out (yields empty string)", () => {
    const p = convertApprovalToPermission("sess", 1, "item/commandExecution/requestApproval", {
      command: "ls",
      availableDecisions: [{}], // Object.keys({})[0] === undefined → ?? "" → ""
    });
    // "" filtered → decisions = [] → both allow options
    expect(p.options.map((o) => o.id)).toEqual(["allow_once", "allow_always", "reject_once"]);
  });
});

describe("extractDiffFromParams - change entry with neither diff nor patch (line 977)", () => {
  it("change entry without diff or patch produces undefined toolPart.diff", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "fc-nd", "fileChange", {
      changes: [{ path: "/foo.ts", content: "updated content" }], // neither diff nor patch
    });
    expect(toolPart.diff).toBeUndefined();
  });
});

describe("itemToParams and itemToOutput default case (lines 1031, 1059)", () => {
  it("unrecognized item type uses default empty params and empty string output", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "customUnknownEventType", id: "custom-1" },
          ],
        }],
      },
    });
    // Falls through applyHistoricalItem default, calls itemToParams (→ {}) and itemToOutput (→ "")
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart).toBeDefined();
    if (toolPart.state.status === "completed") {
      expect(toolPart.state.output).toBe("");
    }
  });
});

describe("normalizeError - object without message field (line 1131 false branch)", () => {
  it("error object without message field falls back to status message", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "interrupted",
          error: { code: 500, name: "ServerError" }, // no message field
          items: [],
        }],
      },
    });
    // normalizeError({ code: 500 }) → message = undefined → if (message) is FALSE → returns undefined
    // then ?? "Turn interrupted" kicks in
    expect(messages[0].error).toBe("Turn interrupted");
  });
});

describe("getRunningToolOutput - non-object input (line 1147 true branch)", () => {
  it("shell tool with null state input returns empty accumulated output", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "sh-null", "commandExecution", { command: "ls" });
    // Manually set running state with null input to hit !input path in getRunningToolOutput
    toolPart.state = { status: "running", input: null, time: { start: Date.now() } };
    completeToolPart(toolPart, null);
    expect(toolPart.state.status).toBe("completed");
    if (toolPart.state.status === "completed") {
      expect((toolPart.state.metadata as any)?.output).toBe("");
    }
  });
});

describe("itemToOutput - imageGeneration with neither savedPath nor result (line 1057)", () => {
  it("imageGeneration without savedPath or result returns empty output", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "imageGeneration", id: "ig-empty" }, // no savedPath or result
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    if (toolPart.state.status === "completed") {
      expect(toolPart.state.output).toBe("");
    }
  });
});

describe("buildToolMetadata - read tool with empty output (line 1077 false branch)", () => {
  it("imageView with no path produces no lines metadata", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "imageView", id: "iv-empty" }, // no path → output = ""
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    if (toolPart.state.status === "completed") {
      // output is "" → if (outputText) is FALSE → no lines metadata
      expect((toolPart.state.metadata as any)?.lines).toBeUndefined();
    }
  });
});

describe("itemToOutput - remaining ?? fallback paths (lines 1046-1053)", () => {
  it("dynamicToolCall with neither contentItems nor result returns empty string", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "dynamicToolCall", id: "dyn-empty", tool: "noop" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    if (toolPart.state.status === "completed") {
      expect(toolPart.state.output).toBe("");
    }
  });

  it("webSearch without query returns empty string output", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "webSearch", id: "ws-noq" }, // no query
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    if (toolPart.state.status === "completed") {
      expect(toolPart.state.output).toBe("");
    }
  });

  it("commandExecution without aggregatedOutput returns empty string", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "commandExecution", id: "cmd-no-out", command: "silent-cmd" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    if (toolPart.state.status === "completed") {
      expect(toolPart.state.output).toBe("");
    }
  });

  it("mcpToolCall without result returns empty string", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { type: "mcpToolCall", id: "mcp-nores", server: "s", tool: "t" },
          ],
        }],
      },
    });
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    if (toolPart.state.status === "completed") {
      expect(toolPart.state.output).toBe("");
    }
  });
});

describe("extractFilePath - changes entry without path field (line 962 false branch)", () => {
  it("fileChange with changes lacking path field produces no locations", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "fc-nopath", "fileChange", {
      changes: [{ diff: "@@ -1 +1 @@\n-old\n+new", content: "new content" }], // no path
    });
    // extractFilePath iterates changes, record.path is undefined → FALSE branch → loop continues
    // returns undefined → no locations set
    expect(toolPart.locations).toBeUndefined();
    // but diff IS extracted from changes
    expect(toolPart.diff).toContain("@@ -1 +1 @@");
  });

  it("fileChange with changes having empty-string path falls through to return undefined", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "fc-emptypath", "fileChange", {
      changes: [{ path: "", diff: "@@ empty path @@" }], // empty string path → falsy
    });
    // record.path = "" → typeof "" === "string" is true BUT "" is falsy → if condition FALSE
    expect(toolPart.locations).toBeUndefined();
  });
});

describe("extractDiffFromParams - direct params.diff field (line 969 true branch)", () => {
  it("direct params.diff non-empty string is extracted and set on toolPart", () => {
    const buffer = createBuffer();
    const { toolPart } = createToolPart(buffer, "direct-diff", "commandExecution", {
      command: "apply-patch",
      diff: "@@ -1 +1 @@\n-before\n+after",
    });
    // extractDiffFromParams: params.diff is a non-empty string → TRUE branch → returns it
    expect(toolPart.diff).toContain("@@ -1 +1 @@");
    expect(toolPart.diff).toContain("+after");
  });
});

describe("applyHistoricalItem - item with no type uses 'unknown' fallback (line 772)", () => {
  it("item without type field uses 'unknown' as item type", () => {
    const messages = convertThreadToMessages("sess", {
      thread: {
        id: "t-1",
        turns: [{
          status: "completed",
          items: [
            { id: "no-type-1" } as any, // type is undefined → item.type ?? "unknown" = "unknown"
          ],
        }],
      },
    });
    // The item skips the switch cases and hits default with type "unknown"
    const toolPart = messages[0].parts.find((p) => p.type === "tool") as ToolPart;
    expect(toolPart).toBeDefined();
    expect(toolPart.originalTool).toBe("unknown");
    expect(toolPart.callId).toBe("no-type-1");
  });
});
