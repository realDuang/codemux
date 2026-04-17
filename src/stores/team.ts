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
  return teamStore.runs.find((r) => r.parentSessionId === sessionId);
}

/** Get team run by ID */
export function getTeamRun(runId: string): TeamRun | undefined {
  return teamStore.runs.find((r) => r.id === runId);
}
