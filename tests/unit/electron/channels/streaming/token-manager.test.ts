import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  TokenManager,
  type TokenFetcher,
  type TokenFetchResult,
} from "../../../../../electron/main/channels/streaming/token-manager";

// Safety margin constant mirrored from the source (5 minutes in ms)
const SAFETY_MARGIN_MS = 5 * 60 * 1000;

describe("TokenManager", () => {
  let fetcher: ReturnType<typeof vi.fn<TokenFetcher>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    fetcher = vi.fn<TokenFetcher>().mockResolvedValue({
      token: "tok-abc",
      expiresInSeconds: 7200, // 2 hours
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // getToken() — first call
  // -------------------------------------------------------------------------

  describe("getToken() - first call", () => {
    it("triggers the fetcher and returns the token", async () => {
      const mgr = new TokenManager(fetcher);

      const token = await mgr.getToken();

      expect(fetcher).toHaveBeenCalledOnce();
      expect(token).toBe("tok-abc");
    });
  });

  // -------------------------------------------------------------------------
  // getToken() — cached
  // -------------------------------------------------------------------------

  describe("getToken() - cached", () => {
    it("returns the cached token without calling fetcher again", async () => {
      const mgr = new TokenManager(fetcher);

      await mgr.getToken();
      const second = await mgr.getToken();

      expect(fetcher).toHaveBeenCalledOnce();
      expect(second).toBe("tok-abc");
    });
  });

  // -------------------------------------------------------------------------
  // getToken() — expired
  // -------------------------------------------------------------------------

  describe("getToken() - expired", () => {
    it("re-fetches when the token has expired", async () => {
      const mgr = new TokenManager(fetcher);

      await mgr.getToken();

      // Advance time past full expiry (7200s = 2h)
      vi.advanceTimersByTime(7200 * 1000);

      fetcher.mockResolvedValueOnce({
        token: "tok-refreshed",
        expiresInSeconds: 7200,
      });

      const token = await mgr.getToken();

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(token).toBe("tok-refreshed");
    });
  });

  // -------------------------------------------------------------------------
  // getToken() — safety margin
  // -------------------------------------------------------------------------

  describe("getToken() - safety margin", () => {
    it("re-fetches 5 minutes before actual expiry", async () => {
      const mgr = new TokenManager(fetcher);

      await mgr.getToken();
      expect(fetcher).toHaveBeenCalledOnce();

      // Advance to just BEFORE the safety margin boundary — token still valid
      // effective expiry = 7200s * 1000 - 300_000 = 6_900_000ms
      const effectiveExpiryMs = 7200 * 1000 - SAFETY_MARGIN_MS;
      vi.advanceTimersByTime(effectiveExpiryMs - 1);

      // Should still be cached
      await mgr.getToken();
      expect(fetcher).toHaveBeenCalledOnce();

      // Advance 1 more ms — now past the effective expiry
      vi.advanceTimersByTime(1);

      fetcher.mockResolvedValueOnce({
        token: "tok-safety",
        expiresInSeconds: 7200,
      });

      const token = await mgr.getToken();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(token).toBe("tok-safety");
    });
  });

  // -------------------------------------------------------------------------
  // invalidate()
  // -------------------------------------------------------------------------

  describe("invalidate()", () => {
    it("forces re-fetch on next getToken() call", async () => {
      const mgr = new TokenManager(fetcher);

      await mgr.getToken();
      expect(fetcher).toHaveBeenCalledOnce();

      mgr.invalidate();

      fetcher.mockResolvedValueOnce({
        token: "tok-new",
        expiresInSeconds: 7200,
      });

      const token = await mgr.getToken();

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(token).toBe("tok-new");
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent deduplication
  // -------------------------------------------------------------------------

  describe("concurrent deduplication", () => {
    it("multiple simultaneous getToken() calls share one fetch", async () => {
      // Use a deferred so we can control when the fetcher resolves
      let resolve!: (value: TokenFetchResult) => void;
      const deferred = new Promise<TokenFetchResult>((r) => {
        resolve = r;
      });
      fetcher.mockReturnValue(deferred);

      const mgr = new TokenManager(fetcher);

      // Fire three concurrent calls
      const p1 = mgr.getToken();
      const p2 = mgr.getToken();
      const p3 = mgr.getToken();

      // Only one fetch should have been triggered
      expect(fetcher).toHaveBeenCalledOnce();

      // Resolve the single fetch
      resolve({ token: "tok-shared", expiresInSeconds: 7200 });

      const [t1, t2, t3] = await Promise.all([p1, p2, p3]);

      expect(t1).toBe("tok-shared");
      expect(t2).toBe("tok-shared");
      expect(t3).toBe("tok-shared");
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Fetcher error handling
  // -------------------------------------------------------------------------

  describe("fetcher error", () => {
    it("propagates the error and clears refreshPromise so retry works", async () => {
      fetcher.mockRejectedValueOnce(new Error("network failure"));

      const mgr = new TokenManager(fetcher);

      // First call should reject
      await expect(mgr.getToken()).rejects.toThrow("network failure");

      // refreshPromise should be cleared — a retry should invoke the fetcher
      // again, not replay the same rejection
      fetcher.mockResolvedValueOnce({
        token: "tok-retry",
        expiresInSeconds: 7200,
      });

      const token = await mgr.getToken();

      expect(token).toBe("tok-retry");
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // refreshPromise cleanup
  // -------------------------------------------------------------------------

  describe("refreshPromise cleanup", () => {
    it("refreshPromise is null after successful completion", async () => {
      const mgr = new TokenManager(fetcher);

      await mgr.getToken();

      // After completion, a subsequent getToken() on an expired token should
      // start a *new* fetch (not return a stale promise). We verify this by
      // invalidating and checking that the fetcher is called again.
      mgr.invalidate();

      fetcher.mockResolvedValueOnce({
        token: "tok-second",
        expiresInSeconds: 7200,
      });

      const token = await mgr.getToken();

      expect(token).toBe("tok-second");
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("refreshPromise is null after failed completion", async () => {
      fetcher.mockRejectedValueOnce(new Error("boom"));

      const mgr = new TokenManager(fetcher);

      await expect(mgr.getToken()).rejects.toThrow("boom");

      // The refreshPromise should be cleared so the next call creates a fresh one
      fetcher.mockResolvedValueOnce({
        token: "tok-recovered",
        expiresInSeconds: 7200,
      });

      const token = await mgr.getToken();
      expect(token).toBe("tok-recovered");
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });
});
