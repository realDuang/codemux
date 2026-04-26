import { createMemo, createSignal, createEffect, For, onCleanup, onMount, Show } from "solid-js";
import type { OrchestrationRun, OrchestrationSubtask, SubtaskStatus } from "../../types/unified";
import styles from "./orchestration.module.css";

interface TeamExecutionCardProps {
  run: OrchestrationRun;
  onCancel: () => void;
  onViewSession: (sessionId: string) => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

/** Topological sort into layers for DAG visualization */
function computeDAGLayers(subtasks: OrchestrationSubtask[]): OrchestrationSubtask[][] {
  const layers: OrchestrationSubtask[][] = [];
  const placed = new Set<string>();
  let remaining = [...subtasks];

  while (remaining.length > 0) {
    const layer = remaining.filter((t) =>
      t.dependsOn.every((dep) => placed.has(dep)),
    );
    if (layer.length === 0) {
      // Deadlock or cycle — put remaining in last layer
      layers.push(remaining);
      break;
    }
    layers.push(layer);
    for (const t of layer) placed.add(t.id);
    remaining = remaining.filter((t) => !placed.has(t.id));
  }

  return layers;
}

/** Determine edge visual status based on source/target task statuses */
function getEdgeStatus(from: OrchestrationSubtask, to: OrchestrationSubtask): "completed" | "active" | "pending" {
  if (from.status === "completed" && to.status === "completed") return "completed";
  if (from.status === "completed" && (to.status === "running" || to.status === "pending")) return "active";
  return "pending";
}

interface EdgeData {
  fromId: string;
  toId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  status: "completed" | "active" | "pending";
}

function StatusDot(props: { status: SubtaskStatus }) {
  return (
    <span
      classList={{
        [styles.statusRunning]: props.status === "running",
        [styles.statusComplete]: props.status === "completed",
        [styles.statusBlocked]: props.status === "blocked" || props.status === "pending",
        [styles.statusFailed]: props.status === "failed",
      }}
      class="text-[9px] font-medium capitalize"
    >
      {props.status}
    </span>
  );
}

function ElapsedTimer(props: { startMs: number; running: boolean }) {
  const [elapsed, setElapsed] = createSignal(Date.now() - props.startMs);
  let interval: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    if (props.running) {
      interval = setInterval(() => setElapsed(Date.now() - props.startMs), 500);
    }
  });

  onCleanup(() => {
    if (interval) clearInterval(interval);
  });

  return <span class="text-[9px] text-slate-400 dark:text-slate-500 tabular-nums">{formatDuration(elapsed())}</span>;
}

