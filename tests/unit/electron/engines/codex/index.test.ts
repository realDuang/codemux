import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mkdtempSyncMock, writeFileSyncMock, resolveCodexCliPathMock, resolveCodexCliVersionMock, verifyRolloutMock } = vi.hoisted(() => ({
  mkdtempSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  resolveCodexCliPathMock: vi.fn(),
  resolveCodexCliVersionMock: vi.fn(),
  verifyRolloutMock: vi.fn(async (_id: string, _metadata: Record<string, unknown>): Promise<"active" | "archived" | undefined> => undefined),
}));
vi.mock("../../../../../electron/main/engines/codex/desktop-rollout-path", () => ({ verifyCodexRolloutPath: verifyRolloutMock }));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  mkdtempSyncMock.mockImplementation(actual.mkdtempSync);
  writeFileSyncMock.mockImplementation(actual.writeFileSync);

  return {
    ...actual,
    mkdtempSync: mkdtempSyncMock,
    writeFileSync: writeFileSyncMock,
  };
});

vi.mock("../../../../../electron/main/engines/codex/config", async () => {
  const actual = await vi.importActual<typeof import("../../../../../electron/main/engines/codex/config")>(
    "../../../../../electron/main/engines/codex/config",
  );

  return {
    ...actual,
    resolveCodexCliPath: resolveCodexCliPathMock,
    resolveCodexCliVersion: resolveCodexCliVersionMock,
  };
});

