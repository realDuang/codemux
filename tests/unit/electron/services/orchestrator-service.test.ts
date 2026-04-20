import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { OrchestrationSubtask, RoleEngineMapping } from "../../../../src/types/unified";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockExistsSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockRenameSync,
  mockGetPath,
  mockOrchLog,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => false),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockRenameSync: vi.fn(),
  mockGetPath: vi.fn(() => "/tmp/test-orch-userData"),
  mockOrchLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: { getPath: mockGetPath, isPackaged: false, on: vi.fn() },
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    renameSync: mockRenameSync,
  },
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  renameSync: mockRenameSync,
}));

vi.mock("electron-log/main", () => ({
  default: { scope: vi.fn(() => mockOrchLog) },
}));

// Stub conversation-store import (used in fallbacks)
vi.mock("../../../../electron/main/services/conversation-store", () => ({
  conversationStore: {
    listMessages: vi.fn(async () => []),
  },
}));

// ---------------------------------------------------------------------------
// Mock EngineManager
// ---------------------------------------------------------------------------

class MockEngineManager extends EventEmitter {
  createSession = vi.fn(async (engineType: string, _dir: string, worktreeName?: string) => ({
    id: `sess_${engineType}_${worktreeName ?? "default"}_${Math.random().toString(36).slice(2, 6)}`,
  }));
  sendMessage = vi.fn(async () => ({
    parts: [{ type: "text", text: "default mock reply" }],
  }));
  cancelMessage = vi.fn(async () => undefined);
  replyPermission = vi.fn();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function freshService() {
  vi.resetModules();
  const mod = await import("../../../../electron/main/services/orchestrator-service");
  // Accumulated listeners across tests trip the default 10-listener warning;
  // raise the cap since we re-import in every test.
  mod.orchestratorService.setMaxListeners(100);
  return mod.orchestratorService;
}

function makeSubtask(overrides: Partial<OrchestrationSubtask> = {}): OrchestrationSubtask {
  return {
    id: "t1",
    description: "do thing",
    engineType: "claude",
    dependsOn: [],
    needsWorktree: false,
    status: "blocked",
    ...overrides,
  };
}

const ROLES: RoleEngineMapping[] = [
  { role: "explorer", label: "x", description: "search", engineType: "copilot", readOnly: true },
  { role: "coder", label: "c", description: "write", engineType: "codex" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OrchestratorService", () => {
  describe("createRun", () => {
    it("creates a run with the expected metadata and emits update", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      svc.init(em as any);
      const updates: any[] = [];
      svc.on("orchestration.updated", (data) => updates.push(data));

      const run = svc.createRun(
        "sess_p",
        "/tmp/work",
        "build me a thing",
        ["claude", "codex"],
        ROLES,
        { name: "team-abc", directory: "/tmp/team-abc" },
      );

      expect(run.id).toMatch(/^orch_[a-z0-9]+_[a-z0-9]+$/);
      expect(run.parentSessionId).toBe("sess_p");
      expect(run.status).toBe("setup");
      expect(run.teamWorktreeName).toBe("team-abc");
      expect(run.teamWorktreeDir).toBe("/tmp/team-abc");
      expect(run.engineTypes).toEqual(["claude", "codex"]);
      expect(updates.length).toBeGreaterThan(0);
      expect(updates[0].run.id).toBe(run.id);
    });

    it("createRun with no worktreeInfo leaves worktree fields undefined", async () => {
      const svc = await freshService();
      svc.init(new MockEngineManager() as any);
      const run = svc.createRun("sp", "/tmp", "p", ["claude"]);
      expect(run.teamWorktreeName).toBeUndefined();
      expect(run.teamWorktreeDir).toBeUndefined();
    });

    it("listRuns returns all created runs", async () => {
      const svc = await freshService();
      svc.init(new MockEngineManager() as any);
      const r1 = svc.createRun("s1", "/tmp", "a", ["claude"]);
      const r2 = svc.createRun("s2", "/tmp", "b", ["claude"]);
      const ids = svc.listRuns().map((r) => r.id);
      expect(ids).toContain(r1.id);
      expect(ids).toContain(r2.id);
    });
  });

  describe("decomposeTask", () => {
    it("parses the LLM response and transitions to confirming", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      em.sendMessage.mockResolvedValueOnce({
        parts: [
          {
            type: "text",
            text: '[{"id":"a","description":"analyze","role":"explorer","dependsOn":[],"needsWorktree":false}]',
          },
        ],
      });
      svc.init(em as any);
      const run = svc.createRun("sp", "/tmp", "task", ["claude", "copilot"], ROLES);

      const subtasks = await svc.decomposeTask(run.id);
      expect(subtasks).toHaveLength(1);
      expect(subtasks[0].id).toBe("a");
      expect(subtasks[0].role).toBe("explorer");
      // Engine should be auto-resolved from role mapping → copilot
      expect(subtasks[0].engineType).toBe("copilot");
      expect(svc.listRuns().find((r) => r.id === run.id)!.status).toBe("confirming");
    });

    it("strips markdown fences from the LLM response", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      em.sendMessage.mockResolvedValueOnce({
        parts: [
          {
            type: "text",
            text: '```json\n[{"id":"x","description":"d","dependsOn":[]}]\n```',
          },
        ],
      });
      svc.init(em as any);
      const run = svc.createRun("sp", "/tmp", "task", ["claude"]);
      const subtasks = await svc.decomposeTask(run.id);
      expect(subtasks).toHaveLength(1);
      expect(subtasks[0].id).toBe("x");
    });

    it("falls back to a single-subtask wrapper when JSON cannot be parsed", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      em.sendMessage.mockResolvedValueOnce({
        parts: [{ type: "text", text: "I can't be parsed as JSON" }],
      });
      svc.init(em as any);
      const run = svc.createRun("sp", "/tmp", "t", ["claude"]);
      const subtasks = await svc.decomposeTask(run.id);
      expect(subtasks).toHaveLength(1);
      expect(subtasks[0].id).toBe("main");
      expect(subtasks[0].engineType).toBe("claude");
    });

