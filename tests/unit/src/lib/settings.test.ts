import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isElectron } from '../../../../src/lib/platform';
import { Auth } from '../../../../src/lib/auth';

vi.mock('../../../../src/lib/platform', () => ({
  isElectron: vi.fn(() => false),
}));

vi.mock('../../../../src/lib/auth', () => ({
  Auth: {
    isAuthenticated: vi.fn(() => false),
    getAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer token' })),
  },
}));

vi.mock('../../../../src/lib/gateway-client', () => ({
  gatewayClient: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../../../../src/lib/gateway-api', () => ({
  gateway: {
    init: vi.fn(),
    setHandlers: vi.fn(),
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
vi.stubGlobal('document', {
  visibilityState: 'visible',
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

// Import AFTER globals are stubbed
const {
  getSetting,
  saveSetting,
  getNestedSetting,
  saveNestedSetting,
  bootstrapSharedSettings,
  refreshSharedSettings,
  setSharedSettingsSyncEnabled,
  resetSettingsBootstrapCache,
  subscribeToSettingsChanges,
} = await import('../../../../src/lib/settings');
const { gatewayClient } = await import('../../../../src/lib/gateway-client');
const { gateway } = await import('../../../../src/lib/gateway-api');

describe('settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(isElectron).mockReturnValue(false);
    vi.mocked(Auth.isAuthenticated).mockReturnValue(false);
    vi.mocked(Auth.getAuthHeaders).mockReturnValue({ Authorization: 'Bearer token' });
    // Reset electron-related globals
    delete (window as any).electronAPI;
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('setInterval', vi.fn(() => 1));
    vi.stubGlobal('clearInterval', vi.fn());
    (window as any).addEventListener = vi.fn();
    (window as any).removeEventListener = vi.fn();
    (document as any).visibilityState = 'visible';
    (document as any).addEventListener = vi.fn();
    (document as any).removeEventListener = vi.fn();
    resetSettingsBootstrapCache();
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
          onChanged: vi.fn(),
        },
      };

      expect(getSetting('theme')).toBe('light');
      
      saveSetting('theme', 'system');
      expect(saveMock).toHaveBeenCalledWith({ theme: 'system' });
      expect(getSetting('theme')).toBe('system');
      // Also saved to localStorage as secondary cache
      expect(localStorage.getItem('settings:theme')).toBe(JSON.stringify('system'));
    });

    it('refreshes the renderer cache when electron settings change externally', () => {
      vi.mocked(isElectron).mockReturnValue(true);
      const saveMock = vi.fn();
      const onChangedMock = vi.fn((callback: (settings: Record<string, unknown>) => void) => {
        callback({
          theme: 'dark',
          defaultEngine: 'claude',
          engineModels: {
            claude: { providerID: 'anthropic', modelID: 'claude-sonnet' },
          },
        });
        return vi.fn();
      });
      (window as any).electronAPI = {
        settings: {
          cache: { theme: 'light', defaultEngine: 'opencode' },
          save: saveMock,
          onChanged: onChangedMock,
        },
      };

      const callback = vi.fn();
      const unsubscribe = subscribeToSettingsChanges(callback);

      expect(onChangedMock).toHaveBeenCalledTimes(1);
      expect(getSetting('theme')).toBe('dark');
      expect(getSetting('defaultEngine')).toBe('claude');
      expect(getNestedSetting('engineModels.claude.modelID')).toBe('claude-sonnet');
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        theme: 'dark',
        defaultEngine: 'claude',
      }));

      unsubscribe?.();
    });

    it('keeps local-only settings in localStorage even when sync is enabled', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      vi.mocked(fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          enabled: true,
        }),
      });

      await refreshSharedSettings();
      saveSetting('lastSessionId', 'session-1');
      expect(localStorage.getItem('settings:lastSessionId')).toBe(JSON.stringify('session-1'));
    });

    it('reads shared settings from the remote cache when sync is enabled', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      vi.mocked(fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          syncEnabled: true,
          sharedSettings: {
            theme: 'dark',
            locale: 'zh',
          },
        }),
      });

      await bootstrapSharedSettings();
      expect(getSetting('theme')).toBe('dark');
      expect(getSetting('locale')).toBe('zh');
    });

    it('writes shared settings through the remote API when sync is enabled', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      vi.mocked(fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            syncEnabled: true,
            sharedSettings: {
              theme: 'dark',
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            success: true,
            settings: {
              theme: 'dark',
            },
          }),
        });

      await refreshSharedSettings();
      saveSetting('theme', 'dark');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fetch).toHaveBeenLastCalledWith('/api/settings/shared', expect.objectContaining({
        method: 'POST',
      }));
      expect(getSetting('theme')).toBe('dark');
      expect(localStorage.getItem('settings:theme')).toBe(JSON.stringify('dark'));
    });

    it('reverts optimistic shared setting reads when the remote persist fails', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            syncEnabled: true,
            sharedSettings: {
              theme: 'dark',
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
        });

      await refreshSharedSettings();
      saveSetting('theme', 'system');

      expect(getSetting('theme')).toBe('system');

      await vi.waitFor(() => {
        expect(getSetting('theme')).toBe('dark');
      });

      expect(localStorage.getItem('settings:theme')).toBe(JSON.stringify('dark'));
      expect(warnSpy).toHaveBeenCalledWith(
        '[Settings] Failed to persist shared setting:',
        expect.any(Error),
      );
    });

    it('persists shared settings remotely even when sync state is still bootstrapping', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      vi.mocked(fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            syncEnabled: true,
            sharedSettings: {
              theme: 'system',
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            success: true,
            settings: {
              theme: 'dark',
            },
          }),
        });

      const bootstrapPromise = refreshSharedSettings();
      saveSetting('theme', 'dark');

      await bootstrapPromise;
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(2);
      });

      expect(fetch).toHaveBeenLastCalledWith('/api/settings/shared', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          patch: { theme: 'dark' },
          removeKeys: [],
        }),
      }));
      expect(getSetting('theme')).toBe('dark');
      expect(localStorage.getItem('settings:theme')).toBe(JSON.stringify('dark'));
    });

    it('updates the shared sync toggle through the API in browser mode', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      vi.mocked(fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            enabled: true,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            syncEnabled: true,
            sharedSettings: {
              theme: 'dark',
            },
          }),
        });

      await expect(setSharedSettingsSyncEnabled(true)).resolves.toBe(true);
      expect(fetch).toHaveBeenNthCalledWith(1, '/api/settings/sync-enabled', expect.objectContaining({
        method: 'POST',
      }));
      expect(getSetting('theme')).toBe('dark');
    });

    it('saves shared nested engine model updates as engine-scoped patches', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      vi.mocked(fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            syncEnabled: true,
            sharedSettings: {
              engineModels: {
                opencode: { modelID: 'gpt-4o', enabled: true },
                claude: { providerID: 'anthropic', modelID: 'claude-old' },
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            success: true,
            settings: {
              engineModels: {
                opencode: { modelID: 'gpt-4o', enabled: true },
                claude: { providerID: 'anthropic', modelID: 'claude-new' },
              },
            },
          }),
        });

      await refreshSharedSettings();
      saveNestedSetting('engineModels.claude.modelID', 'claude-new');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fetch).toHaveBeenLastCalledWith('/api/settings/shared', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          patch: {
            engineModels: {
              claude: { providerID: 'anthropic', modelID: 'claude-new' },
            },
          },
          removeKeys: [],
        }),
      }));
      expect(getNestedSetting('engineModels.opencode.modelID')).toBe('gpt-4o');
      expect(getNestedSetting('engineModels.claude.modelID')).toBe('claude-new');
    });

    it('waits for pending shared writes before refreshing shared settings', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);

      let resolveSharedWrite: ((value: unknown) => void) | undefined;
      vi.mocked(fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            syncEnabled: true,
            sharedSettings: {
              engineModels: {
                claude: { providerID: 'anthropic', modelID: 'claude-old' },
              },
            },
          }),
        })
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveSharedWrite = (value) => resolve(value);
        }))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            syncEnabled: true,
            sharedSettings: {
              engineModels: {
                claude: { providerID: 'anthropic', modelID: 'claude-new' },
              },
            },
          }),
        });

      await refreshSharedSettings();
      saveNestedSetting('engineModels.claude.modelID', 'claude-new');
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(2);
      });

      const refreshPromise = refreshSharedSettings();
      await Promise.resolve();

      expect(fetch).toHaveBeenCalledTimes(2);

      resolveSharedWrite?.({
        ok: true,
        json: async () => ({
          success: true,
          settings: {
            engineModels: {
              claude: { providerID: 'anthropic', modelID: 'claude-new' },
            },
          },
        }),
      });

      await refreshPromise;

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(getNestedSetting('engineModels.claude.modelID')).toBe('claude-new');
    });

    it('keeps shared-setting saves on the remote path during refresh', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);

      let resolveSharedWrite: ((value: unknown) => void) | undefined;
      vi.mocked(fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            syncEnabled: true,
            sharedSettings: {
              theme: 'dark',
            },
          }),
        })
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveSharedWrite = (value) => resolve(value);
        }))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            syncEnabled: true,
            sharedSettings: {
              theme: 'system',
            },
          }),
        });

      await refreshSharedSettings();

      const refreshPromise = refreshSharedSettings();
      saveSetting('theme', 'system');

      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(2);
      });

      expect(fetch).toHaveBeenNthCalledWith(2, '/api/settings/shared', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          patch: { theme: 'system' },
          removeKeys: [],
        }),
      }));
      expect(getSetting('theme')).toBe('system');
      expect(localStorage.getItem('settings:theme')).toBe(JSON.stringify('dark'));

      resolveSharedWrite?.({
        ok: true,
        json: async () => ({
          success: true,
          settings: {
            theme: 'system',
          },
        }),
      });

      await refreshPromise;
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(getSetting('theme')).toBe('system');
    });

    it('refreshes browser subscribers when shared settings change remotely', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      vi.mocked(fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          syncEnabled: true,
          sharedSettings: {
            theme: 'dark',
            locale: 'zh',
          },
        }),
      });

      const callback = vi.fn();
      const unsubscribe = subscribeToSettingsChanges(callback);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(setInterval).toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledWith('/api/settings/bootstrap', expect.objectContaining({
        cache: 'no-store',
        headers: { Authorization: 'Bearer token' },
      }));
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        settingsSyncEnabled: true,
        theme: 'dark',
        locale: 'zh',
      }));
      expect(getSetting('theme')).toBe('dark');

      unsubscribe?.();
      expect(clearInterval).toHaveBeenCalled();
    });

    it('refreshes browser subscribers when shared settings change via gateway push', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      vi.mocked(fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          syncEnabled: true,
          sharedSettings: {
            theme: 'dark',
            locale: 'zh',
          },
        }),
      });

      const callback = vi.fn();
      const unsubscribe = subscribeToSettingsChanges(callback);

      await new Promise((resolve) => setTimeout(resolve, 0));

      const handlerCall = vi.mocked(gatewayClient.on).mock.calls.find(
        ([event]) => event === 'settings.changed',
      );
      expect(handlerCall).toBeDefined();

      const handler = handlerCall?.[1] as ((data: { settings: Record<string, unknown> }) => Promise<void> | void);
      await handler?.({
        settings: {
          settingsSyncEnabled: true,
          theme: 'light',
          locale: 'ru',
        },
      });

      expect(getSetting('theme')).toBe('light');
      expect(getSetting('locale')).toBe('ru');
      expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({
        settingsSyncEnabled: true,
        theme: 'light',
        locale: 'ru',
      }));

      unsubscribe?.();
      expect(gatewayClient.off).toHaveBeenCalledWith('settings.changed', handler);
    });

    it('keeps gateway settings push subscribed after gateway handlers change', async () => {
      vi.mocked(Auth.isAuthenticated).mockReturnValue(true);
      vi.mocked(fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          syncEnabled: true,
          sharedSettings: {
            theme: 'dark',
            locale: 'zh',
          },
        }),
      });

      const callback = vi.fn();
      const unsubscribe = subscribeToSettingsChanges(callback);

      await new Promise((resolve) => setTimeout(resolve, 0));

      gateway.setHandlers({
        onMessageUpdated: vi.fn(),
      });

      const handlerCall = vi.mocked(gatewayClient.on).mock.calls.find(
        ([event]) => event === 'settings.changed',
      );
      expect(handlerCall).toBeDefined();

      const handler = handlerCall?.[1] as ((data: { settings: Record<string, unknown> }) => Promise<void> | void);
      await handler?.({
        settings: {
          settingsSyncEnabled: true,
          theme: 'system',
          locale: 'en',
        },
      });

      expect(getSetting('theme')).toBe('system');
      expect(getSetting('locale')).toBe('en');
      expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({
        settingsSyncEnabled: true,
        theme: 'system',
        locale: 'en',
      }));

      unsubscribe?.();
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
});