vi.mock("../../../../../electron/main/services/logger", () => ({
  codexLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { CodexAdapter, createCodexDesktopOwnerRuntime } from "../../../../../electron/main/engines/codex/index";
import { convertThreadToMessages } from "../../../../../electron/main/engines/codex/converters";

interface MockClient {
  running: boolean;
  request: ReturnType<typeof vi.fn>;
  respond: ReturnType<typeof vi.fn>;
  respondError: ReturnType<typeof vi.fn>;
}

function createMockClient(): MockClient {
  return {
    running: true,
    request: vi.fn(),
    respond: vi.fn(),
    respondError: vi.fn(),
  };
}

function createAdapterWithClient() {
  const adapter = new CodexAdapter();
  const client = createMockClient();
  vi.spyOn(adapter, "start").mockResolvedValue(undefined);
  (adapter as any).client = client;
  (adapter as any).status = "running";
  return { adapter, client };
}

function seedSession(
  adapter: CodexAdapter,
  options?: { sessionId?: string; threadId?: string; directory?: string; title?: string },
) {
  const sessionId = options?.sessionId ?? "codex_thread-1";
  const threadId = options?.threadId ?? "thread-1";
  const directory = options?.directory ?? "/repo";
  const title = options?.title ?? "Thread 1";

  (adapter as any).sessionToThread.set(sessionId, threadId);
  (adapter as any).threadToSession.set(threadId, sessionId);
  (adapter as any).threads.set(threadId, {
    threadId,
    directory,
    createdAt: 100,
    updatedAt: 200,
    lastUsedAt: 200,
    title,
    loaded: true,
  });
  (adapter as any).sessionDirectories.set(sessionId, directory);
  (adapter as any).sessionModes.set(sessionId, "default");

  return { sessionId, threadId, directory };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("CodexAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveCodexCliPathMock.mockReturnValue("/usr/local/bin/codex");
    resolveCodexCliVersionMock.mockReturnValue("codex-cli 1.2.3");
  });

  it("routes asynchronous agent questions and replies through the exact active turn", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const asked = vi.fn();
    adapter.on("question.asked", asked);
    const notify = (method: string, values: Record<string, unknown>) => (adapter as any).handleNotification(method, { threadId, turnId: "async-turn", ...values });
    notify("turn/started", { turn: { id: "async-turn", status: "inProgress" } });
    const item = { id: "async-item", type: "agentMessage", text: "Checking.", questions: [{ title: "  Which environment?  ", options: ["Staging", "Production"] }] };
    notify("item/started", { item });
    notify("item/completed", { item });
    const pending = adapter.getPendingQuestions(sessionId);
    expect(pending).toHaveLength(1);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(pending[0]).toMatchObject({ dismissStopsTurn: false, questions: [{ question: item.questions[0].title, options: [{ label: "Staging" }, { label: "Production" }] }] });
    client.request.mockResolvedValue({ turnId: "async-turn" });
    await adapter.replyQuestion(pending[0].id, [["  Staging  "]], sessionId);
    const expectedText = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(["request_user_input_async", "async-item", 0]), question: item.questions[0].title, answer: "Staging" }])}\n</send_user_message_question_reply>`;
    expect(client.request).toHaveBeenCalledWith("turn/steer", { threadId, expectedTurnId: "async-turn", input: [{ type: "text", text: expectedText, text_elements: [] }] }, 120_000);
    expect(client.respond).not.toHaveBeenCalled();
    expect(adapter.getPendingQuestions(sessionId)).toEqual([]);
    expect((adapter as any).activeTurnIds.get(sessionId)).toBe("async-turn");
    expect((await adapter.listMessages(sessionId)).some((message) => message.role === "user")).toBe(false);
    const buffer = (adapter as any).messageBuffers.get(sessionId);
    expect(buffer.parts.some((part: { text?: string }) => part.text?.includes("Staging"))).toBe(true);
    notify("item/completed", { item: { id: "echo", type: "userMessage", content: [{ type: "text", text: expectedText }] } });
    expect(buffer.parts.filter((part: { text?: string }) => part.text?.includes("Staging"))).toHaveLength(1);
  });

  it("keeps asynchronous questions retryable after steer failure and dismisses locally", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const notify = (method: string, values: Record<string, unknown>) => (adapter as any).handleNotification(method, { threadId, turnId: "async-turn", ...values });
    notify("turn/started", { turn: { id: "async-turn", status: "inProgress" } });
    const item = { id: "async-item", type: "agentMessage", questions: [{ title: "Continue?" }] };
    notify("item/started", { item });
    const [pending] = adapter.getPendingQuestions(sessionId);
    expect(pending).toBeDefined();
    client.request.mockRejectedValue(new Error("Turn changed"));
    await expect(adapter.replyQuestion(pending.id, [["Yes"]], sessionId)).rejects.toThrow("Turn changed");
    expect(adapter.getPendingQuestions(sessionId)).toHaveLength(1);
    expect((adapter as any).messageQueues.size).toBe(0);
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["turn/steer"]);
    await adapter.rejectQuestion(pending.id, sessionId);
    notify("item/completed", { item });
    expect(adapter.getPendingQuestions(sessionId)).toEqual([]);
    expect(client.respond).not.toHaveBeenCalled();
    expect(client.respondError).not.toHaveBeenCalled();
    expect((adapter as any).activeTurnIds.get(sessionId)).toBe("async-turn");
  });

  it("consumes native asynchronous answer echoes and clears questions when their turn ends", async () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const notify = (method: string, values: Record<string, unknown>) => (adapter as any).handleNotification(method, { threadId, turnId: "async-turn", ...values });
    notify("turn/started", { turn: { id: "async-turn", status: "inProgress" } });
    notify("item/completed", { item: { id: "async-item", type: "agentMessage", questions: [{ title: "Which environment?" }, { title: "Run checks?" }] } });
    const text = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(["request_user_input_async", "async-item", 0]), question: "Which environment?", answer: "Staging" }])}\n</send_user_message_question_reply>`;
    notify("item/started", { item: { id: "reply-item", type: "userMessage", content: [{ type: "text", text }] } });
    notify("item/completed", { item: { id: "reply-item", type: "userMessage", content: [{ type: "text", text }] } });
    expect(adapter.getPendingQuestions(sessionId)).toHaveLength(1);
    expect(adapter.getPendingQuestions(sessionId)[0].questions.map((question) => question.question)).toEqual(["Run checks?"]);
    const buffer = (adapter as any).messageBuffers.get(sessionId);
    expect(buffer.parts.filter((part: { text?: string }) => part.text?.includes("Staging"))).toHaveLength(1);
    notify("turn/completed", { turn: { id: "async-turn", status: "completed" } });
    expect(adapter.getPendingQuestions(sessionId)).toEqual([]);
    notify("item/completed", { item: { id: "late-question", type: "agentMessage", questions: [{ title: "Too late?" }] } });
    expect(adapter.getPendingQuestions(sessionId)).toEqual([]);
  });

  it("rejects blank or stale asynchronous replies without starting or queueing work", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    (adapter as any).handleNotification("turn/started", { threadId, turn: { id: "async-turn", status: "inProgress" } });
    (adapter as any).handleNotification("item/completed", { threadId, turnId: "async-turn", item: { id: "question", type: "agentMessage", questions: [{ title: "Continue?" }] } });
    const [pending] = adapter.getPendingQuestions(sessionId);
    expect(pending).toBeDefined();
    await expect(adapter.replyQuestion(pending.id, [["Yes"]], "another-session")).rejects.toThrow("another Codex session");
    await expect(adapter.replyQuestion(pending.id, [["   "]], sessionId)).rejects.toThrow();
    (adapter as any).activeTurnIds.set(sessionId, "new-turn");
    await expect(adapter.replyQuestion(pending.id, [["Yes"]], sessionId)).rejects.toThrow("active Codex turn");
    expect(client.request).not.toHaveBeenCalled();
    expect((adapter as any).messageQueues.size).toBe(0);
  });

  it("preserves the assistant boundary when the Desktop owner steers an asynchronous reply", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const runtime = adapter.createDesktopOwnerRuntime();
    (adapter as any).handleNotification("turn/started", { threadId, turn: { id: "async-turn", status: "inProgress" } });
    (adapter as any).handleNotification("item/completed", { threadId, turnId: "async-turn", item: { id: "question", type: "agentMessage", questions: [{ title: "Continue?" }] } });
    const text = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(["request_user_input_async", "question", 0]), question: "Continue?", answer: "Yes" }])}\n</send_user_message_question_reply>`;
    client.request.mockResolvedValue({ turnId: "async-turn" });
    await runtime.request(sessionId, "turn/steer", { threadId, expectedTurnId: "async-turn", input: [{ type: "text", text, text_elements: [] }] });
    expect(adapter.getPendingQuestions(sessionId)).toEqual([]);
    expect((await adapter.listMessages(sessionId)).filter((message) => message.role === "user")).toEqual([]);
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["turn/steer"]);
    expect((adapter as any).messageBuffers.get(sessionId).parts.at(-1).text).toContain("Yes");
  });

  it.each(["unknown", "mixed", "malformed"])("rejects an explicitly asynchronous %s owner reply without creating a user message", async (source) => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    (adapter as any).handleNotification("turn/started", { threadId, turn: { id: "active-turn", status: "inProgress" } });
    (adapter as any).handleNotification("item/completed", { threadId, turnId: "active-turn", item: {
      id: "question", type: "agentMessage", questions: [{ title: "Continue?" }],
    } });
    const ids = source === "mixed" ? ["question", "old-question"] : ["old-question"];
    const text = source === "malformed" ? "<send_user_message_question_reply>invalid</send_user_message_question_reply>"
      : `<send_user_message_question_reply>\n${JSON.stringify(ids.map((id) => ({
        questionItemId: JSON.stringify(["request_user_input_async", id, 0]), question: "Continue?", answer: "Yes",
      })))}\n</send_user_message_question_reply>`;
    await expect(adapter.createDesktopOwnerRuntime().request(sessionId, "turn/steer", {
      threadId, expectedTurnId: "active-turn", input: [{ type: "text", text }],
      restoreMessage: { context: { turnTrigger: "send_user_message_async_question" } },
    })).rejects.toThrow("no longer belongs to the active Codex turn");
    expect(client.request).not.toHaveBeenCalled();
    expect((await adapter.listMessages(sessionId)).some((message) => message.role === "user")).toBe(false);
    expect(adapter.getPendingQuestions(sessionId)).toHaveLength(1);
    expect((adapter as any).messageQueues.size).toBe(0);
  });

  it("does not authorize visualization reads from an async user answer", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter, { threadId: "11111111-1111-4111-8111-111111111111" });
    const codexHome = mkdtempSync(join(tmpdir(), "codemux-question-image-"));
    const imagePath = join(codexHome, "visualizations", "2026", "10", "14", threadId, "preview.png");
    mkdirSync(dirname(imagePath), { recursive: true });
    writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC", "base64"));
    vi.stubEnv("CODEX_HOME", codexHome);
    try {
      const notify = (method: string, values: Record<string, unknown>) => (adapter as any).handleNotification(method, {
        threadId, turnId: "active-turn", ...values,
      });
      notify("turn/started", { turn: { id: "active-turn", status: "inProgress" } });
      notify("item/completed", { item: { id: "question", type: "agentMessage", questions: [{ title: "Which image?" }] } });
      client.request.mockResolvedValue({ turnId: "active-turn" });
      const markdown = `![Preview](${imagePath})`;
      await adapter.replyQuestion(adapter.getPendingQuestions(sessionId)[0].id, [[markdown]], sessionId);
      notify("item/completed", { item: { id: "native-image", type: "agentMessage", text: markdown } });
      notify("turn/completed", { turn: { id: "active-turn", status: "completed" } });
      const parts = (await adapter.listMessages(sessionId)).flatMap((message) => message.parts);
      const receipt = parts.find((part) => part.type === "text" && part.text === `Which image?\n\n${markdown}`);
      expect(receipt).toMatchObject({ type: "text", completed: true, phase: "commentary" });
      expect(receipt).not.toHaveProperty("inlineAssets");
      expect(parts.find((part) => part.type === "text" && part.text === markdown))
        .toMatchObject({ inlineAssets: [{ sourcePath: imagePath }] });
    } finally {
      vi.unstubAllEnvs();
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("restores only unanswered active questions and keeps local dismissals through history refresh", async () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const question = { id: "question", type: "agentMessage", questions: [{ title: "Environment?" }, { title: "Run checks?" }] };
    const answered = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(["request_user_input_async", "question", 0]), question: "Environment?", answer: "Staging" }])}\n</send_user_message_question_reply>`;
    const read = vi.spyOn(adapter, "readStoredThread").mockResolvedValue({ archived: false, thread: { id: threadId, turns: [
      { id: "old-turn", status: "completed", items: [{ id: "old-question", type: "agentMessage", questions: [{ title: "Old question?" }] }] },
      { id: "async-turn", status: "inProgress", items: [question, { id: "reply", type: "userMessage", content: [{ type: "text", text: answered }] }] },
    ] } } as any);
    await adapter.getHistoricalMessages(sessionId, "/repo");
    expect(adapter.getPendingQuestions(sessionId)).toHaveLength(1);
    expect(adapter.getPendingQuestions(sessionId)[0].questions.map((entry) => entry.question)).toEqual(["Run checks?"]);
    (adapter as any).handleNotification("item/completed", { threadId, turnId: "async-turn", item: question });
    expect(adapter.getPendingQuestions(sessionId)[0].questions.map((entry) => entry.question)).toEqual(["Run checks?"]);
    await adapter.rejectQuestion(adapter.getPendingQuestions(sessionId)[0].id, sessionId);
    await adapter.getHistoricalMessages(sessionId, "/repo");
    expect(adapter.getPendingQuestions(sessionId)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps newer asynchronous questions when an older history snapshot arrives", async () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    vi.spyOn(adapter, "readStoredThread").mockResolvedValue({ archived: false, thread: { id: threadId, turns: [
      { id: "old-turn", status: "completed", items: [] },
    ] } } as any);
    (adapter as any).handleNotification("turn/started", { threadId, turn: { id: "new-turn", status: "inProgress" } });
    (adapter as any).handleNotification("item/completed", { threadId, turnId: "new-turn", item: { id: "new-question", type: "agentMessage", questions: [{ title: "Current choice?" }] } });
    await adapter.getHistoricalMessages(sessionId, "/repo");
    expect(adapter.getPendingQuestions(sessionId)).toHaveLength(1);
    expect(adapter.getPendingQuestions(sessionId)[0].questions[0].question).toBe("Current choice?");
  });

  it("keeps a streamed asynchronous question absent from an older snapshot of the same turn", async () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    vi.spyOn(adapter, "readStoredThread").mockResolvedValue({ archived: false, thread: { id: threadId, turns: [
      { id: "async-turn", status: "inProgress", items: [] },
    ] } } as any);
    const item = { id: "new-question", type: "agentMessage", questions: [{ title: "Current choice?" }] };
    (adapter as any).handleNotification("turn/started", { threadId, turn: { id: "async-turn", status: "inProgress" } });
    (adapter as any).handleNotification("item/started", { threadId, turnId: "async-turn", item });
    await adapter.getHistoricalMessages(sessionId, "/repo");
    expect(adapter.getPendingQuestions(sessionId)).toHaveLength(1);
    (adapter as any).handleNotification("item/completed", { threadId, turnId: "async-turn", item });
    expect(adapter.getPendingQuestions(sessionId)).toHaveLength(1);
    expect(adapter.getPendingQuestions(sessionId)[0].questions[0].question).toBe("Current choice?");
  });

  it.each(["unknown", "mixed"])("ignores %s asynchronous reply receipts for live question state", async (source) => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    (adapter as any).handleNotification("turn/started", { threadId, turn: { id: "async-turn", status: "inProgress" } });
    (adapter as any).handleNotification("item/completed", { threadId, turnId: "async-turn", item: { id: "question", type: "agentMessage", questions: [{ title: "Continue?" }] } });
    const ids = source === "mixed" ? ["question", "unknown-question"] : ["unknown-question"];
    const text = `<send_user_message_question_reply>\n${JSON.stringify(ids.map((id) => ({
      questionItemId: JSON.stringify(["request_user_input_async", id, 0]), question: "Continue?", answer: "Yes",
    })))}\n</send_user_message_question_reply>`;
    (adapter as any).handleNotification("item/completed", { threadId, turnId: "async-turn", item: { id: "user-example", type: "userMessage", content: [{ type: "text", text }] } });
    expect(adapter.getPendingQuestions(sessionId)).toHaveLength(1);
    expect((adapter as any).messageBuffers.get(sessionId).parts.some((part: { text?: string }) => part.text?.includes("Yes"))).toBe(false);

    const runtime = adapter.createDesktopOwnerRuntime();
    client.request.mockResolvedValue({ turnId: "async-turn" });
    await runtime.request(sessionId, "turn/steer", { threadId, expectedTurnId: "async-turn", input: [{ type: "text", text, text_elements: [] }] });
    expect((await adapter.listMessages(sessionId)).filter((message) => message.role === "user")).toMatchObject([{ parts: [{ type: "text", text }] }]);
    expect(adapter.getPendingQuestions(sessionId)).toHaveLength(1);
  });

  it("refreshes completed command display actions without replacing tool identity or clearing omitted metadata", () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const buffer = (adapter as any).createMessageBuffer(sessionId, "/repo", threadId);
    (adapter as any).messageBuffers.set(sessionId, buffer);
    const commandActions = [{ type: "read", command: "cat src/main.ts", name: "main.ts", path: "src/main.ts" }];
    for (const id of ["late-actions", "retained-actions"]) {
      (adapter as any).handleItemStarted(sessionId, { item: {
        id, type: "commandExecution", command: "initial command", cwd: "/repo",
        ...(id === "retained-actions" ? { commandActions } : {}),
      } });
      const started = (adapter as any).activeToolParts.get(id);
      const originalInput = structuredClone(started.state.input);
      (adapter as any).handleItemCompleted(sessionId, { item: {
        id, type: "commandExecution", command: "cat src/main.ts", status: "completed", aggregatedOutput: "source output",
        ...(id === "late-actions" ? { commandActions } : {}),
      } });
      const completed = buffer.parts.find((part: { callId?: string }) => part.callId === id);
      expect(completed).toBe(started);
      expect(completed).toMatchObject({
        callId: id, normalizedTool: "shell", originalTool: "commandExecution", title: "Running cat src/main.ts",
        displayActions: [{ kind: "read", label: "main.ts", path: "/repo/src/main.ts", command: "cat src/main.ts" }],
        state: { status: "completed", input: originalInput, output: "source output" },
      });
    }
    expect(buffer.parts.filter((part: { type: string }) => part.type === "tool")).toHaveLength(2);
  });

  it("sets an error status when startup initialization fails", async () => {
    const adapter = new CodexAdapter();
    vi.spyOn(adapter as any, "spawnAndInitialize").mockRejectedValue(new Error("initialize timed out"));
    vi.spyOn(adapter as any, "refreshRuntimeMetadata").mockResolvedValue(undefined);

    await expect(adapter.start()).rejects.toThrow("initialize timed out");

    expect((adapter as any).spawnAndInitialize).toHaveBeenCalledTimes(1);
    expect((adapter as any).refreshRuntimeMetadata).not.toHaveBeenCalled();
    expect(adapter.getStatus()).toBe("error");
    expect(adapter.getInfo()).toMatchObject({
      status: "error",
      errorMessage: "initialize timed out",
    });
    expect((adapter as any).startPromise).toBeNull();
  });

  it("resumes an existing Codex thread from engineMeta during session creation", async () => {
    const { adapter } = createAdapterWithClient();
    vi.spyOn(adapter, "getStoredThreadAvailability").mockResolvedValue("active");
    vi.spyOn(adapter as any, "resumeThread").mockResolvedValue({
      thread: {
        id: "thread-123",
        name: "Existing Thread",
        createdAt: 1000,
        updatedAt: 2000,
      },
      model: "gpt-5.4",
      reasoningEffort: "xhigh",
    });
    vi.spyOn(adapter as any, "startThread").mockResolvedValue({
      thread: { id: "thread-new" },
    });
    vi.spyOn(adapter as any, "refreshCommandsForDirectory").mockResolvedValue([]);

    const session = await adapter.createSession("/repo", { codexThreadId: "thread-123" });

    expect((adapter as any).resumeThread).toHaveBeenCalledWith("thread-123", "/repo");
    expect((adapter as any).startThread).not.toHaveBeenCalled();
    expect(session).toMatchObject({
      id: "codex_thread-123",
      directory: "/repo",
      title: "Existing Thread",
      engineMeta: { codexThreadId: "thread-123" },
    });
    expect((adapter as any).sessionModels.get("codex_thread-123")).toBe("gpt-5.4");
    expect(adapter.getReasoningEffort("codex_thread-123")).toBe("max");
  });

  it("falls back to starting a new thread when resume fails", async () => {
    const { adapter } = createAdapterWithClient();
    vi.spyOn(adapter, "getStoredThreadAvailability").mockResolvedValue("missing");
    vi.spyOn(adapter as any, "resumeThread").mockRejectedValue(new Error("missing thread"));
    vi.spyOn(adapter as any, "startThread").mockResolvedValue({
      thread: {
        id: "thread-fresh",
        name: "Fresh Thread",
        createdAt: 3000,
        updatedAt: 4000,
      },
      model: "gpt-5.4",
    });
    vi.spyOn(adapter as any, "refreshCommandsForDirectory").mockResolvedValue([]);

    const session = await adapter.createSession("/repo", { codexThreadId: "thread-stale" });

    expect((adapter as any).resumeThread).toHaveBeenCalledWith("thread-stale", "/repo");
    expect((adapter as any).startThread).toHaveBeenCalledWith("/repo");
    expect(session.id).toBe("codex_thread-fresh");
  });

  it("refuses ordinary Codex restoration of an archived native thread without replacing it", async () => {
    const { adapter, client } = createAdapterWithClient();
    const thread = { id: "archived-native", cwd: "/repo", turns: [] };
    client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => method === "thread/read" ? { thread }
      : { data: params.archived ? [thread] : [], nextCursor: null });
    const resume = vi.spyOn(adapter as any, "resumeThread").mockResolvedValue({ thread });
    const create = vi.spyOn(adapter as any, "startThread");
    await expect(adapter.createSession("/repo", { codexThreadId: thread.id })).rejects.toMatchObject({ code: "CODEX_THREAD_ARCHIVED" });
    expect(resume).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("excludes archived native history from ordinary Codex imports before reading turns", async () => {
    const { adapter, client } = createAdapterWithClient();
    const thread = { id: "archived-native", cwd: "/repo", turns: [] };
    client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => method === "thread/read" ? { thread }
      : { data: params.archived ? [thread] : [], nextCursor: null });
    await expect(adapter.getHistoricalMessages("codex_archived-native", "/repo", { codexThreadId: thread.id })).rejects.toMatchObject({ code: "CODEX_THREAD_ARCHIVED" });
    expect(client.request.mock.calls.filter(([method]) => method === "thread/read").every(([, params]) => params.includeTurns === false)).toBe(true);
  });

  it("restores a marked CodeMux owner without overriding its original model, cwd, permissions or instructions", async () => {
    const { adapter, client } = createAdapterWithClient();
    (adapter as any).currentModelId = "today-default";
    const saved = {
      thread: { id: "saved-thread", cwd: "/saved/repo", name: "Saved work", turns: [] },
      model: "original-model", modelProvider: "modelhub", reasoningEffort: "ultra",
      approvalPolicy: "on-request", sandbox: { type: "readOnly" }, serviceTier: "fast",
      collaborationMode: { mode: "plan", settings: { model: "original-model", reasoning_effort: "ultra", developer_instructions: null } },
    };
    client.request.mockImplementation(async (method: string) => method === "thread/resume" || method === "thread/read" ? saved : { data: [] });
    const session = await adapter.createSession("/outdated/path", { codexThreadId: "saved-thread", codexDesktopOwner: "codemux" });
    expect(client.request).toHaveBeenCalledWith("thread/resume", { threadId: "saved-thread", persistExtendedHistory: true });
    expect(client.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    expect(session).toMatchObject({ id: "codex_saved-thread", directory: "/saved/repo", engineMeta: { codexThreadId: "saved-thread" } });
    const state = await createCodexDesktopOwnerRuntime(adapter).readThread(session.id);
    expect(state).toMatchObject({ model: "original-model", modelProvider: "modelhub", reasoningEffort: "ultra", approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" }, collaborationMode: { mode: "plan" } });
  });

  it("never creates a replacement thread for a failed or mismatched marked owner restore", async () => {
    const { adapter, client } = createAdapterWithClient();
    const startThread = vi.spyOn(adapter as any, "startThread");
    client.request.mockRejectedValueOnce(new Error("Original thread missing"));
    await expect(adapter.createSession("/repo", { codexThreadId: "original", codexDesktopOwner: "codemux" })).rejects.toThrow("Original thread missing");
    client.request.mockResolvedValueOnce({ thread: { id: "replacement" } });
    await expect(adapter.createSession("/repo", { codexThreadId: "original", codexDesktopOwner: "codemux" })).rejects.toThrow("changed the original");
    await expect(adapter.createSession("/repo", { codexDesktopOwner: "codemux" })).rejects.toThrow("original Codex thread ID");
    expect(startThread).not.toHaveBeenCalled();
    expect((adapter as any).sessionToThread.size).toBe(0);
  });

  it("loads model metadata from model/list and adopts the default model", async () => {
    const { adapter, client } = createAdapterWithClient();
    client.request.mockResolvedValue({
      data: [{
        model: "gpt-5.4",
        displayName: "GPT-5.4",
        description: "Primary coding model",
        inputModalities: ["image"],
        supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "xhigh" }],
        defaultReasoningEffort: "xhigh",
        isDefault: true,
      }],
      nextCursor: null,
    });

    const result = await adapter.listModels();

    expect(client.request).toHaveBeenCalledWith("model/list", {
      cursor: undefined,
      limit: 100,
      includeHidden: false,
    });
    expect(result.currentModelId).toBe("gpt-5.4");
    expect(result.models).toEqual([
      expect.objectContaining({
        modelId: "gpt-5.4",
        name: "GPT-5.4",
        description: "Primary coding model",
        capabilities: expect.objectContaining({
          attachment: true,
          reasoning: true,
          supportedReasoningEfforts: ["high", "max"],
          defaultReasoningEffort: "max",
        }),
      }),
    ]);
  });

  it("reads historical thread messages with includeTurns enabled", async () => {
    const { adapter, client } = createAdapterWithClient();
    const response = {
      thread: {
        id: "thread-1",
        createdAt: 100,
        turns: [{
          id: "turn-1",
          items: [
            { type: "userMessage", id: "user-1", content: [{ type: "text", text: "Fix it" }] },
            { type: "agentMessage", id: "assistant-1", text: "Done" },
          ],
        }],
      },
    };
    client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => method === "thread/read" ? response
      : { data: params.archived ? [] : [response.thread], nextCursor: null });

    const messages = await adapter.getHistoricalMessages("codex_thread-1", "/repo\\sub", { codexThreadId: "thread-1" });

    expect(client.request).toHaveBeenCalledWith("thread/read", {
      threadId: "thread-1",
      includeTurns: true,
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      workingDirectory: "/repo/sub",
      engineMeta: { codexThreadId: "thread-1" },
    });
  });

  it("starts turns with cwd, sandbox, model, reasoning effort, and collaboration mode", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId } = seedSession(adapter);
    client.request.mockImplementation(async (method: string) => {
      if (method === "turn/start") {
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const responsePromise = adapter.sendMessage(
      sessionId,
      [{ type: "text", text: "Fix the failing tests" }],
      { mode: "plan", modelId: "gpt-5.4", reasoningEffort: "max", directory: "/repo" },
    );
    await flushMicrotasks();

    expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        threadId: "thread-1",
        cwd: "/repo",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/repo"],
          readOnlyAccess: { type: "fullAccess" },
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        model: "gpt-5.4",
        effort: "xhigh",
        collaborationMode: expect.objectContaining({
          mode: "plan",
        }),
      }),
      120000,
    );

    (adapter as any).handleAgentMessageDelta(sessionId, { delta: "Done." });
    (adapter as any).handleTurnCompleted(sessionId, { turn: { id: "turn-1", status: "completed" } });

    const response = await responsePromise;
    const messages = await adapter.listMessages(sessionId);

    expect(response).toMatchObject({
      role: "assistant",
      workingDirectory: "/repo",
      modelId: "gpt-5.4",
      reasoningEffort: "max",
      engineMeta: { codexThreadId: "thread-1" },
    });
    expect((response.parts[0] as any).text).toBe("Done.");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("steers an active turn when mode/model/directory stay compatible", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId } = seedSession(adapter);
    (adapter as any).currentModelId = "gpt-5.4";
    (adapter as any).sessionModels.set(sessionId, "gpt-5.4");

    client.request.mockImplementation(async (method: string) => {
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      if (method === "turn/steer") return {};
      throw new Error(`unexpected method: ${method}`);
    });

    const first = adapter.sendMessage(sessionId, [{ type: "text", text: "First" }]);
    await flushMicrotasks();
    const second = adapter.sendMessage(sessionId, [{ type: "text", text: "Second" }]);
    await flushMicrotasks();

    expect(client.request).toHaveBeenNthCalledWith(2, "turn/steer", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Second", text_elements: [] }],
      expectedTurnId: "turn-1",
    }, 120000);

    (adapter as any).handleAgentMessageDelta(sessionId, { delta: "Merged response" });
    (adapter as any).handleTurnCompleted(sessionId, { turn: { id: "turn-1", status: "completed" } });

    const [message1, message2] = await Promise.all([first, second]);
    const history = await adapter.listMessages(sessionId);

    expect(message1.id).toBe(message2.id);
    expect((message1.parts[0] as any).text).toBe("Merged response");
    expect(history.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
  });

  it("queues a second message when the active turn cannot be steered and starts it after completion", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId } = seedSession(adapter);
    const queuedEvents: Array<{ sessionId: string; messageId: string; queuePosition: number }> = [];
    const consumedEvents: Array<{ sessionId: string; messageId: string }> = [];
    adapter.on("message.queued", (event) => queuedEvents.push(event));
    adapter.on("message.queued.consumed", (event) => consumedEvents.push(event));

    client.request.mockImplementation(async (method: string, params: any) => {
      if (method !== "turn/start") throw new Error(`unexpected method: ${method}`);
      if (params.model === "codex-mini-latest") return { turn: { id: "turn-1" } };
      if (params.model === "gpt-5.4") return { turn: { id: "turn-2" } };
      throw new Error(`unexpected model: ${String(params.model)}`);
    });

    const first = adapter.sendMessage(sessionId, [{ type: "text", text: "First" }]);
    await flushMicrotasks();

    const second = adapter.sendMessage(
      sessionId,
      [{ type: "text", text: "Second" }],
      { modelId: "gpt-5.4" },
    );
    await flushMicrotasks();

    expect(queuedEvents).toHaveLength(1);
    expect(queuedEvents[0]).toMatchObject({ sessionId, queuePosition: 1 });

    (adapter as any).handleAgentMessageDelta(sessionId, { delta: "First done" });
    (adapter as any).handleTurnCompleted(sessionId, { turn: { id: "turn-1", status: "completed" } });
    await flushMicrotasks();

    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "turn/start",
      expect.objectContaining({ model: "gpt-5.4" }),
      120000,
    );
    expect(consumedEvents).toHaveLength(1);
    expect(consumedEvents[0]).toMatchObject({ sessionId });

    (adapter as any).handleAgentMessageDelta(sessionId, { delta: "Second done" });
    (adapter as any).handleTurnCompleted(sessionId, { turn: { id: "turn-2", status: "completed" } });

    const [firstMessage, secondMessage] = await Promise.all([first, second]);
    expect((firstMessage.parts[0] as any).text).toBe("First done");
    expect((secondMessage.parts[0] as any).text).toBe("Second done");
  });

  it("maps permission replies to stable approval decisions", async () => {
    const { adapter, client } = createAdapterWithClient();
    (adapter as any).pendingPermissions.set("perm-command", {
      requestId: "req-command",
      sessionId: "codex_thread-1",
      method: "item/commandExecution/requestApproval",
      params: { itemId: "tool-1" },
      permission: { id: "perm-command" },
    });

    await adapter.replyPermission("perm-command", { optionId: "allow_always" });

    expect(client.respond).toHaveBeenCalledWith("req-command", {
      decision: "acceptForSession",
    });

    (adapter as any).pendingPermissions.set("perm-perms", {
      requestId: "req-perms",
      sessionId: "codex_thread-1",
      method: "item/permissions/requestApproval",
      params: {
        permissions: { fileSystem: { read: ["/repo"] } },
      },
      permission: { id: "perm-perms" },
    });

    await adapter.replyPermission("perm-perms", { optionId: "reject_once" });

    expect(client.respond).toHaveBeenCalledWith("req-perms", {
      permissions: {},
      scope: "turn",
    });
  });

  it("maps question answers by question id when replying to requestUserInput", async () => {
    const { adapter, client } = createAdapterWithClient();
    (adapter as any).pendingQuestions.set("question-1", {
      requestId: "req-question",
      sessionId: "codex_thread-1",
      params: {
        questions: [
          { id: "env", question: "Environment?" },
          { id: "branch", question: "Branch?" },
        ],
      },
      question: { id: "question-1" },
    });

    await adapter.replyQuestion("question-1", [["staging"], ["feat/codex"]]);

    expect(client.respond).toHaveBeenCalledWith("req-question", {
      answers: {
        env: { answers: ["staging"] },
        branch: { answers: ["feat/codex"] },
      },
    });
  });

  it("loads skills as commands and invokes them via skill input", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId } = seedSession(adapter);

    client.request.mockImplementation(async (method: string, params: any) => {
      if (method === "skills/list") {
        return {
          data: [{
            cwd: "/repo",
            skills: [{
              name: "fix",
              path: "/skills/fix.md",
              enabled: true,
              scope: "project",
              interface: { shortDescription: "Fix repository issues" },
            }],
          }],
        };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const commands = await adapter.listCommands(sessionId, "/repo");
    expect(commands).toEqual([{
      name: "fix",
      description: "Fix repository issues",
      source: "project",
      userInvocable: true,
    }]);

    const invokePromise = adapter.invokeCommand(sessionId, "fix", "focus auth flow");
    await flushMicrotasks();

    const turnStartCall = client.request.mock.calls.find((call) => call[0] === "turn/start");
    expect(turnStartCall).toBeDefined();
    expect(turnStartCall?.[1]).toEqual(expect.objectContaining({
      input: [
        { type: "skill", name: "fix", path: "/skills/fix.md" },
        { type: "text", text: "focus auth flow", text_elements: [] },
      ],
    }));
    expect(turnStartCall?.[2]).toBe(120000);

    (adapter as any).handleAgentMessageDelta(sessionId, { delta: "Skill executed" });
    (adapter as any).handleTurnCompleted(sessionId, { turn: { id: "turn-1", status: "completed" } });

    const result = await invokePromise;
    expect(result.handledAsCommand).toBe(true);
    expect((result.message?.parts[0] as any).text).toBe("Skill executed");
  });

  it("reports runtime info, reasoning effort, and session state from the adapter cache", async () => {
    const { adapter } = createAdapterWithClient();
    seedSession(adapter, { sessionId: "codex_thread-1", threadId: "thread-1", directory: "/repo/a", title: "Alpha" });
    seedSession(adapter, { sessionId: "codex_thread-2", threadId: "thread-2", directory: "/repo/b", title: "Beta" });

    (adapter as any).version = "codex-cli 1.2.3";
    (adapter as any).authenticated = true;
    (adapter as any).authMessage = "user@example.com";

    expect(await adapter.healthCheck()).toBe(true);
    expect(adapter.hasSession("codex_thread-1")).toBe(true);
    expect(adapter.hasSession("missing")).toBe(false);

    await adapter.setModel("codex_thread-1", "gpt-5.4");
    await adapter.setMode("codex_thread-1", "plan");
    await adapter.setReasoningEffort("codex_thread-1", "high");

    expect(adapter.getReasoningEffort("codex_thread-1")).toBe("high");
    expect(await adapter.listSessions("/repo/a")).toEqual([
      expect.objectContaining({
        id: "codex_thread-1",
        directory: "/repo/a",
        title: "Alpha",
        engineMeta: { codexThreadId: "thread-1" },
      }),
    ]);
    expect(await adapter.getSession("codex_thread-2")).toMatchObject({
      id: "codex_thread-2",
      directory: "/repo/b",
      title: "Beta",
    });
    expect(await adapter.getSession("missing")).toBeNull();
    expect(await adapter.listProjects()).toEqual([]);

    const info = adapter.getInfo();
    expect(info).toMatchObject({
      type: "codex",
      name: "Codex",
      version: "codex-cli 1.2.3",
      status: "running",
      authenticated: true,
      authMessage: "user@example.com",
    });
    expect(info.capabilities.availableModes.map((mode) => mode.id)).toEqual(["default", "plan"]);
    expect(info.authMethods).toEqual([{
      id: "openai",
      name: "OpenAI",
      description: "Use Codex's existing OpenAI login or API key configuration.",
    }]);

    await adapter.setReasoningEffort("codex_thread-1", null);
    expect(adapter.getReasoningEffort("codex_thread-1")).toBeNull();

    (adapter as any).status = "error";
    (adapter as any).lastError = "boot failed";
    expect(await adapter.healthCheck()).toBe(false);
    expect(adapter.getInfo().errorMessage).toBe("boot failed");
  });

  it("cancels active turns, resolves the in-flight response, clears prompts, and updates the directory", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const tempDir = mkdtempSync(join(tmpdir(), "codemux-cancel-"));
    const buffer = (adapter as any).createMessageBuffer(sessionId, "/repo", threadId);
    const resolve = vi.fn();

    (adapter as any).messageBuffers.set(sessionId, buffer);
    (adapter as any).turnResolvers.set(sessionId, [{ resolve, reject: vi.fn() }]);
    (adapter as any).activeTurnIds.set(sessionId, "turn-1");
    (adapter as any).activeTempDirs.set(sessionId, [tempDir]);
    (adapter as any).pendingPermissions.set("perm-1", {
      requestId: "req-1",
      sessionId,
      method: "item/commandExecution/requestApproval",
      params: {},
      permission: { id: "perm-1" },
    });
    (adapter as any).pendingQuestions.set("question-1", {
      requestId: "req-2",
      sessionId,
      params: {},
      question: { id: "question-1" },
    });
    client.request.mockResolvedValue(undefined);

    await adapter.cancelMessage(sessionId, "/repo\\next");

    expect(client.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(client.respond).toHaveBeenCalledWith("req-1", { decision: "decline" });
    expect(client.respondError).toHaveBeenCalledWith("req-2", -32000, "Cancelled");
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      role: "assistant",
      error: "Cancelled",
      staleSession: false,
      engineMeta: { codexThreadId: "thread-1", codexTurnId: "turn-1" },
    }));
    expect((adapter as any).pendingPermissions.size).toBe(0);
    expect((adapter as any).pendingQuestions.size).toBe(0);
    expect((adapter as any).sessionDirectories.get(sessionId)).toBe("/repo/next");
    expect((adapter as any).messageBuffers.has(sessionId)).toBe(false);
    expect((adapter as any).activeTurnIds.has(sessionId)).toBe(false);
    expect(existsSync(tempDir)).toBe(false);
  });

  it("unsubscribes and clears all session state when deleting a session", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId } = seedSession(adapter);
    const tempDir = mkdtempSync(join(tmpdir(), "codemux-delete-"));
    const queueReject = vi.fn();

    (adapter as any).messageHistory.set(sessionId, [{ id: "msg-1" }]);
    (adapter as any).messageQueues.set(sessionId, [{
      input: [],
      userMessage: {} as any,
      tempDirs: [tempDir],
      resolver: { resolve: vi.fn(), reject: queueReject },
    }]);
    (adapter as any).pendingPermissions.set("perm-1", {
      requestId: "req-1",
      sessionId,
      method: "item/commandExecution/requestApproval",
      params: {},
      permission: { id: "perm-1" },
    });
    (adapter as any).pendingQuestions.set("question-1", {
      requestId: "req-2",
      sessionId,
      params: {},
      question: { id: "question-1" },
    });
    (adapter as any).activeTempDirs.set(sessionId, [tempDir]);
    client.request.mockResolvedValue(undefined);

    await adapter.deleteSession(sessionId);

    expect(client.request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "thread-1" });
    expect(client.respond).toHaveBeenCalledWith("req-1", { decision: "decline" });
    expect(client.respondError).toHaveBeenCalledWith("req-2", -32000, "Session deleted");
    expect((adapter as any).sessionToThread.has(sessionId)).toBe(false);
    expect((adapter as any).threadToSession.has("thread-1")).toBe(false);
    expect((adapter as any).threads.has("thread-1")).toBe(false);
    expect((adapter as any).messageHistory.has(sessionId)).toBe(false);
    expect((adapter as any).pendingPermissions.size).toBe(0);
    expect((adapter as any).pendingQuestions.size).toBe(0);
    expect(queueReject).toHaveBeenCalledWith(expect.objectContaining({ message: "Session deleted" }));
    expect(existsSync(tempDir)).toBe(false);
  });

  it("lists historical sessions across multiple pages and marks imported threads", async () => {
    const { adapter, client } = createAdapterWithClient();
    (adapter as any).threadToSession.set("thread-imported", "codex_thread-imported");
    client.request
      .mockResolvedValueOnce({
        data: [
          {
            id: "thread-1",
            name: "First",
            cwd: "/repo\\one",
            createdAt: 10,
            updatedAt: 20,
          },
          {
            id: "thread-imported",
            preview: "Imported preview",
            cwd: "/repo/two",
            createdAt: 30,
            updatedAt: 40,
          },
        ],
        nextCursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        data: [{
          id: "thread-3",
          preview: "Third",
          cwd: "/repo/three",
          createdAt: 50,
          updatedAt: 60,
        }],
        nextCursor: null,
      });

    const sessions = await adapter.listHistoricalSessions(3);

    expect(client.request).toHaveBeenNthCalledWith(1, "thread/list", {
      cursor: undefined,
      limit: 3,
      sortKey: "updated_at",
      archived: false,
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "thread/list", {
      cursor: "cursor-2",
      limit: 3,
      sortKey: "updated_at",
      archived: false,
    });
    expect(sessions).toEqual([
      expect.objectContaining({
        engineSessionId: "codex_thread-1",
        title: "First",
        directory: "/repo/one",
        alreadyImported: false,
        engineMeta: { codexThreadId: "thread-1" },
      }),
      expect.objectContaining({
        engineSessionId: "codex_thread-imported",
        title: "Imported preview",
        directory: "/repo/two",
        alreadyImported: true,
      }),
      expect.objectContaining({
        engineSessionId: "codex_thread-3",
        title: "Third",
        directory: "/repo/three",
        alreadyImported: false,
      }),
    ]);
  });

  it("refreshes runtime metadata, config requirements, auth states, and model fallbacks", async () => {
    const { adapter, client } = createAdapterWithClient();
    const configSpy = vi.spyOn(adapter as any, "refreshConfigRequirements").mockResolvedValue(undefined);
    const modelSpy = vi.spyOn(adapter as any, "refreshModelCache").mockResolvedValue(undefined);
    const authSpy = vi.spyOn(adapter as any, "refreshAuthStatus").mockResolvedValue(undefined);

    await (adapter as any).refreshRuntimeMetadata();

    expect(configSpy).toHaveBeenCalledTimes(1);
    expect(modelSpy).toHaveBeenCalledTimes(1);
    expect(authSpy).toHaveBeenCalledTimes(1);

    configSpy.mockRestore();
    modelSpy.mockRestore();
    authSpy.mockRestore();

    client.request.mockResolvedValueOnce({
      requirements: {
        allowedApprovalPolicies: ["never", "unsupported"],
        allowedSandboxModes: ["workspace-write", "invalid"],
      },
    });
    await (adapter as any).refreshConfigRequirements();
    expect((adapter as any).configRequirements).toEqual({
      allowedApprovalPolicies: ["never", "unsupported"],
      allowedSandboxModes: ["workspace-write", "invalid"],
    });

    client.request.mockResolvedValueOnce({ account: {}, requiresOpenaiAuth: true });
    await (adapter as any).refreshAuthStatus();
    expect(adapter.getInfo()).toMatchObject({
      authenticated: false,
      authMessage: "OpenAI authentication required",
    });

    client.request.mockResolvedValueOnce({ account: { type: "chatgpt", email: "user@example.com" } });
    await (adapter as any).refreshAuthStatus();
    expect(adapter.getInfo()).toMatchObject({ authenticated: true, authMessage: "user@example.com" });

    client.request.mockResolvedValueOnce({ account: { type: "apiKey" } });
    await (adapter as any).refreshAuthStatus();
    expect(adapter.getInfo()).toMatchObject({ authenticated: true, authMessage: "API key" });

    client.request.mockResolvedValueOnce({ account: { type: "workspace" } });
    await (adapter as any).refreshAuthStatus();
    expect(adapter.getInfo()).toMatchObject({ authenticated: true, authMessage: "Authenticated" });

    client.request.mockRejectedValueOnce(new Error("offline"));
    await expect((adapter as any).refreshAuthStatus()).resolves.toBeUndefined();

    (adapter as any).cachedModels = [];
    client.request.mockResolvedValueOnce({ data: [], nextCursor: null });
    await (adapter as any).refreshModelCache();
    expect((adapter as any).cachedModels).toEqual([
      expect.objectContaining({ modelId: "codex-mini-latest", name: "codex-mini-latest" }),
    ]);

    (adapter as any).cachedModels = [];
    client.request
      .mockResolvedValueOnce({
        data: [{
          model: "gpt-5.4",
          displayName: "GPT-5.4",
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          defaultReasoningEffort: "high",
          isDefault: true,
        }],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        data: [{ id: "gpt-5.4-mini", description: "Mini" }],
        nextCursor: null,
      });
    await (adapter as any).refreshModelCache();
    expect((adapter as any).currentModelId).toBe("gpt-5.4");
    expect((adapter as any).cachedModels).toEqual([
      expect.objectContaining({ modelId: "gpt-5.4", name: "GPT-5.4" }),
      expect.objectContaining({ modelId: "gpt-5.4-mini", description: "Mini" }),
    ]);
  });

  it("loads commands, caches skills, and refreshes them when Codex reports changes", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId } = seedSession(adapter);
    const commandEvents: string[][] = [];
    adapter.on("commands.changed", (event) => {
      commandEvents.push(event.commands.map((command) => `${command.name}:${String(command.userInvocable)}`));
    });

    client.request.mockResolvedValueOnce({
      data: [{
        cwd: "/repo",
        skills: [
          {
            name: "fix",
            path: "/skills/fix.md",
            enabled: true,
            scope: "project",
            interface: { shortDescription: "Fix the repo" },
          },
          {
            name: "plan",
            path: "/skills/plan.md",
            enabled: false,
            description: "Plan before coding",
          },
        ],
      }],
    });

    const commands = await adapter.listCommands(sessionId, "/repo");

    expect(commands).toEqual([
      { name: "fix", description: "Fix the repo", source: "project", userInvocable: true },
      { name: "plan", description: "Plan before coding", source: undefined, userInvocable: false },
    ]);
    expect(commandEvents).toEqual([["fix:true", "plan:false"]]);

    client.request.mockResolvedValueOnce({
      data: [{
        cwd: "/repo",
        skills: [{
          name: "fix",
          path: "/skills/fix.md",
          enabled: true,
          interface: { shortDescription: "Fix the repo better" },
        }],
      }],
    });

    (adapter as any).handleSkillsChanged();
    await flushMicrotasks();

    expect(commandEvents).toEqual([
      ["fix:true", "plan:false"],
      ["fix:true"],
    ]);

    (adapter.start as any).mockRejectedValueOnce(new Error("offline"));
    await expect(adapter.listCommands(sessionId, "/repo")).resolves.toEqual([
      { name: "fix", description: "Fix the repo better", source: undefined, userInvocable: true },
    ]);
    await expect(adapter.invokeCommand(sessionId, "plan", "")).resolves.toEqual({ handledAsCommand: false });
  });

  it("dispatches Codex notifications into thread state, token usage, plan text, and compaction notices", async () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const sessionUpdates: Array<{ id: string; title?: string }> = [];
    const partUpdates: any[] = [];
    adapter.on("session.updated", (event) => sessionUpdates.push(event.session));
    adapter.on("message.part.updated", (event) => partUpdates.push(event.part));

    const buffer = (adapter as any).createMessageBuffer(sessionId, "/repo", threadId);
    (adapter as any).messageBuffers.set(sessionId, buffer);

    (adapter as any).handleNotification("thread/started", {
      thread: {
        id: threadId,
        cwd: "/repo\\nested",
        name: "Nested Thread",
        createdAt: 10,
        updatedAt: 20,
      },
    });
    expect((adapter as any).threads.get(threadId)).toMatchObject({
      directory: "/repo/nested",
      title: "Nested Thread",
      createdAt: 10_000,
      updatedAt: 20_000,
      loaded: true,
    });

    (adapter as any).handleNotification("thread/name/updated", { threadId, threadName: "Renamed Thread" });
    (adapter as any).handleNotification("thread/status/changed", { threadId, status: { type: "notLoaded" } });
    (adapter as any).handleNotification("thread/closed", { threadId });
    (adapter as any).handleNotification("turn/started", { threadId, turn: { id: "turn-1" } });
    (adapter as any).handleNotification("thread/tokenUsage/updated", {
      threadId,
      tokenUsage: { last: { inputTokens: 2, outputTokens: 3 } },
    });
    (adapter as any).handleNotification("turn/diff/updated", { threadId, diff: "@@ -1 +1 @@" });
    (adapter as any).handleNotification("turn/plan/updated", {
      threadId,
      explanation: "Explain the rollout",
      plan: [{ step: "Ship it", status: "completed" }],
    });
    (adapter as any).handleNotification("model/rerouted", { threadId, toModel: "gpt-5.4" });
    (adapter as any).handleNotification("thread/compacted", { threadId });
    (adapter as any).handleNotification("thread/unknown", { threadId });

    expect(sessionUpdates).toContainEqual({ id: sessionId, engineType: "codex", title: "Renamed Thread" });
    expect((adapter as any).threads.get(threadId)?.loaded).toBe(false);
    expect((adapter as any).activeTurnIds.get(sessionId)).toBe("turn-1");
    expect(buffer.tokens).toEqual({ input: 2, output: 3 });
    expect(buffer.engineMeta).toEqual({ codexThreadId: threadId, codexTurnId: "turn-1", turnDiff: "@@ -1 +1 @@" });
    expect(buffer.modelId).toBe("gpt-5.4");
    expect(partUpdates.some((part) => part.type === "text" && part.text.includes("## Plan"))).toBe(true);
    expect(partUpdates.some((part) => part.type === "system-notice" && part.noticeType === "compact")).toBe(true);
  });

  it("keeps native reasoning items stable across deltas and tool boundaries", () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const notify = (method: string, data: Record<string, unknown>) =>
      (adapter as any).handleNotification(method, { threadId, turnId: "turn-1", ...data });
    const reasoningParts = () => (adapter as any).messageBuffers.get(sessionId).parts
      .filter((part: any) => part.type === "reasoning");

    notify("turn/started", { turn: { id: "turn-1" } });
    notify("item/started", { item: { id: "reason-1", type: "reasoning", summary: [], content: [] } });
    notify("item/reasoning/textDelta", { itemId: "reason-1", contentIndex: 0, delta: "Inspect failures" });
    expect(reasoningParts()).toEqual([]);
    notify("item/reasoning/summaryTextDelta", { itemId: "reason-1", summaryIndex: 0, delta: "Inspect " });
    const firstId = reasoningParts()[0].id;
    notify("item/reasoning/summaryTextDelta", { itemId: "reason-1", summaryIndex: 0, delta: "failures" });
    expect(reasoningParts()).toHaveLength(1);
    expect(reasoningParts()[0]).toMatchObject({ id: firstId, text: "Inspect failures" });
    notify("item/reasoning/textDelta", { itemId: "reason-1", contentIndex: 0, delta: " before changing anything" });
    expect(reasoningParts()[0]).toMatchObject({ id: firstId, text: "Inspect failures" });

    const firstReasoning = { id: "reason-1", type: "reasoning", summary: ["Inspect failures"], content: ["Inspect failures"] };
    notify("item/completed", { item: firstReasoning });
    notify("item/started", { item: { id: "cmd-1", type: "commandExecution", command: "bun test" } });
    notify("item/completed", { item: { id: "cmd-1", type: "commandExecution", command: "bun test", status: "completed" } });
    notify("item/started", { item: { id: "reason-2", type: "reasoning", summary: [], content: [] } });
    notify("item/reasoning/summaryTextDelta", { itemId: "reason-2", summaryIndex: 1, delta: "Verify result" });
    notify("item/reasoning/summaryTextDelta", { itemId: "reason-2", summaryIndex: 0, delta: "Apply fix" });
    const secondReasoning = { id: "reason-2", type: "reasoning", summary: ["Apply fix", "Verify result"], content: [] };
    notify("item/completed", { item: secondReasoning });
    // Repeated native snapshots must update their own item instead of adding or overwriting another item.
    notify("item/completed", { item: firstReasoning });
    notify("item/completed", { item: secondReasoning });

    expect(reasoningParts().map((part: any) => part.text)).toEqual(["Inspect failures", "Apply fix\n\nVerify result"]);
    expect(reasoningParts()[0].id).toBe(firstId);
    expect(reasoningParts()[1].id).not.toBe(firstId);
    const streamed = (adapter as any).messageBuffers.get(sessionId).parts
      .filter((part: any) => part.type === "reasoning" || part.type === "tool")
      .sort((left: any, right: any) => (left.order ?? 0) - (right.order ?? 0))
      .map((part: any) => ({ type: part.type, text: part.text }));
    const [history] = convertThreadToMessages(sessionId, { thread: { id: threadId, turns: [{
      id: "turn-1", status: "completed", items: [firstReasoning,
        { id: "cmd-1", type: "commandExecution", command: "bun test", status: "completed" }, secondReasoning],
    }] } });
    expect(history.parts.filter((part) => part.type === "reasoning" || part.type === "tool")
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      .map((part: any) => ({ type: part.type, text: part.text }))).toEqual(streamed);
  });

  it("preserves streamed reasoning when completion omits text and ignores late deltas", () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const notify = (method: string, data: Record<string, unknown>) =>
      (adapter as any).handleNotification(method, { threadId, turnId: "turn-1", ...data });
    notify("item/reasoning/summaryTextDelta", { itemId: "reason-1", summaryIndex: 0, delta: "Check the tests" });
    notify("item/completed", { item: { id: "reason-1", type: "reasoning", summary: [], content: [] } });
    notify("item/reasoning/summaryTextDelta", { itemId: "reason-1", summaryIndex: 0, delta: "Check the tests" });
    const parts = (adapter as any).messageBuffers.get(sessionId).parts;
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "reasoning", text: "Check the tests" });
  });

  it("starts the next turn with fresh reasoning item state", () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const notify = (method: string, data: Record<string, unknown>) =>
      (adapter as any).handleNotification(method, { threadId, ...data });
    notify("turn/started", { turn: { id: "turn-1" } });
    notify("item/reasoning/summaryTextDelta", { turnId: "turn-1", itemId: "reason-1", delta: "First turn" });
    notify("item/completed", { turnId: "turn-1", item: { id: "reason-1", type: "reasoning", summary: ["First turn"] } });
    const firstPartId = (adapter as any).messageBuffers.get(sessionId).parts[0].id;
    notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    expect((adapter as any).messageBuffers.has(sessionId)).toBe(false);
    notify("turn/started", { turn: { id: "turn-2" } });
    notify("item/reasoning/summaryTextDelta", { turnId: "turn-2", itemId: "reason-1", delta: "Next turn" });
    const parts = (adapter as any).messageBuffers.get(sessionId).parts;
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "reasoning", text: "Next turn" });
    expect(parts[0].id).not.toBe(firstPartId);
  });

  it("does not emit completed empty reasoning placeholders", () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const parts: any[] = [];
    adapter.on("message.part.updated", ({ part }) => parts.push(part));
    for (let index = 0; index < 4; index++) {
      const item = { id: `reason-${index}`, type: "reasoning", summary: [], content: [] };
      (adapter as any).handleNotification("item/started", { threadId, turnId: "turn-1", item });
      (adapter as any).handleNotification("item/completed", { threadId, turnId: "turn-1", item });
    }
    expect(parts.filter((part) => part.type === "reasoning")).toEqual([]);
    expect((adapter as any).messageBuffers.get(sessionId).parts).toEqual([]);
  });

  it("streams tool, reasoning, plan, and notice events into a single assistant buffer", async () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const buffer = (adapter as any).createMessageBuffer(sessionId, "/repo", threadId);
    (adapter as any).messageBuffers.set(sessionId, buffer);

    (adapter as any).handleAgentMessageDelta(sessionId, { delta: "Hello" });
    (adapter as any).handlePlanDelta(sessionId, { delta: "Draft steps" });
    (adapter as any).handleReasoningDelta(sessionId, { delta: "Think first" });

    (adapter as any).handleItemStarted(sessionId, {
      item: { id: "cmd-1", type: "commandExecution", command: "bun test", cwd: "/repo" },
    });
    (adapter as any).handleToolOutputDelta(sessionId, { itemId: "cmd-1", delta: "running\n" });
    (adapter as any).handleItemCompleted(sessionId, {
      item: {
        id: "cmd-1",
        type: "commandExecution",
        command: "bun test",
        cwd: "/repo",
        aggregatedOutput: "all green",
        status: "completed",
        exitCode: 0,
      },
    });

    (adapter as any).handleItemStarted(sessionId, {
      item: {
        id: "edit-1",
        type: "fileChange",
        changes: [{ path: "/repo/src/app.ts", diff: "@@ base @@" }],
      },
    });
    (adapter as any).handleFileChangeDelta(sessionId, { itemId: "edit-1", delta: "\n@@ patch @@" });
    (adapter as any).handleItemCompleted(sessionId, {
      item: {
        id: "edit-1",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "/repo/src/app.ts", diff: "@@ final @@" }],
      },
    });

    (adapter as any).handleItemStarted(sessionId, {
      item: {
        id: "mcp-1",
        type: "mcpToolCall",
        server: "docs",
        tool: "search",
        arguments: { query: "codex" },
      },
    });
    (adapter as any).handleMcpProgress(sessionId, { itemId: "mcp-1", message: "fetching" });
    (adapter as any).handleMcpProgress(sessionId, { itemId: "mcp-1", message: "done" });
    (adapter as any).handleItemCompleted(sessionId, {
      item: {
        id: "mcp-1",
        type: "mcpToolCall",
        result: "doc-1",
        status: "completed",
      },
    });

    (adapter as any).handleItemStarted(sessionId, { item: { type: "contextCompaction" } });
    (adapter as any).handleItemStarted(sessionId, { item: { type: "enteredReviewMode" } });
    (adapter as any).handleItemStarted(sessionId, { item: { type: "exitedReviewMode" } });

    (adapter as any).handleItemCompleted(sessionId, { item: { type: "agentMessage", text: "Final answer" } });
    (adapter as any).handleItemCompleted(sessionId, {
      item: {
        type: "reasoning",
        summary: ["Inspect"],
        content: ["Apply the fix"],
      },
    });
    (adapter as any).handleItemCompleted(sessionId, { item: { type: "plan", text: "Ship tests" } });
    (adapter as any).handleItemCompleted(sessionId, { item: { type: "contextCompaction" } });
    (adapter as any).handleItemCompleted(sessionId, { item: { type: "enteredReviewMode", review: "strict" } });
    (adapter as any).handleItemCompleted(sessionId, { item: { type: "exitedReviewMode" } });
    (adapter as any).handleItemCompleted(sessionId, {
      item: { type: "webSearch", query: "codex docs", status: "completed" },
    });

    const parts = buffer.parts as any[];
    const shellTool = parts.find((part) => part.type === "tool" && part.callId === "cmd-1");
    const fileTool = parts.find((part) => part.type === "tool" && part.callId === "edit-1");
    const mcpTool = parts.find((part) => part.type === "tool" && part.callId === "mcp-1");
    const webTool = parts.find((part) => part.type === "tool" && part.originalTool === "webSearch");
    const textPart = parts.find((part) => part.type === "text");
    const reasoningPart = parts.find((part) => part.type === "reasoning");
    const planPart = parts.filter((part) => part.type === "text").find((part) => part.text.includes("## Plan"));
    const notices = parts.filter((part) => part.type === "system-notice");

    expect(shellTool).toMatchObject({
      normalizedTool: "shell",
      title: "Running bun test",
      state: expect.objectContaining({ status: "completed", output: "all green" }),
    });
    expect((shellTool.state.metadata as any).stdout).toBe("all green");
    expect(fileTool.diff).toContain("@@ patch @@");
    expect((fileTool.state.metadata as any).diff).toContain("@@ patch @@");
    expect((mcpTool.state.input as any)._output).toBe("fetching\ndone");
    expect(mcpTool.state.output).toBe("doc-1");
    expect(webTool.state.output).toBe("codex docs");
    expect(textPart.text).toBe("Final answer");
    expect(reasoningPart.text).toBe("Inspect");
    expect(planPart.text).toBe("## Plan\n\nShip tests");
    expect(notices.map((notice) => notice.text)).toEqual(expect.arrayContaining([
      "notice:context_compressed",
      "Entered review mode",
      "Exited review mode",
      "Entered review mode: strict",
    ]));
    expect(parts.some((part) => part.type === "step-finish")).toBe(true);
  });

  it("maps tool params, outputs, and metadata for Codex-specific item types", () => {
    const { adapter } = createAdapterWithClient();

    expect((adapter as any).itemToToolParams({
      type: "dynamicToolCall",
      tool: "dynamic-tool",
      arguments: { file: "a.ts" },
    })).toEqual({ tool: "dynamic-tool", arguments: { file: "a.ts" } });
    expect((adapter as any).itemToToolOutput({
      type: "dynamicToolCall",
      contentItems: [{ type: "text", text: "ok" }],
    })).toEqual([{ type: "text", text: "ok" }]);

    expect((adapter as any).itemToToolParams({
      type: "collabAgentToolCall",
      tool: "@fixer",
      prompt: "Fix it",
    })).toEqual({
      tool: "@fixer",
      prompt: "Fix it",
      description: "Delegating via @fixer",
    });
    expect((adapter as any).itemToToolOutput({
      type: "collabAgentToolCall",
      receiverThreadIds: ["thread-a"],
      agentsStates: { fixer: "done" },
    })).toEqual({ receiverThreadIds: ["thread-a"], agentsStates: { fixer: "done" } });

    expect((adapter as any).itemToToolParams({ type: "webSearch", query: "codex cli", action: "search" })).toEqual({
      query: "codex cli",
      action: "search",
    });
    expect((adapter as any).itemToToolOutput({ type: "imageView", path: "/tmp/img.png" })).toBe("/tmp/img.png");
    expect((adapter as any).itemToToolParams({
      type: "imageGeneration",
      revisedPrompt: "A cat",
      savedPath: "/tmp/cat.png",
    })).toEqual({ description: "A cat", savedPath: "/tmp/cat.png" });
    expect((adapter as any).itemToToolOutput({ type: "imageGeneration", result: "fallback" })).toBe("fallback");
    expect((adapter as any).itemToToolMetadata({
      type: "fileChange",
      changes: [{ diff: "@@ -1 +1 @@" }, { path: "/repo/file.ts" }],
    })).toEqual({ diff: "@@ -1 +1 @@" });
    expect((adapter as any).itemToToolMetadata({ type: "commandExecution" })).toBeUndefined();
  });

  it("turns Codex server requests into permissions and questions, then resolves or rejects them", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId } = seedSession(adapter);
    const askedPermissions: string[] = [];
    const askedQuestions: string[] = [];

    adapter.on("permission.asked", (event) => askedPermissions.push(event.permission.id));
    adapter.on("question.asked", (event) => askedQuestions.push(event.question.id));

    (adapter as any).handleServerRequest("perm-1", "item/commandExecution/requestApproval", {
      threadId: "thread-1",
      itemId: "tool-1",
      command: "bun test",
      availableDecisions: ["accept", "acceptForSession", "decline"],
    });
    (adapter as any).handleServerRequest("legacy-1", "execCommandApproval", {
      conversationId: "thread-1",
      callId: "legacy-call",
      command: ["git", "status"],
    });
    (adapter as any).handleServerRequest("question-1", "item/tool/requestUserInput", {
      threadId: "thread-1",
      itemId: "tool-2",
      questions: [{ id: "env", question: "Environment?" }],
    });
    (adapter as any).handleServerRequest("unsupported-1", "unsupported/method", { threadId: "thread-1" });
    (adapter as any).handleServerRequest("missing-1", "item/tool/requestUserInput", {});

    expect(askedPermissions).toEqual(["perm-1", "legacy-1"]);
    expect(askedQuestions).toEqual(["question-1"]);
    expect((adapter as any).pendingPermissions.has("perm-1")).toBe(true);
    expect((adapter as any).pendingQuestions.has("question-1")).toBe(true);
    expect(client.respondError).toHaveBeenCalledWith("unsupported-1", -32601, "CodeMux does not support unsupported/method");
    expect(client.respondError).toHaveBeenCalledWith("missing-1", -32000, "Cannot resolve session for server request item/tool/requestUserInput");

    (adapter as any).handleServerRequestResolved({ requestId: "perm-1" });
    expect((adapter as any).pendingPermissions.has("perm-1")).toBe(false);

    await adapter.rejectQuestion("question-1");
    expect(client.respondError).toHaveBeenCalledWith("question-1", -32000, "User rejected the prompt");

    (adapter as any).pendingPermissions.set("perm-unsupported", {
      requestId: "req-unsupported",
      sessionId,
      method: "unsupportedApproval",
      params: {},
      permission: { id: "perm-unsupported" },
    });
    await adapter.replyPermission("perm-unsupported", { optionId: "allow_once" });
    expect(client.respondError).toHaveBeenCalledWith("req-unsupported", -32601, "Unsupported approval request: unsupportedApproval");
  });

  it("stops the adapter by dropping queued work, pending prompts, active tool state, and cleanup timers", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const tempDir = mkdtempSync(join(tmpdir(), "codemux-stop-"));
    const queueReject = vi.fn();
    const resolve = vi.fn();
    const permissionReplies: string[] = [];

    const buffer = (adapter as any).createMessageBuffer(sessionId, "/repo", threadId);
    (adapter as any).messageBuffers.set(sessionId, buffer);
    (adapter as any).turnResolvers.set(sessionId, [{ resolve, reject: vi.fn() }]);
    (adapter as any).messageQueues.set("codex_thread-queued", [{
      input: [],
      userMessage: {} as any,
      tempDirs: [],
      resolver: { resolve: vi.fn(), reject: queueReject },
    }]);
    (adapter as any).pendingPermissions.set("perm-1", {
      requestId: "req-1",
      sessionId,
      method: "item/commandExecution/requestApproval",
      params: {},
      permission: { id: "perm-1" },
    });
    (adapter as any).pendingQuestions.set("question-1", {
      requestId: "req-2",
      sessionId,
      params: {},
      question: { id: "question-1" },
    });
    (adapter as any).activeTempDirs.set(sessionId, [tempDir]);
    (adapter as any).activeToolParts.set("tool-1", { id: "tool-1" });
    adapter.on("permission.replied", (event) => permissionReplies.push(`${event.permissionId}:${event.optionId}`));

    (adapter as any).startSessionCleanup();
    client.stop = vi.fn().mockResolvedValue(undefined);

    await adapter.stop();

    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(client.respond).toHaveBeenCalledWith("req-1", { decision: "decline" });
    expect(client.respondError).toHaveBeenCalledWith("req-2", -32000, "Adapter stopped");
    expect(queueReject).toHaveBeenCalledWith(expect.objectContaining({ message: "Adapter stopped" }));
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ error: "Adapter stopped" }));
    expect(permissionReplies).toContain("perm-1:reject_once");
    expect(adapter.getStatus()).toBe("stopped");
    expect((adapter as any).client).toBeNull();
    expect((adapter as any).cleanupIntervalId).toBeNull();
    expect((adapter as any).activeToolParts.size).toBe(0);
    expect((adapter as any).activeTempDirs.size).toBe(0);
    expect(existsSync(tempDir)).toBe(false);
  });

  it("builds prompt input for text and images, then removes the generated temp directories", () => {
    const { adapter } = createAdapterWithClient();
    const imageData = Buffer.from("fake image bytes").toString("base64");

    const prepared = (adapter as any).buildPromptInput([
      { type: "text", text: "Inspect this screenshot" },
      { type: "image", data: imageData, mimeType: "image/..\\..\\secret" },
    ]);

    expect(prepared.displayText).toBe("Inspect this screenshot");
    expect(prepared.input).toEqual([
      { type: "text", text: "Inspect this screenshot", text_elements: [] },
      expect.objectContaining({ type: "localImage" }),
    ]);
    expect(prepared.tempDirs).toHaveLength(1);
    expect(existsSync(prepared.tempDirs[0])).toBe(true);
    expect(existsSync((prepared.input[1] as any).path)).toBe(true);
    expect((prepared.input[1] as any).path.endsWith("image.png")).toBe(true);

    (adapter as any).cleanupTempDirs(prepared.tempDirs);
    expect(existsSync(prepared.tempDirs[0])).toBe(false);
    expect(() => (adapter as any).buildPromptInput([])).toThrow("Message content cannot be empty");
  });

  it("cleans up a temp image directory when writing the decoded attachment fails", () => {
    const { adapter } = createAdapterWithClient();
    const imageData = Buffer.from("fake image bytes").toString("base64");
    let attemptedPath: string | undefined;
    writeFileSyncMock.mockImplementationOnce((path) => {
      attemptedPath = String(path);
      throw new Error("disk full");
    });

    expect(() => (adapter as any).buildPromptInput([
      { type: "image", data: imageData, mimeType: "image/png" },
    ])).toThrow("Failed to prepare image attachment");

    expect(attemptedPath).toBeTruthy();
    expect(existsSync(dirname(attemptedPath!))).toBe(false);
  });

  it("rejects oversized image attachments before creating temp directories", () => {
    const { adapter } = createAdapterWithClient();
    const imageData = Buffer.alloc(3 * 1024 * 1024 + 1, 1).toString("base64");

    expect(() => (adapter as any).buildPromptInput([
      { type: "image", data: imageData, mimeType: "image/png" },
    ])).toThrow("Image attachment exceeds the maximum supported size");
    expect(mkdtempSyncMock).not.toHaveBeenCalled();
  });

  it("resumes unloaded threads on demand and unsubscribes only truly idle sessions", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const old = seedSession(adapter, { sessionId: "codex_thread-old", threadId: "thread-old", directory: "/old" });
    const busy = seedSession(adapter, { sessionId: "codex_thread-busy", threadId: "thread-busy", directory: "/busy" });

    (adapter as any).threads.get(threadId).loaded = false;
    (adapter as any).threads.get("thread-old").lastUsedAt = Date.now() - 31 * 60 * 1000;
    (adapter as any).threads.get("thread-busy").lastUsedAt = Date.now() - 31 * 60 * 1000;
    (adapter as any).activeTurnIds.set(busy.sessionId, "turn-busy");

    client.request.mockImplementation(async (method: string, params: any) => {
      if (method === "thread/resume") {
        return {
          thread: {
            id: params.threadId,
            name: "Reloaded Thread",
            createdAt: 100,
            updatedAt: 200,
          },
        };
      }
      if (method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect((adapter as any).ensureThreadLoaded(sessionId, "/repo")).resolves.toBe("thread-1");
    expect(client.request).toHaveBeenCalledWith("thread/resume", expect.objectContaining({
      threadId: "thread-1",
      cwd: "/repo",
      model: "codex-mini-latest",
      approvalPolicy: "never",
      sandbox: "workspace-write",
    }));
    expect((adapter as any).threads.get(threadId)).toMatchObject({ loaded: true, title: "Reloaded Thread" });

    await (adapter as any).cleanupIdleThreads();

    expect(client.request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: old.threadId });
    expect((adapter as any).threads.get(old.threadId)?.loaded).toBe(false);
    expect((adapter as any).threads.get("thread-busy")?.loaded).toBe(true);
  });

  it("fails active turns from notification errors and keeps the staleSession flag false", async () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const resolve = vi.fn();
    const buffer = (adapter as any).createMessageBuffer(sessionId, "/repo", threadId);
    (adapter as any).messageBuffers.set(sessionId, buffer);
    (adapter as any).turnResolvers.set(sessionId, [{ resolve, reject: vi.fn() }]);

    (adapter as any).handleNotification("error", {
      threadId,
      error: { message: "Tool failed", additionalDetails: "permission denied" },
    });

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      error: "Tool failed\n\npermission denied",
      staleSession: false,
    }));
    expect((adapter as any).messageBuffers.has(sessionId)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Service tier (Fast mode) tests
  // ---------------------------------------------------------------------------

  it("passes serviceTier to turn/start when provided in sendMessage options", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId } = seedSession(adapter);
    client.request.mockImplementation(async (method: string) => {
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      throw new Error(`unexpected method: ${method}`);
    });

    adapter.sendMessage(
      sessionId,
      [{ type: "text", text: "Hello" }],
      { directory: "/repo", serviceTier: "fast" },
    );
    await flushMicrotasks();

    expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        threadId: "thread-1",
        serviceTier: "fast",
      }),
      120000,
    );
  });

  it("omits serviceTier from turn/start when not provided", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId } = seedSession(adapter);
    client.request.mockImplementation(async (method: string) => {
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      throw new Error(`unexpected method: ${method}`);
    });

    adapter.sendMessage(
      sessionId,
      [{ type: "text", text: "Hello" }],
      { directory: "/repo" },
    );
    await flushMicrotasks();

    const turnStartCall = client.request.mock.calls.find((call) => call[0] === "turn/start");
    expect(turnStartCall).toBeDefined();
    expect(turnStartCall![1]).not.toHaveProperty("serviceTier");
  });

  it("caches serviceTier from thread/start response", async () => {
    const { adapter, client } = createAdapterWithClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        return {
          thread: { id: "thread-fast", createdAt: Date.now(), updatedAt: Date.now(), name: "Fast Thread" },
          model: "gpt-5.4",
          serviceTier: "fast",
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const session = await adapter.createSession("/repo");
    expect((adapter as any).sessionServiceTiers.get(session.id)).toBe("fast");
  });

  it("reports fastModeSupported based on authenticated state", async () => {
    const { adapter } = createAdapterWithClient();

    // Default: not authenticated
    expect(adapter.getCapabilities().fastModeSupported).toBe(false);

    // Authenticated (any auth type)
    (adapter as any).authenticated = true;
    expect(adapter.getCapabilities().fastModeSupported).toBe(true);

    // Explicitly not authenticated
    (adapter as any).authenticated = false;
    expect(adapter.getCapabilities().fastModeSupported).toBe(false);
  });

  it("cleans up sessionServiceTiers on session cleanup", () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId } = seedSession(adapter);

    (adapter as any).sessionServiceTiers.set(sessionId, "fast");
    (adapter as any).clearSessionState(sessionId);
    expect((adapter as any).sessionServiceTiers.has(sessionId)).toBe(false);
  });
});

