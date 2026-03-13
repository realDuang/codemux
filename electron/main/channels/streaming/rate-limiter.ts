// ============================================================================
// Rate Limiter — Token Bucket algorithm for API rate limiting
// Shared across all channel adapters that need to throttle API calls.
// ============================================================================

/**
 * Token bucket rate limiter.
 * Allows bursts up to `capacity`, refills at `refillRate` tokens per second.
 * `consume()` waits if no tokens are available.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private consuming = false;

  constructor(
    private capacity: number,
    private refillRate: number, // tokens per second
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  async consume(): Promise<void> {
    // Prevent race condition by serializing consume operations
    while (this.consuming) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    this.consuming = true;
    try {
      // Loop until we can consume a token
      while (true) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        // Wait for next token
        const waitMs = ((1 - this.tokens) / this.refillRate) * 1000;
        await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitMs)));
      }
    } finally {
      this.consuming = false;
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}
