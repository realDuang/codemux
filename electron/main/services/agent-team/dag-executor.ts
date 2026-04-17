// ============================================================================
// DAG Executor — Deterministic parallel task scheduling
// Executes tasks in topological order, running independent tasks in parallel.
// Shared between Light Brain and Heavy Brain orchestrators.
// ============================================================================

import { EventEmitter } from "events";
import type { TaskNode, TeamRun } from "../../../../src/types/unified";
import { TaskExecutor } from "./task-executor";

export interface DAGExecutorEvents {
  /** A task's status changed */
  "task.updated": (data: { runId: string; task: TaskNode }) => void;
}

export declare interface DAGExecutor {
  on<K extends keyof DAGExecutorEvents>(event: K, listener: DAGExecutorEvents[K]): this;
  emit<K extends keyof DAGExecutorEvents>(event: K, ...args: Parameters<DAGExecutorEvents[K]>): boolean;
}

export class DAGExecutor extends EventEmitter {
  constructor(
    private taskExecutor: TaskExecutor,
    private directory: string,
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
  async executeReadyTasks(run: TeamRun): Promise<TaskNode[]> {
    const executedTasks: TaskNode[] = [];

    while (true) {
      const ready = this.findReadyTasks(run.tasks);
      if (ready.length === 0) break;

      // Execute all ready tasks in parallel
      const results = await Promise.allSettled(
        ready.map((task) => this.runSingleTask(run, task)),
      );

      // Process results
      for (let i = 0; i < ready.length; i++) {
        const task = ready[i];
        const result = results[i];

        if (result.status === "fulfilled") {
          task.status = "completed";
          task.result = result.value.summary;
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
      this.propagateFailures(run.tasks);
    }

    return executedTasks;
  }

  /**
   * Find tasks that are ready to execute:
   * - status is "pending"
   * - all dependencies are "completed"
   */
  private findReadyTasks(tasks: TaskNode[]): TaskNode[] {
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
   */
  private async runSingleTask(run: TeamRun, task: TaskNode) {
    task.status = "running";
    task.time = { ...task.time, started: Date.now() };
    this.emit("task.updated", { runId: run.id, task });

    // Gather upstream results for context injection
    const dependencies = task.dependsOn
      .map((depId) => run.tasks.find((t) => t.id === depId))
      .filter((t): t is TaskNode => t != null);

    const upstreamContext = TaskExecutor.buildUpstreamContext(dependencies);

    return this.taskExecutor.execute(task, this.directory, upstreamContext);
  }

  /**
   * Mark tasks as "blocked" if any of their dependencies failed.
   */
  private propagateFailures(tasks: TaskNode[]): void {
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
          changed = true;
        }
      }
    }
  }

  /**
   * Check if the DAG execution is complete (no more pending/running tasks).
   */
  static isComplete(tasks: TaskNode[]): boolean {
    return tasks.every((t) =>
      t.status === "completed" || t.status === "failed" || t.status === "blocked" || t.status === "cancelled",
    );
  }

  /**
   * Check if all tasks completed successfully.
   */
  static isAllSuccessful(tasks: TaskNode[]): boolean {
    return tasks.every((t) => t.status === "completed");
  }
}
