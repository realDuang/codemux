// ============================================================================
// Heavy Brain — Continuous LLM supervisor orchestration
// A long-running orchestrator session dispatches tasks and adapts dynamically.
// Results are reported incrementally as each task completes.
// ============================================================================

import type { EngineManager } from "../../gateway/engine-manager";
import type { TaskNode, TeamRun, EngineType, UnifiedMessage } from "../../../../src/types/unified";
import { DAGExecutor } from "./dag-executor";
import {
  TaskExecutor,
  extractTextFromMessage,
  trackAutoApproveSession,
  type AutoApproveSessionTracker,
  type TaskExecutionResult,
} from "./task-executor";
import { dispatchSkill, type DispatchInstruction, type DispatchTask } from "./skills";
import { buildOrchestratorPrompt, formatSingleTaskResult, formatTaskResults, formatUserMessage } from "./prompts";
import { agentTeamLog } from "./logger";
import { UserChannel } from "./user-channel";
import { AGENT_TEAM_MAX_CONCURRENT_TASKS } from "./guardrails";

/** Maximum orchestration iterations to prevent infinite loops */
const MAX_ITERATIONS = 20;

interface RunningTaskState {
  promise: Promise<TaskExecutionResult>;
  sessionId?: string;
}

/**
 * Race a Map of promises: resolves with the first one to settle.
 * Returns the key and result; the remaining promises keep running.
 */
function raceMap(map: Map<string, RunningTaskState>): Promise<{ id: string; result: TaskExecutionResult }> {
  return Promise.race(
    Array.from(map.entries()).map(([id, state]) =>
      state.promise.then(
        (result) => ({ id, result }),
        (err) => ({
          id,
          result: {
            sessionId: "",
            summary: "",
            error: err instanceof Error ? err.message : String(err),
          },
        }),
      ),
    ),
  );
}

type RunningTasks = Map<string, RunningTaskState>;
type TerminalMessage = UnifiedMessage & { _terminal?: true };

type ParseInstructionResult =
  | { ok: true; data: DispatchInstruction; response: UnifiedMessage }
  | { ok: false; error: string; response: UnifiedMessage };

type MergeDispatchTasksResult =
  | { ok: true; tasks: TaskNode[] }
  | { ok: false; error: string };

export class HeavyBrainOrchestrator {
  private cancelled = false;
  private terminal = false;
  private nextAutoTaskIndex = 0;
  private activeRun: {
    teamRun: TeamRun;
    onTaskUpdated: (task: TaskNode) => void;
  } | null = null;
  private activeRunningTasks: RunningTasks | null = null;
  private cancelSignal: Promise<void> = Promise.resolve();
  private resolveCancelSignal: (() => void) | null = null;
  private cancelledSessionIds = new Set<string>();
  /** Shared user message channel — external code calls userChannel.send() */
  readonly userChannel = new UserChannel();

  constructor(
    private engineManager: EngineManager,
    private autoApproveSessions: AutoApproveSessionTracker,
    private maxConcurrentTasks = AGENT_TEAM_MAX_CONCURRENT_TASKS,
  ) {}

