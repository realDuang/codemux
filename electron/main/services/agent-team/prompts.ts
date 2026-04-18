// ============================================================================
// Prompt Templates — Engine-agnostic prompts for agent team orchestration
// ============================================================================

import type { EngineInfo, TaskNode, TeamRun } from "../../../../src/types/unified";

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
  return `You are a **task decomposition agent**. Your only job is to analyze the user's request and output a JSON task plan. You do NOT execute any tasks yourself. You do NOT spawn subagents.

An **external orchestration system** will read your JSON output, create separate sessions on other machines, and run each task independently.

## Important
- You are producing a **plan**, not executing it. Do not attempt to carry out any tasks or spawn subagents.
- Your output will be machine-parsed. The external system creates separate agent sessions for each task and sends them the prompt you write.
- You may use tools to explore the project structure if that helps you write better task prompts, but your **final answer** must be the JSON task plan described in the Output Format above.

## Available Worker Engines
${formatEngineList(engines)}

## Project Directory
${directory}

## Planning Guidelines
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
  return `You are a **task decomposition and review agent**. Your only job is to break down work into subtasks by outputting JSON, then review results returned to you.

You do NOT execute any tasks yourself. You do NOT spawn subagents. You do NOT call tools to perform the work. An **external orchestration system** reads the JSON you output, creates separate sessions on other machines, and runs each task independently. You will receive the results as your next message.

## Your Workflow
1. Analyze the user request — you may use tools (read files, search code) to understand the project and write better task descriptions
2. Output a JSON block describing subtasks (see Communication Protocol above) — the external system handles execution
3. Results arrive incrementally — you receive each task's result as a separate message as soon as it completes
4. After each result, you can: output a "dispatch" JSON to add more tasks, output a "complete" JSON to finish early, or output "continueWaiting" to wait for more results
5. You may receive **human feedback** at any time — it takes priority over task results. Read it carefully and adjust your plan accordingly.
6. After all tasks finish, decide: dispatch another round of tasks, or output "complete" with a summary

## Important Constraints
- **Never do the work yourself** — your role is solely to decide WHAT needs to be done and write task descriptions
- **Never spawn subagents or delegate via tools** — only output JSON; the external system handles all execution
- Your JSON output is machine-parsed, not human-read

## Available Worker Engines
${formatEngineList(engines)}

## Project Directory
${directory}

## Task Design Guidelines
- Each task runs in an isolated session with no shared context — include all necessary information in the task prompt
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

/**
 * Format a single completed task result for incremental reporting (Heavy Brain).
 */
export function formatSingleTaskResult(task: TaskNode, remainingCount: number): string {
  const duration = task.time?.started && task.time?.completed
    ? ` (${((task.time.completed - task.time.started) / 1000).toFixed(1)}s)`
    : "";

  const lines: string[] = [];

  if (task.status === "completed") {
    lines.push(`## Task Completed: ${task.id}${duration}`);
    lines.push(`**${task.description}**\n`);
    lines.push(task.result || "(no output)");
  } else if (task.status === "failed") {
    lines.push(`## Task Failed: ${task.id}${duration}`);
    lines.push(`**${task.description}**\n`);
    lines.push(`Error: ${task.error || "unknown error"}`);
  }

  lines.push("");
  if (remainingCount > 0) {
    lines.push(`---\n${remainingCount} task(s) still running. You may output a JSON block to dispatch new tasks or mark complete, or just acknowledge to wait for more results.`);
  } else {
    lines.push(`---\nAll tasks have finished. Output a JSON block: dispatch more tasks, or mark complete with a summary.`);
  }

  return lines.join("\n");
}

/**
 * Format a human feedback message for injection into the orchestrator (Heavy Brain).
 * Human feedback has higher priority than task results.
 */
export function formatUserMessage(text: string, remainingTasks: number): string {
  const lines = [
    `## Human Feedback`,
    ``,
    text,
    ``,
    `---`,
    remainingTasks > 0
      ? `${remainingTasks} task(s) still running. Respond with a JSON block.`
      : `No tasks currently running. Respond with a JSON block.`,
  ];
  return lines.join("\n");
}
