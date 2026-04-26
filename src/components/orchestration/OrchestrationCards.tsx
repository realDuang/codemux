import { createMemo, Match, Show, Switch } from "solid-js";
import { orchestrationStore } from "../../stores/orchestration";
import { gateway } from "../../lib/gateway-api";
import { updateRun } from "../../stores/orchestration";
import type { OrchestrationSubtask } from "../../types/unified";
import { TeamPlanCard } from "./TeamPlanCard";
import { TeamExecutionCard } from "./TeamExecutionCard";
import { TeamResultCard } from "./TeamResultCard";
import styles from "./orchestration.module.css";

interface OrchestrationCardsProps {
  runId: string;
  onViewSession: (sessionId: string) => void;
}

export function OrchestrationCards(props: OrchestrationCardsProps) {
  const run = createMemo(() => orchestrationStore.runs[props.runId]);

  const handleConfirm = async (subtasks: OrchestrationSubtask[]) => {
    const r = run();
    if (!r) return;
    await gateway.confirmOrchestration({ runId: r.id, subtasks });
  };

  const handleCancel = async () => {
    const r = run();
    if (!r) return;
    await gateway.cancelOrchestration(r.id);
  };

  return (
    <Show when={run()} fallback={<div class="text-sm text-slate-400 dark:text-slate-500 py-4 text-center">Loading orchestration…</div>}>
      {(r) => (
        <Switch fallback={
          <div class={`${styles.teamCard} ${styles.slideUp} flex items-center gap-3 py-6`}>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="animate-spin text-indigo-500">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <span class="text-sm text-slate-600 dark:text-slate-300 capitalize">
              {r().status}…
            </span>
          </div>
        }>
          {/* Decomposing / setup spinner */}
          <Match when={r().status === "setup" || r().status === "decomposing"}>
            <div class={`${styles.teamCard} ${styles.slideUp} flex items-center gap-3 py-6`}>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="animate-spin text-indigo-500">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              <div class="flex flex-col gap-0.5">
                <span class="text-sm font-medium text-slate-700 dark:text-slate-200">
                  {r().status === "setup" ? "Setting up team…" : "Decomposing task…"}
                </span>
                <span class="text-[11px] text-slate-400 dark:text-slate-500">
                  Analyzing prompt and planning subtasks
                </span>
              </div>
            </div>
          </Match>

          {/* Plan confirmation */}
          <Match when={r().status === "confirming"}>
            <TeamPlanCard
              run={r()}
              onConfirm={handleConfirm}
              onCancel={handleCancel}
            />
          </Match>

          {/* Dispatching */}
          <Match when={r().status === "dispatching"}>
            <div class={`${styles.teamCard} ${styles.slideUp} flex items-center gap-3 py-6`}>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="animate-spin text-blue-500">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              <div class="flex flex-col gap-0.5">
                <span class="text-sm font-medium text-slate-700 dark:text-slate-200">
                  Dispatching subtasks…
                </span>
                <span class="text-[11px] text-slate-400 dark:text-slate-500">
                Creating worktree and sessions
                </span>
              </div>
            </div>
          </Match>

          {/* Running / aggregating */}
          <Match when={r().status === "running" || r().status === "aggregating"}>
            <TeamExecutionCard
              run={r()}
              onCancel={handleCancel}
              onViewSession={props.onViewSession}
            />
          </Match>

          {/* Completed */}
          <Match when={r().status === "completed"}>
            <TeamResultCard
              run={r()}
              onViewSession={props.onViewSession}
            />
          </Match>

          {/* Failed */}
          <Match when={r().status === "failed"}>
            <TeamResultCard
              run={r()}
              onViewSession={props.onViewSession}
            />
          </Match>

          {/* Cancelled */}
          <Match when={r().status === "cancelled"}>
            <div class={`${styles.teamCard} ${styles.slideUp} flex items-center gap-3 py-5`}>
              <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                Cancelled
              </span>
              <span class="text-sm text-slate-500 dark:text-slate-400">
                Team execution was cancelled.
              </span>
            </div>
          </Match>
        </Switch>
      )}
    </Show>
  );
}
