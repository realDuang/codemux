// ============================================================================
// Heavy Brain — Continuous LLM supervisor orchestration
// A long-running orchestrator session dispatches tasks and adapts dynamically.
// Results are reported incrementally as each task completes.
// ============================================================================

import type { EngineManager } from "../../gateway/engine-manager";
import type { TaskNode, TeamRun, EngineType } from "../../../../src/types/unified";
import { TaskExecutor, extractTextFromMessage, type TaskExecutionResult } from "./task-executor";
import { dispatchSkill, type DispatchTask } from "./skills";
import { buildOrchestratorPrompt, formatSingleTaskResult, formatTaskResults, formatUserMessage } from "./prompts";
import { agentTeamLog } from "./logger";
import { UserChannel } from "./user-channel";

/** Maximum orchestration iterations to prevent infinite loops */
const MAX_ITERATIONS = 20;

/**
 * Race a Map of promises: resolves with the first one to settle.
 * Returns the key and result; the remaining promises keep running.
 */
function raceMap<T>(map: Map<string, Promise<T>>): Promise<{ id: string; result: T }> {
  return Promise.race(
    Array.from(map.entries()).map(([id, p]) =>
      p.then(
        (result) => ({ id, result }),
        (err) => ({ id, result: { sessionId: "", summary: "", error: err?.message ?? String(err) } as unknown as T }),
      ),
    ),
  );
}

export class HeavyBrainOrchestrator {
  private cancelled = false;
  /** Shared user message channel — external code calls userChannel.send() */
  readonly userChannel = new UserChannel();

  constructor(
    private engineManager: EngineManager,
    private autoApproveSessions: Set<string>,
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
    const defaultEngineType = this.engineManager.getDefaultEngineType();
    const engineType = orchestratorEngineType || defaultEngineType;

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
      teamRun.directory,
      undefined,
      { systemPrompt },
    );
    teamRun.orchestratorSessionId = orchSession.id;
    this.registerAutoApprove(orchSession.id);

    const taskExecutor = new TaskExecutor(
      this.engineManager,
      this.autoApproveSessions,
      defaultEngineType,
    );

    // --- Initial prompt ---
    // Also send as user message for engines that don't support custom system prompts
    const fullPrompt = `${dispatchSkill.formatPrompt}\n\n---\n\n${prompt}`;
    let response = await this.engineManager.sendMessage(orchSession.id, [
      { type: "text", text: fullPrompt },
    ]);

    teamRun.status = "running";
    let iterations = 0;
    let taskCounter = teamRun.tasks.length;

    // --- Orchestration loop ---
    while (iterations++ < MAX_ITERATIONS && !this.cancelled) {
      const responseText = extractTextFromMessage(response);
      let instruction = dispatchSkill.parse(responseText);

      // If parse failed, try correction
      if (!instruction.ok) {
        agentTeamLog.warn(
          `[${teamRun.id}] Heavy Brain: parse failed (attempt ${iterations}): ${instruction.error}`,
        );
        const correction = dispatchSkill.correctionPrompt(responseText, instruction.error);
        response = await this.engineManager.sendMessage(orchSession.id, [
          { type: "text", text: correction },
        ]);
        instruction = dispatchSkill.parse(extractTextFromMessage(response));

        if (!instruction.ok) {
          agentTeamLog.error(`[${teamRun.id}] Heavy Brain: parse failed after correction: ${instruction.error}`);
          teamRun.status = "failed";
          teamRun.finalResult = `Orchestrator output format error: ${instruction.error}`;
          teamRun.time.completed = Date.now();
          return;
        }
      }

      const data = instruction.data;

      // --- Handle "complete" ---
      if (data.action === "complete") {
        teamRun.status = "completed";
        teamRun.finalResult = data.result;
        teamRun.time.completed = Date.now();
        agentTeamLog.info(`[${teamRun.id}] Heavy Brain: orchestrator signaled complete`);
        return;
      }

      // --- Handle "dispatch" ---
      if (data.action === "dispatch") {
        const newTasks = this.convertDispatchTasks(data.tasks, taskCounter);
        taskCounter += newTasks.length;
        teamRun.tasks.push(...newTasks);

        agentTeamLog.info(
          `[${teamRun.id}] Heavy Brain: dispatching ${newTasks.length} tasks (iteration ${iterations})`,
        );

        // Execute tasks and report results incrementally
        response = await this.executeAndReportIncrementally(
          teamRun,
          newTasks,
          orchSession.id,
          taskExecutor,
          onTaskUpdated,
        );
      }
    }

