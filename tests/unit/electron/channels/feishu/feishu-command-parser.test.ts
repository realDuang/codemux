import { describe, it, expect } from 'vitest';
import {
  parseCommand,
  buildHelpText,
  buildGroupHelpText,
  buildProjectListText,
  buildSessionListText,
  buildQuestionText,
  buildHistoryEntries,
} from '../../../../../electron/main/channels/feishu/feishu-command-parser';

describe('parseCommand', () => {
  it('returns null for non-command text', () => {
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand('  not a command')).toBeNull();
  });

  it('returns null for empty or whitespace-only commands', () => {
    expect(parseCommand('/')).toBeNull();
    expect(parseCommand('/   ')).toBeNull();
  });

  it.each([
    ['/help', { command: 'help', args: [], raw: '/help' }],
    ['  /HELP  ', { command: 'help', args: [], raw: '/HELP' }],
    ['/model claude-3', { command: 'model', args: ['claude-3'], raw: '/model claude-3' }],
  ])('parses simple commands: %s', (input, expected) => {
    const result = parseCommand(input);
    expect(result).toMatchObject(expected);
  });

  it.each([
    ['/project list', 'project', 'list', []],
    ['/session switch abc', 'session', 'switch', ['abc']],
    ['/engine list', 'engine', 'list', []],
    ['/model list', 'model', 'list', []],
  ])('parses known subcommands: %s', (input, cmd, sub, args) => {
    const result = parseCommand(input);
    expect(result).toMatchObject({
      command: cmd,
      subcommand: sub,
      args: args,
    });
  });

  it('treats unknown subcommands as regular arguments', () => {
    const result = parseCommand('/project unknown-arg');
    expect(result).toMatchObject({
      command: 'project',
      args: ['unknown-arg'],
    });
    // Ensure subcommand is not present in result
    expect(result).not.toHaveProperty('subcommand');
  });
});

describe('buildHelpText', () => {
  it('returns direct message help text with key references', () => {
    const text = buildHelpText();
    expect(text).toContain('/project');
    expect(text).toContain('/help');
    expect(text).toContain('私聊命令');
  });
});

describe('buildGroupHelpText', () => {
  it('returns group session help text with specific commands', () => {
    const text = buildGroupHelpText();
    expect(text).toContain('/cancel');
    expect(text).toContain('/status');
    expect(text).toContain('/mode');
    expect(text).toContain('/model');
    expect(text).toContain('/history');
    expect(text).toContain('会话命令');
  });
});

describe('buildProjectListText', () => {
  it('returns "not found" message for empty projects', () => {
    expect(buildProjectListText([])).toContain('未找到项目');
  });

  it('lists projects with sequential numbering', () => {
    const projects: any[] = [
      { name: 'P1', directory: '/d1' },
      { name: 'P2', directory: '/d2' },
    ];
    const text = buildProjectListText(projects);
    expect(text).toContain('1. P1');
    expect(text).toContain('2. P2');
    expect(text).toContain('回复数字');
  });
});

describe('buildSessionListText', () => {
  it('shows "new" option even for empty sessions', () => {
    const text = buildSessionListText([], 'Test Project');
    expect(text).toContain('Test Project');
    expect(text).toContain('new');
    expect(text).not.toContain('已有会话');
  });

  it('shows sorted sessions limited to 9', () => {
    const sessions: any[] = Array.from({ length: 12 }, (_, i) => ({
      id: `id-${i}`,
      title: `Session ${i}`,
      time: { updated: i * 1000 },
    }));
    const text = buildSessionListText(sessions, 'P');
    
    // Most recent first: Session 11
    expect(text).toContain('1. Session 11');
    // Limited to 9 items
    expect(text).toContain('9. Session 3');
    expect(text).not.toContain('10. Session 2');
  });
});

describe('buildQuestionText', () => {
  it('returns numbered options for agent questions', () => {
    const options = [
      { id: '1', label: 'Option A' },
      { id: '2', label: 'Option B' },
    ];
    const text = buildQuestionText('What to do?', options);
    expect(text).toContain('What to do?');
    expect(text).toContain('1. Option A');
    expect(text).toContain('2. Option B');
    expect(text).toContain('回复消息以回答');
  });
});

describe('buildHistoryEntries', () => {
  it('returns empty array for no messages', () => {
    expect(buildHistoryEntries([])).toEqual([]);
  });

  it('shows user messages with 👤 and assistant messages with 🤖', () => {
    const messages: any[] = [
      { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Hi there!' }] },
    ];
    const entries = buildHistoryEntries(messages);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ emoji: '👤', text: 'Hello' });
    expect(entries[1]).toEqual({ emoji: '🤖', text: 'Hi there!' });
  });

  it('skips non-text parts like tool and step parts', () => {
    const messages: any[] = [
      { role: 'assistant', parts: [{ type: 'tool', normalizedTool: 'shell' }, { type: 'text', text: 'Done' }] },
    ];
    const entries = buildHistoryEntries(messages);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ emoji: '🤖', text: 'Done' });
  });

  it('skips messages with no text content', () => {
    const messages: any[] = [
      { role: 'assistant', parts: [{ type: 'tool', normalizedTool: 'edit' }] },
    ];
    const entries = buildHistoryEntries(messages);
    expect(entries).toEqual([]);
  });

  it('truncates long messages', () => {
    const longText = 'x'.repeat(600);
    const messages: any[] = [
      { role: 'user', parts: [{ type: 'text', text: longText }] },
    ];
    const entries = buildHistoryEntries(messages);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toContain('...');
    expect(entries[0].text.length).toBeLessThan(longText.length);
  });
});
