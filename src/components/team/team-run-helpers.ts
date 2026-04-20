// Shared helpers for Agent Team UI — status labels / status colors / task icons.
// Extracted from Chat.tsx inline team run card so the same presentation can be
// reused by TeamRunCard and any future dashboard view.

import type { TeamRun, TaskNode, TeamRunStatus } from "../../types/unified";
import type { LocaleDict } from "../../locales/en";
import { formatMessage } from "../../lib/i18n";

export function isTerminalTeamRun(run: TeamRun): boolean {
  return ["completed", "failed", "cancelled"].includes(run.status);
}

export function getTeamRunStatusColor(run: TeamRun): string {
  switch (run.status) {
    case "completed":
      return "bg-green-100 dark:bg-green-900/20 border-green-200 dark:border-green-800";
    case "failed":
      return "bg-red-100 dark:bg-red-900/20 border-red-200 dark:border-red-800";
    case "cancelled":
      return "bg-gray-100 dark:bg-gray-900/20 border-gray-200 dark:border-gray-700";
    case "awaiting-confirmation":
      return "bg-violet-50 dark:bg-violet-900/15 border-violet-200/60 dark:border-violet-700/40";
    default:
      return "bg-amber-50 dark:bg-amber-900/15 border-amber-200/50 dark:border-amber-700/30";
  }
}

export function getTeamRunStatusLabel(run: TeamRun, t: LocaleDict): string {
  const completed = run.tasks.filter((task) => task.status === "completed").length;
  switch (run.status as TeamRunStatus) {
    case "planning":
      return t.chat.teamRunPlanning;
    case "awaiting-confirmation":
      return t.chat.teamRunAwaitingConfirmation;
    case "running":
      return formatMessage(t.chat.teamRunRunning, {
        completed,
        total: run.tasks.length,
      });
    case "completed":
      return t.chat.teamRunCompleted;
    case "failed":
      return t.chat.teamRunFailed;
    case "cancelled":
      return t.chat.teamRunCancelled;
    default:
      return run.status;
  }
}

export function getTeamRunModeLabel(run: TeamRun, t: LocaleDict): string {
  return run.mode === "heavy" ? t.chat.teamRunModeHeavy : t.chat.teamRunModeLight;
}

export function getTeamTaskStatusIcon(task: TaskNode): string {
  switch (task.status) {
    case "completed":
      return "\u2713";
    case "failed":
      return "\u2717";
    case "running":
      return "\u25CB";
    case "blocked":
      return "\u25CB";
    case "cancelled":
      return "\u2014";
    default:
      return "\u00B7";
  }
}

export function getTeamTaskStatusColor(task: TaskNode): string {
  switch (task.status) {
    case "completed":
      return "text-green-600 dark:text-green-400";
    case "failed":
      return "text-red-600 dark:text-red-400";
    case "running":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-gray-500 dark:text-gray-400";
  }
}
