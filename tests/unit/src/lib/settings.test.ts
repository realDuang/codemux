import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isElectron } from '../../../../src/lib/platform';

vi.mock('../../../../src/lib/platform', () => ({
  isElectron: vi.fn(() => false),
}));

vi.mock('../../../../src/lib/auth', () => ({
  Auth: {
    isAuthenticated: vi.fn(() => false),
    getAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer test-token' })),
  },
}));

// Create an in-memory localStorage mock for Node environment
function createLocalStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
}

// Stub localStorage and window before importing settings (which may access them at module level)
vi.stubGlobal('localStorage', createLocalStorageMock());
vi.stubGlobal('window', globalThis);

// Import AFTER globals are stubbed
const { getSetting, saveSetting, getNestedSetting, saveNestedSetting, bootstrapHostSettings, _resetBootstrapState } = await import('../../../../src/lib/settings');
const { Auth } = await import('../../../../src/lib/auth');

describe('settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(isElectron).mockReturnValue(false);
    vi.mocked(Auth.isAuthenticated).mockReturnValue(false);
    _resetBootstrapState();
    // Reset electron-related globals
    delete (window as any).electronAPI;
    // Reset the internal renderer cache by re-stubbing window without electronAPI
  });

  describe('getSetting / saveSetting', () => {
    it('manages simple settings in browser mode using localStorage', () => {
      saveSetting('theme', 'dark');
      expect(localStorage.getItem('settings:theme')).toBe(JSON.stringify('dark'));
      expect(getSetting('theme')).toBe('dark');
    });

    it('returns undefined for missing keys or handles JSON parse errors', () => {
      expect(getSetting('missing')).toBeUndefined();
      
      localStorage.setItem('settings:bad', 'invalid-json');
      expect(getSetting('bad')).toBeUndefined();
    });

    it('interacts with Electron API when in electron mode', () => {
      vi.mocked(isElectron).mockReturnValue(true);
      const saveMock = vi.fn();
      (window as any).electronAPI = {
        settings: {
          cache: { theme: 'light' },
          save: saveMock,
        },
      };

      expect(getSetting('theme')).toBe('light');
      
      saveSetting('theme', 'system');
      expect(saveMock).toHaveBeenCalledWith({ theme: 'system' });
      expect(getSetting('theme')).toBe('system');
      // Also saved to localStorage as secondary cache
      expect(localStorage.getItem('settings:theme')).toBe(JSON.stringify('system'));
    });
  });

  describe('getNestedSetting', () => {
    it('retrieves values from nested paths correctly', () => {
      localStorage.setItem('settings:engineModels', JSON.stringify({
        opencode: { modelID: 'gpt-4o' },
        claude: { modelID: 'claude-3-5-sonnet' }
      }));

      expect(getNestedSetting('engineModels.opencode.modelID')).toBe('gpt-4o');
      expect(getNestedSetting('engineModels.claude')).toEqual({ modelID: 'claude-3-5-sonnet' });
    });

    it('returns undefined for non-existent or invalid paths', () => {
      localStorage.setItem('settings:engineModels', JSON.stringify({
        opencode: { modelID: 'gpt-4o' }
      }));

      expect(getNestedSetting('engineModels.missing')).toBeUndefined();
      expect(getNestedSetting('engineModels.opencode.missing')).toBeUndefined();
      expect(getNestedSetting('engineModels.opencode.modelID.sub')).toBeUndefined();
      expect(getNestedSetting('missing.path')).toBeUndefined();
    });

    it('delegates to getSetting for single-level paths', () => {
      saveSetting('theme', 'dark');
      expect(getNestedSetting('theme')).toBe('dark');
    });
  });

  describe('saveNestedSetting', () => {
    it('saves values to nested paths and merges with existing sibling keys', () => {
      saveSetting('engineModels', { opencode: { modelID: 'gpt-4o' } });
      
      saveNestedSetting('engineModels.claude.modelID', 'claude-3');
      
      const saved = getSetting<any>('engineModels');
      expect(saved.opencode.modelID).toBe('gpt-4o');
      expect(saved.claude.modelID).toBe('claude-3');
    });

    it('creates intermediate objects if they do not exist', () => {
      saveNestedSetting('a.b.c', 123);
      expect(getNestedSetting('a.b.c')).toBe(123);
      expect(getSetting('a')).toEqual({ b: { c: 123 } });
    });

    it('delegates to saveSetting for single-level paths', () => {
      saveNestedSetting('theme', 'light');
      expect(localStorage.getItem('settings:theme')).toBe(JSON.stringify('light'));
    });
  });

  describe('bootstrapHostSettings', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    it('returns false in Electron mode', async () => {
      vi.mocked(isElectron).mockReturnValue(true);
      expect(await bootstrapHostSettings()).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('returns false when not authenticated', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(false);
      expect(await bootstrapHostSettings()).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('fetches and applies host settings to localStorage', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      vi.mocked(fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          settings: {
            theme: 'dark',
            locale: 'zh',
            engineModels: { claude: { providerID: 'anthropic', modelID: 'sonnet' } },
            engineReasoningEfforts: { claude: 'high' },
            engineServiceTiers: { codex: 'fast', opencode: null },
          },
        }),
      });

      expect(await bootstrapHostSettings()).toBe(true);
      expect(fetch).toHaveBeenCalledWith('/api/settings/shared', {
        headers: { Authorization: 'Bearer test-token' },
      });
      expect(getSetting('theme')).toBe('dark');
      expect(getSetting('locale')).toBe('zh');
      expect(getNestedSetting('engineModels.claude.modelID')).toBe('sonnet');
      expect(getNestedSetting('engineReasoningEfforts.claude')).toBe('high');
      expect(getNestedSetting('engineServiceTiers.codex')).toBe('fast');
      expect(getNestedSetting('engineServiceTiers.opencode')).toBeNull();
    });

    it('does not overwrite existing localStorage on fetch failure', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      saveSetting('theme', 'light');
      vi.mocked(fetch as any).mockResolvedValueOnce({ ok: false, status: 500 });

      expect(await bootstrapHostSettings()).toBe(false);
      expect(getSetting('theme')).toBe('light');
    });

    it('skips bootstrap on second call (already done)', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      vi.mocked(fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ settings: { theme: 'dark' } }),
      });

      expect(await bootstrapHostSettings()).toBe(true);
      expect(await bootstrapHostSettings()).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('handles network errors gracefully', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      vi.mocked(fetch as any).mockRejectedValueOnce(new Error('Network error'));

      expect(await bootstrapHostSettings()).toBe(false);
    });
  });

  describe('saveSetting write-back', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    });

    it('fires PATCH for shared keys in web mode when authenticated', () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      saveSetting('theme', 'dark');

      expect(fetch).toHaveBeenCalledWith('/api/settings/shared', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ theme: 'dark' }),
      });
    });

    it('fires PATCH for shared nested keys by sending the root object', () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);

      saveNestedSetting('engineReasoningEfforts.copilot', 'high');
      expect(fetch).toHaveBeenNthCalledWith(1, '/api/settings/shared', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ engineReasoningEfforts: { copilot: 'high' } }),
      });

      saveNestedSetting('engineServiceTiers.codex', null);
      expect(fetch).toHaveBeenNthCalledWith(2, '/api/settings/shared', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ engineServiceTiers: { codex: null } }),
      });
    });

    it('does not fire PATCH for non-shared keys', () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      saveSetting('logLevel', 'debug');

      expect(fetch).not.toHaveBeenCalled();
    });

    it('does not fire PATCH when not authenticated', () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(false);
      saveSetting('theme', 'dark');

      expect(fetch).not.toHaveBeenCalled();
    });

    it('does not fire PATCH in Electron mode', () => {
      vi.mocked(isElectron).mockReturnValue(true);
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      (window as any).electronAPI = {
        settings: { cache: {}, save: vi.fn() },
      };
      saveSetting('theme', 'dark');

      expect(fetch).not.toHaveBeenCalled();
    });

    it('swallows fetch errors silently', () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      vi.mocked(fetch as any).mockImplementation(() => { throw new Error('Network error'); });

      // Should not throw
      expect(() => saveSetting('theme', 'dark')).not.toThrow();
    });
  });
});
