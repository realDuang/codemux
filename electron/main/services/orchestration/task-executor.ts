// ============================================================================
// Task Executor — Executes a single task node as a CodeMux session
// Follows the same pattern as ScheduledTaskService.executeTask()
// ============================================================================

import type { EngineManager } from "../../gateway/engine-manager";
import type { OrchestrationSubtask, EngineType, UnifiedMessage, UnifiedPart, OrchestratorRole } from "../../../../src/types/unified";
import {
  AGENT_TEAM_INACTIVITY_TIMEOUT_MS,
  AGENT_TEAM_MAX_TASK_RETRIES,
  AGENT_TEAM_RETRY_BACKOFF_MS,
} from "./guardrails";

/** Role → engine/model resolver (injected by OrchestrationService). */
export type RoleResolver = (role: OrchestratorRole) => { engineType: EngineType; modelId?: string } | null;

/** Result of executing a single task */
export interface TaskExecutionResult {
  sessionId: string;
  summary: string;
  error?: string;
}

export type AutoApproveSessionTracker = Set<string> | ((sessionId: string) => void);

export interface TaskExecutionOptions {
  upstreamContext?: string;
  defaultWorktreeId?: string;
  onSessionCreated?: (sessionId: string) => void;
  shouldCancel?: () => boolean;
  inactivityTimeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
}

