import { describe, expect, it } from "vitest";

import {
  applyTurnMetadata,
  applyTurnUsage,
  convertApprovalToPermission,
  convertThreadToMessages,
  convertUserInputToQuestion,
  formatTurnPlanMarkdown,
} from "../../../../../electron/main/engines/codex/converters";
import type { MessageBuffer } from "../../../../../electron/main/engines/engine-adapter";
import type { ToolPart } from "../../../../../src/types/unified";

describe("codex/converters.ts", () => {
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
  });

  it("applies token usage and turn metadata from stable payloads", () => {
    const buffer: MessageBuffer = {
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
    };

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
    expect(buffer.engineMeta).toEqual({ turnDiff: "@@ -1 +1 @@" });
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
    expect(messages[0].parts.map((part) => part.type)).toEqual(["text", "text"]);
    expect((messages[0].parts[0] as any).text).toBe("Fix the tests");
    expect((messages[0].parts[1] as any).text).toBe("[Image: /tmp/img.png]");

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
});
