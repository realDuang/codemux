import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { spawn, execFileSync } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexDesktopAdapter } from "../../../../../electron/main/engines/codex/desktop-adapter";
import type { CodexDesktopIpcClient, DesktopSteerOptions, DesktopThreadSnapshot, DesktopThreadSettingsPatch, DesktopThreadSettingsOptions, DesktopThreadOwner } from "../../../../../electron/main/engines/codex/desktop-ipc-client";
import { desktopMessageId, desktopRequestId, type DesktopStateChange } from "../../../../../electron/main/engines/codex/desktop-state";
import type { ImportableSession, UnifiedMessage } from "../../../../../src/types/unified";

vi.mock("child_process", () => ({
  spawn: vi.fn(() => { throw new Error("Desktop followers must not spawn a process"); }),
  execFileSync: vi.fn(() => { throw new Error("Desktop followers must not execute a CLI"); }),
}));

const THREAD = "existing-desktop-thread";
const OWNER = "desktop-owner";

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: THREAD, hostId: "local", cwd: "/repo", title: "Shared task",
    createdAt: 1000, updatedAt: 3000, resumeState: "resumed",
    latestModel: "custom-model", modelProvider: "ModelHub",
    latestCollaborationMode: { mode: "default", settings: { model: "custom-model" } },
    turns: [], requests: [], ...overrides,
  };
}

function turn(id: string, status = "completed", overrides: Record<string, unknown> = {}) {
  return {
    turnId: id, status, turnStartedAtMs: 2000, durationMs: status === "completed" ? 1000 : null,
    params: { threadId: THREAD, input: [{ type: "text", text: "Initial prompt" }], cwd: "/repo", model: "custom-model" },
    items: [
      { id: `${id}-user`, type: "userMessage", content: [{ type: "text", text: "Initial prompt" }] },
      { id: `${id}-answer`, type: "agentMessage", text: status === "completed" ? "Done" : "Working", phase: "final_answer" },
    ], ...overrides,
  };
}

class MockDesktopClient extends EventEmitter {
  connected = true;
  clientId = "test-ipc-client";
  initialState = conversation();
  connect = vi.fn(async () => { this.connected = true; });
  close = vi.fn(() => { this.connected = false; this.emit("close"); });
  discoverOwner = vi.fn(async (_id: string): Promise<DesktopThreadOwner | null> => ({ ownerClientId: OWNER, supportsUntrustedAppInput: true }));
  followThread = vi.fn(async (_id: string, _owner: string): Promise<DesktopThreadSnapshot> => ({ type: "snapshot", revision: 1, conversationState: this.initialState }));
  unfollowThread = vi.fn();
  loadCompleteHistory = vi.fn(async () => ({}));
  startTurn = vi.fn(async (_id: string, _owner: string, _request: Record<string, unknown>) => ({}));
  steerTurn = vi.fn(async (_id: string, _owner: string, _options: DesktopSteerOptions) => ({}));
  interruptTurn = vi.fn(async (_id: string, _owner: string, _turnId: string) => ({}));
  updateThreadSettings = vi.fn(async (_id: string, _owner: string, _patch: DesktopThreadSettingsPatch, _options?: DesktopThreadSettingsOptions) => ({ applied: true }));
  replyCommandApproval = vi.fn(async (_id: string, _owner: string, _requestId: string | number, _decision: unknown) => ({}));
  replyFileApproval = vi.fn(async (_id: string, _owner: string, _requestId: string | number, _decision: unknown) => ({}));
  replyPermissionsApproval = vi.fn(async (_id: string, _owner: string, _requestId: string | number, _response: unknown) => ({}));
  submitUserInput = vi.fn(async (_id: string, _owner: string, _requestId: string | number, _response: unknown) => ({}));
  compactThread = vi.fn(async (_id: string, _owner: string) => ({}));

  publish(change: DesktopStateChange): void {
    this.emit("stream", { conversationId: THREAD, hostId: "local", ownerClientId: OWNER, change });
  }
}

function observe(promise: Promise<UnifiedMessage>) {
  const state: { settled: boolean; message?: UnifiedMessage; error?: unknown } = { settled: false };
  void promise.then(
    (message) => { state.settled = true; state.message = message; },
    (error: unknown) => { state.settled = true; state.error = error; },
  );
  return state;
}

