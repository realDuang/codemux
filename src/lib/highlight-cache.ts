// =============================================================================
// Shared bounded LRU cache for Shiki syntax highlighting results.
// Used by content-bash.tsx, content-code.tsx, and content-markdown.tsx
// to avoid redundant codeToHtml calls while preventing unbounded memory growth.
//
// LRU eviction: accessing a cached entry refreshes its position so that
// frequently-used highlights stay in cache longer. Uses Map insertion order
// (delete + re-set moves the entry to the newest position).
// =============================================================================

const MAX_ENTRIES = 500;

const cache = new Map<string, string>();

/**
 * Get a cached highlight result by key.
 * Refreshes the entry's position (LRU promotion) so it won't be evicted soon.
 */
export function getHighlight(key: string): string | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    // LRU promotion: move to newest position
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

/**
 * Store a highlight result. Evicts the least-recently-used entry
 * when the cache exceeds MAX_ENTRIES.
 */
export function setHighlight(key: string, value: string): void {
  // If key already exists, delete first so re-set moves it to newest position
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= MAX_ENTRIES) {
    // Evict LRU entry (oldest in Map insertion order)
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, value);
}

/**
 * Check if a key exists in the cache (does NOT promote the entry).
 */
export function hasHighlight(key: string): boolean {
  return cache.has(key);
}
