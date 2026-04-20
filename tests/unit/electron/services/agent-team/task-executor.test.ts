import { EventEmitter } from "events";
import { describe, it, expect, vi, afterEach } from "vitest";
import { TaskExecutor } from "../../../../../electron/main/services/agent-team/task-executor";
import type { TaskNode, UnifiedMessage } from "../../../../../src/types/unified";

function makeTask(overrides: Partial<TaskNode> & { id: string }): TaskNode {
  return {
    id: overrides.id,
    description: `Task ${overrides.id}`,
    prompt: `Do ${overrides.id}`,
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

function makeTextMessage(text: string, overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  const messageId = `msg-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: messageId,
    sessionId: "session",
    role: "assistant",
    time: { created: Date.now() },
    parts: [{
      id: `${messageId}-part`,
      messageId,
      sessionId: "session",
      type: "text",
      text,
    }] as any,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class EngineManagerMock extends EventEmitter {
  createSession = vi.fn(async () => ({ id: "session-1" }));
  sendMessage = vi.fn(async () => makeTextMessage("done"));
  cancelMessage = vi.fn(async () => {});
}

describe("TaskExecutor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resets inactivity timeout when the worker session keeps emitting activity", async () => {
    vi.useFakeTimers();

    const deferred = createDeferred<UnifiedMessage>();
    const engineManager = new EngineManagerMock();
    engineManager.createSession = vi.fn(async () => ({ id: "worker-1" }));
    engineManager.sendMessage = vi.fn(async () => deferred.promise);

    const executor = new TaskExecutor(engineManager as any, new Set(), "opencode");
    const executionPromise = executor.execute(
      makeTask({ id: "t1" }),
      "/repo",
      { inactivityTimeoutMs: 1000, maxRetries: 0, retryBackoffMs: 0 },
    );

    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(900);
    engineManager.emit("message.part.updated", {
      sessionId: "worker-1",
      messageId: "msg-1",
      part: { id: "part-1", type: "text", text: "partial" },
    });

    await vi.advanceTimersByTimeAsync(900);
    engineManager.emit("permission.asked", {
      permission: { id: "perm-1", sessionId: "worker-1" },
    });

    await vi.advanceTimersByTimeAsync(900);
    engineManager.emit("question.asked", {
      question: { id: "question-1", sessionId: "worker-1" },
    });

    await vi.advanceTimersByTimeAsync(1100);
    const result = await executionPromise;

    expect(result.error).toBe("Task timed out after 1 second of inactivity.");
    expect(engineManager.cancelMessage).toHaveBeenCalledWith("worker-1");
  });

  it("retries once after a recoverable worker failure", async () => {
    const engineManager = new EngineManagerMock();
    engineManager.createSession = vi.fn()
      .mockResolvedValueOnce({ id: "worker-1" })
      .mockResolvedValueOnce({ id: "worker-2" });
    engineManager.sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce(makeTextMessage("Recovered result"));

    const executor = new TaskExecutor(engineManager as any, new Set(), "opencode");
    const task = makeTask({ id: "t1" });
    const result = await executor.execute(task, "/repo", {
      maxRetries: 1,
      retryBackoffMs: 0,
      inactivityTimeoutMs: 1000,
    });

    expect(result.error).toBeUndefined();
    expect(result.summary).toBe("Recovered result");
    expect(result.sessionId).toBe("worker-2");
    expect(task.sessionId).toBe("worker-2");
    expect(engineManager.createSession).toHaveBeenCalledTimes(2);
    expect(engineManager.sendMessage).toHaveBeenCalledTimes(2);
    expect(engineManager.cancelMessage).toHaveBeenCalledWith("worker-1");
  });

  it("passes worktreeId through to session creation", async () => {
    const engineManager = new EngineManagerMock();
    const executor = new TaskExecutor(engineManager as any, new Set(), "opencode");

    await executor.execute(
      makeTask({ id: "t1", worktreeId: "feature-branch" }),
      "/repo",
      { maxRetries: 0, retryBackoffMs: 0, inactivityTimeoutMs: 1000 },
    );

    expect(engineManager.createSession).toHaveBeenCalledWith("opencode", "/repo", "feature-branch");
  });

  it("inherits the default worktreeId when the task does not override it", async () => {
    const engineManager = new EngineManagerMock();
    const executor = new TaskExecutor(engineManager as any, new Set(), "opencode");
    const task = makeTask({ id: "t1" });

    await executor.execute(
      task,
      "/repo",
      {
        defaultWorktreeId: "feature-branch",
        maxRetries: 0,
        retryBackoffMs: 0,
        inactivityTimeoutMs: 1000,
      },
    );

    expect(task.worktreeId).toBe("feature-branch");
    expect(engineManager.createSession).toHaveBeenCalledWith("opencode", "/repo", "feature-branch");
  });

  it("resolves task.role to engineType via RoleResolver when engineType is not pre-set", async () => {
    const engineManager = new EngineManagerMock();
    const resolveRole = vi.fn((role: string) =>
      role === "explorer" ? { engineType: "claude" as const, modelId: "sonnet-4" } : null,
    );
    const executor = new TaskExecutor(engineManager as any, new Set(), "opencode", resolveRole);
    const task = makeTask({ id: "t1", role: "explorer" });

    await executor.execute(task, "/repo", {
      maxRetries: 0,
      retryBackoffMs: 0,
      inactivityTimeoutMs: 1000,
    });

    expect(resolveRole).toHaveBeenCalledWith("explorer");
    expect(task.engineType).toBe("claude");
    expect(task.modelId).toBe("sonnet-4");
    expect(engineManager.createSession).toHaveBeenCalledWith("claude", "/repo", undefined);
  });

  it("preserves explicit task.engineType even when task.role is also set", async () => {
    const engineManager = new EngineManagerMock();
    const resolveRole = vi.fn(() => ({ engineType: "claude" as const }));
    const executor = new TaskExecutor(engineManager as any, new Set(), "opencode", resolveRole);
    const task = makeTask({ id: "t1", role: "explorer", engineType: "copilot" });

    await executor.execute(task, "/repo", {
      maxRetries: 0,
      retryBackoffMs: 0,
      inactivityTimeoutMs: 1000,
    });

    expect(resolveRole).not.toHaveBeenCalled();
    expect(task.engineType).toBe("copilot");
    expect(engineManager.createSession).toHaveBeenCalledWith("copilot", "/repo", undefined);
  });

  it("falls back to defaultEngineType when RoleResolver returns null", async () => {
    const engineManager = new EngineManagerMock();
    const resolveRole = vi.fn(() => null);
    const executor = new TaskExecutor(engineManager as any, new Set(), "opencode", resolveRole);
    const task = makeTask({ id: "t1", role: "designer" });

    await executor.execute(task, "/repo", {
      maxRetries: 0,
      retryBackoffMs: 0,
      inactivityTimeoutMs: 1000,
    });

    expect(resolveRole).toHaveBeenCalledWith("designer");
    expect(task.engineType).toBeUndefined();
    expect(engineManager.createSession).toHaveBeenCalledWith("opencode", "/repo", undefined);
  });
});
