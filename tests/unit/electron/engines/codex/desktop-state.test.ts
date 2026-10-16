import { describe, expect, it } from "vitest";

import {
  convertDesktopConversation,
  desktopMessageId,
  desktopRequestId,
  DesktopStateReducer,
  DesktopStateRevisionError,
} from "../../../../../electron/main/engines/codex/desktop-state";

// Shape follows the Desktop v11 stream serializer and its m_ turn hydrator.
function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-1", hostId: "local", cwd: "/repo", title: "Shared task",
    createdAt: 1_000, updatedAt: 3_000, resumeState: "resumed",
    latestModel: "custom-model", latestReasoningEffort: "xhigh", modelProvider: "ModelHub",
    latestCollaborationMode: { mode: "default", settings: { model: "custom-model" } },
    turns: [], requests: [], ...overrides,
  };
}

function turn(overrides: Record<string, unknown> = {}) {
  return {
    turnId: "turn-1", status: "inProgress", turnStartedAtMs: 2_000, durationMs: null,
    params: { threadId: "thread-1", input: [{ type: "text", text: "Fix this" }], cwd: "/repo", model: "custom-model", effort: "xhigh" },
    items: [
      { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Fix this" }] },
      { id: "agent-1", type: "agentMessage", text: "Working", phase: "commentary" },
    ], ...overrides,
  };
}

describe("convertDesktopConversation", () => {
  it("routes asynchronous choices through pending questions without inventing a blocking request", () => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ items: [
      { id: "async-ask", type: "agentMessage", delivery: "async", text: "Choose a target.",
        questions: [{ title: "Which target?", options: ["Local", "Remote"] }, { title: "Any constraints?" }] },
    ] })] }));
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({
      engineType: "codex-desktop", sessionId: "thread-1", dismissStopsTurn: false,
      questions: [
        { question: "Which target?", options: [{ label: "Local", description: "" }, { label: "Remote", description: "" }], custom: true },
        { question: "Any constraints?", options: [], custom: true },
      ],
      metadata: { codexTurnId: "turn-1", codexAsyncQuestions: [
        { id: JSON.stringify(["request_user_input_async", "async-ask", 0]), questionIndex: 0 },
        { id: JSON.stringify(["request_user_input_async", "async-ask", 1]), questionIndex: 1 },
      ] },
    });
    expect(result.pendingRequests).toEqual([]);
    expect(result.session.activityStatus).toBe("running");
  });

  it("keeps unanswered async choices pending and renders accepted answer receipts as assistant history", () => {
    const ask = { id: "async-ask", type: "agentMessage", delivery: "async", text: "Choose.",
      questions: [{ title: "Which target?", options: ["Local", "Remote"] }, { title: "Any constraints?" }] };
    const text = `<send_user_message_question_reply>\n${JSON.stringify([
      { questionItemId: JSON.stringify(["request_user_input_async", "async-ask", 0]), question: "Which target?", answer: "Local" },
    ])}\n</send_user_message_question_reply>`;
    const input = [{ type: "text", text }];
    const initial = convertDesktopConversation(conversation({ turns: [turn({ items: [ask] })] }));
    for (const status of ["pending", "failed"]) {
      const pending = convertDesktopConversation(conversation({ turns: [turn({ items: [ask,
        { id: "reply", type: "steeringUserMessage", status, input },
      ] })] }));
      expect(pending.questions[0].questions).toHaveLength(2);
    }
    for (const reply of [
      { id: "reply", type: "userMessage", content: input },
      { id: "reply", type: "steeringUserMessage", status: "accepted", input },
    ]) {
      const result = convertDesktopConversation(conversation({ turns: [turn({ items: [ask, reply] })] }));
      expect(result.questions).toHaveLength(1);
      expect(result.questions[0].questions.map(question => question.question)).toEqual(["Any constraints?"]);
      expect(result.questions[0].id).not.toBe(initial.questions[0].id);
      const history = result.messages.find(message => message.engineMeta?.codexItemId === "reply")!;
      expect(history.role).toBe("assistant");
      expect(history.parts).toEqual([expect.objectContaining({ type: "text", text: "Which target?\n\nLocal", phase: "commentary" })]);
    }
    const completed = convertDesktopConversation(conversation({ turns: [turn({ status: "completed", items: [ask] })] }));
    expect(completed.questions).toEqual([]);
  });

  it.each([
    "Example: <send_user_message_question_reply>not a receipt</send_user_message_question_reply>",
    "<send_user_message_question_reply>{\"answer\":\"Keep this literal\"}</send_user_message_question_reply>",
    `<send_user_message_question_reply>${JSON.stringify({ questionItemId: JSON.stringify(["request_user_input_async", "unknown-call", 0]), question: "Copied sample", answer: "Example" })}</send_user_message_question_reply>`,
  ])("preserves ordinary user text that resembles a question receipt", (text) => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ items: [
      { id: "literal", type: "userMessage", content: [{ type: "text", text }] },
    ] })] }));
    const message = result.messages.find(message => message.engineMeta?.codexItemId === "literal")!;
    expect(message.role).toBe("user");
    expect(message.parts[0]).toMatchObject({ type: "text", text });
  });

  it("preserves command identity and output while projecting native actions across snapshot completion", () => {
    const item = {
      id: "command", type: "commandExecution", command: "cat .agents/skills/review/SKILL.md && rg needle src",
      commandActions: [
        { type: "read", command: "cat .agents/skills/review/SKILL.md", name: "SKILL.md", path: ".agents/skills/review/SKILL.md" },
        { type: "search", command: "rg needle src", query: "needle", path: "src" },
      ],
    };
    const running = convertDesktopConversation(conversation({ turns: [turn({ items: [{ ...item, status: "inProgress", aggregatedOutput: "partial" }] })] }));
    const completed = convertDesktopConversation(conversation({ turns: [turn({ status: "completed", durationMs: 500, items: [
      { ...item, status: "completed", aggregatedOutput: "complete output", exitCode: 0 },
    ] })] }));
    const before = running.messages.flatMap((message) => message.parts).filter((part) => part.type === "tool");
    const after = completed.messages.flatMap((message) => message.parts).filter((part) => part.type === "tool");
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: before[0].id, callId: "command", normalizedTool: "shell", originalTool: "commandExecution",
      displayActions: [
        { kind: "skill", label: "review", path: "/repo/.agents/skills/review/SKILL.md" },
        { kind: "search", query: "needle", path: "/repo/src" },
      ],
      state: { status: "completed", input: item, output: "complete output" },
    });
    expect(after[0].displayActions).toEqual(before[0].displayActions);
  });

  it("preserves response phases and native order when only some items have timestamps", () => {
    const result = convertDesktopConversation(conversation({ turns: [turn({
      commandExecutionStartedAtMsById: { command: 2_200 },
      completedItemIds: { reasoning: true },
      items: [
        { id: "z-commentary", type: "agentMessage", text: "Checking", phase: "commentary" },
        { id: "y-partial", type: "agentMessage", text: "First result", phase: "partial_answer" },
        { id: "command", type: "commandExecution", command: "pwd", status: "inProgress" },
        { id: "reasoning", type: "reasoning", summary: ["Check the result"], content: [] },
        { id: "a-final", type: "agentMessage", text: "Done", phase: "final_answer" },
      ],
    })] }));
    const ordered = [...result.messages].sort((a, b) => a.time.created - b.time.created);
    expect(ordered.map((message) => message.engineMeta?.codexItemId)).toEqual([
      "turn-1:user", "z-commentary", "y-partial", "command", "reasoning", "a-final",
    ]);
    expect(ordered.flatMap((message) => message.parts).filter((part) => part.type === "text").map((part) => part.phase)).toEqual([
      undefined, "commentary", "partial", "final",
    ]);
    expect(ordered[4].parts[0]).toMatchObject({ type: "reasoning", completed: true });
    expect(ordered[4].parts[0]).not.toHaveProperty("time");
    expect(ordered.every((message) => message.parts.every((part, index) => part.order === index))).toBe(true);
    expect(result.isActive).toBe(true);
  });

  it.each([
    ["inProgress", "automatic_approval_review", false],
    ["approved", "automatic_approval_approved", true],
    ["denied", "automatic_approval_denied", true],
    ["aborted", "automatic_approval_aborted", true],
    ["timedOut", "automatic_approval_timed_out", true],
  ])("renders the %s automatic review state as a notice", (status, key, completed) => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ items: [
      { id: "review", type: "automaticApprovalReview", status, ...(completed ? { completedAtMs: 2_400 } : {}) },
    ] })] }));
    const message = result.messages.at(-1)!;
    expect(message.parts[0]).toMatchObject({ type: "system-notice", text: `notice:${key}` });
    expect(message.time.completed).toBe(completed ? 2_400 : undefined);
  });

  it("renders native review warnings without inventing tool calls", () => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ items: [
      { id: "strict", type: "strictReviewNotice" },
      { id: "interruption", type: "autoReviewInterruptionWarning" },
    ] })] }));
    expect(result.messages.slice(1).map((message) => message.parts[0])).toMatchObject([
      { type: "system-notice", noticeType: "warning", text: "notice:strict_review_required" },
      { type: "system-notice", noticeType: "warning", text: "notice:auto_review_interrupted" },
    ]);
  });

  it.each(["completed", "failed", "interrupted"])("retains unfinished tool output in a %s turn", (status) => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ status, durationMs: 500, items: [
      { id: "command", type: "commandExecution", command: "test", status: "inProgress", aggregatedOutput: "Partial output" },
    ] })] }));
    expect(result.messages.at(-1)!.parts[0]).toMatchObject({ type: "tool", state: { status: "error", output: "Partial output" } });
  });

  it.each([undefined, "", "Turn interrupted", { message: "Connection lost" }])(
    "normalizes interrupted turns to cancellation with native error %j", (error) => {
      for (const items of [[], turn().items]) {
        const result = convertDesktopConversation(conversation({ turns: [turn({ status: "interrupted", durationMs: 500, error, items })] }));
        expect(result.messages.at(-1)).toMatchObject({ role: "assistant", error: "Cancelled" });
        expect(result.isActive).toBe(false);
      }
    },
  );

  it.each([[undefined, "Turn failed"], [{ message: "Quota exceeded" }, "Quota exceeded"]])(
    "preserves failed turn errors (%j)", (error, expected) => {
      const result = convertDesktopConversation(conversation({ turns: [turn({ status: "failed", durationMs: 500, error })] }));
      expect(result.messages.at(-1)).toMatchObject({ role: "assistant", error: expected });
    },
  );

  it.each([["priority", "fast"], ["fast", "fast"], ["flex", "flex"], ["default", undefined], [null, undefined]])(
    "normalizes the native service tier %s", (nativeTier, expected) => {
      expect(convertDesktopConversation(conversation({ latestThreadSettings: { serviceTier: nativeTier } })).session.serviceTier).toBe(expected);
    },
  );
  it("preserves native identities in metadata while scoping UI identities during streaming", () => {
    const first = convertDesktopConversation(conversation({ turns: [turn()] }));
    const second = convertDesktopConversation(conversation({ turns: [turn({
      items: [
        { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Fix this" }] },
        { id: "agent-1", type: "agentMessage", text: "Working on the fix", phase: "commentary" },
      ],
    })] }));
    expect(first.session).toMatchObject({
      id: "thread-1", engineType: "codex-desktop", modelId: "custom-model", reasoningEffort: "max",
      activityStatus: "running", engineMeta: { codexThreadId: "thread-1", desktopHostId: "local" },
    });
    expect(first.messages.map((message) => message.engineMeta?.codexItemId)).toEqual(["user-1", "agent-1"]);
    expect(second.messages.map((message) => message.id)).toEqual(first.messages.map((message) => message.id));
    expect(second.messages[1]).toMatchObject({
      id: desktopMessageId("thread-1", "turn-1", "agent-1"), providerId: "ModelHub", time: { created: 2_000 },
      engineMeta: { codexThreadId: "thread-1", codexTurnId: "turn-1", codexItemId: "agent-1" },
      parts: [{ id: desktopMessageId("thread-1", "turn-1", "agent-1"), type: "text", text: "Working on the fix" }],
    });
    expect(second.messages[1].time.completed).toBeUndefined();
    expect(first.activeTurnId).toBe("turn-1");
  });

  it("keeps multiple commentary, tool and final answer items separate", () => {
    const result = convertDesktopConversation(conversation({ turns: [turn({
      status: "completed", durationMs: 500,
      items: [
        { id: "commentary", type: "agentMessage", text: "Checking files", phase: "commentary" },
        { id: "command", type: "commandExecution", command: "pwd", status: "completed", aggregatedOutput: "/repo", exitCode: 0 },
        { id: "answer", type: "agentMessage", text: "Fixed", phase: "final_answer" },
      ],
    })] }));
    expect(result.messages.map((message) => message.engineMeta?.codexItemId)).toEqual(["turn-1:user", "commentary", "command", "answer"]);
    expect(result.messages.at(-1)?.time.completed).toBe(2_500);
    expect(result.messages[2].parts[0]).toMatchObject({ callId: "command", normalizedTool: "shell", state: { status: "completed", output: "/repo" } });
    expect(result.isActive).toBe(false);
    expect(result.session.activityStatus).toBe("idle");
  });

  it.each(["inProgress", "completed"])("does not render empty reasoning items as repeated thinking boxes in a %s turn", (status) => {
    const state = conversation({ turns: [turn({ status, items: [
      { id: "empty", type: "reasoning", summary: [], content: [] },
      { id: "encrypted", type: "reasoning", encryptedContent: "opaque" },
      { id: "raw-only", type: "reasoning", summary: [], content: [{ type: "reasoningText", text: "Not a display summary" }] },
      { id: "blank", type: "reasoning", summary: [{ type: "summaryText", text: " \n " }], content: ["\t"] },
      { id: "readable", type: "reasoning", summary: [{ type: "summaryText", text: "Inspect the repository" }], content: [] },
      { id: "command", type: "commandExecution", command: "pwd", status: "completed", aggregatedOutput: "/repo", exitCode: 0 },
      { id: "another-empty", type: "reasoning", summary: [""], content: [] },
      { id: "answer", type: "agentMessage", text: "Fixed", phase: "final_answer" },
    ] })] });
    const before = structuredClone(state);
    const result = convertDesktopConversation(state);
    expect(result.messages.map((message) => message.engineMeta?.codexItemId)).toEqual(["turn-1:user", "readable", "command", "answer"]);
    expect(result.messages[1].parts[0]).toMatchObject({ type: "reasoning", text: "Inspect the repository", completed: true });
    expect(result.session.activityStatus).toBe(status === "inProgress" ? "running" : "idle");
    expect(state).toEqual(before);
  });

  it("preserves separate readable reasoning around tool calls", () => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ items: [
      { id: "reasoning-before", type: "reasoning", summary: [{ text: "Inspect the repository" }], content: ["Then identify the relevant test"] },
      { id: "command", type: "commandExecution", command: "pwd", status: "inProgress" },
      { id: "reasoning-after", type: "reasoning", summary: ["Check the result"], content: [] },
    ] })] }));
    expect(result.messages.map((message) => message.engineMeta?.codexItemId)).toEqual(["turn-1:user", "reasoning-before", "command", "reasoning-after"]);
    expect(result.messages[1].parts[0]).toMatchObject({ type: "reasoning", text: "Inspect the repository" });
    expect(result.messages[3].parts[0]).toMatchObject({ type: "reasoning", text: "Check the result", completed: false });
    expect(result.messages[1].id).not.toBe(result.messages[3].id);
  });

  it("renders only summary blocks while retaining repetition within the summary", () => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ items: [
      { id: "reasoning", type: "reasoning", summary: ["Check the tests", "Check the tests"], content: [{ type: "reasoningText", text: "Check the tests" }, { text: "Read the output" }] },
    ] })] }));
    expect(result.messages[1].parts[0]).toMatchObject({ type: "reasoning", text: "Check the tests\n\nCheck the tests" });
  });

  it("preserves completed question responses in question order with their original answers", () => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ items: [{
      id: "response", type: "userInputResponse", completed: true,
      questions: [{ id: "scope", question: "Which scope?" }, { id: "checks", question: "Which checks?" }],
      answers: { checks: ["Unit tests", "Browser"], scope: ["Adapter"] },
    }] })] }));
    expect(result.messages[1]).toMatchObject({
      time: { completed: 2_000 },
      parts: [
        { type: "text", text: "Which scope?\n\nAdapter", phase: "commentary", order: 0 },
        { type: "text", text: "Which checks?\n\nUnit tests\n\nBrowser", phase: "commentary", order: 1 },
      ],
    });
  });

  it.each([
    ["accept", "elicitation_accepted"], ["decline", "elicitation_declined"],
    ["cancel", "elicitation_cancelled"], [null, "elicitation_completed"],
  ])("retains a completed elicitation with action %s without inventing an executable tool", (action, notice) => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ items: [{
      id: "elicitation", type: "mcpServerElicitation", completed: true, action,
      params: { mode: "form", message: "Choose a deployment region.", requestedSchema: { type: "object", properties: {} } },
    }] })] }));
    expect(result.messages[1]).toMatchObject({
      time: { completed: 2_000 },
      parts: [{ type: "system-notice", text: `notice:${notice}` }, { type: "text", text: "Choose a deployment region." }],
    });
  });

  it("keeps pending elicitations and permission responses out of the transcript", () => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ items: [
      { id: "elicitation", type: "mcpServerElicitation", completed: false },
      { id: "pending", type: "permissionRequest", completed: false },
      { id: "allowed", type: "permissionRequest", completed: true, response: { permissions: { network: { enabled: true } }, scope: "turn" } },
      { id: "denied", type: "permissionRequest", completed: true, response: { permissions: {}, scope: "turn" } },
    ] })] }));
    expect(result.messages.map((message) => message.engineMeta?.codexItemId)).toEqual(["turn-1:user"]);
  });

  it("omits gated OpenAI form history and preserves verification titles without challenge payloads", () => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ items: [
      { id: "openai", type: "mcpServerElicitation", completed: true, params: { mode: "openaiForm", message: "Private form" } },
      { id: "legacy", type: "mcpServerElicitation", completed: true, params: { mode: "openai/form", message: "Private form" } },
      { id: "metadata", type: "mcpServerElicitation", completed: true, params: { mode: "form", message: "Private form", _meta: { "openai/elicitation": {} } } },
      { id: "verification", type: "mcpServerElicitation", completed: true, action: "accept", params: { mode: "openai/userVerification", title: "Verification complete", challenge: "opaque-challenge" } },
    ] })] }));
    expect(result.messages.map((message) => message.engineMeta?.codexItemId)).toEqual(["turn-1:user", "verification"]);
    expect(result.messages[1].parts).toMatchObject([
      { type: "system-notice", text: "notice:elicitation_accepted" }, { type: "text", text: "Verification complete" },
    ]);
    expect(JSON.stringify(result.messages)).not.toContain("opaque-challenge");
  });

  it.each([false, true])("preserves plan content with its request completion %s", (isCompleted) => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ status: "completed", items: [{
      id: "implementation", type: "planImplementation", planContent: "1. Inspect\n2. Implement", isCompleted,
    }] })] }));
    expect(result.messages[1].parts).toMatchObject([
      { type: "system-notice", text: `notice:plan_implementation_${isCompleted ? "completed" : "pending"}` },
      { type: "text", text: "1. Inspect\n2. Implement" },
    ]);
    expect(result.messages[1].time.completed).toBe(isCompleted ? 2_000 : undefined);
  });

  it("normalizes the native todo list into completed plan updates with independent step states", () => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ items: [{
      id: "todos", type: "todo-list", explanation: "Start with the adapter.",
      plan: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "inProgress" }, { step: "Validate", status: "pending" }],
    }] })] }));
    expect(result.messages[1].parts).toMatchObject([
      { type: "text", text: "Start with the adapter." },
      { type: "tool", normalizedTool: "todo", state: { status: "completed", input: { todos: [
        { content: "Inspect", status: "completed" }, { content: "Implement", status: "in_progress" }, { content: "Validate", status: "pending" },
      ] } } },
    ]);
    expect(result.isActive).toBe(true);
  });

  it.each([false, true])("renders retry=%s native errors as notices while keeping the turn state authoritative", (willRetry) => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ items: [{
      id: "error", type: "error", message: "Connection lost", additionalDetails: "Retry in progress", willRetry,
    }] })] }));
    const parts = result.messages[1].parts;
    expect(parts.at(-1)).toMatchObject({ type: "system-notice", noticeType: willRetry ? "info" : "warning", text: "Connection lost\n\nRetry in progress" });
    expect(parts).toHaveLength(willRetry ? 2 : 1);
    if (willRetry) expect(parts[0]).toMatchObject({ type: "system-notice", text: "notice:stream_reconnecting" });
    expect(result.isActive).toBe(true);
    expect(result.messages[1].error).toBeUndefined();
  });

  it("uses canonical island order and retains optimistic steering without duplicating accepted user items", () => {
    const accepted = turn({ status: "completed", itemsPagination: { hasLoadedOldest: true }, items: [{ id: "accepted", type: "userMessage", content: [{ type: "text", text: "New direction" }] }] });
    const result = convertDesktopConversation(conversation({
      turnHistory: { kind: "canonical", history: {
        isComplete: true,
        islands: [{ entries: [{ value: "turn:turn-1" }] }],
        entitiesByKey: { "turn:turn-1": accepted },
      } },
      turns: [turn({ items: [
        { id: "accepted-steer", type: "steeringUserMessage", serverUserMessageId: "accepted", input: [{ type: "text", text: "New direction" }], status: "accepted" },
        { id: "pending-steer", type: "steeringUserMessage", serverUserMessageId: null, input: [{ type: "text", text: "One more change" }], status: "pending" },
      ] })],
    }));
    expect(result.messages.map((message) => message.engineMeta?.codexItemId)).toEqual(["turn-1:user", "accepted", "pending-steer"]);
    expect(result.messages[2]).toMatchObject({ role: "user", parts: [{ text: "One more change" }] });
    expect(result.messages[2].time.completed).toBeUndefined();
    expect(result.incompleteHistory).toBe(false);
  });

  it("uses the completed legacy overlay and inserts missing history before its shared anchor", () => {
    const canonicalTurn = turn({ turnId: "turn-2", items: [{ id: "agent-2", type: "agentMessage", text: "Partial" }] });
    const result = convertDesktopConversation(conversation({
      turnHistory: { kind: "canonical", history: {
        isComplete: true, islands: [{ entries: [{ value: "turn:turn-2" }] }],
        entitiesByKey: { "turn:turn-2": canonicalTurn },
      } },
      turns: [
        turn({ status: "completed" }),
        turn({ turnId: "turn-2", status: "completed", items: [{ id: "agent-2", type: "agentMessage", text: "Complete" }] }),
      ],
    }));
    expect(result.messages.map((message) => message.engineMeta?.codexTurnId)).toEqual(["turn-1", "turn-1", "turn-2", "turn-2"]);
    expect(result.messages.at(-1)?.parts[0]).toMatchObject({ text: "Complete" });
    expect(result.latestTurnId).toBe("turn-2");
    expect(result.isActive).toBe(false);
  });

  it("reports partial history without presenting unloaded turns as complete", () => {
    expect(convertDesktopConversation(conversation({ resumeState: "needs_resume" })).incompleteHistory).toBe(true);
    expect(convertDesktopConversation(conversation({ turns: [turn({ itemsPagination: { hasLoadedOldest: false } })] })).incompleteHistory).toBe(true);
    expect(convertDesktopConversation(conversation({
      turnHistory: { kind: "canonical", history: { isComplete: false, islands: [], entitiesByKey: {} } },
    })).incompleteHistory).toBe(true);
  });

  it("uses Desktop item timestamps and hides accepted-steer markers", () => {
    const result = convertDesktopConversation(conversation({ turns: [turn({
      params: { input: [{ type: "text", text: "Fix this" }], clientUserMessageId: "client-1" },
      aeonAssistantMessageStartedAtMsById: { "agent-1": 2_100 },
      agentMessageCompletedAtMsById: { "agent-1": 2_200 },
      items: [
        { id: "user-1", type: "userMessage", clientId: "client-1", content: [{ type: "text", text: "Fix this", text_elements: [] }] },
        { id: "agent-1", type: "agentMessage", text: "Continuing" },
        { id: "steer-1", type: "steeringUserMessage", input: [{ type: "text", text: "Check the tests" }], status: "accepted", serverUserMessageId: "server-user-2" },
        { id: "server-user-2", type: "steered" },
      ],
    })] }));
    expect(result.messages.map((message) => message.engineMeta?.codexItemId)).toEqual(["user-1", "agent-1", "steer-1"]);
    expect(result.messages[1].time).toEqual({ created: 2_100, completed: 2_200 });
    expect(result.messages[2].role).toBe("user");
  });

  it.each([
    { itemsPagination: { openingUserMessageId: "opening", hasLoadedOldest: false } },
    { itemsPagination: { hasLoadedOldest: true }, clientUserMessageId: "opening-client", itemClientId: "steer-client" },
    { itemsPagination: { hasLoadedOldest: false } },
  ])("does not mistake a repeated steer for the missing opening input ($itemsPagination)", (entry) => {
    const result = convertDesktopConversation(conversation({ turns: [turn({
      params: { input: [{ type: "text", text: "Continue" }], clientUserMessageId: entry.clientUserMessageId },
      itemsPagination: entry.itemsPagination,
      items: [{ id: "later-steer", clientId: entry.itemClientId, type: "userMessage", content: [{ type: "text", text: "Continue" }] }],
    })] }));
    expect(result.messages.map((message) => message.engineMeta?.codexItemId)).toEqual([entry.clientUserMessageId ?? "turn-1:user", "later-steer"]);
  });

  it("preserves original approval ids and question definitions for follower replies", () => {
    const request = { id: 42, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd", command: "pwd", availableDecisions: ["accept", "decline"] } };
    const question = { id: "input-1", method: "item/tool/requestUserInput", params: { threadId: "thread-1", itemId: "ask", questions: [{ id: "choice", header: "Target", question: "Choose the target", options: [{ label: "A", description: "First" }] }] } };
    const result = convertDesktopConversation(conversation({ requests: [request, question, { ...request, id: 43, completed: true }] }));
    expect(result.pendingRequests).toEqual([request, question]);
    expect(result.permissions[0]).toMatchObject({ id: desktopRequestId("thread-1", 42), engineType: "codex-desktop", sessionId: "thread-1", toolCallId: "cmd", metadata: { codexThreadId: "thread-1", codexRequestId: 42, desktopHostId: "local" } });
    expect(result.questions[0]).toMatchObject({ id: desktopRequestId("thread-1", "input-1"), engineType: "codex-desktop", metadata: { codexThreadId: "thread-1", codexRequestId: "input-1", desktopHostId: "local" }, questions: [{ question: "Choose the target", options: [{ label: "A", description: "First" }] }] });
    expect(result.session.activityStatus).toBe("waiting");
  });

  it("reports the latest runnable turn instead of an older stale active turn", () => {
    const result = convertDesktopConversation(conversation({ turns: [turn(), turn({ turnId: "turn-2", status: "completed" })] }));
    expect(result.activeTurnId).toBeUndefined();
    expect(result.isActive).toBe(false);
    const resumed = convertDesktopConversation(conversation({ resumeState: "needs_resume", threadRuntimeStatus: { type: "active" } }));
    expect(resumed.isActive).toBe(true);
    expect(resumed.activeTurnId).toBeUndefined();
  });

  it("preserves failure and running tool output in the normalized state", () => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ items: [
      { id: "tool-1", type: "commandExecution", command: "test", status: "inProgress", aggregatedOutput: "partial output" },
    ] })] }));
    expect(result.messages[1].parts[0]).toMatchObject({ state: { status: "running", input: { _output: "partial output" } } });
    const failed = convertDesktopConversation(conversation({ turns: [turn({ status: "failed", error: { message: "Request failed" }, items: [] })] }));
    expect(failed.messages.at(-1)).toMatchObject({ error: "Request failed", role: "assistant" });
    expect(failed.session.activityStatus).toBe("error");
  });
});