describe("CodexAdapter native turn lifecycle", () => {
  it("keeps an ordinary retry in the same turn without consuming queued work", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    client.request.mockResolvedValueOnce({ turn: { id: "retry-turn" } }).mockResolvedValueOnce({ turn: { id: "next-turn" } });
    const first = adapter.sendMessage(sessionId, [{ type: "text", text: "First" }]);
    await flushMicrotasks();
    const buffer = (adapter as any).messageBuffers.get(sessionId);
    const second = adapter.sendMessage(sessionId, [{ type: "text", text: "Second" }], { modelId: "gpt-5.4" });

    (adapter as any).handleNotification("error", { threadId, turnId: "retry-turn", willRetry: true, error: { message: "Rate limited" } });
    await flushMicrotasks();
    expect((adapter as any).activeTurnIds.get(sessionId)).toBe("retry-turn");
    expect((adapter as any).messageBuffers.get(sessionId)).toBe(buffer);
    expect((adapter as any).messageQueues.get(sessionId)).toHaveLength(1);
    expect(client.request).toHaveBeenCalledTimes(1);

    (adapter as any).handleNotification("turn/completed", { threadId, turn: { id: "retry-turn", status: "completed" } });
    expect((await first).error).toBeUndefined();
    await flushMicrotasks();
    expect(client.request).toHaveBeenCalledTimes(2);
    (adapter as any).handleNotification("turn/completed", { threadId, turn: { id: "next-turn", status: "completed" } });
    await second;
  });

  it.each(["turn/start", "turn/steer"] as const)("does not resurrect an ordinary turn after a late %s acknowledgement", async (method) => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    if (method === "turn/steer") {
      (adapter as any).handleNotification("turn/started", { threadId, turn: { id: "fast-turn", status: "inProgress" } });
    }
    let acknowledge!: (value: unknown) => void;
    client.request.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
    const response = adapter.sendMessage(sessionId, [{ type: "text", text: "Quick response" }]);
    await flushMicrotasks();
    const messageId = (adapter as any).messageBuffers.get(sessionId).messageId;
    (adapter as any).handleNotification("turn/completed", { threadId, turn: { id: "fast-turn", status: "completed" } });
    acknowledge(method === "turn/start" ? { turn: { id: "fast-turn" } } : { turnId: "fast-turn" });
    expect((await response).id).toBe(messageId);
    expect((adapter as any).hasActiveTurn(sessionId)).toBe(false);
    expect((adapter as any).turnResolvers.has(sessionId)).toBe(false);
  });

  it.each(["turn/start", "turn/steer"] as const)("keeps a newer turn intact when %s is acknowledged after completion", async (method) => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    if (method === "turn/steer") {
      (adapter as any).handleNotification("turn/started", { threadId, turn: { id: "old-turn", status: "inProgress" } });
    }
    let acknowledge!: (value: unknown) => void;
    client.request.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
    const response = adapter.sendMessage(sessionId, [{ type: "text", text: "First" }]);
    await flushMicrotasks();
    const messageId = (adapter as any).messageBuffers.get(sessionId).messageId;
    (adapter as any).handleNotification("turn/completed", { threadId, turn: { id: "old-turn", status: "completed" } });
    (adapter as any).handleNotification("turn/started", { threadId, turn: { id: "new-turn", status: "inProgress" } });
    const nextBuffer = (adapter as any).messageBuffers.get(sessionId);
    acknowledge(method === "turn/start" ? { turn: { id: "old-turn" } } : { turnId: "old-turn" });
    expect((await response).id).toBe(messageId);
    expect((adapter as any).activeTurnIds.get(sessionId)).toBe("new-turn");
    expect((adapter as any).messageBuffers.get(sessionId)).toBe(nextBuffer);
    expect((adapter as any).turnResolvers.has(sessionId)).toBe(false);
  });

  it.each(["before", "after"] as const)("finishes cancellation once when native completion arrives %s the interrupt response", async (order) => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const notify = (method: string, data: Record<string, unknown>) =>
      (adapter as any).handleNotification(method, { threadId, ...data });
    notify("turn/started", { turn: { id: "old-turn", status: "inProgress" } });
    notify("item/started", { turnId: "old-turn", item: { id: "command", type: "commandExecution", command: "pwd" } });
    let acknowledge!: (value: unknown) => void;
    client.request.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
    const cancelled = adapter.cancelMessage(sessionId);
    if (order === "before") notify("turn/completed", { turn: { id: "old-turn", status: "interrupted" } });
    acknowledge({});
    await cancelled;
    if (order === "after") notify("turn/completed", { turn: { id: "old-turn", status: "interrupted" } });
    notify("item/agentMessage/delta", { turnId: "old-turn", itemId: "late", delta: "Late old text" });
    expect((adapter as any).messageHistory.get(sessionId)).toHaveLength(1);
    expect((adapter as any).messageHistory.get(sessionId)[0].error).toBe("Cancelled");
    expect((adapter as any).hasActiveTurn(sessionId)).toBe(false);
    expect((adapter as any).activeToolParts.size).toBe(0);

    notify("turn/started", { turn: { id: "new-turn", status: "inProgress" } });
    notify("item/agentMessage/delta", { turnId: "new-turn", itemId: "new-text", delta: "New response" });
    const nextBuffer = (adapter as any).messageBuffers.get(sessionId);
    notify("turn/completed", { turn: { id: "old-turn", status: "interrupted" } });
    notify("error", { turnId: "old-turn", willRetry: false, error: { message: "Old failure" } });
    notify("item/completed", { turnId: "old-turn", item: { id: "old-text", type: "agentMessage", text: "Old response" } });
    expect((adapter as any).activeTurnIds.get(sessionId)).toBe("new-turn");
    expect((adapter as any).messageBuffers.get(sessionId)).toBe(nextBuffer);
    expect(nextBuffer.parts.filter((part: any) => part.type === "text").map((part: any) => part.text)).toEqual(["New response"]);
    expect((adapter as any).messageHistory.get(sessionId)).toHaveLength(1);
  });

  it("retains the ordinary active turn when the native interrupt fails", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    (adapter as any).handleNotification("turn/started", { threadId, turn: { id: "turn-1", status: "inProgress" } });
    const buffer = (adapter as any).messageBuffers.get(sessionId);
    client.request.mockRejectedValue(new Error("Connection lost"));
    await expect(adapter.cancelMessage(sessionId)).rejects.toThrow("Connection lost");
    expect((adapter as any).activeTurnIds.get(sessionId)).toBe("turn-1");
    expect((adapter as any).messageBuffers.get(sessionId)).toBe(buffer);
    expect((adapter as any).messageHistory.has(sessionId)).toBe(false);
  });

  it("clears server-resolved approval and question cards once without sending another reply", () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const permissionReplied = vi.fn();
    const questionReplied = vi.fn();
    adapter.on("permission.replied", permissionReplied);
    adapter.on("question.replied", questionReplied);
    (adapter as any).handleServerRequest(42, "item/commandExecution/requestApproval", { threadId, turnId: "turn-1", itemId: "command", command: "pwd" });
    (adapter as any).handleServerRequest(43, "item/tool/requestUserInput", { threadId, turnId: "turn-1", itemId: "question", questions: [{ id: "choice", question: "Continue?" }] });
    for (const requestId of [42, 43, 42, 43]) {
      (adapter as any).handleNotification("serverRequest/resolved", { threadId, requestId });
    }
    expect(adapter.getPendingPermissions(sessionId)).toEqual([]);
    expect(adapter.getPendingQuestions(sessionId)).toEqual([]);
    expect(permissionReplied).toHaveBeenCalledExactlyOnceWith({ permissionId: "42", optionId: "resolved" });
    expect(questionReplied).toHaveBeenCalledExactlyOnceWith({ questionId: "43", answers: [] });
    expect(client.respond).not.toHaveBeenCalled();
    expect(client.respondError).not.toHaveBeenCalled();
  });
});

