import { existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mkdtempSyncMock, writeFileSyncMock, resolveCodexCliPathMock, resolveCodexCliVersionMock } = vi.hoisted(() => ({
  mkdtempSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  resolveCodexCliPathMock: vi.fn(),
  resolveCodexCliVersionMock: vi.fn(),
}));

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

import { CodexAdapter } from "../../../../../electron/main/engines/codex/index";

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
    client.request.mockResolvedValue({
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
    });

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
      engineMeta: { codexThreadId: "thread-1" },
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
    expect(buffer.engineMeta).toEqual({ codexThreadId: threadId, turnDiff: "@@ -1 +1 @@" });
    expect(buffer.modelId).toBe("gpt-5.4");
    expect(partUpdates.some((part) => part.type === "text" && part.text.includes("## Plan"))).toBe(true);
    expect(partUpdates.some((part) => part.type === "system-notice" && part.noticeType === "compact")).toBe(true);
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
    expect(reasoningPart.text).toBe("Inspect\n\nApply the fix");
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

  it("reports fastModeSupported based on auth type", async () => {
    const { adapter } = createAdapterWithClient();

    // Default: no auth type set
    expect(adapter.getCapabilities().fastModeSupported).toBe(false);

    // ChatGPT auth
    (adapter as any).authType = "chatgpt";
    expect(adapter.getCapabilities().fastModeSupported).toBe(true);

    // API key auth
    (adapter as any).authType = "apiKey";
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