export function TeamExecutionCard(props: TeamExecutionCardProps) {
  const completedCount = createMemo(
    () => props.run.subtasks.filter((t) => t.status === "completed").length,
  );
  const totalCount = createMemo(() => props.run.subtasks.length);
  const progressPct = createMemo(() =>
    totalCount() > 0 ? Math.round((completedCount() / totalCount()) * 100) : 0,
  );

  const runningSubtasks = createMemo(() => props.run.subtasks.filter((t) => t.status === "running"));
  const roundLabel = createMemo(() => {
    if (runningSubtasks().length > 0) return `Round ${completedCount() + 1}`;
    return props.run.status === "aggregating" ? "Aggregating results…" : "Dispatching…";
  });

  const isCancellable = () =>
    props.run.status === "running" ||
    props.run.status === "dispatching" ||
    props.run.status === "aggregating";

  // DAG layout
  const layers = createMemo(() => computeDAGLayers(props.run.subtasks));
  const taskIndex = createMemo(() => {
    const map = new Map<string, number>();
    props.run.subtasks.forEach((t, i) => map.set(t.id, i));
    return map;
  });

  const hasDependencies = createMemo(() =>
    props.run.subtasks.some((t) => t.dependsOn.length > 0),
  );

  // Node refs for SVG edge positions
  const nodeRefs = new Map<string, HTMLDivElement>();
  let containerRef: HTMLDivElement | undefined;
  const [edges, setEdges] = createSignal<EdgeData[]>([]);

  const computeEdges = () => {
    if (!containerRef || !hasDependencies()) return;
    const containerRect = containerRef.getBoundingClientRect();
    const newEdges: EdgeData[] = [];

    for (const task of props.run.subtasks) {
      for (const depId of task.dependsOn) {
        const fromEl = nodeRefs.get(depId);
        const toEl = nodeRefs.get(task.id);
        const fromTask = props.run.subtasks.find((t) => t.id === depId);
        if (fromEl && toEl && fromTask) {
          const fromRect = fromEl.getBoundingClientRect();
          const toRect = toEl.getBoundingClientRect();
          newEdges.push({
            fromId: depId,
            toId: task.id,
            fromX: fromRect.left + fromRect.width / 2 - containerRect.left,
            fromY: fromRect.bottom - containerRect.top,
            toX: toRect.left + toRect.width / 2 - containerRect.left,
            toY: toRect.top - containerRect.top,
            status: getEdgeStatus(fromTask, task),
          });
        }
      }
    }
    setEdges(newEdges);
  };

  // Recompute edges when subtasks change
  createEffect(() => {
    // Track subtask statuses to trigger recalculation
    props.run.subtasks.forEach((t) => t.status);
    props.run.subtasks.length;
    requestAnimationFrame(computeEdges);
  });

  onMount(() => {
    requestAnimationFrame(computeEdges);
  });

  return (
    <div class={`${styles.teamCard} ${styles.slideUp} flex flex-col gap-4`}>
      {/* Header */}
      <div class="flex items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <span class={`text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300 uppercase tracking-wider ${styles.engineBadgeRunning}`}>
              Running
            </span>
            <span class="text-[11px] text-slate-400 dark:text-slate-500">{roundLabel()}</span>
          </div>
          <h2 class="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Team Execution in Progress
          </h2>
        </div>
        <Show when={isCancellable()}>
          <button
            type="button"
            onClick={props.onCancel}
            class="text-xs text-red-400 hover:text-red-600 dark:hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            Cancel
          </button>
        </Show>
      </div>

      {/* Worktree info */}
      <Show when={props.run.teamWorktreeName}>
        <div class="flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500">
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <span class="font-mono">{props.run.teamWorktreeName}</span>
        </div>
      </Show>

      {/* Progress bar */}
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-slate-500 dark:text-slate-400">
            {completedCount()} / {totalCount()} subtasks completed
          </span>
          <span class="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
            {progressPct()}%
          </span>
        </div>
        <div class={styles.progressBar}>
          <div
            class={styles.progressFill}
            style={{ width: `${progressPct()}%` }}
          />
        </div>
      </div>

      {/* DAG Visualization */}
      <div class={styles.dagContainer} ref={(el) => (containerRef = el)}>
        {/* SVG edges layer */}
        <Show when={hasDependencies() && edges().length > 0}>
          <svg class={styles.dagSvg}>
            <defs>
              <marker id="dagArrowActive" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
                <path d="M0,0 L6,2 L0,4" fill="#6366f1" />
              </marker>
              <marker id="dagArrowCompleted" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
                <path d="M0,0 L6,2 L0,4" fill="#22c55e" />
              </marker>
              <marker id="dagArrowPending" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
                <path d="M0,0 L6,2 L0,4" fill="#94a3b8" />
              </marker>
            </defs>
            <For each={edges()}>
              {(edge) => {
                const midY = (edge.fromY + edge.toY) / 2;
                const d = `M ${edge.fromX} ${edge.fromY} C ${edge.fromX} ${midY}, ${edge.toX} ${midY}, ${edge.toX} ${edge.toY}`;
                return (
                  <path
                    d={d}
                    fill="none"
                    stroke={
                      edge.status === "completed" ? "#22c55e" :
                      edge.status === "active" ? "#6366f1" :
                      "#94a3b8"
                    }
                    stroke-width={edge.status === "pending" ? "1.5" : "2"}
                    stroke-dasharray={edge.status === "pending" ? "4 3" : "none"}
                    marker-end={`url(#dagArrow${edge.status.charAt(0).toUpperCase() + edge.status.slice(1)})`}
                    class={edge.status === "active" ? styles.dagEdgeActive : ""}
                  />
                );
              }}
            </For>
          </svg>
        </Show>

        {/* Node layers */}
        <For each={layers()}>
          {(layer) => (
            <div class={styles.dagLayer}>
              <For each={layer}>
                {(task) => (
                  <DAGNode
                    task={task}
                    index={taskIndex().get(task.id) ?? 0}
                    onViewSession={props.onViewSession}
                    onRef={(el) => nodeRefs.set(task.id, el)}
                  />
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

interface DAGNodeProps {
  task: OrchestrationSubtask;
  index: number;
  onViewSession: (sessionId: string) => void;
  onRef: (el: HTMLDivElement) => void;
}

function DAGNode(props: DAGNodeProps) {
  const truncated = () => {
    const desc = props.task.description;
    return desc.length > 40 ? `${desc.slice(0, 37)}...` : desc;
  };

  const isClickable = () =>
    !!(props.task.sessionId && (props.task.status === "running" || props.task.status === "completed"));

  const handleClick = () => {
    if (isClickable()) {
      props.onViewSession(props.task.sessionId!);
    }
  };

  return (
    <div
      ref={props.onRef}
      class={styles.dagNode}
      classList={{
        [styles.dagNodeRunning]: props.task.status === "running",
        [styles.dagNodeCompleted]: props.task.status === "completed",
        [styles.dagNodeFailed]: props.task.status === "failed",
        [styles.dagNodePending]: props.task.status === "blocked" || props.task.status === "pending",
        "cursor-pointer": isClickable(),
      }}
      onClick={handleClick}
      title={props.task.description}
    >
      {/* Top: index + description */}
      <div class="flex items-start gap-1.5 min-w-0">
        <span
          class="flex-shrink-0 w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center mt-px"
          classList={{
            "bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400": props.task.status === "running",
            "bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-400": props.task.status === "completed",
            "bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400": props.task.status === "failed",
            "bg-slate-100 dark:bg-slate-700 text-slate-400 dark:text-slate-500": props.task.status === "blocked" || props.task.status === "pending",
          }}
        >
          {props.index + 1}
        </span>
        <span class="text-[11px] text-slate-700 dark:text-slate-200 leading-snug min-w-0 line-clamp-2">
          {truncated()}
        </span>
      </div>

      {/* Bottom: role + engine + status + time */}
      <div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
        <Show when={props.task.role}>
          <span class="text-[8px] font-semibold px-1 py-px rounded bg-violet-100/60 dark:bg-violet-900/30 text-violet-500 dark:text-violet-400 uppercase">
            {props.task.role}
          </span>
        </Show>
        <span class="text-[8px] font-semibold px-1 py-px rounded bg-indigo-100/60 dark:bg-indigo-900/30 text-indigo-500 dark:text-indigo-400 uppercase">
          {props.task.engineType}
        </span>
        <StatusDot status={props.task.status} />
        <Show when={props.task.status === "running"}>
          <ElapsedTimer startMs={Date.now() - (props.task.duration ?? 0)} running={true} />
        </Show>
        <Show when={props.task.status === "completed" && props.task.duration !== undefined}>
          <span class="text-[9px] text-slate-400 dark:text-slate-500 tabular-nums">
            {formatDuration(props.task.duration!)}
          </span>
        </Show>
      </div>

      {/* Clickable indicator */}
      <Show when={isClickable()}>
        <div class="text-[9px] text-indigo-400 dark:text-indigo-500 mt-1 text-right">
          View →
        </div>
      </Show>
    </div>
  );
}
