import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDesktopOwnerState, CodexDesktopOwner,
  type CodexDesktopOwnerRuntime, type CodexOwnerRequestMethod,
} from "../../../../../electron/main/engines/codex/desktop-owner";
import type {
  DesktopFollowerMethod, DesktopOwnedThreadRegistration, DesktopQueuedFollowUp, DesktopThreadOwner,
} from "../../../../../electron/main/engines/codex/desktop-ipc-client";
import { convertDesktopConversation } from "../../../../../electron/main/engines/codex/desktop-state";

function nativeState() {
  return {
    thread: {
      id: "thread-created", cwd: "/repo", name: "New task", createdAt: 10, updatedAt: 12,
      source: "appServer", status: { type: "idle" },
      turns: [] as Array<Record<string, unknown>>,
    },
    model: "custom-model", modelProvider: "modelhub", reasoningEffort: "high",
    approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/repo"] },
    requests: [] as Array<{ id: string | number; method: string; params: Record<string, unknown> }>,
  };
}

function harness(metadataEnabled = false) {
  const state = nativeState();
  const registrations = new Map<string, DesktopOwnedThreadRegistration>();
  const transport = {
    clientId: "codemux-owner",
    connect: vi.fn(async () => {}),
    discoverOwner: vi.fn(async (): Promise<DesktopThreadOwner | null> => null),
    registerOwnedThread: vi.fn((registration: DesktopOwnedThreadRegistration) => {
      registrations.set(registration.conversationId, registration);
      return () => { registrations.delete(registration.conversationId); };
    }),
    publishOwnedThreadState: vi.fn(),
    publishOwnedQueuedFollowUps: vi.fn(),
  };
  let listener: ((sessionId: string) => void) | undefined;
  const unsubscribe = vi.fn();
  const readThread = vi.fn(async () => structuredClone(state));
  const readMetadata = vi.fn(async () => ({ id: state.thread.id, name: state.thread.name, updatedAt: state.thread.updatedAt }));
  const request = vi.fn(async (_sessionId: string, _method: CodexOwnerRequestMethod, _params: Record<string, unknown>): Promise<unknown> => ({}));
  const respond = vi.fn(async (_sessionId: string, id: string | number, _result: unknown) => {
    state.requests = state.requests.filter((request) => request.id !== id);
  });
  const updateSettings = vi.fn(async () => true);
  const runtime: CodexDesktopOwnerRuntime = {
    readThread, request, respond, updateSettings,
    ...(metadataEnabled ? { readMetadata } : {}),
    subscribe: (next) => { listener = next; return unsubscribe; },
  };
  const errors: Error[] = [];
  const bridge = new CodexDesktopOwner(transport, runtime, { onError: (_threadId, error) => errors.push(error) });
  return {
    state, transport, registrations, bridge, runtime, readThread, readMetadata, request, respond, updateSettings, unsubscribe, errors,
    changed: () => listener?.("codex_thread-created"),
    call: (method: DesktopFollowerMethod, params: Record<string, unknown> = {}) => {
      const registration = registrations.get("thread-created");
      if (!registration) throw new Error("Test thread was not registered");
      return registration.handleRequest(method, { conversationId: "thread-created", ...params }, { sourceClientId: "desktop-follower" });
    },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("buildDesktopOwnerState", () => {
  it("preserves native identities and ModelHub metadata in Desktop's accepted snapshot shape", () => {
    const native = nativeState();
    native.thread.turns.push({ id: "turn-1", status: "completed", startedAt: 11, completedAt: 12, durationMs: 1000, items: [
      { id: "user-1", type: "userMessage", clientId: "client-user-1", content: [{ type: "text", text: "Hello" }] },
      { id: "answer-1", type: "agentMessage", text: "Hello back", phase: "final_answer" },
    ] });
    const state = buildDesktopOwnerState(native);
    const converted = convertDesktopConversation(state);
    expect(state).toMatchObject({ id: "thread-created", hostId: "local", modelProvider: "modelhub", resumeState: "resumed", createdAt: 10_000 });
    expect(converted.messages.map((message) => message.engineMeta?.codexItemId)).toEqual(["user-1", "answer-1"]);
    expect(converted.messages[1]).toMatchObject({ modelId: "custom-model", providerId: "modelhub", engineMeta: { codexTurnId: "turn-1" }, time: { created: 11_000, completed: 12_000 } });
    expect(converted.incompleteHistory).toBe(false);
    expect(native.thread.turns[0]).not.toHaveProperty("turnId");
  });

  it("maps observed item completion and diff only to their native turn while preserving thread usage", () => {
    const native = nativeState();
    native.thread.turns.push(
      { id: "turn-previous", status: "completed", items: [] },
      { id: "turn-active", status: "inProgress", startedAt: 11, items: [
        { id: "reasoning-1", type: "reasoning", summary: ["Checked the files"], content: [] },
        { id: "answer-1", type: "agentMessage", text: "Checking the result", phase: "commentary" },
      ] },
    );
    const latestTokenUsageInfo = { total: { inputTokens: 100, outputTokens: 20 }, last: { inputTokens: 40, outputTokens: 10 } };
    const observed = {
      completedItemIds: { "reasoning-1": true, "answer-1": true, "running-tool": false },
      agentMessageCompletedAtMsById: { "answer-1": 11_250 },
      diff: "diff --git a/file.ts b/file.ts",
    };
    const state = buildDesktopOwnerState({ ...native, latestTokenUsageInfo, turnStateById: { "turn-active": observed } });
    const turns = state.turns as Array<Record<string, unknown>>;
    expect(state.latestTokenUsageInfo).toEqual(latestTokenUsageInfo);
    expect(turns[0]).toMatchObject({ turnId: "turn-previous", diff: null });
    expect(turns[0]).not.toHaveProperty("completedItemIds");
    expect(turns[0]).not.toHaveProperty("agentMessageCompletedAtMsById");
    expect(turns[1]).toMatchObject({ turnId: "turn-active", ...observed });
    expect(turns[1].completedItemIds).not.toBe(observed.completedItemIds);
    expect(turns[1].agentMessageCompletedAtMsById).not.toBe(observed.agentMessageCompletedAtMsById);
    const converted = convertDesktopConversation(state);
    expect(converted.messages.find((message) => message.engineMeta?.codexItemId === "answer-1")?.time.completed).toBe(11_250);
    expect(converted.isActive).toBe(true);
  });

  it("leaves absent runtime metadata unknown instead of inferring item completion", () => {
    const native = nativeState();
    native.thread.turns.push({ id: "turn-active", status: "inProgress", items: [
      { id: "reasoning-1", type: "reasoning", summary: ["Checked the files"], content: [] },
      { id: "command-1", type: "commandExecution", command: "pwd", status: "inProgress" },
    ] });
    const state = buildDesktopOwnerState(native);
    const turn = (state.turns as Array<Record<string, unknown>>)[0];
    expect(state.latestTokenUsageInfo).toBeNull();
    expect(turn.diff).toBeNull();
    expect(turn).not.toHaveProperty("completedItemIds");
    expect(turn).not.toHaveProperty("agentMessageCompletedAtMsById");
    expect(convertDesktopConversation(state).messages[0].time.completed).toBeUndefined();
  });
});

describe("CodexDesktopOwner", () => {
  it("admits the native Desktop composer queue before consuming its original message ID", async () => {
    const h = harness();
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    const queued: DesktopQueuedFollowUp = {
      id: "native-user-1", text: "Continue", context: {}, cwd: "/repo", createdAt: 1,
      submission: { hostId: "local", status: "pending" },
    };
    let admit!: (value: unknown) => void;
    h.request.mockImplementation(() => new Promise((resolve) => { admit = resolve; }));
    expect(h.registrations.get("thread-created")?.supportedMethods).toContain("thread-follower-set-queued-follow-ups-state");
    expect(h.registrations.get("thread-created")?.clientName).toBe("CodeMux");
    expect(await h.call("thread-follower-set-queued-follow-ups-state", { state: { "thread-created": [queued] }, discardedMessageIds: [] })).toEqual({ ok: true });
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledOnce());
    expect(h.request).toHaveBeenCalledWith("codex_thread-created", "turn/start", expect.objectContaining({
      threadId: "thread-created", clientUserMessageId: "native-user-1", input: [{ type: "text", text: "Continue" }],
    }));
    expect(h.registrations.get("thread-created")?.getQueuedFollowUps?.()).toHaveLength(1);
    await h.call("thread-follower-set-queued-follow-ups-state", { state: { "thread-created": [queued] }, discardedMessageIds: [] });
    admit({ turn: { id: "native-turn", status: "inProgress", items: [] } });
    await vi.waitFor(() => expect(h.registrations.get("thread-created")?.getQueuedFollowUps?.()).toEqual([]));
    expect(h.transport.publishOwnedQueuedFollowUps).toHaveBeenLastCalledWith("thread-created", []);
    await h.call("thread-follower-set-queued-follow-ups-state", { state: { "thread-created": [queued] }, discardedMessageIds: [] });
    expect(h.request).toHaveBeenCalledOnce();
    h.bridge.dispose();
  });

  it("keeps queued input during an active turn and starts it after the original runtime completes", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.state.thread.turns.push({ id: "current-turn", status: "inProgress", items: [] });
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    const queued = { id: "next-input", text: "Next", context: {}, createdAt: 2, submission: { hostId: "local", status: "pending" } };
    await h.call("thread-follower-set-queued-follow-ups-state", { state: { "thread-created": [queued] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.registrations.get("thread-created")?.getQueuedFollowUps?.()).toEqual([queued]);
    h.state.thread.turns[0].status = "completed";
    h.changed();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.registrations.get("thread-created")?.getQueuedFollowUps?.()).toEqual([]);
    h.bridge.dispose();
  });

  it("uses canonical composer input and settings, and steers send-now input into its active turn", async () => {
    const h = harness();
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    const collaborationMode = { mode: "default", settings: { model: "selected-model", reasoning_effort: "low", developer_instructions: null } };
    const queued = { id: "selected-input", text: "Display preview", context: { prompt: "Actual prompt", messageThreadId: "thread-created" },
      createdAt: 2, submissionIntent: "start", submission: { hostId: "local", status: "pending" },
      submissionOptions: { collaborationMode, serviceTier: "priority" } };
    await h.call("thread-follower-set-queued-follow-ups-state", { state: { "thread-created": [queued] } });
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledOnce());
    expect(h.request).toHaveBeenCalledWith("codex_thread-created", "turn/start", expect.objectContaining({
      input: [{ type: "text", text: "Actual prompt" }], collaborationMode, serviceTier: "priority",
    }));
    await vi.waitFor(() => expect(h.registrations.get("thread-created")?.getQueuedFollowUps?.()).toEqual([]));
    h.state.thread.turns.push({ id: "active-turn", status: "inProgress", items: [] });
    await h.call("thread-follower-set-queued-follow-ups-state", { state: { "thread-created": [{ ...queued,
      id: "steering-input", submissionOptions: undefined, submissionIntent: "send-now",
    }] } });
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledTimes(2));
    expect(h.request).toHaveBeenLastCalledWith("codex_thread-created", "turn/steer", expect.objectContaining({
      expectedTurnId: "active-turn", clientUserMessageId: "steering-input", input: [{ type: "text", text: "Actual prompt" }],
    }));
    h.bridge.dispose();
  });

  it("resolves the native custom permission selection before accepting the queued turn", async () => {
    const h = harness();
    const permissions = { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" };
    const resolvePermissions = vi.fn(async () => permissions);
    h.runtime.resolveQueuedPermissions = resolvePermissions;
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    const queued = { id: "custom-input", text: "Continue", context: {}, createdAt: 2,
      submissionOptions: { permissionSelection: { kind: "custom" } } };
    await h.call("thread-follower-set-queued-follow-ups-state", { state: { "thread-created": [queued] } });
    expect(resolvePermissions).toHaveBeenCalledExactlyOnceWith("codex_thread-created", queued);
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("codex_thread-created", "turn/start", expect.objectContaining(permissions)));
    h.bridge.dispose();
  });

  it("retains uncertain admissions across queue edits without replaying and accepts an explicit discard", async () => {
    const h = harness();
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    h.request.mockRejectedValue(new Error("request-timeout"));
    const queued = { id: "uncertain-input", text: "Next", context: {}, createdAt: 2, submission: { hostId: "local", status: "pending" } };
    await h.call("thread-follower-set-queued-follow-ups-state", { state: { "thread-created": [queued] } });
    await vi.waitFor(() => expect(h.errors).toHaveLength(1));
    expect(h.registrations.get("thread-created")?.getQueuedFollowUps?.()).toEqual([
      { ...queued, submission: { hostId: "local", status: "outcome-unknown" } },
    ]);
    await h.call("thread-follower-set-queued-follow-ups-state", { state: { "thread-created": [] } });
    expect(h.registrations.get("thread-created")?.getQueuedFollowUps?.()).toHaveLength(1);
    await h.call("thread-follower-set-queued-follow-ups-state", { state: { "thread-created": [] }, discardedMessageIds: [queued.id] });
    expect(h.registrations.get("thread-created")?.getQueuedFollowUps?.()).toEqual([]);
    expect(h.request).toHaveBeenCalledOnce();
    h.bridge.dispose();
  });

  it("rejects unsupported attachment input before acknowledging or replacing a queue", async () => {
    const h = harness();
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    await expect(h.call("thread-follower-set-queued-follow-ups-state", { state: { "thread-created": [{
      id: "image-input", text: "Read this", createdAt: 2, context: { imageAttachments: [{ path: "/private/image.png" }] },
    }] } })).rejects.toThrow("attachments");
    expect(h.request).not.toHaveBeenCalled();
    expect(h.registrations.get("thread-created")?.getQueuedFollowUps?.()).toEqual([]);
    h.bridge.dispose();
  });

  it("removes and clears waiting input without cancelling the original turn", async () => {
    const h = harness();
    h.state.thread.turns.push({ id: "current-turn", status: "inProgress", items: [] });
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    const queued = ["first", "second"].map((id) => ({ id, text: id, context: {}, createdAt: 2 }));
    await h.call("thread-follower-set-queued-follow-ups-state", { state: { "thread-created": queued } });
    await h.call("thread-follower-remove-queued-message", { messageId: "first" });
    expect(h.registrations.get("thread-created")?.getQueuedFollowUps?.()).toEqual([queued[1]]);
    await h.call("thread-follower-clear-queued-messages");
    expect(h.registrations.get("thread-created")?.getQueuedFollowUps?.()).toEqual([]);
    expect(h.request).not.toHaveBeenCalled();
    h.bridge.dispose();
  });

  it("keeps waiting input after a stale stop but cancels it after the active user stop", async () => {
    const h = harness();
    h.state.thread.turns.push({ id: "current-turn", status: "inProgress", items: [] });
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    const queued = { id: "waiting", text: "Next", context: {}, createdAt: 2 };
    await h.call("thread-follower-set-queued-follow-ups-state", { state: { "thread-created": [queued] } });
    await h.call("thread-follower-interrupt-turn", { expectedTurnId: "stale", mode: "user-stop" });
    expect(h.registrations.get("thread-created")?.getQueuedFollowUps?.()).toHaveLength(1);
    await h.call("thread-follower-interrupt-turn", { expectedTurnId: "current-turn", mode: "user-stop" });
    expect(h.registrations.get("thread-created")?.getQueuedFollowUps?.()).toEqual([]);
    expect(h.request).toHaveBeenCalledExactlyOnceWith("codex_thread-created", "turn/interrupt", { threadId: "thread-created", turnId: "current-turn" });
    h.bridge.dispose();
  });

  it("polls metadata only for registered threads and refreshes full state only when the title changes", async () => {
    vi.useFakeTimers();
    const h = harness(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.readMetadata).not.toHaveBeenCalled();
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.readMetadata).toHaveBeenCalledExactlyOnceWith("codex_thread-created");
    expect(h.readThread).toHaveBeenCalledOnce();
    h.state.thread.updatedAt += 1;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.readThread).toHaveBeenCalledOnce();
    h.state.thread.name = "Renamed from official Desktop";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.readThread).toHaveBeenCalledTimes(2);
    expect(h.transport.publishOwnedThreadState).toHaveBeenCalledExactlyOnceWith("thread-created", expect.objectContaining({ conversationState: expect.objectContaining({ title: "Renamed from official Desktop" }) }));
    h.bridge.dispose();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.readMetadata).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not enable metadata polling for runtimes without that optional method", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.readMetadata).not.toHaveBeenCalled();
    expect(h.readThread).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    h.bridge.dispose();
  });

  it("does not overlap metadata reads or publish a read that completes after disposal", async () => {
    vi.useFakeTimers();
    const h = harness(true);
    let resolve!: (metadata: { id: string; name: string; updatedAt: number }) => void;
    h.readMetadata.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.readMetadata).toHaveBeenCalledOnce();
    h.bridge.dispose();
    resolve({ id: "thread-created", name: "Late title", updatedAt: 99 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.readThread).toHaveBeenCalledOnce();
    expect(h.transport.publishOwnedThreadState).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
  });

  it("ignores metadata with a different thread identity", async () => {
    vi.useFakeTimers();
    const h = harness(true);
    h.readMetadata.mockResolvedValue({ id: "other-thread", name: "Other title", updatedAt: 99 });
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.errors).toHaveLength(1);
    expect(h.readThread).toHaveBeenCalledOnce();
    expect(h.transport.publishOwnedThreadState).not.toHaveBeenCalled();
    h.bridge.dispose();
  });

  it("registers only the explicit new thread and never takes another client's ownership", async () => {
    const h = harness();
    h.transport.discoverOwner.mockResolvedValueOnce({ ownerClientId: "official-desktop", supportsUntrustedAppInput: true });
    await expect(h.bridge.registerCreatedThread("codex_thread-created", "thread-created")).rejects.toThrow("owned by another");
    expect(h.readThread).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.registrations.size).toBe(0);
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    expect(h.registrations.get("thread-created")?.getSnapshot()).toMatchObject({ type: "snapshot", revision: 0, conversationState: { id: "thread-created" } });
    expect(h.registrations.get("thread-created")?.supportedMethods).not.toContain("thread-follower-update-daybreak");
    h.bridge.dispose();
  });

  it("returns the native start admission while execution remains owned by the existing runtime", async () => {
    const h = harness();
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    const nativeResult = { turn: { id: "turn-1", status: "inProgress", items: [] } };
    h.request.mockImplementation(async (_sessionId, _method, params) => {
      h.state.thread.turns.push({ ...nativeResult.turn, items: [{ id: "user-1", type: "userMessage", content: params.input }] });
      return nativeResult;
    });
    const result = await h.call("thread-follower-start-turn", { turnStart: { request: { threadId: "thread-created", input: [{ type: "text", text: "Continue" }] } } });
    expect(result).toEqual({ result: nativeResult });
    expect(h.request).toHaveBeenCalledExactlyOnceWith("codex_thread-created", "turn/start", { threadId: "thread-created", input: [{ type: "text", text: "Continue" }] });
    expect(h.transport.publishOwnedThreadState).toHaveBeenCalledWith("thread-created", expect.objectContaining({ revision: 1 }));
    await expect(h.call("thread-follower-start-turn", { turnStart: { request: { threadId: "foreign-thread", input: [] } } })).rejects.toThrow("another thread");
    expect(h.request).toHaveBeenCalledTimes(1);
    h.bridge.dispose();
  });

  it("steers the active turn and ignores a stale interrupt identity", async () => {
    const h = harness();
    h.state.thread.turns.push({ id: "turn-active", status: "inProgress", items: [] });
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    await h.call("thread-follower-steer-turn", { input: [{ type: "text", text: "Add tests" }], clientUserMessageId: "user-input" });
    expect(h.request).toHaveBeenLastCalledWith("codex_thread-created", "turn/steer", { threadId: "thread-created", expectedTurnId: "turn-active", input: [{ type: "text", text: "Add tests" }], clientUserMessageId: "user-input" });
    expect(await h.call("thread-follower-interrupt-turn", { expectedTurnId: "old-turn", mode: "user-stop" })).toEqual({ ok: true, interruptedTurnId: null });
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(await h.call("thread-follower-interrupt-turn", { expectedTurnId: "turn-active", mode: "user-stop" })).toEqual({ ok: true, interruptedTurnId: "turn-active" });
    expect(h.request).toHaveBeenLastCalledWith("codex_thread-created", "turn/interrupt", { threadId: "thread-created", turnId: "turn-active" });
    h.bridge.dispose();
  });

  it("rejects an async answer when refreshing the owner has advanced to another turn", async () => {
    const h = harness();
    const question = { id: "old-question", type: "agentMessage", questions: [{ title: "Deploy staging?" }] };
    h.state.thread.turns.push({ id: "turn-old", status: "inProgress", items: [question] });
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    h.state.thread.turns[0].status = "completed";
    h.state.thread.turns.push({ id: "turn-new", status: "inProgress", items: [] });
    const text = `<send_user_message_question_reply>\n${JSON.stringify([{
      questionItemId: JSON.stringify(["request_user_input_async", "old-question", 0]), question: "Deploy staging?", answer: "Yes",
    }])}\n</send_user_message_question_reply>`;
    try {
      await expect(h.call("thread-follower-steer-turn", {
        input: [{ type: "text", text }], restoreMessage: { context: { turnTrigger: "send_user_message_async_question" } },
      })).rejects.toThrow("no longer belongs to the active Codex turn");
      expect(h.request).not.toHaveBeenCalled();
    } finally {
      h.bridge.dispose();
    }
  });

  it("retains explicit async answer intent for the runtime's active-turn validation", async () => {
    const h = harness();
    h.state.thread.turns.push({ id: "turn-active", status: "inProgress", items: [
      { id: "question", type: "agentMessage", questions: [{ title: "Continue?" }] },
    ] });
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    const input = [{ type: "text", text: `<send_user_message_question_reply>\n${JSON.stringify([{
      questionItemId: JSON.stringify(["request_user_input_async", "question", 0]), question: "Continue?", answer: "Yes",
    }])}\n</send_user_message_question_reply>` }];
    const restoreMessage = { context: { turnTrigger: "send_user_message_async_question" } };
    try {
      await h.call("thread-follower-steer-turn", { input, restoreMessage });
      expect(h.request).toHaveBeenCalledWith("codex_thread-created", "turn/steer", {
        threadId: "thread-created", expectedTurnId: "turn-active", input, restoreMessage,
      });
    } finally {
      h.bridge.dispose();
    }
  });

  it("routes approvals only to the matching pending native request and publishes their removal", async () => {
    const h = harness();
    h.state.requests.push({ id: 42, method: "item/commandExecution/requestApproval", params: { threadId: "thread-created", turnId: "turn-1", itemId: "cmd", command: "pwd" } });
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    await expect(h.call("thread-follower-file-approval-decision", { requestId: 42, decision: "accept" })).rejects.toThrow("no longer pending");
    await expect(h.call("thread-follower-command-approval-decision", { requestId: "42", decision: "accept" })).rejects.toThrow("no longer pending");
    expect(h.respond).not.toHaveBeenCalled();
    expect(await h.call("thread-follower-command-approval-decision", { requestId: 42, decision: "accept" })).toEqual({ ok: true });
    expect(h.respond).toHaveBeenCalledWith("codex_thread-created", 42, { decision: "accept" });
    expect(h.registrations.get("thread-created")?.getSnapshot().conversationState.requests).toEqual([]);
    h.bridge.dispose();
  });

  it.each([
    { firstId: 42, remainingId: "42" },
    { firstId: "42", remainingId: 42 },
  ])("keeps numeric and string approval IDs distinct when replying to $firstId first", async ({ firstId, remainingId }) => {
    const h = harness();
    const requests = [42, "42"].map((id) => ({
      id, method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-created", turnId: "turn-1", itemId: `cmd-${typeof id}`, command: "pwd" },
    }));
    h.state.requests.push(...requests);
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");

    expect(await h.call("thread-follower-command-approval-decision", { requestId: firstId, decision: "accept" })).toEqual({ ok: true });
    expect(h.respond).toHaveBeenNthCalledWith(1, "codex_thread-created", firstId, { decision: "accept" });
    const remaining = requests.filter((request) => request.id === remainingId);
    expect(h.state.requests).toEqual(remaining);
    expect(h.registrations.get("thread-created")?.getSnapshot().conversationState.requests).toEqual(remaining);

    expect(await h.call("thread-follower-command-approval-decision", { requestId: remainingId, decision: "decline" })).toEqual({ ok: true });
    expect(h.respond).toHaveBeenNthCalledWith(2, "codex_thread-created", remainingId, { decision: "decline" });
    expect(h.respond).toHaveBeenCalledTimes(2);
    expect(h.state.requests).toEqual([]);
    expect(h.registrations.get("thread-created")?.getSnapshot().conversationState.requests).toEqual([]);
    h.bridge.dispose();
  });

  it("coalesces change events and detaches without stopping or answering the runtime", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    h.state.thread.name = "Renamed in CodeMux";
    h.changed(); h.changed(); h.changed();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.readThread).toHaveBeenCalledTimes(2);
    expect(h.transport.publishOwnedThreadState).toHaveBeenCalledTimes(1);
    h.bridge.dispose();
    h.changed();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.registrations.size).toBe(0);
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.respond).not.toHaveBeenCalled();
  });

  it("refreshes settings and complete history through the original runtime", async () => {
    const h = harness();
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    expect(await h.call("thread-follower-read-model-settings")).toEqual({ settings: { model: "custom-model", reasoningEffort: "high", daybreakEnabled: null, resumeState: "resumed", mode: "default", threadSource: null, modelProvider: "modelhub" } });
    expect(await h.call("thread-follower-update-thread-settings", { threadSettings: { model: "another-model" }, condition: { ifModelEquals: "custom-model" } })).toEqual({ applied: true });
    expect(h.updateSettings).toHaveBeenCalledWith("codex_thread-created", { model: "another-model" }, { activeTurnId: undefined, condition: { ifModelEquals: "custom-model" } });
    expect(await h.call("thread-follower-load-complete-history")).toEqual({ revision: 0 });
    expect(h.transport.publishOwnedThreadState).toHaveBeenCalledOnce();
    h.bridge.dispose();
  });

  it("relinquishes registration if another owner appeared during an IPC disconnect", async () => {
    const h = harness();
    await h.bridge.registerCreatedThread("codex_thread-created", "thread-created");
    h.transport.discoverOwner.mockResolvedValueOnce({ ownerClientId: "another-client", supportsUntrustedAppInput: false });
    await h.bridge.reconnect();
    expect(h.registrations.size).toBe(0);
    expect(h.errors).toHaveLength(1);
    expect(h.request).not.toHaveBeenCalled();
    h.bridge.dispose();
  });
});
