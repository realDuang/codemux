import { describe, it, expect, vi } from "vitest";

vi.mock("../../../../../electron/main/services/agent-team/logger", () => ({
  agentTeamLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { HeavyBrainOrchestrator } from "../../../../../electron/main/services/agent-team/heavy-brain";
import type { TeamRun, UnifiedMessage } from "../../../../../src/types/unified";

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

function makeJsonMessage(payload: unknown, overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return makeTextMessage(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``, overrides);
}

function makeRun(overrides: Partial<TeamRun> = {}): TeamRun {
  return {
    id: "team-run",
    parentSessionId: "parent-session",
    directory: "/repo",
    originalPrompt: "Do the work",
    mode: "heavy",
    status: "planning",
    tasks: [],
    time: { created: 1_000 },
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

function createEngineManagerMock(
  sessionIds: string[],
  sendMessage: (sessionId: string, content: Array<{ type: string; text?: string }>) => Promise<UnifiedMessage>,
) {
  return {
    getDefaultEngineType: vi.fn(() => "opencode"),
    listEngines: vi.fn(() => [{
      type: "opencode",
      name: "OpenCode",
      status: "running",
    }]),
    createSession: vi.fn(async () => ({ id: sessionIds.shift() ?? "session-fallback" })),
    sendMessage: vi.fn(sendMessage),
    cancelMessage: vi.fn(async () => {}),
  } as any;
}

describe("HeavyBrainOrchestrator", () => {
  it("reports upstream results before starting dependent tasks in the same dispatch batch", async () => {
    const events: string[] = [];
    const sendMessage = vi.fn(async (sessionId: string, content: Array<{ text?: string }>) => {
      const text = content[0]?.text ?? "";

      if (sessionId === "orch-session") {
        if (text.includes("## Task Completed: A")) {
          events.push("orchestrator-saw-a");
          return makeJsonMessage({ action: "continueWaiting" });
        }
        if (text.includes("## Task Completed: B")) {
          events.push("orchestrator-saw-b");
          return makeJsonMessage({ action: "complete", result: "done" });
        }

        events.push("orchestrator-initial");
        return makeJsonMessage({
          action: "dispatch",
          tasks: [
            { id: "A", description: "Task A", prompt: "Run A", dependsOn: [] },
            { id: "B", description: "Task B", prompt: "Run B", dependsOn: ["A"] },
          ],
        });
      }

      if (sessionId === "worker-a") {
        events.push("worker-a-started");
        expect(text).toContain("Run A");
        return makeTextMessage("A result");
      }

      if (sessionId === "worker-b") {
        events.push("worker-b-started");
        expect(text).toContain("Run B");
        expect(text).toContain("A result");
        return makeTextMessage("B result");
      }

      throw new Error(`Unexpected session ${sessionId}`);
    });

    const engineManager = createEngineManagerMock(
      ["orch-session", "worker-a", "worker-b"],
      sendMessage,
    );
    const orchestrator = new HeavyBrainOrchestrator(engineManager, new Set());
    const teamRun = makeRun();
    const updates: string[] = [];

    await orchestrator.run(teamRun, "opencode", (task) => {
      updates.push(`${task.id}:${task.status}`);
    });

    expect(teamRun.status).toBe("completed");
    expect(teamRun.tasks.map((task) => `${task.id}:${task.status}`)).toEqual([
      "A:completed",
      "B:completed",
    ]);
    expect(updates).toContain("B:pending");
    expect(updates).toContain("B:running");
    expect(events.indexOf("orchestrator-saw-a")).toBeLessThan(events.indexOf("worker-b-started"));
  });

  it("allows later dispatches to depend on already completed tasks", async () => {
    const events: string[] = [];
    const sendMessage = vi.fn(async (sessionId: string, content: Array<{ text?: string }>) => {
      const text = content[0]?.text ?? "";

      if (sessionId === "orch-session") {
        if (text.includes("## Task Completed: A")) {
          events.push("orchestrator-dispatched-b");
          return makeJsonMessage({
            action: "dispatch",
            tasks: [
              { id: "B", description: "Task B", prompt: "Run B", dependsOn: ["A"] },
            ],
          });
        }
        if (text.includes("## Task Completed: B")) {
          events.push("orchestrator-completed");
          return makeJsonMessage({ action: "complete", result: "done" });
        }

        return makeJsonMessage({
          action: "dispatch",
          tasks: [
            { id: "A", description: "Task A", prompt: "Run A", dependsOn: [] },
          ],
        });
      }

      if (sessionId === "worker-a") {
        events.push("worker-a-started");
        return makeTextMessage("A result");
      }

      if (sessionId === "worker-b") {
        events.push("worker-b-started");
        expect(text).toContain("Run B");
        expect(text).toContain("A result");
        return makeTextMessage("B result");
      }

      throw new Error(`Unexpected session ${sessionId}`);
    });

    const engineManager = createEngineManagerMock(
      ["orch-session", "worker-a", "worker-b"],
      sendMessage,
    );
    const orchestrator = new HeavyBrainOrchestrator(engineManager, new Set());
    const teamRun = makeRun();

    await orchestrator.run(teamRun, "opencode", () => {});

    expect(teamRun.status).toBe("completed");
    expect(teamRun.tasks.map((task) => `${task.id}:${task.status}`)).toEqual([
      "A:completed",
      "B:completed",
    ]);
    expect(events.indexOf("orchestrator-dispatched-b")).toBeLessThan(events.indexOf("worker-b-started"));
  });

  it("fails the run when a later dispatch reuses an existing task id", async () => {
    const sendMessage = vi.fn(async (sessionId: string, content: Array<{ text?: string }>) => {
      const text = content[0]?.text ?? "";

      if (sessionId === "orch-session") {
        if (text.includes("## Task Completed: A")) {
          return makeJsonMessage({
            action: "dispatch",
            tasks: [
              { id: "A", description: "Task A again", prompt: "Run A again", dependsOn: [] },
            ],
          });
        }

        return makeJsonMessage({
          action: "dispatch",
          tasks: [
            { id: "A", description: "Task A", prompt: "Run A", dependsOn: [] },
          ],
        });
      }

      if (sessionId === "worker-a") {
        return makeTextMessage("A result");
      }

      throw new Error(`Unexpected session ${sessionId}`);
    });

    const engineManager = createEngineManagerMock(["orch-session", "worker-a"], sendMessage);
    const orchestrator = new HeavyBrainOrchestrator(engineManager, new Set());
    const teamRun = makeRun();

    await orchestrator.run(teamRun, "opencode", () => {});

    expect(teamRun.status).toBe("failed");
    expect(teamRun.finalResult).toContain("Duplicate task id 'A'");
    expect(teamRun.tasks).toHaveLength(1);
    expect(teamRun.tasks[0].status).toBe("completed");
    expect(engineManager.createSession).toHaveBeenCalledTimes(2);
  });

  it("blocks downstream tasks after an upstream failure", async () => {
    const events: string[] = [];
    const sendMessage = vi.fn(async (sessionId: string, content: Array<{ text?: string }>) => {
      const text = content[0]?.text ?? "";

      if (sessionId === "orch-session") {
        if (text.includes("## Task Failed: A")) {
          events.push("orchestrator-saw-a-failure");
          return makeJsonMessage({ action: "continueWaiting" });
        }
        if (text.includes("## Task Execution Results")) {
          events.push("orchestrator-saw-summary");
          expect(text).toContain('[BLOCKED]');
          return makeJsonMessage({ action: "complete", result: "handled failure" });
        }

        return makeJsonMessage({
          action: "dispatch",
          tasks: [
            { id: "A", description: "Task A", prompt: "Run A", dependsOn: [] },
            { id: "B", description: "Task B", prompt: "Run B", dependsOn: ["A"] },
          ],
        });
      }

      if (sessionId === "worker-a") {
        events.push("worker-a-started");
        return makeTextMessage("A failed", { error: "boom" });
      }

      if (sessionId === "worker-b") {
        throw new Error("Downstream blocked task should not start");
      }

      throw new Error(`Unexpected session ${sessionId}`);
    });

    const engineManager = createEngineManagerMock(
      ["orch-session", "worker-a"],
      sendMessage,
    );
    const orchestrator = new HeavyBrainOrchestrator(engineManager, new Set());
    const teamRun = makeRun();

    await orchestrator.run(teamRun, "opencode", () => {});

    expect(teamRun.status).toBe("completed");
    expect(teamRun.finalResult).toBe("handled failure");
    expect(teamRun.tasks.map((task) => `${task.id}:${task.status}`)).toEqual([
      "A:failed",
      "B:blocked",
    ]);
    expect(events).not.toContain("worker-b-started");
  });

  it("cancels running workers and pending tasks when the orchestrator completes early", async () => {
    const workerB = createDeferred<UnifiedMessage>();
    const sendMessage = vi.fn(async (sessionId: string, content: Array<{ text?: string }>) => {
      const text = content[0]?.text ?? "";

      if (sessionId === "orch-session") {
        if (text.includes("## Task Completed: A")) {
          return makeJsonMessage({ action: "complete", result: "done early" });
        }

        return makeJsonMessage({
          action: "dispatch",
          tasks: [
            { id: "A", description: "Task A", prompt: "Run A", dependsOn: [] },
            { id: "B", description: "Task B", prompt: "Run B", dependsOn: [] },
            { id: "C", description: "Task C", prompt: "Run C", dependsOn: ["A"] },
          ],
        });
      }

      if (sessionId === "worker-a") {
        return makeTextMessage("A result");
      }

      if (sessionId === "worker-b") {
        return workerB.promise;
      }

      throw new Error(`Unexpected session ${sessionId}`);
    });

    const engineManager = createEngineManagerMock(
      ["orch-session", "worker-a", "worker-b"],
      sendMessage,
    );
    const orchestrator = new HeavyBrainOrchestrator(engineManager, new Set());
    const teamRun = makeRun();

    await orchestrator.run(teamRun, "opencode", () => {});

    expect(teamRun.status).toBe("completed");
    expect(teamRun.finalResult).toBe("done early");
    expect(teamRun.tasks.map((task) => `${task.id}:${task.status}`)).toEqual([
      "A:completed",
      "B:cancelled",
      "C:cancelled",
    ]);
    expect(engineManager.cancelMessage).toHaveBeenCalledWith("worker-b");

    workerB.resolve(makeTextMessage("late B result"));
    await Promise.resolve();
    await Promise.resolve();

    expect(teamRun.tasks.find((task) => task.id === "B")?.status).toBe("cancelled");
  });

  it("cancels active sessions on user cancel and ignores late worker results", async () => {
    const workerStarted = createDeferred<void>();
    const workerResult = createDeferred<UnifiedMessage>();
    const sendMessage = vi.fn(async (sessionId: string) => {
      if (sessionId === "orch-session") {
        return makeJsonMessage({
          action: "dispatch",
          tasks: [
            { id: "A", description: "Task A", prompt: "Run A", dependsOn: [] },
          ],
        });
      }

      if (sessionId === "worker-a") {
        workerStarted.resolve();
        return workerResult.promise;
      }

      throw new Error(`Unexpected session ${sessionId}`);
    });

    const engineManager = createEngineManagerMock(
      ["orch-session", "worker-a"],
      sendMessage,
    );
    const orchestrator = new HeavyBrainOrchestrator(engineManager, new Set());
    const teamRun = makeRun();

    const runPromise = orchestrator.run(teamRun, "opencode", () => {});
    await workerStarted.promise;

    await orchestrator.cancel();
    await runPromise;

    expect(teamRun.status).toBe("cancelled");
    expect(teamRun.finalResult).toBe("Orchestration was cancelled.");
    expect(teamRun.tasks.map((task) => `${task.id}:${task.status}`)).toEqual([
      "A:cancelled",
    ]);
    expect(engineManager.cancelMessage).toHaveBeenCalledWith("orch-session");
    expect(engineManager.cancelMessage).toHaveBeenCalledWith("worker-a");

    workerResult.resolve(makeTextMessage("late result"));
    await Promise.resolve();
    await Promise.resolve();

    expect(teamRun.tasks[0].status).toBe("cancelled");
  });

  it("respects the max concurrent task limit when starting ready workers", async () => {
    const workerA = createDeferred<UnifiedMessage>();
    const workerB = createDeferred<UnifiedMessage>();
    const workerC = createDeferred<UnifiedMessage>();
    const workerAStarted = createDeferred<void>();
    const workerBStarted = createDeferred<void>();
    const workerCStarted = createDeferred<void>();
    const started: string[] = [];

    let orchestrationStep = 0;
    const sendMessage = vi.fn(async (sessionId: string, content: Array<{ text?: string }>) => {
      const text = content[0]?.text ?? "";

      if (sessionId === "orch-session") {
        if (text.includes("## Task Completed: A")) {
          orchestrationStep += 1;
          return makeJsonMessage({ action: "continueWaiting" });
        }
        if (text.includes("## Task Completed: B")) {
          orchestrationStep += 1;
          return makeJsonMessage({ action: "continueWaiting" });
        }
        if (text.includes("## Task Completed: C")) {
          orchestrationStep += 1;
          return makeJsonMessage({ action: "complete", result: "done" });
        }

        return makeJsonMessage({
          action: "dispatch",
          tasks: [
            { id: "A", description: "Task A", prompt: "Run A", dependsOn: [] },
            { id: "B", description: "Task B", prompt: "Run B", dependsOn: [] },
            { id: "C", description: "Task C", prompt: "Run C", dependsOn: [] },
          ],
        });
      }

      if (sessionId === "worker-a") {
        started.push("A");
        workerAStarted.resolve();
        return workerA.promise;
      }

      if (sessionId === "worker-b") {
        started.push("B");
        workerBStarted.resolve();
        return workerB.promise;
      }

      if (sessionId === "worker-c") {
        started.push("C");
        workerCStarted.resolve();
        return workerC.promise;
      }

      throw new Error(`Unexpected session ${sessionId}`);
    });

    const engineManager = createEngineManagerMock(
      ["orch-session", "worker-a", "worker-b", "worker-c"],
      sendMessage,
    );
    const orchestrator = new HeavyBrainOrchestrator(engineManager, new Set(), 1);
    const teamRun = makeRun();

    const runPromise = orchestrator.run(teamRun, "opencode", () => {});
    await workerAStarted.promise;

    expect(started).toEqual(["A"]);
    expect(engineManager.createSession).toHaveBeenCalledTimes(2);

    workerA.resolve(makeTextMessage("A result"));
    await workerBStarted.promise;

    expect(started).toEqual(["A", "B"]);
    expect(engineManager.createSession).toHaveBeenCalledTimes(3);

    workerB.resolve(makeTextMessage("B result"));
    await workerCStarted.promise;

    expect(started).toEqual(["A", "B", "C"]);
    expect(engineManager.createSession).toHaveBeenCalledTimes(4);

    workerC.resolve(makeTextMessage("C result"));
    await runPromise;

    expect(orchestrationStep).toBe(3);
    expect(teamRun.status).toBe("completed");
  });

  it("passes dispatch worktreeId through to worker sessions", async () => {
    const sendMessage = vi.fn(async (sessionId: string) => {
      if (sessionId === "orch-session") {
        return makeJsonMessage({
          action: "dispatch",
          tasks: [
            {
              id: "A",
              description: "Task A",
              prompt: "Run A",
              dependsOn: [],
              worktreeId: "feature-branch",
            },
          ],
        });
      }

      if (sessionId === "worker-a") {
        return makeTextMessage("A result");
      }

      throw new Error(`Unexpected session ${sessionId}`);
    });

    const engineManager = createEngineManagerMock(["orch-session", "worker-a"], sendMessage);
    const orchestrator = new HeavyBrainOrchestrator(engineManager, new Set());
    const teamRun = makeRun();

    await orchestrator.run(teamRun, "opencode", () => {});

    expect(teamRun.tasks[0].worktreeId).toBe("feature-branch");
    expect(engineManager.createSession).toHaveBeenNthCalledWith(2, "opencode", "/repo", "feature-branch");
  });

  it("keeps worktree team runs inside the parent project worktree context", async () => {
    const sendMessage = vi.fn(async (sessionId: string, content: Array<{ text?: string }>) => {
      const text = content[0]?.text ?? "";

      if (sessionId === "orch-session") {
        if (text.includes("## Task Completed: A")) {
          return makeJsonMessage({ action: "complete", result: "done" });
        }

        return makeJsonMessage({
          action: "dispatch",
          tasks: [
            {
              id: "A",
              description: "Task A",
              prompt: "Run A",
              dependsOn: [],
            },
          ],
        });
      }

      if (sessionId === "worker-a") {
        return makeTextMessage("A result");
      }

      throw new Error(`Unexpected session ${sessionId}`);
    });

    const engineManager = createEngineManagerMock(["orch-session", "worker-a"], sendMessage);
    const orchestrator = new HeavyBrainOrchestrator(engineManager, new Set());
    const teamRun = makeRun({
      directory: "/repo/.worktrees/feature-branch",
      parentDirectory: "/repo",
      worktreeId: "feature-branch",
    });

    await orchestrator.run(teamRun, "opencode", () => {});

    expect(teamRun.tasks[0].worktreeId).toBe("feature-branch");
    expect(engineManager.createSession).toHaveBeenNthCalledWith(
      1,
      "opencode",
      "/repo",
      "feature-branch",
      expect.objectContaining({
        systemPrompt: expect.any(String),
      }),
    );
    expect(engineManager.createSession).toHaveBeenNthCalledWith(
      2,
      "opencode",
      "/repo",
      "feature-branch",
    );
  });
});
