// ============================================================================
// Structured Output Skills — format spec + self-check + parser bundles
// Injected into agent prompts so agents self-validate before outputting.
// Parser is a safety net; correctionPrompt handles the rare parse failure.
// ============================================================================

// --- Skill Framework ---

/**
 * A structured output skill bundles format specification, parser, and
 * correction logic for a specific JSON output format.
 *
 * The formatPrompt is injected into the agent's prompt so it knows the
 * expected schema and self-checks before outputting. The parser extracts
 * the typed result from raw LLM text. On parse failure, correctionPrompt
 * generates a follow-up message to let the agent fix its output in-place
 * (same session, no new session needed).
 */
export interface StructuredOutputSkill<T> {
  /** Skill name for logging */
  name: string;

  /** Prompt instructions injected into the session: format spec + self-check checklist */
  formatPrompt: string;

  /** Parse LLM text output into T. Returns null on failure with error detail. */
  parse(text: string): { ok: true; data: T } | { ok: false; error: string };

  /** Generate a correction prompt when parse fails */
  correctionPrompt(rawText: string, error: string): string;
}

// --- JSON Extraction Utility ---

/**
 * Extract JSON objects/arrays from LLM text output.
 * Handles: ```json fenced blocks, bare JSON, and markdown-wrapped JSON.
 */
export function extractJsonBlocks(text: string): string[] {
  const blocks: string[] = [];

  // Strategy: find top-level JSON objects/arrays by bracket-balanced scanning.
  // This handles JSON values that contain ``` fences (e.g. prompts with code blocks)
  // which break naive regex-based fence matching.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;

    const close = ch === "{" ? "}" : "]";
    let depth = 1;
    let inString = false;
    let escaped = false;
    let j = i + 1;

    for (; j < text.length && depth > 0; j++) {
      const c = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        if (inString) escaped = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === ch) depth++;
      else if (c === close) depth--;
    }

    if (depth === 0) {
      blocks.push(text.slice(i, j));
      i = j - 1; // skip past this block
    }
  }

  return blocks;
}

/**
 * Try to parse the first valid JSON from extracted blocks.
 */
export function parseFirstJson<T>(text: string): { ok: true; data: T } | { ok: false; error: string } {
  const blocks = extractJsonBlocks(text);
  if (blocks.length === 0) {
    return { ok: false, error: "No JSON block found in output. Expected a ```json code block." };
  }

  const errors: string[] = [];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block) as T;
      return { ok: true, data: parsed };
    } catch (e) {
      errors.push(`JSON parse error: ${(e as Error).message}`);
    }
  }

  return { ok: false, error: errors.join("; ") };
}

// --- DAG Planning Skill (Light Brain) ---

/** Raw task node as output by the planning LLM */
export interface RawTaskNode {
  id: string;
  description: string;
  prompt: string;
  dependsOn: string[];
  engineType?: string;
  worktreeId?: string;
}

interface DagPlanOutput {
  tasks: RawTaskNode[];
}

function validateDagPlan(data: unknown): { ok: true; data: DagPlanOutput } | { ok: false; error: string } {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Expected a JSON object with a 'tasks' array." };
  }

  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.tasks)) {
    return { ok: false, error: "Missing 'tasks' array in output." };
  }

  const tasks = obj.tasks as unknown[];
  if (tasks.length === 0) {
    return { ok: false, error: "Task list is empty. At least one task is required." };
  }

  const ids = new Set<string>();
  const errors: string[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i] as Record<string, unknown>;
    if (!t.id || typeof t.id !== "string") {
      errors.push(`Task [${i}]: missing or invalid 'id'`);
      continue;
    }
    if (ids.has(t.id)) {
      errors.push(`Task [${i}]: duplicate id '${t.id}'`);
    }
    ids.add(t.id);

    if (!t.description || typeof t.description !== "string") {
      errors.push(`Task '${t.id}': missing 'description'`);
    }
    if (!t.prompt || typeof t.prompt !== "string") {
      errors.push(`Task '${t.id}': missing 'prompt'`);
    }
    if (!Array.isArray(t.dependsOn)) {
      errors.push(`Task '${t.id}': missing 'dependsOn' array`);
    }
    if (t.worktreeId != null && typeof t.worktreeId !== "string") {
      errors.push(`Task '${t.id}': invalid 'worktreeId'`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join("; ") };
  }

  // Validate dependency references
  for (const t of tasks as RawTaskNode[]) {
    for (const dep of t.dependsOn) {
      if (!ids.has(dep)) {
        errors.push(`Task '${t.id}': dependsOn references unknown task '${dep}'`);
      }
    }
  }

  // Check for circular dependencies
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const taskMap = new Map((tasks as RawTaskNode[]).map((t) => [t.id, t]));

  function hasCycle(id: string): boolean {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    inStack.add(id);
    const task = taskMap.get(id);
    if (task) {
      for (const dep of task.dependsOn) {
        if (hasCycle(dep)) return true;
      }
    }
    inStack.delete(id);
    return false;
  }

  for (const id of ids) {
    if (hasCycle(id)) {
      errors.push("Circular dependency detected in task DAG");
      break;
    }
  }

  // Check for at least one root task
  const hasRoot = (tasks as RawTaskNode[]).some((t) => t.dependsOn.length === 0);
  if (!hasRoot) {
    errors.push("No root task found (at least one task must have dependsOn: [])");
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join("; ") };
  }

  return { ok: true, data: { tasks: tasks as RawTaskNode[] } };
}

