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
    ['Summarize mock project metadata...', 'Summarize mock project metadata: inspect the sample manifest…', true],
    ['Summarize mock project metadata: inspect the sample manifest', 'Summarize mock project metadata: inspect the sample manifest…', true],
    ['Summarize mock project metadata', 'Summarize mock project metadata: inspect the sample manifest…', false],
    ['Fix sample parser', 'Fix sample parser and add tests for the regression…', false],
    ['Review Sample Upload Integration', 'Please review the sample upload integration changes…', false],
    ['Retrieve Mock Session Title', 'How can a mock engine expose a generated conversation title?', false],
    ['', 'First prompt', false],
    ['Title', undefined, false],
  ])('isPromptFallbackTitle("%s", "%s") returns %s', (title, firstPrompt, expected) => {
    expect(isPromptFallbackTitle(title, firstPrompt)).toBe(expected);
  });
});
