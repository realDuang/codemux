import { createSignal, For, onMount, Show } from "solid-js";
import type { OrchestrationRun, OrchestrationSubtask } from "../../types/unified";
import { ContentMarkdown } from "../share/content-markdown";
import { Collapsible } from "../Collapsible";
import styles from "./orchestration.module.css";

interface TeamResultCardProps {
  run: OrchestrationRun;
  onViewSession: (sessionId: string) => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

export function TeamResultCard(props: TeamResultCardProps) {
  const [ripple, setRipple] = createSignal(false);

  onMount(() => {
    // Trigger completion ripple animation
    setRipple(true);
    const t = setTimeout(() => setRipple(false), 700);
    return () => clearTimeout(t);
  });

  const successCount = () => props.run.subtasks.filter((t) => t.status === "completed").length;
  const failedCount = () => props.run.subtasks.filter((t) => t.status === "failed").length;
  const totalDuration = () => {
    if (props.run.time.completed && props.run.time.created) {
      return props.run.time.completed - props.run.time.created;
    }
    return undefined;
  };

  return (
    <div
      class={`${styles.teamCard} ${styles.slideUp} flex flex-col gap-4`}
      classList={{ [styles.ripple]: ripple() }}
    >
      {/* Header */}
      <div class="flex items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-300 uppercase tracking-wider">
              {props.run.status === "failed" ? "Failed" : "Completed"}
            </span>
            <span class="text-[11px] text-slate-400 dark:text-slate-500">
              {successCount()}/{props.run.subtasks.length} succeeded
              <Show when={failedCount() > 0}>
                {" "}· {failedCount()} failed
              </Show>
              <Show when={totalDuration() !== undefined}>
                {" "}· {formatDuration(totalDuration()!)} total
              </Show>
            </span>
          </div>
          <h2 class="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Team Execution Results
          </h2>
        </div>
      </div>

      {/* Summary */}
      <Show when={props.run.resultSummary}>
        <div class="rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700/40 px-3 py-3">
          <p class="text-[10px] font-medium text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">
            Summary
          </p>
          <div class="text-sm text-slate-700 dark:text-slate-200">
            <ContentMarkdown text={props.run.resultSummary!} expand />
          </div>
        </div>
      </Show>

      {/* Per-subtask results */}
      <div class="flex flex-col gap-2">
        <p class="text-[11px] font-medium text-slate-400 dark:text-slate-500 uppercase tracking-wider">
          Subtask Results
        </p>
        <For each={props.run.subtasks}>
          {(task, idx) => (
            <SubtaskResultRow
              task={task}
              index={idx()}
              onViewSession={props.onViewSession}
            />
          )}
        </For>
      </div>

      {/* Worktree info */}
      <Show when={props.run.teamWorktreeName}>
        <div class="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <span>Worktree:</span>
          <span class="font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">
            {props.run.teamWorktreeName}
          </span>
        </div>
      </Show>
    </div>
  );
}

interface SubtaskResultRowProps {
  task: OrchestrationSubtask;
  index: number;
  onViewSession: (sessionId: string) => void;
}

function SubtaskResultRow(props: SubtaskResultRowProps) {
  const isCompleted = () => props.task.status === "completed";
  const isFailed = () => props.task.status === "failed";

  return (
    <Collapsible defaultOpen={false}>
      <div
        class="rounded-lg border transition-colors"
        classList={{
          "border-green-200 dark:border-green-800/40 bg-green-50/30 dark:bg-green-950/10": isCompleted(),
          "border-red-200 dark:border-red-800/40 bg-red-50/30 dark:bg-red-950/10": isFailed(),
          "border-slate-200 dark:border-slate-700/40 bg-slate-50/50 dark:bg-slate-800/30": !isCompleted() && !isFailed(),
        }}
      >
        <Collapsible.Trigger class="w-full flex items-center gap-2 px-3 py-2.5 text-left">
          <Collapsible.Arrow />

          {/* Index */}
          <span class="flex-shrink-0 w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center"
            classList={{
              "bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-400": isCompleted(),
              "bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400": isFailed(),
              "bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400": !isCompleted() && !isFailed(),
            }}
          >
            {props.index + 1}
          </span>

          {/* Description */}
          <span class="flex-1 text-sm text-slate-700 dark:text-slate-200 truncate">
            {props.task.description}
          </span>

          {/* Engine badge */}
          <span class="flex-shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 uppercase">
            {props.task.engineType}
          </span>

          {/* Status */}
          <Show when={isCompleted()}>
            <span class="flex-shrink-0 text-[10px] text-green-600 dark:text-green-400 font-medium">
              ✓ done
            </span>
          </Show>
          <Show when={isFailed()}>
            <span class="flex-shrink-0 text-[10px] text-red-500 dark:text-red-400 font-medium">
              ✕ failed
            </span>
          </Show>

          {/* Duration */}
          <Show when={props.task.duration !== undefined}>
            <span class="flex-shrink-0 text-[10px] text-slate-400 dark:text-slate-500 tabular-nums">
              {formatDuration(props.task.duration!)}
            </span>
          </Show>
        </Collapsible.Trigger>

        <Collapsible.Content>
          <div class="px-3 pb-3 pt-1 flex flex-col gap-2 border-t border-slate-100 dark:border-slate-700/50">
            <Show when={props.task.resultSummary}>
              <ContentMarkdown text={props.task.resultSummary!} expand />
            </Show>
            <Show when={props.task.error}>
              <p class="text-sm text-red-500 dark:text-red-400">{props.task.error}</p>
            </Show>
            <Show when={props.task.sessionId}>
              <button
                type="button"
                onClick={() => props.onViewSession(props.task.sessionId!)}
                class="self-start text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors"
              >
                View Session →
              </button>
            </Show>
          </div>
        </Collapsible.Content>
      </div>
    </Collapsible>
  );
}
