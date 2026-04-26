import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrchestrationRun, RoleEngineMapping } from "../../../../src/types/unified";

// In-memory settings backing store for save/getSetting
const settingsBacking = new Map<string, unknown>();

vi.mock("../../../../src/lib/settings", () => ({
  getSetting: vi.fn((key: string) => settingsBacking.get(key)),
  saveSetting: vi.fn((key: string, value: unknown) => {
    settingsBacking.set(key, value);
  }),
}));

// Use SolidJS's actual createStore so reactivity / nested updates work as in production
// (no need to mock — the module is environment-agnostic and works in Node).

beforeEach(() => {
  settingsBacking.clear();
  vi.resetModules();
});

function makeRun(overrides: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return {
    id: "orch_abc",
    parentSessionId: "sess_parent",
    directory: "/tmp/work",
    status: "setup",
    prompt: "do stuff",
    engineTypes: ["claude"],
    subtasks: [],
    createdAt: 1,
    ...overrides,
  };
}

describe("orchestration store", () => {
  describe("DEFAULT_ROLE_MAPPINGS", () => {
    it("includes the five canonical roles with read-only flags on review roles", async () => {
      const { DEFAULT_ROLE_MAPPINGS } = await import("../../../../src/stores/orchestration");
      const roles = DEFAULT_ROLE_MAPPINGS.map((m) => m.role);
      expect(roles).toEqual(["explorer", "researcher", "reviewer", "designer", "coder"]);
      // Read-only is set on the analysis roles only
      expect(DEFAULT_ROLE_MAPPINGS.find((m) => m.role === "explorer")!.readOnly).toBe(true);
      expect(DEFAULT_ROLE_MAPPINGS.find((m) => m.role === "researcher")!.readOnly).toBe(true);
      expect(DEFAULT_ROLE_MAPPINGS.find((m) => m.role === "reviewer")!.readOnly).toBe(true);
      expect(DEFAULT_ROLE_MAPPINGS.find((m) => m.role === "designer")!.readOnly).toBeUndefined();
      expect(DEFAULT_ROLE_MAPPINGS.find((m) => m.role === "coder")!.readOnly).toBeUndefined();
    });

    it("defaults all roles to claude when no settings are saved", async () => {
      const { DEFAULT_ROLE_MAPPINGS, getRoleMappings } = await import("../../../../src/stores/orchestration");
      const mappings = getRoleMappings();
      expect(mappings).toHaveLength(DEFAULT_ROLE_MAPPINGS.length);
      expect(mappings.every((m) => m.engineType === "claude")).toBe(true);
    });
  });

  describe("loadRoleMappings (via module load)", () => {
    it("uses persisted mappings from settings when present", async () => {
      const persisted: RoleEngineMapping[] = [
        { role: "explorer", label: "x", description: "x", engineType: "copilot", readOnly: true },
        { role: "coder", label: "c", description: "c", engineType: "codex" },
      ];
      settingsBacking.set("orchestration.roleMapping", persisted);

      const { getRoleMappings } = await import("../../../../src/stores/orchestration");
      const mappings = getRoleMappings();
      expect(mappings).toHaveLength(2);
      expect(mappings[0].engineType).toBe("copilot");
      expect(mappings[1].engineType).toBe("codex");
    });

    it("falls back to defaults when persisted value is empty array", async () => {
      settingsBacking.set("orchestration.roleMapping", []);
      const { getRoleMappings, DEFAULT_ROLE_MAPPINGS } = await import("../../../../src/stores/orchestration");
      expect(getRoleMappings()).toHaveLength(DEFAULT_ROLE_MAPPINGS.length);
    });

    it("falls back to defaults when persisted value is not an array", async () => {
      settingsBacking.set("orchestration.roleMapping", "not-an-array" as any);
      const { getRoleMappings, DEFAULT_ROLE_MAPPINGS } = await import("../../../../src/stores/orchestration");
      expect(getRoleMappings()).toHaveLength(DEFAULT_ROLE_MAPPINGS.length);
    });
  });

  describe("generateTeamId", () => {
    it("produces ids with the team_ prefix", async () => {
      const { generateTeamId } = await import("../../../../src/stores/orchestration");
      const id = generateTeamId();
      expect(id).toMatch(/^team_[a-z0-9]+_[a-z0-9]+$/);
    });

    it("produces unique ids on successive calls", async () => {
      const { generateTeamId } = await import("../../../../src/stores/orchestration");
      const a = generateTeamId();
      const b = generateTeamId();
      expect(a).not.toBe(b);
    });
  });

  describe("registerTeam / getTeamId / getTeamInfo / isTeamParentSession", () => {
    it("registers and looks up a team without worktree info", async () => {
      const { registerTeam, getTeamId, getTeamInfo, isTeamParentSession } = await import(
        "../../../../src/stores/orchestration"
      );
      registerTeam("team_1", "sess_parent");

      expect(getTeamId("sess_parent")).toBe("team_1");
      expect(getTeamInfo("team_1")).toMatchObject({ id: "team_1", parentSessionId: "sess_parent" });
      expect(getTeamInfo("team_1")?.worktreeInfo).toBeUndefined();
      expect(isTeamParentSession("sess_parent")).toBe(true);
      expect(isTeamParentSession("sess_child")).toBe(false);
    });

    it("stores worktreeInfo when provided", async () => {
      const { registerTeam, getTeamInfo } = await import("../../../../src/stores/orchestration");
      registerTeam("team_1", "sess_parent", { name: "team-abc", directory: "/tmp/team-abc" });
      expect(getTeamInfo("team_1")?.worktreeInfo).toEqual({ name: "team-abc", directory: "/tmp/team-abc" });
    });

    it("isTeamParentSession returns false when team mapping points to a different parent", async () => {
      const { registerTeam, isTeamParentSession, setOrchestrationStore } = await import(
        "../../../../src/stores/orchestration"
      );
      registerTeam("team_1", "sess_parent");
      // Manually point a child session at the same team
      setOrchestrationStore("sessionToTeam", "sess_child", "team_1");
      expect(isTeamParentSession("sess_child")).toBe(false);
    });
  });

  describe("associateRunWithTeam / getRunForTeam", () => {
    it("links a run to a team and round-trips lookup", async () => {
      const { registerTeam, associateRunWithTeam, updateRun, getRunForTeam } = await import(
        "../../../../src/stores/orchestration"
      );
      registerTeam("team_1", "sess_parent");
      const run = makeRun({ id: "orch_1", parentSessionId: "sess_parent" });
      updateRun(run);
      associateRunWithTeam("team_1", "orch_1");

      const fetched = getRunForTeam("team_1");
      expect(fetched?.id).toBe("orch_1");
    });

    it("returns undefined when team has no run", async () => {
      const { registerTeam, getRunForTeam } = await import("../../../../src/stores/orchestration");
      registerTeam("team_1", "sess_parent");
      expect(getRunForTeam("team_1")).toBeUndefined();
    });

    it("returns undefined for unknown team", async () => {
      const { getRunForTeam } = await import("../../../../src/stores/orchestration");
      expect(getRunForTeam("team_missing")).toBeUndefined();
    });
  });

  describe("updateRun", () => {
    it("stores the run and back-fills sessionToTeam for child subtasks", async () => {
      const { registerTeam, updateRun, getRun, getTeamId } = await import(
        "../../../../src/stores/orchestration"
      );
      registerTeam("team_1", "sess_parent");
      const run = makeRun({
        parentSessionId: "sess_parent",
        subtasks: [
          {
            id: "t1",
            description: "d",
            engineType: "claude",
            dependsOn: [],
            needsWorktree: false,
            status: "completed",
            sessionId: "sess_child_1",
          },
          {
            id: "t2",
            description: "d",
            engineType: "claude",
            dependsOn: [],
            needsWorktree: false,
            status: "running",
            sessionId: "sess_child_2",
          },
          {
            id: "t3",
            description: "d",
            engineType: "claude",
            dependsOn: [],
            needsWorktree: false,
            status: "blocked",
          },
        ],
      });
      updateRun(run);

      expect(getRun(run.id)).toBeTruthy();
      expect(getTeamId("sess_child_1")).toBe("team_1");
      expect(getTeamId("sess_child_2")).toBe("team_1");
      // No sessionId yet → no mapping created
      expect(getTeamId("t3")).toBeUndefined();
    });

    it("does not create child mappings when parent isn't part of any team", async () => {
      const { updateRun, getTeamId } = await import("../../../../src/stores/orchestration");
      const run = makeRun({
        parentSessionId: "sess_orphan",
        subtasks: [
          {
            id: "t1",
            description: "d",
            engineType: "claude",
            dependsOn: [],
            needsWorktree: false,
            status: "running",
            sessionId: "sess_child",
          },
        ],
      });
      updateRun(run);
      expect(getTeamId("sess_child")).toBeUndefined();
    });
  });

  describe("setCurrentRunId", () => {
    it("updates the current run id and accepts null", async () => {
      const { setCurrentRunId, orchestrationStore } = await import(
        "../../../../src/stores/orchestration"
      );
      setCurrentRunId("orch_x");
      expect(orchestrationStore.currentRunId).toBe("orch_x");
      setCurrentRunId(null);
      expect(orchestrationStore.currentRunId).toBeNull();
    });
  });

  describe("restoreFromRuns", () => {
    it("restores teams, child mappings, and worktree info from a list of runs", async () => {
      const { restoreFromRuns, getRun, getTeamId, getTeamInfo } = await import(
        "../../../../src/stores/orchestration"
      );
      const run = makeRun({
        id: "orch_xyz",
        parentSessionId: "sess_p",
        teamWorktreeName: "team-xyz",
        teamWorktreeDir: "/tmp/team-xyz",
        subtasks: [
          {
            id: "t1",
            description: "",
            engineType: "claude",
            dependsOn: [],
            needsWorktree: true,
            status: "completed",
            sessionId: "sess_c1",
          },
        ],
      });
      const result = restoreFromRuns([run]);

      expect(result.get("sess_p")).toBe("team_xyz");
      expect(result.get("sess_c1")).toBe("team_xyz");
      expect(getRun("orch_xyz")).toBeTruthy();
      expect(getTeamId("sess_p")).toBe("team_xyz");
      expect(getTeamId("sess_c1")).toBe("team_xyz");
      expect(getTeamInfo("team_xyz")?.worktreeInfo).toEqual({
        name: "team-xyz",
        directory: "/tmp/team-xyz",
      });
    });

    it("sets currentRunId for in-flight runs only", async () => {
      const { restoreFromRuns, orchestrationStore } = await import(
        "../../../../src/stores/orchestration"
      );
      restoreFromRuns([
        makeRun({ id: "orch_done", parentSessionId: "p1", status: "completed" }),
        makeRun({ id: "orch_live", parentSessionId: "p2", status: "running" }),
      ]);
      expect(orchestrationStore.currentRunId).toBe("orch_live");
    });

    it.each(["dispatching", "confirming", "decomposing", "running"] as const)(
      "treats status %s as in-flight",
      async (status) => {
        const { restoreFromRuns, orchestrationStore } = await import(
          "../../../../src/stores/orchestration"
        );
        restoreFromRuns([makeRun({ id: `orch_${status}`, parentSessionId: "p", status })]);
        expect(orchestrationStore.currentRunId).toBe(`orch_${status}`);
      },
    );

    it("omits worktreeInfo when teamWorktreeName/Dir are absent", async () => {
      const { restoreFromRuns, getTeamInfo } = await import(
        "../../../../src/stores/orchestration"
      );
      restoreFromRuns([makeRun({ id: "orch_nw", parentSessionId: "p" })]);
      expect(getTeamInfo("team_nw")?.worktreeInfo).toBeUndefined();
    });
  });

  describe("autoDetectTeams", () => {
    it("groups sessions by team-* worktreeId and uses the first as parent", async () => {
      const { autoDetectTeams, getTeamId, getTeamInfo } = await import(
        "../../../../src/stores/orchestration"
      );
      const detected = autoDetectTeams([
        { id: "sess_1", worktreeId: "team-abc" },
        { id: "sess_2", worktreeId: "team-abc" },
        { id: "sess_3", worktreeId: "team-def" },
      ]);

      expect(detected.get("sess_1")).toBe("team_abc");
      expect(detected.get("sess_2")).toBe("team_abc");
      expect(detected.get("sess_3")).toBe("team_def");
      expect(getTeamInfo("team_abc")?.parentSessionId).toBe("sess_1");
      expect(getTeamInfo("team_def")?.parentSessionId).toBe("sess_3");
      expect(getTeamId("sess_2")).toBe("team_abc");
    });

    it("ignores sessions without a team- worktreeId", async () => {
      const { autoDetectTeams, getTeamId } = await import(
        "../../../../src/stores/orchestration"
      );
      const detected = autoDetectTeams([
        { id: "sess_a" },
        { id: "sess_b", worktreeId: "wt-other" },
      ]);
      expect(detected.size).toBe(0);
      expect(getTeamId("sess_a")).toBeUndefined();
      expect(getTeamId("sess_b")).toBeUndefined();
    });

    it("does not re-register sessions that already belong to a team", async () => {
      const { registerTeam, autoDetectTeams } = await import(
        "../../../../src/stores/orchestration"
      );
      registerTeam("team_existing", "sess_known");
      const detected = autoDetectTeams([
        { id: "sess_known", worktreeId: "team-existing" },
        { id: "sess_new", worktreeId: "team-fresh" },
      ]);
      expect(detected.has("sess_known")).toBe(false);
      expect(detected.get("sess_new")).toBe("team_fresh");
    });

    it("preserves an existing team entry when its sessions reappear", async () => {
      const { registerTeam, autoDetectTeams, getTeamInfo, setOrchestrationStore } =
        await import("../../../../src/stores/orchestration");
      registerTeam("team_abc", "sess_orig");
      // Clear the parent's session→team mapping to force the worktree branch
      // to encounter the orphan session, while the team itself still exists.
      setOrchestrationStore("sessionToTeam", "sess_orig", undefined as any);
      autoDetectTeams([{ id: "sess_orig", worktreeId: "team-abc" }]);
      // Existing team entry should not be overwritten
      expect(getTeamInfo("team_abc")?.parentSessionId).toBe("sess_orig");
    });
  });

  describe("updateRoleMappings", () => {
    it("updates the store and persists to settings", async () => {
      const { updateRoleMappings, getRoleMappings } = await import(
        "../../../../src/stores/orchestration"
      );
      const next: RoleEngineMapping[] = [
        { role: "coder", label: "Coder", description: "writes code", engineType: "opencode" },
      ];
      updateRoleMappings(next);

      expect(getRoleMappings()).toEqual(next);
      expect(settingsBacking.get("orchestration.roleMapping")).toEqual(next);
    });
  });

  describe("getEngineForRole", () => {
    it("returns the engine + modelId from the configured mapping", async () => {
      const { updateRoleMappings, getEngineForRole } = await import(
        "../../../../src/stores/orchestration"
      );
      updateRoleMappings([
        { role: "explorer", label: "x", description: "x", engineType: "copilot", modelId: "gpt-4" },
      ]);
      expect(getEngineForRole("explorer")).toEqual({ engineType: "copilot", modelId: "gpt-4" });
    });

    it("falls back to DEFAULT_ROLE_MAPPINGS when role isn't in the current mapping", async () => {
      const { updateRoleMappings, getEngineForRole, DEFAULT_ROLE_MAPPINGS } = await import(
        "../../../../src/stores/orchestration"
      );
      // Mapping omits the "reviewer" role
      updateRoleMappings([
        { role: "coder", label: "c", description: "c", engineType: "codex" },
      ]);
      const expected = DEFAULT_ROLE_MAPPINGS.find((m) => m.role === "reviewer")!.engineType;
      expect(getEngineForRole("reviewer")).toEqual({ engineType: expected });
    });

    it("returns claude when role isn't in either mapping", async () => {
      const { updateRoleMappings, getEngineForRole } = await import(
        "../../../../src/stores/orchestration"
      );
      updateRoleMappings([
        { role: "coder", label: "c", description: "c", engineType: "codex" },
      ]);
      // Cast to bypass type — emulate an unknown role flowing in from settings/json
      expect(getEngineForRole("unknown" as any)).toEqual({ engineType: "claude" });
    });
  });
});