  /**
   * Run Heavy Brain orchestration:
   * 1. Create orchestrator session
   * 2. Loop: orchestrator dispatches → execute with incremental results → decide next
   * 3. Until orchestrator signals "complete" or max iterations
   */
  async run(
    teamRun: TeamRun,
    orchestratorEngineType: EngineType | undefined,
    onTaskUpdated: (task: TaskNode) => void,
  ): Promise<void> {
    this.cancelled = false;
    this.terminal = false;
    this.nextAutoTaskIndex = teamRun.tasks.length;
    this.activeRun = { teamRun, onTaskUpdated };
    this.activeRunningTasks = null;
    this.cancelledSessionIds.clear();
    this.cancelSignal = new Promise<void>((resolve) => {
      this.resolveCancelSignal = resolve;
    });

    const defaultEngineType = this.engineManager.getDefaultEngineType();
    const engineType = orchestratorEngineType || defaultEngineType;

    try {
      // --- Create orchestrator session ---
      teamRun.status = "planning";
      agentTeamLog.info(`[${teamRun.id}] Heavy Brain: creating orchestrator session on ${engineType}`);

      const engines = this.engineManager.listEngines();
      const prompt = buildOrchestratorPrompt(
        teamRun.originalPrompt,
        engines,
        teamRun.directory,
      );

      // Inject format spec + orchestrator role as system-level prompt.
      const systemPrompt = `${dispatchSkill.formatPrompt}\n\n---\n\n${prompt}`;

      const orchSession = await this.engineManager.createSession(
        engineType,
        teamRun.parentDirectory ?? teamRun.directory,
        teamRun.worktreeId,
        { systemPrompt },
      );
      teamRun.orchestratorSessionId = orchSession.id;
      this.registerAutoApprove(orchSession.id);

      if (this.terminal) {
        return;
      }

      const taskExecutor = new TaskExecutor(
        this.engineManager,
        this.autoApproveSessions,
        defaultEngineType,
      );

      // --- Initial prompt ---
      // Also send as user message for engines that don't support custom system prompts
      const fullPrompt = `${dispatchSkill.formatPrompt}\n\n---\n\n${prompt}`;
      const initialResponse = await this.sendToOrchestrator(orchSession.id, fullPrompt);
      if (!initialResponse || this.terminal) {
        return;
      }
      let response = initialResponse;

      teamRun.status = "running";
      let iterations = 0;

      // --- Orchestration loop ---
      while (iterations++ < MAX_ITERATIONS && !this.terminal) {
        const parsed = await this.parseInstruction(teamRun, orchSession.id, response);
        response = parsed.response;

        if (this.terminal) {
          return;
        }

        if (!parsed.ok) {
          await this.failRun(teamRun, `Orchestrator output format error: ${parsed.error}`, onTaskUpdated);
          return;
        }

        const data = parsed.data;

        // --- Handle "complete" ---
        if (data.action === "complete") {
          await this.completeRun(teamRun, data.result, onTaskUpdated);
          return;
        }

        // --- Handle "dispatch" ---
        if (data.action === "dispatch") {
          const mergeResult = this.mergeDispatchTasks(teamRun, data.tasks, onTaskUpdated);
          if (!mergeResult.ok) {
            await this.failRun(teamRun, `Orchestrator task graph error: ${mergeResult.error}`, onTaskUpdated);
            return;
          }

          agentTeamLog.info(
            `[${teamRun.id}] Heavy Brain: dispatching ${mergeResult.tasks.length} tasks (iteration ${iterations})`,
          );

          // Execute tasks and report results incrementally
          response = await this.executeAndReportIncrementally(
            teamRun,
            orchSession.id,
            taskExecutor,
            onTaskUpdated,
          );

          if (this.isTerminal(response)) {
            return;
          }
        }
      }

      if (this.terminal) {
        return;
      }

      if (this.cancelled) {
        await this.finalizeRun(teamRun, "cancelled", "Orchestration was cancelled.", onTaskUpdated);
      } else {
        await this.failRun(
          teamRun,
          `Orchestration exceeded maximum iterations (${MAX_ITERATIONS}).`,
          onTaskUpdated,
        );
      }
    } finally {
      this.activeRun = null;
      this.activeRunningTasks = null;
      this.resolveCancelSignal = null;
    }
  }

