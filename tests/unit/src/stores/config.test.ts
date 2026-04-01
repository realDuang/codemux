import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as settings from '../../../../src/lib/settings';

// Mock settings module
vi.mock('../../../../src/lib/settings', () => ({
  getSetting: vi.fn(),
  saveSetting: vi.fn(),
  getNestedSetting: vi.fn(),
  saveNestedSetting: vi.fn(),
}));

// The storeContainer must be declared INSIDE vi.mock factory to avoid TDZ issues
// since vi.mock is hoisted above all other statements.
// We use a module-scoped variable via vi.hoisted() which runs before hoisted mocks.
const { storeContainer } = vi.hoisted(() => {
  const storeContainer: { data: any; setter: any } = { data: {}, setter: null };
  return { storeContainer };
});

vi.mock('solid-js/store', () => ({
  createStore: vi.fn((initial: any) => {
    // Mutate the container's data object in-place so configStore ref stays valid
    Object.keys(storeContainer.data).forEach((k: string) => delete storeContainer.data[k]);
    Object.assign(storeContainer.data, initial);

    storeContainer.setter = (pathOrValue: any, ...args: any[]) => {
      if (args.length === 0) {
        // Full object replacement: setConfigStore({ ... })
        Object.keys(storeContainer.data).forEach((k: string) => delete storeContainer.data[k]);
        Object.assign(storeContainer.data, pathOrValue);
      } else if (args.length === 1) {
        // Single path: setConfigStore('key', value)
        storeContainer.data[pathOrValue] = args[0];
      } else if (args.length === 2) {
        // Nested path: setConfigStore('key', 'subkey', value)
        if (!storeContainer.data[pathOrValue] || typeof storeContainer.data[pathOrValue] !== 'object') {
          storeContainer.data[pathOrValue] = {};
        }
        storeContainer.data[pathOrValue] = { ...storeContainer.data[pathOrValue], [args[0]]: args[1] };
      }
    };

    return [storeContainer.data, storeContainer.setter];
  }),
}));

// Import AFTER mocks are set up (vi.mock is hoisted, so this is fine)
import {
  getSelectedModelForEngine,
  getDefaultEngineType,
  isEngineEnabled,
  loadEngineModelSelection,
  restoreEngineModelSelections,
  configStore,
  setConfigStore,
} from '../../../../src/stores/config';

