// =============================================================================
// Micro-benchmark: Markdown Parsing Performance
//
// Measures the cost of marked.parse() — the core of ContentMarkdown.
//
// Retained case: "heavy response (tables + code)" — a realistic large AI
// response with 8 sections, each containing code blocks and tables (~6KB).
// This is the upper-bound parsing cost per debounce interval during streaming.
// =============================================================================

import { bench, describe, beforeAll } from "vitest";
import type { Marked as MarkedType } from "marked";

let marked: MarkedType;

beforeAll(async () => {
  const { Marked } = await import("marked");
  marked = new Marked();
});

// ---------------------------------------------------------------------------
// Realistic heavy content sample — simulates a detailed AI analysis
// ---------------------------------------------------------------------------

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
| Latency p50 | 25.3ms | +3.2% |
| Latency p99 | 142.7ms | -1.8% |
| Throughput | 850 rps | +2.5% |

Key observations:
1. The caching layer reduces p50 latency by **40%**
2. Memory usage grows linearly with unique inputs
3. Consider using \`WeakMap\` for garbage-collectible entries
`,
).join("\n---\n");

// ---------------------------------------------------------------------------
// Benchmark: Heavy response parsing (upper-bound cost)
// ---------------------------------------------------------------------------

describe("marked.parse: content complexity", () => {
  bench("heavy response — 8 sections, 8 code blocks, 8 tables (~6KB)", () => {
    marked.parse(HEAVY_RESPONSE);
  });
});
