// ============================================================================
// Desktop-level Scheduled Task Service
// Persistent scheduled tasks that survive app restarts.
// Each trigger creates a new session (never reuses existing ones).
// Permissions are auto-approved (same pattern as channel adapters).
// ============================================================================

import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { Notification } from "electron";
import path from "node:path";
import fs from "node:fs";
import { scheduledTaskLog } from "./logger";
import { getScheduledTasksPath } from "./app-paths";
import type { EngineManager } from "../gateway/engine-manager";
import type {
  ScheduledTask,
  ScheduledTaskCreateRequest,
  ScheduledTaskUpdateRequest,
  ScheduledTaskRunResult,
  ScheduledTaskFrequency,
  EngineType,
} from "../../../src/types/unified";

/** Max setTimeout value (~24.8 days). Timers longer than this overflow to 1. */
const MAX_TIMEOUT = 2_147_483_647;

/** Maximum number of run history entries kept per task. */
const MAX_RUN_HISTORY = 50;

/** Missed run catch-up window (7 days). */
const MISSED_RUN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Debounce delay for persisting to disk. */
const SAVE_DEBOUNCE_MS = 500;

/** Maximum jitter offset (10 minutes). */
const MAX_JITTER_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Persistence file format
// ---------------------------------------------------------------------------

