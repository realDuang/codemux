import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ScheduledTaskFrequency } from "../../../../src/types/unified";

// Mock electron modules
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/test-userData"),
    isPackaged: false,
    on: vi.fn(),
  },
  Notification: vi.fn().mockImplementation(() => ({
    show: vi.fn(),
  })),
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
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

// Import after mocks
import { ScheduledTaskService } from "../../../../electron/main/services/scheduled-task-service";

describe("ScheduledTaskService", () => {
  let service: ScheduledTaskService;

  beforeEach(() => {
    // Create service with a mock engineManager
    const mockEngineManager = {
      on: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
    } as any;
    service = new ScheduledTaskService(mockEngineManager);
  });

  describe("computeNextRun", () => {
    it("returns null for manual frequency", () => {
      const freq: ScheduledTaskFrequency = { type: "manual" };
      expect(service.computeNextRun(freq, 0, Date.now())).toBeNull();
    });

    it("computes next interval run correctly", () => {
      const now = Date.now();
      const freq: ScheduledTaskFrequency = {
        type: "interval",
        intervalMinutes: 60, // 1 hour
      };
      const jitterMs = 0;
      const next = service.computeNextRun(freq, jitterMs, now);

      expect(next).not.toBeNull();
      // Should be approximately 1 hour after "now"
      expect(next! - now).toBe(60 * 60_000);
    });

    it("applies jitter to interval (capped at 10% of interval)", () => {
      const now = Date.now();
      const freq: ScheduledTaskFrequency = {
        type: "interval",
        intervalMinutes: 60,
      };
      const jitterMs = 300_000; // 5 minutes
      const next = service.computeNextRun(freq, jitterMs, now);

      expect(next).not.toBeNull();
      // Interval = 3600000ms, capped jitter = min(300000, 360000) = 300000
      expect(next! - now).toBe(60 * 60_000 + 300_000);
    });

    it("caps jitter at 10% of interval", () => {
      const now = Date.now();
      const freq: ScheduledTaskFrequency = {
        type: "interval",
        intervalMinutes: 10, // 10 min = 600_000ms, 10% = 60_000ms
      };
      const jitterMs = 300_000; // 5 min, but should be capped to 60s
      const next = service.computeNextRun(freq, jitterMs, now);

      expect(next).not.toBeNull();
      // Capped jitter = min(300000, 60000) = 60000
      expect(next! - now).toBe(10 * 60_000 + 60_000);
    });

    it("computes next daily run (future time today)", () => {
      // Set "afterMs" to 8:00 AM today
      const today = new Date();
      today.setHours(8, 0, 0, 0);
      const afterMs = today.getTime();

      const freq: ScheduledTaskFrequency = {
        type: "daily",
        hour: 10,
        minute: 30,
      };
      const next = service.computeNextRun(freq, 0, afterMs);

      expect(next).not.toBeNull();
      const nextDate = new Date(next!);
      expect(nextDate.getHours()).toBe(10);
      expect(nextDate.getMinutes()).toBe(30);
      // Should be same day since 10:30 > 8:00
      expect(nextDate.getDate()).toBe(today.getDate());
    });

    it("computes next daily run (past time today → tomorrow)", () => {
      // Set "afterMs" to 14:00 PM today
      const today = new Date();
      today.setHours(14, 0, 0, 0);
      const afterMs = today.getTime();

      const freq: ScheduledTaskFrequency = {
        type: "daily",
        hour: 10,
        minute: 0,
      };
      const next = service.computeNextRun(freq, 0, afterMs);

      expect(next).not.toBeNull();
      const nextDate = new Date(next!);
      expect(nextDate.getHours()).toBe(10);
      expect(nextDate.getMinutes()).toBe(0);
      // Should be next day since 10:00 < 14:00
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      expect(nextDate.getDate()).toBe(tomorrow.getDate());
    });

    it("computes next weekly run for a future day this week", () => {
      // Create a Monday at 8:00 AM
      const monday = new Date();
      // Find next Monday
      const dayOfWeek = monday.getDay();
      const daysUntilMonday = (1 - dayOfWeek + 7) % 7 || 7;
      monday.setDate(monday.getDate() + daysUntilMonday);
      monday.setHours(8, 0, 0, 0);
      const afterMs = monday.getTime();

      const freq: ScheduledTaskFrequency = {
        type: "weekly",
        hour: 9,
        minute: 0,
        daysOfWeek: [3], // Wednesday
      };
      const next = service.computeNextRun(freq, 0, afterMs);

      expect(next).not.toBeNull();
      const nextDate = new Date(next!);
      expect(nextDate.getDay()).toBe(3); // Wednesday
      expect(nextDate.getHours()).toBe(9);
    });

    it("returns null for weekly with empty daysOfWeek", () => {
      const freq: ScheduledTaskFrequency = {
        type: "weekly",
        hour: 9,
        minute: 0,
        daysOfWeek: [],
      };
      expect(service.computeNextRun(freq, 0, Date.now())).toBeNull();
    });

    it("picks earliest day when multiple daysOfWeek", () => {
      // Start from a Monday at 8:00
      const monday = new Date();
      const dayOfWeek = monday.getDay();
      const daysUntilMonday = (1 - dayOfWeek + 7) % 7 || 7;
      monday.setDate(monday.getDate() + daysUntilMonday);
      monday.setHours(8, 0, 0, 0);
      const afterMs = monday.getTime();

      const freq: ScheduledTaskFrequency = {
        type: "weekly",
        hour: 9,
        minute: 0,
        daysOfWeek: [3, 5], // Wednesday and Friday
      };
      const next = service.computeNextRun(freq, 0, afterMs);

      expect(next).not.toBeNull();
      const nextDate = new Date(next!);
      // Wednesday (day 3) is closer than Friday (day 5)
      expect(nextDate.getDay()).toBe(3);
    });

    it("defaults interval to 60 minutes if not specified", () => {
      const now = Date.now();
      const freq: ScheduledTaskFrequency = {
        type: "interval",
        // intervalMinutes not specified → defaults to 60
      };
      const next = service.computeNextRun(freq, 0, now);

      expect(next).not.toBeNull();
      expect(next! - now).toBe(60 * 60_000);
    });

    it("defaults daily to 9:00 if hour/minute not specified", () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0); // midnight
      const afterMs = today.getTime();

      const freq: ScheduledTaskFrequency = {
        type: "daily",
        // hour/minute not specified → defaults to 9:00
      };
      const next = service.computeNextRun(freq, 0, afterMs);

      expect(next).not.toBeNull();
      const nextDate = new Date(next!);
      expect(nextDate.getHours()).toBe(9);
      expect(nextDate.getMinutes()).toBe(0);
    });
  });
});