describe("Desktop request identity isolation", () => {
  it("isolates pending permissions, questions, and elicitations by native thread and host", () => {
    const requests = [
      { id: 1, method: "item/commandExecution/requestApproval", params: { command: "pwd" } },
      { id: "1", method: "item/commandExecution/requestApproval", params: { command: "ls" } },
      { id: 2, method: "item/tool/requestUserInput", params: { questions: [{ id: "choice", header: "Target", question: "Choose a target" }] } },
      { id: 3, method: "mcpServer/elicitation/request", params: { mode: "form", serverName: "fixture", message: "Choose a target", requestedSchema: { type: "object", properties: { target: { type: "string" } } } } },
    ];
    const states = [conversation({ requests }), conversation({ id: "thread-2", requests }), conversation({ hostId: "remote", requests })];
    const originals = structuredClone(states);
    const snapshots = states.map(convertDesktopConversation);
    const normalized = snapshots.flatMap((snapshot) => [...snapshot.permissions, ...snapshot.questions]);
    expect(new Set(normalized.map((request) => request.id)).size).toBe(12);
    for (const snapshot of snapshots) {
      expect(snapshot.pendingRequests).toEqual(requests);
      const hostId = snapshot.session.engineMeta?.desktopHostId as string;
      const pending = [...snapshot.permissions, ...snapshot.questions];
      pending.forEach((request, index) => {
        expect(request.id).toBe(desktopRequestId(snapshot.session.id, requests[index].id, hostId));
        expect(request.metadata).toMatchObject({ codexThreadId: snapshot.session.id, codexRequestId: requests[index].id, desktopHostId: hostId });
      });
    }
    expect(convertDesktopConversation(states[0]).permissions).toEqual(snapshots[0].permissions);
    expect(states).toEqual(originals);
  });

  it("keeps separators unambiguous and distinguishes native number and string IDs", () => {
    expect(desktopRequestId("a:b", "c")).not.toBe(desktopRequestId("a", "b:c"));
    expect(desktopRequestId("thread", 1)).not.toBe(desktopRequestId("thread", "1"));
    expect(desktopRequestId("thread", "1", "host:a")).not.toBe(desktopRequestId("a:thread", "1", "host"));
  });
});

