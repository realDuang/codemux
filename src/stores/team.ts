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

function pickPreferredRun(runs: TeamRun[]): TeamRun | undefined {
  if (runs.length === 0) return undefined;
  return runs.reduce((best, run) => {
    if (!best) return run;
    const bestActive = isActiveTeamRun(best);
    const runActive = isActiveTeamRun(run);
    if (runActive !== bestActive) {
      return runActive ? run : best;
    }
    return run.time.created > best.time.created ? run : best;
  }, runs[0]);
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
      setTeamStore("runs", (runs) => {
        const idx = runs.findIndex((r) => r.id === run.id);
        if (idx >= 0) {
          const updated = [...runs];
          updated[idx] = run;
          return updated;
        }
        return [...runs, run];
      });
    },

    onTeamTaskUpdated: (runId: string, task: TaskNode) => {
      setTeamStore("runs", (runs) =>
        runs.map((run) => {
          if (run.id !== runId) return run;
          return {
            ...run,
            tasks: run.tasks.map((t) => (t.id === task.id ? task : t)),
          };
        }),
      );
    },
  };
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
  setTeamStore("runs", (runs) => [...runs, run]);
  setTeamStore("activeRunId", run.id);
  return run;
}

/** Cancel a team run */
export async function cancelTeamRun(runId: string): Promise<void> {
  await gateway.cancelTeamRun(runId);
}

/** Get the active team run for a given session */
export function getTeamRunForSession(sessionId: string): TeamRun | undefined {
  return pickPreferredRun(teamStore.runs.filter((r) => r.parentSessionId === sessionId));
}

/** Get the active team run for a given session, if any */
export function getActiveTeamRunForSession(sessionId: string): TeamRun | undefined {
  return pickPreferredRun(
    teamStore.runs.filter((r) => r.parentSessionId === sessionId && isActiveTeamRun(r)),
  );
}

/** Get the active Heavy Brain run for a given session, if any */
export function getActiveHeavyTeamRunForSession(sessionId: string): TeamRun | undefined {
  return pickPreferredRun(
    teamStore.runs.filter(
      (r) => r.parentSessionId === sessionId && r.mode === "heavy" && isActiveTeamRun(r),
    ),
  );
}

/** Send a user follow-up message to an active team run orchestrator */
export async function sendTeamRunMessage(runId: string, text: string): Promise<void> {
  await gateway.sendTeamMessage(runId, text);
}

/** Get team run by ID */
export function getTeamRun(runId: string): TeamRun | undefined {
  return teamStore.runs.find((r) => r.id === runId);
}
