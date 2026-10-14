import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
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
    const appPath = join('/binary-fixture', 'app.asar');
    const packageName = `@github/copilot-${process.platform}-${process.arch}`;
    const binaryName = process.platform === 'win32' ? 'copilot.exe' : 'copilot';
    const candidates = [
      join('/binary-fixture', 'app.asar.unpacked', 'node_modules', '@github', 'copilot', 'node_modules', packageName, binaryName),
      join('/binary-fixture', 'app.asar.unpacked', 'node_modules', packageName, binaryName),
      join(appPath, 'node_modules', packageName, binaryName),
      join(appPath, 'node_modules', '@github', 'copilot', 'node_modules', packageName, binaryName),
    ];

    it.each(candidates.map((candidate, index) => ({ candidate, index })))(
      'uses fallback candidate $index after earlier paths are unavailable',
      ({ candidate, index }) => {
        vi.mocked(app.getAppPath).mockReturnValue(appPath);
        vi.mocked(existsSync).mockImplementation(file => file === candidate);

        expect(resolvePlatformCli()).toBe(candidate);
        const checkedCandidates = vi.mocked(existsSync).mock.calls
          .map(([file]) => file)
          .filter(file => candidates.includes(String(file)));
        expect(checkedCandidates).toEqual(candidates.slice(0, index + 1));
        expect(app.getAppPath).toHaveBeenCalledOnce();
      },
    );

    it('prefers the nested unpacked package when multiple fallback binaries exist', () => {
      vi.mocked(app.getAppPath).mockReturnValue(appPath);
      vi.mocked(existsSync).mockImplementation(file => candidates.includes(String(file)));

      expect(resolvePlatformCli()).toBe(candidates[0]);
    });

    it('returns undefined when module resolution and all fallback locations are unavailable', () => {
      vi.mocked(app.getAppPath).mockReturnValue(appPath);
      vi.mocked(existsSync).mockReturnValue(false);

      expect(resolvePlatformCli()).toBeUndefined();
      expect(vi.mocked(existsSync).mock.calls.slice(-4).map(([file]) => file)).toEqual(candidates);
    });
  });
});
