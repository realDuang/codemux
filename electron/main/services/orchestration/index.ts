// ============================================================================
// Agent Team Service — Singleton orchestration service
// Manages team runs (Light Brain and Heavy Brain) with auto-approve permissions.
// Follows the same pattern as ScheduledTaskService.
// ============================================================================

import { EventEmitter } from "events";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { timeId } from "../../utils/id-gen";
import { orchestrationLog } from "./logger";
import { LightBrainOrchestrator } from "./light-brain";
import { HeavyBrainOrchestrator } from "./heavy-brain";
import type { UserChannel } from "./user-channel";
import type { EngineManager } from "../../gateway/engine-manager";
import type {
  OrchestrationRun,
  OrchestrationCreateRequest,
  OrchestrationSubtask,
  EngineType,
  RoleEngineMapping,
  OrchestratorRole,
  ConversationMessage,
  TextPart,
} from "../../../../src/types/unified";
import { loadSettings, saveSettings } from "../logger";
import { conversationStore } from "../conversation-store";

const SAVE_DEBOUNCE_MS = 500;
const ROLE_MAPPINGS_SETTING_KEY = "orchestration.roleMappings";

/** Default role → engine mapping (inspired by oh-my-opencode-slim agent roles, via PR #117). */
export const DEFAULT_ROLE_MAPPINGS: RoleEngineMapping[] = [
  {
    role: "explorer",
    label: "Explorer",
    description: "Codebase search, file/symbol location, pattern matching (read-only)",
    engineType: "claude",
    readOnly: true,
  },
  {
    role: "researcher",
    label: "Researcher",
    description: "Documentation research, external resources, library/API investigation (read-only)",
    engineType: "claude",
    readOnly: true,
  },
  {
    role: "reviewer",
    label: "Reviewer",
    description: "Architecture analysis, code review, quality checks (read-only)",
    engineType: "claude",
    readOnly: true,
  },
  {
    role: "designer",
    label: "Designer",
    description: "UI/UX design and implementation, frontend styling, visual components",
    engineType: "claude",
  },
  {
    role: "coder",
    label: "Coder",
    description: "Code implementation, refactoring, bug fixing, feature development",
    engineType: "claude",
  },
];

interface OrchestrationRunFileFormat {
  version: 1;
  runs: OrchestrationRun[];
}

/**
 * A pending plan-confirmation gate. Light Brain (and optionally Heavy Brain)
 * stashes a resolver here when paused at `awaiting-confirmation`. The
 * gateway handler for TEAM_CONFIRM_PLAN calls `resolve(tasks)` to unblock it.
 */
interface PendingConfirmation {
  resolve: (tasks: OrchestrationSubtask[]) => void;
  reject: (reason: unknown) => void;
}

// --- Event types ---

export interface OrchestrationServiceEvents {
  "orchestration.updated": (data: { run: OrchestrationRun }) => void;
  "orchestration.subtask.updated": (data: { runId: string; task: OrchestrationSubtask }) => void;
  "orchestration.roleMappings.updated": (data: { mappings: RoleEngineMapping[] }) => void;
}

export declare interface OrchestrationService {
  on<K extends keyof OrchestrationServiceEvents>(event: K, listener: OrchestrationServiceEvents[K]): this;
  off<K extends keyof OrchestrationServiceEvents>(event: K, listener: OrchestrationServiceEvents[K]): this;
  emit<K extends keyof OrchestrationServiceEvents>(event: K, ...args: Parameters<OrchestrationServiceEvents[K]>): boolean;
}

// --- Service ---

export class OrchestrationService extends EventEmitter {
  private engineManager: EngineManager | null = null;
  private runs = new Map<string, OrchestrationRun>();
  /** Session IDs created by team runs — auto-approve permissions for these. */
  private autoApproveSessions = new Set<string>();
  /** Run-scoped auto-approve session tracking for deterministic cleanup. */
  private autoApproveSessionsByRun = new Map<string, Set<string>>();
  /** Active Heavy Brain orchestrators (for cancellation). */
  private activeOrchestrators = new Map<string, HeavyBrainOrchestrator>();
  /** Active Heavy Brain relay channels for human-in-the-loop messages. */
  private activeRelayChannels = new Map<string, UserChannel>();
  /** Pending plan-confirmation gates keyed by runId. */
  private pendingConfirmations = new Map<string, PendingConfirmation>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;