describe("CodexAdapter stored lifecycle", () => {
  beforeEach(() => { verifyRolloutMock.mockReset(); });
  it.each(["active", "archived"] as const)("reads an admitted index-less rollout only after path verification confirms %s", async (availability) => {
    const { adapter, client } = createAdapterWithClient();
    const thread = { id: "known-empty", cwd: "/repo", name: "Empty", path: "/native/rollout.jsonl", turns: [] };
    const catalog = adapter.createDesktopCatalogClient();
    catalog.admitThread!(thread.id);
    verifyRolloutMock.mockResolvedValue(availability);
    client.request.mockImplementation(async (method: string) => method === "thread/read" ? { thread } : { data: [], nextCursor: null });
    expect(await adapter.readStoredThread(thread.id)).toEqual({ thread, archived: availability === "archived" });
    expect(verifyRolloutMock).toHaveBeenCalledExactlyOnceWith(thread.id, thread);
    expect(client.request.mock.calls.every(([method]) => ["thread/read", "thread/list"].includes(method))).toBe(true);
    expect((adapter as any).sessionToThread.size).toBe(0);
    catalog.dispose!();
  });

  it("rejects unadmitted or invalid paths instead of treating metadata as storage proof", async () => {
    const { adapter, client } = createAdapterWithClient();
    const thread = { id: "unknown-empty", cwd: "/repo", path: "/native/rollout.jsonl", turns: [] };
    client.request.mockImplementation(async (method: string) => method === "thread/read" ? { thread } : { data: [], nextCursor: null });
    verifyRolloutMock.mockResolvedValue("active");
    await expect(adapter.readStoredThread(thread.id)).rejects.toThrow("missing from native storage");
    expect(verifyRolloutMock).not.toHaveBeenCalled();
    const catalog = adapter.createDesktopCatalogClient();
    catalog.admitThread!(thread.id);
    verifyRolloutMock.mockResolvedValue(undefined);
    await expect(adapter.readStoredThread(thread.id)).rejects.toThrow("missing from native storage");
    catalog.dispose!();
  });

  it("revokes only the disposed catalog's admission lease", async () => {
    const { adapter, client } = createAdapterWithClient();
    const thread = { id: "known-empty", cwd: "/repo", turns: [] };
    client.request.mockImplementation(async (method: string) => method === "thread/read" ? { thread } : { data: [], nextCursor: null });
    verifyRolloutMock.mockResolvedValue("active");
    const first = adapter.createDesktopCatalogClient();
    const second = adapter.createDesktopCatalogClient();
    first.admitThread!(thread.id);
    first.admitThread!(thread.id);
    second.admitThread!(thread.id);
    first.dispose!();
    first.dispose!();
    expect((await adapter.readStoredThread(thread.id)).archived).toBe(false);
    second.dispose!();
    await expect(adapter.readStoredThread(thread.id)).rejects.toThrow("missing from native storage");
    expect(() => first.admitThread!(thread.id)).toThrow("stopped");
  });

  it("uses metadata only for the exact admitted not-materialized error and keeps identity checks", async () => {
    const { adapter, client } = createAdapterWithClient();
    const id = "known-empty";
    const thread = { id, cwd: "/repo", turns: [] };
    const catalog = adapter.createDesktopCatalogClient();
    catalog.admitThread!(id);
    verifyRolloutMock.mockResolvedValue("active");
    client.request.mockImplementation(async (method: string) => method === "thread/read" ? { thread } : { data: [], nextCursor: null });
    client.request.mockRejectedValueOnce(new Error(`thread ${id} is not materialized yet; includeTurns is unavailable before first user message (code: -32600)`));
    expect((await adapter.readStoredThread(id)).thread).toEqual(thread);
    expect(client.request).toHaveBeenNthCalledWith(1, "thread/read", { threadId: id, includeTurns: true });
    expect(client.request).toHaveBeenNthCalledWith(2, "thread/read", { threadId: id, includeTurns: false });
    for (const error of [new Error("Native connection failed"), new Error("list_turns is not supported yet (code: -32601)"), new Error("thread other-id is not materialized yet; includeTurns is unavailable before first user message (code: -32600)")]) {
      client.request.mockClear().mockRejectedValueOnce(error);
      await expect(adapter.readStoredThread(id)).rejects.toBe(error);
      expect(client.request).toHaveBeenCalledOnce();
    }
    client.request.mockResolvedValueOnce({ thread: { id: "wrong-id" } });
    await expect(adapter.readStoredThread(id)).rejects.toThrow("different thread");
    catalog.dispose!();
  });

  it("verifies archive and restore through the native path for an admitted blank rollout", async () => {
    const { adapter, client } = createAdapterWithClient();
    const id = "known-empty";
    let archived = false;
    const catalog = adapter.createDesktopCatalogClient();
    catalog.admitThread!(id);
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/read") return { thread: { id, cwd: "/repo", path: archived ? "/native/archived" : "/native/active" } };
      if (method === "thread/archive") { archived = true; return {}; }
      if (method === "thread/unarchive") { archived = false; return {}; }
      return { data: [], nextCursor: null };
    });
    verifyRolloutMock.mockImplementation(async (_id, metadata) => metadata.path === "/native/archived" ? "archived" : "active");
    await adapter.archiveStoredThread(id);
    expect(await adapter.getStoredThreadAvailability(id)).toBe("archived");
    await adapter.unarchiveStoredThread(id);
    expect(await adapter.getStoredThreadAvailability(id)).toBe("active");
    expect(client.request.mock.calls.some(([method]) => ["thread/resume", "thread/start", "turn/start"].includes(method))).toBe(false);
    catalog.dispose!();
  });

  it("preserves original archived turn and item identities without resuming their runtime", async () => {
    const { adapter, client } = createAdapterWithClient();
    const thread = { id: "stored-thread", cwd: "/repo", turns: [{ id: "original-turn", items: [{ id: "original-item", type: "agentMessage", text: "Saved response" }] }] };
    client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => method === "thread/read" ? { thread }
      : { data: params.archived ? [thread] : [], nextCursor: null });
    expect(await adapter.readStoredThread("stored-thread")).toEqual({ thread, archived: true });
    expect(client.request).toHaveBeenCalledWith("thread/read", { threadId: "stored-thread", includeTurns: true });
    expect(client.request.mock.calls.some(([method]) => method === "thread/resume" || method === "thread/unarchive" || method === "turn/start")).toBe(false);
    expect((adapter as any).sessionToThread.size).toBe(0);
  });

  it("rejects archived client history before requesting its turns", async () => {
    const { adapter, client } = createAdapterWithClient();
    const thread = { id: "archived-thread", cwd: "/repo" };
    client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => method === "thread/read" ? { thread }
      : { data: params.archived ? [thread] : [], nextCursor: null });
    await expect(adapter.readStoredThread(thread.id, { activeOnly: true })).rejects.toMatchObject({ code: "CODEX_THREAD_ARCHIVED" });
    expect(client.request.mock.calls.filter(([method]) => method === "thread/read").every(([, params]) => params.includeTurns === false)).toBe(true);
    expect((adapter as any).sessionToThread.size).toBe(0);
  });

  it("does not return a transcript archived while its client read was in flight", async () => {
    const { adapter, client } = createAdapterWithClient();
    let archived = false;
    const thread = { id: "racing-thread", cwd: "/repo", turns: [] };
    client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read") {
        if (params.includeTurns) archived = true;
        return { thread };
      }
      return { data: params.archived === archived ? [thread] : [], nextCursor: null };
    });
    await expect(adapter.readStoredThread(thread.id, { activeOnly: true })).rejects.toMatchObject({ code: "CODEX_THREAD_ARCHIVED" });
  });

  it("reads active client history without acquiring its runtime", async () => {
    const { adapter, client } = createAdapterWithClient();
    const thread = { id: "active-thread", cwd: "/repo", turns: [] };
    client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => method === "thread/read" ? { thread }
      : { data: params.archived ? [] : [thread], nextCursor: null });
    await expect(adapter.readStoredThread(thread.id, { activeOnly: true })).resolves.toEqual({ thread, archived: false });
    expect((adapter as any).sessionToThread.size).toBe(0);
  });
  it("archives and restores native storage with verified state and no thread resume", async () => {
    const { adapter, client } = createAdapterWithClient();
    let archived = false;
    const metadata = { id: "stored-thread", name: "Saved title", cwd: "/repo" };
    client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read") return { thread: metadata };
      if (method === "thread/archive") { archived = true; return {}; }
      if (method === "thread/unarchive") { archived = false; return { thread: metadata }; }
      return { data: params.archived === archived ? [metadata] : [], nextCursor: null };
    });
    expect(await adapter.getStoredThreadAvailability("stored-thread")).toBe("active");
    expect(await adapter.archiveStoredThread("stored-thread")).toEqual(metadata);
    expect(await adapter.getStoredThreadAvailability("stored-thread")).toBe("archived");
    expect(await adapter.unarchiveStoredThread("stored-thread")).toEqual(metadata);
    expect(await adapter.getStoredThreadAvailability("stored-thread")).toBe("active");
    expect(client.request.mock.calls.filter(([method]) => method === "thread/archive" || method === "thread/unarchive").map(([method]) => method)).toEqual(["thread/archive", "thread/unarchive"]);
    expect(client.request.mock.calls.some(([method]) => method === "thread/resume" || method === "turn/start")).toBe(false);
    expect(client.request.mock.calls.filter(([method]) => method === "thread/read").every(([, params]) => params.includeTurns === false)).toBe(true);
    expect((adapter as any).sessionToThread.size).toBe(0);
  });

  it.each([false, true])("does not repeat an already verified lifecycle state (archived=$0)", async (archived) => {
    const { adapter, client } = createAdapterWithClient();
    const metadata = { id: "stored-thread", cwd: "/repo" };
    client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => method === "thread/read" ? { thread: metadata }
      : { data: params.archived === archived ? [metadata] : [], nextCursor: null });
    if (archived) await adapter.archiveStoredThread("stored-thread"); else await adapter.unarchiveStoredThread("stored-thread");
    expect(client.request.mock.calls.some(([method]) => method === "thread/archive" || method === "thread/unarchive")).toBe(false);
  });

  it("preserves the native active-writer rejection without retrying or releasing the owner", async () => {
    const { adapter, client } = createAdapterWithClient();
    client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read") return { thread: { id: "stored-thread" } };
      if (method === "thread/archive") throw new Error("thread stored-thread already has an active writer (code: -32600)");
      return { data: params.archived ? [] : [{ id: "stored-thread" }], nextCursor: null };
    });
    await expect(adapter.archiveStoredThread("stored-thread")).rejects.toThrow("active writer");
    expect(client.request.mock.calls.filter(([method]) => method === "thread/archive")).toHaveLength(1);
    expect(client.request.mock.calls.some(([method]) => method === "thread/unsubscribe" || method === "turn/interrupt" || method === "thread/resume")).toBe(false);
  });

  it.each(["archive", "unarchive"] as const)("does not report an unconfirmed %s as success", async (operation) => {
    const { adapter, client } = createAdapterWithClient();
    const archived = operation === "unarchive";
    client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read") return { thread: { id: "stored-thread" } };
      if (method === `thread/${operation}`) return {};
      return { data: params.archived === archived ? [{ id: "stored-thread" }] : [], nextCursor: null };
    });
    await expect(operation === "archive" ? adapter.archiveStoredThread("stored-thread") : adapter.unarchiveStoredThread("stored-thread")).rejects.toThrow("not confirmed");
    expect(client.request.mock.calls.filter(([method]) => method === `thread/${operation}`)).toHaveLength(1);
  });

  it("reports missing only after both bounded indexes confirm absence", async () => {
    const { adapter, client } = createAdapterWithClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/read") throw new Error("thread not loaded: missing-thread (code: -32600)");
      return { data: [], nextCursor: null };
    });
    expect(await adapter.getStoredThreadAvailability("missing-thread")).toBe("missing");
    expect(client.request.mock.calls.filter(([method]) => method === "thread/list").map(([, params]) => params.archived)).toEqual([false, true]);
    client.request.mockRejectedValueOnce(new Error("Metadata connection failed"));
    await expect(adapter.getStoredThreadAvailability("missing-thread")).rejects.toThrow("Metadata connection failed");
  });

  it("fails closed on conflicting availability records", async () => {
    const { adapter, client } = createAdapterWithClient();
    client.request.mockImplementation(async (method: string) => method === "thread/read" ? { thread: { id: "stored-thread" } }
      : { data: [{ id: "stored-thread" }], nextCursor: null });
    await expect(adapter.getStoredThreadAvailability("stored-thread")).rejects.toThrow("conflicting active and archived");
    await expect(adapter.archiveStoredThread("stored-thread")).rejects.toThrow("conflicting active and archived");
    expect(client.request.mock.calls.some(([method]) => method === "thread/archive")).toBe(false);
  });
});

