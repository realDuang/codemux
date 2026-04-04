import { describe, it, expect } from 'vitest';
import {
  convertEventsToMessages,
  createUserMessage,
  buildToolTitle,
  normalizeTodoInput,
  normalizeTodoStatus,
  upsertPart,
  sdkModelToUnified,
  metadataToSession,
} from '../../../../../electron/main/engines/copilot/converters';
import type { SessionEvent, ModelInfo, SessionMetadata } from '@github/copilot-sdk';
import type { UnifiedPart, TextPart, ToolPart, EngineType } from '../../../../../src/types/unified';

describe('copilot-converters', () => {
  const sessionId = 'test-session';
  const timestamp = '2025-01-01T00:00:00Z';
  const tsMs = new Date(timestamp).getTime();

  const mockBase = {
    id: 'evt-1',
    timestamp,
    parentId: null,
  };

  describe('convertEventsToMessages', () => {
    it('converts basic message sequence and extracts summary from task_complete', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'user.message',
          data: { content: 'hello' },
        } as any,
        {
          ...mockBase,
          type: 'assistant.message_delta',
          data: { messageId: 'm1', deltaContent: 'hi ' },
        } as any,
        {
          ...mockBase,
          type: 'assistant.message_delta',
          data: { messageId: 'm1', deltaContent: 'there' },
        } as any,
        {
          ...mockBase,
          type: 'tool.execution_start',
          data: { toolCallId: 'call1', toolName: 'task_complete', arguments: { summary: 'Task finished successfully' } },
        } as any,
      ];

      const messages = convertEventsToMessages(sessionId, events);

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect((messages[0].parts[0] as TextPart).text).toBe('hello');
      expect(messages[1].role).toBe('assistant');
      // task_complete summary is appended to textAccum, so it's concatenated with prior text
      expect((messages[1].parts[0] as TextPart).text).toBe('hi thereTask finished successfully');
      expect(messages[1].parts.find(p => p.type === 'tool')).toBeUndefined();
    });

    it('handles reasoning deltas and tool calls', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'assistant.reasoning_delta',
          data: { reasoningId: 'r1', deltaContent: 'thinking...' },
        } as any,
        {
          ...mockBase,
          type: 'tool.execution_start',
          data: { toolCallId: 'call1', toolName: 'ls', arguments: { path: '.' } },
        } as any,
        {
          ...mockBase,
          type: 'tool.execution_complete',
          data: { toolCallId: 'call1', success: true, result: { content: 'file.txt' } },
        } as any,
        {
          ...mockBase,
          type: 'assistant.message',
          data: { messageId: 'm1', content: 'done' },
        } as any,
      ];

      const messages = convertEventsToMessages(sessionId, events);

      expect(messages).toHaveLength(1);
      const parts = messages[0].parts;
      expect(parts).toHaveLength(3);
      
      expect(parts[0].type).toBe('tool'); 
      expect(parts[1].type).toBe('text');
      expect(parts[2].type).toBe('reasoning');

      expect((parts[2] as any).text).toBe('thinking...');
      const toolPart = parts[0] as ToolPart;
      expect(toolPart.originalTool).toBe('ls');
      expect(toolPart.state.status).toBe('completed');
      if (toolPart.state.status === 'completed') {
        expect(toolPart.state.output).toBe('file.txt');
      }
      expect((parts[1] as TextPart).text).toBe('done');
    });

    it('processes usage events and tool execution failures', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'assistant.message',
          data: { messageId: 'm1', content: 'hi' },
        } as any,
        {
          ...mockBase,
          ephemeral: true,
          type: 'assistant.usage',
          data: {
            model: 'gpt-4',
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 5,
            cost: 0.001,
          },
        } as any,
        {
          ...mockBase,
          type: 'tool.execution_start',
          data: { toolCallId: 'call-fail', toolName: 'shell', arguments: { command: 'false' } },
        } as any,
        {
          ...mockBase,
          type: 'tool.execution_complete',
          data: { toolCallId: 'call-fail', success: false, error: 'Command failed' },
        } as any,
      ];

      const messages = convertEventsToMessages(sessionId, events);

      expect(messages).toHaveLength(1);
      const msg = messages[0];
      expect(msg.modelId).toBe('gpt-4');
      expect(msg.tokens?.input).toBe(10);
      expect(msg.tokens?.output).toBe(20);
      expect(msg.tokens?.cache?.read).toBe(5);
      expect(msg.cost).toBe(0.001);
      expect(msg.costUnit).toBe("premium_requests");

      const toolPart = msg.parts.find(p => p.type === 'tool' && (p as ToolPart).callId === 'call-fail') as ToolPart;
      expect(toolPart).toBeDefined();
      expect(toolPart.state.status).toBe('error');
      if (toolPart.state.status === 'error') {
        expect(toolPart.state.error).toBe('Command failed');
      }
    });
  });

  describe('createUserMessage', () => {
    it('creates a valid user message', () => {
      const msg = createUserMessage(sessionId, 'hello', tsMs);
      expect(msg.role).toBe('user');
      expect(msg.sessionId).toBe(sessionId);
      expect(msg.time.created).toBe(tsMs);
      expect(msg.parts).toHaveLength(1);
      expect(msg.parts[0].type).toBe('text');
      expect((msg.parts[0] as TextPart).text).toBe('hello');
    });
  });

  describe('buildToolTitle', () => {
    it.each([
      ['shell', 'shell', { command: 'ls -la' }, 'ls -la'],
      ['shell', 'shell', { command: 'a'.repeat(100) }, 'a'.repeat(57) + '...'],
      ['read', 'read', { path: '/foo.txt' }, 'Reading /foo.txt'],
      ['write', 'write', { file_path: '/bar.txt' }, 'Writing /bar.txt'],
      ['grep', 'grep', { pattern: 'search' }, 'Searching for "search"'],
      ['glob', 'glob', { pattern: '*.ts' }, 'Finding files matching *.ts'],
      ['web_fetch', 'web_fetch', { url: 'https://example.com' }, 'Fetching https://example.com'],
      ['task', 'task', { description: 'Do something' }, 'Do something'],
      ['todo', 'todo', {}, 'Updating todos'],
      ['other', 'unknown' as any, {}, 'other'],
    ])('builds title for %s', (original, normalized, args, expected) => {
      expect(buildToolTitle(original, normalized as any, args)).toBe(expected);
    });
  });

  describe('normalizeTodoInput', () => {
    it('normalizes markdown todo string or returns original if invalid', () => {
      const inputValid = { todos: '- [ ] task 1\n- [x] task 2' };
      const normalizedValid = normalizeTodoInput(inputValid);
      expect(normalizedValid.todos).toEqual([
        { content: 'task 1', status: 'pending' },
        { content: 'task 2', status: 'completed' },
      ]);

      const inputInvalid = { todos: 'just text' };
      expect(normalizeTodoInput(inputInvalid)).toBe(inputInvalid);
    });
  });

  describe('normalizeTodoStatus', () => {
    it.each([
      ['in_progress', 'in_progress'],
      ['done', 'completed'],
      ['completed', 'completed'],
      ['pending', 'pending'],
      ['anything', 'pending'],
    ])('normalizes %s to %s', (input, expected) => {
      expect(normalizeTodoStatus(input)).toBe(expected);
    });
  });

  describe('upsertPart', () => {
    it('inserts a new part or updates an existing one', () => {
      const parts: UnifiedPart[] = [];
      const part1: TextPart = { id: 'p1', messageId: 'm1', sessionId: 's1', type: 'text', text: 'hi' };
      upsertPart(parts, part1);
      expect(parts).toEqual([part1]);

      const part1Updated: TextPart = { ...part1, text: 'hello' };
      upsertPart(parts, part1Updated);
      expect(parts).toHaveLength(1);
      expect((parts[0] as TextPart).text).toBe('hello');
    });
  });

  describe('sdkModelToUnified', () => {
    it('converts SDK model info to unified format', () => {
      const engineType: EngineType = 'copilot';
      const sdkModel: ModelInfo = {
        id: 'gpt-4',
        name: 'GPT-4',
        capabilities: {
          supports: {
            vision: true,
            reasoningEffort: true,
          } as any,
          limits: {
            max_context_window_tokens: 128000,
          },
        },
      } as any;

      const unified = sdkModelToUnified(engineType, sdkModel);
      expect(unified.modelId).toBe('gpt-4');
      expect(unified.name).toBe('GPT-4');
      expect(unified.engineType).toBe(engineType);
      expect(unified.capabilities?.attachment).toBe(true);
      expect(unified.capabilities?.reasoning).toBe(true);
      expect(unified.meta?.maxContextTokens).toBe(128000);
    });

    it('maps supportedReasoningEfforts with xhigh → max', () => {
      const sdkModel: ModelInfo = {
        id: 'o3',
        name: 'O3',
        capabilities: { supports: { vision: false, reasoningEffort: true } as any, limits: { max_context_window_tokens: 200000 } },
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] as any,
        defaultReasoningEffort: 'high' as any,
      } as any;

      const unified = sdkModelToUnified('copilot', sdkModel);
      expect(unified.capabilities?.supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'max']);
      expect(unified.capabilities?.defaultReasoningEffort).toBe('high');
    });

    it('maps defaultReasoningEffort xhigh → max', () => {
      const sdkModel: ModelInfo = {
        id: 'o3-max',
        name: 'O3 Max',
        capabilities: { supports: { vision: false, reasoningEffort: true } as any, limits: { max_context_window_tokens: 200000 } },
        supportedReasoningEfforts: ['high', 'xhigh'] as any,
        defaultReasoningEffort: 'xhigh' as any,
      } as any;

      const unified = sdkModelToUnified('copilot', sdkModel);
      expect(unified.capabilities?.supportedReasoningEfforts).toEqual(['high', 'max']);
      expect(unified.capabilities?.defaultReasoningEffort).toBe('max');
    });

    it('returns undefined reasoning efforts when model has no reasoning support', () => {
      const sdkModel: ModelInfo = {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        capabilities: { supports: { vision: true } as any, limits: { max_context_window_tokens: 128000 } },
      } as any;

      const unified = sdkModelToUnified('copilot', sdkModel);
      expect(unified.capabilities?.reasoning).toBe(false);
      expect(unified.capabilities?.supportedReasoningEfforts).toBeUndefined();
      expect(unified.capabilities?.defaultReasoningEffort).toBeUndefined();
    });

    it('does not expose reasoning support when the SDK reports reasoningEffort: false', () => {
      const sdkModel: ModelInfo = {
        id: 'gpt-4o',
        name: 'GPT-4o',
        capabilities: { supports: { vision: true, reasoningEffort: false }, limits: { max_context_window_tokens: 128000 } },
        supportedReasoningEfforts: ['low', 'medium'] as any,
        defaultReasoningEffort: 'medium' as any,
      } as any;

      const unified = sdkModelToUnified('copilot', sdkModel);
      expect(unified.capabilities?.reasoning).toBe(false);
      expect(unified.capabilities?.supportedReasoningEfforts).toBeUndefined();
      expect(unified.capabilities?.defaultReasoningEffort).toBeUndefined();
    });

    it('filters invalid reasoning effort values from Copilot model metadata', () => {
      const sdkModel: ModelInfo = {
        id: 'o3-filtered',
        name: 'O3 Filtered',
        capabilities: { supports: { vision: false, reasoningEffort: true } as any, limits: { max_context_window_tokens: 200000 } },
        supportedReasoningEfforts: ['low', 'turbo', 'xhigh'] as any,
        defaultReasoningEffort: 'turbo' as any,
      } as any;

      const unified = sdkModelToUnified('copilot', sdkModel);
      expect(unified.capabilities?.supportedReasoningEfforts).toEqual(['low', 'max']);
      expect(unified.capabilities?.defaultReasoningEffort).toBeUndefined();
    });
  });

  describe('metadataToSession', () => {
    it('converts session metadata to unified session and handles missing directory', () => {
      const engineType: EngineType = 'copilot';
      const meta: SessionMetadata = {
        sessionId: 's1',
        summary: 'Test Session',
        startTime: new Date('2025-01-01T00:00:00Z'),
        modifiedTime: new Date('2025-01-01T01:00:00Z'),
        isRemote: false,
        context: {
          cwd: 'C:\\Users\\test\\project',
          repository: 'repo',
          branch: 'main',
          gitRoot: '/git',
        },
      } as any;

      const session = metadataToSession(engineType, meta);
      expect(session.id).toBe('s1');
      expect(session.title).toBe('Test Session');
      expect(session.directory).toBe('C:/Users/test/project');
      expect(session.time.created).toBe(new Date('2025-01-01T00:00:00Z').getTime());
      expect(session.engineMeta?.repository).toBe('repo');

      const metaNoDir: SessionMetadata = {
        sessionId: 's2',
        startTime: new Date(),
        modifiedTime: new Date(),
        context: {},
      } as any;
      const sessionNoDir = metadataToSession('copilot', metaNoDir);
      expect(sessionNoDir.directory).toBeDefined();
      expect(sessionNoDir.directory).not.toBe('');
    });
  });
});