export const dagPlanningSkill: StructuredOutputSkill<DagPlanOutput> = {
  name: "dag-planning",

  formatPrompt: `
## Output Format Requirements

Your **final answer** MUST be a single JSON code block with the following schema. This JSON will be parsed by an external orchestration system — it is not for human reading.

\`\`\`json
{
  "tasks": [
    {
      "id": "string (unique, e.g. t1, t2)",
      "description": "string (1-sentence summary of the task)",
       "prompt": "string (detailed, self-contained instructions for the worker agent)",
       "dependsOn": ["array of task IDs this task depends on, use [] if none"],
       "engineType": "optional string: claude | copilot | opencode (omit to use default)",
       "worktreeId": "optional string: existing worktree name for isolated file changes"
     }
   ]
 }
\`\`\`

## Self-Check Before Outputting (MANDATORY)

Before writing the JSON block, verify ALL of the following:
1. JSON syntax is valid (balanced braces, proper quoting, no trailing commas)
2. Every task ID is unique
3. Every ID referenced in dependsOn exists in the task list
4. No circular dependency chains (e.g. A depends on B, B depends on A)
5. Each prompt is self-contained — the worker agent CANNOT see other tasks or the original request
6. At least one task has dependsOn: [] (the DAG must have a root)
7. Your final answer is ONLY the JSON block — no additional text before or after
`.trim(),

  parse(text: string) {
    const jsonResult = parseFirstJson<unknown>(text);
    if (!jsonResult.ok) return jsonResult;
    return validateDagPlan(jsonResult.data);
  },

  correctionPrompt(rawText: string, error: string) {
    return (
      `Your previous output had a format error:\n${error}\n\n` +
      `Please output ONLY the corrected JSON block following the schema above. ` +
      `Do not include any explanation — just the valid JSON.`
    );
  },
};

// --- Dispatch Skill (Heavy Brain) ---

export interface DispatchTask {
  id: string;
  description: string;
  prompt: string;
  engineType?: string;
  dependsOn?: string[];
  worktreeId?: string;
}

export type DispatchInstruction =
  | { action: "dispatch"; tasks: DispatchTask[] }
  | { action: "complete"; result: string }
  | { action: "continueWaiting" };

function validateDispatchInstruction(
  data: unknown,
): { ok: true; data: DispatchInstruction } | { ok: false; error: string } {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Expected a JSON object with 'action' field." };
  }

  const obj = data as Record<string, unknown>;

  if (obj.action === "complete") {
    if (!obj.result || typeof obj.result !== "string") {
      return { ok: false, error: "action 'complete' requires a 'result' string." };
    }
    return { ok: true, data: { action: "complete", result: obj.result } };
  }

  if (obj.action === "continueWaiting") {
    return { ok: true, data: { action: "continueWaiting" } };
  }

  if (obj.action === "dispatch") {
    if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
      return { ok: false, error: "action 'dispatch' requires a non-empty 'tasks' array." };
    }

    const errors: string[] = [];
    const ids = new Set<string>();
    for (let i = 0; i < obj.tasks.length; i++) {
      const t = obj.tasks[i] as Record<string, unknown>;
      if (!t.id || typeof t.id !== "string") {
        errors.push(`Task [${i}]: missing 'id'`);
        continue;
      }
      if (ids.has(t.id)) {
        errors.push(`Task [${i}]: duplicate id '${t.id}'`);
      }
      ids.add(t.id);
      if (!t.description || typeof t.description !== "string") {
        errors.push(`Task '${t.id}': missing 'description'`);
      }
      if (!t.prompt || typeof t.prompt !== "string") {
        errors.push(`Task '${t.id}': missing 'prompt'`);
      }
      if (t.worktreeId != null && typeof t.worktreeId !== "string") {
        errors.push(`Task '${t.id}': invalid 'worktreeId'`);
      }
    }

    if (errors.length > 0) {
      return { ok: false, error: errors.join("; ") };
    }

    return {
      ok: true,
      data: {
        action: "dispatch",
        tasks: obj.tasks as DispatchTask[],
      },
    };
  }

  return {
    ok: false,
    error: `Unknown action '${String(obj.action)}'. Expected 'dispatch', 'complete', or 'continue'.`,
  };
}

