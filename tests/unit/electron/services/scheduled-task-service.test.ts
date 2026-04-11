import { EventEmitter } from "events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScheduledTask, ScheduledTaskFrequency } from "../../../../src/types/unified";

// ---------------------------------------------------------------------------
// Hoisted mock variables — must be declared before any vi.mock() calls
// ---------------------------------------------------------------------------

const {
  mockExistsSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockMkdirSync,
  mockRenameSync,
  mockNotificationShow,
  mockNotificationIsSupported,
  ElectronNotification,
} = vi.hoisted(() => {
  const mockNotificationShow = vi.fn();
  const mockNotificationIsSupported = vi.fn(() => true);
  // Use a real class instead of vi.fn() so vi.clearAllMocks() never wipes the implementation.
  class ElectronNotification {
    show = mockNotificationShow;
    static isSupported = mockNotificationIsSupported;
  }
  return {
    mockExistsSync: vi.fn(() => false),
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
    mockRenameSync: vi.fn(),
    mockNotificationShow,
    mockNotificationIsSupported,
    ElectronNotification,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/test-userData"),
    isPackaged: false,
    on: vi.fn(),
  },
  Notification: ElectronNotification,
}));

vi.mock("../../../../electron/main/services/logger", () => ({
  scheduledTaskLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    renameSync: mockRenameSync,
  },
}));

// Import after mocks are registered
import { ScheduledTaskService } from "../../../../electron/main/services/scheduled-task-service";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createSampleTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-123",
    name: "Test Task",
    description: "A test task",
    prompt: "Do some work",
    engineType: "opencode" as any,
    directory: "/test/dir",
    frequency: { type: "interval", intervalMinutes: 60 },
    enabled: true,
    jitterMs: 0,
    createdAt: 1_000_000,
    lastRunAt: null,
    nextRunAt: null,
    runHistory: [],
    ...overrides,
  };
}

