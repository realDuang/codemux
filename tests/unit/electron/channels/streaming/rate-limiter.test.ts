import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { TokenBucket } from "../../../../../electron/main/channels/streaming/rate-limiter";

describe("TokenBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe("constructor", () => {
    it("initializes with full capacity", async () => {
      const bucket = new TokenBucket(5, 1);

      // Should be able to consume `capacity` tokens immediately without waiting
      for (let i = 0; i < 5; i++) {
        await bucket.consume();
      }
      // All 5 consumed synchronously — if capacity wasn't full, one of these
      // would have triggered an internal wait and the test would hang.
    });
  });

  // -------------------------------------------------------------------------
  // consume() — tokens available
  // -------------------------------------------------------------------------

  describe("consume() with available tokens", () => {
    it("consumes immediately and decrements tokens", async () => {
      const bucket = new TokenBucket(3, 1);

      // First consume should resolve immediately
      await bucket.consume();

      // We used 1 token out of 3 — two more should also be instant
      await bucket.consume();
      await bucket.consume();

      // The fourth consume should NOT resolve immediately because tokens are
      // exhausted. We verify by racing it against a resolved promise.
      let fourthResolved = false;
      const fourth = bucket.consume().then(() => {
        fourthResolved = true;
      });

      // Flush microtasks only (no timer advancement)
      await vi.advanceTimersByTimeAsync(0);
      expect(fourthResolved).toBe(false);

      // Clean up — advance enough time for the refill so the promise settles
      await vi.advanceTimersByTimeAsync(1_100);
      await fourth;
    });

    it("allows burst consumption up to full capacity", async () => {
      const capacity = 10;
      const bucket = new TokenBucket(capacity, 1);

      // All capacity tokens should be consumed without any delay
      const start = Date.now();
      for (let i = 0; i < capacity; i++) {
        await bucket.consume();
      }
      const elapsed = Date.now() - start;

      // With fake timers no real time passes — elapsed should be 0
      expect(elapsed).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // consume() — tokens exhausted
  // -------------------------------------------------------------------------

  describe("consume() when exhausted", () => {
    it("waits for refill when no tokens are available", async () => {
      // 1 token capacity, refills at 1 token/second
      const bucket = new TokenBucket(1, 1);

      // Exhaust the single token
      await bucket.consume();

      // Next consume must wait for a refill
      let resolved = false;
      const pending = bucket.consume().then(() => {
        resolved = true;
      });

      // Flush microtasks — should still be pending
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      // Advance time past the refill interval (1 second for rate=1 t/s)
      await vi.advanceTimersByTimeAsync(1_100);
      await pending;

      expect(resolved).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // refill logic
  // -------------------------------------------------------------------------

  describe("refill", () => {
    it("refills tokens based on elapsed time", async () => {
      const bucket = new TokenBucket(5, 2); // capacity 5, 2 tokens/sec

      // Drain all 5 tokens
      for (let i = 0; i < 5; i++) {
        await bucket.consume();
      }

      // Advance 1 second — should refill 2 tokens (rate = 2/s)
      await vi.advanceTimersByTimeAsync(1_000);

      // Both of these should succeed instantly (2 tokens available)
      await bucket.consume();
      await bucket.consume();

      // Third should block
      let thirdResolved = false;
      const third = bucket.consume().then(() => {
        thirdResolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(thirdResolved).toBe(false);

      // Clean up
      await vi.advanceTimersByTimeAsync(1_000);
      await third;
    });

    it("caps tokens at capacity", async () => {
      const bucket = new TokenBucket(3, 10); // capacity 3, fast refill

      // Exhaust all tokens
      for (let i = 0; i < 3; i++) {
        await bucket.consume();
      }

      // Wait a long time — tokens should refill but never exceed capacity
      await vi.advanceTimersByTimeAsync(10_000);

      // Should be able to consume exactly 3 (capacity) without blocking
      for (let i = 0; i < 3; i++) {
        await bucket.consume();
      }

      // 4th should block — proves we didn't exceed capacity
      let fourthResolved = false;
      const fourth = bucket.consume().then(() => {
        fourthResolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fourthResolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      await fourth;
    });
  });

  // -------------------------------------------------------------------------
  // Serialization (consuming flag)
  // -------------------------------------------------------------------------

  describe("serialization", () => {
    it("serializes concurrent consume() calls via the consuming flag", async () => {
      const bucket = new TokenBucket(2, 1);

      const order: number[] = [];

      // Fire two consumes concurrently
      const p1 = bucket.consume().then(() => order.push(1));
      const p2 = bucket.consume().then(() => order.push(2));

      // Let the serialization spin-wait resolve
      await vi.advanceTimersByTimeAsync(10);

      await Promise.all([p1, p2]);

      // Both should have completed and the first-in should finish first
      expect(order).toEqual([1, 2]);
    });

    it("third concurrent call waits for token refill after capacity exhausted", async () => {
      const bucket = new TokenBucket(2, 1);

      let thirdDone = false;

      // Fire three concurrent consumes — only 2 tokens available
      const p1 = bucket.consume();
      const p2 = bucket.consume();
      const p3 = bucket.consume().then(() => {
        thirdDone = true;
      });

      // Let the first two resolve (they have tokens)
      await vi.advanceTimersByTimeAsync(10);
      await p1;
      await p2;

      // Third should still be pending — no tokens left
      expect(thirdDone).toBe(false);

      // Advance enough for refill
      await vi.advanceTimersByTimeAsync(1_100);
      await p3;

      expect(thirdDone).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Refill rate comparison
  // -------------------------------------------------------------------------

  describe("refill rate", () => {
    it("higher refill rate results in shorter wait", async () => {
      const slow = new TokenBucket(1, 1); // 1 token/sec
      const fast = new TokenBucket(1, 10); // 10 tokens/sec

      // Exhaust both
      await slow.consume();
      await fast.consume();

      let fastDone = false;
      let slowDone = false;

      const pFast = fast.consume().then(() => {
        fastDone = true;
      });
      const pSlow = slow.consume().then(() => {
        slowDone = true;
      });

      // After 150ms the fast bucket (10 t/s → 100ms per token) should have
      // refilled, but the slow bucket (1 t/s → 1000ms per token) should not.
      await vi.advanceTimersByTimeAsync(150);

      expect(fastDone).toBe(true);
      expect(slowDone).toBe(false);

      // Clean up — let the slow one finish
      await vi.advanceTimersByTimeAsync(1_000);
      await pFast;
      await pSlow;
    });
  });
});
