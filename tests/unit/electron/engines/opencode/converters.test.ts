import { describe, it, expect } from 'vitest';
import { 
  convertSession, 
  convertMessage, 
  convertPart, 
  convertProviders 
} from '../../../../../electron/main/engines/opencode/converters';
import type { EngineType } from '../../../../../src/types/unified';

const ENGINE_TYPE: EngineType = 'opencode';

describe('OpenCode Converters', () => {
  describe('convertSession', () => {
    it('converts SDK session to UnifiedSession and handles path normalization', () => {
      const sdkSession = {
        id: 'session-123',
        directory: 'C:\\Users\\test\\project',
        title: 'Test Session',
        parentID: 'parent-456',
        projectID: 'project-789',
        slug: 'test-slug',
        version: '1.0.0',
        summary: 'A test session summary',
        share: { enabled: true, url: 'https://share.link' },
        time: {
          created: 1000000,
          updated: 1000100,
          compacting: 1000050
        }
      };

      const unified = convertSession(ENGINE_TYPE, sdkSession as any);

      expect(unified).toEqual({
        id: 'session-123',
        engineType: ENGINE_TYPE,
        directory: 'C:/Users/test/project',
        title: 'Test Session',
        parentId: 'parent-456',
        projectId: 'project-789',
        time: {
          created: 1000000,
          updated: 1000100,
        },
        engineMeta: {
          slug: 'test-slug',
          projectID: 'project-789',
          version: '1.0.0',
          compacting: 1000050,
          summary: 'A test session summary',
          share: { enabled: true, url: 'https://share.link' },
        },
      });

      const unixSession = {
        id: 's1',
        directory: '/home/user/project',
        time: { created: 1, updated: 2 }
      };
      const unifiedUnix = convertSession(ENGINE_TYPE, unixSession as any);
      expect(unifiedUnix.directory).toBe('/home/user/project');
    });
  });

  describe('convertMessage', () => {
    it('converts SDK message with various states (full, minimal, compaction)', () => {
      const sdkMessage = {
        id: 'msg-1',
        sessionID: 'sess-1',
        role: 'assistant',
        time: {
          created: 1000,
          completed: 1100
        },
        parts: [
          { type: 'text', text: 'Hello' },
          null,
          { type: 'reasoning', text: 'Thinking...' }
        ],
        tokens: { input: 10, output: 20 },
        cost: 0.05,
        modelID: 'gpt-4',
        providerID: 'openai',
        mode: 'chat',
        path: { cwd: '/work' },
        agent: 'coder',
        system: 'You are an assistant',
        summary: false
      };

      const unified = convertMessage(ENGINE_TYPE, sdkMessage);

      expect(unified.id).toBe('msg-1');
      expect(unified.role).toBe('assistant');
      expect(unified.parts).toHaveLength(2);
      expect(unified.parts[0].type).toBe('text');
      expect(unified.parts[1].type).toBe('reasoning');
      expect(unified.tokens).toEqual({ input: 10, output: 20 });
      expect(unified.cost).toBe(0.05);
      expect(unified.workingDirectory).toBe('/work');
      expect(unified.isCompaction).toBe(false);
      expect(unified.engineMeta).toMatchObject({
        agent: 'coder',
        system: 'You are an assistant'
      });

      const minimalMsg = {
        id: 'min-1',
        sessionID: 's1',
        role: 'user'
      };
      const unifiedMinimal = convertMessage(ENGINE_TYPE, minimalMsg);
      expect(unifiedMinimal.time.created).toBeDefined();
      expect(unifiedMinimal.parts).toEqual([]);

      const compactionMsg = {
        id: 'c1',
        summary: true,
        time: { created: 1 }
      };
      expect(convertMessage(ENGINE_TYPE, compactionMsg).isCompaction).toBe(true);
    });

    it('normalizes various error formats including MessageAbortedError', () => {
      const msgWithError = {
        id: 'm1',
        error: 'Some error',
        time: { created: 1 }
      };
      expect(convertMessage(ENGINE_TYPE, msgWithError).error).toBe('Some error');

      const msgWithAbortStr = {
        id: 'm2',
        error: 'MessageAbortedError',
        time: { created: 1 }
      };
      expect(convertMessage(ENGINE_TYPE, msgWithAbortStr).error).toBe('Cancelled');

      const msgWithAbortObj = {
        id: 'm3',
        error: { name: 'MessageAbortedError' },
        time: { created: 1 }
      };
      expect(convertMessage(ENGINE_TYPE, msgWithAbortObj).error).toBe('Cancelled');
      
      const msgWithErrorObj = {
        id: 'm4',
        error: { message: 'Custom Error' },
        time: { created: 1 }
      };
      expect(convertMessage(ENGINE_TYPE, msgWithErrorObj).error).toBe('Custom Error');

      // Rate limit wrapped in MessageAbortedError should preserve the real message
      const msgWithAbortWrappedError = {
        id: 'm5',
        error: { name: 'MessageAbortedError', message: 'Too Many Requests: Sorry, you\'ve exceeded your rate limits.' },
        time: { created: 1 }
      };
      expect(convertMessage(ENGINE_TYPE, msgWithAbortWrappedError).error).toBe('Too Many Requests: Sorry, you\'ve exceeded your rate limits.');
    });
  });

  describe('convertPart', () => {
    const baseSdk = { id: 'p1', messageID: 'm1', sessionID: 's1' };
    const baseUnified = { id: 'p1', messageId: 'm1', sessionId: 's1' };

    it.each([
      ['text', { type: 'text', text: 'hi', synthetic: true }, { type: 'text', text: 'hi', synthetic: true }],
      ['reasoning', { type: 'reasoning', text: 'logic' }, { type: 'reasoning', text: 'logic' }],
      ['file', { type: 'file', mime: 'image/png', filename: 'img.png', url: 'blob:...' }, { type: 'file', mime: 'image/png', filename: 'img.png', url: 'blob:...' }],
      ['step-start', { type: 'step-start' }, { type: 'step-start' }],
      ['step-finish', { type: 'step-finish' }, { type: 'step-finish' }],
      ['snapshot', { type: 'snapshot', snapshot: 'hash123' }, { type: 'snapshot', files: ['hash123'] }],
      ['patch', { type: 'patch', hash: 'diff-content', files: ['file.ts'] }, { type: 'patch', content: 'diff-content', path: 'file.ts' }],
    ])('converts %s parts correctly', (_, sdkExtra, expectedExtra) => {
      const sdk = { ...baseSdk, ...sdkExtra };
      expect(convertPart(ENGINE_TYPE, sdk as any)).toEqual({ ...baseUnified, ...expectedExtra });
    });

    it('converts tool parts with all lifecycle states', () => {
      const baseTool = { ...baseSdk, type: 'tool', callID: 'call-1', tool: 'bash' };

      const pending = convertPart(ENGINE_TYPE, { ...baseTool, state: { status: 'pending', input: 'ls' } } as any);
      expect(pending.type).toBe('tool');
      if (pending.type === 'tool') {
        expect(pending.normalizedTool).toBe('shell');
        expect(pending.state.status).toBe('pending');
      }

      const running = convertPart(ENGINE_TYPE, { 
        ...baseTool, 
        state: { status: 'running', input: 'ls', time: { start: 100 } } 
      } as any);
      if (running.type === 'tool') {
        expect(running.state.status).toBe('running');
        expect((running.state as any).time.start).toBe(100);
      }

      const completed = convertPart(ENGINE_TYPE, { 
        ...baseTool, 
        state: { 
          status: 'completed', 
          input: 'ls', 
          output: 'file.txt',
          title: 'Listing files',
          time: { start: 100, end: 150 },
          metadata: { foo: 'bar' }
        } 
      } as any);
      if (completed.type === 'tool') {
        expect(completed.state.status).toBe('completed');
        expect((completed.state as any).title).toBe('Listing files');
        expect((completed.state as any).time.duration).toBe(50);
        expect((completed.state as any).metadata).toEqual({ foo: 'bar' });
      }

      const error = convertPart(ENGINE_TYPE, { 
        ...baseTool, 
        state: { 
          status: 'error', 
          input: 'ls', 
          error: 'Failed',
          time: { start: 100, end: 110 }
        } 
      } as any);
      if (error.type === 'tool') {
        expect(error.state.status).toBe('error');
        expect((error.state as any).error).toBe('Failed');
        expect((error.state as any).time.duration).toBe(10);
      }
    });

    it('falls back to text for unknown part types', () => {
      const sdk = { ...baseSdk, type: 'future-type' };
      const unified = convertPart(ENGINE_TYPE, sdk as any);
      expect(unified.type).toBe('text');
      expect((unified as any).text).toBe('[future-type]');
      expect(unified.messageId).toBe('m1');
    });
  });

  describe('convertProviders', () => {
    it('converts connected providers and their models, handling missing cost or connectivity', () => {
      const response = {
        all: [
          {
            id: 'p1',
            name: 'Provider 1',
            models: {
              'm1': {
                id: 'm1',
                name: 'Model 1',
                family: 'GPT',
                cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 0.8 },
                temperature: true,
                reasoning: false,
                attachment: true,
                tool_call: true,
                status: 'online',
                release_date: '2023-01-01',
                limit: { tpd: 1000 }
              }
            }
          },
          {
            id: 'p2',
            name: 'Disconnected',
            models: { 'm2': { id: 'm2', name: 'Model 2' } }
          }
        ],
        connected: ['p1']
      };

      const models = convertProviders(ENGINE_TYPE, response as any);

      expect(models).toHaveLength(1);
      expect(models[0]).toEqual({
        modelId: 'p1/m1',
        name: 'Model 1',
        description: 'GPT (Provider 1)',
        engineType: ENGINE_TYPE,
        providerId: 'p1',
        providerName: 'Provider 1',
        cost: {
          input: 1,
          output: 2,
          cache: { read: 0.5, write: 0.8 }
        },
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: true,
          toolcall: true
        },
        meta: {
          status: 'online',
          releaseDate: '2023-01-01',
          limits: { tpd: 1000 }
        }
      });

      const responseNoCost = {
        all: [{ id: 'p1', name: 'P1', models: { 'm1': { id: 'm1', name: 'M1' } } }],
        connected: ['p1']
      };
      expect(convertProviders(ENGINE_TYPE, responseNoCost as any)[0].cost).toBeUndefined();

      const responseNoConnected = {
        all: [{ id: 'p1', models: {} }],
        connected: []
      };
      expect(convertProviders(ENGINE_TYPE, responseNoConnected as any)).toEqual([]);
    });
  });
});
