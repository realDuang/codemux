// =============================================================================
// Micro-benchmark: Markdown Parsing Performance
//
// Measures the cost of marked.parse() — the core of ContentMarkdown.
//
// In production, ContentMarkdown debounces SSE updates to ~150ms intervals,
// then calls marked.parse() on the accumulated text. This benchmark measures:
// 1. Pure marked.parse() cost (no Shiki) — to isolate markdown overhead
// 2. Streaming simulation — incremental re-parsing as text grows
// 3. How cost scales with content complexity (tables, lists, code blocks)
//
// Note: Shiki integration is tested separately in shiki-highlight.bench.ts.
// In production, marked-shiki async highlight adds to this baseline cost.
// =============================================================================

import { bench, describe, beforeAll } from "vitest";
import type { Marked as MarkedType } from "marked";

let marked: MarkedType;

beforeAll(async () => {
  const { Marked } = await import("marked");
  marked = new Marked();
});

// ---------------------------------------------------------------------------
// Realistic content samples
// ---------------------------------------------------------------------------

const PLAIN_SHORT = "Hello **world** with `code` and a [link](https://example.com).";

const PLAIN_MEDIUM = `
This is a more substantial response from the AI assistant. It contains **bold text**,
*italic text*, and \`inline code\` throughout.

Here are some key points:
- First point about the architecture
- Second point about **performance** implications
- Third point with a \`codeRef\` reference

The implementation uses a combination of techniques to achieve optimal results.
You can find more details in the [documentation](https://docs.example.com).
`.trim();

const WITH_CODE_BLOCKS = `
Here's a solution to the problem:

\`\`\`typescript
function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

// Memoized version
function fibMemo(n: number, memo: Map<number, number> = new Map()): number {
  if (memo.has(n)) return memo.get(n)!;
  if (n <= 1) return n;
  const result = fibMemo(n - 1, memo) + fibMemo(n - 2, memo);
  memo.set(n, result);
  return result;
}
\`\`\`

And the iterative approach:

\`\`\`python
def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
\`\`\`

The time complexity is O(2^n) for recursive, O(n) for memoized, and O(n) for iterative.
`.trim();

const WITH_TABLE = `
## Comparison Results

| Algorithm | Time Complexity | Space Complexity | Practical Speed |
|-----------|----------------|-----------------|-----------------|
| Recursive | O(2^n) | O(n) | Very slow |
| Memoized | O(n) | O(n) | Fast |
| Iterative | O(n) | O(1) | Fastest |
| Matrix | O(log n) | O(1) | Fastest (large n) |

### Notes
- Recursive is impractical for n > 40
- Memoized trades memory for speed
- Iterative is the best general-purpose solution
`.trim();

// Heavy response: simulates a detailed AI analysis with mixed content
const HEAVY_RESPONSE = Array.from(
  { length: 8 },
  (_, i) => `
## Section ${i + 1}: Analysis

Here's the detailed analysis for component ${i + 1}. The implementation
uses **reactive signals** and \`createMemo\` for derived state.

\`\`\`typescript
export class Handler${i} {
  private cache = new Map<string, Result>();

  async process(input: string): Promise<Result> {
    if (this.cache.has(input)) {
      return this.cache.get(input)!;
    }
    const parsed = JSON.parse(input);
    const result = await this.transform(parsed);
    this.cache.set(input, result);
    return result;
  }

  private async transform(data: unknown): Promise<Result> {
    // Complex transformation logic
    return { status: 'ok', data, timestamp: Date.now() };
  }
}
\`\`\`

| Metric | Value | Delta |
|--------|-------|-------|
| Latency p50 | ${(Math.random() * 50 + 10).toFixed(1)}ms | ${Math.random() > 0.5 ? "+" : "-"}${(Math.random() * 10).toFixed(1)}% |
| Latency p99 | ${(Math.random() * 200 + 50).toFixed(1)}ms | ${Math.random() > 0.5 ? "+" : "-"}${(Math.random() * 15).toFixed(1)}% |
| Throughput | ${(Math.random() * 1000 + 500).toFixed(0)} rps | ${Math.random() > 0.5 ? "+" : "-"}${(Math.random() * 5).toFixed(1)}% |

Key observations:
1. The caching layer reduces p50 latency by **40%**
2. Memory usage grows linearly with unique inputs
3. Consider using \`WeakMap\` for garbage-collectible entries
`,
).join("\n---\n");

