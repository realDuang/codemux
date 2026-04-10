import { describe, expect, it } from "vitest";

import {
  appendPlanDelta,
  appendReasoningDelta,
  appendTextDelta,
  applyTurnMetadata,
  applyTurnUsage,
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
import type { ToolPart } from "../../../../../src/types/unified";

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