  /**
   * Execute tasks in parallel and report each result to the orchestrator
   * as it completes. User messages (via UserChannel) are prioritized over
   * task results. The orchestrator can:
   * - dispatch new tasks (added to the running set)
   * - signal complete (remaining tasks are cancelled)
   * - acknowledge and wait (continueWaiting)
   *
   * Returns the last orchestrator response for the main loop to parse.
   */
  private async executeAndReportIncrementally(
    teamRun: TeamRun,
    orchSessionId: string,
    executor: TaskExecutor,
    onTaskUpdated: (task: TaskNode) => void,
  ): Promise<UnifiedMessage> {
    const running: RunningTasks = new Map();
    this.activeRunningTasks = running;
    this.propagateBlockedTasks(teamRun, onTaskUpdated);
    this.startReadyTasks(teamRun, running, executor, onTaskUpdated);

    let lastResponse: UnifiedMessage | undefined;

    // Process completions and user messages
    while (running.size > 0 && !this.terminal) {
      // --- Priority 1: check for buffered user message ---
      const pendingUserMsg = this.userChannel.takePending();
      if (pendingUserMsg) {
        const response = await this.sendToOrchestrator(
          orchSessionId,
          formatUserMessage(pendingUserMsg, this.countOpenTasks(teamRun.tasks)),
        );
        if (!response || this.terminal) {
          return this.markTerminal(lastResponse ?? this.createSyntheticMessage(orchSessionId));
        }
        lastResponse = response;
        lastResponse = await this.handleOrchestratorResponse(
          teamRun,
          orchSessionId,
          lastResponse,
          running,
          onTaskUpdated,
        );
        if (this.isTerminal(lastResponse)) return lastResponse;
        this.startReadyTasks(teamRun, running, executor, onTaskUpdated);
        continue;
      }

      // --- Priority 2: race task completions vs user messages ---
      type RaceResult =
        | { type: "task"; id: string; result: TaskExecutionResult }
        | { type: "user"; text: string }
        | { type: "cancel" };

      const taskPromise = raceMap(running).then(
        (result): RaceResult => ({ type: "task", ...result }),
      );
      const userPromise = this.userChannel.waitForMessage().then(
        (text): RaceResult => ({ type: "user", text }),
      );
      const cancelPromise = this.cancelSignal.then(
        (): RaceResult => ({ type: "cancel" }),
      );

      const winner = await Promise.race([userPromise, taskPromise, cancelPromise]);

      if (winner.type === "cancel") {
        return this.markTerminal(lastResponse ?? this.createSyntheticMessage(orchSessionId));
      }

      if (winner.type === "user") {
        // User message arrived — send to orchestrator immediately
        agentTeamLog.info(`[${teamRun.id}] Human feedback received (${running.size} tasks running)`);
        const response = await this.sendToOrchestrator(
          orchSessionId,
          formatUserMessage(winner.text, this.countOpenTasks(teamRun.tasks)),
        );
        if (!response || this.terminal) {
          return this.markTerminal(lastResponse ?? this.createSyntheticMessage(orchSessionId));
        }
        lastResponse = response;
        lastResponse = await this.handleOrchestratorResponse(
          teamRun,
          orchSessionId,
          lastResponse,
          running,
          onTaskUpdated,
        );
        if (this.isTerminal(lastResponse)) return lastResponse;
        this.startReadyTasks(teamRun, running, executor, onTaskUpdated);
        continue;
      }

      // --- Task completed ---
      running.delete(winner.id);

      if (this.terminal) {
        continue;
      }

      // Update task status
      const task = teamRun.tasks.find((candidate) => candidate.id === winner.id);
      if (!task) {
        continue;
      }

      task.time = { ...task.time, completed: Date.now() };
      task.sessionId = winner.result.sessionId;
      if (winner.result.error) {
        task.status = "failed";
        task.error = winner.result.error;
        task.result = winner.result.summary;
      } else {
        task.status = "completed";
        task.result = winner.result.summary;
      }
      onTaskUpdated(task);
      this.propagateBlockedTasks(teamRun, onTaskUpdated);

      agentTeamLog.info(
        `[${teamRun.id}] Task ${winner.id} ${task.status} (${running.size} remaining)`,
      );

      // Send this task's result to orchestrator
      const resultMsg = formatSingleTaskResult(task, this.countOpenTasks(teamRun.tasks));
      const response = await this.sendToOrchestrator(orchSessionId, resultMsg);
      if (!response || this.terminal) {
        return this.markTerminal(lastResponse ?? this.createSyntheticMessage(orchSessionId));
      }
      lastResponse = response;
      lastResponse = await this.handleOrchestratorResponse(
        teamRun,
        orchSessionId,
        lastResponse,
        running,
        onTaskUpdated,
      );
      if (this.isTerminal(lastResponse)) return lastResponse;
      this.startReadyTasks(teamRun, running, executor, onTaskUpdated);
    }

    if (this.terminal) {
      return this.markTerminal(lastResponse ?? this.createSyntheticMessage(orchSessionId));
    }

    // All tasks done — send final summary for orchestrator to decide
    const summaryText = formatTaskResults(teamRun);
    const response = await this.sendToOrchestrator(orchSessionId, summaryText);
    if (!response) {
      return this.markTerminal(lastResponse ?? this.createSyntheticMessage(orchSessionId));
    }

    return response;
  }

