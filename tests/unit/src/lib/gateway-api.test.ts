import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcile } from 'solid-js/store';
import type { EngineCatalogSnapshot, EngineInfo, SessionActivityStatus, UnifiedMessage, UnifiedPart, UnifiedProject, UnifiedSession } from '../../../../src/types/unified';

const mockGatewayClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  discardSessionNotifications: vi.fn(),
  connected: true,
  listEngines: vi.fn().mockResolvedValue([]),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  listSessions: vi.fn().mockResolvedValue([]),
  createSession: vi.fn().mockResolvedValue({ id: 's1' }),
  getSession: vi.fn().mockResolvedValue({ id: 's1' }),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  renameSession: vi.fn().mockResolvedValue(undefined),
  setSessionArchived: vi.fn().mockResolvedValue(undefined),
  setSessionProject: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue({ id: 'm1' }),
  cancelMessage: vi.fn().mockResolvedValue(undefined),
  listMessages: vi.fn().mockResolvedValue([]),
  getMessageSteps: vi.fn().mockResolvedValue([]),
  setModel: vi.fn().mockResolvedValue(undefined),
  setMode: vi.fn().mockResolvedValue(undefined),
  replyPermission: vi.fn().mockResolvedValue(undefined),
  replyQuestion: vi.fn().mockResolvedValue(undefined),
  rejectQuestion: vi.fn().mockResolvedValue(undefined),
  listProjects: vi.fn().mockResolvedValue([]),
  listCatalogs: vi.fn().mockResolvedValue([]),
  createProject: vi.fn().mockResolvedValue({ id: 'project' }),
  updateProject: vi.fn().mockResolvedValue({ id: 'project' }),
  reorderProjects: vi.fn().mockResolvedValue(undefined),
  setProjectEngine: vi.fn().mockResolvedValue(undefined),
  listAllSessions: vi.fn().mockResolvedValue([]),
  listAllProjects: vi.fn().mockResolvedValue([]),
  deleteProject: vi.fn().mockResolvedValue({ success: true }),
  importLegacyProjects: vi.fn().mockResolvedValue({ success: true }),
  importPreview: vi.fn().mockResolvedValue([]),
  importExecute: vi.fn().mockResolvedValue({ imported: 0 }),
  listCommands: vi.fn().mockResolvedValue([]),
  invokeCommand: vi.fn().mockResolvedValue({ result: 'ok' }),
  listFiles: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue({ content: '' }),
  getGitStatus: vi.fn().mockResolvedValue([]),
  getGitDiff: vi.fn().mockResolvedValue(''),
  watchDirectory: vi.fn().mockResolvedValue(undefined),
  unwatchDirectory: vi.fn().mockResolvedValue(undefined),
  getEngineCapabilities: vi.fn().mockResolvedValue({}),
  listScheduledTasks: vi.fn().mockResolvedValue([]),
  getScheduledTask: vi.fn().mockResolvedValue(null),
  createScheduledTask: vi.fn().mockResolvedValue({ id: 't1' }),
  updateScheduledTask: vi.fn().mockResolvedValue({ id: 't1' }),
  deleteScheduledTask: vi.fn().mockResolvedValue({ success: true }),
  runScheduledTaskNow: vi.fn().mockResolvedValue({ success: true }),
  request: vi.fn().mockResolvedValue({}),
  on: vi.fn(),
  off: vi.fn(),
};

