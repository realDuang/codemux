import { createStore } from "solid-js/store";
import type { OrchestrationRun, RoleEngineMapping, OrchestratorRole, EngineType } from "../types/unified";
import { getSetting, saveSetting } from "../lib/settings";

/** Default role → engine mapping (inspired by oh-my-opencode-slim agent roles) */
export const DEFAULT_ROLE_MAPPINGS: RoleEngineMapping[] = [
  { role: "explorer", label: "Explorer", description: "Codebase search, file/symbol location, pattern matching (read-only)", engineType: "claude", readOnly: true },
  { role: "researcher", label: "Researcher", description: "Documentation research, external resources, library/API investigation (read-only)", engineType: "claude", readOnly: true },
  { role: "reviewer", label: "Reviewer", description: "Architecture analysis, code review, quality checks, strategic advice (read-only)", engineType: "claude", readOnly: true },
  { role: "designer", label: "Designer", description: "UI/UX design and implementation, frontend styling, visual components", engineType: "claude" },
  { role: "coder", label: "Coder", description: "Code implementation, refactoring, bug fixing, feature development", engineType: "claude" },
];

function loadRoleMappings(): RoleEngineMapping[] {
  const saved = getSetting<RoleEngineMapping[]>("orchestration.roleMapping");
  if (saved && Array.isArray(saved) && saved.length > 0) return saved;
  return DEFAULT_ROLE_MAPPINGS.map((m) => ({ ...m }));
}

interface TeamInfo {
  id: string;
  /** The orchestrator parent session ID */
  parentSessionId: string;
  /** Associated orchestration run ID (set after user sends prompt) */
  runId?: string;
  /** Worktree info created for this team */
  worktreeInfo?: { name: string; directory: string };
}

const [orchestrationStore, setOrchestrationStore] = createStore<{
  runs: Record<string, OrchestrationRun>;
  currentRunId: string | null;
  /** teamId → TeamInfo */
  teams: Record<string, TeamInfo>;
  /** sessionId → teamId (reverse lookup for both parent + child sessions) */
  sessionToTeam: Record<string, string>;
  /** Role → engine mapping configuration */
  roleMappings: RoleEngineMapping[];
}>({
  runs: {},
  currentRunId: null,
  teams: {},
  sessionToTeam: {},
  roleMappings: loadRoleMappings(),
});

export { orchestrationStore, setOrchestrationStore };

