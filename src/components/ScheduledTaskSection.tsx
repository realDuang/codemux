import { For, Show, createSignal, createMemo, onCleanup } from "solid-js";
import { useI18n } from "../lib/i18n";
import { scheduledTaskStore, setScheduledTaskStore } from "../stores/scheduled-task";
import { getEngineBadge } from "./share/common";
import type { ScheduledTask } from "../types/unified";

interface ScheduledTaskSectionProps {
  tasks: ScheduledTask[];
  collapsed?: boolean;
  onCreateTask: () => void;
  onEditTask: (task: ScheduledTask) => void;
  onDeleteTask: (taskId: string) => void;
  onRunNow: (taskId: string) => void;
  onToggleEnabled: (taskId: string, enabled: boolean) => void;
  onSelectTaskSession: (sessionId: string) => void;
}

export function ScheduledTaskSection(props: ScheduledTaskSectionProps) {
  const { t } = useI18n();
  const [pendingDeleteId, setPendingDeleteId] = createSignal<string | null>(null);
  const [runningTaskId, setRunningTaskId] = createSignal<string | null>(null);

  // Tick signal — forces countdown recalculation every 30s
  const [tick, setTick] = createSignal(0);
  const tickInterval = setInterval(() => setTick((t) => t + 1), 30_000);
  onCleanup(() => clearInterval(tickInterval));

  const isExpanded = () => scheduledTaskStore.expanded;

  const toggleExpanded = () => {
    setScheduledTaskStore("expanded", !isExpanded());
  };

  const enabledCount = createMemo(() => props.tasks.filter((t) => t.enabled).length);

  const formatNextRun = (task: ScheduledTask): string => {
    tick(); // Subscribe to tick for auto-refresh
    if (task.frequency.type === "manual") return t().scheduledTask.manual;
    if (!task.nextRunAt) return "-";

    const now = Date.now();
    const diff = task.nextRunAt - now;

    if (diff < 0) return t().scheduledTask.lessThanOneMinute;

    if (diff < 60_000) return t().scheduledTask.lessThanOneMinute;
    if (diff < 3_600_000) {
      const mins = Math.round(diff / 60_000);
      return `${mins}m`;
    }
    if (diff < 86_400_000) {
      const hours = Math.floor(diff / 3_600_000);
      const mins = Math.round((diff % 3_600_000) / 60_000);
      return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    }

    const date = new Date(task.nextRunAt);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const frequencyLabel = (task: ScheduledTask): string => {
    const labels: Record<string, string> = {
      manual: t().scheduledTask.frequencyManual,
      interval: t().scheduledTask.frequencyInterval,
      daily: t().scheduledTask.frequencyDaily,
      weekly: t().scheduledTask.frequencyWeekly,
    };
    let label = labels[task.frequency.type] || task.frequency.type;
    if (task.frequency.type === "interval" && task.frequency.intervalMinutes) {
      const mins = task.frequency.intervalMinutes;
      label = mins >= 60 ? `${mins / 60}h` : `${mins}m`;
    }
    return label;
  };

  const handleRunNow = async (e: MouseEvent, taskId: string) => {
    e.stopPropagation();
    setRunningTaskId(taskId);
    try {
      await props.onRunNow(taskId);
    } finally {
      setRunningTaskId(null);
    }
  };

  // Collapsed mode: just show a small clock icon
  if (props.collapsed) {
    return (
      <div class="flex flex-col items-center gap-1 mb-2 pb-2 border-b border-gray-200 dark:border-slate-800">
        <button
          class="w-10 h-10 rounded-lg flex items-center justify-center hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors relative"
          onClick={props.onCreateTask}
          title={t().scheduledTask.title}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-gray-500 dark:text-gray-400">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <Show when={enabledCount() > 0}>
            <span class="absolute -top-0.5 -right-0.5 w-4 h-4 bg-blue-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
              {enabledCount()}
            </span>
          </Show>
        </button>
      </div>
    );
  }

  return (
    <div class="mb-2 pb-2 border-b border-gray-200 dark:border-slate-800">
      {/* Section Header */}
      <div
        class="group flex items-center justify-between px-2 py-1.5 rounded-md cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-900 transition-colors"
        onClick={toggleExpanded}
      >
        <div class="flex items-center gap-2 min-w-0 flex-1">
          {/* Expand/Collapse Arrow */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class={`text-gray-400 transition-transform flex-shrink-0 ${isExpanded() ? "rotate-90" : ""}`}
          >
            <path d="m9 18 6-6-6-6" />
          </svg>

          {/* Clock icon */}
          <div class="w-5 h-5 rounded flex items-center justify-center bg-indigo-500 text-white flex-shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>

          {/* Title + count */}
          <span class="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
            {t().scheduledTask.title}
          </span>
          <Show when={props.tasks.length > 0}>
            <span class="text-[10px] text-gray-400 dark:text-gray-500">
              [{enabledCount()}/{props.tasks.length}]
            </span>
          </Show>
        </div>

        {/* Create task button */}
        <button
          class="p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded transition-all opacity-0 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            props.onCreateTask();
          }}
          title={t().scheduledTask.create}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14" />
            <path d="M12 5v14" />
          </svg>
        </button>
      </div>

      {/* Task List — animated collapsible */}
      <div class="collapsible-grid" data-expanded={isExpanded() ? "true" : "false"}>
        <div class="collapsible-content">
          <div class="ml-4 mt-1">
            <Show
              when={props.tasks.length > 0}
              fallback={
                <div class="px-3 py-3 text-center">
                  <p class="text-xs text-gray-400 dark:text-gray-500">{t().scheduledTask.noTasks}</p>
                  <button
                    onClick={props.onCreateTask}
                    class="mt-1.5 text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
                  >
                    + {t().scheduledTask.create}
                  </button>
                </div>
              }
            >
              <For each={props.tasks}>
                {(task) => {
                  const handleClick = () => {
                    if (task.runHistory.length > 0) {
                      props.onSelectTaskSession(task.runHistory[0]);
                    }
                  };

                  return (
                    <div
                      class="group relative px-3 py-2 mb-0.5 rounded-md cursor-pointer transition-all duration-150 hover:bg-gray-100 dark:hover:bg-slate-900"
                      onClick={handleClick}
                    >
                      {/* Line 1: Status dot + Name */}
                      <div class="flex items-center gap-1.5 min-w-0">
                        {/* Enabled/disabled dot */}
                        <span
                          class={`w-2 h-2 rounded-full flex-shrink-0 ${
                            task.enabled
                              ? "bg-green-500 dark:bg-green-400"
                              : "bg-gray-300 dark:bg-gray-600"
                          }`}
                          title={task.enabled ? t().scheduledTask.enabled : t().scheduledTask.disabled}
                        />

                        <span class="text-sm text-gray-700 dark:text-gray-300 truncate">
                          {task.name}
                        </span>
                      </div>

                      {/* Line 2: Engine badge + frequency + next run */}
                      <div class="flex items-center gap-1.5 mt-0.5">
                        <Show when={getEngineBadge(task.engineType)}>
                          {(badge) => (
                            <span class={`text-[9px] font-medium px-1 py-0.5 rounded leading-none flex-shrink-0 ${badge().class}`}>
                              {badge().label}
                            </span>
                          )}
                        </Show>
                        <span class="text-[10px] text-gray-400 dark:text-gray-500">
                          {frequencyLabel(task)}
                        </span>
                        <Show when={task.enabled && task.frequency.type !== "manual"}>
                          <span class="text-[10px] text-gray-400 dark:text-gray-500">
                            · {formatNextRun(task)}
                          </span>
                        </Show>
                      </div>

                      {/* Hover action buttons */}
                      <Show
                        when={pendingDeleteId() !== task.id}
                        fallback={
                          <div class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1 bg-white dark:bg-slate-800 rounded-md shadow-sm px-1 py-0.5">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                props.onDeleteTask(task.id);
                                setPendingDeleteId(null);
                              }}
                              class="px-2 py-1 text-[10px] font-medium text-white bg-red-500 hover:bg-red-600 rounded transition-colors"
                            >
                              {t().common.confirm}
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setPendingDeleteId(null);
                              }}
                              class="px-2 py-1 text-[10px] font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700 rounded transition-colors"
                            >
                              {t().common.cancel}
                            </button>
                          </div>
                        }
                      >
                        <div class="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-0.5 bg-white/90 dark:bg-slate-800/90 backdrop-blur-xs rounded-md shadow-sm px-0.5 py-0.5">
                          {/* Run Now */}
                          <button
                            onClick={(e) => handleRunNow(e, task.id)}
                            disabled={runningTaskId() === task.id}
                            class="p-1.5 text-gray-400 hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20 rounded transition-all disabled:opacity-50"
                            title={t().scheduledTask.runNow}
                          >
                            <Show
                              when={runningTaskId() !== task.id}
                              fallback={
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="animate-spin">
                                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                                </svg>
                              }
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                <polygon points="5 3 19 12 5 21 5 3" />
                              </svg>
                            </Show>
                          </button>

                          {/* Toggle enabled */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onToggleEnabled(task.id, !task.enabled);
                            }}
                            class={`p-1.5 rounded transition-all ${
                              task.enabled
                                ? "text-green-500 hover:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-900/20"
                                : "text-gray-400 hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20"
                            }`}
                            title={task.enabled ? t().scheduledTask.disable : t().scheduledTask.enable}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <Show
                                when={task.enabled}
                                fallback={
                                  <>
                                    <circle cx="12" cy="12" r="10" />
                                  </>
                                }
                              >
                                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                                <polyline points="22 4 12 14.01 9 11.01" />
                              </Show>
                            </svg>
                          </button>

                          {/* Edit */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onEditTask(task);
                            }}
                            class="p-1.5 text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-all"
                            title={t().scheduledTask.edit}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                              <path d="m15 5 4 4" />
                            </svg>
                          </button>

                          {/* Delete */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingDeleteId(task.id);
                            }}
                            class="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-all"
                            title={t().scheduledTask.delete}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M3 6h18" />
                              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
