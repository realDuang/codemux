import { describe, it, expect } from 'vitest';
import { sdkSessionToUnified, convertSdkMessages } from '../../electron/main/engines/claude/converters';
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";

describe('Claude Converters', () => {
  describe('sdkSessionToUnified', () => {
    it('converts full SDK session info to unified session', () => {
      const sdkSession: SDKSessionInfo = {
        sessionId: 'test-uuid',
        lastModified: 1710000000000,
        fileSize: 1024,
        customTitle: 'Custom Title',
        summary: 'Session Summary',
        firstPrompt: 'Hello Claude',
        gitBranch: 'main',
        cwd: 'C:\\Users\\test\\project'
      };

      const result = sdkSessionToUnified('claude', sdkSession);

      expect(result).toEqual({
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
    });

    it('handles minimal SDK session info with defaults', () => {
      const sdkSession: SDKSessionInfo = {
        sessionId: 'test-uuid',
        lastModified: 1710000000000,
        fileSize: 1024,
        summary: 'Session Summary'
      };

      const result = sdkSessionToUnified('claude', sdkSession, '/default/path');

      expect(result.directory).toBe('/default/path');
      expect(result.title).toBe('Session Summary');
    });

    it('falls back to firstPrompt or Untitled for title', () => {
       const sdkSession1: SDKSessionInfo = {
        sessionId: '1',
        lastModified: 1,
        fileSize: 1,
        firstPrompt: 'Prompt text that is quite long and should be sliced if it exceeds one hundred characters of length for sure'
      } as any;
      const result1 = sdkSessionToUnified('claude', sdkSession1);
      expect(result1.title).toBe('Prompt text that is quite long and should be sliced if it exceeds one hundred characters of length for sure'.slice(0, 100));

      const sdkSession2: SDKSessionInfo = {
        sessionId: '2',
        lastModified: 1,
        fileSize: 1,
        summary: 'Summary Text'
      } as any;
      const result2 = sdkSessionToUnified('claude', sdkSession2);
      expect(result2.title).toBe('Summary Text');

      const sdkSession3: SDKSessionInfo = {
        sessionId: '3',
        lastModified: 1,
        fileSize: 1
      } as any;
      const result3 = sdkSessionToUnified('claude', sdkSession3);
      expect(result3.title).toBe('Untitled');
    });
  });

  describe('convertSdkMessages', () => {
    const sessionId = 'test-session';

    it('converts simple text messages (user & assistant)', () => {
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
        }
      ];

      const timestamps = new Map([
        ['u1', 1000],
        ['a1', 2000]
      ]);

      const result = convertSdkMessages(sdkMessages, sessionId, timestamps);

      expect(result).toHaveLength(2);
      
      // User message
      expect(result[0].role).toBe('user');
      expect(result[0].id).toBe('u1');
      expect(result[0].time.created).toBe(1000);
      expect(result[0].parts[0]).toMatchObject({ type: 'text', text: 'Hello' });

      // Assistant message
      expect(result[1].role).toBe('assistant');
      expect(result[1].id).toBe('a1');
      expect(result[1].time.created).toBe(2000);
      expect(result[1].parts[0]).toMatchObject({ type: 'text', text: 'Hi there' });
    });

    it('converts complex assistant message with thinking and tool use', () => {
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

      expect(assistantMsg.parts).toHaveLength(5); // reasoning, text, step-start, tool, step-finish
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
      // Duration: u2 timestamp (8000) - a1 timestamp (5000) = 3000
      expect((toolPart as any).state.time).toEqual({
        start: 5000,
        end: 8000,
        duration: 3000
      });

      expect(assistantMsg.parts[4].type).toBe('step-finish');
      
      // Assistant completion time should match next message timestamp
      expect(assistantMsg.time.completed).toBe(8000);
    });

    it('handles user messages with array content', () => {
        const sdkMessages = [
            {
                type: 'user',
                uuid: 'u1',
                message: {
                    content: [
                        { type: 'text', text: 'Part 1' },
                        { type: 'text', text: 'Part 2' }
                    ]
                }
            }
        ];
        const result = convertSdkMessages(sdkMessages, sessionId);
        expect(result[0].parts).toHaveLength(2);
        expect(result[0].parts[0]).toMatchObject({ text: 'Part 1' });
        expect(result[0].parts[1]).toMatchObject({ text: 'Part 2' });
    });

    it('gracefully handles missing timestamps and UUIDs', () => {
      const sdkMessages = [
        {
          type: 'user',
          message: { content: 'No UUID' }
        }
      ];

      const result = convertSdkMessages(sdkMessages, sessionId);

      expect(result).toHaveLength(1);
      expect(result[0].id).toMatch(/^msg_/);
      expect(result[0].time.created).toBeLessThanOrEqual(Date.now());
      expect(result[0].parts[0].id).toMatch(/^pt_/);
    });

    it('ignores unknown message types and empty parts', () => {
       const sdkMessages = [
        { type: 'system', uuid: 's1', message: { content: 'ignore me' } },
        { type: 'user', uuid: 'u1', message: { content: [] } } // Empty content array results in no parts
      ];
      
      const result = convertSdkMessages(sdkMessages, sessionId);
      expect(result).toHaveLength(0);
    });

    it('calculates 0 duration if tool result user message is missing or earlier', () => {
        const sdkMessages = [
            {
                type: 'assistant',
                uuid: 'a1',
                message: { content: [{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: {} }] }
            }
        ];
        const timestamps = new Map([['a1', 1000]]);
        const result = convertSdkMessages(sdkMessages, sessionId, timestamps);
        const toolPart = result[0].parts[1] as any;
        expect(toolPart.state.time.duration).toBe(0);
        expect(toolPart.state.time.end).toBe(1000);
    });

    it('handles assistant message as the last message (no completion timestamp from next)', () => {
        const sdkMessages = [
            {
                type: 'assistant',
                uuid: 'a1',
                message: { content: [{ type: 'text', text: 'End' }] }
            }
        ];
        const timestamps = new Map([['a1', 1000]]);
        const result = convertSdkMessages(sdkMessages, sessionId, timestamps);
        expect(result[0].time.completed).toBe(1000);
    });

    it('handles tool result in user message without UUID or timestamp', () => {
        const sdkMessages = [
            {
                type: 'user',
                message: {
                    content: [
                        { type: 'tool_result', tool_use_id: 'tool_1', content: 'res' }
                    ]
                }
            }
        ];
        // This should not crash and should not populate toolResultTimestamps for others
        const result = convertSdkMessages(sdkMessages, sessionId);
        expect(result).toHaveLength(0); // tool_result only is filtered out by user msg logic
    });

    it.each([
      ['empty content array', [], 0],
      ['only unknown content block', [{ type: 'unknown' }], 0],
      ['text and unknown block', [{ type: 'text', text: 'hi' }, { type: 'unknown' }], 1],
    ])('user message content analysis: %s', (_, content, expectedParts) => {
      const sdkMessages = [{ type: 'user', uuid: 'u1', message: { content } }];
      const result = convertSdkMessages(sdkMessages, sessionId);
      expect(result.length > 0 ? result[0].parts : []).toHaveLength(expectedParts);
    });

    it('assistant message content variations', () => {
      const sdkMessages = [
        {
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [
              { type: 'text', text: 'Text' },
              { type: 'thinking', thinking: 'Thought' },
              { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
              { type: 'unknown', data: '???' }
            ]
          }
        }
      ];
      const result = convertSdkMessages(sdkMessages, sessionId);
      const parts = result[0].parts;
      expect(parts).toHaveLength(5); // text, reasoning, step-start, tool, step-finish
      expect(parts[0]).toMatchObject({ type: 'text', text: 'Text' });
      expect(parts[1]).toMatchObject({ type: 'reasoning', text: 'Thought' });
      expect(parts[3]).toMatchObject({ type: 'tool', callId: 't1', originalTool: 'Bash' });
    });

    it('tool duration with multiple tools and interleaved messages', () => {
      const sdkMessages = [
        {
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [
              { type: 'tool_use', id: 'tool_1', name: 'Bash', input: {} },
              { type: 'tool_use', id: 'tool_2', name: 'Read', input: {} }
            ]
          }
        },
        {
          type: 'user',
          uuid: 'u2',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tool_1', content: 'out1' },
              { type: 'tool_result', tool_use_id: 'tool_2', content: 'out2' }
            ]
          }
        }
      ];
      const timestamps = new Map([
        ['a1', 1000],
        ['u2', 2500]
      ]);
      const result = convertSdkMessages(sdkMessages, sessionId, timestamps);
      const assistantMsg = result[0];
      
      const tool1 = assistantMsg.parts.find(p => p.type === 'tool' && p.callId === 'tool_1') as any;
      const tool2 = assistantMsg.parts.find(p => p.type === 'tool' && p.callId === 'tool_2') as any;
      
      expect(tool1.state.time.duration).toBe(1500);
      expect(tool2.state.time.duration).toBe(1500);
    });

    it('handles assistant message with missing content property', () => {
      const sdkMessages = [
        { type: 'assistant', uuid: 'a1', message: {} }
      ];
      const result = convertSdkMessages(sdkMessages, sessionId);
      expect(result).toHaveLength(0);
    });
  });
});
