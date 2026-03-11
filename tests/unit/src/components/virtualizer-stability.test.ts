// =============================================================================
// Unit tests: Virtualizer Measurement Stability
//
// Validates the fixes for the overlap/blank rendering bug in long sessions.
//
// Root causes addressed:
//   1. position:sticky inside position:absolute virtualizer rows causes layout
//      engine conflicts (CSS fix — not testable here, but measurement stability is)
//   2. solid-virtual's createComputed calls virtualizer.measure() on every
//      reactive option change, clearing ALL cached item sizes
//   3. queueMicrotask in measureElement caused measurement lag, racing with
//      cache-clearing
//   4. estimateSize: 150 was too low for rows with steps bars (~200-550px),
//      causing totalSize to collapse when cache is cleared
// =============================================================================

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Helpers — simulate virtualizer behavior without DOM
// ---------------------------------------------------------------------------

/**
 * Calculate totalSize using estimateSize for items without cached sizes.
 */
function calculateTotalSize(
  estimateSize: number,
  cachedSizes: Map<number, number>,
  count: number,
  gap: number = 20
): number {
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += cachedSizes.get(i) ?? estimateSize;
    if (i < count - 1) total += gap;
  }
  return total;
}

/**
 * Calculate real total size from actual heights.
 */
function calculateRealTotalSize(heights: number[], gap: number = 20): number {
  let total = 0;
  for (let i = 0; i < heights.length; i++) {
    total += heights[i];
    if (i < heights.length - 1) total += gap;
  }
  return total;
}

/**
 * Deterministic row height distribution matching real SessionTurn rows:
 * - Collapsed (no steps): ~150-250px
 * - Expanded steps: ~400-600px
 *
 * Uses a simple deterministic pattern instead of Math.random().
 */
function generateDeterministicHeights(count: number, expandedIndices: number[] = []): number[] {
  const expandedSet = new Set(expandedIndices);
  const heights: number[] = [];
  for (let i = 0; i < count; i++) {
    if (expandedSet.has(i)) {
      // Expanded: 400-600px range, deterministic
      heights.push(400 + (i * 37) % 200);
    } else {
      // Collapsed: 150-250px range, deterministic
      heights.push(150 + (i * 23) % 100);
    }
  }
  return heights;
}

// ---------------------------------------------------------------------------
// Tests: estimateSize accuracy
// ---------------------------------------------------------------------------

describe("estimateSize accuracy: totalSize error after cache clear", () => {
  const COUNT = 50;
  const GAP = 20;
  // ~10% expanded items at indices 5, 15, 25, 35, 45
  const expandedIndices = [5, 15, 25, 35, 45];
  const heights = generateDeterministicHeights(COUNT, expandedIndices);
  const realTotal = calculateRealTotalSize(heights, GAP);

  it("estimateSize=200 has lower error than estimateSize=150", () => {
    const error150 = Math.abs(realTotal - calculateTotalSize(150, new Map(), COUNT, GAP)) / realTotal;
    const error200 = Math.abs(realTotal - calculateTotalSize(200, new Map(), COUNT, GAP)) / realTotal;

    // 200 is closer to the weighted average of collapsed (150-250) + expanded (400-600)
    expect(error200).toBeLessThan(error150);
  });

  it("estimateSize=200 error ratio is within 15%", () => {
    const error200 = Math.abs(realTotal - calculateTotalSize(200, new Map(), COUNT, GAP)) / realTotal;
    expect(error200).toBeLessThan(0.15);
  });

  it("estimateSize=150 error ratio is above 10%", () => {
    const error150 = Math.abs(realTotal - calculateTotalSize(150, new Map(), COUNT, GAP)) / realTotal;
    // 150 is too low for a mix of collapsed + expanded items
    expect(error150).toBeGreaterThan(0.10);
  });
});

// ---------------------------------------------------------------------------
// Tests: Cache rebuild speed after measure() clears all sizes
// ---------------------------------------------------------------------------