// ---------------------------------------------------------------------------
// Benchmark: Parse cost by content type
// ---------------------------------------------------------------------------

describe("marked.parse: content complexity", () => {
  bench("plain text — short (60 chars)", () => {
    marked.parse(PLAIN_SHORT);
  });

  bench("plain text — medium (500 chars)", () => {
    marked.parse(PLAIN_MEDIUM);
  });

  bench("with 2 code blocks (800 chars)", () => {
    marked.parse(WITH_CODE_BLOCKS);
  });

  bench("with table + lists (600 chars)", () => {
    marked.parse(WITH_TABLE);
  });

  bench("heavy response — 8 sections, 8 code blocks, 8 tables (~6KB)", () => {
    marked.parse(HEAVY_RESPONSE);
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Streaming simulation — incremental re-parsing
//
// ContentMarkdown's debounce means marked.parse() is called ~6-7 times/sec
// on progressively longer text. Each call re-parses the ENTIRE accumulated
// text, not just the new tokens. This measures that accumulation cost.
// ---------------------------------------------------------------------------

describe("streaming simulation: incremental re-parse", () => {
  // Simulate ~10 seconds of streaming at ~30 tokens/sec, debounced to ~150ms
  // = roughly 67 re-parses, each on progressively longer text
  const words = HEAVY_RESPONSE.split(/\s+/);

  // Build snapshots at debounce intervals (~5 words per 150ms chunk at 30 tok/s)
  const WORDS_PER_CHUNK = 5;
  const snapshots: string[] = [];
  for (let i = WORDS_PER_CHUNK; i <= Math.min(words.length, 500); i += WORDS_PER_CHUNK) {
    snapshots.push(words.slice(0, i).join(" "));
  }

  bench(`${snapshots.length} incremental parses (simulating ~${(snapshots.length * 0.15).toFixed(1)}s of streaming)`, () => {
    for (const snapshot of snapshots) {
      marked.parse(snapshot);
    }
  });

  // Measure cost of parsing just the final (longest) snapshot
  bench("single parse of final accumulated text", () => {
    marked.parse(snapshots[snapshots.length - 1]);
  });

  // Compare: what if we only parsed the new chunk (hypothetical optimization)?
  bench("parse only last chunk (incremental-parse potential)", () => {
    const lastChunk = words.slice(words.length - WORDS_PER_CHUNK).join(" ");
    marked.parse(lastChunk);
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Scaling — how does parse cost grow with text size?
// ---------------------------------------------------------------------------

describe("scaling: text size vs parse time", () => {
  const paragraph = `This is a paragraph with **bold**, *italic*, \`code\`, and a [link](https://example.com). It has multiple sentences to provide realistic content density.\n\n`;

  for (const count of [1, 5, 10, 25, 50, 100]) {
    const text = paragraph.repeat(count);
    bench(`${count} paragraphs (${(text.length / 1024).toFixed(1)}KB)`, () => {
      marked.parse(text);
    });
  }
});

// ---------------------------------------------------------------------------
// Benchmark: HTML escaping (displayHtml fallback in ContentMarkdown)
//
// When markdown is still loading, ContentMarkdown shows escaped raw text.
// This measures the fallback path cost.
// ---------------------------------------------------------------------------

describe("displayHtml fallback (escape + basic formatting)", () => {
  function escapeAndFormat(raw: string): string {
    const escaped = raw
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<p>${escaped.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
  }

  bench("short text fallback", () => {
    escapeAndFormat(PLAIN_SHORT);
  });

  bench("medium text fallback", () => {
    escapeAndFormat(PLAIN_MEDIUM);
  });

  bench("heavy response fallback (~6KB)", () => {
    escapeAndFormat(HEAVY_RESPONSE);
  });
});