export function trackAutoApproveSession(
  tracker: AutoApproveSessionTracker,
  sessionId: string,
): void {
  if (typeof tracker === "function") {
    tracker(sessionId);
    return;
  }

  if (tracker.size > 200) {
    const recent = [...tracker].slice(-100);
    tracker.clear();
    for (const id of recent) tracker.add(id);
  }

  tracker.add(sessionId);
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

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  if (ms % 1000 === 0) {
    const seconds = ms / 1000;
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  return `${ms}ms`;
}

function isRecoverableExecutionError(error: unknown): boolean {
  const message = stringifyError(error).toLowerCase();
  return (
    message.includes("timed out after") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("connection") ||
    message.includes("temporar") ||
    message.includes("unavailable") ||
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("503") ||
    message.includes("econnreset") ||
    message.includes("epipe")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TaskExecutor {
  constructor(
    private engineManager: EngineManager,
    private autoApproveSessions: AutoApproveSessionTracker,
    private defaultEngineType: EngineType,
    private resolveRole?: RoleResolver,
  ) {}

  /**
   * Execute a single task: create session, send prompt, wait for completion.
   *
   * @param task - The task node to execute
   * @param directory - Working directory for the session
   * @param upstreamContext - Optional context from completed upstream tasks
   */
  async execute(
    task: OrchestrationSubtask,
    directory: string,
    options: TaskExecutionOptions = {},
  ): Promise<TaskExecutionResult> {
    const maxRetries = options.maxRetries ?? AGENT_TEAM_MAX_TASK_RETRIES;
    const inactivityTimeoutMs = options.inactivityTimeoutMs ?? AGENT_TEAM_INACTIVITY_TIMEOUT_MS;
    const retryBackoffMs = options.retryBackoffMs ?? AGENT_TEAM_RETRY_BACKOFF_MS;

    let attempt = 0;
    let lastSessionId = task.sessionId ?? "";

    while (true) {
      if (options.shouldCancel?.()) {
        return {
          sessionId: lastSessionId,
          summary: "",
          error: "Task cancelled before execution started.",
        };
      }

      try {
        const result = await this.executeAttempt(task, directory, options, inactivityTimeoutMs);
        return result;
      } catch (error) {
        lastSessionId = task.sessionId ?? lastSessionId;

        if (options.shouldCancel?.()) {
          return {
            sessionId: lastSessionId,
            summary: "",
            error: "Task cancelled during execution.",
          };
        }

        if (attempt >= maxRetries || !isRecoverableExecutionError(error)) {
          return {
            sessionId: lastSessionId,
            summary: "",
            error: stringifyError(error),
          };
        }

        attempt += 1;

        if (retryBackoffMs > 0) {
          await sleep(retryBackoffMs);
        }
      }
    }
  }

  /**
   * Build upstream context string from completed dependency tasks.
   */
  static buildUpstreamContext(dependencies: OrchestrationSubtask[]): string | undefined {
    const completed = dependencies.filter((d) => d.status === "completed" && d.resultSummary);
    if (completed.length === 0) return undefined;

    const sections = completed.map(
      (d) => `[Task "${d.description}"]: ${d.resultSummary}`,
    );

    return `Context from completed upstream tasks:\n---\n${sections.join("\n---\n")}`;
  }

  private registerAutoApprove(sessionId: string): void {
    trackAutoApproveSession(this.autoApproveSessions, sessionId);
  }

  private async executeAttempt(
    task: OrchestrationSubtask,
    directory: string,
    options: TaskExecutionOptions,
    inactivityTimeoutMs: number,
  ): Promise<TaskExecutionResult> {
    // Resolve role → engine/model if task has a role and engineType wasn't explicitly set
    if (task.role && !task.engineType && this.resolveRole) {
      const resolved = this.resolveRole(task.role);
      if (resolved) {
        task.engineType = resolved.engineType;
        if (resolved.modelId && !task.modelId) {
          task.modelId = resolved.modelId;
        }
      }
    }

    const engineType = (task.engineType as EngineType) || this.defaultEngineType;
    const worktreeId = task.worktreeId ?? options.defaultWorktreeId;
    if (!task.worktreeId && worktreeId) {
      task.worktreeId = worktreeId;
    }

    const session = await this.engineManager.createSession(engineType, directory, worktreeId);
    task.sessionId = session.id;

    this.registerAutoApprove(session.id);
    options.onSessionCreated?.(session.id);

    if (options.shouldCancel?.()) {
      return {
        sessionId: session.id,
        summary: "",
        error: "Task cancelled before execution started.",
      };
    }

    let prompt = task.prompt;
    if (options.upstreamContext) {
      prompt = `${options.upstreamContext}\n\n---\n\nYour task:\n${task.prompt}`;
    }

    try {
      const message = await this.waitForSessionResponse(
        session.id,
        this.engineManager.sendMessage(session.id, [
          { type: "text", text: prompt },
        ]),
        inactivityTimeoutMs,
      );

      const summary = extractTextFromMessage(message);

      if (message.error) {
        return { sessionId: session.id, summary, error: message.error };
      }

      return { sessionId: session.id, summary };
    } catch (error) {
      if (!stringifyError(error).includes("of inactivity")) {
        await this.cancelSessionQuietly(session.id);
      }
      throw error;
    }
  }

  private async waitForSessionResponse(
    sessionId: string,
    responsePromise: Promise<UnifiedMessage>,
    inactivityTimeoutMs: number,
  ): Promise<UnifiedMessage> {
    const eventSource: Pick<EngineManager, "cancelMessage"> & Partial<Pick<EngineManager, "on" | "off">> =
      this.engineManager;

    return await new Promise<UnifiedMessage>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };

      const resetTimer = () => {
        if (settled) {
          return;
        }
        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          void this.cancelSessionQuietly(sessionId).finally(() => {
            finish(() => reject(new Error(`Task timed out after ${formatDuration(inactivityTimeoutMs)} of inactivity.`)));
          });
        }, inactivityTimeoutMs);
      };

      const handlePartUpdated = (data: { sessionId: string }) => {
        if (data.sessionId === sessionId) {
          resetTimer();
        }
      };
      const handleMessageUpdated = (data: { sessionId: string }) => {
        if (data.sessionId === sessionId) {
          resetTimer();
        }
      };
      const handlePermissionAsked = (data: { permission: { sessionId: string } }) => {
        if (data.permission.sessionId === sessionId) {
          resetTimer();
        }
      };
      const handleQuestionAsked = (data: { question: { sessionId: string } }) => {
        if (data.question.sessionId === sessionId) {
          resetTimer();
        }
      };

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        eventSource.off?.("message.part.updated", handlePartUpdated);
        eventSource.off?.("message.updated", handleMessageUpdated);
        eventSource.off?.("permission.asked", handlePermissionAsked);
        eventSource.off?.("question.asked", handleQuestionAsked);
      };

      eventSource.on?.("message.part.updated", handlePartUpdated);
      eventSource.on?.("message.updated", handleMessageUpdated);
      eventSource.on?.("permission.asked", handlePermissionAsked);
      eventSource.on?.("question.asked", handleQuestionAsked);

      resetTimer();

      responsePromise.then(
        (message) => finish(() => resolve(message)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  private async cancelSessionQuietly(sessionId: string): Promise<void> {
    try {
      await this.engineManager.cancelMessage(sessionId);
    } catch {
      // Best effort cleanup only.
    }
  }
}