export const dispatchSkill: StructuredOutputSkill<DispatchInstruction> = {
  name: "orchestrator-dispatch",

  formatPrompt: `
## Communication Protocol

You communicate your decisions via JSON code blocks. This JSON is parsed by an external orchestration system — it is not for human reading. Every response MUST be a single JSON block with one of these actions:

### 1. Dispatch new tasks:
\`\`\`json
{
  "action": "dispatch",
  "tasks": [
    {
       "id": "unique_id",
       "description": "1-sentence summary",
       "prompt": "detailed, self-contained instructions for the worker agent",
       "engineType": "optional: claude | copilot | opencode",
       "dependsOn": ["optional array of already-known task IDs"],
       "worktreeId": "optional string: existing worktree name for isolated file changes"
     }
   ]
 }
\`\`\`

### 2. Mark orchestration as complete:
\`\`\`json
{
  "action": "complete",
  "result": "Summary of everything accomplished by the team..."
}
\`\`\`

### 3. Acknowledge and wait for more results:
\`\`\`json
{
  "action": "continueWaiting"
}
\`\`\`

## Self-Check Before Outputting (MANDATORY)

1. JSON syntax is valid
2. action is "dispatch", "complete", or "continueWaiting"
3. If dispatch: every task has id, description, and a detailed self-contained prompt
4. If complete: result contains a meaningful summary of all work done
5. Your response is ONLY the JSON block — no additional text before or after
`.trim(),

  parse(text: string) {
    const jsonResult = parseFirstJson<unknown>(text);
    if (!jsonResult.ok) return jsonResult;
    return validateDispatchInstruction(jsonResult.data);
  },

  correctionPrompt(rawText: string, error: string) {
    return (
      `Your previous output had a format error:\n${error}\n\n` +
      `Please output ONLY the corrected JSON block. Use one of: ` +
      `{ "action": "dispatch", "tasks": [...] }, { "action": "complete", "result": "..." }, or { "action": "continueWaiting" }.`
    );
  },
};

// --- Skill Execution Helper ---

/**
 * Execute a skill against an LLM session with optional retry on parse failure.
 * On first parse failure, sends a correction prompt to let the agent fix in-place.
 *
 * @param sendMessage - Function to send a message and get the response text
 * @param prompt - The user's prompt content
 * @param skill - The structured output skill to use
 * @param maxRetries - Maximum correction attempts (default: 1)
 * @returns Parsed result or null if all attempts fail
 */
export async function executeWithSkill<T>(
  sendMessage: (text: string) => Promise<string>,
  prompt: string,
  skill: StructuredOutputSkill<T>,
  maxRetries = 1,
  log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  // First attempt: send prompt with skill format instructions
  const fullPrompt = `${skill.formatPrompt}\n\n---\n\n${prompt}`;
  const responseText = await sendMessage(fullPrompt);

  log?.info(`[${skill.name}] LLM response (${responseText.length} chars): ${responseText.slice(0, 500)}${responseText.length > 500 ? "..." : ""}`);

  const result = skill.parse(responseText);
  if (result.ok) return result;

  log?.warn(`[${skill.name}] Parse failed: ${result.error}`);

  // Retry with correction prompt
  let lastError = result.error;
  for (let i = 0; i < maxRetries; i++) {
    const correction = skill.correctionPrompt(responseText, lastError);
    const retryText = await sendMessage(correction);
    log?.info(`[${skill.name}] Retry ${i + 1} response (${retryText.length} chars): ${retryText.slice(0, 500)}${retryText.length > 500 ? "..." : ""}`);
    const retryResult = skill.parse(retryText);
    if (retryResult.ok) return retryResult;
    lastError = retryResult.error;
    log?.warn(`[${skill.name}] Retry ${i + 1} parse failed: ${lastError}`);
  }

  return { ok: false, error: lastError };
}