  /**
   * Send a message to the orchestrator and return the response.
   */
  private async sendToOrchestrator(
    orchSessionId: string,
    text: string,
  ): Promise<UnifiedMessage | null> {
    const responsePromise = this.engineManager.sendMessage(orchSessionId, [
      { type: "text", text },
    ]);

    const guardedResponse = responsePromise.catch((error) => {
      if (this.cancelled || this.terminal) {
        agentTeamLog.debug(
          `[${orchSessionId}] Ignoring orchestrator response after cancellation: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
      throw error;
    });

    const winner = await Promise.race([
      guardedResponse.then((response) => ({ type: "response" as const, response })),
      this.cancelSignal.then(() => ({ type: "cancel" as const })),
    ]);

    if (winner.type === "cancel") {
      return null;
    }

    return winner.response;
  }

  /**
   * Parse an orchestrator response and handle dispatch/complete actions.
   * Returns the (possibly updated) lastResponse. Mutates `running` if new
   * tasks are dispatched or remaining tasks are cancelled.
   */
  private async handleOrchestratorResponse(
    teamRun: TeamRun,
    orchSessionId: string,
    lastResponse: UnifiedMessage,
    running: RunningTasks,
    onTaskUpdated: (task: TaskNode) => void,
  ): Promise<UnifiedMessage> {
    const parsed = await this.parseInstruction(teamRun, orchSessionId, lastResponse);
    lastResponse = parsed.response;

    if (this.terminal) {
      return this.markTerminal(lastResponse);
    }

    if (!parsed.ok) {
      await this.failRun(teamRun, `Orchestrator output format error: ${parsed.error}`, onTaskUpdated);
      running.clear();
      return this.markTerminal(lastResponse);
    }

    if (parsed.data.action === "complete") {
      await this.completeRun(teamRun, parsed.data.result, onTaskUpdated);
      running.clear();
      return this.markTerminal(lastResponse);
    }

    if (parsed.data.action === "dispatch") {
      const mergeResult = this.mergeDispatchTasks(teamRun, parsed.data.tasks, onTaskUpdated);
      if (!mergeResult.ok) {
        await this.failRun(teamRun, `Orchestrator task graph error: ${mergeResult.error}`, onTaskUpdated);
        running.clear();
        return this.markTerminal(lastResponse);
      }

      agentTeamLog.info(
        `[${teamRun.id}] Orchestrator dispatched ${mergeResult.tasks.length} new tasks mid-execution`,
      );
    }

    return lastResponse;
  }

  /** Check if the orchestrator signaled completion */
  private isTerminal(response: UnifiedMessage): boolean {
    return !!(response as TerminalMessage)._terminal;
  }

  async cancel(): Promise<void> {
    if (this.terminal) {
      return;
    }

    this.cancelled = true;
    this.userChannel.dispose();
    this.resolveCancelSignal?.();

    const activeRun = this.activeRun;
    if (!activeRun) {
      this.terminal = true;
      return;
    }

    if (activeRun.teamRun.orchestratorSessionId) {
      await this.cancelSession(
        activeRun.teamRun.orchestratorSessionId,
        `run ${activeRun.teamRun.id} orchestrator`,
      );
    }

    await this.finalizeRun(
      activeRun.teamRun,
      "cancelled",
      "Orchestration was cancelled.",
      activeRun.onTaskUpdated,
    );
  }

  private convertDispatchTasks(tasks: DispatchTask[], defaultWorktreeId?: string): TaskNode[] {
    return tasks.map((t): TaskNode => ({
      id: t.id || `task_${this.nextAutoTaskIndex++}`,
      description: t.description,
      prompt: t.prompt,
      engineType: t.engineType as EngineType | undefined,
      dependsOn: t.dependsOn || [],
      worktreeId: t.worktreeId ?? defaultWorktreeId,
      status: "pending",
    }));
  }

  private registerAutoApprove(sessionId: string): void {
    trackAutoApproveSession(this.autoApproveSessions, sessionId);
  }

  private async parseInstruction(
    teamRun: TeamRun,
    orchSessionId: string,
    response: UnifiedMessage,
  ): Promise<ParseInstructionResult> {
    const responseText = extractTextFromMessage(response);
    let instruction = dispatchSkill.parse(responseText);

    if (instruction.ok) {
      return { ok: true, data: instruction.data, response };
    }

    agentTeamLog.warn(
      `[${teamRun.id}] Orchestrator response not valid JSON: ${instruction.error}`,
    );

    const correction = dispatchSkill.correctionPrompt(responseText, instruction.error);
    const retryResponse = await this.sendToOrchestrator(orchSessionId, correction);
    if (!retryResponse) {
      return { ok: false, error: "Orchestration was cancelled.", response };
    }

    instruction = dispatchSkill.parse(extractTextFromMessage(retryResponse));
    if (!instruction.ok) {
      return { ok: false, error: instruction.error, response: retryResponse };
    }

    return { ok: true, data: instruction.data, response: retryResponse };
  }

  private mergeDispatchTasks(
    teamRun: TeamRun,
    tasks: DispatchTask[],
    onTaskUpdated: (task: TaskNode) => void,
  ): MergeDispatchTasksResult {
    const newTasks = this.convertDispatchTasks(tasks, teamRun.worktreeId);
    const validation = this.validateMergedTasks(teamRun.tasks, newTasks);
    if (!validation.ok) {
      return validation;
    }

    teamRun.tasks.push(...newTasks);
    for (const task of newTasks) {
      onTaskUpdated(task);
    }
    this.propagateBlockedTasks(teamRun, onTaskUpdated);

    return { ok: true, tasks: newTasks };
  }

  private validateMergedTasks(
    existingTasks: TaskNode[],
    newTasks: TaskNode[],
  ): MergeDispatchTasksResult {
    const combined = [...existingTasks, ...newTasks];
    const ids = new Set<string>();
    const errors: string[] = [];

    for (const task of combined) {
      if (ids.has(task.id)) {
        errors.push(`Duplicate task id '${task.id}'`);
      } else {
        ids.add(task.id);
      }
    }

    for (const task of combined) {
      for (const depId of task.dependsOn) {
        if (!ids.has(depId)) {
          errors.push(`Task '${task.id}' dependsOn unknown task '${depId}'`);
        }
      }
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();
    const taskMap = new Map(combined.map((task) => [task.id, task]));

    const hasCycle = (taskId: string): boolean => {
      if (inStack.has(taskId)) return true;
      if (visited.has(taskId)) return false;

      visited.add(taskId);
      inStack.add(taskId);

      const task = taskMap.get(taskId);
      if (task) {
        for (const depId of task.dependsOn) {
          if (hasCycle(depId)) return true;
        }
      }

      inStack.delete(taskId);
      return false;
    };

    for (const taskId of ids) {
      if (hasCycle(taskId)) {
        errors.push("Circular dependency detected in task graph");
        break;
      }
    }

    if (errors.length > 0) {
      return { ok: false, error: errors.join("; ") };
    }

    return { ok: true, tasks: newTasks };
  }

  private propagateBlockedTasks(
    teamRun: TeamRun,
    onTaskUpdated: (task: TaskNode) => void,
  ): void {
    const blockedTasks = DAGExecutor.propagateFailures(teamRun.tasks);
    for (const task of blockedTasks) {
      task.time = { ...task.time, completed: task.time?.completed ?? Date.now() };
      onTaskUpdated(task);
    }
  }

  private startReadyTasks(
    teamRun: TeamRun,
    running: RunningTasks,
    executor: TaskExecutor,
    onTaskUpdated: (task: TaskNode) => void,
  ): void {
    const capacity = Math.max(this.maxConcurrentTasks - running.size, 0);
    if (capacity === 0) {
      return;
    }

    const readyTasks = DAGExecutor.findReadyTasks(teamRun.tasks).slice(0, capacity);

    for (const task of readyTasks) {
      const dependencies = task.dependsOn
        .map((depId) => teamRun.tasks.find((candidate) => candidate.id === depId))
        .filter((candidate): candidate is TaskNode => candidate != null);

      const upstreamContext = TaskExecutor.buildUpstreamContext(dependencies);

      task.status = "running";
      task.time = { ...task.time, started: Date.now() };
      onTaskUpdated(task);

      let state!: RunningTaskState;
      const promise = executor.execute(task, teamRun.parentDirectory ?? teamRun.directory, {
        upstreamContext,
        defaultWorktreeId: teamRun.worktreeId,
        onSessionCreated: (sessionId) => {
          state.sessionId = sessionId;
          if (this.cancelled || this.terminal) {
            void this.cancelSession(sessionId, `task ${task.id}`);
          }
        },
        shouldCancel: () => this.cancelled || this.terminal,
      });
      state = { promise };
      running.set(task.id, state);
    }
  }

  private countOpenTasks(tasks: TaskNode[]): number {
    return tasks.filter((task) => task.status === "pending" || task.status === "running").length;
  }

  private async completeRun(
    teamRun: TeamRun,
    result: string,
    onTaskUpdated: (task: TaskNode) => void,
  ): Promise<void> {
    if (await this.finalizeRun(teamRun, "completed", result, onTaskUpdated)) {
      agentTeamLog.info(`[${teamRun.id}] Heavy Brain: orchestrator signaled complete`);
    }
  }

  private async failRun(
    teamRun: TeamRun,
    message: string,
    onTaskUpdated: (task: TaskNode) => void,
  ): Promise<void> {
    if (await this.finalizeRun(teamRun, "failed", message, onTaskUpdated)) {
      agentTeamLog.error(`[${teamRun.id}] Heavy Brain: ${message}`);
    }
  }

  private markTerminal(response: UnifiedMessage): UnifiedMessage {
    (response as TerminalMessage)._terminal = true;
    return response;
  }

  private async finalizeRun(
    teamRun: TeamRun,
    status: TeamRun["status"],
    result: string,
    onTaskUpdated: (task: TaskNode) => void,
  ): Promise<boolean> {
    if (this.terminal) {
      return false;
    }

    this.terminal = true;
    this.resolveCancelSignal?.();
    await this.cancelOutstandingTasks(teamRun, onTaskUpdated);
    teamRun.status = status;
    teamRun.finalResult = result;
    teamRun.time.completed = Date.now();
    return true;
  }

  private async cancelOutstandingTasks(
    teamRun: TeamRun,
    onTaskUpdated: (task: TaskNode) => void,
  ): Promise<void> {
    const cancellationPromises: Promise<void>[] = [];

    for (const task of teamRun.tasks) {
      if (task.status === "running") {
        const sessionId = this.activeRunningTasks?.get(task.id)?.sessionId ?? task.sessionId;
        if (sessionId) {
          cancellationPromises.push(this.cancelSession(sessionId, `task ${task.id}`));
        }
      }

      if (task.status !== "pending" && task.status !== "running") {
        continue;
      }

      task.status = "cancelled";
      task.time = { ...task.time, completed: task.time?.completed ?? Date.now() };
      onTaskUpdated(task);
    }

    await Promise.all(cancellationPromises);
  }

  private async cancelSession(sessionId: string, label: string): Promise<void> {
    if (this.cancelledSessionIds.has(sessionId)) {
      return;
    }

    this.cancelledSessionIds.add(sessionId);
    try {
      await this.engineManager.cancelMessage(sessionId);
    } catch (error) {
      agentTeamLog.warn(
        `[${label}] Failed to cancel session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private createSyntheticMessage(sessionId: string): UnifiedMessage {
    return {
      id: `team-terminal-${Date.now()}`,
      sessionId,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      parts: [],
    };
  }
}
