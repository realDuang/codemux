// ============================================================================
// DAG Executor — Deterministic parallel task scheduling
// Executes tasks in topological order, running independent tasks in parallel.
// Shared between Light Brain and Heavy Brain orchestrators.
// ============================================================================

import { EventEmitter } from "events";
import type { OrchestrationSubtask, OrchestrationRun } from "../../../../src/types/unified";
import { TaskExecutor } from "./task-executor";
import { AGENT_TEAM_MAX_CONCURRENT_TASKS } from "./guardrails";

export interface DAGExecutorEvents {
  /** A task's status changed */
  "task.updated": (data: { runId: string; task: OrchestrationSubtask }) => void;
}

export declare interface DAGExecutor {
  on<K extends keyof DAGExecutorEvents>(event: K, listener: DAGExecutorEvents[K]): this;
  emit<K extends keyof DAGExecutorEvents>(event: K, ...args: Parameters<DAGExecutorEvents[K]>): boolean;
}

export class DAGExecutor extends EventEmitter {
  constructor(
    private taskExecutor: TaskExecutor,
    private directory: string,
    private maxConcurrentTasks = AGENT_TEAM_MAX_CONCURRENT_TASKS,
  ) {
    super();
  }

  /**
   * Execute all ready tasks in the DAG.
   * Runs in layers: find all tasks whose dependencies are satisfied,
   * execute them in parallel, then repeat until no more tasks are runnable.
   *
   * @param run - The team run containing the task DAG
   * @returns The tasks that were executed in this call
   */
  async executeReadyTasks(run: OrchestrationRun): Promise<OrchestrationSubtask[]> {
    const executedTasks: OrchestrationSubtask[] = [];

    while (true) {
      const ready = DAGExecutor.findReadyTasks(run.subtasks).slice(0, this.maxConcurrentTasks);
      if (ready.length === 0) break;

      // Execute the next ready batch up to the concurrency limit.
      const results = await Promise.allSettled(
        ready.map((task) => this.runSingleTask(run, task)),
      );

      // Process results
      for (let i = 0; i < ready.length; i++) {
        const task = ready[i];
        const result = results[i];

        if (result.status === "fulfilled") {
          task.status = "completed";
          task.resultSummary = result.value.summary;
          task.sessionId = result.value.sessionId;
          if (result.value.error) {
            task.status = "failed";
            task.error = result.value.error;
          }
        } else {
          task.status = "failed";
          task.error = result.reason?.message ?? String(result.reason);
        }

        task.time = { ...task.time, completed: Date.now() };
        this.emit("task.updated", { runId: run.id, task });
        executedTasks.push(task);
      }

      // Propagate failures: mark downstream tasks as blocked
      DAGExecutor.propagateFailures(run.subtasks);
    }

    return executedTasks;
  }

  /**
   * Find tasks that are ready to execute:
   * - status is "pending"
   * - all dependencies are "completed"
   */
  static findReadyTasks(tasks: OrchestrationSubtask[]): OrchestrationSubtask[] {
    return tasks.filter((task) => {
      if (task.status !== "pending") return false;
      return task.dependsOn.every((depId) => {
        const dep = tasks.find((t) => t.id === depId);
        return dep?.status === "completed";
      });
    });
  }

  /**
   * Execute a single task with upstream context injection.
   *
   * Team-worktree routing:
   * - If run.teamWorktreeDir is set and the task is write-capable (needsWorktree
   *   !== false), the task runs in the shared team worktree so sibling tasks
   *   see each other's edits.
   * - Read-only tasks (needsWorktree === false) skip the team worktree and
   *   run in the run's primary directory, avoiding contention.
   * - When teamWorktreeDir is not set, behavior is unchanged.
   */
  private async runSingleTask(run: OrchestrationRun, task: OrchestrationSubtask) {
    task.status = "running";
    task.time = { ...task.time, started: Date.now() };
    this.emit("task.updated", { runId: run.id, task });

    // Gather upstream results for context injection
    const dependencies = task.dependsOn
      .map((depId) => run.subtasks.find((t) => t.id === depId))
      .filter((t): t is OrchestrationSubtask => t != null);

    const upstreamContext = TaskExecutor.buildUpstreamContext(dependencies);

    // Choose directory + default worktree based on team worktree presence.
    const readOnlyByRole = task.role
      ? (run.roleMappings?.find((m) => m.role === task.role)?.readOnly ?? false)
      : false;
    const isReadOnly = task.needsWorktree === false || readOnlyByRole;
    const useTeamWorktree = !!run.teamWorktreeDir && !isReadOnly;

    const effectiveDirectory = useTeamWorktree
      ? (run.teamWorktreeDir as string)
      : this.directory;
    const effectiveDefaultWorktreeId = useTeamWorktree
      ? (run.teamWorktreeName ?? run.worktreeId)
      : run.worktreeId;

    return this.taskExecutor.execute(task, effectiveDirectory, {
      upstreamContext,
      defaultWorktreeId: effectiveDefaultWorktreeId,
    });
  }

  /**
   * Mark tasks as "blocked" if any of their dependencies failed.
   */
  static propagateFailures(tasks: OrchestrationSubtask[]): OrchestrationSubtask[] {
    const blockedTasks: OrchestrationSubtask[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (task.status !== "pending") continue;

        const hasFailedDep = task.dependsOn.some((depId) => {
          const dep = tasks.find((t) => t.id === depId);
          return dep?.status === "failed" || dep?.status === "blocked";
        });

        if (hasFailedDep) {
          task.status = "blocked";
          task.error = "Blocked by failed upstream task";
          blockedTasks.push(task);
          changed = true;
        }
      }
    }

    return blockedTasks;
  }

  /**
   * Check if the DAG execution is complete (no more pending/running tasks).
   */
  static isComplete(tasks: OrchestrationSubtask[]): boolean {
    return tasks.every((t) =>
      t.status === "completed" || t.status === "failed" || t.status === "blocked" || t.status === "cancelled",
    );
  }

  /**
   * Check if all tasks completed successfully.
   */
  static isAllSuccessful(tasks: OrchestrationSubtask[]): boolean {
    return tasks.every((t) => t.status === "completed");
  }
}
