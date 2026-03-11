// =============================================================================
// Micro-benchmark: Shiki Syntax Highlighting Performance
//
// Measures the cost of codeToHtml calls used in ContentBash / ContentCode.
//
// Retained cases:
//   1. cache HIT — Map.get (validates our highlight-cache implementation)
//   2. cache MISS — full codeToHtml + store (absolute cost of a cache miss)
//
// These two cases directly quantify the value of the highlight-cache and
// detect regressions in our cache implementation.
// =============================================================================

import { bench, describe, beforeAll } from "vitest";
import type { HighlighterGeneric, BundledLanguage, BundledTheme } from "shiki";
import { getHighlight, setHighlight, hasHighlight } from "../../../src/lib/highlight-cache";

let highlighter: HighlighterGeneric<BundledLanguage, BundledTheme>;

beforeAll(async () => {
  const { createHighlighter } = await import("shiki");
  highlighter = await createHighlighter({
    themes: ["github-light", "one-dark-pro"],
    langs: ["bash"],
  });
}, 60_000); // Shiki init can be slow

// ---------------------------------------------------------------------------
// Realistic code sample matching actual tool output
// ---------------------------------------------------------------------------

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

  bench("cache MISS — codeToHtml + store (what ContentBash pays on first render)", () => {
    // Use unique key to force miss
    const uniqueCode = BASH_MEDIUM + `\n# ${Math.random()}`;
    const key = `bash:f:${uniqueCode}`;
    const html = highlighter.codeToHtml(uniqueCode, {
      lang: "bash",
      themes: { light: "github-light", dark: "one-dark-pro" },
    });
    setHighlight(key, html);
  });
});
