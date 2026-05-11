import { describe, it, expect, vi } from "vitest";

vi.mock("../../../../../electron/main/services/orchestration/logger", () => ({
  orchestrationLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { LightBrainOrchestrator } from "../../../../../electron/main/services/orchestration/light-brain";
import type { OrchestrationRun, UnifiedMessage } from "../../../../../src/types/unified";

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

function makeRun(overrides: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return {
    id: "team-run",
    parentSessionId: "parent-session",
    directory: "/repo",
    prompt: "Do the work",
    mode: "light",
    status: "decomposing",
    subtasks: [],
    time: { created: 1_000 },
    ...overrides,
  };
}

describe("LightBrainOrchestrator", () => {
  it("keeps worktree team runs inside the parent project worktree context", async () => {
    const engineManager = {
      getDefaultEngineType: vi.fn(() => "opencode"),
      listEngines: vi.fn(() => [{
        type: "opencode",
        name: "OpenCode",
        status: "running",
      }]),
      createSession: vi.fn()
        .mockResolvedValueOnce({ id: "planner-session" })
        .mockResolvedValueOnce({ id: "worker-session" }),
      sendMessage: vi.fn(async (sessionId: string) => {
        if (sessionId === "planner-session") {
          return makeTextMessage(`\`\`\`json
{
  "tasks": [
    {
      "id": "t1",
      "description": "Edit isolated files",
      "prompt": "Apply the requested change",
      "dependsOn": []
    }
  ]
}
\`\`\``);
        }

        if (sessionId === "worker-session") {
          return makeTextMessage("worker done");
        }

        throw new Error(`Unexpected session ${sessionId}`);
      }),
      cancelMessage: vi.fn(async () => {}),
    } as any;

    const orchestrator = new LightBrainOrchestrator(engineManager, new Set());
    const teamRun = makeRun({
      directory: "/repo/.worktrees/feature-branch",
      parentDirectory: "/repo",
      worktreeId: "feature-branch",
    });

    await orchestrator.run(teamRun, () => {}, "opencode");

    expect(teamRun.status).toBe("completed");
    expect(teamRun.subtasks[0].worktreeId).toBe("feature-branch");
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

  it("passes planner-provided worktreeId to worker sessions", async () => {
    const engineManager = {
      getDefaultEngineType: vi.fn(() => "opencode"),
      listEngines: vi.fn(() => [{
        type: "opencode",
        name: "OpenCode",
        status: "running",
      }]),
      createSession: vi.fn()
        .mockResolvedValueOnce({ id: "planner-session" })
        .mockResolvedValueOnce({ id: "worker-session" }),
      sendMessage: vi.fn(async (sessionId: string) => {
        if (sessionId === "planner-session") {
          return makeTextMessage(`\`\`\`json
{
  "tasks": [
    {
      "id": "t1",
      "description": "Edit isolated files",
      "prompt": "Apply the requested change",
      "dependsOn": [],
      "worktreeId": "feature-branch"
    }
  ]
}
\`\`\``);
        }

        if (sessionId === "worker-session") {
          return makeTextMessage("worker done");
        }

        throw new Error(`Unexpected session ${sessionId}`);
      }),
      cancelMessage: vi.fn(async () => {}),
    } as any;

    const orchestrator = new LightBrainOrchestrator(engineManager, new Set());
    const teamRun = makeRun();

    await orchestrator.run(teamRun, () => {}, "opencode");

    expect(teamRun.status).toBe("completed");
    expect(teamRun.subtasks[0].worktreeId).toBe("feature-branch");
    expect(engineManager.createSession).toHaveBeenNthCalledWith(2, "opencode", "/repo", "feature-branch");
  });

  it("pauses in awaiting-confirmation when requirePlanConfirmation is set, then resumes with user-edited tasks", async () => {
    const engineManager = {
      getDefaultEngineType: vi.fn(() => "opencode"),
      listEngines: vi.fn(() => [{ type: "opencode", name: "OpenCode", status: "running" }]),
      createSession: vi.fn()
        .mockResolvedValueOnce({ id: "planner-session" })
        .mockResolvedValueOnce({ id: "worker-session" }),
      sendMessage: vi.fn(async (sessionId: string) => {
        if (sessionId === "planner-session") {
          return makeTextMessage(`\`\`\`json
{
  "tasks": [
    { "id": "t1", "description": "Auto plan", "prompt": "auto", "dependsOn": [] }
  ]
}
\`\`\``);
        }
        return makeTextMessage("worker done");
      }),
      cancelMessage: vi.fn(async () => {}),
    } as any;

    const statuses: string[] = [];
    const awaitPlanConfirmation = vi.fn(async (_runId: string) => {
      // Snapshot the team run status while paused
      statuses.push(teamRun.status);
      return [
        {
          id: "t-user-1",
          description: "User-edited task",
          prompt: "Do edited work",
          dependsOn: [],
          status: "pending" as const,
        },
      ];
    });

    const orchestrator = new LightBrainOrchestrator(
      engineManager,
      new Set(),
      undefined,
      awaitPlanConfirmation,
    );
    const teamRun = makeRun({ requirePlanConfirmation: true });

    await orchestrator.run(teamRun, () => {}, "opencode");

    expect(awaitPlanConfirmation).toHaveBeenCalledWith("team-run");
    expect(statuses[0]).toBe("confirming");
    expect(teamRun.status).toBe("completed");
    expect(teamRun.subtasks).toHaveLength(1);
    expect(teamRun.subtasks[0].id).toBe("t-user-1");
    expect(teamRun.subtasks[0].description).toBe("User-edited task");
  });

  it("marks run failed cleanly if plan confirmation is rejected (e.g. run cancelled)", async () => {
    const engineManager = {
      getDefaultEngineType: vi.fn(() => "opencode"),
      listEngines: vi.fn(() => [{ type: "opencode", name: "OpenCode", status: "running" }]),
      createSession: vi.fn().mockResolvedValueOnce({ id: "planner-session" }),
      sendMessage: vi.fn(async () => makeTextMessage(`\`\`\`json
{
  "tasks": [{ "id": "t1", "description": "x", "prompt": "y", "dependsOn": [] }]
}
\`\`\``)),
      cancelMessage: vi.fn(async () => {}),
    } as any;

    const awaitPlanConfirmation = vi.fn(() => Promise.reject(new Error("Run cancelled")));

    const orchestrator = new LightBrainOrchestrator(
      engineManager,
      new Set(),
      undefined,
      awaitPlanConfirmation,
    );
    const teamRun = makeRun({ requirePlanConfirmation: true });

    await orchestrator.run(teamRun, () => {}, "opencode");

    expect(teamRun.status).toBe("failed");
    expect(teamRun.resultSummary).toContain("Plan confirmation failed");
    expect(teamRun.time.completed).toBeDefined();
    // Worker session was never created
    expect(engineManager.createSession).toHaveBeenCalledTimes(1);
  });
});
