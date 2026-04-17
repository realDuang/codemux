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

    // --- Branch coverage additions ---

    it('handles session.idle event finalizing the current assistant message', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'assistant.message_delta',
          data: { deltaContent: 'partial response' },
        } as any,
        {
          ...mockBase,
          type: 'session.idle',
        } as any,
        {
          ...mockBase,
          type: 'user.message',
          data: { content: 'follow up' },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('assistant');
      expect((messages[0].parts[0] as TextPart).text).toBe('partial response');
      expect(messages[1].role).toBe('user');
    });

    it('ignores session.title_changed event without creating messages', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'user.message',
          data: { content: 'hello' },
        } as any,
        {
          ...mockBase,
          type: 'session.title_changed',
          data: { title: 'A New Title' },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
    });

    it('ignores unknown event types (default switch case)', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'some.unknown.event.type',
          data: {},
        } as any,
        {
          ...mockBase,
          type: 'user.message',
          data: { content: 'hi' },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
    });

    it('handles user.message with undefined content, falling back to empty string', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'user.message',
          data: {},
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      expect(messages).toHaveLength(1);
      expect((messages[0].parts[0] as TextPart).text).toBe('');
    });

    it('ignores assistant.message with empty/falsy content', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'assistant.message',
          data: { content: '' },
        } as any,
        {
          ...mockBase,
          type: 'assistant.message',
          data: {},
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      expect(messages).toHaveLength(0);
    });

    it('ignores assistant.message content when textAccum is already populated', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'assistant.message_delta',
          data: { deltaContent: 'delta content' },
        } as any,
        {
          ...mockBase,
          type: 'assistant.message',
          data: { content: 'should be ignored because textAccum is set' },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      expect(messages).toHaveLength(1);
      const textPart = messages[0].parts.find(p => p.type === 'text') as TextPart;
      expect(textPart?.text).toBe('delta content');
    });

    it('does not set textPartId in assistant.message when already set by a prior empty delta', () => {
      // Empty delta sets textPartId but leaves textAccum empty, so assistant.message can fill
      // textAccum, but the existing textPartId is reused (the if(!textPartId) branch is false)
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'assistant.message_delta',
          data: { deltaContent: '' },
        } as any,
        {
          ...mockBase,
          type: 'assistant.message',
          data: { content: 'hello from message event' },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      expect(messages).toHaveLength(1);
      const textPart = messages[0].parts.find(p => p.type === 'text') as TextPart;
      expect(textPart?.text).toBe('hello from message event');
    });

    it('skips task_complete when summary is absent', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'tool.execution_start',
          data: { toolCallId: 'tc1', toolName: 'task_complete', arguments: {} },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      expect(messages).toHaveLength(0);
    });

    it('skips task_complete when summary is a non-string value', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'tool.execution_start',
          data: { toolCallId: 'tc2', toolName: 'task_complete', arguments: { summary: 42 } },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      expect(messages).toHaveLength(0);
    });

    it('includes task_complete textPartId from a prior empty delta (textPartId already set)', () => {
      // Ensures the if(!textPartId) branch inside task_complete is false
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'assistant.message_delta',
          data: { deltaContent: '' },
        } as any,
        {
          ...mockBase,
          type: 'tool.execution_start',
          data: { toolCallId: 'tc3', toolName: 'task_complete', arguments: { summary: 'done!' } },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      expect(messages).toHaveLength(1);
      const textPart = messages[0].parts.find(p => p.type === 'text') as TextPart;
      expect(textPart?.text).toBe('done!');
    });

    it('ignores tool.execution_complete for an unknown callId', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'user.message',
          data: { content: 'start' },
        } as any,
        {
          ...mockBase,
          type: 'tool.execution_complete',
          data: { toolCallId: 'nonexistent-id', success: true, result: { content: 'ok' } },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
    });

    it('sets diff on tool part when detailedContent is present in execution result', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'tool.execution_start',
          data: { toolCallId: 'c1', toolName: 'write', arguments: { path: '/file.txt' } },
        } as any,
        {
          ...mockBase,
          type: 'tool.execution_complete',
          data: {
            toolCallId: 'c1',
            success: true,
            result: { content: 'written', detailedContent: 'diff: +new line' },
          },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      const toolPart = messages[0].parts.find(p => p.type === 'tool') as ToolPart;
      expect(toolPart.diff).toBe('diff: +new line');
    });

    it('uses "Failed" as default error message when error field is missing', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'tool.execution_start',
          data: { toolCallId: 'c2', toolName: 'shell', arguments: { command: 'fail' } },
        } as any,
        {
          ...mockBase,
          type: 'tool.execution_complete',
          data: { toolCallId: 'c2', success: false },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      const toolPart = messages[0].parts.find(p => p.type === 'tool') as ToolPart;
      expect(toolPart.state.status).toBe('error');
      if (toolPart.state.status === 'error') {
        expect(toolPart.state.error).toBe('Failed');
      }
    });

    it('produces empty output string when tool completes with no result content', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'tool.execution_start',
          data: { toolCallId: 'c3', toolName: 'shell', arguments: { command: 'noop' } },
        } as any,
        {
          ...mockBase,
          type: 'tool.execution_complete',
          data: { toolCallId: 'c3', success: true },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      const toolPart = messages[0].parts.find(p => p.type === 'tool') as ToolPart;
      expect(toolPart.state.status).toBe('completed');
      if (toolPart.state.status === 'completed') {
        expect(toolPart.state.output).toBe('');
      }
    });

    it('handles tool.execution_start with no arguments (uses empty object fallback)', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'tool.execution_start',
          data: { toolCallId: 'c4', toolName: 'shell' },
        } as any,
        {
          ...mockBase,
          type: 'tool.execution_complete',
          data: { toolCallId: 'c4', success: true },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      const toolPart = messages[0].parts.find(p => p.type === 'tool') as ToolPart;
      expect(toolPart).toBeDefined();
      if (toolPart.state.status === 'completed') {
        expect(toolPart.state.input).toEqual({});
      }
    });

    it('handles usage event without cache tokens, cost, or model', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'assistant.message',
          data: { content: 'hello' },
        } as any,
        {
          ...mockBase,
          type: 'assistant.usage',
          data: { inputTokens: 5, outputTokens: 3 },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      const msg = messages[0];
      expect(msg.tokens?.cache).toBeUndefined();
      expect(msg.cost).toBeUndefined();
      expect(msg.modelId).toBeUndefined();
    });

    it('handles usage event with only cacheWriteTokens, producing a cache entry', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'assistant.message',
          data: { content: 'hello' },
        } as any,
        {
          ...mockBase,
          type: 'assistant.usage',
          data: { cacheWriteTokens: 7 },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      expect(messages[0].tokens?.cache).toEqual({ read: 0, write: 7 });
    });

    it('accumulates multiple reasoning deltas into a single reasoning part', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'assistant.reasoning_delta',
          data: { deltaContent: 'first ' },
        } as any,
        {
          ...mockBase,
          type: 'assistant.reasoning_delta',
          data: { deltaContent: 'second' },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      expect(messages).toHaveLength(1);
      const reasoningPart = messages[0].parts.find(p => p.type === 'reasoning');
      expect((reasoningPart as any)?.text).toBe('first second');
    });

    it('falls back to Date.now() when event timestamp is invalid', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          timestamp: 'not-a-valid-date',
          type: 'user.message',
          data: { content: 'hi' },
        } as any,
      ];
      const before = Date.now();
      const messages = convertEventsToMessages(sessionId, events);
      const after = Date.now();
      expect(messages[0].time.created).toBeGreaterThanOrEqual(before);
      expect(messages[0].time.created).toBeLessThanOrEqual(after);
    });

    it('handles multiple interleaved user and assistant messages', () => {
      const events: SessionEvent[] = [
        {
          ...mockBase,
          type: 'user.message',
          data: { content: 'first question' },
        } as any,
        {
          ...mockBase,
          type: 'assistant.message_delta',
          data: { deltaContent: 'first answer' },
        } as any,
        {
          ...mockBase,
          type: 'user.message',
          data: { content: 'second question' },
        } as any,
        {
          ...mockBase,
          type: 'assistant.message_delta',
          data: { deltaContent: 'second answer' },
        } as any,
      ];
      const messages = convertEventsToMessages(sessionId, events);
      expect(messages).toHaveLength(4);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
      expect(messages[2].role).toBe('user');
      expect(messages[3].role).toBe('assistant');
    });

    it('produces no messages from an empty events array', () => {
      const messages = convertEventsToMessages(sessionId, []);
      expect(messages).toHaveLength(0);
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

    // --- Branch coverage additions ---

    it('builds "Editing <path>" for the edit case with path key', () => {
      expect(buildToolTitle('edit_file', 'edit', { path: '/src/main.ts' })).toBe('Editing /src/main.ts');
    });

    it('builds "Editing <path>" for the edit case with file_path key', () => {
      expect(buildToolTitle('edit_file', 'edit', { file_path: '/src/other.ts' })).toBe('Editing /src/other.ts');
    });

    it('builds "Editing file" for the edit case with no path', () => {
      expect(buildToolTitle('edit_file', 'edit', {})).toBe('Editing file');
    });

    it('builds "Listing files" for the list case', () => {
      expect(buildToolTitle('list_files', 'list', {})).toBe('Listing files');
    });

    it('builds "Running command" for shell with empty command string', () => {
      expect(buildToolTitle('shell', 'shell', { command: '' })).toBe('Running command');
    });

    it('builds "Running command" for shell with no command key', () => {
      expect(buildToolTitle('shell', 'shell', {})).toBe('Running command');
    });

    it('builds "Reading <path>" for read using file_path key', () => {
      expect(buildToolTitle('read_file', 'read', { file_path: '/via-file_path.txt' })).toBe('Reading /via-file_path.txt');
    });

    it('builds "Reading file" for read with no path keys', () => {
      expect(buildToolTitle('read_file', 'read', {})).toBe('Reading file');
    });

    it('builds "Writing <path>" for write using file_path key', () => {
      expect(buildToolTitle('write_file', 'write', { file_path: '/output.txt' })).toBe('Writing /output.txt');
    });

    it('builds "Writing file" for write with no path keys', () => {
      expect(buildToolTitle('write_file', 'write', {})).toBe('Writing file');
    });

    it('builds grep title using the query key as fallback to pattern', () => {
      expect(buildToolTitle('grep', 'grep', { query: 'search term' })).toBe('Searching for "search term"');
    });

    it('builds "Searching" for grep with no pattern or query', () => {
      expect(buildToolTitle('grep', 'grep', {})).toBe('Searching');
    });

    it('builds "Finding files" for glob with no pattern', () => {
      expect(buildToolTitle('glob', 'glob', {})).toBe('Finding files');
    });

    it('builds "Fetching URL" for web_fetch with no url', () => {
      expect(buildToolTitle('web_fetch', 'web_fetch', {})).toBe('Fetching URL');
    });

    it('builds "Running task" for task with no description', () => {
      expect(buildToolTitle('task', 'task', {})).toBe('Running task');
    });

    it('treats null args as empty input object', () => {
      expect(buildToolTitle('shell', 'shell', null)).toBe('Running command');
      expect(buildToolTitle('other', 'unknown' as any, null)).toBe('other');
    });

    it('treats non-object args (e.g. a string) as empty input object', () => {
      expect(buildToolTitle('read', 'read', 'not-an-object' as any)).toBe('Reading file');
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

    // --- Branch coverage additions ---

    it('returns empty object when args is null', () => {
      const result = normalizeTodoInput(null);
      expect(result).toEqual({});
    });

    it('returns empty object when args is undefined', () => {
      const result = normalizeTodoInput(undefined);
      expect(result).toEqual({});
    });

    it('returns input unchanged when todos value is not a string', () => {
      const input = { todos: [{ content: 'already an array', status: 'pending' }] };
      expect(normalizeTodoInput(input)).toBe(input);
    });

    it('returns input unchanged when todos is a number', () => {
      const input = { todos: 42 };
      expect(normalizeTodoInput(input as any)).toBe(input);
    });

    it('handles uppercase [X] checkbox as completed status', () => {
      const input = { todos: '- [X] uppercase done' };
      const result = normalizeTodoInput(input);
      expect(result.todos).toEqual([{ content: 'uppercase done', status: 'completed' }]);
    });

    it('returns input unchanged when todos string matches outer regex but has no valid content lines', () => {
      // "- [ ]" passes the outer /[-*]\s*\[[ xX]\]/ test but the per-line
      // regex /^[-*]\s*\[([ xX])\]\s+(.+)/ requires content after ], so todos array stays empty
      const input = { todos: '- [ ]' };
      const result = normalizeTodoInput(input);
      expect(result).toBe(input);
    });

    it('skips lines without content in otherwise valid todo string', () => {
      const input = { todos: '- [ ] valid task\n- [ ]\n- [x] another valid' };
      const result = normalizeTodoInput(input);
      expect(result.todos).toEqual([
        { content: 'valid task', status: 'pending' },
        { content: 'another valid', status: 'completed' },
      ]);
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

    // --- Branch coverage additions ---

    it('handles model without any capabilities object', () => {
      const sdkModel = { id: 'basic', name: 'Basic Model' } as ModelInfo;
      const unified = sdkModelToUnified('copilot', sdkModel);
      expect(unified.modelId).toBe('basic');
      expect(unified.capabilities?.reasoning).toBe(false);
      expect(unified.capabilities?.attachment).toBe(false);
      expect(unified.meta?.maxContextTokens).toBeUndefined();
    });

    it('returns undefined supportedReasoningEfforts when reasoning is supported but no levels are provided', () => {
      const sdkModel = {
        id: 'o3-no-levels',
        name: 'O3 No Levels',
        capabilities: {
          supports: { reasoningEffort: true } as any,
          limits: {},
        },
        // supportedReasoningEfforts intentionally omitted
      } as any;
      const unified = sdkModelToUnified('copilot', sdkModel);
      expect(unified.capabilities?.reasoning).toBe(true);
      expect(unified.capabilities?.supportedReasoningEfforts).toBeUndefined();
    });

    it('returns undefined supportedReasoningEfforts when all effort values are unrecognized', () => {
      const sdkModel = {
        id: 'o3-all-invalid',
        name: 'O3 All Invalid',
        capabilities: {
          supports: { reasoningEffort: true } as any,
          limits: {},
        },
        supportedReasoningEfforts: ['turbo', 'blazing_fast'] as any,
        defaultReasoningEffort: 'turbo' as any,
      } as any;
      const unified = sdkModelToUnified('copilot', sdkModel);
      expect(unified.capabilities?.supportedReasoningEfforts).toBeUndefined();
      expect(unified.capabilities?.defaultReasoningEffort).toBeUndefined();
    });

    it('returns undefined defaultReasoningEffort when it is not provided (non-string value)', () => {
      const sdkModel = {
        id: 'o3-no-default',
        name: 'O3 No Default',
        capabilities: {
          supports: { reasoningEffort: true } as any,
          limits: {},
        },
        supportedReasoningEfforts: ['low', 'high'] as any,
        // defaultReasoningEffort intentionally omitted → undefined → non-string
      } as any;
      const unified = sdkModelToUnified('copilot', sdkModel);
      expect(unified.capabilities?.defaultReasoningEffort).toBeUndefined();
      expect(unified.capabilities?.supportedReasoningEfforts).toEqual(['low', 'high']);
    });

    it('handles model with no vision support (attachment: false)', () => {
      const sdkModel = {
        id: 'text-only',
        name: 'Text Only',
        capabilities: {
          supports: { vision: false, reasoningEffort: false },
          limits: { max_context_window_tokens: 4096 },
        },
      } as any;
      const unified = sdkModelToUnified('copilot', sdkModel);
      expect(unified.capabilities?.attachment).toBe(false);
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

    // --- Branch coverage additions ---

    it('falls back to homedir when context has no cwd property', () => {
      const meta = {
        sessionId: 's3',
        summary: 'No cwd',
        startTime: new Date('2025-03-01'),
        modifiedTime: new Date('2025-03-02'),
        isRemote: true,
        context: { repository: 'my-repo', branch: 'dev' },
      } as any;
      const session = metadataToSession('copilot', meta);
      expect(session.directory).toBeTruthy();
      expect(session.engineMeta?.repository).toBe('my-repo');
      expect(session.engineMeta?.branch).toBe('dev');
    });

    it('handles metadata with no context property at all (short-circuits optional chains)', () => {
      const meta = {
        sessionId: 's4',
        summary: 'No context',
        startTime: new Date('2025-04-01'),
        modifiedTime: new Date('2025-04-02'),
        isRemote: false,
        // context is entirely absent
      } as any;
      const session = metadataToSession('copilot', meta);
      expect(session.id).toBe('s4');
      expect(session.directory).toBeTruthy(); // homedir() fallback
      expect(session.engineMeta?.repository).toBeUndefined();
      expect(session.engineMeta?.branch).toBeUndefined();
      expect(session.engineMeta?.gitRoot).toBeUndefined();
    });

    it('normalizes Windows backslash paths in cwd to forward slashes', () => {
      const meta = {
        sessionId: 's5',
        summary: 'Windows path',
        startTime: new Date('2025-05-01'),
        modifiedTime: new Date('2025-05-02'),
        isRemote: false,
        context: { cwd: 'D:\\Projects\\my-app\\src' },
      } as any;
      const session = metadataToSession('copilot', meta);
      expect(session.directory).toBe('D:/Projects/my-app/src');
    });
  });
});