describe("CodexAdapter.renameStoredThread", () => {
  it("uses the native name field when renaming a loaded session", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    client.request.mockResolvedValue({});
    await adapter.renameSession(sessionId, "New title");
    expect(client.request).toHaveBeenCalledExactlyOnceWith("thread/name/set", { threadId, name: "New title" });
    expect((await adapter.getSession(sessionId))?.title).toBe("New title");
  });
  it("verifies unarchived storage around one rename without loading the target into this runtime", async () => {
    const { adapter, client } = createAdapterWithClient();
    let renamed = false;
    client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read") return { thread: { id: "stored-thread", cwd: "/exact/repo", name: renamed ? "New title" : "Old title" } };
      if (method === "thread/name/set") { renamed = true; return {}; }
      if (!renamed && params.cursor === null) return { data: [{ id: "other" }], nextCursor: "page-2" };
      return { data: [{ id: "stored-thread" }], nextCursor: null };
    });
    await adapter.renameStoredThread("stored-thread", "New title");
    expect(adapter.start).toHaveBeenCalledOnce();
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read", "thread/list", "thread/list", "thread/name/set", "thread/read", "thread/list",
    ]);
    expect(client.request).toHaveBeenNthCalledWith(2, "thread/list", {
      cursor: null, limit: 100, sortKey: "updated_at", archived: false,
      modelProviders: null, sourceKinds: [], useStateDbOnly: true, cwd: "/exact/repo",
    });
    expect(client.request).toHaveBeenNthCalledWith(3, "thread/list", expect.objectContaining({ cursor: "page-2", archived: false }));
    expect(client.request).toHaveBeenNthCalledWith(4, "thread/name/set", { threadId: "stored-thread", name: "New title" });
    expect(client.request.mock.calls.filter(([method]) => method === "thread/read").every(([, params]) => params.includeTurns === false)).toBe(true);
    expect((adapter as any).sessionToThread.size).toBe(0);
  });

  it("does not write when the target is absent from the unarchived list", async () => {
    const { adapter, client } = createAdapterWithClient();
    client.request.mockImplementation(async (method: string) => method === "thread/read"
      ? { thread: { id: "stored-thread", cwd: "/repo", name: "Old title" } }
      : { data: [], nextCursor: null });
    await expect(adapter.renameStoredThread("stored-thread", "New title")).rejects.toThrow("not in the verified unarchived list");
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["thread/read", "thread/list"]);
  });

  it("fails closed when the target is archived after the single write", async () => {
    const { adapter, client } = createAdapterWithClient();
    let renamed = false;
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/read") return { thread: { id: "stored-thread", name: renamed ? "New title" : "Old title" } };
      if (method === "thread/name/set") { renamed = true; return {}; }
      return { data: renamed ? [] : [{ id: "stored-thread" }], nextCursor: null };
    });
    await expect(adapter.renameStoredThread("stored-thread", "New title")).rejects.toThrow("not in the verified unarchived list");
    expect(client.request.mock.calls.filter(([method]) => method === "thread/name/set")).toHaveLength(1);
    expect(client.request.mock.calls.some(([method]) => method === "thread/unarchive" || method === "thread/resume")).toBe(false);
  });

  it("reports a stored-title mismatch without retrying the write", async () => {
    const { adapter, client } = createAdapterWithClient();
    client.request.mockImplementation(async (method: string) => method === "thread/read"
      ? { thread: { id: "stored-thread", name: "Still old" } }
      : { data: [{ id: "stored-thread" }], nextCursor: null });
    await expect(adapter.renameStoredThread("stored-thread", "New title")).rejects.toThrow("stored title did not match");
    expect(client.request.mock.calls.filter(([method]) => method === "thread/name/set")).toHaveLength(1);
  });

  it.each(["repeated", "limit", "invalid"] as const)("does not rename when pagination is %s", async (failure) => {
    const { adapter, client } = createAdapterWithClient();
    let page = 0;
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/read") return { thread: { id: "stored-thread" } };
      page += 1;
      if (failure === "invalid") return { data: null };
      return { data: [], nextCursor: failure === "repeated" ? "same-cursor" : `page-${page}` };
    });
    await expect(adapter.renameStoredThread("stored-thread", "New title")).rejects.toThrow(failure === "limit" ? "pagination limit" : failure === "repeated" ? "repeated" : "invalid unarchived");
    expect(page).toBe(failure === "limit" ? 20 : failure === "repeated" ? 2 : 1);
    expect(client.request.mock.calls.some(([method]) => method === "thread/name/set")).toBe(false);
  });
});