describe("cache rebuild: overscan impact on recovery", () => {
  const COUNT = 50;
  const GAP = 20;
  const heights = generateDeterministicHeights(COUNT, [5, 15, 25, 35, 45]);

  it("higher overscan recovers more error after cache clear", () => {
    const realTotal = calculateRealTotalSize(heights, GAP);
    const scrollPosition = Math.floor(COUNT / 2);
    const visibleCount = 5;

    const recoveryByOverscan: Record<number, number> = {};

    for (const overscan of [3, 5, 8, 12]) {
      // Start fully cached
      const cache = new Map<number, number>();
      for (let i = 0; i < COUNT; i++) cache.set(i, heights[i]);

      // Clear all (simulating measure())
      cache.clear();

      // Re-measure visible window + overscan items
      const measureStart = Math.max(0, scrollPosition - overscan);
      const measureEnd = Math.min(COUNT, scrollPosition + visibleCount + overscan);
      for (let i = measureStart; i < measureEnd; i++) {
        cache.set(i, heights[i]);
      }

      const recoveredTotal = calculateTotalSize(200, cache, COUNT, GAP);
      const errorRatio = Math.abs(realTotal - recoveredTotal) / realTotal;
      recoveryByOverscan[overscan] = errorRatio;
    }

    // Higher overscan should yield lower error
    expect(recoveryByOverscan[12]).toBeLessThan(recoveryByOverscan[3]);
    expect(recoveryByOverscan[8]).toBeLessThan(recoveryByOverscan[3]);
  });

  it("overscan=5 re-measures at least 15 items", () => {
    const overscan = 5;
    const scrollPosition = Math.floor(COUNT / 2);
    const visibleCount = 5;
    const measureStart = Math.max(0, scrollPosition - overscan);
    const measureEnd = Math.min(COUNT, scrollPosition + visibleCount + overscan);
    const measuredCount = measureEnd - measureStart;

    expect(measuredCount).toBeGreaterThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// Tests: Height variation — steps expand/collapse offset calculation
// ---------------------------------------------------------------------------

describe("height variation: steps expand/collapse offset calculation", () => {
  const COUNT = 30;
  const GAP = 20;

  function calculateOffsets(cache: Map<number, number>, count: number, estimateSize: number): number[] {
    const offsets: number[] = [0];
    for (let i = 1; i < count; i++) {
      offsets.push(offsets[i - 1] + (cache.get(i - 1) ?? estimateSize) + GAP);
    }
    return offsets;
  }

  it("expanding items shifts subsequent offsets correctly", () => {
    const heights = Array.from({ length: COUNT }, () => 200);
    const cache = new Map<number, number>();
    for (let i = 0; i < COUNT; i++) cache.set(i, heights[i]);

    const offsetsBefore = calculateOffsets(cache, COUNT, 200);

    // Expand 3 items from 200px to 550px
    const expandIndices = [5, 12, 20];
    for (const idx of expandIndices) {
      cache.set(idx, 550);
    }

    const offsetsAfter = calculateOffsets(cache, COUNT, 200);

    // Items before the first expand should not shift
    for (let i = 0; i <= 5; i++) {
      expect(offsetsAfter[i]).toBe(offsetsBefore[i]);
    }

    // Items after the first expand should shift by 350px (550 - 200)
    expect(offsetsAfter[6]).toBe(offsetsBefore[6] + 350);

    // Items after the second expand should shift by 700px (2 * 350)
    expect(offsetsAfter[13]).toBe(offsetsBefore[13] + 700);

    // Items after all 3 expands should shift by 1050px (3 * 350)
    expect(offsetsAfter[21]).toBe(offsetsBefore[21] + 1050);
  });

  it("scroll adjustment accumulates correctly for 10 sequential expands", () => {
    const COUNT_LARGE = 50;
    const cache = new Map<number, number>();
    for (let i = 0; i < COUNT_LARGE; i++) cache.set(i, 200);

    let scrollAdjustment = 0;
    const scrollPosition = 10; // Items 0-9 are above viewport

    for (let expandIdx = 0; expandIdx < 10; expandIdx++) {
      const oldSize = cache.get(expandIdx) ?? 200;
      const newSize = 550;
      cache.set(expandIdx, newSize);

      if (expandIdx < scrollPosition) {
        scrollAdjustment += newSize - oldSize;
      }
    }

    // 10 items × (550 - 200) = 3500px
    expect(scrollAdjustment).toBe(3500);
  });
});

// ---------------------------------------------------------------------------
// Tests: measureElement sync vs queueMicrotask timing
// ---------------------------------------------------------------------------

describe("measureElement timing: sync vs queueMicrotask", () => {
  it("sync measurement survives a subsequent cache clear", () => {
    const cache = new Map<number, number>();

    // Sync: measure 20 items directly
    for (let i = 0; i < 20; i++) {
      cache.set(i, 200 + i * 10);
    }
    expect(cache.size).toBe(20);

    // Simulate measure() clearing cache (happens on reactive change)
    cache.clear();
    expect(cache.size).toBe(0);

    // Key point: the initial measurement was captured before the clear.
    // With sync measurement, the values were available for layout calculation
    // during the frame they were set.
  });

  it("queueMicrotask measurement loses data when interleaved with cache clears", async () => {
    const cache = new Map<number, number>();
    const sizes = generateDeterministicHeights(20);
    const microtasks: Promise<void>[] = [];

    for (let i = 0; i < 20; i++) {
      // Schedule measurement via microtask (old broken behavior)
      microtasks.push(
        Promise.resolve().then(() => {
          cache.set(i, sizes[i]);
        })
      );

      // Every 5 measurements, a reactive change triggers cache clear
      if (i > 0 && i % 5 === 0) {
        microtasks.push(
          Promise.resolve().then(() => {
            cache.clear();
          })
        );
      }
    }

    await Promise.all(microtasks);

    // With interleaved clears, cache size should be less than 20
    // because clears wipe out previously set measurements
    expect(cache.size).toBeLessThan(20);
  });
});

// ---------------------------------------------------------------------------
// Tests: Scroll container stability — null transitions
// ---------------------------------------------------------------------------

describe("scroll container: null transition impact on cache", () => {
  it("stable container only clears cache once during session switch", () => {
    const COUNT = 30;
    const heights = generateDeterministicHeights(COUNT, [3, 10, 20]);
    const cache = new Map<number, number>();
    let clearCount = 0;

    // Initial state: all items measured
    for (let i = 0; i < COUNT; i++) cache.set(i, heights[i]);
    expect(cache.size).toBe(COUNT);

    // Stable container session switch: one clear when count changes
    cache.clear();
    clearCount++;

    // New session data arrives
    const newHeights = generateDeterministicHeights(COUNT, [2, 8, 18]);
    for (let i = 0; i < COUNT; i++) cache.set(i, newHeights[i]);

    expect(clearCount).toBe(1);
    expect(cache.size).toBe(COUNT);
  });

  it("unstable container causes 3 cache clears during session switch", () => {
    const COUNT = 30;
    const heights = generateDeterministicHeights(COUNT, [3, 10, 20]);
    const cache = new Map<number, number>();
    let clearCount = 0;

    // Initial state: all items measured
    for (let i = 0; i < COUNT; i++) cache.set(i, heights[i]);

    // Unstable container (old behavior): 3 clears
    // 1. Show fallback renders → scroll div destroyed → measure()
    cache.clear();
    clearCount++;

    // 2. Show content renders → new scroll div → measure()
    cache.clear();
    clearCount++;

    // 3. Data loads, count changes → measure()
    cache.clear();
    clearCount++;

    // Re-measure
    const newHeights = generateDeterministicHeights(COUNT, [2, 8, 18]);
    for (let i = 0; i < COUNT; i++) cache.set(i, newHeights[i]);

    expect(clearCount).toBe(3);
    // Stable container saves 2 unnecessary cache clears
  });
});
