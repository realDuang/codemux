import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock electron and logger before imports
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/test"),
    isPackaged: false,
    on: vi.fn(),
  },
}));

vi.mock("../../../../../electron/main/services/logger", () => ({
  agentTeamLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { DAGExecutor } from "../../../../../electron/main/services/agent-team/dag-executor";
import { TaskExecutor } from "../../../../../electron/main/services/agent-team/task-executor";
import type { TeamRun, TaskNode } from "../../../../../src/types/unified";

function makeTask(overrides: Partial<TaskNode> & { id: string }): TaskNode {
  return {
    description: `Task ${overrides.id}`,
    prompt: `Do ${overrides.id}`,
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

function makeRun(tasks: TaskNode[]): TeamRun {
  return {
    id: "team_test",
    parentSessionId: "parent",
    directory: "/test",
    originalPrompt: "test",
    mode: "light",
    status: "running",
    tasks,
    time: { created: Date.now() },
  };
}

describe("DAGExecutor", () => {
  let mockTaskExecutor: TaskExecutor;

  beforeEach(() => {
    // Create a mock TaskExecutor
    mockTaskExecutor = {
      execute: vi.fn(async (task: TaskNode) => ({
        sessionId: `session_${task.id}`,
        summary: `Result of ${task.id}`,
      })),
    } as any;
  });

  it("executes independent tasks in parallel", async () => {
    const tasks = [
      makeTask({ id: "t1" }),
      makeTask({ id: "t2" }),
      makeTask({ id: "t3" }),
    ];
    const run = makeRun(tasks);

    const dagExecutor = new DAGExecutor(mockTaskExecutor, "/test");
    await dagExecutor.executeReadyTasks(run);

    // All 3 tasks should be completed
    expect(tasks.every((t) => t.status === "completed")).toBe(true);
    // TaskExecutor.execute should be called 3 times
    expect(mockTaskExecutor.execute).toHaveBeenCalledTimes(3);
  });

  it("respects dependencies: t2 waits for t1", async () => {
    const executionOrder: string[] = [];
    mockTaskExecutor.execute = vi.fn(async (task: TaskNode) => {
      executionOrder.push(task.id);
      return { sessionId: `s_${task.id}`, summary: `Result of ${task.id}` };
    });

    const tasks = [
      makeTask({ id: "t1" }),
      makeTask({ id: "t2", dependsOn: ["t1"] }),
    ];
    const run = makeRun(tasks);

    const dagExecutor = new DAGExecutor(mockTaskExecutor, "/test");
    await dagExecutor.executeReadyTasks(run);

    expect(tasks[0].status).toBe("completed");
    expect(tasks[1].status).toBe("completed");
    // t1 must execute before t2
    expect(executionOrder.indexOf("t1")).toBeLessThan(executionOrder.indexOf("t2"));
  });

  it("propagates failures: downstream tasks become blocked", async () => {
    mockTaskExecutor.execute = vi.fn(async (task: TaskNode) => {
      if (task.id === "t1") throw new Error("t1 failed");
      return { sessionId: `s_${task.id}`, summary: `ok` };
    });

    const tasks = [
      makeTask({ id: "t1" }),
      makeTask({ id: "t2", dependsOn: ["t1"] }),
      makeTask({ id: "t3" }),
    ];
    const run = makeRun(tasks);

    const dagExecutor = new DAGExecutor(mockTaskExecutor, "/test");
    await dagExecutor.executeReadyTasks(run);

    expect(tasks[0].status).toBe("failed");
    expect(tasks[1].status).toBe("blocked");
    expect(tasks[2].status).toBe("completed");
  });

  it("emits task.updated events", async () => {
    const tasks = [makeTask({ id: "t1" })];
    const run = makeRun(tasks);

    const dagExecutor = new DAGExecutor(mockTaskExecutor, "/test");
    const events: string[] = [];
    dagExecutor.on("task.updated", ({ task }) => {
      events.push(`${task.id}:${task.status}`);
    });

    await dagExecutor.executeReadyTasks(run);

    expect(events).toContain("t1:running");
    expect(events).toContain("t1:completed");
  });

  it("handles diamond dependency pattern", async () => {
    // t1 → t2, t3 → t4 (diamond)
    const tasks = [
      makeTask({ id: "t1" }),
      makeTask({ id: "t2", dependsOn: ["t1"] }),
      makeTask({ id: "t3", dependsOn: ["t1"] }),
      makeTask({ id: "t4", dependsOn: ["t2", "t3"] }),
    ];
    const run = makeRun(tasks);

    const dagExecutor = new DAGExecutor(mockTaskExecutor, "/test");
    await dagExecutor.executeReadyTasks(run);

    expect(tasks.every((t) => t.status === "completed")).toBe(true);
  });

  it("limits concurrently running ready tasks", async () => {
    const deferreds = new Map<string, () => void>();
    let thirdTaskStarted!: () => void;
    const thirdTaskStartedPromise = new Promise<void>((resolve) => {
      thirdTaskStarted = resolve;
    });
    let active = 0;
    let maxActive = 0;

    mockTaskExecutor.execute = vi.fn((task: TaskNode) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (task.id === "t3") {
        thirdTaskStarted();
      }

      return new Promise((resolve) => {
        deferreds.set(task.id, () => {
          active -= 1;
          resolve({ sessionId: `s_${task.id}`, summary: `Result of ${task.id}` });
        });
      });
    }) as any;

    const tasks = [
      makeTask({ id: "t1" }),
      makeTask({ id: "t2" }),
      makeTask({ id: "t3" }),
    ];
    const run = makeRun(tasks);

    const dagExecutor = new DAGExecutor(mockTaskExecutor, "/test", 2);
    const executionPromise = dagExecutor.executeReadyTasks(run);
    await Promise.resolve();

    expect(mockTaskExecutor.execute).toHaveBeenCalledTimes(2);

    deferreds.get("t1")?.();
    deferreds.get("t2")?.();
    await thirdTaskStartedPromise;

    expect(mockTaskExecutor.execute).toHaveBeenCalledTimes(3);

    deferreds.get("t3")?.();
    await executionPromise;

    expect(maxActive).toBe(2);
    expect(tasks.every((task) => task.status === "completed")).toBe(true);
  });
});

describe("DAGExecutor static helpers", () => {
  it("isComplete returns true when all tasks are terminal", () => {
    const tasks: TaskNode[] = [
      makeTask({ id: "t1", status: "completed" } as any),
      makeTask({ id: "t2", status: "failed" } as any),
      makeTask({ id: "t3", status: "blocked" } as any),
    ];
    expect(DAGExecutor.isComplete(tasks)).toBe(true);
  });

  it("isComplete returns false when tasks are pending", () => {
    const tasks: TaskNode[] = [
      makeTask({ id: "t1", status: "completed" } as any),
      makeTask({ id: "t2", status: "pending" } as any),
    ];
    expect(DAGExecutor.isComplete(tasks)).toBe(false);
  });

  it("isAllSuccessful returns true when all completed", () => {
    const tasks: TaskNode[] = [
      makeTask({ id: "t1", status: "completed" } as any),
      makeTask({ id: "t2", status: "completed" } as any),
    ];
    expect(DAGExecutor.isAllSuccessful(tasks)).toBe(true);
  });

  it("isAllSuccessful returns false when any failed", () => {
    const tasks: TaskNode[] = [
      makeTask({ id: "t1", status: "completed" } as any),
      makeTask({ id: "t2", status: "failed" } as any),
    ];
    expect(DAGExecutor.isAllSuccessful(tasks)).toBe(false);
  });
});
