// =============================================================================
// Micro-benchmark: Shiki Syntax Highlighting Performance
//
// Measures the cost of codeToHtml calls used in:
//   - ContentBash  (NOW with highlight-cache + long-output truncation)
//   - ContentCode  (WITH highlight-cache)
//   - ContentMarkdown (WITH highlight-cache via markedShiki plugin)
//
// Key metrics: cache hit vs miss cost, long output truncation benefit,
// dual-theme overhead, and scaling behavior.
// =============================================================================

import { bench, describe, beforeAll } from "vitest";
import type { HighlighterGeneric, BundledLanguage, BundledTheme } from "shiki";
import { getHighlight, setHighlight, hasHighlight } from "../../../src/lib/highlight-cache";

let highlighter: HighlighterGeneric<BundledLanguage, BundledTheme>;

beforeAll(async () => {
  const { createHighlighter } = await import("shiki");
  highlighter = await createHighlighter({
    themes: ["github-light", "one-dark-pro"],
    langs: ["typescript", "python", "bash", "json", "javascript", "console"],
  });
}, 60_000); // Shiki init can be slow

// ---------------------------------------------------------------------------
// Realistic code samples matching actual tool outputs
// ---------------------------------------------------------------------------

const BASH_SHORT = "ls -la /tmp";

const BASH_MEDIUM = `#!/bin/bash
set -euo pipefail

for file in $(find . -name "*.ts" -type f); do
  echo "Processing $file"
  if grep -q "TODO" "$file"; then
    echo "  Found TODOs in $file"
    grep -n "TODO" "$file" | while read -r line; do
      echo "    $line"
    done
  fi
done

echo "Done processing $(find . -name '*.ts' | wc -l) files"`;

const BASH_LONG_OUTPUT = Array.from(
  { length: 200 },
  (_, i) =>
    `[${String(i + 1).padStart(3, "0")}] PASS  src/tests/unit/component-${i}.test.ts (${(Math.random() * 2).toFixed(1)}s)`,
).join("\n");

const TS_COMPONENT = `import { createSignal, createMemo, createEffect, onCleanup, Show, For } from 'solid-js'
import { createStore } from 'solid-js/store'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  parts: Part[]
}

interface Part {
  id: string
  type: 'text' | 'code' | 'tool'
  content: string
}

export function MessageList(props: { sessionId: string }) {
  const [messages, setMessages] = createStore<Message[]>([])
  const [filter, setFilter] = createSignal('')

  const filtered = createMemo(() => {
    const f = filter().toLowerCase()
    if (!f) return messages
    return messages.filter(m => m.content.toLowerCase().includes(f))
  })

  createEffect(() => {
    const ws = new WebSocket(\`ws://localhost:4200/ws\`)
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (data.type === 'message.updated') {
        setMessages(produce(draft => { draft.push(data.payload) }))
      }
    }
    onCleanup(() => ws.close())
  })

  return (
    <div class="message-list">
      <input value={filter()} onInput={e => setFilter(e.target.value)} />
      <For each={filtered()}>
        {(msg) => <div class="message">{msg.content}</div>}
      </For>
    </div>
  )
}`;

const PYTHON_SNIPPET = `import asyncio
from typing import AsyncGenerator

async def stream_tokens(prompt: str) -> AsyncGenerator[str, None]:
    """Stream response tokens from the language model."""
    async with aiohttp.ClientSession() as session:
        async with session.post(
            "https://api.example.com/v1/completions",
            json={"prompt": prompt, "stream": True},
        ) as response:
            async for line in response.content:
                if line.startswith(b"data: "):
                    data = json.loads(line[6:])
                    if data.get("choices"):
                        yield data["choices"][0]["text"]

async def main():
    prompt = "Explain quantum computing in simple terms."
    tokens = []
    async for token in stream_tokens(prompt):
        tokens.append(token)
        print(token, end="", flush=True)
    print(f"\\n\\nTotal tokens: {len(tokens)}")

if __name__ == "__main__":
    asyncio.run(main())`;

// ---------------------------------------------------------------------------
// Benchmark: Raw codeToHtml cost (what ContentBash pays every time)
// ---------------------------------------------------------------------------