/** Generate a team ID */
export function generateTeamId(): string {
  return `team_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Register a new team with its parent session */
export function registerTeam(teamId: string, parentSessionId: string, worktreeInfo?: { name: string; directory: string }): void {
  setOrchestrationStore("teams", teamId, { id: teamId, parentSessionId, worktreeInfo });
  setOrchestrationStore("sessionToTeam", parentSessionId, teamId);
}

/** Associate a run with an existing team */
export function associateRunWithTeam(teamId: string, runId: string): void {
  setOrchestrationStore("teams", teamId, "runId", runId);
}

/** Get the teamId for a session (parent or child) */
export function getTeamId(sessionId: string): string | undefined {
  return orchestrationStore.sessionToTeam[sessionId];
}

/** Get team info by teamId */
export function getTeamInfo(teamId: string): TeamInfo | undefined {
  return orchestrationStore.teams[teamId];
}

/** Check if a session is a team parent session */
export function isTeamParentSession(sessionId: string): boolean {
  const teamId = orchestrationStore.sessionToTeam[sessionId];
  if (!teamId) return false;
  return orchestrationStore.teams[teamId]?.parentSessionId === sessionId;
}

/** Get the run for a team */
export function getRunForTeam(teamId: string): OrchestrationRun | undefined {
  const team = orchestrationStore.teams[teamId];
  if (!team?.runId) return undefined;
  return orchestrationStore.runs[team.runId];
}

export function getRun(runId: string): OrchestrationRun | undefined {
  return orchestrationStore.runs[runId];
}

export function updateRun(run: OrchestrationRun): void {
  setOrchestrationStore("runs", run.id, { ...run });

  // Map child session IDs → teamId via the run's parentSessionId
  const teamId = orchestrationStore.sessionToTeam[run.parentSessionId];
  if (teamId) {
    for (const task of run.subtasks) {
      if (task.sessionId) {
        setOrchestrationStore("sessionToTeam", task.sessionId, teamId);
      }
    }
  }
}

export function setCurrentRunId(runId: string | null): void {
  setOrchestrationStore("currentRunId", runId);
}

/**
 * Restore orchestration state from backend runs (e.g., after page refresh).
 * Reconstructs teams, sessionToTeam mappings, and returns a map of sessionId → teamId
 * so the caller can patch teamId on SessionInfo objects.
 */
export function restoreFromRuns(runs: OrchestrationRun[]): Map<string, string> {
  const sessionTeamMap = new Map<string, string>();
  for (const run of runs) {
    // Generate a team ID for this run
    const teamId = `team_${run.id.slice(5)}`;

    // Store the run
    setOrchestrationStore("runs", run.id, { ...run });

    // Register team (include worktree info if available)
    const worktreeInfo = run.teamWorktreeName && run.teamWorktreeDir
      ? { name: run.teamWorktreeName, directory: run.teamWorktreeDir }
      : undefined;
    setOrchestrationStore("teams", teamId, { id: teamId, parentSessionId: run.parentSessionId, runId: run.id, worktreeInfo });
    setOrchestrationStore("sessionToTeam", run.parentSessionId, teamId);
    sessionTeamMap.set(run.parentSessionId, teamId);

    // Map child sessions
    for (const task of run.subtasks) {
      if (task.sessionId) {
        setOrchestrationStore("sessionToTeam", task.sessionId, teamId);
        sessionTeamMap.set(task.sessionId, teamId);
      }
    }

    // Set current run if still active
    if (run.status === "running" || run.status === "dispatching" || run.status === "confirming" || run.status === "decomposing") {
      setOrchestrationStore("currentRunId", run.id);
    }
  }
  return sessionTeamMap;
}

/**
 * Auto-detect team sessions from worktreeId pattern.
 * For sessions whose worktreeId starts with "team-" but aren't yet registered
 * in the orchestration store, register them as teams.
 * Returns a map of sessionId → teamId for sessions that were auto-registered.
 */
export function autoDetectTeams(sessions: { id: string; worktreeId?: string }[]): Map<string, string> {
  const result = new Map<string, string>();

  // Group sessions by team worktree name
  const worktreeToSessions = new Map<string, string[]>();
  for (const s of sessions) {
    if (s.worktreeId?.startsWith("team-") && !orchestrationStore.sessionToTeam[s.id]) {
      const arr = worktreeToSessions.get(s.worktreeId) || [];
      arr.push(s.id);
      worktreeToSessions.set(s.worktreeId, arr);
    }
  }

  for (const [worktreeName, sessionIds] of worktreeToSessions) {
    // The first session created in the team worktree is the parent (orchestrator)
    const parentSessionId = sessionIds[0];
    const teamId = `team_${worktreeName.slice(5)}`;

    if (!orchestrationStore.teams[teamId]) {
      setOrchestrationStore("teams", teamId, { id: teamId, parentSessionId });
    }
    for (const sid of sessionIds) {
      setOrchestrationStore("sessionToTeam", sid, teamId);
      result.set(sid, teamId);
    }
  }

  return result;
}

/** Update the role → engine mapping and persist */
export function updateRoleMappings(mappings: RoleEngineMapping[]): void {
  setOrchestrationStore("roleMappings", mappings);
  saveSetting("orchestration.roleMapping", mappings);
}

/** Get the engine type for a given role */
export function getEngineForRole(role: OrchestratorRole): { engineType: EngineType; modelId?: string } {
  const mapping = orchestrationStore.roleMappings.find((m) => m.role === role);
  if (mapping) return { engineType: mapping.engineType, modelId: mapping.modelId };
  const fallback = DEFAULT_ROLE_MAPPINGS.find((m) => m.role === role);
  return { engineType: fallback?.engineType ?? "claude" };
}

/** Get all role mappings (reactive) */
export function getRoleMappings(): RoleEngineMapping[] {
  return orchestrationStore.roleMappings;
}