describe("createCodexDesktopOwnerRuntime", () => {
  it("reads owner title metadata without loading turns or resuming a thread", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    client.request.mockResolvedValue({ thread: { id: threadId, name: "Current title" } });
    const runtime = createCodexDesktopOwnerRuntime(adapter);
    expect(await runtime.readMetadata!(sessionId)).toEqual({ id: threadId, name: "Current title" });
    expect(client.request).toHaveBeenCalledExactlyOnceWith("thread/read", { threadId, includeTurns: false });
  });
  it("uses legacy history only for new private owner threads", async () => {
    for (const ownerEnabled of [false, true]) {
      const { adapter, client } = createAdapterWithClient();
      if (ownerEnabled) createCodexDesktopOwnerRuntime(adapter);
      client.request.mockImplementation(async (method: string) => method === "thread/start" ? { thread: { id: "new-thread" }, model: "custom-model" } : { data: [] });
      await adapter.createSession("/repo");
      const params = client.request.mock.calls.find(([method]) => method === "thread/start")?.[1];
      if (ownerEnabled) expect(params).toHaveProperty("historyMode", "legacy");
      else expect(params).not.toHaveProperty("historyMode");
    }
  });

  it("reads authoritative metadata before a new legacy thread has its first user message", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const runtime = createCodexDesktopOwnerRuntime(adapter);
    client.request.mockRejectedValueOnce(new Error(`thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message (code: -32600)`));
    client.request.mockResolvedValueOnce({ thread: { id: threadId, historyMode: "legacy", turns: [] } });
    expect((await runtime.readThread(sessionId)).thread).toEqual({ id: threadId, historyMode: "legacy", turns: [] });
    expect(client.request).toHaveBeenNthCalledWith(1, "thread/read", { threadId, includeTurns: true });
    expect(client.request).toHaveBeenNthCalledWith(2, "thread/read", { threadId, includeTurns: false });
    client.request.mockRejectedValueOnce(new Error("list_turns is not supported yet (code: -32601)"));
    await expect(runtime.readThread(sessionId)).rejects.toThrow("list_turns is not supported");
    expect(client.request).toHaveBeenCalledTimes(3);
  });

  it("reads only an already loaded native thread and preserves its provider, raw effort and pending requests", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const runtime = createCodexDesktopOwnerRuntime(adapter);
    (adapter as any).nativeSessionSettings.set(sessionId, { model: "modelhub-model", effort: "ultra" });
    client.request.mockResolvedValue({ thread: { id: threadId, cwd: "/repo", modelProvider: "modelhub", turns: [{ id: "native-turn", items: [] }] } });
    const changed = vi.fn();
    const unsubscribe = runtime.subscribe(changed);
    (adapter as any).handleServerRequest(42, "item/commandExecution/requestApproval", { threadId, itemId: "cmd", command: "pwd" });
    const state = await runtime.readThread(sessionId);
    expect(state).toMatchObject({ model: "modelhub-model", modelProvider: "modelhub", reasoningEffort: "ultra", thread: { id: threadId, turns: [{ id: "native-turn" }] }, requests: [{ id: 42, method: "item/commandExecution/requestApproval" }] });
    expect(client.request).toHaveBeenCalledExactlyOnceWith("thread/read", { threadId, includeTurns: true });
    expect(changed).toHaveBeenCalledWith(sessionId);
    (adapter as any).threads.get(threadId).loaded = false;
    await expect(runtime.readThread(sessionId)).rejects.toThrow("already loaded");
    await expect(runtime.readThread("unknown-session")).rejects.toThrow("already loaded");
    expect(client.request).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("acknowledges native start before completion while keeping the existing user and active-turn pipeline", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const runtime = createCodexDesktopOwnerRuntime(adapter);
    await runtime.updateSettings!(sessionId, { model: "custom-model", effort: "ultra" }, {});
    const response = { turn: { id: "native-turn", status: "inProgress" } };
    client.request.mockResolvedValue(response);
    const input = [
      { type: "text", text: "Check this", text_elements: [] },
      { type: "image", url: "data:image/png;base64,aGVsbG8=" },
      { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
    ];
    const admitted = await runtime.request(sessionId, "turn/start", { threadId, input, clientUserMessageId: "client-user-1" });
    expect(admitted).toBe(response);
    expect(client.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId, input, model: "custom-model", effort: "ultra", clientUserMessageId: "client-user-1" }), 120000);
    expect((adapter as any).activeTurnIds.get(sessionId)).toBe("native-turn");
    expect((await adapter.listMessages(sessionId)).map((message) => message.role)).toEqual(["user"]);
    (adapter as any).handleTurnCompleted(sessionId, { turn: { id: "native-turn", status: "completed" } });
    await flushMicrotasks();
    expect((await adapter.listMessages(sessionId)).map((message) => message.role)).toEqual(["user", "assistant"]);
    expect((adapter as any).activeTurnIds.has(sessionId)).toBe(false);
    expect((adapter as any).nativeSessionSettings.get(sessionId)).not.toHaveProperty("clientUserMessageId");
  });

  it("keeps explicit start and steer distinct and never silently queues a rejected owner request", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const runtime = createCodexDesktopOwnerRuntime(adapter);
    const input = [{ type: "text", text: "First" }];
    client.request.mockResolvedValueOnce({ turn: { id: "active-turn" } });
    await runtime.request(sessionId, "turn/start", { threadId, input });
    await expect(runtime.request(sessionId, "turn/start", { threadId, input })).rejects.toThrow("already active");
    await expect(runtime.request(sessionId, "turn/steer", { threadId, expectedTurnId: "stale-turn", input })).rejects.toThrow("does not match");
    client.request.mockRejectedValueOnce(new Error("Steer rejected"));
    await expect(runtime.request(sessionId, "turn/steer", { threadId, expectedTurnId: "active-turn", input })).rejects.toThrow("Steer rejected");
    expect((adapter as any).messageQueues.size).toBe(0);
    expect((adapter as any).activeTurnIds.get(sessionId)).toBe("active-turn");
    client.request.mockResolvedValueOnce({ turnId: "active-turn" });
    expect(await runtime.request(sessionId, "turn/steer", { threadId, expectedTurnId: "active-turn", input, clientUserMessageId: "steered-user" })).toEqual({ turnId: "active-turn" });
    expect(client.request).toHaveBeenLastCalledWith("turn/steer", { threadId, expectedTurnId: "active-turn", input: [{ type: "text", text: "First", text_elements: [] }], clientUserMessageId: "steered-user" }, 120000);
    (adapter as any).handleTurnCompleted(sessionId, { turn: { id: "active-turn", status: "completed" } });
  });

  it("returns a failed admission and still finalizes the adapter's failed message", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    client.request.mockRejectedValue(new Error("Provider rejected request"));
    const runtime = createCodexDesktopOwnerRuntime(adapter);
    await expect(runtime.request(sessionId, "turn/start", { threadId, input: [{ type: "text", text: "Hello" }] })).rejects.toThrow("Provider rejected");
    await flushMicrotasks();
    expect((await adapter.listMessages(sessionId)).at(-1)?.error).toBe("Provider rejected request");
    expect((adapter as any).messageBuffers.has(sessionId)).toBe(false);
  });

  it.each(["turn/start", "turn/steer"] as const)("does not resurrect a completed turn when %s admission arrives late", async (method) => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const runtime = createCodexDesktopOwnerRuntime(adapter);
    if (method === "turn/steer") {
      (adapter as any).activeTurnIds.set(sessionId, "fast-turn");
      (adapter as any).messageBuffers.set(sessionId, (adapter as any).createMessageBuffer(sessionId, "/repo", threadId));
    }
    let acknowledge!: (value: unknown) => void;
    client.request.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
    const admission = runtime.request(sessionId, method, { threadId, expectedTurnId: "fast-turn", input: [{ type: "text", text: "Quick response" }] });
    (adapter as any).handleTurnCompleted(sessionId, { turn: { id: "fast-turn", status: "completed" } });
    acknowledge(method === "turn/start" ? { turn: { id: "fast-turn" } } : { turnId: "fast-turn" });
    await admission;
    await flushMicrotasks();
    expect((adapter as any).hasActiveTurn(sessionId)).toBe(false);
    expect((adapter as any).turnResolvers.has(sessionId)).toBe(false);
  });

  it("interrupts only the exact active turn and preserves local state if the native interrupt fails", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const runtime = createCodexDesktopOwnerRuntime(adapter);
    (adapter as any).activeTurnIds.set(sessionId, "active-turn");
    (adapter as any).messageBuffers.set(sessionId, (adapter as any).createMessageBuffer(sessionId, "/repo", threadId));
    await expect(runtime.request(sessionId, "turn/interrupt", { threadId, turnId: "other-turn" })).rejects.toThrow("does not match");
    expect(client.request).not.toHaveBeenCalled();
    client.request.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(runtime.request(sessionId, "turn/interrupt", { threadId, turnId: "active-turn" })).rejects.toThrow("Connection lost");
    expect((adapter as any).activeTurnIds.get(sessionId)).toBe("active-turn");
    client.request.mockResolvedValueOnce({});
    await runtime.request(sessionId, "turn/interrupt", { threadId, turnId: "active-turn" });
    expect((adapter as any).activeTurnIds.has(sessionId)).toBe(false);
    expect((await adapter.listMessages(sessionId)).at(-1)?.error).toBe("Cancelled");
  });

  it("replies with original request ids and clears existing pending maps", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const runtime = createCodexDesktopOwnerRuntime(adapter);
    const changed = vi.fn();
    runtime.subscribe(changed);
    (adapter as any).handleServerRequest(42, "item/commandExecution/requestApproval", { threadId, itemId: "cmd", command: "pwd" });
    (adapter as any).handleServerRequest("q1", "item/tool/requestUserInput", { threadId, itemId: "ask", questions: [{ id: "choice", question: "Continue?" }] });
    await runtime.respond(sessionId, "42", { decision: "accept" });
    await runtime.respond(sessionId, "q1", { answers: { choice: { answers: ["Yes"] } } });
    expect(client.respond).toHaveBeenCalledWith(42, { decision: "accept" });
    expect(adapter.getPendingPermissions(sessionId)).toEqual([]);
    expect(adapter.getPendingQuestions(sessionId)).toEqual([]);
    await expect(runtime.respond(sessionId, "42", { decision: "accept" })).rejects.toThrow("does not match");
    expect(changed).toHaveBeenCalledWith(sessionId);
  });

  it("keeps owned sessions loaded until the owner subscription is disposed", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const runtime = createCodexDesktopOwnerRuntime(adapter);
    const unsubscribe = runtime.subscribe(() => {});
    client.request.mockResolvedValue({ thread: { id: threadId, turns: [] } });
    await runtime.readThread(sessionId);
    await (adapter as any).cleanupIdleThreads();
    expect(client.request).toHaveBeenCalledTimes(1);
    unsubscribe();
    await (adapter as any).cleanupIdleThreads();
    expect(client.request).toHaveBeenLastCalledWith("thread/unsubscribe", { threadId });
  });

  it("retains an owner turn during a native retry notification", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const runtime = createCodexDesktopOwnerRuntime(adapter);
    client.request.mockResolvedValue({ thread: { id: threadId, turns: [] } });
    await runtime.readThread(sessionId);
    (adapter as any).activeTurnIds.set(sessionId, "retrying-turn");
    (adapter as any).messageBuffers.set(sessionId, (adapter as any).createMessageBuffer(sessionId, "/repo", threadId));
    (adapter as any).handleNotification("error", { threadId, turnId: "retrying-turn", willRetry: true, error: { message: "Rate limited" } });
    expect((adapter as any).activeTurnIds.get(sessionId)).toBe("retrying-turn");
    expect((adapter as any).messageBuffers.has(sessionId)).toBe(true);
    (adapter as any).handleTurnCompleted(sessionId, { turn: { id: "retrying-turn", status: "failed", error: { message: "Retries exhausted" } } });
    expect((adapter as any).activeTurnIds.has(sessionId)).toBe(false);
  });

  it("applies conditional next-turn settings without switching providers or executing native requests", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId } = seedSession(adapter);
    const runtime = createCodexDesktopOwnerRuntime(adapter);
    expect(await runtime.updateSettings!(sessionId, { model: "next-model" }, { condition: { ifModelEquals: "wrong-model" } })).toBe(false);
    await expect(runtime.updateSettings!(sessionId, { modelProvider: "foreign" }, {})).rejects.toThrow("Unsupported Desktop owner setting");
    expect(await runtime.updateSettings!(sessionId, { collaborationMode: { mode: "plan", settings: { model: "next-model", reasoning_effort: "ultra", developer_instructions: null } } }, {})).toBe(true);
    expect((adapter as any).desktopOwnerSettings(sessionId)).toMatchObject({ model: "next-model", effort: "ultra", collaborationMode: { mode: "plan" } });
    expect((adapter as any).nativeSessionSettings.get(sessionId).modelProvider).not.toBe("foreign");
    await expect(runtime.updateSettings!(sessionId, { model: "other" }, { activeTurnId: "active" })).rejects.toThrow("active Codex turn");
    expect(client.request).not.toHaveBeenCalled();
  });
});


