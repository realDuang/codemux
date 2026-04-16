import { EventEmitter } from "node:events";
import log from "electron-log/main";
import type { EngineManager } from "../gateway/engine-manager";
import type { OrchestrationRun, OrchestrationSubtask, EngineType, RoleEngineMapping } from "../../../src/types/unified";

const orchLog = log.scope("Orchestrator");

function generateId(): string {
  return `orch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

class OrchestratorService extends EventEmitter {
  private engineManager: EngineManager | null = null;
  private activeRuns = new Map<string, OrchestrationRun>();
  private autoApproveSessions = new Set<string>();
  /** Resolvers notified when any subtask finishes (for DAG waitForAnyCompletion) */
  private subtaskDoneResolvers: Array<() => void> = [];

  init(engineManager: EngineManager): void {
    this.engineManager = engineManager;
    this.subscribePermissionAutoApprove();
    orchLog.info("OrchestratorService initialized");
  }

  // Creates a new orchestration run
  createRun(parentSessionId: string, directory: string, prompt: string, engineTypes: EngineType[], roleMappings?: RoleEngineMapping[]): OrchestrationRun {
    const id = generateId();
    const run: OrchestrationRun = {
      id,
      parentSessionId,
      directory,
      status: "setup",
      prompt,
      engineTypes,
      subtasks: [],
      roleMappings,
      createdAt: Date.now(),
    };
    this.activeRuns.set(id, run);
    this.emitUpdate(run);
    return run;
  }

  // Decomposes a task using LLM via the parent session (already created by frontend)
  async decomposeTask(runId: string): Promise<OrchestrationSubtask[]> {
    const run = this.getRun(runId);
    run.status = "decomposing";
    this.emitUpdate(run);

    try {
      if (!this.engineManager) throw new Error("Not initialized");
      if (!run.parentSessionId) throw new Error("parentSessionId not set — was the run created with a session?");

      // Use the parent session (already created by frontend with user's chosen engine)
      const sessionId = run.parentSessionId;
      this.autoApproveSessions.add(sessionId);

      // Build decomposition prompt
      const engineDescriptions = run.engineTypes.map(e => `- ${e}`).join("\n");

      // Build role descriptions if role mappings are available
      let roleSection = "";
      const hasRoles = run.roleMappings && run.roleMappings.length > 0;
      if (hasRoles) {
        const roleLines = run.roleMappings!
          .map(r => `- ${r.role} → engine "${r.engineType}"${r.readOnly ? " (READ-ONLY)" : ""}: ${r.description}`)
          .join("\n");
        roleSection = `
Available roles (each maps to an engine):
${roleLines}

IMPORTANT: You MUST assign a "role" to each subtask based on the nature of the work. The engine is automatically determined by the role mapping — do NOT set "engineType" manually, it will be overridden by the role's engine.
`;
      }

      const decompositionPrompt = `You are a task decomposition assistant. Analyze the following task and break it into independent subtasks that can be executed in parallel by different AI coding agents.

Available engines:
${engineDescriptions}
${roleSection}
Task: "${run.prompt}"

Return ONLY a JSON array. Each item must have:
- "id": short identifier (e.g., "analyze", "test", "refactor")
- "description": clear task description for the assigned agent
- "role": the role best suited for this subtask (explorer, researcher, reviewer, designer, coder)
- "engineType": one of the available engines (auto-set from role if roles are configured)
- "dependsOn": array of task IDs this task depends on (empty if independent)
- "needsWorktree": true if the task modifies files, false if read-only analysis

Role guidelines:
- explorer: searching code, locating files/symbols/patterns — always read-only
- researcher: looking up docs, APIs, external references — always read-only
- reviewer: analyzing architecture, reviewing code quality, strategic advice — always read-only
- designer: UI/UX design, frontend components, styling — may modify files
- coder: implementation, refactoring, bug fixes, feature work — modifies files

Rules:
1. Tasks with empty dependsOn will run in parallel immediately
2. Keep subtasks independent where possible (2-5 subtasks)
3. Each subtask should be a complete, self-contained work unit
4. Read-only roles (explorer, researcher, reviewer) should have needsWorktree=false

Respond with ONLY the JSON array, no markdown fencing, no explanation.`;

      // sendMessage blocks until the engine finishes processing and returns the response
      const result = await this.engineManager.sendMessage(sessionId, [{ type: "text", text: decompositionPrompt }]);

      // Extract text directly from the returned message (avoids disk read race)
      const textParts = result.parts?.filter((p: any) => p.type === "text") || [];
      const responseText = textParts.map((p: any) => p.text || "").join("\n");

      // Fallback: if sendMessage didn't return parts, read from conversation store
      const finalText = responseText || await this.readLastAssistantMessage(sessionId);

      // Parse the JSON response
      const subtasks = this.parseSubtasks(finalText, run.engineTypes, run.roleMappings);
      run.subtasks = subtasks;
      run.status = "confirming";
      this.emitUpdate(run);

      return subtasks;
    } catch (err: any) {
      orchLog.error("Failed to decompose task:", err);
      run.status = "failed";
      this.emitUpdate(run);
      throw err;
    }
  }

  // Execute after user confirms the subtask plan
  async confirmAndExecute(runId: string, subtasks: OrchestrationSubtask[]): Promise<void> {
    const run = this.getRun(runId);
    // Reset all subtask statuses to "blocked" — DAG will unlock them based on dependencies
    run.subtasks = subtasks.map(t => ({ ...t, status: "blocked" as const }));
    run.status = "dispatching";
    this.emitUpdate(run);

    try {
      // Create a clean worktree from main for isolation
      await this.createTeamWorktree(run);

      // Execute the DAG (subtasks use the team worktree directory)
      await this.executeDAG(run);
    } catch (err: any) {
      orchLog.error("Orchestration failed:", err);
      run.status = "failed";
      this.emitUpdate(run);
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.getRun(runId);
    // Cancel all running subtasks
    for (const task of run.subtasks) {
      if (task.status === "running" && task.sessionId) {
        try {
          await this.engineManager?.cancelMessage(task.sessionId);
        } catch { /* ignore */ }
        task.status = "failed";
        task.error = "Cancelled by user";
      }
      if (task.status === "blocked" || task.status === "pending") {
        task.status = "failed";
        task.error = "Cancelled by user";
      }
    }
    run.status = "cancelled";
    run.completedAt = Date.now();
    this.emitUpdate(run);
  }

  listRuns(): OrchestrationRun[] {
    return Array.from(this.activeRuns.values());
  }

  async shutdown(): Promise<void> {
    // Cancel all active runs
    for (const run of this.activeRuns.values()) {
      if (run.status === "running" || run.status === "dispatching") {
        try {
          await this.cancelRun(run.id);
        } catch { /* ignore */ }
      }
    }
  }

  // --- Internal methods ---

  private getRun(runId: string): OrchestrationRun {
    const run = this.activeRuns.get(runId);
    if (!run) throw new Error(`Orchestration run not found: ${runId}`);
    return run;
  }

  private async createTeamWorktree(run: OrchestrationRun): Promise<void> {
    try {
      const { worktreeManager } = await import("./worktree-manager");
      const info = await worktreeManager.create(run.directory, {
        name: `team-${run.id.slice(5, 13)}`,
        // baseBranch defaults to auto-detected main branch
      });
      run.teamWorktreeName = info.name;
      run.teamWorktreeDir = info.directory;
      orchLog.info(`Team worktree created: ${info.name} at ${info.directory}`);
    } catch (err: any) {
      orchLog.warn("Failed to create team worktree, using original directory:", err.message);
      // Continue without worktree — subtasks will use the original directory
    }
  }

  private async executeDAG(run: OrchestrationRun): Promise<void> {
    run.status = "running";
    this.emitUpdate(run);

    while (this.hasUnfinished(run)) {
      // Find subtasks whose dependencies are all completed
      const ready = run.subtasks.filter(t =>
        t.status === "blocked" &&
        t.dependsOn.every(depId => {
          const dep = run.subtasks.find(s => s.id === depId);
          return dep && dep.status === "completed";
        }),
      );

      if (ready.length === 0 && !this.hasRunning(run)) {
        // Deadlock or all remaining tasks have failed dependencies
        orchLog.warn("DAG deadlock or all dependencies failed");
        break;
      }

      // Dispatch ready subtasks in parallel
      for (const task of ready) {
        task.status = "pending";
        const context = this.buildContextInjection(run, task);
        this.dispatchSubtask(run, task, context).catch((err) => {
          orchLog.error(`Failed to dispatch subtask ${task.id}:`, err);
          task.status = "failed";
          task.error = err.message;
          this.emitUpdate(run);
          this.notifySubtaskDone();
        });
      }
      this.emitUpdate(run);

      // Wait for any running subtask to complete
      if (this.hasRunning(run)) {
        await this.waitForAnyCompletion(run);
      }
    }

    // Aggregate results
    run.status = "aggregating";
    this.emitUpdate(run);
    await this.aggregateResults(run);

    run.status = run.subtasks.every(t => t.status === "completed") ? "completed" : "failed";
    run.completedAt = Date.now();
    this.emitUpdate(run);
  }

  private async dispatchSubtask(run: OrchestrationRun, task: OrchestrationSubtask, context: string): Promise<void> {
    if (!this.engineManager) throw new Error("Not initialized");

    // Use the team worktree directory if available, otherwise fall back to original
    const dir = run.teamWorktreeDir || run.directory;

    const startTime = Date.now();
    const session = await this.engineManager.createSession(task.engineType, dir);
    task.sessionId = session.id;
    task.status = "running";
    this.autoApproveSessions.add(session.id);
    this.emitUpdate(run);

    const prompt = context
      ? `${task.description}\n\n${context}`
      : task.description;

    // sendMessage blocks until the engine finishes — no need for separate completion detection
    await this.engineManager.sendMessage(
      session.id,
      [{ type: "text", text: prompt }],
      task.modelId ? { modelId: task.modelId } : undefined,
    );

    task.duration = Math.round((Date.now() - startTime) / 1000);
    task.status = "completed";

    // Extract a summary of the result
    task.resultSummary = await this.extractResultSummary(task);

    this.emitUpdate(run);

    // Notify DAG loop that a subtask finished
    this.notifySubtaskDone();
  }

  private buildContextInjection(run: OrchestrationRun, task: OrchestrationSubtask): string {
    if (task.dependsOn.length === 0) return "";

    const sections: string[] = [];
    for (const depId of task.dependsOn) {
      const dep = run.subtasks.find(s => s.id === depId);
      if (!dep || dep.status !== "completed" || !dep.resultSummary) continue;
      sections.push(`### [${dep.description}] (completed)\n${dep.resultSummary}`);
    }

    if (sections.length === 0) return "";
    return `## Upstream Task Results\n\n${sections.join("\n\n")}`;
  }

  /** Read the last assistant message text from a session */
  private async readLastAssistantMessage(sessionId: string): Promise<string> {
    try {
      const { conversationStore } = await import("./conversation-store");
      const messages = await conversationStore.listMessages(sessionId);
      if (messages && messages.length > 0) {
        const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
        if (lastAssistant) {
          const textParts = lastAssistant.parts?.filter((p: any) => p.type === "text") || [];
          return textParts.map((p: any) => p.text || "").join("\n");
        }
      }
    } catch { /* ignore */ }
    return "";
  }

  private async waitForAnyCompletion(run: OrchestrationRun): Promise<void> {
    const activeTasks = run.subtasks.filter(t => t.status === "running" || t.status === "pending");
    if (activeTasks.length === 0) return;

    // Wait for notifySubtaskDone() signal from dispatchSubtask
    return new Promise<void>((resolve) => {
      this.subtaskDoneResolvers.push(resolve);
    });
  }

  /** Called by dispatchSubtask when a subtask finishes */
  private notifySubtaskDone(): void {
    const resolvers = this.subtaskDoneResolvers;
    this.subtaskDoneResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  private async extractResultSummary(task: OrchestrationSubtask): Promise<string> {
    if (!task.sessionId) return "";
    try {
      const { conversationStore } = await import("./conversation-store");
      const messages = await conversationStore.listMessages(task.sessionId);
      if (messages && messages.length > 0) {
        const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
        if (lastAssistant) {
          const textParts = lastAssistant.parts?.filter((p: any) => p.type === "text") || [];
          const fullText = textParts.map((p: any) => p.text || "").join("\n");
          // Truncate to first 2000 chars as summary
          return fullText.length > 2000 ? fullText.slice(0, 2000) + "..." : fullText;
        }
      }
    } catch { /* ignore */ }
    return "Task completed.";
  }

  private async aggregateResults(run: OrchestrationRun): Promise<void> {
    const completedSummaries = run.subtasks
      .filter(t => t.status === "completed" && t.resultSummary)
      .map(t => `### ${t.description}\n${t.resultSummary}`)
      .join("\n\n");

    if (completedSummaries) {
      run.resultSummary = completedSummaries;
    } else {
      run.resultSummary = "No results were collected from subtasks.";
    }

    // Send aggregated results back to the parent session via sendMessage
    // so the engine properly processes and summarizes them
    if (run.resultSummary && this.engineManager) {
      try {
        const failedTasks = run.subtasks.filter(t => t.status === "failed");
        const failedSection = failedTasks.length > 0
          ? `\n\nFailed subtasks:\n${failedTasks.map(t => `- ${t.description}: ${t.error || "unknown error"}`).join("\n")}`
          : "";

        const prompt = `The team execution has completed. Here are the results from each subtask:\n\n${run.resultSummary}${failedSection}\n\nPlease provide a concise summary of what was accomplished, any issues encountered, and suggested next steps if applicable.`;

        await this.engineManager.sendMessage(
          run.parentSessionId,
          [{ type: "text", text: prompt }],
        );
        orchLog.info(`Sent aggregated results to parent session for summarization`);
      } catch (err: any) {
        orchLog.warn("Failed to send results to parent session:", err.message);
      }
    }
  }

  private parseSubtasks(responseText: string, validEngines: EngineType[], roleMappings?: RoleEngineMapping[]): OrchestrationSubtask[] {
    // Try to extract JSON array from the response
    let jsonStr = responseText.trim();
    // Remove markdown code fences if present
    const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    // Build role → engine lookup
    const roleEngineMap = new Map<string, { engineType: EngineType; modelId?: string }>();
    if (roleMappings) {
      for (const m of roleMappings) {
        roleEngineMap.set(m.role, { engineType: m.engineType, modelId: m.modelId });
      }
    }

    try {
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) throw new Error("Expected JSON array");

      return parsed.map((item: any) => {
        // Auto-resolve engine from role if role mapping exists
        let engineType: EngineType = validEngines.includes(item.engineType) ? item.engineType : validEngines[0];
        let modelId: string | undefined = item.modelId;
        const role = item.role;

        if (role && roleEngineMap.has(role)) {
          const mapping = roleEngineMap.get(role)!;
          if (validEngines.includes(mapping.engineType)) {
            engineType = mapping.engineType;
          }
          if (mapping.modelId) {
            modelId = mapping.modelId;
          }
        }

        return {
          id: String(item.id || generateId()),
          description: String(item.description || ""),
          engineType,
          dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [],
          needsWorktree: Boolean(item.needsWorktree ?? true),
          status: "blocked" as const,
          modelId,
          role,
        };
      });
    } catch (err) {
      orchLog.error("Failed to parse subtask JSON:", err, "Raw:", responseText.slice(0, 500));
      // Fallback: create a single subtask with the entire task
      return [{
        id: "main",
        description: responseText.slice(0, 200) || "Execute the task",
        engineType: validEngines[0],
        dependsOn: [],
        needsWorktree: true,
        status: "blocked",
      }];
    }
  }

  private hasUnfinished(run: OrchestrationRun): boolean {
    return run.subtasks.some(t => t.status === "blocked" || t.status === "pending" || t.status === "running");
  }

  private hasRunning(run: OrchestrationRun): boolean {
    return run.subtasks.some(t => t.status === "running" || t.status === "pending");
  }

  private subscribePermissionAutoApprove(): void {
    if (!this.engineManager) return;
    this.engineManager.on("permission.asked", (data: any) => {
      const sessionId = data.permission?.sessionId;
      if (!sessionId || !this.autoApproveSessions.has(sessionId)) return;
      const permission = data.permission;
      const acceptOption = permission.options?.find(
        (o: any) => o.type?.includes("accept") || o.type?.includes("allow"),
      );
      if (acceptOption) {
        this.engineManager!.replyPermission(permission.id, { optionId: acceptOption.id });
        orchLog.info(`Auto-approved permission for orchestrated session ${sessionId}`);
      }
    });
  }

  private emitUpdate(run: OrchestrationRun): void {
    this.emit("orchestration.updated", { run: { ...run, subtasks: [...run.subtasks] } });
  }
}

export const orchestratorService = new OrchestratorService();