  // --- Lifecycle ---

  init(engineManager: EngineManager): void {
    if (this.initialized) return;
    this.runs.clear();
    this.autoApproveSessions.clear();
    this.autoApproveSessionsByRun.clear();
    this.activeOrchestrators.clear();
    this.activeRelayChannels.clear();
    this.engineManager = engineManager;
    this.loadFromDisk();
    this.subscribePermissionAutoApprove();
    this.initialized = true;
    orchestrationLog.info(`Agent Team Service initialized with ${this.runs.size} run(s)`);
  }

  async shutdown(): Promise<void> {
    // Cancel all running orchestrators
    for (const [runId, orchestrator] of this.activeOrchestrators) {
      orchestrationLog.info(`Cancelling orchestrator for run ${runId}`);
      await orchestrator.cancel();
    }
    this.activeOrchestrators.clear();
    this.activeRelayChannels.clear();
    this.autoApproveSessionsByRun.clear();
    this.autoApproveSessions.clear();
    this.flushPendingSave();
    this.initialized = false;
    orchestrationLog.info("Agent Team Service shut down");
  }

  // --- Auto-approve (same pattern as ScheduledTaskService) ---

  private subscribePermissionAutoApprove(): void {
    if (!this.engineManager) return;

    this.engineManager.on("permission.asked", (data: any) => {
      const permission = data.permission ?? data;
      const sessionId = permission.sessionId;
      if (!sessionId || !this.autoApproveSessions.has(sessionId)) return;

      const acceptOption = permission.options?.find(
        (o: any) =>
          o.type?.includes("accept") ||
          o.type?.includes("allow") ||
          o.label?.toLowerCase().includes("allow"),
      );

      if (acceptOption) {
        orchestrationLog.info(`Auto-approving permission ${permission.id} for session ${sessionId}`);
        this.engineManager!.replyPermission(permission.id, { optionId: acceptOption.id });
      }
    });
  }

  // --- CRUD ---

  /**
   * Create and start a new team run.
   * Returns immediately with the run in "decomposing" status.
   * Execution happens asynchronously.
   */
  async createRun(req: OrchestrationCreateRequest): Promise<OrchestrationRun> {
    if (!this.engineManager) {
      throw new Error("OrchestrationService not initialized");
    }

    if (Boolean(req.worktreeId) !== Boolean(req.parentDirectory)) {
      throw new Error(
        "Team runs started from worktree sessions must include both worktreeId and parentDirectory.",
      );
    }

    const run: OrchestrationRun = {
      id: timeId("team"),
      parentSessionId: req.sessionId,
      directory: req.directory,
      parentDirectory: req.parentDirectory,
      worktreeId: req.worktreeId,
      teamWorktreeName: req.teamWorktreeInfo?.name,
      teamWorktreeDir: req.teamWorktreeInfo?.directory,
      roleMappings: req.roleMappings ?? this.getRoleMappings(),
      prompt: req.prompt,
      engineTypes: req.engineTypes ?? (req.engineType ? [req.engineType] : []),
      mode: req.mode,
      status: "decomposing",
      subtasks: [],
      time: { created: Date.now() },
      // Plan confirmation defaults: Light = on, Heavy = off (can be overridden)
      requirePlanConfirmation: req.requirePlanConfirmation ?? (req.mode === "light"),
      // Default: relay results to parent when we have one
      aggregateToParent: req.aggregateToParent ?? true,
    };

    this.runs.set(run.id, run);
    this.emitRunUpdated(run);

    // Persist the user's prompt as a user message in the parent session
    // so it survives page refresh (the frontend only creates a temp message).
    try {
      const msgId = timeId("msg");
      const userMessage: ConversationMessage = {
        id: msgId,
        role: "user",
        time: { created: Date.now(), completed: Date.now() },
        parts: [{
          type: "text" as const,
          id: `${msgId}_p0`,
          messageId: msgId,
          sessionId: req.sessionId,
          text: req.prompt,
        } as TextPart],
      };
      await conversationStore.appendMessage(req.sessionId, userMessage);
    } catch (err) {
      orchestrationLog.warn(`Failed to persist user prompt for run ${run.id}:`, err);
    }

    orchestrationLog.info(`Created team run ${run.id} (${run.mode} brain)`);

    // Start execution asynchronously
    void this.executeRun(run, req.engineType as EngineType | undefined).catch((err) => {
      orchestrationLog.error(`Team run ${run.id} failed:`, err);
      run.status = "failed";
      run.resultSummary = `Orchestration error: ${err.message}`;
      run.time.completed = Date.now();
      this.emitRunUpdated(run);
    });

    return run;
  }

