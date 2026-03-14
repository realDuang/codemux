// ============================================================================
// TokenManager — Reusable access_token auto-refresh utility
// Used by channel adapters that require time-limited API tokens
// (e.g., WeCom corpid+corpsecret, DingTalk appKey+appSecret).
// ============================================================================

/**
 * Token fetch function provided by the adapter.
 * Should call the platform API to obtain a new token.
 * Returns { token, expiresInSeconds }.
 */
export interface TokenFetchResult {
  token: string;
  /** Token validity in seconds (e.g., 7200 for 2 hours) */
  expiresInSeconds: number;
}

export type TokenFetcher = () => Promise<TokenFetchResult>;

/**
 * Manages a single access_token with automatic refresh before expiry.
 * - Lazy initialization: first getToken() call triggers fetch
 * - Concurrent deduplication: multiple getToken() calls during refresh share one fetch
 * - Safety margin: refreshes 5 minutes before actual expiry
 * - Manual invalidation: invalidate() forces next getToken() to re-fetch
 */
export class TokenManager {
  private token: string | null = null;
  private expiresAt = 0;
  private refreshPromise: Promise<string> | null = null;
  /** Safety margin: refresh 5 minutes before actual expiry */
  private static readonly SAFETY_MARGIN_MS = 5 * 60 * 1000;

  constructor(private fetcher: TokenFetcher) {}

  /** Get a valid token, refreshing if needed */
  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) {
      return this.token;
    }
    return this.refresh();
  }

  /** Force invalidation — next getToken() will re-fetch */
  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  /** Refresh the token, deduplicating concurrent calls */
  private async refresh(): Promise<string> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const result = await this.fetcher();
        this.token = result.token;
        this.expiresAt = Date.now() + result.expiresInSeconds * 1000 - TokenManager.SAFETY_MARGIN_MS;
        return result.token;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }
}
