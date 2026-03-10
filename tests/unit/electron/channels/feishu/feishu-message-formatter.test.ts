import { describe, it, expect } from 'vitest';
import {
  formatToolSummaryFromCounts,
  truncateForFeishu,
  formatStreamingText,
} from '../../../../../electron/main/channels/feishu/feishu-message-formatter';

describe('formatToolSummaryFromCounts', () => {
  it('returns empty string for empty map', () => {
    expect(formatToolSummaryFromCounts(new Map())).toBe("");
  });

  it('returns summary for a single tool', () => {
    const counts = new Map([['shell', 2]]);
    const result = formatToolSummaryFromCounts(counts);
    expect(result).toContain('执行了 2 个操作');
    expect(result).toContain('Shell(2)');
  });

  it('returns summary for multiple tools', () => {
    const counts = new Map([
      ['shell', 2],
      ['edit', 1],
    ]);
    const result = formatToolSummaryFromCounts(counts);
    expect(result).toContain('执行了 3 个操作');
    expect(result).toContain('Shell(2)');
    expect(result).toContain('Edit(1)');
  });
});

describe('truncateForFeishu', () => {
  it('returns unchanged text if under limit', () => {
    const text = 'short message';
    expect(truncateForFeishu(text, 50)).toBe(text);
  });

  it('truncates text with notice if over limit', () => {
    // A string of 1000 'a's
    const text = 'a'.repeat(1000);
    // Setting a very small limit like 100 will force truncation
    const result = truncateForFeishu(text, 100);
    expect(result).toContain('内容已截断');
    expect(result.length).toBeLessThan(text.length);
  });

  it('handles multi-byte characters correctly', () => {
    const text = '你好，这是一个中文消息，需要被截断。';
    // Small limit to force truncation
    const result = truncateForFeishu(text, 20);
    expect(result).toContain('内容已截断');
    // Ensure it doesn't crash on multi-byte split
  });
});

describe('formatStreamingText', () => {
  it('returns Thinking... for empty buffer', () => {
    expect(formatStreamingText("")).toBe("Thinking...");
  });

  it('appends thinking indicator to non-empty buffer', () => {
    const result = formatStreamingText("Hello");
    expect(result).toContain("Hello");
    expect(result).toContain("_Thinking..._");
  });
});
