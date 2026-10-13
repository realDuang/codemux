import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDesktopOwnerState, CodexDesktopOwner,
  type CodexDesktopOwnerRuntime, type CodexOwnerRequestMethod,
} from "../../../../../electron/main/engines/codex/desktop-owner";
import type {
  DesktopFollowerMethod, DesktopOwnedThreadRegistration, DesktopThreadOwner,
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
    state, transport, registrations, bridge, readThread, readMetadata, request, respond, updateSettings, unsubscribe, errors,
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
});

describe("CodexDesktopOwner", () => {
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
