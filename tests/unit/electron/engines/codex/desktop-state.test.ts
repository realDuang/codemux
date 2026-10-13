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
      { id: "blank", type: "reasoning", summary: [{ type: "summaryText", text: " \n " }], content: ["\t"] },
      { id: "readable", type: "reasoning", summary: [{ type: "summaryText", text: "Inspect the repository" }], content: [] },
      { id: "command", type: "commandExecution", command: "pwd", status: "completed", aggregatedOutput: "/repo", exitCode: 0 },
      { id: "another-empty", type: "reasoning", summary: [""], content: [] },
      { id: "answer", type: "agentMessage", text: "Fixed", phase: "final_answer" },
    ] })] });
    const before = structuredClone(state);
    const result = convertDesktopConversation(state);
    expect(result.messages.map((message) => message.engineMeta?.codexItemId)).toEqual(["turn-1:user", "readable", "command", "answer"]);
    expect(result.messages[1].parts[0]).toMatchObject({ type: "reasoning", text: "Inspect the repository" });
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
    expect(result.messages[1].parts[0]).toMatchObject({ type: "reasoning", text: "Inspect the repository\n\nThen identify the relevant test" });
    expect(result.messages[3].parts[0]).toMatchObject({ type: "reasoning", text: "Check the result" });
    expect(result.messages[1].id).not.toBe(result.messages[3].id);
  });

  it("deduplicates identical reasoning blocks across channels while retaining repetition within a channel", () => {
    const result = convertDesktopConversation(conversation({ turns: [turn({ items: [
      { id: "reasoning", type: "reasoning", summary: ["Check the tests", "Check the tests"], content: [{ type: "reasoningText", text: "Check the tests" }, { text: "Read the output" }] },
    ] })] }));
    expect(result.messages[1].parts[0]).toMatchObject({ type: "reasoning", text: "Check the tests\n\nCheck the tests\n\nRead the output" });
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
