import { describe, it, expect, beforeEach, vi } from 'vitest';

let getHighlight: typeof import('../../../../src/lib/highlight-cache').getHighlight;
let setHighlight: typeof import('../../../../src/lib/highlight-cache').setHighlight;
let hasHighlight: typeof import('../../../../src/lib/highlight-cache').hasHighlight;

describe('highlight-cache', () => {
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../../../src/lib/highlight-cache');
    getHighlight = mod.getHighlight;
    setHighlight = mod.setHighlight;
    hasHighlight = mod.hasHighlight;
  });

  describe('basic operations', () => {
    it('stores and retrieves highlights correctly', () => {
      setHighlight('key1', 'value1');
      expect(hasHighlight('key1')).toBe(true);
      expect(getHighlight('key1')).toBe('value1');
    });

    it('returns undefined and false for non-existent keys', () => {
      expect(hasHighlight('unknown')).toBe(false);
      expect(getHighlight('unknown')).toBeUndefined();
    });

    it('updates existing keys with new values', () => {
      setHighlight('key1', 'value1');
      setHighlight('key1', 'value2');
      expect(getHighlight('key1')).toBe('value2');
    });
  });

  describe('cache eviction', () => {
    it('evicts the oldest entry when exceeding MAX_ENTRIES (500)', () => {
      // Fill cache to 500
      for (let i = 1; i <= 500; i++) {
        setHighlight(`key${i}`, `value${i}`);
      }

      // Add 501st entry
      setHighlight('key501', 'value501');

      // First entry (key1) should be evicted
      expect(hasHighlight('key1')).toBe(false);
      expect(getHighlight('key1')).toBeUndefined();

      // Second entry (key2) and latest (key501) should still exist
      expect(hasHighlight('key2')).toBe(true);
      expect(hasHighlight('key501')).toBe(true);
      expect(getHighlight('key501')).toBe('value501');
    });
  });
});
