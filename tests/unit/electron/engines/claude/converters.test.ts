import { describe, it, expect } from 'vitest';
import { sdkSessionToUnified, convertSdkMessages } from '../../../../../electron/main/engines/claude/converters';
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";

describe('Claude Converters', () => {
  describe('sdkSessionToUnified', () => {
    it('converts SDK session info with full data, defaults, and title fallbacks', () => {
      // Full session conversion
      const sdkSessionFull: SDKSessionInfo = {
        sessionId: 'test-uuid',
        lastModified: 1710000000000,
        fileSize: 1024,
        customTitle: 'Custom Title',
        summary: 'Session Summary',
        firstPrompt: 'Hello Claude',
        gitBranch: 'main',
        cwd: 'C:\\Users\\test\\project'
      };

      const resultFull = sdkSessionToUnified('claude', sdkSessionFull);

      expect(resultFull).toEqual({
        id: 'cc_test-uuid',
        engineType: 'claude',
        directory: 'C:/Users/test/project',
        title: 'Custom Title',
        time: {
          created: 1710000000000,
          updated: 1710000000000,
        },
        engineMeta: {
          ccSessionId: 'test-uuid',
          gitBranch: 'main',
        },
      });

      // Minimal session with defaults
      const sdkSessionMin: SDKSessionInfo = {
        sessionId: 'test-uuid-min',
        lastModified: 1710000000000,
        fileSize: 1024,
        summary: 'Session Summary'
      };
      const resultMin = sdkSessionToUnified('claude', sdkSessionMin, '/default/path');
      expect(resultMin.directory).toBe('/default/path');
      expect(resultMin.title).toBe('Session Summary');

      // Title fallbacks
      const sdkSessionPrompt: SDKSessionInfo = {
        sessionId: '1',
        lastModified: 1,
        fileSize: 1,
        firstPrompt: 'Prompt text that is quite long and should be sliced if it exceeds one hundred characters of length for sure'
      } as any;
      expect(sdkSessionToUnified('claude', sdkSessionPrompt).title).toBe('Prompt text that is quite long and should be sliced if it exceeds one hundred characters of length for sure'.slice(0, 100));

      const sdkSessionSummary: SDKSessionInfo = {
        sessionId: '2',
        lastModified: 1,
        fileSize: 1,
        summary: 'Summary Text'
      } as any;
      expect(sdkSessionToUnified('claude', sdkSessionSummary).title).toBe('Summary Text');

      const sdkSessionNone: SDKSessionInfo = {
        sessionId: '3',
        lastModified: 1,
        fileSize: 1
      } as any;
      expect(sdkSessionToUnified('claude', sdkSessionNone).title).toBe('Untitled');
    });
  });

  describe('convertSdkMessages', () => {
    const sessionId = 'test-session';

    it('converts user and assistant text messages with array content and missing metadata', () => {
      const sdkMessages = [
        {
          type: 'user',
          uuid: 'u1',
          message: { content: 'Hello' }
        },
        {
          type: 'assistant',
          uuid: 'a1',
          message: { content: [{ type: 'text', text: 'Hi there' }] }
        },
        {
          type: 'user',
          uuid: 'u2',
          message: {
            content: [
              { type: 'text', text: 'Part 1' },
              { type: 'text', text: 'Part 2' }
            ]
          }
        },
        {
          type: 'user',
          message: { content: 'No UUID' }
        }
      ];

      const timestamps = new Map([
        ['u1', 1000],
        ['a1', 2000],
        ['u2', 3000]
      ]);

      const result = convertSdkMessages(sdkMessages, sessionId, timestamps);

      expect(result).toHaveLength(4);
      expect(result[0].role).toBe('user');
      expect(result[0].parts[0]).toMatchObject({ type: 'text', text: 'Hello' });
      expect(result[1].parts[0]).toMatchObject({ type: 'text', text: 'Hi there' });
      expect(result[2].parts).toHaveLength(2);
      expect(result[3].id).toMatch(/^msg_/);
      expect(result[3].time.created).toBeLessThanOrEqual(Date.now());
    });

    it('converts complex assistant message with thinking and tool use lifecycle', () => {
      const sdkMessages = [
        {
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [
              { type: 'thinking', thinking: 'I should list files' },
              { type: 'text', text: 'Listing files...' },
              { type: 'tool_use', id: 'tool_1', name: 'Glob', input: { pattern: '*.ts' } }
            ]
          }
        },
        {
            type: 'user',
            uuid: 'u2',
            message: {
                content: [
                    { type: 'tool_result', tool_use_id: 'tool_1', content: 'file1.ts' }
                ]
            }
        }
      ];

      const timestamps = new Map([
        ['a1', 5000],
        ['u2', 8000]
      ]);

      const result = convertSdkMessages(sdkMessages, sessionId, timestamps);
      const assistantMsg = result[0];

      expect(assistantMsg.parts).toHaveLength(5);
      expect(assistantMsg.parts[0]).toMatchObject({ type: 'reasoning', text: 'I should list files' });
      expect(assistantMsg.parts[1]).toMatchObject({ type: 'text', text: 'Listing files...' });
      expect(assistantMsg.parts[2].type).toBe('step-start');
      
      const toolPart = assistantMsg.parts[3];
      expect(toolPart).toMatchObject({
        type: 'tool',
        callId: 'tool_1',
        normalizedTool: 'glob',
        originalTool: 'Glob'
      });
      expect((toolPart as any).state.time).toEqual({
        start: 5000,
        end: 8000,
        duration: 3000
      });

      expect(assistantMsg.parts[4].type).toBe('step-finish');
      expect(assistantMsg.time.completed).toBe(8000);
    });

    it('filters out unknown types, empty parts, or invalid tool results', () => {
       const sdkMessages = [
        { type: 'system', uuid: 's1', message: { content: 'ignore me' } },
        { type: 'user', uuid: 'u1', message: { content: [] } },
        { type: 'assistant', uuid: 'a2', message: {} },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'res' }]
          }
        }
      ];
      
      const result = convertSdkMessages(sdkMessages, sessionId);
      expect(result).toHaveLength(0);
    });

    it('handles edge cases for tool duration and message completion', () => {
        // Missing tool result or earlier timestamp
        const sdkMsgNoResult = [
            {
                type: 'assistant',
                uuid: 'a1',
                message: { content: [{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: {} }] }
            }
        ];
        const resultNoResult = convertSdkMessages(sdkMsgNoResult, sessionId, new Map([['a1', 1000]]));
        const toolPart = resultNoResult[0].parts[1] as any;
        expect(toolPart.state.time.duration).toBe(0);
        expect(toolPart.state.time.end).toBe(1000);

        // Assistant message as the last message
        const sdkMsgLast = [
            {
                type: 'assistant',
                uuid: 'a1',
                message: { content: [{ type: 'text', text: 'End' }] }
            }
        ];
        const resultLast = convertSdkMessages(sdkMsgLast, sessionId, new Map([['a1', 1000]]));
        expect(resultLast[0].time.completed).toBe(1000);
    });

    it.each([
      ['empty content array', [], 0],
      ['only unknown content block', [{ type: 'unknown' }], 0],
      ['text and unknown block', [{ type: 'text', text: 'hi' }, { type: 'unknown' }], 1],
    ])('analyzes user message content variations: %s', (_, content, expectedParts) => {
      const sdkMessages = [{ type: 'user', uuid: 'u1', message: { content } }];
      const result = convertSdkMessages(sdkMessages, sessionId);
      expect(result.length > 0 ? result[0].parts : []).toHaveLength(expectedParts);
    });

    it('processes assistant message content variations and tool durations for multiple tools', () => {
      const sdkMessages = [
        {
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [
              { type: 'text', text: 'Text' },
              { type: 'thinking', thinking: 'Thought' },
              { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
              { type: 'tool_use', id: 't2', name: 'Read', input: {} },
              { type: 'unknown', data: '???' }
            ]
          }
        },
        {
          type: 'user',
          uuid: 'u2',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'out1' },
              { type: 'tool_result', tool_use_id: 't2', content: 'out2' }
            ]
          }
        }
      ];
      const timestamps = new Map([['a1', 1000], ['u2', 2500]]);
      const result = convertSdkMessages(sdkMessages, sessionId, timestamps);
      
      const assistantMsg = result[0];
      expect(assistantMsg.parts).toHaveLength(8); // text + reasoning + (step-start + tool + step-finish) * 2
      expect(assistantMsg.parts[0]).toMatchObject({ type: 'text', text: 'Text' });
      expect(assistantMsg.parts[1]).toMatchObject({ type: 'reasoning', text: 'Thought' });
      
      const tool1 = assistantMsg.parts.find(p => p.type === 'tool' && p.callId === 't1') as any;
      const tool2 = assistantMsg.parts.find(p => p.type === 'tool' && p.callId === 't2') as any;
      expect(tool1.state.time.duration).toBe(1500);
      expect(tool2.state.time.duration).toBe(1500);
    });
  });
});