interface TaskFileFormat {
  version: 1;
  tasks: ScheduledTask[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ScheduledTaskService extends EventEmitter {
  private tasks = new Map<string, ScheduledTask>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private engineManager: EngineManager | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
  /** Session IDs created by scheduled tasks — auto-approve permissions for these. */
  private autoApproveSessions = new Set<string>();
  /** Task IDs currently being executed (for graceful shutdown). */
  private runningTasks = new Set<string>();

  // --- Lifecycle -------------------------------------------------------

  /**
   * Initialize the service.
   * Must be called after `app.whenReady()` and after `engineManager.initFromStore()`.
   */
  init(engineManager: EngineManager): void {
    if (this.initialized) return;
    this.engineManager = engineManager;
    this.loadFromDisk();
    this.initialized = true;

    // Subscribe to permission events for auto-approval
    this.subscribePermissionAutoApprove();

    // Schedule all enabled non-manual tasks
    for (const task of this.tasks.values()) {
      if (task.enabled && task.frequency.type !== "manual") {
        this.scheduleTask(task);
      }
    }

    // Check for missed runs
    this.checkMissedRuns();

    scheduledTaskLog.info(`Initialized with ${this.tasks.size} task(s)`);
  }

  /** Graceful shutdown: clear timers, wait for running tasks, flush pending writes. */
  async shutdown(): Promise<void> {
    // Clear all scheduling timers (prevent new triggers)
    for (const [id, timer] of this.timers.entries()) {
      clearTimeout(timer);
      this.timers.delete(id);
    }

    // Wait for currently executing tasks to finish (max 5 seconds)
    if (this.runningTasks.size > 0) {
      scheduledTaskLog.info(
        `Waiting for ${this.runningTasks.size} running task(s) to finish...`,
      );
      const deadline = Date.now() + 5000;
      while (this.runningTasks.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.runningTasks.size > 0) {
        scheduledTaskLog.warn(
          `${this.runningTasks.size} task(s) still running at shutdown, proceeding anyway`,
        );
      }
    }

    // Flush pending save
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.writeToDisk();
    }

    this.autoApproveSessions.clear();
    this.runningTasks.clear();
    this.initialized = false;
    scheduledTaskLog.info("Shut down");
  }

  // --- Auto-approve permissions (same pattern as channel adapters) ------

  private subscribePermissionAutoApprove(): void {
    if (!this.engineManager) return;

    this.engineManager.on("permission.asked", (data: any) => {
      const permission = data.permission ?? data;
      const sessionId = permission.sessionId;
      if (!sessionId || !this.autoApproveSessions.has(sessionId)) return;

      // Find an accept/allow option
      const acceptOption = permission.options?.find(
        (o: any) =>
          o.type?.includes("accept") ||
          o.type?.includes("allow") ||
          o.label?.toLowerCase().includes("allow"),
      );

      if (acceptOption) {
        scheduledTaskLog.info(`Auto-approving permission ${permission.id} for session ${sessionId}`);
        this.engineManager!.replyPermission(permission.id, { optionId: acceptOption.id });
      }
    });
  }

  // --- CRUD -----------------------------------------------------------

  list(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  get(id: string): ScheduledTask | null {
    return this.tasks.get(id) ?? null;
  }

  create(req: ScheduledTaskCreateRequest): ScheduledTask {
    const jitterMs = this.computeJitter(req.name);
    const now = Date.now();

    const task: ScheduledTask = {
      id: randomUUID(),
      name: req.name,
      description: req.description,
      prompt: req.prompt,
      engineType: req.engineType,
      directory: req.directory,
      frequency: req.frequency,
      enabled: req.enabled ?? true,
      jitterMs,
      createdAt: now,
      lastRunAt: null,
      nextRunAt: null,
      runHistory: [],
    };

    // Compute nextRunAt for non-manual tasks
    if (task.enabled && task.frequency.type !== "manual") {
      task.nextRunAt = this.computeNextRun(task.frequency, task.jitterMs, now);
    }

    this.tasks.set(task.id, task);
    this.scheduleSave();
    this.emitChanged();

    // Schedule if enabled and non-manual
    if (task.enabled && task.frequency.type !== "manual") {
      this.scheduleTask(task);
    }

    scheduledTaskLog.info(`Created task "${task.name}" (${task.id})`);
    return task;
  }

  update(req: ScheduledTaskUpdateRequest): ScheduledTask {
    const task = this.tasks.get(req.id);
    if (!task) {
      throw Object.assign(new Error(`Task not found: ${req.id}`), { code: "NOT_FOUND" });
    }

    // Apply partial updates
    if (req.name !== undefined) task.name = req.name;
    if (req.description !== undefined) task.description = req.description;
    if (req.prompt !== undefined) task.prompt = req.prompt;
    if (req.engineType !== undefined) task.engineType = req.engineType;
    if (req.directory !== undefined) task.directory = req.directory;
    if (req.enabled !== undefined) task.enabled = req.enabled;

    // Recompute jitter if name changed
    if (req.name !== undefined) {
      task.jitterMs = this.computeJitter(req.name);
    }

    // Reschedule if frequency or enabled changed
    const frequencyChanged = req.frequency !== undefined;
    if (frequencyChanged) {
      task.frequency = req.frequency!;
    }

    // Clear existing timer
    this.clearTaskTimer(task.id);

    if (task.enabled && task.frequency.type !== "manual") {
      task.nextRunAt = this.computeNextRun(task.frequency, task.jitterMs, Date.now());
      this.scheduleTask(task);
    } else {
      task.nextRunAt = null;
    }

    this.scheduleSave();
    this.emitChanged();
    scheduledTaskLog.info(`Updated task "${task.name}" (${task.id})`);
    return task;
  }

  delete(id: string): void {
    const task = this.tasks.get(id);
    if (!task) {
      throw Object.assign(new Error(`Task not found: ${id}`), { code: "NOT_FOUND" });
    }

    this.clearTaskTimer(id);
    this.tasks.delete(id);
    this.scheduleSave();
    this.emitChanged();
    scheduledTaskLog.info(`Deleted task "${task.name}" (${id})`);
  }

  // --- Execution ------------------------------------------------------

  async runNow(taskId: string): Promise<ScheduledTaskRunResult> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw Object.assign(new Error(`Task not found: ${taskId}`), { code: "NOT_FOUND" });
    }

    return this.executeTask(task);
  }

