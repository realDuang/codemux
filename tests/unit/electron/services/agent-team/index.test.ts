import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(),
  },
}));

vi.mock("../../../../../electron/main/services/agent-team/logger", () => ({
  agentTeamLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { app } from "electron";
import { AgentTeamService } from "../../../../../electron/main/services/agent-team";
import type { EngineType, TaskNode, TeamRun, UnifiedMessage } from "../../../../../src/types/unified";

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

function makeTask(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: "task-a",
    description: "Task A",
    prompt: "Run A",
    dependsOn: [],
    status: "pending",
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

function createEngineManagerMock(defaultEngineType: EngineType = "opencode") {
  const emitter = new EventEmitter();
  const sessionIds = ["planner-session", "worker-session", "extra-session"];

  return {
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      emitter.on(event, handler);
    }),
    off: vi.fn(),
    replyPermission: vi.fn(),
    getDefaultEngineType: vi.fn(() => defaultEngineType),
    listEngines: vi.fn(() => [
      { type: "opencode", name: "OpenCode", status: "running" },
      { type: "claude", name: "Claude", status: "running" },
      { type: "copilot", name: "Copilot", status: "running" },
    ]),
    createSession: vi.fn(async () => ({ id: sessionIds.shift() ?? "session-fallback" })),
    sendMessage: vi.fn(async (sessionId: string) => {
      if (sessionId === "planner-session") {
        return makeJsonMessage({
          tasks: [
            { id: "A", description: "Task A", prompt: "Run A", dependsOn: [] },
          ],
        });
      }

      if (sessionId === "worker-session") {
        return makeTextMessage("A result");
      }

      throw new Error(`Unexpected session ${sessionId}`);
    }),
    cancelMessage: vi.fn(async () => {}),
  } as any;
}

let tmpDir: string;
const services: AgentTeamService[] = [];

function createService(): AgentTeamService {
  const service = new AgentTeamService();
  services.push(service);
  return service;
}

describe("AgentTeamService", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-service-"));
    vi.mocked(app.getPath).mockReturnValue(tmpDir);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const service of services.splice(0)) {
      await service.shutdown();
    }

    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe("light planner engine", () => {
    it.each([
      { requested: "claude" as EngineType, expected: "claude" as EngineType },
      { requested: undefined, expected: "opencode" as EngineType },
    ])("uses $expected for the planning session", async ({ requested, expected }) => {
      const engineManager = createEngineManagerMock("opencode");
      const service = createService();
      const run = makeRun();

      service.init(engineManager);

      await (service as any).executeRun(run, requested);

      expect(engineManager.createSession).toHaveBeenNthCalledWith(
        1,
        expected,
        "/repo",
        undefined,
        expect.objectContaining({
          systemPrompt: expect.any(String),
        }),
      );
      expect(run.status).toBe("completed");
      expect(run.tasks.map((task) => `${task.id}:${task.status}`)).toEqual([
        "A:completed",
      ]);
    });

    it("rejects incomplete worktree team-run context", async () => {
      const service = createService();
      service.init(createEngineManagerMock("opencode"));

      await expect(service.createRun({
        sessionId: "parent-session",
        prompt: "Do the work",
        mode: "light",
        directory: "/repo/.worktrees/feature-branch",
        worktreeId: "feature-branch",
      } as any)).rejects.toThrow(
        "Team runs started from worktree sessions must include both worktreeId and parentDirectory.",
      );
    });
  });

  describe("relay contract", () => {
    it("relays messages to active Heavy Brain runs", () => {
      const service = createService();
      const run = makeRun({
        id: "heavy-run",
        mode: "heavy",
        status: "running",
      });
      const channel = { send: vi.fn() };

      (service as any).runs.set(run.id, run);
      (service as any).activeRelayChannels.set(run.id, channel);

      service.sendMessageToRun(run.id, "Need a tighter plan");

      expect(channel.send).toHaveBeenCalledWith("Need a tighter plan");
    });

    it("rejects relay messages for Light Brain runs with a mode-specific error", () => {
      const service = createService();
      const run = makeRun({
        id: "light-run",
        mode: "light",
        status: "running",
      });

      (service as any).runs.set(run.id, run);

      expect(() => service.sendMessageToRun(run.id, "Can you revise the plan?")).toThrow(
        "Relay messaging is only supported for active Heavy Brain runs.",
      );
    });
  });

  describe("lifecycle hardening", () => {
    it("loads persisted runs and marks in-progress work as interrupted", () => {
      const filePath = path.join(tmpDir, "agent-team-runs.json");
      const persistedRunningRun = makeRun({
        id: "persisted-running",
        mode: "heavy",
        status: "running",
        orchestratorSessionId: "orch-session",
        tasks: [
          makeTask({
            id: "A",
            status: "completed",
            result: "done",
            time: { started: 10, completed: 20 },
          }),
          makeTask({
            id: "B",
            description: "Task B",
            prompt: "Run B",
            dependsOn: ["A"],
            status: "running",
            time: { started: 30 },
          }),
          makeTask({
            id: "C",
            description: "Task C",
            prompt: "Run C",
            dependsOn: ["B"],
            status: "pending",
          }),
        ],
      });
      const persistedCompletedRun = makeRun({
        id: "persisted-complete",
        status: "completed",
        finalResult: "done",
        time: { created: 500, completed: 700 },
      });

      fs.writeFileSync(filePath, JSON.stringify({
        version: 1,
        runs: [persistedRunningRun, persistedCompletedRun],
      }, null, 2), "utf-8");

      const service = createService();
      service.init(createEngineManagerMock());

      const recoveredRun = service.getRun("persisted-running");
      expect(recoveredRun?.status).toBe("failed");
      expect(recoveredRun?.finalResult).toContain("interrupted because CodeMux restarted");
      expect(recoveredRun?.time.completed).toBeDefined();
      expect(recoveredRun?.tasks.map((task) => `${task.id}:${task.status}`)).toEqual([
        "A:completed",
        "B:cancelled",
        "C:cancelled",
      ]);

      const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const savedRecovered = saved.runs.find((run: TeamRun) => run.id === "persisted-running");
      expect(savedRecovered.status).toBe("failed");
      expect(savedRecovered.tasks.map((task: TaskNode) => task.status)).toEqual([
        "completed",
        "cancelled",
        "cancelled",
      ]);
    });

    it("cleans up run-scoped auto-approve sessions and persists run snapshots", async () => {
      vi.useFakeTimers();

      const service = createService();
      const engineManager = createEngineManagerMock();
      const run = makeRun({ id: "light-run", mode: "light" });
      const filePath = path.join(tmpDir, "agent-team-runs.json");

      service.init(engineManager);
      (service as any).runs.set(run.id, run);

      await (service as any).executeRun(run, "opencode");
      await vi.runAllTimersAsync();

      expect(run.status).toBe("completed");
      expect((service as any).autoApproveSessions.size).toBe(0);
      expect((service as any).autoApproveSessionsByRun.size).toBe(0);
      expect((service as any).activeOrchestrators.size).toBe(0);
      expect((service as any).activeRelayChannels.size).toBe(0);
      expect(fs.existsSync(filePath)).toBe(true);

      const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(saved.runs.some((savedRun: TeamRun) => savedRun.id === "light-run")).toBe(true);
    });
  });

  describe("role mappings", () => {
    it("returns DEFAULT_ROLE_MAPPINGS when nothing is persisted", () => {
      const service = createService();
      const mappings = service.getRoleMappings();
      expect(mappings.length).toBeGreaterThanOrEqual(5);
      expect(mappings.map((m) => m.role)).toEqual(
        expect.arrayContaining(["explorer", "researcher", "reviewer", "designer", "coder"]),
      );
    });

    it("persists role mapping updates to settings.json and reloads them", () => {
      const service = createService();
      const updated = [
        { role: "coder" as const, label: "Coder", description: "code", engineType: "copilot" as EngineType, modelId: "gpt-5" },
      ];
      service.updateRoleMappings(updated);
      const settingsFile = path.join(tmpDir, "settings.json");
      expect(fs.existsSync(settingsFile)).toBe(true);
      const raw = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
      expect(raw["team.roleMappings"]).toEqual(updated);

      const reloaded = service.getRoleMappings();
      expect(reloaded).toEqual(updated);
    });

    it("resolveRole returns mapped engine+model for known role, fallback for unknown", () => {
      const service = createService();
      service.updateRoleMappings([
        { role: "coder" as const, label: "C", description: "d", engineType: "claude" as EngineType, modelId: "sonnet-4" },
      ]);
      expect(service.resolveRole("coder", "opencode")).toEqual({ engineType: "claude", modelId: "sonnet-4" });
      // unknown role → falls back to provided default
      expect(service.resolveRole("explorer", "opencode")).toEqual({ engineType: "opencode" });
    });
  });

  describe("plan confirmation gate", () => {
    it("awaitPlanConfirmation resolves when confirmPlan is called with tasks", async () => {
      const service = createService();
      const gate = service.awaitPlanConfirmation("run-abc");
      const tasks = [
        { id: "t1", description: "x", prompt: "y", dependsOn: [], status: "pending" as const },
      ];
      service.confirmPlan("run-abc", tasks);
      await expect(gate).resolves.toEqual(tasks);
    });

    it("confirmPlan throws when no pending gate exists", () => {
      const service = createService();
      expect(() => service.confirmPlan("nonexistent-run", [])).toThrow(/No pending plan confirmation/);
    });
  });
});