vi.mock('../../../../src/lib/gateway-client', () => ({
  gatewayClient: mockGatewayClient,
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import after mocks are set up
const { gateway, gatewayConnected, getAuthoritativeSessionActivity } = await import('../../../../src/lib/gateway-api');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function emit(event: string, payload?: unknown) {
  const binding = mockGatewayClient.on.mock.calls.find(([name]) => name === event);
  expect(binding).toBeDefined();
  (binding![1] as (value?: unknown) => void)(payload);
}

function message(id: string, sessionId = 's1', parts: UnifiedPart[] = []): UnifiedMessage {
  return { id, sessionId, role: 'assistant', time: { created: 1 }, parts };
}

function part(id: string, text: string, messageId = 'm1', sessionId = 's1'): UnifiedPart {
  return { id, sessionId, messageId, type: 'text', text };
}

const { setConfigStore } = await import('../../../../src/stores/config');
const { sessionStore, setSessionStore } = await import('../../../../src/stores/session');
const { messageStore, setMessageStore } = await import('../../../../src/stores/message');

function useAuthoritativeEngine() {
  setConfigStore('engines', [{
    type: 'test-engine',
    capabilities: { authoritativeSessionState: true },
  } as EngineInfo]);
  setSessionStore('list', [{
    id: 's1', engineType: 'test-engine', title: 'Shared', directory: '/tmp',
    createdAt: new Date(1).toISOString(), updatedAt: new Date(1).toISOString(),
  }]);
}

function sharedSession(activityStatus: SessionActivityStatus, id = 's1'): UnifiedSession {
  return { id, engineType: 'test-engine', directory: '/tmp', activityStatus, time: { created: 1, updated: 2 } };
}

function emitGatewayEvent(event: string, payload: unknown) {
  const handler = mockGatewayClient.on.mock.calls.find(([name]) => name === event)?.[1];
  expect(handler).toBeTypeOf('function');
  handler(payload);
}

function catalogSnapshot(sourceId = 'desktop/local', revision = 'r1', sessions: UnifiedSession[] = []): EngineCatalogSnapshot {
  return { sourceId, revision, complete: true, sessions, projects: [{
    id: `catalog:${sourceId}:stable-project`, name: 'Shared project', directory: '/workspace/Second Root',
    roots: ['/workspace/Second Root', 'C:\\Projects\\First', '/workspace/nested/../root'],
    catalogSourceId: sourceId, catalogProjectId: 'stable-project',
  }] };
}

describe('GatewayAPI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset initialized state by calling destroy
    gateway.destroy();
    vi.clearAllMocks(); // clear the disconnect/off calls from destroy
    setConfigStore('engines', []);
    setSessionStore('list', []);
    setSessionStore('current', null);
    setSessionStore('sendingMap', reconcile({}));
    setMessageStore('message', reconcile({}));
    setMessageStore('part', reconcile({}));
  });

  // --- init & isInitialized ---

  it('isInitialized returns false before init', () => {
    expect(gateway.isInitialized).toBe(false);
  });

  it('init connects and marks initialized', async () => {
    await gateway.init();
    expect(gateway.isInitialized).toBe(true);
    expect(mockGatewayClient.connect).toHaveBeenCalledOnce();
  });

  it('init stores handlers when provided', async () => {
    const onConnected = vi.fn();
    await gateway.init({ onConnected });
    expect(gateway.isInitialized).toBe(true);
  });

  it('init skips re-connect when already initialized', async () => {
    await gateway.init();
    await gateway.init(); // second call
    expect(mockGatewayClient.connect).toHaveBeenCalledOnce();
  });

  it('init catches connection errors', async () => {
    mockGatewayClient.connect.mockRejectedValueOnce(new Error('fail'));
    await gateway.init(); // should not throw
    expect(gateway.isInitialized).toBe(true);
  });

  // --- setHandlers ---

  it('setHandlers merges new handlers', () => {
    const fn = vi.fn();
    gateway.setHandlers({ onConnected: fn });
    // no throw means success
  });

  // --- destroy ---

  it('destroy resets initialized and disconnects', async () => {
    await gateway.init();
    emit('connected');
    expect(gatewayConnected()).toBe(true);
    vi.clearAllMocks();
    gateway.destroy();
    expect(gateway.isInitialized).toBe(false);
    expect(gatewayConnected()).toBe(false);
    expect(mockGatewayClient.disconnect).toHaveBeenCalledOnce();
  });

  // --- connected getter ---

  it('connected delegates to gatewayClient.connected', () => {
    expect(gateway.connected).toBe(true);
  });

  describe('authoritative session state', () => {
    it.each<[SessionActivityStatus, boolean]>([
      ['running', true], ['waiting', true], ['idle', false],
      ['completed', false], ['error', false], ['cancelled', false],
    ])('applies remote %s activity without a local send', async (status, sending) => {
      useAuthoritativeEngine();
      setSessionStore('sendingMap', 's1', !sending);
      const onSessionUpdated = vi.fn();
      await gateway.init({ onSessionUpdated });
      const session = sharedSession(status);

      emitGatewayEvent('session.updated', { session });

      expect(sessionStore.sendingMap.s1).toBe(sending);
      expect(getAuthoritativeSessionActivity('s1')).toBe(status);
      expect(onSessionUpdated).toHaveBeenCalledWith(session);
    });

    it('preserves ordinary engine sending state when activity is not authoritative', async () => {
      setSessionStore('sendingMap', 's1', true);
      await gateway.init({});

      emitGatewayEvent('session.updated', { session: sharedSession('idle') });

      expect(sessionStore.sendingMap.s1).toBe(true);
      expect(getAuthoritativeSessionActivity('s1')).toBeUndefined();
    });

    it('restores activity from session list and get snapshots', async () => {
      useAuthoritativeEngine();
      mockGatewayClient.listAllSessions.mockResolvedValueOnce([sharedSession('running')]);
      await gateway.listAllSessions();
      expect(sessionStore.sendingMap.s1).toBe(true);

      mockGatewayClient.getSession.mockResolvedValueOnce(sharedSession('waiting'));
      await gateway.getSession('s1');
      expect(getAuthoritativeSessionActivity('s1')).toBe('waiting');

      mockGatewayClient.listSessions.mockResolvedValueOnce([sharedSession('completed')]);
      await gateway.listSessions('test-engine');
      expect(sessionStore.sendingMap.s1).toBe(false);
    });

    it('keeps a newer activity event when an earlier snapshot finishes late', async () => {
      useAuthoritativeEngine();
      await gateway.init({});
      let resolveSnapshot!: (session: UnifiedSession) => void;
      mockGatewayClient.getSession.mockReturnValueOnce(new Promise<UnifiedSession>((resolve) => {
        resolveSnapshot = resolve;
      }));
      const snapshot = gateway.getSession('s1');

      emitGatewayEvent('session.updated', { session: sharedSession('running') });
      resolveSnapshot(sharedSession('idle'));
      await snapshot;

      expect(sessionStore.sendingMap.s1).toBe(true);
      expect(getAuthoritativeSessionActivity('s1')).toBe('running');
    });
  });

  describe('session removal', () => {
    it('clears activity and ignores late session output until an explicit restoration', async () => {
      useAuthoritativeEngine();
      const handlers = {
        onSessionRemoved: vi.fn(), onSessionUpdated: vi.fn(), onMessageUpdated: vi.fn(),
        onPartUpdated: vi.fn(), onPartsBatch: vi.fn(), onMessageRemoved: vi.fn(),
        onPermissionAsked: vi.fn(), onQuestionAsked: vi.fn(), onMessageQueued: vi.fn(), onMessageQueuedConsumed: vi.fn(),
      };
      await gateway.init(handlers);
      emitGatewayEvent('session.updated', { session: sharedSession('running') });
      handlers.onSessionUpdated.mockClear();
      emitGatewayEvent('session.removed', { sessionId: 's1' });
      emitGatewayEvent('session.updated', { session: sharedSession('running') });
      emitGatewayEvent('message.updated', { sessionId: 's1', message: { id: 'old' } });
      emitGatewayEvent('message.part.updated', { sessionId: 's1', part: { id: 'old' } });
      emitGatewayEvent('message.parts.batch', { sessionId: 's1', messageId: 'old', parts: [{ id: 'old' }] });
      emitGatewayEvent('message.removed', { sessionId: 's1', messageId: 'old' });
      emitGatewayEvent('message.queued', { sessionId: 's1', messageId: 'old', queuePosition: 0 });
      emitGatewayEvent('message.queued.consumed', { sessionId: 's1', messageId: 'old' });
      emitGatewayEvent('permission.asked', { permission: { id: 'old', sessionId: 's1' } });
      emitGatewayEvent('question.asked', { question: { id: 'old', sessionId: 's1' } });

      expect(getAuthoritativeSessionActivity('s1')).toBeUndefined();
      expect(sessionStore.sendingMap.s1).toBe(false);
      expect(handlers.onSessionRemoved).toHaveBeenCalledExactlyOnceWith('s1');
      for (const [name, handler] of Object.entries(handlers)) {
        if (name !== 'onSessionRemoved') expect(handler).not.toHaveBeenCalled();
      }
      emitGatewayEvent('session.created', { session: sharedSession('idle') });
      emitGatewayEvent('message.updated', { sessionId: 's1', message: { id: 'fresh' } });
      expect(mockGatewayClient.discardSessionNotifications).toHaveBeenCalledExactlyOnceWith('s1');
      expect(handlers.onMessageUpdated).toHaveBeenCalledExactlyOnceWith('s1', { id: 'fresh' });
    });

    it('filters every in-flight session and content snapshot after removal', async () => {
      useAuthoritativeEngine();
      const onSessionUpdated = vi.fn();
      await gateway.init({ onSessionUpdated });
      let finish!: () => void;
      const wait = new Promise<void>((resolve) => { finish = resolve; });
      const old = { ...sharedSession('running'), title: 'Old private title', catalogSourceId: 'desktop/local' };
      const message: UnifiedMessage = { id: 'old-message', sessionId: 's1', role: 'assistant', time: { created: 1 }, parts: [] };
      const part = { id: 'old-part', messageId: message.id, sessionId: 's1', type: 'text' as const, text: 'Old output' };
      mockGatewayClient.listSessions.mockReturnValueOnce(wait.then(() => [old]));
      mockGatewayClient.listAllSessions.mockReturnValueOnce(wait.then(() => [old]));
      mockGatewayClient.getSession.mockReturnValueOnce(wait.then(() => old));
      mockGatewayClient.listCatalogs.mockReturnValueOnce(wait.then(() => [catalogSnapshot('desktop/local', 'old', [old])]));
      mockGatewayClient.listMessages.mockReturnValueOnce(wait.then(() => [message]));
      mockGatewayClient.getMessageSteps.mockReturnValueOnce(wait.then(() => [part]));
      mockGatewayClient.request.mockReturnValueOnce(wait.then(() => ({ questions: [{ id: 'old' }], permissions: [{ id: 'old' }] })));
      const sessions = gateway.listSessions('test-engine');
      const allSessions = gateway.listAllSessions();
      const session = expect(gateway.getSession('s1')).rejects.toThrow('Session was removed');
      const catalogs = gateway.listCatalogs();
      const messages = gateway.listMessages('s1');
      const steps = gateway.getMessageSteps('s1', message.id);
      const pending = gateway.listPending('s1');
      emitGatewayEvent('session.removed', { sessionId: 's1' });
      finish();

      expect(await sessions).toEqual([]);
      expect(await allSessions).toEqual([]);
      await session;
      expect((await catalogs)[0].sessions).toEqual([]);
      expect(await messages).toEqual([]);
      expect(await steps).toEqual([]);
      expect(await pending).toEqual({ questions: [], permissions: [] });
      expect(onSessionUpdated).not.toHaveBeenCalled();
      expect(getAuthoritativeSessionActivity('s1')).toBeUndefined();
    });

    it.each([false, true])('preserves removal and explicit restoration order when removed again=%s', async (removeAgain) => {
      await gateway.init({});
      let finish!: () => void;
      const wait = new Promise<void>((resolve) => { finish = resolve; });
      const old = { ...sharedSession('idle'), title: 'Old title', catalogSourceId: 'desktop/local', projectId: 'old-project' };
      const restored = { ...sharedSession('idle'), title: 'Restored title', catalogSourceId: 'desktop/local' };
      mockGatewayClient.listAllSessions.mockReturnValueOnce(wait.then(() => [old]));
      mockGatewayClient.getSession.mockReturnValueOnce(wait.then(() => old));
      mockGatewayClient.listCatalogs.mockReturnValueOnce(wait.then(() => [catalogSnapshot('desktop/local', 'old', [old])]));
      mockGatewayClient.listMessages.mockReturnValueOnce(wait.then(() => [{ id: 'old-message' }]));
      const sessions = gateway.listAllSessions();
      const get = gateway.getSession('s1');
      const result = removeAgain ? expect(get).rejects.toThrow('Session was removed') : get;
      const catalogs = gateway.listCatalogs();
      const messages = gateway.listMessages('s1');
      emitGatewayEvent('session.updated', { session: { ...old, title: 'Before removal' } });
      emitGatewayEvent('session.removed', { sessionId: 's1' });
      emitGatewayEvent('session.created', { session: restored });
      if (removeAgain) emitGatewayEvent('session.removed', { sessionId: 's1' });
      finish();

      expect(await sessions).toEqual(removeAgain ? [] : [restored]);
      expect((await catalogs)[0].sessions).toEqual(removeAgain ? [] : [restored]);
      if (removeAgain) await result;
      else expect(await result).toEqual(restored);
      expect(await messages).toEqual([]);
    });

    it('allows only a fresh catalog or created event to restore an active ID', async () => {
      await gateway.init({});
      const restored = { ...sharedSession('idle'), catalogSourceId: 'desktop/local' };
      emitGatewayEvent('session.removed', { sessionId: 's1' });
      mockGatewayClient.listAllSessions.mockResolvedValueOnce([restored]);
      expect(await gateway.listAllSessions()).toEqual([]);
      mockGatewayClient.listCatalogs.mockResolvedValueOnce([catalogSnapshot('desktop/local', 'restored', [restored])]);
      expect((await gateway.listCatalogs())[0].sessions).toEqual([restored]);
      expect(mockGatewayClient.discardSessionNotifications).toHaveBeenCalledExactlyOnceWith('s1');
      mockGatewayClient.getSession.mockResolvedValueOnce(restored);
      expect(await gateway.getSession('s1')).toEqual(restored);
    });

    it('drops removed IDs from cached catalog events as well as pending replies', async () => {
      await gateway.init({});
      let resolve!: (value: EngineCatalogSnapshot[]) => void;
      mockGatewayClient.listCatalogs.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
      const loading = gateway.listCatalogs();
      emitGatewayEvent('catalog.updated', catalogSnapshot('desktop/local', 'new', [sharedSession('idle')]));
      emitGatewayEvent('session.removed', { sessionId: 's1' });
      resolve([catalogSnapshot('desktop/local', 'old', [sharedSession('idle')])]);
      expect((await loading)[0].sessions).toEqual([]);
    });
  });

  describe('authoritative message snapshots', () => {
    it('keeps removed messages out of a late snapshot and ignores their trailing parts', async () => {
      useAuthoritativeEngine();
      const onMessageRemoved = vi.fn();
      await gateway.init({ onMessageRemoved });
      let resolveSnapshot!: (messages: UnifiedMessage[]) => void;
      mockGatewayClient.listMessages.mockReturnValueOnce(new Promise<UnifiedMessage[]>((resolve) => {
        resolveSnapshot = resolve;
      }));
      const loading = gateway.listMessages('s1');
      const oldPart = { id: 'p1', messageId: 'm1', sessionId: 's1', type: 'text' as const, text: 'removed output' };

      emitGatewayEvent('message.removed', { sessionId: 's1', messageId: 'm1' });
      emitGatewayEvent('message.part.updated', { sessionId: 's1', part: oldPart });
      resolveSnapshot([
        { id: 'm1', sessionId: 's1', role: 'assistant', time: { created: 1 }, parts: [oldPart] },
        { id: 'm2', sessionId: 's1', role: 'user', time: { created: 2 }, parts: [] },
      ]);

      expect((await loading).map((message) => message.id)).toEqual(['m2']);
      expect(onMessageRemoved).toHaveBeenCalledWith('s1', 'm1');
    });

    it('allows an explicit message update to restore an ID removed during the snapshot', async () => {
      useAuthoritativeEngine();
      await gateway.init({});
      let resolveSnapshot!: (messages: UnifiedMessage[]) => void;
      mockGatewayClient.listMessages.mockReturnValueOnce(new Promise<UnifiedMessage[]>((resolve) => {
        resolveSnapshot = resolve;
      }));
      const loading = gateway.listMessages('s1');
      const restored: UnifiedMessage = { id: 'm1', sessionId: 's1', role: 'user', time: { created: 2 }, parts: [] };
      emitGatewayEvent('message.removed', { sessionId: 's1', messageId: 'm1' });
      emitGatewayEvent('message.updated', { sessionId: 's1', message: restored });
      resolveSnapshot([]);

      expect(await loading).toEqual([restored]);
    });

    it.each(['removed part', 'empty parts'] as const)(
      'replaces stale parts with a complete message update containing %s during history loading',
      async (variant) => {
        useAuthoritativeEngine();
        await gateway.init({});
        let resolveSnapshot!: (messages: UnifiedMessage[]) => void;
        mockGatewayClient.listMessages.mockReturnValueOnce(new Promise<UnifiedMessage[]>((resolve) => {
          resolveSnapshot = resolve;
        }));
        const loading = gateway.listMessages('s1');
        const keptPart = { id: 'p1', messageId: 'm1', sessionId: 's1', type: 'text' as const, text: 'old output' };
        const removedPart = { ...keptPart, id: 'p2', text: 'removed output' };
        const interimPart = { ...keptPart, id: 'p3', text: 'interim output' };
        const snapshot: UnifiedMessage = {
          id: 'm1', sessionId: 's1', role: 'assistant', time: { created: 1 }, parts: [keptPart, removedPart],
        };
        const complete: UnifiedMessage = {
          ...snapshot,
          parts: variant === 'empty parts' ? [] : [{ ...keptPart, text: 'current output' }],
        };

        emitGatewayEvent('message.part.updated', { sessionId: 's1', part: interimPart });
        emitGatewayEvent('message.updated', { sessionId: 's1', message: complete });
        resolveSnapshot([snapshot]);

        expect(await loading).toEqual([complete]);
      },
    );

    it('merges partial updates after a complete message replacement during history loading', async () => {
      useAuthoritativeEngine();
      await gateway.init({});
      let resolveSnapshot!: (messages: UnifiedMessage[]) => void;
      mockGatewayClient.listMessages.mockReturnValueOnce(new Promise<UnifiedMessage[]>((resolve) => {
        resolveSnapshot = resolve;
      }));
      const loading = gateway.listMessages('s1');
      const removedPart = { id: 'p1', messageId: 'm1', sessionId: 's1', type: 'text' as const, text: 'removed output' };
      const keptPart = { ...removedPart, id: 'p2', text: 'current output' };
      const snapshot: UnifiedMessage = {
        id: 'm1', sessionId: 's1', role: 'assistant', time: { created: 1 }, parts: [removedPart],
      };
      const complete: UnifiedMessage = { ...snapshot, parts: [keptPart] };
      const nextPart = { ...keptPart, id: 'p3', text: 'new output' };
      const updatedPart = { ...keptPart, text: 'updated output' };

      emitGatewayEvent('message.updated', { sessionId: 's1', message: complete });
      emitGatewayEvent('message.part.updated', { sessionId: 's1', part: nextPart });
      emitGatewayEvent('message.parts.batch', { sessionId: 's1', messageId: 'm1', parts: [updatedPart] });
      resolveSnapshot([snapshot]);

      expect(await loading).toEqual([{ ...complete, parts: [updatedPart, nextPart] }]);
    });

    it('retains messages and streaming parts received while a snapshot is loading', async () => {
      useAuthoritativeEngine();
      await gateway.init({});
      let resolveSnapshot!: (messages: UnifiedMessage[]) => void;
      mockGatewayClient.listMessages.mockReturnValueOnce(new Promise<UnifiedMessage[]>((resolve) => {
        resolveSnapshot = resolve;
      }));
      const loading = gateway.listMessages('s1');
      const oldPart = { id: 'p1', messageId: 'm1', sessionId: 's1', type: 'text' as const, text: 'old' };
      const newPart = { ...oldPart, text: 'new output' };
      const user: UnifiedMessage = { id: 'm2', sessionId: 's1', role: 'user', time: { created: 2 }, parts: [] };
      const nextPart = { ...newPart, id: 'p3', messageId: 'm3', text: 'next turn' };

      emitGatewayEvent('message.updated', { sessionId: 's1', message: user });
      emitGatewayEvent('message.part.updated', { sessionId: 's1', part: newPart });
      emitGatewayEvent('message.parts.batch', { sessionId: 's1', messageId: 'm3', parts: [nextPart] });
      emitGatewayEvent('message.updated', { sessionId: 'other', message: { ...user, id: 'other', sessionId: 'other' } });
      resolveSnapshot([{ id: 'm1', sessionId: 's1', role: 'assistant', time: { created: 1 }, parts: [oldPart] }]);

      const messages = await loading;
      expect(messages.map((message) => message.id)).toEqual(['m1', 'm2', 'm3']);
      expect(messages[0].parts).toEqual([newPart]);
      expect(messages[2].parts).toEqual([nextPart]);
    });

    it('retains ordinary engine messages received during history loading', async () => {
      await gateway.init({});
      let resolveSnapshot!: (messages: UnifiedMessage[]) => void;
      mockGatewayClient.listMessages.mockReturnValueOnce(new Promise<UnifiedMessage[]>((resolve) => {
        resolveSnapshot = resolve;
      }));
      const loading = gateway.listMessages('s1');
      const incoming: UnifiedMessage = { id: 'new', sessionId: 's1', role: 'user', time: { created: 2 }, parts: [] };
      emitGatewayEvent('message.updated', { sessionId: 's1', message: incoming });
      const snapshot: UnifiedMessage[] = [];
      resolveSnapshot(snapshot);

      expect(await loading).toEqual([incoming]);
    });
  });

  // --- Delegation methods ---

  describe('canonical catalogs', () => {
    it('keeps session metadata events newer than an in-flight catalog response in delivery order', async () => {
      await gateway.init();
      let resolveCatalogs!: (catalogs: EngineCatalogSnapshot[]) => void;
      mockGatewayClient.listCatalogs.mockReturnValueOnce(new Promise((resolve) => { resolveCatalogs = resolve; }));
      const loading = gateway.listCatalogs();
      const old = { ...sharedSession('idle'), catalogSourceId: 'desktop/local', title: 'Old', modelId: 'old-model' };
      emitGatewayEvent('session.updated', { session: { ...old, title: 'First' } });
      const snapshot = catalogSnapshot('desktop/local', 'r2', [{ ...old, title: 'Catalog title' }]);
      emitGatewayEvent('catalog.updated', snapshot);
      const latest = { ...old, title: 'Live title', modelId: 'new-model', activityStatus: 'running' as const, projectId: null };
      emitGatewayEvent('session.updated', { session: latest });
      const created = { ...sharedSession('idle', 'new-chat'), catalogSourceId: 'desktop/local' };
      emitGatewayEvent('session.created', { session: created });
      resolveCatalogs([catalogSnapshot('desktop/local', 'r1', [old])]);
      const [result] = await loading;
      expect(result.sessions).toEqual([latest, created]);
      expect(snapshot.sessions[0].title).toBe('Catalog title');

      mockGatewayClient.listCatalogs.mockResolvedValueOnce([catalogSnapshot('desktop/local', 'r3', [{ ...old, title: 'Later' }])]);
      expect((await gateway.listCatalogs())[0].sessions[0].title).toBe('Later');
    });

    it('lists owner snapshots unchanged and synchronizes their session activity', async () => {
      useAuthoritativeEngine();
      const snapshot = catalogSnapshot('desktop/local', 'owner-revision', [sharedSession('running')]);
      mockGatewayClient.listCatalogs.mockResolvedValueOnce([snapshot]);

      expect(await gateway.listCatalogs()).toEqual([snapshot]);
      expect(mockGatewayClient.listCatalogs).toHaveBeenCalledExactlyOnceWith();
      expect(sessionStore.sendingMap.s1).toBe(true);
      expect(getAuthoritativeSessionActivity('s1')).toBe('running');
    });

    it('synchronizes all catalog activity before notifying without changing the active chat', async () => {
      useAuthoritativeEngine();
      setSessionStore('current', 's1');
      setSessionStore('sendingMap', 's2', true);
      setSessionStore('sendingMap', 'ordinary', true);
      const message: UnifiedMessage = { id: 'm1', sessionId: 's1', role: 'assistant', time: { created: 1 }, parts: [] };
      const part = { id: 'p1', messageId: 'm1', sessionId: 's1', type: 'text' as const, text: 'Visible streamed output' };
      setMessageStore('message', 's1', [message]);
      setMessageStore('part', 'm1', [part]);
      const activeMessages = messageStore.message.s1;
      const activeParts = messageStore.part.m1;
      const selectedSession = sessionStore.list[0];
      const snapshot = catalogSnapshot('desktop/local', 'r2', [sharedSession('running'), sharedSession('completed', 's2'),
        { ...sharedSession('idle', 'ordinary'), engineType: 'claude' }]);
      const onCatalogUpdated = vi.fn((incoming: EngineCatalogSnapshot) => {
        expect(incoming).toBe(snapshot);
        expect(getAuthoritativeSessionActivity('s1')).toBe('running');
        expect(getAuthoritativeSessionActivity('s2')).toBe('completed');
        expect(sessionStore.sendingMap.s1).toBe(true);
        expect(sessionStore.sendingMap.s2).toBe(false);
      });
      const onMessageRemoved = vi.fn();
      await gateway.init({ onCatalogUpdated, onMessageRemoved });

      emitGatewayEvent('catalog.updated', snapshot);

      expect(onCatalogUpdated).toHaveBeenCalledExactlyOnceWith(snapshot);
      expect(onCatalogUpdated.mock.calls[0][0]).toBe(snapshot);
      expect(sessionStore.current).toBe('s1');
      expect(sessionStore.list[0]).toBe(selectedSession);
      expect(messageStore.message.s1).toBe(activeMessages);
      expect(messageStore.part.m1).toBe(activeParts);
      expect(messageStore.part.m1).toEqual([part]);
      expect(onMessageRemoved).not.toHaveBeenCalled();
      expect(sessionStore.sendingMap.ordinary).toBe(true);
      expect(getAuthoritativeSessionActivity('ordinary')).toBeUndefined();
      for (const fetch of [mockGatewayClient.listCatalogs, mockGatewayClient.listSessions, mockGatewayClient.listAllSessions,
        mockGatewayClient.listProjects, mockGatewayClient.listAllProjects, mockGatewayClient.getSession, mockGatewayClient.listMessages]) {
        expect(fetch).not.toHaveBeenCalled();
      }
    });

    it('retains the latest pushed snapshot and new sources when an older catalog request completes', async () => {
      useAuthoritativeEngine();
      await gateway.init({});
      let resolveCatalogs!: (catalogs: EngineCatalogSnapshot[]) => void;
      mockGatewayClient.listCatalogs.mockReturnValueOnce(new Promise<EngineCatalogSnapshot[]>((resolve) => { resolveCatalogs = resolve; }));
      const loading = gateway.listCatalogs();
      const stale = catalogSnapshot('desktop/local', 'r1', [sharedSession('idle')]);
      const unchanged = catalogSnapshot('other-source', 'other-r1');
      const latest = catalogSnapshot('desktop/local', 'r3', [sharedSession('waiting')]);
      latest.projects.push({ id: 'catalog:desktop/local:new-project', name: 'Created during loading', directory: '/new', roots: ['/new'] });
      const added = catalogSnapshot('new-source', 'new-r1', [sharedSession('running', 'new-session')]);
      emitGatewayEvent('catalog.updated', catalogSnapshot('desktop/local', 'r2', [sharedSession('running')]));
      emitGatewayEvent('catalog.updated', latest);
      emitGatewayEvent('catalog.updated', added);
      resolveCatalogs([stale, unchanged]);

      const catalogs = await loading;
      expect(catalogs).toHaveLength(3);
      expect(catalogs).toContainEqual(latest);
      expect(catalogs).toContainEqual(unchanged);
      expect(catalogs).toContainEqual(added);
      expect(getAuthoritativeSessionActivity('s1')).toBe('waiting');
      expect(getAuthoritativeSessionActivity('new-session')).toBe('running');
      expect(mockGatewayClient.listCatalogs).toHaveBeenCalledOnce();
    });

    it('clears pushed catalogs on destroy before a new connection loads its sources', async () => {
      await gateway.init({});
      emitGatewayEvent('catalog.updated', catalogSnapshot('previous-connection', 'r9'));
      gateway.destroy();
      mockGatewayClient.on.mockClear();
      await gateway.init({});
      let resolveCatalogs!: (catalogs: EngineCatalogSnapshot[]) => void;
      mockGatewayClient.listCatalogs.mockReturnValueOnce(new Promise<EngineCatalogSnapshot[]>((resolve) => { resolveCatalogs = resolve; }));
      const loading = gateway.listCatalogs();
      const current = catalogSnapshot('new-connection', 'r1');
      emitGatewayEvent('catalog.updated', current);
      resolveCatalogs([]);

      expect(await loading).toEqual([current]);
      expect(mockGatewayClient.off).toHaveBeenCalledWith('catalog.updated', expect.any(Function));
    });

    it('creates and updates projects without normalizing roots or replacing stable IDs', async () => {
      const snapshot = catalogSnapshot();
      const project = snapshot.projects[0];
      mockGatewayClient.createProject.mockResolvedValueOnce(project);
      expect(await gateway.createProject(snapshot.sourceId, project.name!, project.roots!)).toBe(project);
      expect(mockGatewayClient.createProject).toHaveBeenCalledWith({ sourceId: snapshot.sourceId, name: project.name, roots: project.roots });
      const patch = { name: 'Renamed project', roots: [...project.roots!].reverse() };
      const updated: UnifiedProject = { ...project, ...patch };
      mockGatewayClient.updateProject.mockResolvedValueOnce(updated);
      expect(await gateway.updateProject(project.id, patch)).toBe(updated);
      expect(mockGatewayClient.updateProject).toHaveBeenCalledWith({ projectId: project.id, patch });
    });

    it('reorders stable project IDs without changing their supplied order', async () => {
      const projectIds = ['catalog:desktop/local:second', 'catalog:desktop/local:first'];
      await gateway.reorderProjects('desktop/local', projectIds);
      expect(mockGatewayClient.reorderProjects).toHaveBeenCalledExactlyOnceWith({ sourceId: 'desktop/local', projectIds });
    });

    it.each(['catalog:desktop/local:stable-project', null])('passes session project assignment %s unchanged', async (projectId) => {
      await gateway.setSessionProject('s1', projectId);
      expect(mockGatewayClient.setSessionProject).toHaveBeenCalledExactlyOnceWith({ sessionId: 's1', projectId });
    });

    it.each(['catalog:desktop/local:stable-project', null])('creates a session with explicit project assignment %s', async (projectId) => {
      await gateway.createSession('codex', '/workspace/worktree', 'worktree-stable', projectId);
      expect(mockGatewayClient.createSession).toHaveBeenCalledExactlyOnceWith({ engineType: 'codex', directory: '/workspace/worktree', worktreeId: 'worktree-stable', projectId });
    });
  });

  it('listEngines delegates', async () => {
    const engines = [{ type: 'claude' }];
    mockGatewayClient.listEngines.mockResolvedValueOnce(engines);
    const result = await gateway.listEngines();
    expect(result).toEqual(engines);
  });

  it('listModels delegates', async () => {
    const models = { models: [{ id: 'm1' }] };
    mockGatewayClient.listModels.mockResolvedValueOnce(models);
    const result = await gateway.listModels('claude' as any);
    expect(result).toEqual(models);
    expect(mockGatewayClient.listModels).toHaveBeenCalledWith('claude');
  });

  it('listSessions delegates', async () => {
    await gateway.listSessions('claude' as any);
    expect(mockGatewayClient.listSessions).toHaveBeenCalledWith('claude');
  });

  it('createSession delegates with params', async () => {
    await gateway.createSession('claude' as any, '/tmp');
    expect(mockGatewayClient.createSession).toHaveBeenCalledWith({
      engineType: 'claude',
      directory: '/tmp',
      worktreeId: undefined,
    });
  });

  it('getSession delegates', async () => {
    await gateway.getSession('s1');
    expect(mockGatewayClient.getSession).toHaveBeenCalledWith('s1');
  });

  it('deleteSession delegates', async () => {
    await gateway.deleteSession('s1');
    expect(mockGatewayClient.deleteSession).toHaveBeenCalledWith('s1');
  });

  it('renameSession delegates', async () => {
    await gateway.renameSession('s1', 'New Title');
    expect(mockGatewayClient.renameSession).toHaveBeenCalledWith('s1', 'New Title');
  });

  it.each([true, false])('setSessionArchived delegates archived=%s without hiding errors', async (archived) => {
    await gateway.setSessionArchived('s1', archived);
    expect(mockGatewayClient.setSessionArchived).toHaveBeenCalledWith('s1', archived);
    mockGatewayClient.setSessionArchived.mockRejectedValueOnce(new Error('Owner unavailable'));
    await expect(gateway.setSessionArchived('s1', archived)).rejects.toThrow('Owner unavailable');
  });

  it('cancelMessage delegates', async () => {
    await gateway.cancelMessage('s1');
    expect(mockGatewayClient.cancelMessage).toHaveBeenCalledWith('s1');
  });

  it('listMessages delegates', async () => {
    await gateway.listMessages('s1');
    expect(mockGatewayClient.listMessages).toHaveBeenCalledWith('s1');
  });

  describe('listMessages', () => {
    it('merges live part batches and message completion into an older snapshot', async () => {
      const onPartsBatch = vi.fn();
      await gateway.init({ onPartsBatch });
      const pending = deferred<UnifiedMessage[]>();
      mockGatewayClient.listMessages.mockReturnValueOnce(pending.promise);
      const loading = gateway.listMessages('s1');

      emit('message.part.updated', { sessionId: 's1', part: part('p1', 'live') });
      const batch = [part('p1', 'latest'), part('p2', 'new tool output')];
      emit('message.parts.batch', { sessionId: 's1', messageId: 'm1', parts: batch });
      emit('message.updated', {
        sessionId: 's1',
        message: { ...message('m1'), time: { created: 1, completed: 10 } },
      });
      pending.resolve([message('m1', 's1', [part('p1', 'old'), part('disk-only', 'retained')])]);

      const result = await loading;
      expect(result).toHaveLength(1);
      expect(result[0].time.completed).toBe(10);
      expect(result[0].parts).toEqual([
        part('p1', 'latest'), part('disk-only', 'retained'), part('p2', 'new tool output'),
      ]);
      expect(onPartsBatch).toHaveBeenCalledExactlyOnceWith('s1', 'm1', batch);
    });

    it('retains new messages and part-only placeholders without mixing sessions', async () => {
      await gateway.init();
      const pending = deferred<UnifiedMessage[]>();
      mockGatewayClient.listMessages.mockReturnValueOnce(pending.promise);
      const loading = gateway.listMessages('s1');
      const live = { ...message('new'), time: { created: 2 } };
      emit('message.updated', { sessionId: 's1', message: live });
      emit('message.part.updated', { sessionId: 's1', part: part('new-part', 'live text', 'part-only') });
      emit('message.updated', { sessionId: 'other', message: message('excluded', 'other') });
      pending.resolve([message('older')]);

      const result = await loading;
      expect(result.map((item) => item.id)).toEqual(['older', 'new', 'part-only']);
      expect(result[2]).toMatchObject({
        sessionId: 's1', role: 'assistant', parts: [part('new-part', 'live text', 'part-only')],
      });
    });

    it('keeps concurrent snapshot buffers independent', async () => {
      await gateway.init();
      const first = deferred<UnifiedMessage[]>();
      const second = deferred<UnifiedMessage[]>();
      mockGatewayClient.listMessages.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const firstLoad = gateway.listMessages('s1');
      const secondLoad = gateway.listMessages('s1');
      emit('message.part.updated', { sessionId: 's1', part: part('p1', 'first event') });
      first.resolve([message('m1')]);
      expect((await firstLoad)[0].parts).toEqual([part('p1', 'first event')]);

      emit('message.part.updated', { sessionId: 's1', part: part('p1', 'second event') });
      second.resolve([message('m1')]);
      expect((await secondLoad)[0].parts).toEqual([part('p1', 'second event')]);
    });

    it('discards failed snapshot updates before the next request', async () => {
      await gateway.init();
      const pending = deferred<UnifiedMessage[]>();
      mockGatewayClient.listMessages.mockReturnValueOnce(pending.promise);
      const loading = gateway.listMessages('s1');
      emit('message.updated', { sessionId: 's1', message: message('failed-request-event') });
      pending.reject(new Error('Connection interrupted'));
      await expect(loading).rejects.toThrow('Connection interrupted');

      mockGatewayClient.listMessages.mockResolvedValueOnce([message('fresh')]);
      expect((await gateway.listMessages('s1')).map((item) => item.id)).toEqual(['fresh']);
    });
  });

  it('getMessageSteps delegates', async () => {
    await gateway.getMessageSteps('s1', 'm1');
    expect(mockGatewayClient.getMessageSteps).toHaveBeenCalledWith('s1', 'm1');
  });

  it('getCapabilities delegates', async () => {
    await gateway.getCapabilities('claude' as any);
    expect(mockGatewayClient.getEngineCapabilities).toHaveBeenCalledWith('claude');
  });

  it('setModel delegates', async () => {
    await gateway.setModel('s1', 'model-1');
    expect(mockGatewayClient.setModel).toHaveBeenCalledWith({ sessionId: 's1', modelId: 'model-1' });
  });

  it('setMode delegates', async () => {
    await gateway.setMode('s1', 'fast');
    expect(mockGatewayClient.setMode).toHaveBeenCalledWith({ sessionId: 's1', modeId: 'fast' });
  });

  it('replyPermission delegates', async () => {
    await gateway.replyPermission('p1', 'allow');
    expect(mockGatewayClient.replyPermission).toHaveBeenCalledWith({ permissionId: 'p1', optionId: 'allow' });
  });

  it('replyQuestion delegates', async () => {
    await gateway.replyQuestion('q1', [['a']]);
    expect(mockGatewayClient.replyQuestion).toHaveBeenCalledWith({ questionId: 'q1', answers: [['a']] });
  });

  it('rejectQuestion delegates', async () => {
    await gateway.rejectQuestion('q1');
    expect(mockGatewayClient.rejectQuestion).toHaveBeenCalledWith('q1');
  });

  it('listProjects delegates', async () => {
    await gateway.listProjects('claude' as any);
    expect(mockGatewayClient.listProjects).toHaveBeenCalledWith('claude');
  });

  it('setProjectEngine delegates', async () => {
    await gateway.setProjectEngine('/tmp', 'claude' as any);
    expect(mockGatewayClient.setProjectEngine).toHaveBeenCalledWith({ directory: '/tmp', engineType: 'claude' });
  });

  it('listAllSessions delegates', async () => {
    await gateway.listAllSessions();
    expect(mockGatewayClient.listAllSessions).toHaveBeenCalled();
  });

  it('listAllProjects delegates', async () => {
    await gateway.listAllProjects();
    expect(mockGatewayClient.listAllProjects).toHaveBeenCalled();
  });

  it('deleteProject delegates', async () => {
    await gateway.deleteProject('p1');
    expect(mockGatewayClient.deleteProject).toHaveBeenCalledWith('p1');
  });

  it('importLegacyProjects delegates', async () => {
    await gateway.importLegacyProjects([]);
    expect(mockGatewayClient.importLegacyProjects).toHaveBeenCalledWith([]);
  });

  // --- sendMessage ---

  it('sendMessage builds content with text only', async () => {
    await gateway.sendMessage('s1', 'hello');
    expect(mockGatewayClient.sendMessage).toHaveBeenCalledWith({
      sessionId: 's1',
      content: [{ type: 'text', text: 'hello' }],
      mode: undefined,
      modelId: undefined,
      reasoningEffort: undefined,
      serviceTier: undefined,
    });
  });

  it('sendMessage builds content with text and images', async () => {
    const images = [{ data: 'base64data', mimeType: 'image/png' }];
    await gateway.sendMessage('s1', 'look', { images: images as any });
    expect(mockGatewayClient.sendMessage).toHaveBeenCalledWith({
      sessionId: 's1',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', data: 'base64data', mimeType: 'image/png' },
      ],
      mode: undefined,
      modelId: undefined,
      reasoningEffort: undefined,
      serviceTier: undefined,
    });
  });

  it('sendMessage forwards mode and modelId', async () => {
    await gateway.sendMessage('s1', 'hi', { mode: 'fast', modelId: 'gpt-4' });
    expect(mockGatewayClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'fast', modelId: 'gpt-4' }),
    );
  });

  // --- invokeCommand ---

  it('invokeCommand delegates with options', async () => {
    await gateway.invokeCommand('s1', '/help', 'arg1', { mode: 'fast' });
    expect(mockGatewayClient.invokeCommand).toHaveBeenCalledWith({
      sessionId: 's1',
      commandName: '/help',
      args: 'arg1',
      mode: 'fast',
    });
  });

  it('invokeCommand delegates without options', async () => {
    await gateway.invokeCommand('s1', '/test', '');
    expect(mockGatewayClient.invokeCommand).toHaveBeenCalledWith({
      sessionId: 's1',
      commandName: '/test',
      args: '',
    });
  });

  // --- listCommands ---

  it('listCommands delegates', async () => {
    await gateway.listCommands('claude' as any, 's1');
    expect(mockGatewayClient.listCommands).toHaveBeenCalledWith({ engineType: 'claude', sessionId: 's1' });
  });

  // --- File explorer ---

  it('listFiles delegates', async () => {
    await gateway.listFiles('/dir', '/root');
    expect(mockGatewayClient.listFiles).toHaveBeenCalledWith('/dir', '/root');
  });

  it('readFile delegates', async () => {
    await gateway.readFile('/file.ts', '/dir');
    expect(mockGatewayClient.readFile).toHaveBeenCalledWith('/file.ts', '/dir');
  });

  it('getGitStatus delegates', async () => {
    await gateway.getGitStatus('/dir');
    expect(mockGatewayClient.getGitStatus).toHaveBeenCalledWith('/dir');
  });

  it('getGitDiff delegates', async () => {
    await gateway.getGitDiff('/dir', 'file.ts');
    expect(mockGatewayClient.getGitDiff).toHaveBeenCalledWith('/dir', 'file.ts');
  });

  it('watchDirectory delegates', async () => {
    await gateway.watchDirectory('/dir');
    expect(mockGatewayClient.watchDirectory).toHaveBeenCalledWith('/dir');
  });

  it('unwatchDirectory delegates', async () => {
    await gateway.unwatchDirectory('/dir');
    expect(mockGatewayClient.unwatchDirectory).toHaveBeenCalledWith('/dir');
  });

  // --- Import ---

  it('importPreview delegates', async () => {
    await gateway.importPreview('claude' as any, 10);
    expect(mockGatewayClient.importPreview).toHaveBeenCalledWith({ engineType: 'claude', limit: 10 });
  });

  it('importExecute delegates and binds/unbinds progress handler', async () => {
    const onProgress = vi.fn();
    await gateway.importExecute('claude' as any, [], onProgress);
    expect(mockGatewayClient.on).toHaveBeenCalledWith('session.import.progress', onProgress);
    expect(mockGatewayClient.importExecute).toHaveBeenCalledWith({ engineType: 'claude', sessions: [] });
    expect(mockGatewayClient.off).toHaveBeenCalledWith('session.import.progress', onProgress);
  });

  it('importExecute works without progress handler', async () => {
    await gateway.importExecute('claude' as any, []);
    expect(mockGatewayClient.on).not.toHaveBeenCalledWith('session.import.progress', expect.anything());
  });

  // --- Scheduled Tasks ---

  it('listScheduledTasks delegates', async () => {
    await gateway.listScheduledTasks();
    expect(mockGatewayClient.listScheduledTasks).toHaveBeenCalled();
  });

  it('createScheduledTask delegates', async () => {
    const req = { name: 'task1' } as any;
    await gateway.createScheduledTask(req);
    expect(mockGatewayClient.createScheduledTask).toHaveBeenCalledWith(req);
  });

  it('deleteScheduledTask delegates', async () => {
    await gateway.deleteScheduledTask('t1');
    expect(mockGatewayClient.deleteScheduledTask).toHaveBeenCalledWith('t1');
  });

  it('runScheduledTaskNow delegates', async () => {
    await gateway.runScheduledTaskNow('t1');
    expect(mockGatewayClient.runScheduledTaskNow).toHaveBeenCalledWith('t1');
  });

  // --- Worktree ---

  it('createWorktree delegates via request', async () => {
    await gateway.createWorktree('/dir', { name: 'wt1' });
    expect(mockGatewayClient.request).toHaveBeenCalledWith('worktree.create', {
      directory: '/dir',
      name: 'wt1',
      baseBranch: undefined,
    });
  });

  it('listWorktrees delegates via request', async () => {
    await gateway.listWorktrees('/dir');
    expect(mockGatewayClient.request).toHaveBeenCalledWith('worktree.list', { directory: '/dir' });
  });

  it('removeWorktree delegates via request', async () => {
    await gateway.removeWorktree('/dir', 'wt1');
    expect(mockGatewayClient.request).toHaveBeenCalledWith('worktree.remove', { directory: '/dir', worktreeName: 'wt1' });
  });

  it('mergeWorktree delegates via request', async () => {
    await gateway.mergeWorktree('/dir', 'wt1', { mode: 'squash' });
    expect(mockGatewayClient.request).toHaveBeenCalledWith('worktree.merge', {
      directory: '/dir',
      worktreeName: 'wt1',
      targetBranch: undefined,
      mode: 'squash',
      message: undefined,
    });
  });

  it('listBranches delegates via request', async () => {
    await gateway.listBranches('/dir');
    expect(mockGatewayClient.request).toHaveBeenCalledWith('worktree.listBranches', { directory: '/dir' });
  });
});
