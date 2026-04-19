import { describe, it, expect, vi } from "vitest";

vi.mock("../../../../../electron/main/services/agent-team/logger", () => ({
  agentTeamLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { LightBrainOrchestrator } from "../../../../../electron/main/services/agent-team/light-brain";
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

function makeRun(overrides: Partial<TeamRun> = {}): TeamRun {
  return {
    id: "team-run",
    parentSessionId: "parent-session",
    directory: "/repo",
    originalPrompt: "Do the work",
    mode: "light",
    status: "planning",
    tasks: [],
    time: { created: 1_000 },
    ...overrides,
  };
}

describe("LightBrainOrchestrator", () => {
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
    expect(teamRun.tasks[0].worktreeId).toBe("feature-branch");
    expect(engineManager.createSession).toHaveBeenNthCalledWith(2, "opencode", "/repo", "feature-branch");
  });
});