    it("falls back to first available engine when LLM names an unknown engine", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      em.sendMessage.mockResolvedValueOnce({
        parts: [
          {
            type: "text",
            text: '[{"id":"a","description":"d","engineType":"made-up","dependsOn":[]}]',
          },
        ],
      });
      svc.init(em as any);
      const run = svc.createRun("sp", "/tmp", "t", ["claude", "codex"]);
      const subtasks = await svc.decomposeTask(run.id);
      expect(subtasks[0].engineType).toBe("claude");
    });

    it("marks the run as failed when sendMessage throws", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      em.sendMessage.mockRejectedValueOnce(new Error("boom"));
      svc.init(em as any);
      const run = svc.createRun("sp", "/tmp", "t", ["claude"]);
      await expect(svc.decomposeTask(run.id)).rejects.toThrow("boom");
      expect(svc.listRuns().find((r) => r.id === run.id)!.status).toBe("failed");
    });

    it("falls back to readLastAssistantMessage when sendMessage returns no parts", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      em.sendMessage.mockResolvedValueOnce({} as any);
      const { conversationStore } = await import(
        "../../../../electron/main/services/conversation-store"
      );
      vi.mocked(conversationStore.listMessages).mockResolvedValueOnce([
        {
          role: "assistant",
          parts: [{ type: "text", text: '[{"id":"q","description":"d","dependsOn":[]}]' }],
        } as any,
      ]);
      svc.init(em as any);
      const run = svc.createRun("sp", "/tmp", "t", ["claude"]);
      const subtasks = await svc.decomposeTask(run.id);
      expect(subtasks[0].id).toBe("q");
    });

    it("throws when run is not found", async () => {
      const svc = await freshService();
      svc.init(new MockEngineManager() as any);
      await expect(svc.decomposeTask("missing")).rejects.toThrow(/not found/);
    });
  });

  describe("confirmAndExecute (DAG)", () => {
    it("runs independent subtasks in parallel and aggregates results", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();

      // Each task gets its own response; aggregator call also goes through sendMessage
      em.sendMessage.mockImplementation(async (sessionId: string) => {
        if (sessionId.startsWith("sess_p")) {
          return { parts: [{ type: "text", text: "agg ok" }] };
        }
        return { parts: [{ type: "text", text: `result for ${sessionId}` }] };
      });

      svc.init(em as any);
      const run = svc.createRun("sess_p", "/tmp/work", "x", ["claude"], undefined, {
        name: "team-x",
        directory: "/tmp/team-x",
      });

      await svc.confirmAndExecute(run.id, [
        makeSubtask({ id: "a", dependsOn: [] }),
        makeSubtask({ id: "b", dependsOn: [] }),
      ]);

      const final = svc.listRuns().find((r) => r.id === run.id)!;
      expect(final.status).toBe("completed");
      expect(final.subtasks.every((t) => t.status === "completed")).toBe(true);
      expect(final.resultSummary).toContain("do thing");
      // createSession should be called with the team worktree name for child sessions
      const childCalls = em.createSession.mock.calls.filter((c) => c[0] !== undefined);
      expect(childCalls.some((c) => c[2] === "team-x")).toBe(true);
      // Aggregator should send to the parent session
      expect(em.sendMessage).toHaveBeenCalledWith(
        "sess_p",
        expect.arrayContaining([expect.objectContaining({ type: "text" })]),
      );
    });

    it("respects dependsOn ordering — dependent task runs after its prerequisite", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      const sendOrder: string[] = [];
      em.sendMessage.mockImplementation(async (sessionId: string) => {
        sendOrder.push(sessionId);
        return { parts: [{ type: "text", text: "ok" }] };
      });
      svc.init(em as any);
      const run = svc.createRun("sp", "/tmp", "x", ["claude"]);
      await svc.confirmAndExecute(run.id, [
        makeSubtask({ id: "first", description: "first", dependsOn: [] }),
        makeSubtask({ id: "second", description: "second", dependsOn: ["first"] }),
      ]);

      const final = svc.listRuns().find((r) => r.id === run.id)!;
      expect(final.subtasks.find((t) => t.id === "first")!.status).toBe("completed");
      expect(final.subtasks.find((t) => t.id === "second")!.status).toBe("completed");

      // The second send (for the dependent task) should include "first"'s result
      // in the prompt as upstream context.
      const dependentCall = em.sendMessage.mock.calls.find((call) => {
        const text = call[1]?.[0]?.text || "";
        return text.includes("Upstream Task Results") && text.includes("first");
      });
      expect(dependentCall).toBeTruthy();
    });

    it("uses teamWorktreeDir as cwd when no worktree name is set", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      em.sendMessage.mockResolvedValue({ parts: [{ type: "text", text: "r" }] });
      svc.init(em as any);
      const run = svc.createRun("sp", "/tmp/orig", "x", ["claude"]);
      // Force teamWorktreeDir without a name to take the second branch
      const stored = svc.listRuns().find((r) => r.id === run.id)!;
      (stored as any).teamWorktreeDir = "/tmp/wt-only";

      await svc.confirmAndExecute(run.id, [makeSubtask({ id: "only" })]);
      // First createSession call after init may have been from decomposeTask path —
      // here we only invoke confirmAndExecute, so it's the dispatch call.
      expect(em.createSession).toHaveBeenCalledWith("claude", "/tmp/wt-only");
    });

    it("marks dispatch failure as a failed subtask without crashing the DAG", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      em.createSession.mockRejectedValueOnce(new Error("create failed"));
      svc.init(em as any);
      const run = svc.createRun("sp", "/tmp", "x", ["claude"]);
      await svc.confirmAndExecute(run.id, [makeSubtask({ id: "boom" })]);

      const final = svc.listRuns().find((r) => r.id === run.id)!;
      expect(final.subtasks[0].status).toBe("failed");
      expect(final.subtasks[0].error).toBe("create failed");
      expect(final.status).toBe("failed");
    });

    it("truncates very long result summaries to 2000+ chars", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      const longText = "a".repeat(5000);
      em.sendMessage.mockResolvedValue({ parts: [{ type: "text", text: longText }] });
      svc.init(em as any);
      const run = svc.createRun("sp", "/tmp", "x", ["claude"]);
      await svc.confirmAndExecute(run.id, [makeSubtask({ id: "long" })]);

      const final = svc.listRuns().find((r) => r.id === run.id)!;
      const summary = final.subtasks[0].resultSummary || "";
      expect(summary.length).toBe(2000 + "...".length);
      expect(summary.endsWith("...")).toBe(true);
    });
  });

  describe("cancelRun", () => {
    it("cancels running, blocked, and pending subtasks", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      svc.init(em as any);
      const run = svc.createRun("sp", "/tmp", "x", ["claude"]);
      // Manually populate subtasks in different states
      run.subtasks = [
        { ...makeSubtask({ id: "a" }), status: "running", sessionId: "sess_a" },
        { ...makeSubtask({ id: "b" }), status: "blocked" },
        { ...makeSubtask({ id: "c" }), status: "pending" },
        { ...makeSubtask({ id: "d" }), status: "completed" },
      ];
      // Persist mutation back
      (svc as any).activeRuns.set(run.id, run);

      await svc.cancelRun(run.id);
      const final = svc.listRuns().find((r) => r.id === run.id)!;
      expect(em.cancelMessage).toHaveBeenCalledWith("sess_a");
      expect(final.subtasks.find((t) => t.id === "a")!.status).toBe("failed");
      expect(final.subtasks.find((t) => t.id === "b")!.status).toBe("failed");
      expect(final.subtasks.find((t) => t.id === "c")!.status).toBe("failed");
      expect(final.subtasks.find((t) => t.id === "d")!.status).toBe("completed");
      expect(final.status).toBe("cancelled");
    });

    it("ignores cancelMessage errors", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      em.cancelMessage.mockRejectedValueOnce(new Error("nope"));
      svc.init(em as any);
      const run = svc.createRun("sp", "/tmp", "x", ["claude"]);
      run.subtasks = [{ ...makeSubtask({ id: "a" }), status: "running", sessionId: "s" }];
      (svc as any).activeRuns.set(run.id, run);
      await expect(svc.cancelRun(run.id)).resolves.toBeUndefined();
      const final = svc.listRuns().find((r) => r.id === run.id)!;
      expect(final.status).toBe("cancelled");
    });
  });

  describe("shutdown", () => {
    it("cancels in-flight runs", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      svc.init(em as any);
      const r1 = svc.createRun("p1", "/tmp", "x", ["claude"]);
      const r2 = svc.createRun("p2", "/tmp", "x", ["claude"]);
      // Mark one as running, the other as completed
      const stored1 = svc.listRuns().find((r) => r.id === r1.id)!;
      const stored2 = svc.listRuns().find((r) => r.id === r2.id)!;
      stored1.status = "running";
      stored2.status = "completed";

      await svc.shutdown();
      expect(svc.listRuns().find((r) => r.id === r1.id)!.status).toBe("cancelled");
      expect(svc.listRuns().find((r) => r.id === r2.id)!.status).toBe("completed");
    });
  });

  describe("permission auto-approve", () => {
    it("auto-approves accept-typed permission options for orchestrated sessions", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      // Hold sendMessage so the subtask stays "running" while we fire the
      // permission event — auto-approval is now scoped to a run's lifetime
      // and is revoked once the run reaches a terminal state.
      let releaseSend: (v: any) => void = () => {};
      em.sendMessage.mockReturnValue(
        new Promise((resolve) => {
          releaseSend = resolve;
        }),
      );
      svc.init(em as any);
      const run = svc.createRun("sp", "/tmp", "x", ["claude"]);
      const execPromise = svc.confirmAndExecute(run.id, [makeSubtask({ id: "a" })]);

      // Wait until createSession resolves so we have a child sessionId
      const childSession = await em.createSession.mock.results[0].value;
      const sessionId = childSession.id;
      // Yield to let dispatchSubtask reach the in-flight sendMessage call
      await new Promise((r) => setTimeout(r, 0));

      em.emit("permission.asked", {
        permission: {
          id: "perm_1",
          sessionId,
          options: [
            { id: "deny_opt", type: "deny" },
            { id: "ok_opt", type: "accept_once" },
          ],
        },
      });
      expect(em.replyPermission).toHaveBeenCalledWith("perm_1", { optionId: "ok_opt" });

      releaseSend({ parts: [{ type: "text", text: "ok" }] });
      await execPromise;
    });

    it("revokes auto-approval after the run reaches a terminal state", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      em.sendMessage.mockResolvedValue({ parts: [{ type: "text", text: "ok" }] });
      svc.init(em as any);
      const run = svc.createRun("sp", "/tmp", "x", ["claude"]);
      await svc.confirmAndExecute(run.id, [makeSubtask({ id: "a" })]);

      const childSession = await em.createSession.mock.results[0].value;
      em.emit("permission.asked", {
        permission: {
          id: "perm_late",
          sessionId: childSession.id,
          options: [{ id: "ok", type: "accept" }],
        },
      });
      expect(em.replyPermission).not.toHaveBeenCalled();
    });

    it("ignores permission events for unknown sessions", async () => {
      const svc = await freshService();
      const em = new MockEngineManager();
      svc.init(em as any);
      em.emit("permission.asked", {
        permission: { id: "p", sessionId: "stranger", options: [{ id: "ok", type: "accept" }] },
      });
      expect(em.replyPermission).not.toHaveBeenCalled();
    });
  });

  describe("disk persistence", () => {
    it("atomically writes runs (.tmp + rename) to userData orchestrations.json after debounce", async () => {
      const svc = await freshService();
      svc.init(new MockEngineManager() as any);
      svc.createRun("sp", "/tmp", "x", ["claude"]);
      // saveToDisk is debounced (~200ms); flush by shutting down
      await svc.shutdown();
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/orchestrations\.json\.tmp$/),
        expect.any(String),
        "utf-8",
      );
      expect(mockRenameSync).toHaveBeenCalledWith(
        expect.stringMatching(/orchestrations\.json\.tmp$/),
        expect.stringMatching(/orchestrations\.json$/),
      );
    });

    it("loads previously-persisted runs and marks in-flight runs as failed", async () => {
      const persisted = [
        {
          id: "orch_old",
          parentSessionId: "sp",
          directory: "/tmp",
          status: "running",
          prompt: "x",
          engineTypes: ["claude"],
          subtasks: [
            { id: "a", description: "", engineType: "claude", dependsOn: [], needsWorktree: false, status: "running" },
            { id: "b", description: "", engineType: "claude", dependsOn: [], needsWorktree: false, status: "completed" },
          ],
          createdAt: 1,
        },
      ];
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(persisted));

      const svc = await freshService();
      svc.init(new MockEngineManager() as any);

      const run = svc.listRuns().find((r) => r.id === "orch_old")!;
      expect(run).toBeTruthy();
      expect(run.status).toBe("failed");
      expect(run.completedAt).toBeTypeOf("number");
      expect(run.subtasks.find((t) => t.id === "a")!.status).toBe("failed");
      expect(run.subtasks.find((t) => t.id === "a")!.error).toBe("Interrupted by app restart");
      expect(run.subtasks.find((t) => t.id === "b")!.status).toBe("completed");
    });

    it("survives malformed disk content with a warning instead of throwing", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not json");
      const svc = await freshService();
      expect(() => svc.init(new MockEngineManager() as any)).not.toThrow();
      expect(mockOrchLog.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load orchestrations from disk"),
        expect.any(String),
      );
    });

    it("survives writeFileSync errors without throwing", async () => {
      mockWriteFileSync.mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      const svc = await freshService();
      svc.init(new MockEngineManager() as any);
      expect(() => svc.createRun("sp", "/tmp", "x", ["claude"])).not.toThrow();
      // Flush the debounced write so the error is observed
      await svc.shutdown();
      expect(mockOrchLog.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to persist orchestrations"),
        expect.any(String),
      );
    });
  });
});
