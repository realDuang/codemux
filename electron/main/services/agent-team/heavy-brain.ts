// ============================================================================
// Heavy Brain — Continuous LLM supervisor orchestration
// A long-running orchestrator session dispatches tasks and adapts dynamically.
// ============================================================================

import type { EngineManager } from "../../gateway/engine-manager";
import type { TaskNode, TeamRun, EngineType } from "../../../../src/types/unified";
import { DAGExecutor } from "./dag-executor";
import { TaskExecutor, extractTextFromMessage } from "./task-executor";
import { dispatchSkill, type DispatchInstruction, type DispatchTask } from "./skills";
import { buildOrchestratorPrompt, formatTaskResults } from "./prompts";
import { agentTeamLog } from "./logger";

/** Maximum orchestration iterations to prevent infinite loops */
const MAX_ITERATIONS = 20;

export class HeavyBrainOrchestrator {
  private cancelled = false;

  constructor(
    private engineManager: EngineManager,
    private autoApproveSessions: Set<string>,
  ) {}

  /**
   * Run Heavy Brain orchestration:
   * 1. Create orchestrator session
   * 2. Loop: orchestrator dispatches → execute → send results back
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

    const orchSession = await this.engineManager.createSession(engineType, teamRun.directory);
    teamRun.orchestratorSessionId = orchSession.id;
    this.registerAutoApprove(orchSession.id);

    const engines = this.engineManager.listEngines();
    const taskExecutor = new TaskExecutor(
      this.engineManager,
      this.autoApproveSessions,
      defaultEngineType,
    );
    const dagExecutor = new DAGExecutor(taskExecutor, teamRun.directory);
    dagExecutor.on("task.updated", ({ task }) => onTaskUpdated(task));

    // --- Initial prompt ---
    const prompt = buildOrchestratorPrompt(
      teamRun.originalPrompt,
      engines,
      teamRun.directory,
    );

    // First message: skill format + orchestrator prompt
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
        // Add new tasks to the DAG
        const newTasks = this.convertDispatchTasks(data.tasks, taskCounter);
        taskCounter += newTasks.length;
        teamRun.tasks.push(...newTasks);

        agentTeamLog.info(
          `[${teamRun.id}] Heavy Brain: dispatching ${newTasks.length} tasks (iteration ${iterations})`,
        );

        // Execute ready tasks
        await dagExecutor.executeReadyTasks(teamRun);

        // Send results back to orchestrator
        const resultsText = formatTaskResults(teamRun);
        response = await this.engineManager.sendMessage(orchSession.id, [
          { type: "text", text: resultsText },
        ]);
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
   * Signal cancellation of the orchestration loop.
   */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Convert dispatch tasks to TaskNode format.
   */
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