function createMockEngineManager() {
  const emitter = new EventEmitter();
  return {
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      emitter.on(event, handler);
    }),
    off: vi.fn(),
    _emit: (event: string, data: unknown) => emitter.emit(event, data),
    createSession: vi.fn().mockResolvedValue({ id: "session-abc" }),
    sendMessage: vi.fn().mockResolvedValue({}),
    replyPermission: vi.fn().mockResolvedValue({}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ScheduledTaskService", () => {
  let service: ScheduledTaskService;
  let mockEngineManager: ReturnType<typeof createMockEngineManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockNotificationIsSupported.mockReturnValue(true);
    service = new ScheduledTaskService();
    mockEngineManager = createMockEngineManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // computeNextRun
  // =========================================================================

  describe("computeNextRun", () => {
    it("returns null for manual frequency", () => {
      const freq: ScheduledTaskFrequency = { type: "manual" };
      expect(service.computeNextRun(freq, 0, Date.now())).toBeNull();
    });

    it("returns null for unknown frequency type", () => {
      const freq = { type: "unknown" } as any;
      expect(service.computeNextRun(freq, 0, Date.now())).toBeNull();
    });

    it("computes next interval run using afterMs + intervalMs", () => {
      const now = 1_000_000;
      const freq: ScheduledTaskFrequency = { type: "interval", intervalMinutes: 60 };
      expect(service.computeNextRun(freq, 0, now)).toBe(now + 60 * 60_000);
    });

    it("defaults interval to 60 minutes when intervalMinutes is not specified", () => {
      const now = 1_000_000;
      const freq: ScheduledTaskFrequency = { type: "interval" };
      expect(service.computeNextRun(freq, 0, now)).toBe(now + 60 * 60_000);
    });

    it("applies jitter when it is within 10% of the interval", () => {
      const now = 1_000_000;
      // interval = 3_600_000 ms, 10% = 360_000; jitter = 300_000 < cap → kept as-is
      const freq: ScheduledTaskFrequency = { type: "interval", intervalMinutes: 60 };
      expect(service.computeNextRun(freq, 300_000, now)).toBe(now + 60 * 60_000 + 300_000);
    });

    it("caps jitter at 10% of the interval", () => {
      const now = 1_000_000;
      // interval = 600_000 ms (10 min), 10% = 60_000; jitter = 300_000 > cap → capped to 60_000
      const freq: ScheduledTaskFrequency = { type: "interval", intervalMinutes: 10 };
      expect(service.computeNextRun(freq, 300_000, now)).toBe(now + 10 * 60_000 + 60_000);
    });

    it("computes next daily run for a time later today", () => {
      const today = new Date();
      today.setHours(8, 0, 0, 0);
      const afterMs = today.getTime();
      const freq: ScheduledTaskFrequency = { type: "daily", hour: 10, minute: 30 };
      const next = service.computeNextRun(freq, 0, afterMs)!;
      const nextDate = new Date(next);
      expect(nextDate.getHours()).toBe(10);
      expect(nextDate.getMinutes()).toBe(30);
      expect(nextDate.getDate()).toBe(today.getDate());
    });

    it("rolls to tomorrow when the daily time has already passed today", () => {
      const today = new Date();
      today.setHours(14, 0, 0, 0);
      const afterMs = today.getTime();
      const freq: ScheduledTaskFrequency = { type: "daily", hour: 10, minute: 0 };
      const next = service.computeNextRun(freq, 0, afterMs)!;
      const nextDate = new Date(next);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      expect(nextDate.getDate()).toBe(tomorrow.getDate());
      expect(nextDate.getHours()).toBe(10);
    });

    it("defaults daily hour/minute to 9:00 when not specified", () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const afterMs = today.getTime();
      const freq: ScheduledTaskFrequency = { type: "daily" };
      const next = service.computeNextRun(freq, 0, afterMs)!;
      const nextDate = new Date(next);
      expect(nextDate.getHours()).toBe(9);
      expect(nextDate.getMinutes()).toBe(0);
    });

    it("computes next weekly run for a future day this week", () => {
      const monday = new Date();
      const daysUntilMonday = (1 - monday.getDay() + 7) % 7 || 7;
      monday.setDate(monday.getDate() + daysUntilMonday);
      monday.setHours(8, 0, 0, 0);
      // From Monday 08:00, want Wednesday 09:00
      const freq: ScheduledTaskFrequency = { type: "weekly", hour: 9, minute: 0, daysOfWeek: [3] };
      const next = service.computeNextRun(freq, 0, monday.getTime())!;
      expect(new Date(next).getDay()).toBe(3);
      expect(new Date(next).getHours()).toBe(9);
    });

    it("advances to next week when the weekly target day+time has already passed", () => {
      // Monday at 10:00, want Monday at 09:00 → already passed → next Monday (+7 days)
      const monday = new Date();
      const daysUntilMonday = (1 - monday.getDay() + 7) % 7 || 7;
      monday.setDate(monday.getDate() + daysUntilMonday);
      monday.setHours(10, 0, 0, 0);
      const freq: ScheduledTaskFrequency = { type: "weekly", hour: 9, minute: 0, daysOfWeek: [1] };
      const next = service.computeNextRun(freq, 0, monday.getTime())!;
      expect(new Date(next).getDay()).toBe(1);
      expect(next).toBeGreaterThan(monday.getTime() + 6 * 24 * 60 * 60_000);
    });

    it("returns null for weekly with an empty daysOfWeek array", () => {
      const freq: ScheduledTaskFrequency = { type: "weekly", daysOfWeek: [] };
      expect(service.computeNextRun(freq, 0, Date.now())).toBeNull();
    });

    it("defaults weekly daysOfWeek to Monday when not specified", () => {
      const monday = new Date();
      const daysUntilMonday = (1 - monday.getDay() + 7) % 7 || 7;
      monday.setDate(monday.getDate() + daysUntilMonday);
      monday.setHours(8, 0, 0, 0);
      // No daysOfWeek → defaults to [1] (Monday), 09:00 is still ahead
      const freq: ScheduledTaskFrequency = { type: "weekly", hour: 9, minute: 0 };
      const next = service.computeNextRun(freq, 0, monday.getTime())!;
      expect(new Date(next).getDay()).toBe(1);
    });

    it("picks the earliest candidate when multiple daysOfWeek are given", () => {
      const monday = new Date();
      const daysUntilMonday = (1 - monday.getDay() + 7) % 7 || 7;
      monday.setDate(monday.getDate() + daysUntilMonday);
      monday.setHours(8, 0, 0, 0);
      // Wednesday (3) comes before Friday (5)
      const freq: ScheduledTaskFrequency = { type: "weekly", hour: 9, minute: 0, daysOfWeek: [3, 5] };
      const next = service.computeNextRun(freq, 0, monday.getTime())!;
      expect(new Date(next).getDay()).toBe(3);
    });
  });

  // =========================================================================
  // init
  // =========================================================================

  describe("init", () => {
    it("sets initialized=true and stores the engine manager", () => {
      service.init(mockEngineManager as any);
      expect((service as any).initialized).toBe(true);
      expect((service as any).engineManager).toBe(mockEngineManager);
    });

    it("is idempotent — a second call is a no-op", () => {
      service.init(mockEngineManager as any);
      const em2 = createMockEngineManager();
      service.init(em2 as any);
      expect((service as any).engineManager).toBe(mockEngineManager);
    });

    it("calls loadFromDisk exactly once", () => {
      const loadSpy = vi.spyOn(service as any, "loadFromDisk");
      service.init(mockEngineManager as any);
      expect(loadSpy).toHaveBeenCalledTimes(1);
    });

    it("subscribes to permission.asked events on the engine manager", () => {
      service.init(mockEngineManager as any);
      expect(mockEngineManager.on).toHaveBeenCalledWith("permission.asked", expect.any(Function));
    });

    it("calls checkMissedRuns exactly once", () => {
      const checkSpy = vi.spyOn(service as any, "checkMissedRuns");
      service.init(mockEngineManager as any);
      expect(checkSpy).toHaveBeenCalledTimes(1);
    });

    it("schedules each enabled non-manual task that was loaded from disk", () => {
      vi.useFakeTimers();
      const task = createSampleTask({
        id: "t1",
        enabled: true,
        frequency: { type: "interval", intervalMinutes: 60 },
        nextRunAt: Date.now() + 60_000,
      });
      (service as any).tasks.set("t1", task);
      const scheduleSpy = vi.spyOn(service as any, "scheduleTask");
      vi.spyOn(service as any, "checkMissedRuns").mockReturnValue(undefined);

      service.init(mockEngineManager as any);

      expect(scheduleSpy).toHaveBeenCalledWith(task);
    });

    it("does not schedule disabled tasks", () => {
      vi.useFakeTimers();
      const task = createSampleTask({ id: "t1", enabled: false });
      (service as any).tasks.set("t1", task);
      const scheduleSpy = vi.spyOn(service as any, "scheduleTask");
      vi.spyOn(service as any, "checkMissedRuns").mockReturnValue(undefined);

      service.init(mockEngineManager as any);

      expect(scheduleSpy).not.toHaveBeenCalled();
    });

    it("does not schedule manual tasks", () => {
      vi.useFakeTimers();
      const task = createSampleTask({ id: "t1", enabled: true, frequency: { type: "manual" } });
      (service as any).tasks.set("t1", task);
      const scheduleSpy = vi.spyOn(service as any, "scheduleTask");
      vi.spyOn(service as any, "checkMissedRuns").mockReturnValue(undefined);

      service.init(mockEngineManager as any);

      expect(scheduleSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // shutdown
  // =========================================================================

  describe("shutdown", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("clears all scheduling timers and empties the timers map", async () => {
      (service as any).timers.set("t1", setTimeout(() => {}, 10_000));
      (service as any).timers.set("t2", setTimeout(() => {}, 20_000));

      await service.shutdown();

      expect((service as any).timers.size).toBe(0);
    });

    it("flushes a pending save by calling writeToDisk immediately", async () => {
      mockExistsSync.mockReturnValue(true);
      (service as any).saveTimer = setTimeout(() => {}, 500);
      const writeSpy = vi.spyOn(service as any, "writeToDisk");

      await service.shutdown();

      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect((service as any).saveTimer).toBeNull();
    });

    it("skips the disk flush when there is no pending save", async () => {
      (service as any).saveTimer = null;
      const writeSpy = vi.spyOn(service as any, "writeToDisk");

      await service.shutdown();

      expect(writeSpy).not.toHaveBeenCalled();
    });

    it("sets initialized=false after shutdown", async () => {
      (service as any).initialized = true;

      await service.shutdown();

      expect((service as any).initialized).toBe(false);
    });

    it("clears autoApproveSessions on shutdown", async () => {
      (service as any).autoApproveSessions.add("s1");
      (service as any).autoApproveSessions.add("s2");

      await service.shutdown();

      expect((service as any).autoApproveSessions.size).toBe(0);
    });
  });

  // =========================================================================
  // list / get
  // =========================================================================

  describe("list", () => {
    it("returns an empty array when no tasks exist", () => {
      expect(service.list()).toEqual([]);
    });

    it("returns all tasks", () => {
      const t1 = createSampleTask({ id: "t1" });
      const t2 = createSampleTask({ id: "t2" });
      (service as any).tasks.set("t1", t1);
      (service as any).tasks.set("t2", t2);

      const result = service.list();

      expect(result).toHaveLength(2);
      expect(result).toContain(t1);
      expect(result).toContain(t2);
    });
  });

  describe("get", () => {
    it("returns the task when it exists", () => {
      const task = createSampleTask({ id: "t1" });
      (service as any).tasks.set("t1", task);
      expect(service.get("t1")).toBe(task);
    });

    it("returns null for an unknown id", () => {
      expect(service.get("nonexistent")).toBeNull();
    });
  });

  // =========================================================================
  // create
  // =========================================================================

  describe("create", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("creates a task with the correct fields", () => {
      const task = service.create({
        name: "My Task",
        description: "desc",
        prompt: "run tests",
        engineType: "opencode" as any,
        directory: "/home/user",
        frequency: { type: "manual" },
      });

      expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(task.name).toBe("My Task");
      expect(task.description).toBe("desc");
      expect(task.prompt).toBe("run tests");
      expect(task.engineType).toBe("opencode");
      expect(task.directory).toBe("/home/user");
      expect(task.runHistory).toEqual([]);
      expect(task.lastRunAt).toBeNull();
    });

    it("defaults enabled to true when not specified", () => {
      const task = service.create({
        name: "T",
        description: "",
        prompt: "p",
        engineType: "opencode" as any,
        directory: "/d",
        frequency: { type: "manual" },
      });
      expect(task.enabled).toBe(true);
    });

    it("stores the task in the internal map", () => {
      const task = service.create({
        name: "T",
        description: "",
        prompt: "p",
        engineType: "opencode" as any,
        directory: "/d",
        frequency: { type: "manual" },
      });
      expect((service as any).tasks.get(task.id)).toBe(task);
    });

    it("does not schedule manual tasks", () => {
      const scheduleSpy = vi.spyOn(service as any, "scheduleTask");
      service.create({
        name: "T",
        description: "",
        prompt: "p",
        engineType: "opencode" as any,
        directory: "/d",
        frequency: { type: "manual" },
      });
      expect(scheduleSpy).not.toHaveBeenCalled();
    });

    it("does not schedule disabled tasks", () => {
      const scheduleSpy = vi.spyOn(service as any, "scheduleTask");
      service.create({
        name: "T",
        description: "",
        prompt: "p",
        engineType: "opencode" as any,
        directory: "/d",
        frequency: { type: "interval", intervalMinutes: 60 },
        enabled: false,
      });
      expect(scheduleSpy).not.toHaveBeenCalled();
    });

    it("schedules enabled non-manual tasks", () => {
      const scheduleSpy = vi.spyOn(service as any, "scheduleTask");
      const task = service.create({
        name: "T",
        description: "",
        prompt: "p",
        engineType: "opencode" as any,
        directory: "/d",
        frequency: { type: "interval", intervalMinutes: 30 },
        enabled: true,
      });
      expect(scheduleSpy).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
    });

    it("computes nextRunAt for enabled non-manual tasks", () => {
      const now = Date.now();
      const task = service.create({
        name: "T",
        description: "",
        prompt: "p",
        engineType: "opencode" as any,
        directory: "/d",
        frequency: { type: "interval", intervalMinutes: 60 },
        enabled: true,
      });
      expect(task.nextRunAt).not.toBeNull();
      expect(task.nextRunAt!).toBeGreaterThan(now);
    });

    it("leaves nextRunAt null for manual tasks", () => {
      const task = service.create({
        name: "T",
        description: "",
        prompt: "p",
        engineType: "opencode" as any,
        directory: "/d",
        frequency: { type: "manual" },
      });
      expect(task.nextRunAt).toBeNull();
    });

    it("emits tasks.changed", () => {
      const handler = vi.fn();
      service.on("tasks.changed", handler);
      service.create({
        name: "T",
        description: "",
        prompt: "p",
        engineType: "opencode" as any,
        directory: "/d",
        frequency: { type: "manual" },
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("enqueues a debounced save", () => {
      service.create({
        name: "T",
        description: "",
        prompt: "p",
        engineType: "opencode" as any,
        directory: "/d",
        frequency: { type: "manual" },
      });
      expect((service as any).saveTimer).not.toBeNull();
    });
  });

  // =========================================================================
  // update
  // =========================================================================

  describe("update", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("throws a NOT_FOUND error when the task does not exist", () => {
      expect(() => service.update({ id: "nonexistent" })).toThrow("Task not found");
    });

    it("attaches code=NOT_FOUND to the thrown error", () => {
      try {
        service.update({ id: "nonexistent" });
      } catch (err: any) {
        expect(err.code).toBe("NOT_FOUND");
      }
    });

    it("applies partial field updates", () => {
      const task = createSampleTask({ id: "t1" });
      (service as any).tasks.set("t1", task);

      service.update({
        id: "t1",
        name: "New Name",
        description: "New desc",
        prompt: "New prompt",
        engineType: "claude" as any,
        directory: "/new/dir",
        enabled: false,
      });

      expect(task.name).toBe("New Name");
      expect(task.description).toBe("New desc");
      expect(task.prompt).toBe("New prompt");
      expect(task.engineType).toBe("claude");
      expect(task.directory).toBe("/new/dir");
      expect(task.enabled).toBe(false);
    });

    it("recomputes jitter when the name changes", () => {
      const task = createSampleTask({ id: "t1", name: "Old", jitterMs: 12345 });
      (service as any).tasks.set("t1", task);

      service.update({ id: "t1", name: "New Name That Is Different" });

      // The new name produces a different hash → different jitter
      expect(task.jitterMs).not.toBe(12345);
    });

    it("sets nextRunAt to null when task is disabled", () => {
      const task = createSampleTask({ id: "t1", enabled: true, nextRunAt: Date.now() + 60_000 });
      (service as any).tasks.set("t1", task);

      service.update({ id: "t1", enabled: false });

      expect(task.nextRunAt).toBeNull();
    });

    it("reschedules when frequency changes and task is still enabled", () => {
      const task = createSampleTask({ id: "t1", enabled: true, nextRunAt: Date.now() + 60_000 });
      (service as any).tasks.set("t1", task);
      const scheduleSpy = vi.spyOn(service as any, "scheduleTask");

      service.update({ id: "t1", frequency: { type: "interval", intervalMinutes: 30 } });

      expect(scheduleSpy).toHaveBeenCalled();
    });

    it("clears any existing timer before rescheduling", () => {
      const task = createSampleTask({ id: "t1", enabled: true, nextRunAt: Date.now() + 60_000 });
      (service as any).tasks.set("t1", task);
      (service as any).timers.set("t1", setTimeout(() => {}, 60_000));
      const clearSpy = vi.spyOn(service as any, "clearTaskTimer");

      service.update({ id: "t1", name: "Updated" });

      expect(clearSpy).toHaveBeenCalledWith("t1");
    });

    it("emits tasks.changed", () => {
      const task = createSampleTask({ id: "t1" });
      (service as any).tasks.set("t1", task);
      const handler = vi.fn();
      service.on("tasks.changed", handler);

      service.update({ id: "t1", name: "Changed" });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("returns the updated task object", () => {
      const task = createSampleTask({ id: "t1" });
      (service as any).tasks.set("t1", task);
      const result = service.update({ id: "t1", name: "Changed" });
      expect(result).toBe(task);
    });
  });

  // =========================================================================
  // delete
  // =========================================================================

  describe("delete", () => {
    it("throws a NOT_FOUND error when the task does not exist", () => {
      expect(() => service.delete("nonexistent")).toThrow("Task not found");
    });

    it("attaches code=NOT_FOUND to the thrown error", () => {
      try {
        service.delete("nonexistent");
      } catch (err: any) {
        expect(err.code).toBe("NOT_FOUND");
      }
    });

    it("removes the task from the internal map", () => {
      const task = createSampleTask({ id: "t1" });
      (service as any).tasks.set("t1", task);

      service.delete("t1");

      expect((service as any).tasks.has("t1")).toBe(false);
    });

    it("clears the associated timer", () => {
      vi.useFakeTimers();
      const task = createSampleTask({ id: "t1" });
      (service as any).tasks.set("t1", task);
      (service as any).timers.set("t1", setTimeout(() => {}, 60_000));

      service.delete("t1");

      expect((service as any).timers.has("t1")).toBe(false);
    });

    it("emits tasks.changed", () => {
      const task = createSampleTask({ id: "t1" });
      (service as any).tasks.set("t1", task);
      const handler = vi.fn();
      service.on("tasks.changed", handler);

      service.delete("t1");

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // runNow
  // =========================================================================

  describe("runNow", () => {
    it("throws NOT_FOUND when the task does not exist", async () => {
      await expect(service.runNow("nonexistent")).rejects.toThrow("Task not found");
    });

    it("attaches code=NOT_FOUND to the error", async () => {
      await expect(service.runNow("nonexistent")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("delegates to executeTask and returns its result", async () => {
      const task = createSampleTask({ id: "t1" });
      (service as any).tasks.set("t1", task);
      vi.spyOn(service as any, "executeTask").mockResolvedValue({
        taskId: "t1",
        conversationId: "session-xyz",
      });

      const result = await service.runNow("t1");

      expect(result).toEqual({ taskId: "t1", conversationId: "session-xyz" });
      expect((service as any).executeTask).toHaveBeenCalledWith(task);
    });
  });

  // =========================================================================
  // executeTask (private)
  // =========================================================================

  describe("executeTask (private)", () => {
    it("throws when engineManager has not been set", async () => {
      const task = createSampleTask({ id: "t1" });
      await expect((service as any).executeTask(task)).rejects.toThrow(
        "ScheduledTaskService not initialized",
      );
    });

    it("creates a session and sends the task prompt", async () => {
      (service as any).engineManager = mockEngineManager;
      const task = createSampleTask({ id: "t1", engineType: "opencode" as any, directory: "/dir" });

      await (service as any).executeTask(task);

      expect(mockEngineManager.createSession).toHaveBeenCalledWith("opencode", "/dir");
      expect(mockEngineManager.sendMessage).toHaveBeenCalledWith("session-abc", [
        { type: "text", text: "Do some work" },
      ]);
    });

    it("returns taskId and conversationId", async () => {
      (service as any).engineManager = mockEngineManager;
      const result = await (service as any).executeTask(createSampleTask({ id: "t1" }));
      expect(result).toEqual({ taskId: "t1", conversationId: "session-abc" });
    });

    it("registers the new session id in autoApproveSessions", async () => {
      (service as any).engineManager = mockEngineManager;
      await (service as any).executeTask(createSampleTask({ id: "t1" }));
      expect((service as any).autoApproveSessions.has("session-abc")).toBe(true);
    });

    it("evicts oldest sessions when autoApproveSessions exceeds 200", async () => {
      (service as any).engineManager = mockEngineManager;
      // Pre-fill with 201 entries
      for (let i = 0; i < 201; i++) {
        (service as any).autoApproveSessions.add(`old-${i}`);
      }

      await (service as any).executeTask(createSampleTask({ id: "t1" }));

      // Trimmed to 100 kept + 1 new
      expect((service as any).autoApproveSessions.size).toBeLessThanOrEqual(101);
      expect((service as any).autoApproveSessions.has("session-abc")).toBe(true);
    });

    it("updates lastRunAt to the current time", async () => {
      (service as any).engineManager = mockEngineManager;
      const task = createSampleTask({ id: "t1", lastRunAt: null });
      const before = Date.now();

      await (service as any).executeTask(task);

      expect(task.lastRunAt).not.toBeNull();
      expect(task.lastRunAt!).toBeGreaterThanOrEqual(before);
    });

    it("prepends the session id to runHistory", async () => {
      (service as any).engineManager = mockEngineManager;
      const task = createSampleTask({ id: "t1", runHistory: ["prev-session"] });

      await (service as any).executeTask(task);

      expect(task.runHistory[0]).toBe("session-abc");
      expect(task.runHistory[1]).toBe("prev-session");
    });

    it("trims runHistory to the 50-entry maximum", async () => {
      (service as any).engineManager = mockEngineManager;
      const task = createSampleTask({
        id: "t1",
        runHistory: Array.from({ length: 50 }, (_, i) => `s-${i}`),
      });

      await (service as any).executeTask(task);

      expect(task.runHistory.length).toBe(50);
      expect(task.runHistory[0]).toBe("session-abc");
    });

    it("reschedules after successful execution for non-manual enabled tasks", async () => {
      vi.useFakeTimers();
      (service as any).engineManager = mockEngineManager;
      const task = createSampleTask({
        id: "t1",
        enabled: true,
        frequency: { type: "interval", intervalMinutes: 60 },
      });
      const scheduleSpy = vi.spyOn(service as any, "scheduleTask");

      await (service as any).executeTask(task);

      expect(scheduleSpy).toHaveBeenCalledWith(task);
      expect(task.nextRunAt).not.toBeNull();
    });

    it("does not reschedule manual tasks after execution", async () => {
      vi.useFakeTimers();
      (service as any).engineManager = mockEngineManager;
      const task = createSampleTask({ id: "t1", enabled: true, frequency: { type: "manual" } });
      const scheduleSpy = vi.spyOn(service as any, "scheduleTask");

      await (service as any).executeTask(task);

      expect(scheduleSpy).not.toHaveBeenCalled();
    });

    it("emits task.fired with taskId and conversationId", async () => {
      (service as any).engineManager = mockEngineManager;
      const handler = vi.fn();
      service.on("task.fired", handler);

      await (service as any).executeTask(createSampleTask({ id: "t1" }));

      expect(handler).toHaveBeenCalledWith({ taskId: "t1", conversationId: "session-abc" });
    });

    it("emits tasks.changed after execution", async () => {
      (service as any).engineManager = mockEngineManager;
      const handler = vi.fn();
      service.on("tasks.changed", handler);

      await (service as any).executeTask(createSampleTask({ id: "t1" }));

      expect(handler).toHaveBeenCalled();
    });

    it("shows a desktop notification on success", async () => {
      (service as any).engineManager = mockEngineManager;
      await (service as any).executeTask(createSampleTask({ id: "t1", name: "Daily Report" }));
      expect(mockNotificationShow).toHaveBeenCalled();
    });

    it("removes the task from runningTasks after successful execution", async () => {
      (service as any).engineManager = mockEngineManager;
      const task = createSampleTask({ id: "t1" });

      await (service as any).executeTask(task);

      expect((service as any).runningTasks.has("t1")).toBe(false);
    });

    it("emits task.failed and re-throws on createSession error", async () => {
      (service as any).engineManager = mockEngineManager;
      mockEngineManager.createSession.mockRejectedValueOnce(new Error("session error"));
      const task = createSampleTask({ id: "t1" });
      const failHandler = vi.fn();
      service.on("task.failed", failHandler);

      await expect((service as any).executeTask(task)).rejects.toThrow("session error");
      expect(failHandler).toHaveBeenCalledWith({ taskId: "t1", error: "session error" });
    });

    it("shows an error notification when execution fails", async () => {
      (service as any).engineManager = mockEngineManager;
      mockEngineManager.createSession.mockRejectedValueOnce(new Error("engine down"));
      const task = createSampleTask({ id: "t1" });

      await expect((service as any).executeTask(task)).rejects.toThrow();

      expect(mockNotificationShow).toHaveBeenCalled();
    });

    it("always removes the task from runningTasks, even when execution fails", async () => {
      (service as any).engineManager = mockEngineManager;
      mockEngineManager.createSession.mockRejectedValueOnce(new Error("fail"));
      const task = createSampleTask({ id: "t1" });

      await expect((service as any).executeTask(task)).rejects.toThrow();

      expect((service as any).runningTasks.has("t1")).toBe(false);
    });
  });

  // =========================================================================
  // scheduleTask (private)
  // =========================================================================

  describe("scheduleTask (private)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("does nothing for disabled tasks", () => {
      const task = createSampleTask({ id: "t1", enabled: false, nextRunAt: Date.now() + 1000 });
      (service as any).scheduleTask(task);
      expect((service as any).timers.has("t1")).toBe(false);
    });

    it("does nothing for manual tasks", () => {
      const task = createSampleTask({
        id: "t1",
        enabled: true,
        frequency: { type: "manual" },
        nextRunAt: Date.now() + 1000,
      });
      (service as any).scheduleTask(task);
      expect((service as any).timers.has("t1")).toBe(false);
    });

    it("does nothing when nextRunAt is null", () => {
      const task = createSampleTask({ id: "t1", enabled: true, nextRunAt: null });
      (service as any).scheduleTask(task);
      expect((service as any).timers.has("t1")).toBe(false);
    });

    it("registers a timer entry for a normally scheduled task", () => {
      const task = createSampleTask({ id: "t1", enabled: true, nextRunAt: Date.now() + 5000 });
      (service as any).scheduleTask(task);
      expect((service as any).timers.has("t1")).toBe(true);
    });

    it("clears any existing timer before setting a new one", () => {
      const task = createSampleTask({ id: "t1", enabled: true, nextRunAt: Date.now() + 5000 });
      (service as any).timers.set("t1", setTimeout(() => {}, 10_000));
      const clearSpy = vi.spyOn(service as any, "clearTaskTimer");

      (service as any).scheduleTask(task);

      expect(clearSpy).toHaveBeenCalledWith("t1");
    });

    it("calls executeTask when the timer fires", async () => {
      (service as any).engineManager = mockEngineManager;
      const task = createSampleTask({
        id: "t1",
        enabled: true,
        frequency: { type: "interval", intervalMinutes: 60 },
        nextRunAt: Date.now() + 100,
      });
      (service as any).tasks.set("t1", task);
      const executeSpy = vi.spyOn(service as any, "executeTask").mockResolvedValue({
        taskId: "t1",
        conversationId: "s1",
      });

      (service as any).scheduleTask(task);
      await vi.runAllTimersAsync();

      expect(executeSpy).toHaveBeenCalledWith(task);
    });

    it("uses MAX_TIMEOUT (2147483647 ms) for delays that would overflow", () => {
      const MAX_TIMEOUT = 2_147_483_647;
      const task = createSampleTask({
        id: "t1",
        enabled: true,
        nextRunAt: Date.now() + MAX_TIMEOUT + 1000,
      });
      const rescheduleSpy = vi.spyOn(service as any, "scheduleTask");

      (service as any).scheduleTask(task);

      // Timer registered but does NOT call executeTask immediately
      expect((service as any).timers.has("t1")).toBe(true);

      // Advance by MAX_TIMEOUT — the overflow handler fires and calls scheduleTask again
      vi.advanceTimersByTime(MAX_TIMEOUT);
      expect(rescheduleSpy.mock.calls.length).toBeGreaterThan(1);
    });

    it("reschedules after a task execution failure", async () => {
      (service as any).engineManager = mockEngineManager;
      // Always fail so rescheduled timers don't re-enter this branch and loop
      mockEngineManager.createSession.mockRejectedValue(new Error("persistent fail"));
      const task = createSampleTask({
        id: "t1",
        enabled: true,
        frequency: { type: "interval", intervalMinutes: 60 },
        nextRunAt: Date.now() + 10,
      });
      (service as any).tasks.set("t1", task);
      const scheduleSpy = vi.spyOn(service as any, "scheduleTask");

      (service as any).scheduleTask(task);
      // Only advance enough to fire the initial 10 ms timer; the reschedule
      // timer (~3 600 000 ms) must NOT fire so we avoid an infinite loop.
      await vi.advanceTimersByTimeAsync(20);

      // Original call + at least one reschedule call issued from the catch block
      expect(scheduleSpy.mock.calls.length).toBeGreaterThan(1);
    });

    it("does not reschedule after failure for disabled tasks", async () => {
      (service as any).engineManager = mockEngineManager;
      mockEngineManager.createSession.mockRejectedValueOnce(new Error("fail"));
      const task = createSampleTask({
        id: "t1",
        enabled: true,
        frequency: { type: "interval", intervalMinutes: 60 },
        nextRunAt: Date.now() + 10,
      });
      (service as any).tasks.set("t1", task);

      // Mark as disabled after the timer is set but before execution
      const executeSpy = vi.spyOn(service as any, "executeTask").mockImplementation(async () => {
        task.enabled = false;
        throw new Error("fail");
      });
      const scheduleSpy = vi.spyOn(service as any, "scheduleTask");

      (service as any).scheduleTask(task);
      await vi.runAllTimersAsync();

      // Only the original scheduleTask call; no reschedule because task.enabled=false
      expect(executeSpy).toHaveBeenCalledTimes(1);
      // scheduleSpy call count: 1 (original). No second call.
      const rescheduleCalls = scheduleSpy.mock.calls.length;
      expect(rescheduleCalls).toBe(1);
    });
  });

  // =========================================================================
  // checkMissedRuns (private)
  // =========================================================================

  describe("checkMissedRuns (private)", () => {
    it("skips disabled tasks", () => {
      const task = createSampleTask({ id: "t1", enabled: false });
      (service as any).tasks.set("t1", task);
      (service as any).engineManager = mockEngineManager;
      const executeSpy = vi.spyOn(service as any, "executeTask").mockResolvedValue({} as any);

      (service as any).checkMissedRuns();

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("skips manual tasks", () => {
      const task = createSampleTask({ id: "t1", enabled: true, frequency: { type: "manual" } });
      (service as any).tasks.set("t1", task);
      (service as any).engineManager = mockEngineManager;
      const executeSpy = vi.spyOn(service as any, "executeTask").mockResolvedValue({} as any);

      (service as any).checkMissedRuns();

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("executes tasks with a missed run within the 7-day window", () => {
      const now = Date.now();
      // Created 2 hours ago with interval=60min → expected next run was 1 hour ago
      const task = createSampleTask({
        id: "t1",
        enabled: true,
        frequency: { type: "interval", intervalMinutes: 60 },
        createdAt: now - 2 * 60 * 60_000,
        lastRunAt: null,
      });
      (service as any).tasks.set("t1", task);
      (service as any).engineManager = mockEngineManager;
      const executeSpy = vi.spyOn(service as any, "executeTask").mockResolvedValue({} as any);

      (service as any).checkMissedRuns();

      expect(executeSpy).toHaveBeenCalledWith(task);
    });

    it("skips tasks whose expected next run is still in the future", () => {
      const now = Date.now();
      // Created 30 min ago, interval=60 min → next run in 30 min from now
      const task = createSampleTask({
        id: "t1",
        enabled: true,
        frequency: { type: "interval", intervalMinutes: 60 },
        createdAt: now - 30 * 60_000,
        lastRunAt: null,
      });
      (service as any).tasks.set("t1", task);
      (service as any).engineManager = mockEngineManager;
      const executeSpy = vi.spyOn(service as any, "executeTask").mockResolvedValue({} as any);

      (service as any).checkMissedRuns();

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("skips tasks with missed runs older than the 7-day window", () => {
      const now = Date.now();
      const eightDays = 8 * 24 * 60 * 60_000;
      const task = createSampleTask({
        id: "t1",
        enabled: true,
        frequency: { type: "interval", intervalMinutes: 60 },
        createdAt: now - eightDays,
        lastRunAt: now - eightDays,
      });
      (service as any).tasks.set("t1", task);
      (service as any).engineManager = mockEngineManager;
      const executeSpy = vi.spyOn(service as any, "executeTask").mockResolvedValue({} as any);

      (service as any).checkMissedRuns();

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("uses createdAt as the baseline when lastRunAt is null", () => {
      const now = Date.now();
      const task = createSampleTask({
        id: "t1",
        enabled: true,
        frequency: { type: "interval", intervalMinutes: 60 },
        createdAt: now - 2 * 60 * 60_000,
        lastRunAt: null,
      });
      (service as any).tasks.set("t1", task);
      (service as any).engineManager = mockEngineManager;
      const executeSpy = vi.spyOn(service as any, "executeTask").mockResolvedValue({} as any);

      (service as any).checkMissedRuns();

      expect(executeSpy).toHaveBeenCalledWith(task);
    });

    it("uses lastRunAt as the baseline when present", () => {
      const now = Date.now();
      // lastRunAt was 2 hours ago, interval=60min → next expected was 1 hour ago
      const task = createSampleTask({
        id: "t1",
        enabled: true,
        frequency: { type: "interval", intervalMinutes: 60 },
        createdAt: now - 10 * 60 * 60_000,
        lastRunAt: now - 2 * 60 * 60_000,
      });
      (service as any).tasks.set("t1", task);
      (service as any).engineManager = mockEngineManager;
      const executeSpy = vi.spyOn(service as any, "executeTask").mockResolvedValue({} as any);

      (service as any).checkMissedRuns();

      expect(executeSpy).toHaveBeenCalledWith(task);
    });
  });

  // =========================================================================
  // loadFromDisk (private)
  // =========================================================================

  describe("loadFromDisk (private)", () => {
    it("does nothing when the persistence file does not exist", () => {
      mockExistsSync.mockReturnValue(false);
      (service as any).loadFromDisk();
      expect((service as any).tasks.size).toBe(0);
    });

    it("loads tasks from a valid file", () => {
      const task = createSampleTask({ id: "t1" });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1, tasks: [task] }));

      (service as any).loadFromDisk();

      expect((service as any).tasks.get("t1")).toEqual(task);
    });

    it("ignores a file with an unrecognised version number", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: 2, tasks: [] }));

      (service as any).loadFromDisk();

      expect((service as any).tasks.size).toBe(0);
    });

    it("ignores a file where tasks is not an array", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1, tasks: "bad" }));

      (service as any).loadFromDisk();

      expect((service as any).tasks.size).toBe(0);
    });

    it("handles malformed JSON gracefully without throwing", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not-json{{{");

      expect(() => (service as any).loadFromDisk()).not.toThrow();
      expect((service as any).tasks.size).toBe(0);
    });

    it("handles readFileSync errors gracefully without throwing", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => { throw new Error("disk error"); });

      expect(() => (service as any).loadFromDisk()).not.toThrow();
    });
  });

  // =========================================================================
  // writeToDisk (private)
  // =========================================================================

  describe("writeToDisk (private)", () => {
    it("writes tasks as a JSON blob via an atomic tmp→rename pattern", () => {
      mockExistsSync.mockReturnValue(true);
      const task = createSampleTask({ id: "t1" });
      (service as any).tasks.set("t1", task);

      (service as any).writeToDisk();

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining(".tmp"),
        expect.stringContaining('"version": 1'),
        "utf-8",
      );
      expect(mockRenameSync).toHaveBeenCalled();
    });

    it("includes all current tasks in the written payload", () => {
      mockExistsSync.mockReturnValue(true);
      const task = createSampleTask({ id: "t1", name: "My Task" });
      (service as any).tasks.set("t1", task);

      (service as any).writeToDisk();

      const written = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.tasks).toHaveLength(1);
      expect(parsed.tasks[0].name).toBe("My Task");
    });

    it("creates the data directory when it does not exist", () => {
      mockExistsSync.mockReturnValue(false);

      (service as any).writeToDisk();

      expect(mockMkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });

    it("handles writeFileSync errors gracefully without throwing", () => {
      mockExistsSync.mockReturnValue(true);
      mockWriteFileSync.mockImplementation(() => { throw new Error("write error"); });

      expect(() => (service as any).writeToDisk()).not.toThrow();
    });

    it("handles renameSync errors gracefully without throwing", () => {
      mockExistsSync.mockReturnValue(true);
      mockRenameSync.mockImplementation(() => { throw new Error("rename error"); });

      expect(() => (service as any).writeToDisk()).not.toThrow();
    });
  });

  // =========================================================================
  // scheduleSave (private) — debounce logic
  // =========================================================================

  describe("scheduleSave (private)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("sets a non-null saveTimer", () => {
      (service as any).scheduleSave();
      expect((service as any).saveTimer).not.toBeNull();
    });

    it("coalesces multiple calls into a single disk write", () => {
      mockExistsSync.mockReturnValue(true);
      const writeSpy = vi.spyOn(service as any, "writeToDisk");

      (service as any).scheduleSave();
      (service as any).scheduleSave();
      (service as any).scheduleSave();

      vi.advanceTimersByTime(600); // beyond the 500 ms debounce

      expect(writeSpy).toHaveBeenCalledTimes(1);
    });

    it("nullifies saveTimer after the write executes", () => {
      mockExistsSync.mockReturnValue(true);
      (service as any).scheduleSave();
      vi.advanceTimersByTime(600);
      expect((service as any).saveTimer).toBeNull();
    });
  });

  // =========================================================================
  // showNotification (private)
  // =========================================================================

  describe("showNotification (private)", () => {
    it("shows a notification when Notification.isSupported() returns true", () => {
      mockNotificationIsSupported.mockReturnValue(true);
      (service as any).showNotification("Title", "Body");
      expect(mockNotificationShow).toHaveBeenCalled();
    });

    it("does not show a notification when Notification.isSupported() returns false", () => {
      mockNotificationIsSupported.mockReturnValue(false);
      (service as any).showNotification("Title", "Body");
      expect(mockNotificationShow).not.toHaveBeenCalled();
    });

    it("handles errors from the Notification constructor gracefully", () => {
      mockNotificationIsSupported.mockReturnValue(true);
      mockNotificationShow.mockImplementationOnce(() => { throw new Error("notify error"); });

      expect(() => (service as any).showNotification("T", "B")).not.toThrow();
    });
  });

  // =========================================================================
  // subscribePermissionAutoApprove (private)
  // =========================================================================

  describe("subscribePermissionAutoApprove (private)", () => {
    it("does nothing when engineManager is null", () => {
      (service as any).engineManager = null;
      expect(() => (service as any).subscribePermissionAutoApprove()).not.toThrow();
    });

    it("auto-approves permissions for tracked sessions using the nested .permission shape", () => {
      (service as any).engineManager = mockEngineManager;
      (service as any).autoApproveSessions.add("my-session");
      (service as any).subscribePermissionAutoApprove();

      const [, handler] = mockEngineManager.on.mock.calls.find(([e]) => e === "permission.asked")!;
      handler({
        permission: {
          id: "perm-1",
          sessionId: "my-session",
          options: [{ id: "opt-allow", type: "allow", label: "Allow" }],
        },
      });

      expect(mockEngineManager.replyPermission).toHaveBeenCalledWith("perm-1", { optionId: "opt-allow" });
    });

    it("auto-approves using the flat data shape (no .permission wrapper)", () => {
      (service as any).engineManager = mockEngineManager;
      (service as any).autoApproveSessions.add("session-flat");
      (service as any).subscribePermissionAutoApprove();

      const [, handler] = mockEngineManager.on.mock.calls.find(([e]) => e === "permission.asked")!;
      handler({
        id: "perm-2",
        sessionId: "session-flat",
        options: [{ id: "opt-accept", type: "accept", label: "Accept" }],
      });

      expect(mockEngineManager.replyPermission).toHaveBeenCalledWith("perm-2", { optionId: "opt-accept" });
    });

    it("ignores permissions whose sessionId is not tracked", () => {
      (service as any).engineManager = mockEngineManager;
      (service as any).subscribePermissionAutoApprove();

      const [, handler] = mockEngineManager.on.mock.calls.find(([e]) => e === "permission.asked")!;
      handler({
        permission: {
          id: "perm-x",
          sessionId: "unknown-session",
          options: [{ id: "opt-allow", type: "allow", label: "Allow" }],
        },
      });

      expect(mockEngineManager.replyPermission).not.toHaveBeenCalled();
    });

    it("ignores permissions that have no options containing 'accept' or 'allow'", () => {
      (service as any).engineManager = mockEngineManager;
      (service as any).autoApproveSessions.add("my-session");
      (service as any).subscribePermissionAutoApprove();

      const [, handler] = mockEngineManager.on.mock.calls.find(([e]) => e === "permission.asked")!;
      handler({
        permission: {
          id: "perm-y",
          sessionId: "my-session",
          options: [{ id: "opt-deny", type: "deny", label: "Deny" }],
        },
      });

      expect(mockEngineManager.replyPermission).not.toHaveBeenCalled();
    });

    it("matches options whose label contains 'allow' (case-insensitive)", () => {
      (service as any).engineManager = mockEngineManager;
      (service as any).autoApproveSessions.add("session-label");
      (service as any).subscribePermissionAutoApprove();

      const [, handler] = mockEngineManager.on.mock.calls.find(([e]) => e === "permission.asked")!;
      handler({
        permission: {
          id: "perm-3",
          sessionId: "session-label",
          options: [{ id: "opt-label", type: "other", label: "Allow this action" }],
        },
      });

      expect(mockEngineManager.replyPermission).toHaveBeenCalledWith("perm-3", {
        optionId: "opt-label",
      });
    });

    it("ignores events with no sessionId", () => {
      (service as any).engineManager = mockEngineManager;
      (service as any).subscribePermissionAutoApprove();

      const [, handler] = mockEngineManager.on.mock.calls.find(([e]) => e === "permission.asked")!;
      handler({ permission: { id: "perm-nosession", options: [] } });

      expect(mockEngineManager.replyPermission).not.toHaveBeenCalled();
    });
  });
});