describe("codeToHtml: bash (ContentBash hot path)", () => {
  bench("short command (10 chars)", () => {
    highlighter.codeToHtml(BASH_SHORT, {
      lang: "bash",
      themes: { light: "github-light", dark: "one-dark-pro" },
    });
  });

  bench("medium script (400 chars)", () => {
    highlighter.codeToHtml(BASH_MEDIUM, {
      lang: "bash",
      themes: { light: "github-light", dark: "one-dark-pro" },
    });
  });

  bench("long output — 200 lines (~10KB)", () => {
    highlighter.codeToHtml(BASH_LONG_OUTPUT, {
      lang: "bash",
      themes: { light: "github-light", dark: "one-dark-pro" },
    });
  });
});

describe("codeToHtml: other languages", () => {
  bench("TypeScript component (1.5KB)", () => {
    highlighter.codeToHtml(TS_COMPONENT, {
      lang: "typescript",
      themes: { light: "github-light", dark: "one-dark-pro" },
    });
  });

  bench("Python snippet (900 chars)", () => {
    highlighter.codeToHtml(PYTHON_SNIPPET, {
      lang: "python",
      themes: { light: "github-light", dark: "one-dark-pro" },
    });
  });

  bench("JSON config (500 chars)", () => {
    highlighter.codeToHtml(
      JSON.stringify(
        {
          name: "codemux",
          version: "1.3.4",
          scripts: {
            dev: "electron-vite dev",
            build: "electron-vite build",
            test: "vitest run",
          },
          dependencies: {
            "solid-js": "^1.8.0",
            shiki: "^1.22.0",
            marked: "^11.1.0",
          },
        },
        null,
        2,
      ),
      {
        lang: "json",
        themes: { light: "github-light", dark: "one-dark-pro" },
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Benchmark: highlight-cache hit vs miss
//
// This directly quantifies the value of adding cache to ContentBash:
//   cache miss (codeToHtml)  vs  cache hit (Map.get)
// ---------------------------------------------------------------------------

describe("highlight-cache: hit vs miss", () => {
  // Pre-populate cache for hit benchmarks
  beforeAll(() => {
    const key = `bash:f:${BASH_MEDIUM}`;
    if (!hasHighlight(key)) {
      const html = highlighter.codeToHtml(BASH_MEDIUM, {
        lang: "bash",
        themes: { light: "github-light", dark: "one-dark-pro" },
      });
      setHighlight(key, html);
    }
  });

  bench("cache HIT — Map.get (what ContentCode pays on repeat)", () => {
    const key = `bash:f:${BASH_MEDIUM}`;
    getHighlight(key);
  });

  bench("cache MISS — codeToHtml + store (what ContentBash pays EVERY time)", () => {
    // Use unique key to force miss
    const uniqueCode = BASH_MEDIUM + `\n# ${Math.random()}`;
    const key = `bash:f:${uniqueCode}`;
    const html = highlighter.codeToHtml(uniqueCode, {
      lang: "bash",
      themes: { light: "github-light", dark: "one-dark-pro" },
    });
    setHighlight(key, html);
  });

  bench("cache check — hasHighlight (lookup overhead)", () => {
    hasHighlight(`bash:f:${BASH_MEDIUM}`);
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Dual-theme highlighting (ContentBash uses dual themes)
//
// ContentBash specifies themes: { light, dark } — Shiki generates CSS for both.
// ContentCode uses the same pattern. Compare single vs dual theme cost.
// ---------------------------------------------------------------------------

describe("single theme vs dual theme", () => {
  bench("single theme (github-light only)", () => {
    highlighter.codeToHtml(TS_COMPONENT, {
      lang: "typescript",
      theme: "github-light",
    });
  });

  bench("dual themes (light + dark)", () => {
    highlighter.codeToHtml(TS_COMPONENT, {
      lang: "typescript",
      themes: { light: "github-light", dark: "one-dark-pro" },
    });
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Scaling — how does cost grow with code size?
// ---------------------------------------------------------------------------

describe("scaling: code size vs highlight time", () => {
  const baseLine = "const x = 1; // a comment\n";

  for (const lineCount of [1, 10, 50, 100, 500]) {
    const code = baseLine.repeat(lineCount);
    bench(`TypeScript: ${lineCount} lines (${(code.length / 1024).toFixed(1)}KB)`, () => {
      highlighter.codeToHtml(code, {
        lang: "typescript",
        themes: { light: "github-light", dark: "one-dark-pro" },
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Benchmark: ContentBash optimized path simulation
//
// Simulates the full highlightCode() function from the optimized ContentBash:
//   1. Cache check → return on hit (fast path)
//   2. Long output truncation → only highlight first 200 lines
//   3. codeToHtml on truncated content → store in cache
//
// Compare old (no cache, full highlight) vs new (cache + truncation) behavior.
// ---------------------------------------------------------------------------

describe("ContentBash: old vs optimized behavior", () => {
  const MAX_HIGHLIGHT_LINES = 200;

  // Generate a 500-line "npm test" output (realistic large output)
  const LONG_OUTPUT_500 = Array.from(
    { length: 500 },
    (_, i) =>
      `[${String(i + 1).padStart(3, "0")}] PASS  tests/unit/module-${i}.test.ts (${(Math.random() * 3).toFixed(1)}s)`,
  ).join("\n");

  // Old behavior: highlight ALL 500 lines (no cache, no truncation)
  bench("OLD: highlight 500 lines directly (no cache, no truncation)", () => {
    highlighter.codeToHtml(LONG_OUTPUT_500, {
      lang: "console",
      themes: { light: "github-light", dark: "one-dark-pro" },
    });
  });

  // New behavior: truncate to 200 lines, highlight only those, escape the rest
  bench("NEW: truncate to 200 lines + highlight + escape rest", () => {
    const lines = LONG_OUTPUT_500.split("\n");
    const truncated = lines.slice(0, MAX_HIGHLIGHT_LINES).join("\n");
    const remaining = lines.slice(MAX_HIGHLIGHT_LINES);
    const escaped = remaining
      .join("\n")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const html = highlighter.codeToHtml(truncated, {
      lang: "console",
      themes: { light: "github-light", dark: "one-dark-pro" },
    });

    // Simulate combining (what highlightCode does)
    const _ = html + `<pre style="opacity:0.7"><code>${escaped}</code></pre>`;
  });

  // New behavior on cache hit: near-zero cost
  bench("NEW: cache hit (2nd render of same command)", () => {
    // Pre-populate cache (simulates first render already happened)
    const key = `console:${LONG_OUTPUT_500}`;
    if (!hasHighlight(key)) {
      setHighlight(key, "<pre>cached html...</pre>");
    }
    // This is what every subsequent render pays
    if (hasHighlight(key)) {
      getHighlight(key);
    }
  });

  // Simulate a conversation with 10 shell tool calls, all hitting cache
  bench("NEW: 10 shell tools all cached (realistic conversation)", () => {
    for (let i = 0; i < 10; i++) {
      const cmdKey = `bash:command-${i}`;
      const outKey = `console:output-${i}`;
      if (!hasHighlight(cmdKey)) setHighlight(cmdKey, "<pre>cmd</pre>");
      if (!hasHighlight(outKey)) setHighlight(outKey, "<pre>out</pre>");

      // Simulate ContentBash render: check + get for both command and output
      if (hasHighlight(cmdKey)) getHighlight(cmdKey);
      if (hasHighlight(outKey)) getHighlight(outKey);
    }
  });
});

// ---------------------------------------------------------------------------
// Benchmark: LRU cache behavior under pressure
//
// Verify that LRU promotion (delete + re-set) doesn't add significant
// overhead compared to simple Map.get.
// ---------------------------------------------------------------------------

describe("LRU cache: promotion overhead", () => {
  // Pre-populate cache with entries
  beforeAll(() => {
    for (let i = 0; i < 100; i++) {
      setHighlight(`lru-test-${i}`, `<pre>result-${i}</pre>`);
    }
  });

  bench("simple Map.has check", () => {
    hasHighlight("lru-test-50");
  });

  bench("LRU get (has + delete + set promotion)", () => {
    getHighlight("lru-test-50");
  });
});
