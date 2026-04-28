import { describe, it, expect } from 'vitest';
import { isDefaultTitle, isPromptFallbackTitle } from '../../../../src/lib/session-utils';

describe('isDefaultTitle', () => {
  it.each([
    ['New session - 2024-01-01T00:00:00.000Z', true],
    ['Child session - 2024-12-31T23:59:59.999Z', true],
    ['New session - 2026-03-10T15:30:00.123Z', true],
    ['', false],
    ['My custom title', false],
    ['New session - ', false],
    ['New session - 2024-01-01', false],
    ['new session - 2024-01-01T00:00:00.000Z', false],  // lowercase
    ['New session - 2024-01-01T00:00:00.000Z extra text', false],
    ['Old session - 2024-01-01T00:00:00.000Z', false],  // wrong prefix
  ])('isDefaultTitle("%s") returns %s', (input, expected) => {
    expect(isDefaultTitle(input)).toBe(expected);
  });
});

describe('isPromptFallbackTitle', () => {
  it.each([
    ['Explain Promise.all', 'Explain Promise.all', true],
    ['Read this repository metadata only...', 'Read this repository metadata only: inspect package.json…', true],
    ['Read this repository metadata only: inspect package.json', 'Read this repository metadata only: inspect package.json…', true],
    ['Read this repository metadata only', 'Read this repository metadata only: inspect package.json…', false],
    ['Fix bug', 'Fix bug in parser and add tests for the regression…', false],
    ['Review PicGo Integration', '看看目前修改区，应该是加了 picgo 的支持…', false],
    ['Retrieve Copilot Session Title', '你知道你的 copilot sdk 里如何获取到一个 session 的由 copilot引擎 summary 出来的标题吗', false],
    ['', 'First prompt', false],
    ['Title', undefined, false],
  ])('isPromptFallbackTitle("%s", "%s") returns %s', (title, firstPrompt, expected) => {
    expect(isPromptFallbackTitle(title, firstPrompt)).toBe(expected);
  });
});
