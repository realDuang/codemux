import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { timeId } from "../../../../electron/main/utils/id-gen";

describe("timeId", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("generates ID with correct format: prefix_hexTimestamp_hexCounter_randomHex", () => {
    const prefix = "conv";
    const id = timeId(prefix);
    
    // Format: prefix_ (12 hex) (4 hex) (10 hex)
    // total 1 + 12 + 4 + 10 = 27 characters + prefix length
    expect(id).toMatch(/^conv_[0-9a-f]{12}[0-9a-f]{4}[0-9a-f]{10}$/);
  });

  it("generates unique IDs across multiple calls", () => {
    const ids = new Set();
    for (let i = 0; i < 10; i++) {
      ids.add(timeId("test"));
    }
    
    expect(ids.size).toBe(10);
  });

  it("increments counter for same-millisecond calls", () => {
    const now = new Date("2025-01-01T00:00:00Z");
    vi.setSystemTime(now);
    
    const id1 = timeId("prefix");
    const id2 = timeId("prefix");
    
    const counterPart1 = id1.split("_")[1].substring(12, 16);
    const counterPart2 = id2.split("_")[1].substring(12, 16);
    
    expect(counterPart1).toBe("0000");
    expect(counterPart2).toBe("0001");
    // Timestamp parts should be identical
    expect(id1.split("_")[1].substring(0, 12)).toBe(id2.split("_")[1].substring(0, 12));
  });
});
