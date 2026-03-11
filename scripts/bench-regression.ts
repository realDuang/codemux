#!/usr/bin/env tsx
// =============================================================================
// Benchmark Regression Detection Script
//
// Compares current benchmark results against a baseline and fails if any
// bench case regresses beyond the configured threshold.
//
// Usage:
//   npx tsx scripts/bench-regression.ts <baseline.json> <current.json>
//   npx tsx scripts/bench-regression.ts <baseline.json> <current.json> --threshold 25
//
// Environment variables:
//   BENCH_THRESHOLD  — regression threshold percentage (default: 20)
//
// Exit codes:
//   0 — all benchmarks within threshold (or no baseline available)
//   1 — one or more benchmarks regressed beyond threshold
//
// Output:
//   - Markdown comparison table to stdout
//   - Writes to $GITHUB_STEP_SUMMARY if available (GitHub Actions)
// =============================================================================

import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Types — Vitest bench JSON output structure
// ---------------------------------------------------------------------------

interface BenchResult {
  name: string;
  rank: number;
  rme: number;
  samples: number[];
  hz: number;
  min: number;
  max: number;
  mean: number;
  p75: number;
  p99: number;
  p995: number;
  p999: number;
}

interface BenchGroup {
  fullName: string;
  benchmarks: BenchResult[];
}

interface BenchFile {
  filepath: string;
  groups: BenchGroup[];
}

interface BenchOutput {
  files: BenchFile[];
}

// ---------------------------------------------------------------------------
// CLI args parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let baselinePath = "";
let currentPath = "";
let threshold = Number(process.env.BENCH_THRESHOLD) || 20;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--threshold" && args[i + 1]) {
    threshold = parseFloat(args[i + 1]);
    i++;
  } else if (!baselinePath) {
    baselinePath = args[i];
  } else if (!currentPath) {
    currentPath = args[i];
  }
}

if (!baselinePath || !currentPath) {
  console.error("Usage: npx tsx scripts/bench-regression.ts <baseline.json> <current.json> [--threshold N]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBenchJson(filePath: string): BenchOutput | null {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return null;
  }
  const raw = fs.readFileSync(resolved, "utf-8");
  return JSON.parse(raw) as BenchOutput;
}

/**
 * Flatten the nested bench output into a flat map: "group > name" → BenchResult
 *
 * Vitest bench JSON uses `fullName` on groups (e.g. "file.ts > group name")
 * and `name` on individual benchmarks.
 */
function flattenBenches(output: BenchOutput): Map<string, BenchResult> {
  const map = new Map<string, BenchResult>();
  for (const file of output.files) {
    for (const group of file.groups) {
      // Extract just the group display name from fullName
      // fullName = "tests/benchmark/micro/foo.bench.ts > Group Name"
      const groupName = group.fullName
        ? group.fullName.replace(/^.*>\s*/, "")
        : "unknown";

      for (const bench of group.benchmarks) {
        const key = `${groupName} > ${bench.name}`;
        map.set(key, bench);
      }
    }
  }
  return map;
}

function formatHz(hz: number): string {
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(2)}M ops/s`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(2)}K ops/s`;
  return `${hz.toFixed(2)} ops/s`;
}

function formatChange(changePercent: number): string {
  const sign = changePercent >= 0 ? "+" : "";
  const emoji = changePercent < -threshold ? "🔴" : changePercent > threshold ? "🟢" : "⚪";
  return `${emoji} ${sign}${changePercent.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\n📊 Benchmark Regression Check (threshold: ${threshold}%)\n`);

// Read baseline
const baseline = readBenchJson(baselinePath);
if (!baseline) {
  console.log("⚠️  No baseline found — skipping regression check (first run?)");
  console.log(`   Baseline path: ${path.resolve(baselinePath)}`);
  process.exit(0);
}

// Read current
const current = readBenchJson(currentPath);
if (!current) {
  console.error(`❌ Current results not found: ${path.resolve(currentPath)}`);
  process.exit(1);
}

const baselineMap = flattenBenches(baseline);
const currentMap = flattenBenches(current);

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

interface CompareRow {
  name: string;
  baselineHz: number;
  currentHz: number;
  changePercent: number;
  failed: boolean;
}

const rows: CompareRow[] = [];
const failures: CompareRow[] = [];
const newBenches: string[] = [];
const removedBenches: string[] = [];

// Check all current benches against baseline
for (const [key, currentBench] of currentMap) {
  const baselineBench = baselineMap.get(key);
  if (!baselineBench) {
    newBenches.push(key);
    continue;
  }

  const changePercent = ((currentBench.hz - baselineBench.hz) / baselineBench.hz) * 100;
  const failed = changePercent < -threshold;

  const row: CompareRow = {
    name: key,
    baselineHz: baselineBench.hz,
    currentHz: currentBench.hz,
    changePercent,
    failed,
  };

  rows.push(row);
  if (failed) failures.push(row);
}

// Check for removed benches
for (const key of baselineMap.keys()) {
  if (!currentMap.has(key)) {
    removedBenches.push(key);
  }
}

// ---------------------------------------------------------------------------
// Output markdown table
// ---------------------------------------------------------------------------

const lines: string[] = [];

lines.push("## Benchmark Comparison\n");
lines.push("| Benchmark | Baseline | Current | Change |");
lines.push("|-----------|----------|---------|--------|");

for (const row of rows) {
  const status = row.failed ? "**REGRESSED**" : "OK";
  lines.push(
    `| ${row.name} | ${formatHz(row.baselineHz)} | ${formatHz(row.currentHz)} | ${formatChange(row.changePercent)} ${status} |`,
  );
}

if (newBenches.length > 0) {
  lines.push("");
  lines.push("### New Benchmarks (no baseline)");
  for (const name of newBenches) {
    const bench = currentMap.get(name)!;
    lines.push(`- ${name}: ${formatHz(bench.hz)}`);
  }
}

if (removedBenches.length > 0) {
  lines.push("");
  lines.push("### Removed Benchmarks (in baseline but not in current)");
  for (const name of removedBenches) {
    lines.push(`- ${name}`);
  }
}

lines.push("");
lines.push(`> Threshold: **${threshold}%** regression triggers failure`);
lines.push(`> Compared ${rows.length} benchmarks, ${newBenches.length} new, ${removedBenches.length} removed`);

const markdown = lines.join("\n");

// Print to stdout
console.log(markdown);

// Write to GitHub Step Summary if available
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
  console.log("\n📝 Results written to GitHub Step Summary");
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} benchmark(s) regressed beyond ${threshold}% threshold:\n`);
  for (const f of failures) {
    console.log(`   ${f.name}: ${formatChange(f.changePercent)} (${formatHz(f.baselineHz)} → ${formatHz(f.currentHz)})`);
  }
  console.log("");
  process.exit(1);
} else {
  console.log(`\n✅ All ${rows.length} benchmarks within ${threshold}% threshold\n`);
  process.exit(0);
}
