// ============================================================================
// Agent Team Service — Singleton orchestration service
// Manages team runs (Light Brain and Heavy Brain) with auto-approve permissions.
// Follows the same pattern as ScheduledTaskService.
// ============================================================================

import { EventEmitter } from "events";
import { timeId } from "../../utils/id-gen";
import { agentTeamLog } from "./logger";
import { LightBrainOrchestrator } from "./light-brain";
import { HeavyBrainOrchestrator } from "./heavy-brain";
import type { EngineManager } from "../../gateway/engine-manager";
import type {
  TeamRun,
  TeamCreateRequest,
  TaskNode,
  EngineType,
} from "../../../../src/types/unified";

// --- Event types ---

export interface AgentTeamServiceEvents {
  "team.run.updated": (data: { run: TeamRun }) => void;
  "team.task.updated": (data: { runId: string; task: TaskNode }) => void;
}

export declare interface AgentTeamService {
  on<K extends keyof AgentTeamServiceEvents>(event: K, listener: AgentTeamServiceEvents[K]): this;
  off<K extends keyof AgentTeamServiceEvents>(event: K, listener: AgentTeamServiceEvents[K]): this;
  emit<K extends keyof AgentTeamServiceEvents>(event: K, ...args: Parameters<AgentTeamServiceEvents[K]>): boolean;
}

// --- Service ---

export class AgentTeamService extends EventEmitter {
  private engineManager: EngineManager | null = null;
  private runs = new Map<string, TeamRun>();
  /** Session IDs created by team runs — auto-approve permissions for these. */
  private autoApproveSessions = new Set<string>();
  /** Active Heavy Brain orchestrators (for cancellation). */
  private activeOrchestrators = new Map<string, HeavyBrainOrchestrator>();
  private initialized = false;

  // --- Lifecycle ---

  init(engineManager: EngineManager): void {
    if (this.initialized) return;
    this.engineManager = engineManager;
    this.subscribePermissionAutoApprove();
    this.initialized = true;
    agentTeamLog.info("Agent Team Service initialized");
  }

  async shutdown(): Promise<void> {
    // Cancel all running orchestrators
    for (const [runId, orchestrator] of this.activeOrchestrators) {
      agentTeamLog.info(`Cancelling orchestrator for run ${runId}`);
      orchestrator.cancel();
    }
    this.activeOrchestrators.clear();
    this.autoApproveSessions.clear();
    this.initialized = false;
    agentTeamLog.info("Agent Team Service shut down");
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
        agentTeamLog.info(`Auto-approving permission ${permission.id} for session ${sessionId}`);
        this.engineManager!.replyPermission(permission.id, { optionId: acceptOption.id });
      }
    });
  }

  // --- CRUD ---

  /**
   * Create and start a new team run.
   * Returns immediately with the run in "planning" status.
   * Execution happens asynchronously.
   */
  async createRun(req: TeamCreateRequest): Promise<TeamRun> {
    if (!this.engineManager) {
      throw new Error("AgentTeamService not initialized");
    }

    const run: TeamRun = {
      id: timeId("team"),
      parentSessionId: req.sessionId,
      directory: req.directory,
      originalPrompt: req.prompt,
      mode: req.mode,
      status: "planning",
      tasks: [],
      time: { created: Date.now() },
    };

    this.runs.set(run.id, run);
    this.emitRunUpdated(run);

    agentTeamLog.info(`Created team run ${run.id} (${run.mode} brain)`);

    // Start execution asynchronously
    void this.executeRun(run, req.engineType as EngineType | undefined).catch((err) => {
      agentTeamLog.error(`Team run ${run.id} failed:`, err);
      run.status = "failed";
      run.finalResult = `Orchestration error: ${err.message}`;
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
      orchestrator.cancel();
      this.activeOrchestrators.delete(runId);
    }

    // Cancel all running child sessions
    for (const task of run.tasks) {
      if (task.sessionId && task.status === "running") {
        try {
          await this.engineManager?.cancelMessage(task.sessionId);
        } catch {
          // Best-effort
        }
        task.status = "cancelled";
      }
      if (task.status === "pending") {
        task.status = "cancelled";
      }
    }

    run.status = "cancelled";
    run.time.completed = Date.now();
    this.emitRunUpdated(run);
    agentTeamLog.info(`Cancelled team run ${runId}`);
  }

  listRuns(): TeamRun[] {
    return Array.from(this.runs.values());
  }

  getRun(runId: string): TeamRun | null {
    return this.runs.get(runId) ?? null;
  }

  // --- Execution ---

  private async executeRun(run: TeamRun, orchestratorEngineType?: EngineType): Promise<void> {
    const onTaskUpdated = (task: TaskNode) => {
      this.emit("team.task.updated", { runId: run.id, task });
      this.emitRunUpdated(run);
    };

    if (run.mode === "light") {
      const orchestrator = new LightBrainOrchestrator(
        this.engineManager!,
        this.autoApproveSessions,
      );
      await orchestrator.run(run, onTaskUpdated);
    } else {
      const orchestrator = new HeavyBrainOrchestrator(
        this.engineManager!,
        this.autoApproveSessions,
      );
      this.activeOrchestrators.set(run.id, orchestrator);
      try {
        await orchestrator.run(run, orchestratorEngineType, onTaskUpdated);
      } finally {
        this.activeOrchestrators.delete(run.id);
      }
    }

    this.emitRunUpdated(run);
  }

  private emitRunUpdated(run: TeamRun): void {
    this.emit("team.run.updated", { run });
  }
}

/** Singleton instance */
export const agentTeamService = new AgentTeamService();
