// ============================================================================
// Team Store — Minimal reactive store for Agent Team runs
// ============================================================================

import { createStore } from "solid-js/store";
import { gateway } from "../lib/gateway-api";
import type { TeamRun, TaskNode } from "../types/unified";

interface TeamStoreState {
  /** All known team runs */
  runs: TeamRun[];
  /** Currently active/focused run ID */
  activeRunId: string | null;
}

const [teamStore, setTeamStore] = createStore<TeamStoreState>({
  runs: [],
  activeRunId: null,
});

export { teamStore };

function isActiveTeamRun(run: TeamRun): boolean {
  return run.status === "planning" || run.status === "running";
}

function compareTeamRuns(a: TeamRun, b: TeamRun): number {
  const aActive = isActiveTeamRun(a);
  const bActive = isActiveTeamRun(b);
  if (aActive !== bActive) {
    return aActive ? -1 : 1;
  }
  return b.time.created - a.time.created;
}

function pickPreferredRun(runs: TeamRun[]): TeamRun | undefined {
  if (runs.length === 0) return undefined;
  return [...runs].sort(compareTeamRuns)[0];
}

function dedupeTeamRuns(runs: TeamRun[]): TeamRun[] {
  const deduped = new Map<string, TeamRun>();
  for (const run of runs) {
    deduped.set(run.id, run);
  }
  return [...deduped.values()];
}

function upsertTeamRun(runs: TeamRun[], run: TeamRun): TeamRun[] {
  return [...runs.filter((existing) => existing.id !== run.id), run];
}

function getLatestTeamRun(runs: TeamRun[], runId: string): TeamRun | undefined {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (runs[index].id === runId) {
      return runs[index];
    }
  }
  return undefined;
}

function getSessionRuns(sessionId: string): TeamRun[] {
  return dedupeTeamRuns(teamStore.runs.filter((run) => run.parentSessionId === sessionId));
}

/** Initialize notification handlers for team events */
export function initTeamStore(): void {
  // These handlers are set during gateway-api initialization
  // See connectTeamHandlers()
}

/** Connect team notification handlers to gateway-api */
export function connectTeamHandlers(): {
  onTeamRunUpdated: (run: TeamRun) => void;
  onTeamTaskUpdated: (runId: string, task: TaskNode) => void;
} {
  return {
    onTeamRunUpdated: (run: TeamRun) => {
      setTeamStore("runs", (runs) => upsertTeamRun(runs, run));
    },

      onTeamTaskUpdated: (runId: string, task: TaskNode) => {
      setTeamStore("runs", (runs) => {
        const run = getLatestTeamRun(runs, runId);
        if (!run) return runs;

        return upsertTeamRun(runs, {
          ...run,
          tasks: run.tasks.map((t) => (t.id === task.id ? task : t)),
        });
      });
    },
  };
}

/** Replace the known team runs with a hydrated snapshot from the backend. */
export function hydrateTeamRuns(runs: TeamRun[]): void {
  const activeRunId = teamStore.activeRunId;
  const dedupedRuns = dedupeTeamRuns(runs);
  const nextActiveRunId = activeRunId && dedupedRuns.some((run) => run.id === activeRunId)
    ? activeRunId
    : null;

  setTeamStore("runs", dedupedRuns);
  setTeamStore("activeRunId", nextActiveRunId);
}

/** Create a new team run */
export async function createTeamRun(
  sessionId: string,
  prompt: string,
  mode: "light" | "heavy",
  directory: string,
  engineType?: string,
): Promise<TeamRun> {
  const run = await gateway.createTeamRun({
    sessionId,
    prompt,
    mode,
    directory,
    engineType,
  });
  setTeamStore("runs", (runs) => upsertTeamRun(runs, run));
  setTeamStore("activeRunId", run.id);
  return run;
}

/** Cancel a team run */
export async function cancelTeamRun(runId: string): Promise<void> {
  await gateway.cancelTeamRun(runId);
}

/** Get the active team run for a given session */
export function getTeamRunForSession(sessionId: string): TeamRun | undefined {
  return pickPreferredRun(getSessionRuns(sessionId));
}

/** Get all known team runs for a session, sorted by activity then recency. */
export function getTeamRunsForSession(sessionId: string): TeamRun[] {
  return getSessionRuns(sessionId)
    .sort(compareTeamRuns);
}

/** Get the active team run for a given session, if any */
export function getActiveTeamRunForSession(sessionId: string): TeamRun | undefined {
  return pickPreferredRun(
    getSessionRuns(sessionId).filter((r) => isActiveTeamRun(r)),
  );
}

/** Get the active Heavy Brain run for a given session, if any */
export function getActiveHeavyTeamRunForSession(sessionId: string): TeamRun | undefined {
  return pickPreferredRun(
    getSessionRuns(sessionId).filter(
      (r) => r.mode === "heavy" && isActiveTeamRun(r),
    ),
  );
}

/** Relay a user follow-up message to an active Heavy Brain orchestrator */
export async function sendTeamRunMessage(runId: string, text: string): Promise<void> {
  await gateway.sendTeamMessage(runId, text);
}

/** Get team run by ID */
export function getTeamRun(runId: string): TeamRun | undefined {
  return getLatestTeamRun(teamStore.runs, runId);
}