describe("Desktop message identity isolation", () => {
  function repeatedIds(threadId: string, text: string, hostId = "local") {
    return conversation({ id: threadId, hostId, turns: [turn({
      turnId: "reused-turn", status: "completed", durationMs: 100,
      params: { input: [{ type: "text", text }] },
      items: [
        { id: "item-1", type: "userMessage", content: [{ type: "text", text }] },
        { id: "item-2", type: "agentMessage", text: `${text} answer` },
      ],
    })] });
  }

  it("keeps global part storage isolated when threads reuse both turn and item IDs", () => {
    const oldState = repeatedIds("old-thread", "OLD_READY");
    const newState = repeatedIds("new-thread", "NEW_PROMPT");
    const before = JSON.stringify([oldState, newState]);
    const oldSnapshot = convertDesktopConversation(oldState);
    const newSnapshot = convertDesktopConversation(newState);
    const globalParts = new Map([...oldSnapshot.messages, ...newSnapshot.messages].map((message) => [message.id, message.parts]));
    expect(globalParts.size).toBe(4);
    expect(globalParts.get(oldSnapshot.messages[0].id)?.[0]).toMatchObject({ type: "text", text: "OLD_READY" });
    expect(globalParts.get(newSnapshot.messages[0].id)?.[0]).toMatchObject({ type: "text", text: "NEW_PROMPT" });
    const allPartIds = [...globalParts.values()].flatMap((parts) => parts.map((part) => part.id));
    expect(new Set(allPartIds).size).toBe(allPartIds.length);
    for (const snapshot of [oldSnapshot, newSnapshot]) {
      expect(snapshot.messages.map((message) => message.engineMeta?.codexItemId)).toEqual(["item-1", "item-2"]);
      expect(snapshot.messages.map((message) => message.engineMeta?.codexTurnId)).toEqual(["reused-turn", "reused-turn"]);
      for (const message of snapshot.messages) for (const part of message.parts) expect(part.messageId).toBe(message.id);
    }
    expect(JSON.stringify([oldState, newState])).toBe(before);
  });

  it("keeps repeated native item IDs distinct across turns and hosts", () => {
    const state = repeatedIds("thread", "first");
    const second = repeatedIds("thread", "second").turns[0];
    const snapshot = convertDesktopConversation({ ...state, turns: [...state.turns, { ...second, turnId: "another-turn" }] });
    expect(new Set(snapshot.messages.map((message) => message.id)).size).toBe(4);
    const otherHost = convertDesktopConversation(repeatedIds("thread", "first", "remote:host"));
    expect(otherHost.messages[0].id).not.toBe(snapshot.messages[0].id);
    expect(desktopMessageId("a:b", "c", "d")).not.toBe(desktopMessageId("a", "b:c", "d"));
  });

  it("retains stable qualified identities across stream updates and reconnects", () => {
    const state = repeatedIds("thread", "initial");
    const first = new DesktopStateReducer();
    const initial = first.apply({ type: "snapshot", revision: 1, conversationState: state });
    const updated = first.apply({ type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "replace", path: ["turns", 0, "items", 1, "text"], value: "Updated answer" }] });
    const reconnected = new DesktopStateReducer().apply({ type: "snapshot", revision: 7, conversationState: first.conversationState });
    expect(updated.messages.map((message) => message.id)).toEqual(initial.messages.map((message) => message.id));
    expect(reconnected.messages.map((message) => message.id)).toEqual(initial.messages.map((message) => message.id));
    expect(reconnected.messages.flatMap((message) => message.parts.map((part) => part.id))).toEqual(updated.messages.flatMap((message) => message.parts.map((part) => part.id)));
  });

  it("isolates generated input and error identities from native item identities", () => {
    const snapshot = convertDesktopConversation(conversation({ turns: [turn({ status: "failed", items: [
      { id: "turn-1:user", type: "userMessage", content: [{ type: "text", text: "Different input" }] },
      { id: "error", type: "userMessage", content: [{ type: "text", text: "Another input" }] },
    ] })] }));
    expect(new Set(snapshot.messages.map((message) => message.id)).size).toBe(snapshot.messages.length);
    expect(snapshot.messages[0].id).toContain(":input:");
    expect(snapshot.messages.at(-1)?.id).toContain(":error:");
    expect(snapshot.messages.at(-1)?.engineMeta).toMatchObject({ codexThreadId: "thread-1", codexTurnId: "turn-1" });
  });
});

