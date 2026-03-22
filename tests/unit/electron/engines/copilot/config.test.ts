import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { app } from 'electron';
import { DEFAULT_MODES, readConfigModel, resolvePlatformCli } from '../../../../../electron/main/engines/copilot/config';

vi.mock('fs');
vi.mock('electron', () => ({
  app: { getAppPath: vi.fn(() => '/app') },
}));

describe('copilot/config.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('DEFAULT_MODES', () => {
    it('contains interactive, plan, and autopilot modes', () => {
      expect(DEFAULT_MODES).toHaveLength(3);
      expect(DEFAULT_MODES.map(m => m.id)).toEqual(['autopilot', 'interactive', 'plan']);
    });
  });

  describe('readConfigModel', () => {
    it('returns model string from config file or undefined on error', () => {
      // Success
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('{"model": "gpt-4o"}');
      expect(readConfigModel()).toBe('gpt-4o');

      // File not found
      vi.mocked(existsSync).mockReturnValue(false);
      expect(readConfigModel()).toBeUndefined();

      // No model field
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('{"foo": "bar"}');
      expect(readConfigModel()).toBeUndefined();

      // JSON error
      vi.mocked(readFileSync).mockReturnValue('invalid json');
      expect(readConfigModel()).toBeUndefined();
    });
  });

  describe('resolvePlatformCli', () => {
    it('resolves binary from import.meta.resolve or falls back to candidates', () => {
      // Mock import.meta.resolve (Strategy 1)
      // Note: In tests, Strategy 1 often fails because import.meta.resolve 
      // is an experimental feature not always present in test environment.
      // We'll focus on testing the fallback Strategy 2.
      
      vi.mocked(existsSync).mockImplementation((p: any) => {
        return p.includes('app.asar.unpacked');
      });

      const resolved = resolvePlatformCli();
      expect(resolved).toBeDefined();
      expect(resolved).toMatch(/app\.asar\.unpacked/);

      // Returns undefined when no candidates exist
      vi.mocked(existsSync).mockReturnValue(false);
      expect(resolvePlatformCli()).toBeUndefined();
    });
  });
});