    // --- Max iterations or cancelled ---
    if (this.cancelled) {
      teamRun.status = "cancelled";
      teamRun.finalResult = "Orchestration was cancelled.";
    } else {
      teamRun.status = "failed";
      teamRun.finalResult = `Orchestration exceeded maximum iterations (${MAX_ITERATIONS}).`;
    }
    teamRun.time.completed = Date.now();
    agentTeamLog.info(`[${teamRun.id}] Heavy Brain: ${teamRun.status}`);
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
    initialTasks: TaskNode[],
    orchSessionId: string,
    executor: TaskExecutor,
    onTaskUpdated: (task: TaskNode) => void,
  ): Promise<import("../../../../src/types/unified").UnifiedMessage> {
    // Start all tasks in parallel
    const running = new Map<string, Promise<TaskExecutionResult>>();
    for (const task of initialTasks) {
      task.status = "running";
      task.time = { started: Date.now() };
      onTaskUpdated(task);
      running.set(task.id, executor.execute(task, teamRun.directory));
    }

    let lastResponse: import("../../../../src/types/unified").UnifiedMessage;

    // Process completions and user messages
    while (running.size > 0 && !this.cancelled) {
      // --- Priority 1: check for buffered user message ---
      const pendingUserMsg = this.userChannel.takePending();
      if (pendingUserMsg) {
        lastResponse = await this.sendToOrchestrator(
          teamRun, orchSessionId,
          formatUserMessage(pendingUserMsg, running.size),
        );
        lastResponse = await this.handleOrchestratorResponse(
          teamRun, orchSessionId, lastResponse, running, executor, onTaskUpdated,
        );
        if (this.isTerminal(lastResponse)) return lastResponse;
        continue;
      }

      // --- Priority 2: race task completions vs user messages ---
      type RaceResult =
        | { type: "task"; id: string; result: TaskExecutionResult }
        | { type: "user"; text: string };

      const taskPromise = raceMap(running).then(
        (r): RaceResult => ({ type: "task", ...r }),
      );
      const userPromise = this.userChannel.waitForMessage().then(
        (text): RaceResult => ({ type: "user", text }),
      );

      const winner = await Promise.race([userPromise, taskPromise]);

      if (winner.type === "user") {
        // User message arrived — send to orchestrator immediately
        agentTeamLog.info(`[${teamRun.id}] Human feedback received (${running.size} tasks running)`);
        lastResponse = await this.sendToOrchestrator(
          teamRun, orchSessionId,
          formatUserMessage(winner.text, running.size),
        );
        lastResponse = await this.handleOrchestratorResponse(
          teamRun, orchSessionId, lastResponse, running, executor, onTaskUpdated,
        );
        if (this.isTerminal(lastResponse)) return lastResponse;
        continue;
      }

      // --- Task completed ---
      running.delete(winner.id);

      // Update task status
      const task = teamRun.tasks.find((t) => t.id === winner.id);
      if (task) {
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

        agentTeamLog.info(
          `[${teamRun.id}] Task ${winner.id} ${task.status} (${running.size} remaining)`,
        );
      }

      // Send this task's result to orchestrator
      const resultMsg = formatSingleTaskResult(task!, running.size);
      lastResponse = await this.sendToOrchestrator(teamRun, orchSessionId, resultMsg);
      lastResponse = await this.handleOrchestratorResponse(
        teamRun, orchSessionId, lastResponse, running, executor, onTaskUpdated,
      );
      if (this.isTerminal(lastResponse)) return lastResponse;
    }

    // All tasks done — send final summary for orchestrator to decide
    const summaryText = formatTaskResults(teamRun);
    lastResponse = await this.engineManager.sendMessage(orchSessionId, [
      { type: "text", text: summaryText },
    ]);

    return lastResponse!;
  }

  /**
   * Send a message to the orchestrator and return the response.
   */
  private async sendToOrchestrator(
    teamRun: TeamRun,
    orchSessionId: string,
    text: string,
  ): Promise<import("../../../../src/types/unified").UnifiedMessage> {
    return this.engineManager.sendMessage(orchSessionId, [
      { type: "text", text },
    ]);
  }

  /**
   * Parse an orchestrator response and handle dispatch/complete actions.
   * Returns the (possibly updated) lastResponse. Mutates `running` if new
   * tasks are dispatched or remaining tasks are cancelled.
   */
  private async handleOrchestratorResponse(
    teamRun: TeamRun,
    orchSessionId: string,
    lastResponse: import("../../../../src/types/unified").UnifiedMessage,
    running: Map<string, Promise<TaskExecutionResult>>,
    executor: TaskExecutor,
    onTaskUpdated: (task: TaskNode) => void,
  ): Promise<import("../../../../src/types/unified").UnifiedMessage> {
    const responseText = extractTextFromMessage(lastResponse);
    let instruction = dispatchSkill.parse(responseText);

    // If parse failed, try correction (strict protocol: no free-text allowed)
    if (!instruction.ok) {
      agentTeamLog.warn(
        `[${teamRun.id}] Orchestrator response not valid JSON: ${instruction.error}`,
      );
      const correction = dispatchSkill.correctionPrompt(responseText, instruction.error);
      const retryResponse = await this.engineManager.sendMessage(orchSessionId, [
        { type: "text", text: correction },
      ]);
      lastResponse = retryResponse;
      instruction = dispatchSkill.parse(extractTextFromMessage(retryResponse));
      if (!instruction.ok) {
        agentTeamLog.warn(
          `[${teamRun.id}] Orchestrator correction also failed: ${instruction.error}`,
        );
        return lastResponse;
      }
    }

    if (instruction.data.action === "complete") {
      // Cancel remaining tasks
      for (const remainId of running.keys()) {
        const t = teamRun.tasks.find((t) => t.id === remainId);
        if (t) {
          t.status = "cancelled";
          t.time = { ...t.time, completed: Date.now() };
          onTaskUpdated(t);
        }
      }
      running.clear();
      // Mark as terminal via _terminal flag so the caller knows to return
      (lastResponse as any)._terminal = true;
      return lastResponse;
    }

    if (instruction.data.action === "dispatch") {
      const newTasks = this.convertDispatchTasks(
        instruction.data.tasks,
        teamRun.tasks.length,
      );
      teamRun.tasks.push(...newTasks);
      for (const t of newTasks) {
        t.status = "running";
        t.time = { started: Date.now() };
        onTaskUpdated(t);
        running.set(t.id, executor.execute(t, teamRun.directory));
      }
      agentTeamLog.info(
        `[${teamRun.id}] Orchestrator dispatched ${newTasks.length} new tasks mid-execution`,
      );
    }

    // action === "continueWaiting" → keep waiting
    return lastResponse;
  }

  /** Check if the orchestrator signaled completion */
  private isTerminal(response: import("../../../../src/types/unified").UnifiedMessage): boolean {
    return !!(response as any)._terminal;
  }

  cancel(): void {
    this.cancelled = true;
    this.userChannel.dispose();
  }

  private convertDispatchTasks(tasks: DispatchTask[], startIndex: number): TaskNode[] {
    return tasks.map((t, i): TaskNode => ({
      id: t.id || `task_${startIndex + i}`,
      description: t.description,
      prompt: t.prompt,
      engineType: t.engineType as EngineType | undefined,
      dependsOn: t.dependsOn || [],
      status: "pending",
    }));
  }

  private registerAutoApprove(sessionId: string): void {
    if (this.autoApproveSessions.size > 200) {
      const recent = [...this.autoApproveSessions].slice(-100);
      this.autoApproveSessions.clear();
      for (const id of recent) this.autoApproveSessions.add(id);
    }
    this.autoApproveSessions.add(sessionId);
  }
}