describe("DesktopStateReducer", () => {
  it("replays reasoning text patches and reconnect snapshots without accumulating empty thinking messages", () => {
    const reducer = new DesktopStateReducer();
    const initial = reducer.apply({ type: "snapshot", revision: 1, conversationState: conversation({ turns: [turn({ items: [
      { id: "reasoning-1", type: "reasoning", summary: [], content: [] },
    ] })] }) });
    expect(initial.messages.filter((message) => message.parts.some((part) => part.type === "reasoning"))).toEqual([]);
    const started = reducer.apply({ type: "patches", baseRevision: 1, revision: 2, patches: [
      { op: "add", path: ["turns", 0, "items", 0, "summary", 0], value: "Inspect" },
    ] });
    const updated = reducer.apply({ type: "patches", baseRevision: 2, revision: 3, patches: [
      { op: "replace", path: ["turns", 0, "items", 0, "summary", 0], value: "Inspect the repository" },
      { op: "add", path: ["turns", 0, "items", 1], value: { id: "reasoning-2", type: "reasoning", summary: [], content: [] } },
    ] });
    const completed = reducer.apply({ type: "patches", baseRevision: 3, revision: 4, patches: [
      { op: "replace", path: ["turns", 0, "status"], value: "completed" },
    ] });
    const reconnected = new DesktopStateReducer().apply({ type: "snapshot", revision: 9, conversationState: reducer.conversationState });
    const reasoning = (snapshot: typeof initial) => snapshot.messages.filter((message) => message.parts.some((part) => part.type === "reasoning"));
    for (const snapshot of [started, updated, completed, reconnected]) {
      expect(reasoning(snapshot)).toHaveLength(1);
      expect(reasoning(snapshot)[0].id).toBe(desktopMessageId("thread-1", "turn-1", "reasoning-1"));
      expect(reasoning(snapshot)[0].parts[0].id).toBe(reasoning(started)[0].parts[0].id);
    }
    expect(reasoning(updated)[0].parts[0]).toMatchObject({ text: "Inspect the repository" });
    expect(reasoning(completed)[0].time.completed).toBeDefined();
    expect(reconnected.messages).toEqual(completed.messages);
  });

  it("applies Desktop Immer array and field patches while preserving the input snapshot", () => {
    const initial = conversation({ turns: [turn()] });
    const reducer = new DesktopStateReducer();
    reducer.apply({ type: "snapshot", revision: 2, conversationState: initial });
    const result = reducer.apply({ type: "patches", baseRevision: 2, revision: 3, patches: [
      { op: "replace", path: ["turns", 0, "items", 1, "text"], value: "Done" },
      { op: "add", path: ["turns", 0, "completedItemIds"], value: { "agent-1": true } },
      { op: "replace", path: ["turns", 0, "status"], value: "completed" },
      { op: "replace", path: ["turns", 0, "durationMs"], value: 1_000 },
    ], acceptedTextChanges: [] });
    expect(result.messages[1].parts[0]).toMatchObject({ text: "Done" });
    expect(result.messages[1].time.completed).toBe(3_000);
    expect(reducer.revision).toBe(3);
    expect(initial.turns[0].items[1]).toMatchObject({ text: "Working" });
  });

  it("removes approvals when another client resolves them", () => {
    const reducer = new DesktopStateReducer();
    reducer.apply({ type: "snapshot", revision: 1, conversationState: conversation({ requests: [
      { id: "req-1", method: "item/fileChange/requestApproval", params: { threadId: "thread-1", itemId: "patch" } },
    ] }) });
    const result = reducer.apply({ type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "remove", path: ["requests", 0] }] });
    expect(result.pendingRequests).toEqual([]);
    expect(result.permissions).toEqual([]);
    expect(result.session.activityStatus).toBe("idle");
  });

  it("accepts an Immer replacement for a field omitted from the JSON snapshot", () => {
    const reducer = new DesktopStateReducer();
    reducer.apply({ type: "snapshot", revision: 1, conversationState: conversation() });
    const result = reducer.apply({ type: "patches", baseRevision: 1, revision: 2, patches: [
      { op: "replace", path: ["latestThreadSettings"], value: { model: "selected-model", effort: "high" } },
    ] });
    expect(result.session).toMatchObject({ modelId: "selected-model", reasoningEffort: "high" });
  });

  it("rejects revision gaps and recovers from an authoritative snapshot", () => {
    const reducer = new DesktopStateReducer();
    reducer.apply({ type: "snapshot", revision: 4, conversationState: conversation() });
    expect(() => reducer.apply({ type: "patches", baseRevision: 5, revision: 6, patches: [] })).toThrow(DesktopStateRevisionError);
    expect(reducer.revision).toBe(4);
    reducer.apply({ type: "snapshot", revision: 7, conversationState: conversation({ title: "Refreshed" }) });
    expect(reducer.snapshot?.session.title).toBe("Refreshed");
    expect(reducer.revision).toBe(7);
  });

  it("rejects malformed patches atomically and blocks prototype mutation", () => {
    const reducer = new DesktopStateReducer();
    reducer.apply({ type: "snapshot", revision: 1, conversationState: conversation() });
    expect(() => reducer.apply({ type: "patches", baseRevision: 1, revision: 2, patches: [
      { op: "replace", path: ["title"], value: "Changed" },
      { op: "replace", path: ["missing", "text"], value: "lost" },
    ] })).toThrow(DesktopStateRevisionError);
    expect(reducer.snapshot?.session.title).toBe("Shared task");
    expect(reducer.revision).toBe(1);
    expect(() => reducer.apply({ type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "add", path: ["__proto__", "polluted"], value: true }] })).toThrow(DesktopStateRevisionError);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("does not mix identities across followed conversations", () => {
    const reducer = new DesktopStateReducer();
    reducer.apply({ type: "snapshot", revision: 1, conversationState: conversation() });
    expect(() => reducer.apply({ type: "snapshot", revision: 2, conversationState: conversation({ id: "thread-2" }) })).toThrow(DesktopStateRevisionError);
    expect(reducer.snapshot?.session.id).toBe("thread-1");
    reducer.reset();
    expect(reducer.revision).toBeUndefined();
    expect(reducer.snapshot).toBeUndefined();
    expect(reducer.apply({ type: "snapshot", revision: 0, conversationState: conversation({ id: "thread-2" }) }).session.id).toBe("thread-2");
  });
});
