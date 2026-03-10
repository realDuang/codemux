// =============================================================================
// Shared bounded cache for Shiki syntax highlighting results.
// Used by content-code.tsx and content-markdown.tsx to avoid redundant
// codeToHtml calls while preventing unbounded memory growth.
// =============================================================================

const MAX_ENTRIES = 500;

const cache = new Map<string, string>();

/**
 * Get a cached highlight result by key.
 */
export function getHighlight(key: string): string | undefined {
  return cache.get(key);
}

/**
 * Store a highlight result. Evicts the oldest entry when the cache exceeds MAX_ENTRIES.
 */
export function setHighlight(key: string, value: string): void {
  if (cache.size >= MAX_ENTRIES) {
    // Evict oldest entry (Map preserves insertion order)
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, value);
}

/**
 * Check if a key exists in the cache.
 */
export function hasHighlight(key: string): boolean {
  return cache.has(key);
}