describe("Codex native item streams", () => {

  it("keeps proposed plan items independent from progress plans and authoritative after completion", () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const notify = (method: string, data: Record<string, unknown>) =>
      (adapter as any).handleNotification(method, { threadId, turnId: "plan-turn", ...data });
    notify("turn/started", { turn: { id: "plan-turn" } });
    notify("turn/plan/updated", { plan: [{ step: "Inspect", status: "in_progress" }] });
    notify("item/started", { item: { id: "plan-1", type: "plan", text: "" } });
    notify("item/started", { item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "" } });
    notify("item/plan/delta", { itemId: "plan-1", delta: "First draft" });
    notify("item/plan/delta", { itemId: "plan-2", delta: "Second draft" });
    notify("item/started", { item: { id: "plan-2", type: "plan", text: "" } });
    notify("turn/plan/updated", { plan: [{ step: "Inspect", status: "completed" }] });
    const plans = [
      { id: "plan-1", type: "plan", text: "First final plan" },
      { id: "plan-2", type: "plan", text: "# Second final plan" },
    ];
    for (const item of plans) {
      notify("item/completed", { item });
      notify("item/plan/delta", { itemId: item.id, delta: "Late duplicate" });
      notify("item/started", { item: { ...item, text: "" } });
    }
    notify("item/completed", { item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "Approved" } });
    const parts = (adapter as any).messageBuffers.get(sessionId).parts;
    expect(parts).toMatchObject([
      { text: "## Plan\n\n- [x] Inspect", phase: "commentary", order: 0 },
      { text: "## Plan\n\nFirst final plan", phase: "partial", order: 1 },
      { text: "Approved", phase: "final", order: 2 },
      { text: "# Second final plan", phase: "partial", order: 3 },
    ]);
    expect(new Set(parts.map((part: any) => part.id)).size).toBe(4);
    const [history] = convertThreadToMessages(sessionId, { thread: { id: threadId, turns: [{
      id: "plan-turn", status: "completed", items: plans,
    }] } });
    expect(parts.filter((part: any) => part.phase === "partial")
      .map((part: any) => ({ id: part.id, text: part.text, phase: part.phase })))
      .toEqual(history.parts.map((part: any) => ({ id: part.id, text: part.text, phase: part.phase })));
  });

  it("keeps an in-flight proposed plan before a steering boundary", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const notify = (method: string, data: Record<string, unknown>) =>
      (adapter as any).handleNotification(method, { threadId, turnId: "plan-steer", ...data });
    notify("turn/started", { turn: { id: "plan-steer" } });
    notify("item/started", { item: { id: "plan", type: "plan", text: "" } });
    client.request.mockResolvedValue({ turnId: "plan-steer" });
    const sending = adapter.sendMessage(sessionId, [{ type: "text", text: "Make it smaller" }]);
    await flushMicrotasks();
    notify("item/plan/delta", { itemId: "plan", delta: "Original draft" });
    notify("item/completed", { item: { id: "plan", type: "plan", text: "Original proposal" } });
    notify("item/completed", { item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "Revised answer" } });
    notify("turn/completed", { turn: { id: "plan-steer", status: "completed" } });
    await sending;
    const messages = await adapter.listMessages(sessionId);
    expect(messages.map((message) => message.role)).toEqual(["assistant", "user", "assistant"]);
    expect(messages[0].parts).toMatchObject([{ text: "## Plan\n\nOriginal proposal", phase: "partial" }]);
    expect(messages[2].parts).toMatchObject([{ text: "Revised answer", phase: "final" }]);
  });

  it("keeps raw-only reasoning invisible through streaming and completion", () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const notify = (method: string, data: Record<string, unknown>) =>
      (adapter as any).handleNotification(method, { threadId, turnId: "raw-turn", ...data });
    const updates: unknown[] = [];
    adapter.on("message.part.updated", ({ part }) => updates.push(part));
    notify("turn/started", { turn: { id: "raw-turn" } });
    notify("item/started", { item: { id: "reason", type: "reasoning", summary: [], content: [] } });
    notify("item/reasoning/textDelta", { itemId: "reason", contentIndex: 0, delta: "Raw reasoning" });
    notify("item/completed", { item: { id: "reason", type: "reasoning", summary: [], content: ["Raw reasoning"] } });
    expect(updates).toEqual([]);
    expect((adapter as any).messageBuffers.get(sessionId).parts).toEqual([]);
    expect((adapter as any).hasActiveTurn(sessionId)).toBe(true);
  });

  it("keeps turn controls running when steering closes a commentary segment", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const notify = (method: string, data: Record<string, unknown>) =>
      (adapter as any).handleNotification(method, { threadId, turnId: "commentary-turn", ...data });
    let sending = true;
    adapter.on("message.updated", ({ message }) => {
      if (message.role === "assistant" && message.time.completed != null) sending = false;
    });
    notify("turn/started", { turn: { id: "commentary-turn" } });
    notify("item/completed", { item: { id: "commentary", type: "agentMessage", phase: "commentary", text: "Checking" } });
    client.request.mockResolvedValue({ turnId: "commentary-turn" });
    const steer = adapter.sendMessage(sessionId, [{ type: "text", text: "Use another approach" }]);
    await flushMicrotasks();
    expect(sending).toBe(true);
    expect((adapter as any).hasActiveTurn(sessionId)).toBe(true);
    notify("turn/completed", { turn: { id: "commentary-turn", status: "completed" } });
    await steer;
    expect(sending).toBe(false);
    expect((await adapter.listMessages(sessionId)).filter((message) => message.role === "assistant").every((message) => message.time.completed != null)).toBe(true);
  });



  it("keeps in-flight items before the user boundary across two steering acknowledgements", async () => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const notify = (method: string, data: Record<string, unknown>) =>
      (adapter as any).handleNotification(method, { threadId, turnId: "steered", ...data });
    notify("turn/started", { turn: { id: "steered" } });
    notify("item/started", { item: { id: "command", type: "commandExecution", command: "pwd" } });
    const acknowledgements: Array<(value: unknown) => void> = [];
    client.request.mockImplementation(() => new Promise((resolve) => acknowledgements.push(resolve)));
    const first = adapter.sendMessage(sessionId, [{ type: "text", text: "First direction" }]);
    const second = adapter.sendMessage(sessionId, [{ type: "text", text: "Second direction" }]);
    await flushMicrotasks();
    acknowledgements[1]({ turnId: "steered" });
    await flushMicrotasks();
    acknowledgements[0]({ turnId: "steered" });
    await flushMicrotasks();
    expect((await adapter.listMessages(sessionId))[0].time.completed).toBeUndefined();
    notify("item/completed", { item: { id: "command", type: "commandExecution", command: "pwd", aggregatedOutput: "/repo", exitCode: 0 } });
    notify("item/completed", { item: { id: "answer", type: "agentMessage", text: "Done", phase: "final_answer" } });
    notify("turn/completed", { turn: { id: "steered", status: "completed" } });
    expect((await first).error).toBeUndefined();
    expect((await second).error).toBeUndefined();
    const messages = await adapter.listMessages(sessionId);
    expect(messages.map((message) => message.role)).toEqual(["assistant", "user", "user", "assistant"]);
    expect(messages[0].parts.find((part) => part.type === "tool")).toMatchObject({ state: { status: "completed", output: "/repo" } });
    expect(messages.at(-1)!.parts.filter((part) => part.type === "text")).toMatchObject([{ text: "Done", phase: "final" }]);
    expect((adapter as any).hasActiveTurn(sessionId)).toBe(false);
  });


  it("preserves commentary, tool, and final identity through authoritative and late events", async () => {
    const { adapter } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    const notify = (method: string, data: Record<string, unknown>) =>
      (adapter as any).handleNotification(method, { threadId, turnId: "native-turn", ...data });
    notify("turn/started", { turn: { id: "native-turn" } });
    const user = { id: "user", type: "userMessage", content: [{ type: "text", text: "Check" }] };
    notify("item/started", { item: user });
    notify("item/completed", { item: user });
    notify("item/started", { item: { id: "z-commentary", type: "agentMessage", phase: "commentary", text: "" } });
    notify("item/agentMessage/delta", { itemId: "z-commentary", delta: "Checking." });
    notify("item/completed", { item: { id: "z-commentary", type: "agentMessage", phase: "commentary", text: "Checked." } });
    notify("item/agentMessage/delta", { itemId: "z-commentary", delta: "Late duplicate" });
    notify("item/started", { item: { id: "command", type: "commandExecution", command: "pwd" } });
    notify("item/completed", { item: { id: "command", type: "commandExecution", command: "pwd", aggregatedOutput: "/repo", exitCode: 0 } });
    notify("item/started", { item: { id: "a-final", type: "agentMessage", phase: "final_answer", text: "" } });
    notify("item/agentMessage/delta", { itemId: "a-final", delta: "Don" });
    const final = { id: "a-final", type: "agentMessage", phase: "final_answer", text: "Done." };
    notify("item/completed", { item: final });
    notify("turn/completed", { turn: { id: "native-turn", status: "completed", items: [final] } });
    const message = (await adapter.listMessages(sessionId)).at(-1)!;
    expect(message.parts.filter((p) => p.type === "text" || p.type === "tool").map((p: any) => [p.type, p.text ?? p.state.output, p.phase])).toEqual([
      ["text", "Checked.", "commentary"], ["tool", "/repo", undefined], ["text", "Done.", "final"],
    ]);
    expect(message.parts.map((part) => part.order)).toEqual(message.parts.map((_, index) => index));
    expect(message.parts.some((part: any) => part.originalTool === "userMessage")).toBe(false);
  });

  it.each([true, false])("interrupts a pending start without reviving it when notification arrives first: %s", async (notificationFirst) => {
    const { adapter, client } = createAdapterWithClient();
    const { sessionId, threadId } = seedSession(adapter);
    let admit!: (value: unknown) => void;
    client.request.mockImplementation((method: string) => method === "turn/start"
      ? new Promise((resolve) => { admit = resolve; }) : Promise.resolve({}));
    const send = adapter.sendMessage(sessionId, [{ type: "text", text: "Check" }]);
    await flushMicrotasks();
    await adapter.cancelMessage(sessionId);
    expect((await send).error).toBe("Cancelled");
    if (notificationFirst) (adapter as any).handleNotification("turn/started", { threadId, turn: { id: "cancelled-start" } });
    admit({ turn: { id: "cancelled-start" } });
    await flushMicrotasks();
    (adapter as any).handleNotification("turn/started", { threadId, turn: { id: "cancelled-start" } });
    (adapter as any).handleNotification("item/agentMessage/delta", { threadId, turnId: "cancelled-start", itemId: "answer", delta: "Do not resurrect" });
    expect(client.request.mock.calls.filter(([method]) => method === "turn/interrupt")).toEqual([
      ["turn/interrupt", { threadId, turnId: "cancelled-start" }],
    ]);
    expect((adapter as any).hasActiveTurn(sessionId)).toBe(false);
    expect((await adapter.listMessages(sessionId)).filter((message) => message.role === "assistant")).toHaveLength(1);
  });
});