  private async executeTask(task: ScheduledTask): Promise<ScheduledTaskRunResult> {
    if (!this.engineManager) {
      throw new Error("ScheduledTaskService not initialized");
    }

    scheduledTaskLog.info(`Executing task "${task.name}" (${task.id})`);
    this.runningTasks.add(task.id);

    try {
      // 1. Create a new session
      const session = await this.engineManager.createSession(
        task.engineType as EngineType,
        task.directory,
      );

      // 2. Register session for auto-approve (with size limit fallback)
      if (this.autoApproveSessions.size > 200) {
        // Keep only the most recent 100 entries (Set preserves insertion order)
        const recent = [...this.autoApproveSessions].slice(-100);
        this.autoApproveSessions.clear();
        for (const id of recent) this.autoApproveSessions.add(id);
      }
      this.autoApproveSessions.add(session.id);

      // 3. Send the prompt as the first message
      await this.engineManager.sendMessage(session.id, [
        { type: "text", text: task.prompt },
      ]);

      // 4. Update task state
      task.lastRunAt = Date.now();
      task.runHistory.unshift(session.id);
      if (task.runHistory.length > MAX_RUN_HISTORY) {
        task.runHistory = task.runHistory.slice(0, MAX_RUN_HISTORY);
      }

      // 5. Reschedule next run
      if (task.enabled && task.frequency.type !== "manual") {
        task.nextRunAt = this.computeNextRun(task.frequency, task.jitterMs, Date.now());
        this.scheduleTask(task);
      }

      this.scheduleSave();
      this.emit("task.fired", { taskId: task.id, conversationId: session.id });
      this.emitChanged();

      // Desktop notification
      this.showNotification(
        `Scheduled task "${task.name}" started`,
        `New session created for: ${task.prompt.slice(0, 100)}`,
      );

      return { taskId: task.id, conversationId: session.id };
    } catch (err: any) {
      scheduledTaskLog.error(`Task "${task.name}" execution failed:`, err);
      this.emit("task.failed", { taskId: task.id, error: err.message });

      this.showNotification(
        `Scheduled task "${task.name}" failed`,
        err.message ?? "Unknown error",
      );

      throw err;
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  // --- Scheduling -----------------------------------------------------

  private scheduleTask(task: ScheduledTask): void {
    this.clearTaskTimer(task.id);

    if (!task.enabled || task.frequency.type === "manual" || task.nextRunAt === null) {
      return;
    }

    const delay = Math.max(0, task.nextRunAt - Date.now());

    // Handle setTimeout overflow (max ~24.8 days)
    if (delay > MAX_TIMEOUT) {
      const timer = setTimeout(() => {
        this.scheduleTask(task);
      }, MAX_TIMEOUT);
      this.timers.set(task.id, timer);
      return;
    }

    const timer = setTimeout(async () => {
      this.timers.delete(task.id);
      try {
        await this.executeTask(task);
      } catch {
        // Error already logged and emitted in executeTask
        // Still reschedule next run
        if (task.enabled && task.frequency.type !== "manual") {
          task.nextRunAt = this.computeNextRun(task.frequency, task.jitterMs, Date.now());
          this.scheduleTask(task);
          this.scheduleSave();
        }
      }
    }, delay);

    this.timers.set(task.id, timer);
    scheduledTaskLog.info(
      `Scheduled task "${task.name}" next run in ${Math.round(delay / 1000)}s`,
    );
  }

  private clearTaskTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  // --- Next-run computation -------------------------------------------

  /**
   * Compute the next run timestamp for a given frequency.
   * @param frequency The task frequency configuration
   * @param jitterMs Deterministic jitter offset in ms
   * @param afterMs Compute the next run after this timestamp (usually Date.now())
   */
  computeNextRun(
    frequency: ScheduledTaskFrequency,
    jitterMs: number,
    afterMs: number,
  ): number | null {
    if (frequency.type === "manual") return null;

    switch (frequency.type) {
      case "interval": {
        const intervalMs = (frequency.intervalMinutes ?? 60) * 60_000;
        // Next run = afterMs + interval + jitter (capped to not exceed interval)
        const cappedJitter = Math.min(jitterMs, intervalMs * 0.1);
        return afterMs + intervalMs + cappedJitter;
      }

      case "daily": {
        const hour = frequency.hour ?? 9;
        const minute = frequency.minute ?? 0;
        const next = new Date(afterMs);
        next.setHours(hour, minute, 0, 0);
        let ts = next.getTime() + jitterMs;
        if (ts <= afterMs) {
          next.setDate(next.getDate() + 1);
          ts = next.getTime() + jitterMs;
        }
        return ts;
      }

      case "weekly": {
        const hour = frequency.hour ?? 9;
        const minute = frequency.minute ?? 0;
        const targetDays = frequency.daysOfWeek ?? [1]; // Default Monday

        if (targetDays.length === 0) return null;

        // Find the earliest next occurrence among the target days
        const candidates: number[] = [];
        for (const targetDay of targetDays) {
          const next = new Date(afterMs);
          next.setHours(hour, minute, 0, 0);

          const currentDay = next.getDay();
          let daysUntil = (targetDay - currentDay + 7) % 7;
          if (daysUntil === 0) {
            // Same day — check if the time has passed
            const ts = next.getTime() + jitterMs;
            if (ts <= afterMs) {
              daysUntil = 7;
            }
          }
          next.setDate(next.getDate() + daysUntil);
          candidates.push(new Date(next).setHours(hour, minute, 0, 0) + jitterMs);
        }

        return Math.min(...candidates);
      }

      default:
        return null;
    }
  }

  // --- Jitter ---------------------------------------------------------

  /**
   * Compute a deterministic jitter value (0–600000 ms) from the task name.
   * Uses a simple hash so the same name always gets the same offset.
   */
  private computeJitter(name: string): number {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      const ch = name.charCodeAt(i);
      hash = ((hash << 5) - hash + ch) | 0;
    }
    return Math.abs(hash) % MAX_JITTER_MS;
  }

  // --- Missed-run catch-up -------------------------------------------

  /**
   * On startup, check each task for missed runs within the 7-day window.
   * If a task should have run while the app was offline, execute it once now.
   */
  private checkMissedRuns(): void {
    const now = Date.now();

    for (const task of this.tasks.values()) {
      if (!task.enabled || task.frequency.type === "manual") continue;

      const lastRun = task.lastRunAt ?? task.createdAt;
      const expectedNext = this.computeNextRun(task.frequency, task.jitterMs, lastRun);

      if (expectedNext === null) continue;

      // If the expected next run is in the past but within the 7-day window
      if (expectedNext < now && (now - expectedNext) < MISSED_RUN_WINDOW_MS) {
        scheduledTaskLog.info(
          `Missed run detected for "${task.name}" (expected at ${new Date(expectedNext).toISOString()})`,
        );

        this.executeTask(task).catch((err) => {
          scheduledTaskLog.error(`Missed-run catch-up failed for "${task.name}":`, err);
        });
      }
    }
  }

  // --- Persistence ----------------------------------------------------

  private getFilePath(): string {
    return getScheduledTasksPath();
  }

  private loadFromDisk(): void {
    const filePath = this.getFilePath();
    try {
      if (!fs.existsSync(filePath)) {
        scheduledTaskLog.info("No scheduled-tasks.json found, starting empty");
        return;
      }

      const raw = fs.readFileSync(filePath, "utf-8");
      const data: TaskFileFormat = JSON.parse(raw);

      if (data.version !== 1 || !Array.isArray(data.tasks)) {
        scheduledTaskLog.warn("Invalid scheduled-tasks.json format, ignoring");
        return;
      }

      for (const task of data.tasks) {
        this.tasks.set(task.id, task);
      }

      scheduledTaskLog.info(`Loaded ${data.tasks.length} task(s) from disk`);
    } catch (err) {
      scheduledTaskLog.error("Failed to load scheduled-tasks.json:", err);
    }
  }

  private writeToDisk(): void {
    const filePath = this.getFilePath();
    const data: TaskFileFormat = {
      version: 1,
      tasks: Array.from(this.tasks.values()),
    };

    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Atomic write: write to .tmp then rename
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      scheduledTaskLog.error("Failed to write scheduled-tasks.json:", err);
    }
  }

  /** Debounced save — coalesces rapid changes into one disk write. */
  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeToDisk();
    }, SAVE_DEBOUNCE_MS);
  }

  // --- Notifications --------------------------------------------------

  private showNotification(title: string, body: string): void {
    try {
      if (Notification.isSupported()) {
        new Notification({ title, body }).show();
      }
    } catch (err) {
      scheduledTaskLog.warn("Failed to show notification:", err);
    }
  }

  // --- Events ---------------------------------------------------------

  private emitChanged(): void {
    this.emit("tasks.changed", { tasks: this.list() });
  }
}

// Singleton
export const scheduledTaskService = new ScheduledTaskService();
