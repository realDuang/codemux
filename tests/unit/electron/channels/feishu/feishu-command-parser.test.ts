import { describe, it, expect } from 'vitest';
import {
  parseCommand,
  buildHelpText,
  buildGroupHelpText,
  buildProjectListText,
  buildSessionListText,
  buildQuestionText,
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
    expect(text).toContain('会话命令');
  });
});

describe('buildProjectListText', () => {
  it('returns "not found" message for empty projects', () => {
    expect(buildProjectListText([])).toContain('未找到项目');
  });

  it('groups projects by engine type with numbering', () => {
    const projects: any[] = [
      { name: 'P1', engineType: 'opencode', directory: '/d1' },
      { name: 'P2', engineType: 'feishu', directory: '/d2' },
    ];
    const text = buildProjectListText(projects);
    expect(text).toContain('[OPENCODE]');
    expect(text).toContain('1. P1');
    expect(text).toContain('[FEISHU]');
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
    expect(text).toContain('回复数字');
  });
});
