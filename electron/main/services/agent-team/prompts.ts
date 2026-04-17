// ============================================================================
// Prompt Templates — Engine-agnostic prompts for agent team orchestration
// ============================================================================

import type { EngineInfo, TeamRun } from "../../../../src/types/unified";

/**
 * Format available engines list for inclusion in prompts.
 */
export function formatEngineList(engines: EngineInfo[]): string {
  const running = engines.filter((e) => e.status === "running");
  if (running.length === 0) return "No engines currently available.";

  return running
    .map((e) => `- ${e.type}: ${e.name}${e.version ? ` v${e.version}` : ""}`)
    .join("\n");
}

/**
 * Build the planning prompt for Light Brain DAG generation.
 * The dagPlanningSkill.formatPrompt is prepended by executeWithSkill().
 */
export function buildPlanningPrompt(
  userRequest: string,
  engines: EngineInfo[],
  directory: string,
): string {
  return `You are a task planner for a multi-engine AI coding assistant. Your job is to decompose the user's request into a directed acyclic graph (DAG) of subtasks that can be executed by different AI engines.

## Available Engines
${formatEngineList(engines)}

## Project Directory
${directory}

## Guidelines
- Break complex tasks into smaller, focused subtasks
- Use dependsOn to express task ordering (parallel tasks have no dependency)
- Each task's prompt must be self-contained — the worker agent cannot see other tasks or the original request
- Include enough context in each prompt for the worker to succeed independently
- If a task produces output needed by a downstream task, mention what the downstream task should expect in its prompt
- Choose engines based on their strengths if applicable, or omit engineType to use the default

## User Request
${userRequest}`;
}

/**
 * Build the initial prompt for Heavy Brain orchestrator.
 * The dispatchSkill.formatPrompt is prepended by executeWithSkill().
 */
export function buildOrchestratorPrompt(
  userRequest: string,
  engines: EngineInfo[],
  directory: string,
): string {
  return `You are an orchestration supervisor managing a team of AI coding agents. You break down complex tasks, dispatch them to worker agents, review results, and coordinate follow-up work.

## Available Engines
${formatEngineList(engines)}

## Project Directory
${directory}

## How It Works
1. You dispatch tasks to worker agents using the JSON protocol above
2. After workers complete, you receive their results as the next message
3. Review results and decide: dispatch more tasks, or mark complete
4. You can dispatch multiple rounds of tasks — each round can depend on prior results

## Guidelines
- Start by analyzing the request and dispatching initial tasks
- Each worker runs in an isolated session — include all necessary context in the prompt
- If a worker fails, you can retry with a modified prompt or different engine
- When all work is done, use the "complete" action with a comprehensive summary

## User Request
${userRequest}`;
}

/**
 * Format task results for injection back into the orchestrator (Heavy Brain).
 */
export function formatTaskResults(run: TeamRun): string {
  const lines: string[] = ["## Task Execution Results\n"];

  for (const task of run.tasks) {
    if (task.status === "completed") {
      const duration = task.time?.started && task.time?.completed
        ? `${((task.time.completed - task.time.started) / 1000).toFixed(1)}s`
        : "";
      lines.push(`### ${task.id}: "${task.description}" [COMPLETED]${duration ? ` (${duration})` : ""}`);
      lines.push(task.result || "(no output)");
      lines.push("");
    } else if (task.status === "failed") {
      lines.push(`### ${task.id}: "${task.description}" [FAILED]`);
      lines.push(`Error: ${task.error || "unknown error"}`);
      lines.push("");
    } else if (task.status === "blocked") {
      lines.push(`### ${task.id}: "${task.description}" [BLOCKED]`);
      lines.push(`Blocked by failed upstream task.`);
      lines.push("");
    }
  }

  const completed = run.tasks.filter((t) => t.status === "completed").length;
  const failed = run.tasks.filter((t) => t.status === "failed").length;
  const total = run.tasks.length;
  lines.push(`---\n${completed}/${total} tasks completed${failed > 0 ? `, ${failed} failed` : ""}. What would you like to do next?`);

  return lines.join("\n");
}
