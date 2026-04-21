import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGatewayClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  connected: true,
  listEngines: vi.fn().mockResolvedValue([]),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  listSessions: vi.fn().mockResolvedValue([]),
  createSession: vi.fn().mockResolvedValue({ id: 's1' }),
  getSession: vi.fn().mockResolvedValue({ id: 's1' }),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  renameSession: vi.fn().mockResolvedValue(undefined),
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
  createOrchestrationRun: vi.fn().mockResolvedValue({ id: 'team-1' }),
  cancelOrchestrationRun: vi.fn().mockResolvedValue(undefined),
  sendOrchestrationMessage: vi.fn().mockResolvedValue(undefined),
  listOrchestrationRuns: vi.fn().mockResolvedValue([]),
  getOrchestrationRun: vi.fn().mockResolvedValue(null),
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
const { gateway } = await import('../../../../src/lib/gateway-api');

describe('GatewayAPI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset initialized state by calling destroy
    gateway.destroy();
    vi.clearAllMocks(); // clear the disconnect/off calls from destroy
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
    vi.clearAllMocks();
    gateway.destroy();
    expect(gateway.isInitialized).toBe(false);
    expect(mockGatewayClient.disconnect).toHaveBeenCalledOnce();
  });

  // --- connected getter ---

  it('connected delegates to gatewayClient.connected', () => {
    expect(gateway.connected).toBe(true);
  });

  // --- Delegation methods ---

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

  it('cancelMessage delegates', async () => {
    await gateway.cancelMessage('s1');
    expect(mockGatewayClient.cancelMessage).toHaveBeenCalledWith('s1');
  });

  it('listMessages delegates', async () => {
    await gateway.listMessages('s1');
    expect(mockGatewayClient.listMessages).toHaveBeenCalledWith('s1');
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

  // --- Orchestration ---

  it('createOrchestration delegates', async () => {
    const req = {
      sessionId: 'sess-1',
      prompt: 'Investigate issue',
      mode: 'heavy',
      directory: '/repo',
      engineType: 'claude',
    } as any;

    await gateway.createOrchestration(req);

    expect(mockGatewayClient.createOrchestrationRun).toHaveBeenCalledWith(req);
  });

  it('cancelOrchestration delegates', async () => {
    await gateway.cancelOrchestration('team-1');
    expect(mockGatewayClient.cancelOrchestrationRun).toHaveBeenCalledWith('team-1');
  });

  it('sendOrchestrationMessage delegates', async () => {
    await gateway.sendOrchestrationMessage('team-1', 'Need a tighter plan');
    expect(mockGatewayClient.sendOrchestrationMessage).toHaveBeenCalledWith('team-1', 'Need a tighter plan');
  });

  it('listOrchestrations delegates', async () => {
    await gateway.listOrchestrations();
    expect(mockGatewayClient.listOrchestrationRuns).toHaveBeenCalled();
  });

  it('getOrchestration delegates', async () => {
    await gateway.getOrchestration('team-1');
    expect(mockGatewayClient.getOrchestrationRun).toHaveBeenCalledWith('team-1');
  });

  it('binds orchestration notifications to the provided handlers', async () => {
    const onOrchestrationUpdated = vi.fn();
    const onOrchestrationSubtaskUpdated = vi.fn();
    const run = { id: 'team-1' } as any;
    const subtask = { id: 'task-1' } as any;

    await gateway.init({ onOrchestrationUpdated, onOrchestrationSubtaskUpdated });

    const runHandler = mockGatewayClient.on.mock.calls.find(
      ([event]) => event === 'orchestration.updated',
    )?.[1];
    const subtaskHandler = mockGatewayClient.on.mock.calls.find(
      ([event]) => event === 'orchestration.subtask.updated',
    )?.[1];

    expect(runHandler).toBeTypeOf('function');
    expect(subtaskHandler).toBeTypeOf('function');

    runHandler?.({ run });
    subtaskHandler?.({ runId: 'team-1', subtask });

    expect(onOrchestrationUpdated).toHaveBeenCalledWith(run);
    expect(onOrchestrationSubtaskUpdated).toHaveBeenCalledWith('team-1', subtask);
  });
});