describe('config store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state via the setter (which mutates storeContainer.data = configStore)
    setConfigStore({
      models: [],
      loading: false,
      currentProviderID: null,
      currentModelID: null,
      engines: [],
      currentEngineType: null,
      engineModels: {},
      engineModelSelections: {},
      enabledEngines: {},
      defaultNewSessionEngine: null,
    });
  });

  describe('getSelectedModelForEngine', () => {
    it('returns user-selected modelID when it exists in the model list', () => {
      setConfigStore('engineModels', 'opencode', [{ modelId: 'gpt-4o' }]);
      setConfigStore('engineModelSelections', 'opencode', { providerID: 'p1', modelID: 'gpt-4o' });
      expect(getSelectedModelForEngine('opencode')).toBe('gpt-4o');
    });

    it('returns user-selected modelID when engine has customModelInput capability', () => {
      setConfigStore('engines', [{ type: 'opencode', capabilities: { customModelInput: true } }]);
      setConfigStore('engineModels', 'opencode', []);
      setConfigStore('engineModelSelections', 'opencode', { providerID: 'p1', modelID: 'custom-xyz' });
      expect(getSelectedModelForEngine('opencode')).toBe('custom-xyz');
    });

    it('returns user-selected modelID when model list is empty (trusts manual input)', () => {
      setConfigStore('engines', [{ type: 'opencode' }]);
      setConfigStore('engineModels', 'opencode', []);
      setConfigStore('engineModelSelections', 'opencode', { providerID: 'p1', modelID: 'manual' });
      expect(getSelectedModelForEngine('opencode')).toBe('manual');
    });

    it('falls back to currentModelID when user selection is stale', () => {
      setConfigStore('engineModels', 'opencode', [{ modelId: 'valid-1' }]);
      setConfigStore('engineModelSelections', 'opencode', { providerID: 'p1', modelID: 'stale-model' });
      setConfigStore('currentEngineType', 'opencode');
      setConfigStore('currentModelID', 'active-model');
      expect(getSelectedModelForEngine('opencode')).toBe('active-model');
    });

    it('falls back to first model in list when no current model', () => {
      setConfigStore('engineModels', 'opencode', [{ modelId: 'first' }, { modelId: 'second' }]);
      expect(getSelectedModelForEngine('opencode')).toBe('first');
    });

    it('returns undefined when no models available anywhere', () => {
      setConfigStore('engineModels', {});
      setConfigStore('models', []);
      expect(getSelectedModelForEngine('opencode')).toBeUndefined();
    });
  });

  describe('getDefaultEngineType', () => {
    it('returns defaultNewSessionEngine when set and engine is running + enabled', () => {
      setConfigStore('defaultNewSessionEngine', 'claude');
      setConfigStore('engines', [
        { type: 'opencode', status: 'running' },
        { type: 'claude', status: 'running' },
      ]);
      setConfigStore('enabledEngines', 'claude', true);
      expect(getDefaultEngineType()).toBe('claude');
    });

    it('returns first running engine when no default set', () => {
      setConfigStore('engines', [
        { type: 'e1', status: 'idle' },
        { type: 'e2', status: 'running' },
      ]);
      expect(getDefaultEngineType()).toBe('e2');
    });

    it('returns first engine if none running', () => {
      setConfigStore('engines', [{ type: 'e1' }, { type: 'e2' }]);
      expect(getDefaultEngineType()).toBe('e1');
    });

    it('returns "opencode" when no engines exist', () => {
      expect(getDefaultEngineType()).toBe('opencode');
    });
  });

  describe('isEngineEnabled', () => {
    it('returns explicit store value when present', () => {
      setConfigStore('enabledEngines', 'claude', false);
      expect(isEngineEnabled('claude')).toBe(false);

      setConfigStore('enabledEngines', 'claude', true);
      expect(isEngineEnabled('claude')).toBe(true);
    });

    it('falls back to persisted setting when not in store', () => {
      // enabledEngines.claude is undefined (not set)
      vi.mocked(settings.getNestedSetting).mockReturnValue({ enabled: false });
      expect(isEngineEnabled('newengine')).toBe(false);
    });

    it('defaults to true when nothing saved', () => {
      vi.mocked(settings.getNestedSetting).mockReturnValue(undefined);
      expect(isEngineEnabled('newengine')).toBe(true);
    });
  });

  describe('loadEngineModelSelection', () => {
    it('returns saved selection when valid, null otherwise', () => {
      vi.mocked(settings.getNestedSetting).mockReturnValue({ providerID: 'p1', modelID: 'gpt-4o' });
      expect(loadEngineModelSelection('opencode')).toEqual({ providerID: 'p1', modelID: 'gpt-4o' });

      // Missing providerID is normalized for non-provider engines / legacy settings
      vi.mocked(settings.getNestedSetting).mockReturnValue({ modelID: 'gpt-4o' });
      expect(loadEngineModelSelection('copilot')).toEqual({ providerID: '', modelID: 'gpt-4o', enabled: undefined });

      // Missing modelID
      vi.mocked(settings.getNestedSetting).mockReturnValue({ providerID: 'p1' });
      expect(loadEngineModelSelection('opencode')).toBeNull();

      // Nothing saved
      vi.mocked(settings.getNestedSetting).mockReturnValue(undefined);
      expect(loadEngineModelSelection('opencode')).toBeNull();

      // Error thrown
      vi.mocked(settings.getNestedSetting).mockImplementation(() => { throw new Error('fail'); });
      expect(loadEngineModelSelection('opencode')).toBeNull();
    });
  });

  describe('restoreEngineModelSelections', () => {
    it('restores valid saved selections and discards stale ones', () => {
      setConfigStore('engines', [{ type: 'opencode' }]);
      setConfigStore('engineModels', 'opencode', [{ modelId: 'valid' }]);

      // Valid saved model
      vi.mocked(settings.getNestedSetting).mockReturnValue({ providerID: 'p1', modelID: 'valid' });
      restoreEngineModelSelections();
      expect(configStore.engineModelSelections['opencode']?.modelID).toBe('valid');

      // Now mock stale model
      setConfigStore('engineModelSelections', 'opencode', undefined as any);
      vi.mocked(settings.getNestedSetting).mockReturnValue({ providerID: 'p1', modelID: 'stale' });
      restoreEngineModelSelections();
      // stale model NOT in list -> not restored, stays undefined
      expect(configStore.engineModelSelections['opencode']).toBeUndefined();
    });
  });
});