  /**
   * Cancel a running team run.
   */
  async cancelRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Team run not found: ${runId}`);

    // Cancel heavy brain orchestrator if active
    const orchestrator = this.activeOrchestrators.get(runId);
    if (orchestrator) {
      await orchestrator.cancel();
      this.activeOrchestrators.delete(runId);
    } else {
      if (run.orchestratorSessionId) {
        try {
          await this.engineManager?.cancelMessage(run.orchestratorSessionId);
        } catch (error) {
          orchestrationLog.warn(
            `Failed to cancel orchestrator session ${run.orchestratorSessionId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      for (const task of run.subtasks) {
        if (task.sessionId && task.status === "running") {
          try {
            await this.engineManager?.cancelMessage(task.sessionId);
          } catch (error) {
            orchestrationLog.warn(
              `Failed to cancel task session ${task.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        if (task.status === "pending" || task.status === "running") {
          task.status = "cancelled";
          task.time = { ...task.time, completed: task.time?.completed ?? Date.now() };
        }
      }

      run.status = "cancelled";
      run.resultSummary = "Orchestration was cancelled.";
      run.time.completed = Date.now();
    }

    this.cleanupRunRuntimeState(runId);
    this.emitRunUpdated(run);
    orchestrationLog.info(`Cancelled team run ${runId}`);
  }

  /**
   * Relay a user message to an active Heavy Brain orchestrator.
   */
  sendMessageToRun(runId: string, text: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Team run not found: ${runId}`);
    if (run.status !== "running" && run.status !== "decomposing") {
      throw new Error(`Team run ${runId} is not active (status: ${run.status})`);
    }
    if (run.mode !== "heavy") {
      throw new Error(
        `Relay messaging is only supported for active Heavy Brain runs. Run ${runId} is ${run.mode}.`,
      );
    }

    const channel = this.activeRelayChannels.get(runId);
    if (!channel) {
      throw new Error(`No active Heavy Brain relay channel for run ${runId}`);
    }

    channel.send(text);
    orchestrationLog.info(`User message sent to run ${runId}`);
  }

  listRuns(): OrchestrationRun[] {
    return Array.from(this.runs.values()).sort((a, b) => b.time.created - a.time.created);
  }

  getRun(runId: string): OrchestrationRun | null {
    return this.runs.get(runId) ?? null;
  }

  // --- Plan confirmation ---

  /**
   * Register a pending plan-confirmation gate for a run. Called by
   * LightBrainOrchestrator (and optionally HeavyBrainOrchestrator) when it
   * reaches the `awaiting-confirmation` phase. Returns a promise that
   * resolves with the user-approved task list.
   */
  awaitPlanConfirmation(runId: string): Promise<OrchestrationSubtask[]> {
    // Notify the frontend that the run has transitioned to "confirming" status
    // so the UI can show the plan confirmation card with approve/cancel buttons.
    const run = this.runs.get(runId);
    if (run) {
      this.emitRunUpdated(run);
    }
    return new Promise<OrchestrationSubtask[]>((resolve, reject) => {
      this.pendingConfirmations.set(runId, { resolve, reject });
    });
  }

  /**
   * Resolve a pending plan-confirmation gate. Called by the gateway when the
   * user confirms / edits the plan via TEAM_CONFIRM_PLAN.
   */
  confirmPlan(runId: string, tasks: OrchestrationSubtask[]): void {
    const gate = this.pendingConfirmations.get(runId);
    if (!gate) {
      throw new Error(`No pending plan confirmation for run ${runId}`);
    }
    this.pendingConfirmations.delete(runId);
    gate.resolve(tasks);
    orchestrationLog.info(`Plan confirmed for run ${runId} with ${tasks.length} task(s)`);
  }

  private rejectPendingConfirmation(runId: string, reason: string): void {
    const gate = this.pendingConfirmations.get(runId);
    if (!gate) return;
    this.pendingConfirmations.delete(runId);
    gate.reject(new Error(reason));
  }

  // --- Role mappings ---

  getRoleMappings(): RoleEngineMapping[] {
    const stored = loadSettings()[ROLE_MAPPINGS_SETTING_KEY];
    if (Array.isArray(stored) && stored.length > 0) {
      // Validate role field exists
      return stored.filter((m: any): m is RoleEngineMapping =>
        m && typeof m === "object" && typeof m.role === "string" && typeof m.engineType === "string"
      );
    }
    return DEFAULT_ROLE_MAPPINGS.map((m) => ({ ...m }));
  }

  updateRoleMappings(mappings: RoleEngineMapping[]): RoleEngineMapping[] {
    saveSettings({ [ROLE_MAPPINGS_SETTING_KEY]: mappings });
    orchestrationLog.info(`Updated role mappings (${mappings.length} roles)`);
    this.emit("orchestration.roleMappings.updated", { mappings });
    return mappings;
  }

  resolveRole(role: OrchestratorRole, fallback: EngineType): { engineType: EngineType; modelId?: string } {
    const mapping = this.getRoleMappings().find((m) => m.role === role);
    if (mapping) {
      return { engineType: mapping.engineType, modelId: mapping.modelId };
    }
    return { engineType: fallback };
  }

  // --- Execution ---

  private async executeRun(run: OrchestrationRun, orchestratorEngineType?: EngineType): Promise<void> {
    const onTaskUpdated = (task: OrchestrationSubtask) => {
      this.emit("orchestration.subtask.updated", { runId: run.id, task });
      this.emitRunUpdated(run);
    };

    const resolvedEngine = orchestratorEngineType ?? this.engineManager!.getDefaultEngineType();
    const registerAutoApproveSession = (sessionId: string) => {
      this.registerAutoApproveSession(run.id, sessionId);
    };
    const resolveRole = (role: OrchestratorRole) => this.resolveRole(role, resolvedEngine);
    const awaitPlanConfirmation = (runId: string) => this.awaitPlanConfirmation(runId);

    try {
      if (run.mode === "light") {
        const orchestrator = new LightBrainOrchestrator(
          this.engineManager!,
          registerAutoApproveSession,
          resolveRole,
          awaitPlanConfirmation,
        );
        await orchestrator.run(run, onTaskUpdated, resolvedEngine);
      } else {
        const orchestrator = new HeavyBrainOrchestrator(
          this.engineManager!,
          registerAutoApproveSession,
          resolveRole,
          awaitPlanConfirmation,
        );
        this.activeOrchestrators.set(run.id, orchestrator);
        this.activeRelayChannels.set(run.id, orchestrator.userChannel);
        await orchestrator.run(run, resolvedEngine, onTaskUpdated);
      }
      await this.relayResultsToParentSession(run);
    } finally {
      this.cleanupRunRuntimeState(run.id);
      this.emitRunUpdated(run);
    }
  }

  /**
   * Send the aggregated run result back to the parent session so the parent
   * engine can summarize it for the user. Silently no-ops if there is no
   * parent session, no result, or the engine send fails.
   *
   * Gated by `run.aggregateToParent` (defaults to true when a parentSessionId
   * exists, preserving the original single-session UX).
   */
  private async relayResultsToParentSession(run: OrchestrationRun): Promise<void> {
    if (!run.parentSessionId || !this.engineManager) return;
    if (run.aggregateToParent === false) return;
    if (run.status !== "completed" && run.status !== "failed") return;
    if (!run.resultSummary) return;

    const failed = run.subtasks.filter((t) => t.status === "failed");
    const failedSection = failed.length > 0
      ? `\n\nFailed tasks:\n${failed.map((t) => `- ${t.description}: ${t.error ?? "unknown error"}`).join("\n")}`
      : "";

    const header = run.status === "completed"
      ? "The agent team has completed. Here are the results from each task:"
      : "The agent team finished with failures. Partial results:";

    const prompt = `${header}\n\n${run.resultSummary}${failedSection}\n\nPlease provide a concise summary of what was accomplished${failed.length > 0 ? ", any issues encountered," : ""} and suggested next steps if applicable.`;

    try {
      await this.engineManager.sendMessage(
        run.parentSessionId,
        [{ type: "text", text: prompt }],
        { internal: true },
      );
      orchestrationLog.info(`[${run.id}] Relayed aggregated results to parent session ${run.parentSessionId}`);
    } catch (err) {
      orchestrationLog.warn(`[${run.id}] Failed to relay results to parent session:`, err);
    }
  }

  private registerAutoApproveSession(runId: string, sessionId: string): void {
    this.autoApproveSessions.add(sessionId);

    const runSessions = this.autoApproveSessionsByRun.get(runId) ?? new Set<string>();
    runSessions.add(sessionId);
    this.autoApproveSessionsByRun.set(runId, runSessions);
  }

  private unregisterAutoApproveSessions(runId: string): void {
    const runSessions = this.autoApproveSessionsByRun.get(runId);
    if (!runSessions) return;

    for (const sessionId of runSessions) {
      this.autoApproveSessions.delete(sessionId);
    }
    this.autoApproveSessionsByRun.delete(runId);
  }

  private cleanupRunRuntimeState(runId: string): void {
    this.activeOrchestrators.delete(runId);
    this.activeRelayChannels.delete(runId);
    this.rejectPendingConfirmation(runId, "Run ended before plan was confirmed");
    this.unregisterAutoApproveSessions(runId);
  }

  private getFilePath(): string {
    return path.join(app.getPath("userData"), "orchestration-runs.json");
  }

  private loadFromDisk(): void {
    const filePath = this.getFilePath();

    try {
      if (!fs.existsSync(filePath)) {
        orchestrationLog.info("No orchestration-runs.json found, starting empty");
        return;
      }

      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as OrchestrationRunFileFormat;

      if (data.version !== 1 || !Array.isArray(data.runs)) {
        orchestrationLog.warn("Invalid orchestration-runs.json format, ignoring");
        return;
      }

      for (const run of data.runs) {
        this.runs.set(run.id, run);
      }

      const recoveredCount = this.recoverInterruptedRuns();
      if (recoveredCount > 0) {
        this.writeToDisk();
      }

      orchestrationLog.info(`Loaded ${data.runs.length} team run(s) from disk`);
    } catch (error) {
      orchestrationLog.error("Failed to load orchestration-runs.json:", error);
    }
  }

  private recoverInterruptedRuns(): number {
    let recoveredCount = 0;
    const completionTime = Date.now();

    for (const run of this.runs.values()) {
      if (run.status !== "decomposing" && run.status !== "running") {
        continue;
      }

      recoveredCount += 1;
      run.status = "failed";
      run.resultSummary = "Agent Team run was interrupted because CodeMux restarted before it completed.";
      run.time.completed = completionTime;

      for (const task of run.subtasks) {
        if (task.status !== "pending" && task.status !== "running") {
          continue;
        }

        task.status = "cancelled";
        task.time = { ...task.time, completed: task.time?.completed ?? completionTime };
      }
    }

    return recoveredCount;
  }

  private writeToDisk(): void {
    const filePath = this.getFilePath();
    const data: OrchestrationRunFileFormat = {
      version: 1,
      runs: this.listRuns(),
    };

    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpPath, filePath);
    } catch (error) {
      orchestrationLog.error("Failed to write orchestration-runs.json:", error);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeToDisk();
    }, SAVE_DEBOUNCE_MS);
  }

  private flushPendingSave(): void {
    if (!this.saveTimer) return;

    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.writeToDisk();
  }

  private emitRunUpdated(run: OrchestrationRun): void {
    this.scheduleSave();
    this.emit("orchestration.updated", { run });
  }
}

/** Singleton instance */
export const orchestrationService = new OrchestrationService();
