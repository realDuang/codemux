// ============================================================================
// Light Brain — Deterministic DAG orchestration
// One LLM call to generate the DAG, then a Node.js state machine executes it.
// ============================================================================

import type { EngineManager } from "../../gateway/engine-manager";
import type { TaskNode, TeamRun, EngineType, EngineInfo } from "../../../../src/types/unified";
import { DAGExecutor } from "./dag-executor";
import { TaskExecutor, extractTextFromMessage } from "./task-executor";
import { dagPlanningSkill, executeWithSkill, type RawTaskNode } from "./skills";
import { buildPlanningPrompt } from "./prompts";
import { agentTeamLog } from "./logger";

export class LightBrainOrchestrator {
  constructor(
    private engineManager: EngineManager,
    private autoApproveSessions: Set<string>,
  ) {}

  /**
   * Run Light Brain orchestration:
   * 1. Planning call (LLM generates DAG)
   * 2. Deterministic execution (DAG state machine)
   */
  async run(
    teamRun: TeamRun,
    onTaskUpdated: (task: TaskNode) => void,
  ): Promise<void> {
    const defaultEngineType = this.engineManager.getDefaultEngineType();
    const plannerEngineType = (teamRun.mode === "light" ? defaultEngineType : defaultEngineType) as EngineType;

    // --- Phase 1: Planning ---
    teamRun.status = "planning";
    agentTeamLog.info(`[${teamRun.id}] Light Brain: planning phase`);

    const engines = this.engineManager.listEngines();
    const tasks = await this.generateDAG(teamRun, plannerEngineType, engines);

    // Convert raw tasks to TaskNodes
    teamRun.tasks = tasks.map((raw): TaskNode => ({
      id: raw.id,
      description: raw.description,
      prompt: raw.prompt,
      engineType: raw.engineType as EngineType | undefined,
      dependsOn: raw.dependsOn,
      status: "pending",
    }));

    agentTeamLog.info(`[${teamRun.id}] Light Brain: DAG generated with ${teamRun.tasks.length} tasks`);

    // --- Phase 2: Execution ---
    teamRun.status = "running";

    const taskExecutor = new TaskExecutor(
      this.engineManager,
      this.autoApproveSessions,
      defaultEngineType,
    );
    const dagExecutor = new DAGExecutor(taskExecutor, teamRun.directory);

    // Forward task update events
    dagExecutor.on("task.updated", ({ task }) => onTaskUpdated(task));

    await dagExecutor.executeReadyTasks(teamRun);

    // --- Phase 3: Determine final status ---
    if (DAGExecutor.isAllSuccessful(teamRun.tasks)) {
      teamRun.status = "completed";
      teamRun.finalResult = this.synthesizeResult(teamRun);
    } else {
      teamRun.status = "failed";
      const failed = teamRun.tasks.filter((t) => t.status === "failed");
      teamRun.finalResult = `${failed.length} task(s) failed: ${failed.map((t) => t.description).join(", ")}`;
    }

    teamRun.time.completed = Date.now();
    agentTeamLog.info(`[${teamRun.id}] Light Brain: ${teamRun.status}`);
  }

  /**
   * Generate the task DAG using a planning LLM call with dagPlanningSkill.
   */
  private async generateDAG(
    teamRun: TeamRun,
    plannerEngineType: EngineType,
    engines: EngineInfo[],
  ): Promise<RawTaskNode[]> {
    // Create a temporary planning session
    // Inject format spec + planner role as system-level prompt for engines
    // that support it (e.g. Copilot). Also sent as user message for compatibility.
    const prompt = buildPlanningPrompt(
      teamRun.originalPrompt,
      engines,
      teamRun.directory,
    );
    const systemPrompt = `${dagPlanningSkill.formatPrompt}\n\n---\n\n${prompt}`;

    const planSession = await this.engineManager.createSession(
      plannerEngineType,
      teamRun.directory,
      undefined,
      { systemPrompt },
    );

    // Register for auto-approve
    if (this.autoApproveSessions.size > 200) {
      const recent = [...this.autoApproveSessions].slice(-100);
      this.autoApproveSessions.clear();
      for (const id of recent) this.autoApproveSessions.add(id);
    }
    this.autoApproveSessions.add(planSession.id);

    // Execute with skill (includes format spec + self-check + retry)
    const sendMessage = async (text: string): Promise<string> => {
      const msg = await this.engineManager.sendMessage(planSession.id, [
        { type: "text", text },
      ]);
      agentTeamLog.info(`[${teamRun.id}] sendMessage returned: role=${msg.role}, parts=${JSON.stringify(msg.parts?.map(p => ({ type: p.type, textLen: (p as any).text?.length })))}`);
      const extracted = extractTextFromMessage(msg);
      agentTeamLog.info(`[${teamRun.id}] extractTextFromMessage: ${extracted.length} chars`);
      if (extracted.length === 0) {
        agentTeamLog.warn(`[${teamRun.id}] Empty text! Full message: ${JSON.stringify(msg).slice(0, 1000)}`);
      }
      return extracted;
    };

    const result = await executeWithSkill(sendMessage, prompt, dagPlanningSkill, 1, agentTeamLog);

    if (!result.ok) {
      throw new Error(`DAG planning failed: ${result.error}`);
    }

    return result.data.tasks;
  }

  /**
   * Simple synthesis: concatenate all task results.
   */
  private synthesizeResult(teamRun: TeamRun): string {
    const results = teamRun.tasks
      .filter((t) => t.status === "completed" && t.result)
      .map((t) => `[${t.description}]: ${t.result}`);
    return results.join("\n\n");
  }
}
