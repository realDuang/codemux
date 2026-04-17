// ============================================================================
// Task Executor — Executes a single task node as a CodeMux session
// Follows the same pattern as ScheduledTaskService.executeTask()
// ============================================================================

import type { EngineManager } from "../../gateway/engine-manager";
import type { TaskNode, EngineType, UnifiedMessage, UnifiedPart } from "../../../../src/types/unified";

/** Result of executing a single task */
export interface TaskExecutionResult {
  sessionId: string;
  summary: string;
  error?: string;
}

/**
 * Extracts text content from a completed UnifiedMessage.
 * Concatenates all text parts from the message.
 */
export function extractTextFromMessage(message: UnifiedMessage): string {
  const textParts = (message.parts || [])
    .filter((p: UnifiedPart) => p.type === "text")
    .map((p) => (p as { text: string }).text);
  return textParts.join("\n").trim();
}

export class TaskExecutor {
  constructor(
    private engineManager: EngineManager,
    private autoApproveSessions: Set<string>,
    private defaultEngineType: EngineType,
  ) {}

  /**
   * Execute a single task: create session, send prompt, wait for completion.
   *
   * @param task - The task node to execute
   * @param directory - Working directory for the session
   * @param upstreamContext - Optional context from completed upstream tasks
   */
  async execute(
    task: TaskNode,
    directory: string,
    upstreamContext?: string,
  ): Promise<TaskExecutionResult> {
    const engineType = (task.engineType as EngineType) || this.defaultEngineType;

    // 1. Create a new session
    const session = await this.engineManager.createSession(engineType, directory);
    task.sessionId = session.id;

    // 2. Register session for auto-approve permissions
    this.registerAutoApprove(session.id);

    // 3. Build prompt with upstream context
    let prompt = task.prompt;
    if (upstreamContext) {
      prompt = `${upstreamContext}\n\n---\n\nYour task:\n${task.prompt}`;
    }

    // 4. Send message and wait for completion
    const message = await this.engineManager.sendMessage(session.id, [
      { type: "text", text: prompt },
    ]);

    // 5. Extract result text
    const summary = extractTextFromMessage(message);

    if (message.error) {
      return { sessionId: session.id, summary, error: message.error };
    }

    return { sessionId: session.id, summary };
  }

  /**
   * Build upstream context string from completed dependency tasks.
   */
  static buildUpstreamContext(dependencies: TaskNode[]): string | undefined {
    const completed = dependencies.filter((d) => d.status === "completed" && d.result);
    if (completed.length === 0) return undefined;

    const sections = completed.map(
      (d) => `[Task "${d.description}"]: ${d.result}`,
    );

    return `Context from completed upstream tasks:\n---\n${sections.join("\n---\n")}`;
  }

  private registerAutoApprove(sessionId: string): void {
    // Keep the set bounded (same pattern as ScheduledTaskService)
    if (this.autoApproveSessions.size > 200) {
      const recent = [...this.autoApproveSessions].slice(-100);
      this.autoApproveSessions.clear();
      for (const id of recent) this.autoApproveSessions.add(id);
    }
    this.autoApproveSessions.add(sessionId);
  }
}
