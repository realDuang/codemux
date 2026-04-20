// TeamRunCard — Renders a single agent team run (fridayliu's inline team card,
// extracted from Chat.tsx). Supports all TeamRunStatus values including the new
// "awaiting-confirmation" state (renders a Confirm & Execute action).
//
// Plan-editing UI is intentionally minimal here (one-click confirm). Full
// role/engine/dependency editing is handled by SubtaskEditor (future work /
// Phase 3 continuation).

import { For, Show } from "solid-js";
import type { TeamRun, TaskNode } from "../../types/unified";
import { useI18n, formatMessage } from "../../lib/i18n";
import {
  isTerminalTeamRun,
  getTeamRunStatusColor,
  getTeamRunStatusLabel,
  getTeamRunModeLabel,
  getTeamTaskStatusIcon,
  getTeamTaskStatusColor,
} from "./team-run-helpers";

export interface TeamRunCardProps {
  run: TeamRun;
  isActive: boolean;
  currentSessionId: string | null;
  onCancel: (runId: string) => void;
  onSelectSession: (sessionId: string) => void;
  /** Called when user confirms the (possibly edited) plan from awaiting-confirmation. */
  onConfirmPlan?: (runId: string, tasks: TaskNode[]) => void;
}

export function TeamRunCard(props: TeamRunCardProps) {
  const { t } = useI18n();

  const handleConfirm = () => {
    props.onConfirmPlan?.(props.run.id, props.run.tasks);
  };

  return (
    <div class="space-y-2">
      <div class={`px-3 py-2 rounded-lg border text-sm ${getTeamRunStatusColor(props.run)}`}>
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-medium text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t().chat.teamRunLabel} ({getTeamRunModeLabel(props.run, t())})
              </span>
              <span class="text-xs text-gray-700 dark:text-gray-200">
                {getTeamRunStatusLabel(props.run, t())}
              </span>
              <Show when={props.isActive}>
                <span class="rounded-full bg-white/70 dark:bg-black/20 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:text-gray-300">
                  {t().chat.teamRunActive}
                </span>
              </Show>
            </div>
            <div class="mt-1 text-[11px] text-gray-500 dark:text-gray-400 break-all">
              {props.run.id}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <Show when={props.run.status === "awaiting-confirmation" && props.onConfirmPlan}>
              <button
                type="button"
                onClick={handleConfirm}
                class="text-xs px-2 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors"
              >
                {t().chat.teamRunConfirmPlan}
              </button>
            </Show>
            <Show when={!isTerminalTeamRun(props.run)}>
              <button
                type="button"
                onClick={() => props.onCancel(props.run.id)}
                class="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400 font-medium"
              >
                {t().chat.teamRunCancel}
              </button>
            </Show>
          </div>
        </div>

        <Show when={props.run.tasks.length > 0}>
          <div class="mt-2 space-y-1.5">
            <For each={props.run.tasks}>
              {(task) => (
                <div class="rounded-md border border-gray-200/70 bg-white/60 px-2 py-1.5 dark:border-gray-700/70 dark:bg-black/10">
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0 flex-1">
                      <div class={`flex items-center gap-1.5 text-xs ${getTeamTaskStatusColor(task)}`}>
                        <span class="w-3 text-center font-mono">{getTeamTaskStatusIcon(task)}</span>
                        <span class="font-medium">{task.id}</span>
                        <span class="truncate">{task.description}</span>
                      </div>

                      <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
                        <Show when={task.dependsOn.length > 0}>
                          <span>
                            {formatMessage(t().chat.teamTaskDependsOn, {
                              ids: task.dependsOn.join(", "),
                            })}
                          </span>
                        </Show>
                        <Show when={task.engineType}>
                          <span>
                            {formatMessage(t().chat.teamTaskEngine, {
                              engine: task.engineType!,
                            })}
                          </span>
                        </Show>
                        <Show when={task.worktreeId}>
                          <span>
                            {formatMessage(t().chat.teamTaskWorktree, {
                              name: task.worktreeId!,
                            })}
                          </span>
                        </Show>
                        <Show when={task.sessionId && task.sessionId !== props.currentSessionId}>
                          <button
                            type="button"
                            onClick={() => props.onSelectSession(task.sessionId!)}
                            class="underline hover:text-gray-700 dark:hover:text-gray-200"
                          >
                            {t().chat.teamTaskOpenSession}
                          </button>
                        </Show>
                      </div>

                      <Show when={task.error}>
                        <div class="mt-1 text-[11px] text-red-600 dark:text-red-400 whitespace-pre-wrap line-clamp-2">
                          {task.error}
                        </div>
                      </Show>
                      <Show when={!task.error && task.result}>
                        <div class="mt-1 text-[11px] text-gray-600 dark:text-gray-300 whitespace-pre-wrap line-clamp-2">
                          {task.result}
                        </div>
                      </Show>
                    </div>

                    <Show when={task.status === "running"}>
                      <span class="mt-0.5 h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={props.run.finalResult}>
        <div class="rounded-lg border border-gray-200 bg-white/70 px-3 py-2 text-sm dark:border-gray-700 dark:bg-slate-900/40">
          <div class="text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t().chat.teamRunFinalResult}
          </div>
          <div class="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs text-gray-600 dark:text-gray-300">
            {props.run.finalResult}
          </div>
        </div>
      </Show>
    </div>
  );
}