describe("CodexDesktopAdapter", () => {
  let client: MockDesktopClient;
  let adapter: CodexDesktopAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MockDesktopClient();
    adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient });
  });

  afterEach(async () => {
    await adapter.stop();
  });

  it("answers asynchronous choices through steering and waits for the accepted receipt", async () => {
    const ask = { id: "async-ask", type: "agentMessage", delivery: "async", text: "Choose.",
      questions: [{ title: "Which target?", options: ["Local", "Remote"] }, { title: "Any constraints?" }] };
    const active = turn("active", "inProgress", { items: [ask] });
    client.initialState = conversation({ turns: [active] });
    await adapter.start();
    await adapter.restoreSession(THREAD, "/repo");
    const question = (await adapter.getPendingQuestions(THREAD))[0];
    expect(question).toBeDefined();
    expect(question.dismissStopsTurn).toBe(false);
    let settled = false;
    const replying = adapter.replyQuestion(question.id, [["Local"], []], THREAD).then(() => { settled = true; });
    await vi.waitFor(() => expect(client.steerTurn).toHaveBeenCalledOnce());
    const options = client.steerTurn.mock.calls[0][2];
    expect(options.restoreMessage).toMatchObject({ context: { turnTrigger: "send_user_message_async_question" } });
    expect(client.submitUserInput).not.toHaveBeenCalled();
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(client.interruptTurn).not.toHaveBeenCalled();
    client.publish({ type: "snapshot", revision: 2, conversationState: conversation({ turns: [
      { ...active, items: [ask, { id: "reply", type: "steeringUserMessage", status: "pending", input: options.input }] },
    ] }) });
    expect(settled).toBe(false);
    expect((await adapter.getPendingQuestions(THREAD))[0].questions).toHaveLength(2);
    client.publish({ type: "snapshot", revision: 3, conversationState: conversation({ turns: [
      { ...active, items: [ask, { id: "reply", type: "steeringUserMessage", status: "accepted", input: options.input }] },
    ] }) });
    await replying;
    expect(settled).toBe(true);
    const remaining = await adapter.getPendingQuestions(THREAD);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).not.toBe(question.id);
    expect(remaining[0].questions.map(item => item.question)).toEqual(["Any constraints?"]);
    const messages = await adapter.listMessages(THREAD);
    expect(messages.find(message => message.engineMeta?.codexItemId === "reply")).toMatchObject({ role: "assistant" });
  });

  it("retains failed async answers for retry and dismisses locally without stopping the turn", async () => {
    const active = turn("active", "inProgress", { items: [
      { id: "async-ask", type: "agentMessage", questions: [{ title: "Which target?", options: ["Local", "Remote"] }] },
    ] });
    client.initialState = conversation({ turns: [active] });
    await adapter.start();
    await adapter.restoreSession(THREAD, "/repo");
    const question = (await adapter.getPendingQuestions(THREAD))[0];
    expect(question).toBeDefined();
    await expect(adapter.replyQuestion(question.id, [[]], THREAD)).rejects.toThrow();
    expect(client.steerTurn).not.toHaveBeenCalled();
    client.steerTurn.mockRejectedValueOnce(new Error("Owner rejected the reply"));
    await expect(adapter.replyQuestion(question.id, [["Local"]], THREAD)).rejects.toThrow("Owner rejected");
    expect((await adapter.getPendingQuestions(THREAD))[0].id).toBe(question.id);
    const replied = vi.fn();
    adapter.on("question.replied", replied);
    await adapter.rejectQuestion(question.id, THREAD);
    expect(replied).toHaveBeenCalledWith({ questionId: question.id, answers: [] });
    expect(await adapter.getPendingQuestions(THREAD)).toEqual([]);
    client.publish({ type: "snapshot", revision: 2, conversationState: conversation({ turns: [active] }) });
    expect(await adapter.getPendingQuestions(THREAD)).toEqual([]);
    expect(client.interruptTurn).not.toHaveBeenCalled();
    expect(client.submitUserInput).not.toHaveBeenCalled();
    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it("coalesces a completed owner miss across cold reads and retries after one second", async () => {
    let now = 1000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      client.discoverOwner.mockResolvedValue(null);
      const readStoredThread = vi.fn(async () => ({ thread: { id: THREAD, cwd: "/repo", createdAt: 1, updatedAt: 2, turns: [] }, archived: false }));
      const restoreThread = vi.fn(async () => THREAD);
      adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient, readStoredThread, restoreThread });
      await adapter.restoreSession(THREAD, "/repo", { catalogSourceId: "source", codexDesktopOwner: "codemux" });
      await adapter.listMessages(THREAD);
      await adapter.getSession(THREAD);
      expect(client.discoverOwner).toHaveBeenCalledOnce();
      expect(readStoredThread).toHaveBeenCalledTimes(3);
      expect(restoreThread).not.toHaveBeenCalled();
      now = 2001;
      await adapter.listMessages(THREAD);
      expect(client.discoverOwner).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });

  it.each(["completed-read", "pending-read"])("attaches the newly registered owner after creation races a %s", async (readState) => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    try {
      const readStoredThread = vi.fn(async () => ({ thread: { id: THREAD, cwd: "/repo", createdAt: 1, updatedAt: 2, turns: [] }, archived: false }));
      const createThread = vi.fn(async () => ({ threadId: THREAD, catalogSourceId: "source", projectId: null }));
      adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient, readStoredThread, createThread });
      let finishDiscovery: ((owner: DesktopThreadOwner | null) => void) | undefined;
      if (readState === "pending-read") client.discoverOwner.mockImplementationOnce(() => new Promise((resolve) => { finishDiscovery = resolve; }));
      else client.discoverOwner.mockResolvedValueOnce(null);
      // Catalog delivery can make another reader request the native ID before
      // createThread has registered the owner and returned to createSession.
      const reading = adapter.getSession(THREAD);
      if (readState === "completed-read") await reading;
      const created = expect(adapter.createSession("/repo", { catalogSourceId: "source" })).resolves.toMatchObject({
        id: THREAD, catalogSourceId: "source", projectId: null,
        engineMeta: { codexThreadId: THREAD, codexDesktopOwner: "codemux" },
      });
      finishDiscovery?.(null);
      await Promise.all([reading, created]);
      expect(createThread).toHaveBeenCalledOnce();
      expect(client.discoverOwner).toHaveBeenCalledTimes(2);
      expect(client.followThread).toHaveBeenCalledExactlyOnceWith(THREAD, OWNER);
      expect((await adapter.getSession(THREAD))?.catalogSourceId).toBe("source");
    } finally { clock.mockRestore(); }
  });

  it("retains a durable creation result when the registered owner disconnects before attachment", async () => {
    client.discoverOwner.mockResolvedValue(null);
    const createThread = vi.fn(async () => ({ threadId: THREAD, catalogSourceId: "source", projectId: null }));
    adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient, createThread,
      readStoredThread: async () => ({ thread: { id: THREAD, cwd: "/repo", createdAt: 1, updatedAt: 2, turns: [] }, archived: false }) });
    await expect(adapter.createSession("/repo", { catalogSourceId: "source" })).resolves.toMatchObject({
      id: THREAD, catalogSourceId: "source", projectId: null,
      engineMeta: { codexThreadId: THREAD, codexDesktopOwner: "codemux" },
    });
    expect(createThread).toHaveBeenCalledOnce();
    expect(client.followThread).not.toHaveBeenCalled();
  });

  it.each(["threadArchived", "threadUnarchived", "ipc-change", "disconnect"])("invalidates a recent miss after %s", async (event) => {
    client.discoverOwner.mockResolvedValue(null);
    const readStoredThread = vi.fn(async () => ({ thread: { id: THREAD, cwd: "/repo", createdAt: 1, updatedAt: 2, turns: [] }, archived: false }));
    adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient, readStoredThread });
    await adapter.getSession(THREAD);
    if (event === "ipc-change") client.clientId = "new-ipc-client";
    else if (event === "disconnect") client.close();
    else client.emit(event, { conversationId: THREAD });
    await adapter.getSession(THREAD);
    expect(client.discoverOwner).toHaveBeenCalledTimes(2);
  });

  it("never caches a failed owner discovery", async () => {
    client.discoverOwner.mockRejectedValue(new Error("ambiguous discovery timeout"));
    adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient,
      readStoredThread: async () => ({ thread: { id: THREAD }, archived: false }) });
    await expect(adapter.getSession(THREAD)).rejects.toThrow("ambiguous");
    await expect(adapter.getSession(THREAD)).rejects.toThrow("ambiguous");
    expect(client.discoverOwner).toHaveBeenCalledTimes(2);
  });

  it.each(["completed", "interrupted", "failed"])("preserves a stored %s turn's activity without a connected owner", async (status) => {
    client.discoverOwner.mockResolvedValue(null);
    const readStoredThread = vi.fn(async () => ({
      thread: { id: THREAD, cwd: "/repo", createdAt: 1, updatedAt: 2, turns: [
        { id: "stored-turn", status, items: [], ...(status === "failed" ? { error: { message: "Current turn failed" } } : {}) },
      ] },
      archived: false,
    }));
    adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient, readStoredThread });
    const updated = vi.fn();
    adapter.on("session.updated", updated);

    const session = await adapter.getSession(THREAD);
    const expected = status === "failed" ? "error" : "idle";
    expect(session?.activityStatus).toBe(expected);
    expect((await adapter.listSessions())[0].activityStatus).toBe(expected);
    expect(updated).toHaveBeenLastCalledWith({ session: expect.objectContaining({ activityStatus: expected }) });
    expect(adapter.hasSession(THREAD)).toBe(false);
    expect(client.followThread).not.toHaveBeenCalled();
    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it.each(["completed", "interrupted", "failed", "inProgress"])("preserves terminal %s activity when its owner disconnects", async (status) => {
    client.initialState = conversation({ turns: [turn("latest-turn", status)] });
    await adapter.attachThread(THREAD);
    const updated = vi.fn();
    adapter.on("session.updated", updated);

    client.emit("ownerDisconnected", OWNER);

    const expected = status === "failed" || status === "inProgress" ? "error" : "idle";
    expect((await adapter.listSessions())[0].activityStatus).toBe(expected);
    expect(updated).toHaveBeenLastCalledWith({ session: expect.objectContaining({ activityStatus: expected }) });
    expect(adapter.hasSession(THREAD)).toBe(false);
  });

  it("replaces disconnected active state after stored history confirms completion", async () => {
    client.initialState = conversation({ turns: [turn("latest-turn", "inProgress")] });
    adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient,
      readStoredThread: async () => ({ thread: { id: THREAD, cwd: "/repo", createdAt: 1, updatedAt: 2,
        turns: [{ id: "latest-turn", status: "completed", items: [] }] }, archived: false }) });
    await adapter.attachThread(THREAD);
    client.emit("ownerDisconnected", OWNER);
    expect((await adapter.listSessions())[0].activityStatus).toBe("error");
    client.discoverOwner.mockResolvedValue(null);
    const updated = vi.fn();
    adapter.on("session.updated", updated);

    expect((await adapter.getSession(THREAD))?.activityStatus).toBe("idle");
    expect((await adapter.listSessions())[0].activityStatus).toBe("idle");
    expect(updated).toHaveBeenLastCalledWith({ session: expect.objectContaining({ activityStatus: "idle" }) });
    expect(adapter.hasSession(THREAD)).toBe(false);
  });

  it("keeps disconnected pending approvals visible until a fresh follow recovers", async () => {
    client.initialState = conversation({ turns: [turn("latest-turn", "completed")], requests: [
      { id: "approval", method: "item/commandExecution/requestApproval", params: { command: "pwd" } },
    ] });
    await adapter.attachThread(THREAD);
    expect((await adapter.listSessions())[0].activityStatus).toBe("waiting");
    client.emit("ownerDisconnected", OWNER);
    expect((await adapter.listSessions())[0].activityStatus).toBe("error");
    await adapter.attachThread(THREAD);
    expect((await adapter.listSessions())[0].activityStatus).toBe("waiting");
    expect(await adapter.getPendingPermissions(THREAD)).toHaveLength(1);
  });

  it.each(["completed-read", "pending-read"])("discovers a newly available owner before sending after %s", async (readState) => {
    const readStoredThread = vi.fn(async () => ({ thread: { id: THREAD, cwd: "/repo", createdAt: 1, updatedAt: 2, turns: [] }, archived: false }));
    const acquireThread = vi.fn(async () => ({ threadId: THREAD, owned: true }));
    adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient, readStoredThread, acquireThread });
    let finishDiscovery: ((owner: DesktopThreadOwner | null) => void) | undefined;
    if (readState === "pending-read") client.discoverOwner.mockImplementationOnce(() => new Promise((resolve) => { finishDiscovery = resolve; }));
    else client.discoverOwner.mockResolvedValueOnce(null);
    const reading = adapter.getSession(THREAD);
    if (readState === "completed-read") await reading;
    const sending = adapter.sendMessage(THREAD, [{ type: "text", text: "New input" }]);
    finishDiscovery?.(null);
    await reading;
    await vi.waitFor(() => expect(client.startTurn).toHaveBeenCalledOnce());
    expect(client.discoverOwner).toHaveBeenCalledTimes(2);
    expect(client.followThread).toHaveBeenCalledExactlyOnceWith(THREAD, OWNER);
    expect(acquireThread).not.toHaveBeenCalled();
    client.publish({ type: "snapshot", revision: 2, conversationState: conversation({ turns: [turn("sent-turn", "completed", {
      params: { threadId: THREAD, input: [{ type: "text", text: "New input" }] },
      items: [
        { id: "new-user", type: "userMessage", content: [{ type: "text", text: "New input" }] },
        { id: "new-answer", type: "agentMessage", text: "Done", phase: "final_answer" },
      ],
    })] }) });
    expect((await sending).engineMeta?.codexItemId).toBe("new-answer");
  });

  it("keeps catalog reads available while guarding every direct project mutation", async () => {
    const snapshot = { sourceId: "source", revision: "r1", complete: true, projects: [], sessions: [] };
    const bridge = {
      managementAvailable: false,
      getCatalog: vi.fn(async () => snapshot), stop: vi.fn(async () => {}),
      createProject: vi.fn(async () => ({ id: "project", directory: "/repo" })),
      updateProject: vi.fn(async () => ({ id: "project", directory: "/repo" })),
      moveProject: vi.fn(async () => {}), deleteProject: vi.fn(async () => {}), assignThreadProject: vi.fn(async () => {}),
    };
    adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient, catalog: bridge });
    await adapter.start();
    expect(await adapter.getCatalog()).toEqual(snapshot);
    await expect(adapter.createProject({ name: "New", roots: ["/repo"] })).rejects.toThrow("project management");
    await expect(adapter.updateProject("project", { name: "Renamed" })).rejects.toThrow("project management");
    await expect(adapter.moveProject("project", null)).rejects.toThrow("project management");
    await expect(adapter.deleteCatalogProject("project")).rejects.toThrow("project management");
    await expect(adapter.setSessionProject("thread", "project")).rejects.toThrow("project management");
    expect(bridge.createProject).not.toHaveBeenCalled();
    expect(bridge.updateProject).not.toHaveBeenCalled();
    expect(bridge.moveProject).not.toHaveBeenCalled();
    expect(bridge.deleteProject).not.toHaveBeenCalled();
    expect(bridge.assignThreadProject).not.toHaveBeenCalled();
    bridge.managementAvailable = true;
    await adapter.createProject({ name: "New", roots: ["/repo"] });
    await adapter.setSessionProject("thread", null);
    expect(bridge.createProject).toHaveBeenCalledOnce();
    expect(bridge.assignThreadProject).toHaveBeenCalledExactlyOnceWith("thread", null);
  });

  it("announces a successful start so persisted shared sessions can reconnect", async () => {
    const changed = vi.fn();
    adapter.on("status.changed", changed);
    await adapter.start();
    await adapter.start();
    expect(changed).toHaveBeenCalledExactlyOnceWith({ engineType: "codex-desktop", status: "running" });
    expect(client.connect).toHaveBeenCalledOnce();
    await adapter.stop();
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ engineType: "codex-desktop", status: "stopped" }));
  });

  it("lists a bounded native catalog without contacting owners or creating conversations", async () => {
    const candidate = (id: string, engineMeta: Record<string, unknown> = {}): ImportableSession => ({
      engineSessionId: id, engineMeta, title: id, directory: "/repo", createdAt: 1, updatedAt: 2, alreadyImported: false,
    });
    const listCandidates = vi.fn(async () => [
      candidate("local-wrapper", { codexThreadId: "original-offline-thread", codexDesktopOwner: "codemux", retained: true }),
      candidate(THREAD),
      candidate("beyond-requested-limit"),
    ]);
    const createThread = vi.fn(async () => THREAD);
    const restoreThread = vi.fn(async (id: string) => id);
    adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient, listCandidates, createThread, restoreThread });
    await adapter.createSession("/repo");
    vi.clearAllMocks();
    client.connected = false;
    client.connect.mockRejectedValue(new Error("Desktop router is unavailable"));
    client.discoverOwner.mockRejectedValue(new Error("Owner lookup must not run during listing"));

    const listed = await adapter.listHistoricalSessions(2);

    expect(listCandidates).toHaveBeenCalledExactlyOnceWith(2);
    expect(listed.map((entry) => entry.engineSessionId)).toEqual(["original-offline-thread", THREAD]);
    expect(listed[0].engineMeta).toEqual({ codexThreadId: "original-offline-thread", codexDesktopOwner: "codemux", retained: true, desktopHostId: "local" });
    expect(listed[1].engineMeta).toMatchObject({ codexThreadId: THREAD, codexDesktopOwner: "codemux" });
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.discoverOwner).not.toHaveBeenCalled();
    expect(client.followThread).not.toHaveBeenCalled();
    expect(createThread).not.toHaveBeenCalled();
    expect(restoreThread).not.toHaveBeenCalled();
    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it("attaches the existing thread without creating, resuming, or executing a process", async () => {
    client.initialState = conversation({ turns: [turn("original-turn")] });
    const session = await adapter.createSession("/repo", { codexThreadId: THREAD });

    expect(session.id).toBe(THREAD);
    expect((await adapter.listMessages(THREAD)).map((message) => message.engineMeta?.codexItemId)).toEqual(["original-turn-user", "original-turn-answer"]);
    expect(client.discoverOwner).toHaveBeenCalledWith(THREAD);
    expect(client.followThread).toHaveBeenCalledExactlyOnceWith(THREAD, OWNER);
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(client.steerTurn).not.toHaveBeenCalled();
    expect(client.interruptTurn).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
    await expect(adapter.createSession("/repo")).rejects.toThrow("Create a conversation in Codex Desktop");
  });

  it("broadcasts Desktop input and follower steering while preserving the restore payload", async () => {
    await adapter.attachThread(THREAD);
    const desktopView = vi.fn();
    const mobileView = vi.fn();
    adapter.on("message.updated", desktopView);
    adapter.on("message.updated", mobileView);
    const activeTurn = turn("external-turn", "inProgress");
    client.publish({ type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "add", path: ["turns", 0], value: activeTurn }] });
    expect(desktopView).toHaveBeenCalledWith(expect.objectContaining({ message: expect.objectContaining({ id: desktopMessageId(THREAD, "external-turn", "external-turn-user"), role: "user" }) }));

    const sending = adapter.sendMessage(THREAD, [{ type: "text", text: "Check the tests too" }]);
    const outcome = observe(sending);
    await vi.waitFor(() => expect(client.steerTurn).toHaveBeenCalledOnce());
    const [threadId, ownerId, payload] = client.steerTurn.mock.calls[0];
    expect([threadId, ownerId]).toEqual([THREAD, OWNER]);
    expect(payload).toMatchObject({
      input: [{ type: "text", text: "Check the tests too", text_elements: [] }],
      clientUserMessageId: expect.any(String),
      restoreMessage: {
        id: payload.clientUserMessageId, text: "Check the tests too", cwd: "/repo", createdAt: expect.any(Number),
        context: {
          messageThreadId: THREAD, workspaceRoots: ["/repo"],
          collaborationMode: client.initialState.latestCollaborationMode,
          commentAttachments: [], fileAttachments: [], imageAttachments: [], ideContext: null,
        },
      },
    });
    client.publish({ type: "patches", baseRevision: 2, revision: 3, patches: [
      { op: "add", path: ["turns", 0, "items", 2], value: {
        id: "mobile-steer-item", type: "steeringUserMessage", clientUserMessageId: payload.clientUserMessageId,
        input: payload.input, status: "accepted", serverUserMessageId: "accepted-steer-item",
      } },
      { op: "add", path: ["turns", 0, "items", 3], value: { id: "answer-after-steer", type: "agentMessage", text: "Tests checked", phase: "final_answer" } },
      { op: "replace", path: ["turns", 0, "status"], value: "completed" },
      { op: "replace", path: ["turns", 0, "durationMs"], value: 2000 },
    ] });

    expect((await sending).engineMeta?.codexItemId).toBe("answer-after-steer");
    expect(outcome.error).toBeUndefined();
    expect(desktopView.mock.calls).toEqual(mobileView.mock.calls);
    expect(mobileView).toHaveBeenCalledWith(expect.objectContaining({ message: expect.objectContaining({ id: desktopMessageId(THREAD, "external-turn", "mobile-steer-item"), role: "user" }) }));
    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it("does not remove messages for an initial or unchanged Desktop snapshot", async () => {
    client.initialState = conversation({ turns: [turn("retained-turn")] });
    const removed = vi.fn();
    adapter.on("message.removed", removed);

    await adapter.attachThread(THREAD);
    client.publish({ type: "snapshot", revision: 2, conversationState: client.initialState });
    client.publish({ type: "patches", baseRevision: 2, revision: 3, patches: [] });

    expect(removed).not.toHaveBeenCalled();
    expect((await adapter.listMessages(THREAD)).map((message) => message.engineMeta?.codexItemId)).toEqual(["retained-turn-user", "retained-turn-answer"]);
  });

  it.each(["rollback", "edit"] as const)("broadcasts Desktop %s removals to both observers before replacement messages", async (operation) => {
    client.initialState = conversation({ turns: [turn("retained-turn"), turn("discarded-turn")] });
    await adapter.attachThread(THREAD);
    const desktopView = vi.fn();
    const mobileView = vi.fn();
    for (const observer of [desktopView, mobileView]) {
      adapter.on("message.removed", (payload) => observer({ type: "message.removed", ...payload }));
      adapter.on("message.updated", (payload) => observer({ type: "message.updated", ...payload }));
    }
    const retainedTurns = [turn("retained-turn")];
    if (operation === "rollback") {
      client.publish({ type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "remove", path: ["turns", 1] }] });
    } else {
      retainedTurns.push(turn("discarded-turn", "completed", {
        params: { threadId: THREAD, input: [{ type: "text", text: "Edited prompt" }], cwd: "/repo", model: "custom-model" },
        items: [
          { id: "discarded-turn-user", type: "userMessage", content: [{ type: "text", text: "Edited prompt" }] },
          { id: "edited-answer", type: "agentMessage", text: "Updated answer", phase: "final_answer" },
        ],
      }));
      client.publish({ type: "snapshot", revision: 2, conversationState: conversation({ turns: retainedTurns }) });
    }

    const expectedEvents = [
      ...(operation === "rollback" ? [{ type: "message.removed", sessionId: THREAD, messageId: desktopMessageId(THREAD, "discarded-turn", "discarded-turn-user") }] : []),
      { type: "message.removed", sessionId: THREAD, messageId: desktopMessageId(THREAD, "discarded-turn", "discarded-turn-answer") },
      ...(operation === "edit" ? ["discarded-turn-user", "edited-answer"].map((id) => ({
        type: "message.updated", sessionId: THREAD, message: expect.objectContaining({ id: desktopMessageId(THREAD, "discarded-turn", id) }),
      })) : []),
    ];
    expect(mobileView.mock.calls.map(([event]) => event)).toEqual(expectedEvents);
    expect(desktopView.mock.calls).toEqual(mobileView.mock.calls);
    expect((await adapter.listMessages(THREAD)).map((message) => message.engineMeta?.codexItemId)).toEqual([
      "retained-turn-user", "retained-turn-answer",
      ...(operation === "edit" ? ["discarded-turn-user", "edited-answer"] : []),
    ]);
    if (operation === "edit") expect(mobileView).toHaveBeenCalledWith(expect.objectContaining({ message: expect.objectContaining({
      id: desktopMessageId(THREAD, "discarded-turn", "discarded-turn-user"), parts: [expect.objectContaining({ type: "text", text: "Edited prompt" })],
    }) }));

    client.publish({ type: "snapshot", revision: 3, conversationState: conversation({ turns: retainedTurns }) });
    expect(mobileView).toHaveBeenCalledTimes(expectedEvents.length);
    expect(desktopView.mock.calls).toEqual(mobileView.mock.calls);
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(client.steerTurn).not.toHaveBeenCalled();
  });

  it("does not return the previous turn when an unrelated patch arrives after start", async () => {
    client.initialState = conversation({ turns: [turn("previous-turn")] });
    await adapter.attachThread(THREAD);
    const sending = adapter.sendMessage(THREAD, [{ type: "text", text: "Start the next task" }]);
    const outcome = observe(sending);
    await vi.waitFor(() => expect(client.startTurn).toHaveBeenCalledOnce());
    client.publish({ type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "replace", path: ["title"], value: "Renamed externally" }] });
    await Promise.resolve();
    await Promise.resolve();
    expect(outcome.settled).toBe(false);

    const turnStart = client.startTurn.mock.calls[0][2];
    expect(turnStart).toMatchObject({ request: {
      threadId: THREAD, input: [{ type: "text", text: "Start the next task", text_elements: [] }],
      clientUserMessageId: expect.any(String),
    } });
    expect(turnStart).not.toHaveProperty("clientUserMessageId");
    const request = turnStart.request as Record<string, unknown>;
    const nextTurn = turn("next-turn", "completed", {
      params: { threadId: THREAD, clientUserMessageId: request.clientUserMessageId, input: [{ type: "text", text: "Start the next task" }] },
      items: [
        { id: "next-user", type: "userMessage", content: [{ type: "text", text: "Start the next task" }] },
        { id: "next-answer", type: "agentMessage", text: "New result", phase: "final_answer" },
      ],
    });
    client.publish({ type: "patches", baseRevision: 2, revision: 3, patches: [{ op: "add", path: ["turns", 1], value: nextTurn }] });
    expect((await sending).engineMeta?.codexItemId).toBe("next-answer");
  });

  it("blocks commands after a revision gap until a fresh follow succeeds", async () => {
    client.initialState = conversation({ turns: [turn("active-turn", "inProgress")] });
    await adapter.attachThread(THREAD);
    client.publish({ type: "patches", baseRevision: 9, revision: 10, patches: [] });
    expect(client.unfollowThread).toHaveBeenCalledWith(THREAD);
    expect((await adapter.listSessions())[0].activityStatus).toBe("error");
    await expect(adapter.cancelMessage(THREAD)).rejects.toThrow("disconnected");
    client.followThread.mockRejectedValueOnce(new Error("Fresh snapshot unavailable"));
    await expect(adapter.sendMessage(THREAD, [{ type: "text", text: "Continue" }])).rejects.toThrow("Fresh snapshot unavailable");
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(client.steerTurn).not.toHaveBeenCalled();
    expect(client.interruptTurn).not.toHaveBeenCalled();
  });

  it("waits for the submitted steering input before accepting the current turn's completion", async () => {
    client.initialState = conversation({ turns: [turn("active-turn", "inProgress")] });
    await adapter.attachThread(THREAD);
    const sending = adapter.sendMessage(THREAD, [{ type: "text", text: "Also inspect the error case" }]);
    const outcome = observe(sending);
    await vi.waitFor(() => expect(client.steerTurn).toHaveBeenCalledOnce());
    const payload = client.steerTurn.mock.calls[0][2];
    client.publish({ type: "patches", baseRevision: 1, revision: 2, patches: [
      { op: "replace", path: ["turns", 0, "status"], value: "completed" },
      { op: "replace", path: ["turns", 0, "durationMs"], value: 1000 },
    ] });
    await Promise.resolve();
    await Promise.resolve();
    expect(outcome.settled).toBe(false);

    client.publish({ type: "patches", baseRevision: 2, revision: 3, patches: [
      { op: "add", path: ["turns", 0, "items", 2], value: {
        id: "accepted-steering", type: "steeringUserMessage", clientUserMessageId: payload.clientUserMessageId,
        input: payload.input, status: "accepted", serverUserMessageId: "server-steering",
      } },
      { op: "add", path: ["turns", 0, "items", 3], value: {
        id: "answer-after-input", type: "agentMessage", text: "The error case is covered", phase: "final_answer",
      } },
    ] });
    expect((await sending).engineMeta?.codexItemId).toBe("answer-after-input");
  });

  it("consumes the queued preview when native steering is accepted while work continues", async () => {
    const active = turn("active-turn", "inProgress");
    client.initialState = conversation({ turns: [active] });
    await adapter.attachThread(THREAD);
    const consumed = vi.fn();
    adapter.on("message.queued.consumed", consumed);
    const sending = adapter.sendMessage(THREAD, [{ type: "text", text: "Also inspect this" }]);
    const outcome = observe(sending);
    await vi.waitFor(() => expect(client.steerTurn).toHaveBeenCalledOnce());
    const payload = client.steerTurn.mock.calls[0][2];
    expect(consumed).not.toHaveBeenCalled();
    const receipt = { id: "steer-receipt", type: "steeringUserMessage", clientUserMessageId: payload.clientUserMessageId,
      input: payload.input, status: "pending" };
    client.publish({ type: "snapshot", revision: 2, conversationState: conversation({ turns: [{ ...active, items: [...active.items, receipt] }] }) });
    expect(consumed).not.toHaveBeenCalled();
    client.publish({ type: "snapshot", revision: 3, conversationState: conversation({ turns: [{ ...active, items: [...active.items, { ...receipt, status: "accepted" }] }] }) });
    expect(consumed).toHaveBeenCalledOnce();
    expect(outcome.settled).toBe(false);
    client.publish({ type: "snapshot", revision: 4, conversationState: conversation({ turns: [{ ...active, status: "completed", durationMs: 1000, items: [...active.items, { ...receipt, status: "accepted" }] }] }) });
    await sending;
    expect(consumed).toHaveBeenCalledOnce();
  });

  it.each([false, true])("correlates identical steering previews by client identity and ignores rejected receipts (server items=%s)", async (serverItems) => {
    const active = turn("active-turn", "inProgress");
    client.initialState = conversation({ turns: [active] });
    await adapter.attachThread(THREAD);
    const consumed = vi.fn();
    adapter.on("message.queued.consumed", consumed);
    const content = [{ type: "text" as const, text: "Same follow-up" }, { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" }];
    const first = adapter.sendMessage(THREAD, content, { clientMessageId: "preview-first" });
    const second = adapter.sendMessage(THREAD, content, { clientMessageId: "preview-second" });
    observe(first); observe(second);
    await vi.waitFor(() => expect(client.steerTurn).toHaveBeenCalledTimes(2));
    const receipts = client.steerTurn.mock.calls.map(([, , payload], index) => ({ id: `receipt-${index}`, type: "steeringUserMessage",
      clientUserMessageId: payload.clientUserMessageId, input: payload.input, status: "pending", serverUserMessageId: `server-user-${index}` }));
    const nativeUser = (index: number) => ({ id: receipts[index].serverUserMessageId, type: "userMessage", content: receipts[index].input });
    client.publish({ type: "snapshot", revision: 2, conversationState: conversation({ turns: [{ ...active, items: [...active.items,
      { ...receipts[0], status: "failed" }, { ...receipts[1], status: "accepted" },
      ...(serverItems ? [nativeUser(1)] : []),
    ] }] }) });
    expect(consumed).toHaveBeenCalledExactlyOnceWith({ sessionId: THREAD, messageId: expect.any(String), clientMessageId: "preview-second" });
    client.publish({ type: "snapshot", revision: 3, conversationState: conversation({ turns: [{ ...active, status: "completed", durationMs: 1000,
      items: [...active.items, ...receipts.map((receipt) => ({ ...receipt, status: "accepted" })), ...(serverItems ? [nativeUser(0), nativeUser(1)] : [])],
    }] }) });
    await Promise.all([first, second]);
    expect(consumed.mock.calls.map(([event]) => event.clientMessageId)).toEqual(["preview-second", "preview-first"]);
    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it("detaches without interrupting a Desktop-owned turn", async () => {
    client.initialState = conversation({ turns: [turn("active-turn", "inProgress")] });
    await adapter.attachThread(THREAD);
    await adapter.deleteSession(THREAD);
    expect(client.unfollowThread).toHaveBeenCalledWith(THREAD);
    expect(await adapter.listSessions()).toEqual([]);
    await adapter.stop();
    expect(client.close).toHaveBeenCalled();
    expect(client.interruptTurn).not.toHaveBeenCalled();
  });

  it("interrupts only a synchronized active turn with its exact turn ID", async () => {
    client.initialState = conversation({ turns: [turn("old-turn"), turn("active-turn", "inProgress")] });
    await adapter.attachThread(THREAD);
    await adapter.cancelMessage(THREAD);
    expect(client.interruptTurn).toHaveBeenCalledExactlyOnceWith(THREAD, OWNER, "active-turn");

    client.publish({ type: "snapshot", revision: 2, conversationState: conversation({ resumeState: "needs_resume", threadRuntimeStatus: { type: "active" } }) });
    await expect(adapter.cancelMessage(THREAD)).rejects.toThrow("active turn is not synchronized");
    client.publish({ type: "snapshot", revision: 3, conversationState: conversation({ turns: [turn("finished-turn")] }) });
    await adapter.cancelMessage(THREAD);
    expect(client.interruptTurn).toHaveBeenCalledOnce();
  });

  it.each([false, true])("sends image-only input through the Desktop contract (steering=%s)", async (steering) => {
    client.initialState = conversation({ turns: steering ? [turn("image-turn", "inProgress")] : [] });
    await adapter.attachThread(THREAD);
    const data = "iVBORw0KGgo=";
    const sending = adapter.sendMessage(THREAD, [{ type: "image", data, mimeType: "image/png" }]);
    observe(sending);
    const method = steering ? client.steerTurn : client.startTurn;
    await vi.waitFor(() => expect(method).toHaveBeenCalledOnce());
    const payload = method.mock.calls[0][2] as Record<string, unknown>;
    const request = steering ? payload : payload.request as Record<string, unknown>;
    expect(request.input).toEqual([{ type: "image", url: `data:image/png;base64,${data}` }]);
    expect(steering ? payload.attachments : (payload.context as Record<string, unknown>).attachments).toEqual([]);
    if (steering) expect(payload.restoreMessage).toMatchObject({ context: { imageAttachments: [
      { id: expect.any(String), src: `data:image/png;base64,${data}` },
    ] } });
    const userItem = steering
      ? { id: "image-user", type: "steeringUserMessage", input: request.input, clientUserMessageId: request.clientUserMessageId, status: "accepted" }
      : { id: "image-user", type: "userMessage", content: request.input };
    client.publish({ type: "snapshot", revision: 2, conversationState: conversation({ turns: [turn("image-turn", "completed", {
      params: { threadId: THREAD, input: request.input },
      items: [userItem, { id: "image-answer", type: "agentMessage", text: "Image inspected", phase: "final_answer" }],
    })] }) });
    expect((await sending).engineMeta?.codexItemId).toBe("image-answer");
  });

  it("rejects invalid image data before dispatching to the owner", async () => {
    await adapter.attachThread(THREAD);
    await expect(adapter.sendMessage(THREAD, [{ type: "image", mimeType: "image/png", data: "not-base64" }])).rejects.toThrow("Invalid base64");
    await expect(adapter.sendMessage(THREAD, [{ type: "image", mimeType: "image/svg+xml", data: "YWJj" }])).rejects.toThrow("mime");
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(client.steerTurn).not.toHaveBeenCalled();
  });

  it("updates model, effort, mode and tier through verified Desktop state", async () => {
    const settings: Record<string, unknown> = {
      model: "custom-model", effort: "ultra", serviceTier: null,
      collaborationMode: { mode: "default", settings: { model: "custom-model", reasoning_effort: "ultra", developer_instructions: "Keep project conventions" } },
    };
    client.initialState = conversation({ latestThreadSettings: settings });
    await adapter.attachThread(THREAD);
    let revision = 1;
    client.updateThreadSettings.mockImplementation(async (_id, _owner, patch) => {
      Object.assign(settings, patch);
      client.publish({ type: "snapshot", revision: ++revision, conversationState: conversation({ latestThreadSettings: settings }) });
      return { applied: true };
    });

    await adapter.setModel(THREAD, "another-modelhub-model");
    expect(client.updateThreadSettings.mock.calls[0][2].collaborationMode?.settings.reasoning_effort).toBe("ultra");
    await adapter.setReasoningEffort(THREAD, "max");
    await adapter.setMode(THREAD, "plan");
    await adapter.setServiceTier(THREAD, "fast");
    expect(client.updateThreadSettings.mock.calls.at(-1)?.[2]).toEqual({ serviceTier: "priority" });
    const session = await adapter.getSession(THREAD);
    expect(session).toMatchObject({ modelId: "another-modelhub-model", reasoningEffort: "max", mode: "plan", serviceTier: "fast" });
    expect(adapter.getReasoningEffort(THREAD)).toBe("max");
    expect(adapter.getServiceTier(THREAD)).toBe("fast");
    expect(client.updateThreadSettings.mock.calls[2][2]).toEqual({ collaborationMode: {
      mode: "plan", settings: { model: "another-modelhub-model", reasoning_effort: "xhigh", developer_instructions: "Keep project conventions" },
    } });
    expect(client.updateThreadSettings.mock.calls.every((call) => !Object.hasOwn(call[2], "modelProvider"))).toBe(true);

    await adapter.setReasoningEffort(THREAD, null);
    await adapter.setServiceTier(THREAD, null);
    expect(adapter.getReasoningEffort(THREAD)).toBeNull();
    expect(adapter.getServiceTier(THREAD)).toBeNull();
  });

  it("changes next-turn settings without entering the active-turn permission editor", async () => {
    client.initialState = conversation({ turns: [turn("running-turn", "inProgress")] });
    await adapter.attachThread(THREAD);
    client.updateThreadSettings.mockImplementation(async (_id, _owner, patch) => {
      client.publish({ type: "snapshot", revision: 2, conversationState: conversation({
        turns: [turn("running-turn", "inProgress")], latestThreadSettings: patch,
      }) });
      return { applied: true };
    });
    await adapter.setServiceTier(THREAD, "fast");
    expect(client.updateThreadSettings).toHaveBeenCalledExactlyOnceWith(THREAD, OWNER, { serviceTier: "priority" });
    expect((await adapter.getSession(THREAD))?.activityStatus).toBe("running");
  });

  it("does not report unsupported or rejected settings as applied", async () => {
    await adapter.attachThread(THREAD);
    client.updateThreadSettings.mockResolvedValue({ applied: false });
    await expect(adapter.setModel(THREAD, "unapplied-model")).rejects.toThrow("did not apply");
    expect((await adapter.getSession(THREAD))?.modelId).toBe("custom-model");
    await expect(adapter.setMode(THREAD, "unsupported-mode")).rejects.toThrow("Unsupported Codex Desktop mode");
    await expect(adapter.renameSession(THREAD, "New title")).rejects.toThrow("unavailable");
  });

  it.each([false, true])("routes foreign-owned renaming through the service without replacing its active state (%s)", async (active) => {
    const turns = active ? [turn("running", "inProgress")] : [];
    client.initialState = conversation({ turns });
    const renameThread = vi.fn(async (_id: string, title: string, _owner: string) => {
      client.publish({ type: "snapshot", revision: 2, conversationState: conversation({ title, turns }) });
    });
    adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient, renameThread });
    await adapter.attachThread(THREAD);
    await adapter.renameSession(THREAD, "  New shared title  ");
    expect(renameThread).toHaveBeenCalledExactlyOnceWith(THREAD, "New shared title", OWNER);
    expect((await adapter.getSession(THREAD))?.title).toBe("New shared title");
    expect((await adapter.getSession(THREAD))?.activityStatus).toBe(active ? "running" : "idle");
    expect((await adapter.getSession(THREAD))?.engineMeta?.codexDesktopOwner).toBeUndefined();
  });

  it.each(["item/tool/requestUserInput", "item/commandExecution/requestApproval"])("does not rename a shared thread with a pending %s", async (method) => {
    const renameThread = vi.fn();
    client.initialState = conversation({ requests: [{ id: "pending", method, params: {} }] });
    adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient, renameThread });
    await adapter.attachThread(THREAD);
    await expect(adapter.renameSession(THREAD, "Blocked title")).rejects.toThrow("pending approvals or questions");
    expect(renameThread).not.toHaveBeenCalled();
  });

  it("rejects empty titles and leaves failed writes unconfirmed", async () => {
    const renameThread = vi.fn(async () => { throw new Error("Metadata write failed"); });
    adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient, renameThread });
    await expect(adapter.renameSession(THREAD, "  ")).rejects.toThrow("non-empty");
    expect(client.followThread).not.toHaveBeenCalled();
    await adapter.attachThread(THREAD);
    await expect(adapter.renameSession(THREAD, "New title")).rejects.toThrow("Metadata write failed");
    expect((await adapter.getSession(THREAD))?.title).toBe("Shared task");
    expect(renameThread).toHaveBeenCalledOnce();
  });

  it("does not report a service callback without a matching title snapshot as synchronized", async () => {
    const renameThread = vi.fn(async () => {});
    adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient, renameThread, syncTimeoutMs: 10 });
    await adapter.attachThread(THREAD);
    await expect(adapter.renameSession(THREAD, "Unconfirmed title")).rejects.toThrow("not been synchronized");
    expect((await adapter.getSession(THREAD))?.title).toBe("Shared task");
    expect(renameThread).toHaveBeenCalledOnce();
  });

  it("keeps settings unconfirmed when the owner accepts a change without publishing it", async () => {
    adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient, syncTimeoutMs: 10 });
    await adapter.attachThread(THREAD);
    await expect(adapter.setModel(THREAD, "not-synchronized")).rejects.toThrow("accepted but its state is not synchronized");
    expect((await adapter.getSession(THREAD))?.modelId).toBe("custom-model");
    expect(client.updateThreadSettings).toHaveBeenCalledOnce();
  });

  it.each([
    { method: "item/commandExecution/requestApproval", wrapper: "replyCommandApproval" as const, optionId: "allow_always", expected: "acceptForSession" },
    { method: "item/fileChange/requestApproval", wrapper: "replyFileApproval" as const, optionId: "reject_once", expected: "decline" },
    { method: "item/permissions/requestApproval", wrapper: "replyPermissionsApproval" as const, optionId: "allow_once", expected: { permissions: { network: { enabled: true } }, scope: "turn" } },
  ])("answers $method with the original request ID", async ({ method, wrapper, optionId, expected }) => {
    client.initialState = conversation({ requests: [{ id: 42, method, params: {
      threadId: THREAD, turnId: "approval-turn", itemId: "approval-item", command: "pwd",
      permissions: { network: { enabled: true } },
    } }] });
    await adapter.attachThread(THREAD);
    client[wrapper].mockImplementation(async () => {
      client.publish({ type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "remove", path: ["requests", 0] }] });
      return {};
    });
    await adapter.replyPermission(desktopRequestId(THREAD, 42), { optionId }, THREAD);
    expect(client[wrapper]).toHaveBeenCalledWith(THREAD, OWNER, 42, expected);
    expect(adapter.getPendingPermissions(THREAD)).toEqual([]);
    await expect(adapter.replyPermission(desktopRequestId(THREAD, 42), { optionId }, THREAD)).rejects.toThrow("no longer pending");
    expect(client[wrapper]).toHaveBeenCalledOnce();
  });

  it("submits answers by native question ID and preserves unresolved state on failure", async () => {
    const question = { id: "request-7", method: "item/tool/requestUserInput", params: { threadId: THREAD, questions: [
      { id: "target", header: "Target", question: "Which target?" },
      { id: "scope", header: "Scope", question: "Which scope?" },
    ] } };
    client.initialState = conversation({ requests: [question] });
    await adapter.attachThread(THREAD);
    client.submitUserInput.mockRejectedValueOnce(new Error("Owner unavailable"));
    await expect(adapter.replyQuestion(desktopRequestId(THREAD, "request-7"), [["Mobile"], ["Current session"]], THREAD)).rejects.toThrow("Owner unavailable");
    expect(adapter.getPendingQuestions(THREAD)).toHaveLength(1);
    client.submitUserInput.mockImplementation(async () => {
      client.publish({ type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "remove", path: ["requests", 0] }] });
      return {};
    });
    await adapter.replyQuestion(desktopRequestId(THREAD, "request-7"), [["Mobile"], ["Current session"]], THREAD);
    expect(client.submitUserInput).toHaveBeenLastCalledWith(THREAD, OWNER, "request-7", {
      answers: { target: { answers: ["Mobile"] }, scope: { answers: ["Current session"] } },
    });
    expect(adapter.getPendingQuestions(THREAD)).toEqual([]);
  });

  it("routes globally scoped requests to their native owners without clearing another thread", async () => {
    const threads = ["thread-a", "thread-b"];
    const states = new Map(threads.map((id) => [id, conversation({ id, requests: [
      { id: 42, method: "item/commandExecution/requestApproval", params: { threadId: id, command: "pwd" } },
      { id: 7, method: "item/tool/requestUserInput", params: { threadId: id, questions: [{ id: "choice", header: "Target", question: "Choose a target" }] } },
    ] })]));
    const revisions = new Map(threads.map((id) => [id, 1]));
    const permissions = new Map<string, string>();
    const questions = new Map<string, string>();
    adapter.on("permission.asked", ({ permission }) => permissions.set(permission.id, permission.sessionId));
    adapter.on("permission.replied", ({ permissionId }) => permissions.delete(permissionId));
    adapter.on("question.asked", ({ question }) => questions.set(question.id, question.sessionId));
    adapter.on("question.replied", ({ questionId }) => questions.delete(questionId));
    client.discoverOwner.mockImplementation(async (id) => ({ ownerClientId: `owner-${id}`, supportsUntrustedAppInput: true }));
    client.followThread.mockImplementation(async (id) => ({ type: "snapshot", revision: 1, conversationState: states.get(id)! }));
    for (const id of threads) await adapter.attachThread(id);
    expect(permissions.size).toBe(2);
    expect(questions.size).toBe(2);
    const resolveRequest = async (id: string, owner: string, requestId: string | number) => {
      const previous = states.get(id)!;
      const requests = previous.requests as Array<{ id: string | number }>;
      const next = { ...previous, requests: requests.filter((request) => request.id !== requestId) };
      states.set(id, next);
      const revision = revisions.get(id)! + 1;
      revisions.set(id, revision);
      client.emit("stream", { conversationId: id, hostId: "local", ownerClientId: owner, change: { type: "snapshot", revision, conversationState: next } });
      return {};
    };
    client.replyCommandApproval.mockImplementation(resolveRequest);
    client.submitUserInput.mockImplementation(resolveRequest);
    const permissionA = desktopRequestId("thread-a", 42);
    const questionA = desktopRequestId("thread-a", 7);
    await expect(adapter.replyPermission(permissionA, { optionId: "allow_once" }, "thread-b")).rejects.toThrow("no longer pending");
    await expect(adapter.replyQuestion(questionA, [["A"]], "thread-b")).rejects.toThrow("no longer pending");
    await expect(adapter.replyPermission("42", { optionId: "allow_once" }, "thread-a")).rejects.toThrow("no longer pending");
    await expect(adapter.replyQuestion("7", [["A"]])).rejects.toThrow("no longer pending");
    expect(client.replyCommandApproval).not.toHaveBeenCalled();
    expect(client.submitUserInput).not.toHaveBeenCalled();
    await adapter.replyPermission(permissionA, { optionId: "allow_once" });
    expect(client.replyCommandApproval).toHaveBeenCalledExactlyOnceWith("thread-a", "owner-thread-a", 42, "accept");
    expect([...permissions.entries()]).toEqual([[desktopRequestId("thread-b", 42), "thread-b"]]);
    expect(questions.size).toBe(2);
    await adapter.replyQuestion(questionA, [["A"]]);
    expect(client.submitUserInput).toHaveBeenCalledExactlyOnceWith("thread-a", "owner-thread-a", 7, { answers: { choice: { answers: ["A"] } } });
    expect([...questions.entries()]).toEqual([[desktopRequestId("thread-b", 7), "thread-b"]]);
    expect(adapter.getPendingPermissions("thread-b")).toHaveLength(1);
    expect(adapter.getPendingQuestions("thread-b")).toHaveLength(1);
  });

  it.each([42, "42"])("preserves the native type of request %s among equal textual IDs", async (firstId) => {
    const requests = [42, "42"].map((id) => ({ id, method: "item/commandExecution/requestApproval", params: { threadId: THREAD, command: "pwd" } }));
    client.initialState = conversation({ requests });
    await adapter.attachThread(THREAD);
    let revision = 1;
    let pending = requests;
    client.replyCommandApproval.mockImplementation(async (_thread, _owner, requestId) => {
      pending = pending.filter((request) => request.id !== requestId);
      client.publish({ type: "snapshot", revision: ++revision, conversationState: conversation({ requests: pending }) });
      return {};
    });
    const secondId = typeof firstId === "number" ? "42" : 42;
    await adapter.replyPermission(desktopRequestId(THREAD, firstId), { optionId: "allow_once" });
    expect(client.replyCommandApproval).toHaveBeenLastCalledWith(THREAD, OWNER, firstId, "accept");
    expect(adapter.getPendingPermissions(THREAD).map((request) => request.id)).toEqual([desktopRequestId(THREAD, secondId)]);
    await adapter.replyPermission(desktopRequestId(THREAD, secondId), { optionId: "allow_once" });
    expect(client.replyCommandApproval).toHaveBeenLastCalledWith(THREAD, OWNER, secondId, "accept");
    expect(adapter.getPendingPermissions(THREAD)).toEqual([]);
  });

  it("dismisses a blocking question by stopping only its synchronized turn", async () => {
    const question = { id: "blocking-question", method: "item/tool/requestUserInput", params: { threadId: THREAD, questions: [
      { id: "target", header: "Target", question: "Which target?" },
    ] } };
    client.initialState = conversation({ turns: [turn("question-turn", "inProgress")], requests: [question] });
    await adapter.attachThread(THREAD);
    client.interruptTurn.mockImplementation(async () => {
      client.publish({ type: "patches", baseRevision: 1, revision: 2, patches: [
        { op: "remove", path: ["requests", 0] },
        { op: "replace", path: ["turns", 0, "status"], value: "interrupted" },
      ] });
      return {};
    });
    await adapter.rejectQuestion(desktopRequestId(THREAD, "blocking-question"), THREAD);
    expect(client.interruptTurn).toHaveBeenCalledExactlyOnceWith(THREAD, OWNER, "question-turn");
    expect(client.submitUserInput).not.toHaveBeenCalled();
    client.publish({ type: "snapshot", revision: 3, conversationState: conversation({ requests: [question] }) });
    await expect(adapter.rejectQuestion(desktopRequestId(THREAD, "blocking-question"), THREAD)).rejects.toThrow("active turn is not synchronized");
    expect(client.interruptTurn).toHaveBeenCalledOnce();
  });

  it("rejects legacy approvals instead of reporting ignored follower calls as successful", async () => {
    client.initialState = conversation({ requests: [{ id: "legacy-request", method: "execCommandApproval", params: { threadId: THREAD, command: "pwd" } }] });
    await adapter.attachThread(THREAD);
    await expect(adapter.replyPermission(desktopRequestId(THREAD, "legacy-request"), { optionId: "allow_once" }, THREAD)).rejects.toThrow("not supported");
    expect(client.replyCommandApproval).not.toHaveBeenCalled();
    expect(adapter.getPendingPermissions(THREAD)).toHaveLength(1);
  });

  it("exposes only implemented native commands and never sends unknown commands as prompts", async () => {
    await adapter.attachThread(THREAD);
    expect((await adapter.listCommands()).map((command) => command.name)).toEqual(["compact"]);
    expect(await adapter.invokeCommand(THREAD, "compact", "")).toEqual({ handledAsCommand: true });
    expect(client.compactThread).toHaveBeenCalledWith(THREAD, OWNER);
    await expect(adapter.invokeCommand(THREAD, "unknown-skill", "")).rejects.toThrow("Only /compact");
    expect(client.startTurn).not.toHaveBeenCalled();
  });
});
