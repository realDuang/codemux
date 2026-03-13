import { describe, it, expect } from 'vitest';
import { buildGroupWelcomeCard } from '../../../../../electron/main/channels/feishu/feishu-card-builder';

describe('buildGroupWelcomeCard', () => {
  it('returns valid JSON string with session and project info', () => {
    const projectName = 'Test Project';
    const engineType = 'opencode' as any;
    const sessionId = 'abcdef-123456-7890';
    
    const result = buildGroupWelcomeCard(projectName, engineType, sessionId);
    const card = JSON.parse(result);
    
    expect(card.header.title.content).toBe('CodeMux 会话');
    expect(card.header.template).toBe('green');
    
    const content = card.elements[0].text.content;
    expect(content).toContain(`**项目:** ${projectName}`);
    expect(content).toContain(`**引擎:** ${engineType}`);
    expect(content).toContain(`**会话:** ${sessionId}`);
    expect(content).toContain('/cancel');
    expect(content).toContain('/help');
  });
});
