import { describe, it, expect } from 'vitest';
import {
  buildFinalReplyCard,
  buildGroupWelcomeCard,
} from '../../../../../electron/main/channels/feishu/feishu-card-builder';

describe('buildFinalReplyCard', () => {
  it('returns a markdown interactive card with default title', () => {
    const card = JSON.parse(buildFinalReplyCard('**hello**'));

    expect(card.config.wide_screen_mode).toBe(true);
    expect(card.header.title.content).toBe('CodeMux');
    expect(card.header.template).toBe('blue');
    expect(card.elements[0]).toEqual({ tag: 'markdown', content: '**hello**' });
  });

  it('uses custom title when provided', () => {
    const card = JSON.parse(buildFinalReplyCard('content', undefined, 'Custom Title'));
    expect(card.header.title.content).toBe('Custom Title');
  });

  it('adds tool summary as a note after a divider', () => {
    const card = JSON.parse(buildFinalReplyCard('content', 'used 2 tools'));

    expect(card.elements[1]).toEqual({ tag: 'hr' });
    expect(card.elements[2]).toEqual({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: 'used 2 tools' }],
    });
  });

  it('truncates oversized content and appends a notice', () => {
    const long = '长'.repeat(20_000);
    const card = JSON.parse(buildFinalReplyCard(long));
    const content = card.elements[0].content;

    expect(content.length).toBeLessThan(long.length);
    expect(content).toContain('内容已截断');
  });
});

describe('buildGroupWelcomeCard', () => {
  it('returns valid JSON string with session and project info', () => {
    const projectName = 'Test Project';
    const engineType = 'opencode' as any;
    const sessionId = 'abcdef-123456-7890';

    const result = buildGroupWelcomeCard(projectName, engineType, sessionId);
    const card = JSON.parse(result);

    expect(card.header.title.content).toBe('CodeMux 会话');
    expect(card.header.template).toBe('green');

    const content = card.elements[0].content;
    expect(content).toContain(`**项目:** ${projectName}`);
    expect(content).toContain(`**引擎:** ${engineType}`);
    expect(content).toContain(`**会话:** ${sessionId}`);
    expect(content).toContain('/cancel');
    expect(content).toContain('/mode list / /mode mode-id');
    expect(content).toContain('/model list / /model model-id');
    expect(content).toContain('/effort list / /effort low|medium|high|max');
    expect(content).toContain('/help');
  });
});
