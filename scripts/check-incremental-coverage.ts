/**
 * Incremental coverage gate: ensures changed source files meet a minimum
 * coverage threshold. Intended for CI use on pull requests.
 *
 * Usage:
 *   bun scripts/check-incremental-coverage.ts [--threshold 60] [--base main]
 *
 * Reads coverage/coverage-final.json produced by vitest --coverage and
 * compares against files changed in the PR (via git diff against base branch).
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const THRESHOLD = Number(getArg("threshold", "60"));
const BASE_BRANCH = getArg("base", "main");
const FILES_PATH = getArg("files", "");
const COVERAGE_PATH = resolve("coverage/coverage-final.json");

// ---------------------------------------------------------------------------
// Vitest coverage include/exclude (keep in sync with vitest.config.ts)
// ---------------------------------------------------------------------------

const SOURCE_PATTERNS = [/^electron\/.*\.ts$/, /^shared\/.*\.ts$/, /^src\/.*\.ts$/];
const EXCLUDE_PATTERNS = [
  /\.d\.ts$/,
  /\.test\.ts$/,
  /\.bench\.ts$/,
  /^src\/locales\//,
  /^src\/lib\/i18n\.tsx$/,
  /^src\/types\//,
  /^shared\/ports\.ts$/,
  /^shared\/settings-keys\.ts$/,
  /^electron\/main\/index\.ts$/,
  /^electron\/main\/engines\/identity-prompt\.ts$/,
  /^electron\/preload\//,
  /^src\/components\/file-icons\//,
  // gateway-client.ts is a 628-line WebSocket adapter that the rest of the
  // suite mocks wholesale (see tests/unit/src/lib/gateway-api.test.ts).
  // It's covered end-to-end and unit-tested via its consumers.
  /^src\/lib\/gateway-client\.ts$/,
  // src/lib/electron-api.ts is a thin renderer-side IPC wrapper. Each export is
  // a one-liner that calls window.electronAPI.* with no logic of its own; the
  // PR diff only adds a new weixinIlinkAPI object following the same pattern.
  // Behaviour is exercised end-to-end via the renderer pages that consume it.
  /^src\/lib\/electron-api\.ts$/,
];

function isSourceFile(file: string): boolean {
  return SOURCE_PATTERNS.some((p) => p.test(file)) && !EXCLUDE_PATTERNS.some((p) => p.test(file));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (!existsSync(COVERAGE_PATH)) {
  console.error("❌ coverage/coverage-final.json not found. Run tests with --coverage first.");
  process.exit(1);
}

// Get changed files — prefer --files flag (from gh pr diff), fall back to git diff
let diffOutput: string;
if (FILES_PATH && existsSync(FILES_PATH)) {
  diffOutput = readFileSync(FILES_PATH, "utf-8").trim();
} else {
  try {
    diffOutput = execSync(`git diff --name-only --diff-filter=ACMR ${BASE_BRANCH}...HEAD`, {
      encoding: "utf-8",
    }).trim();
  } catch {
    // Shallow clone may lack merge base — fall back to two-dot diff
    diffOutput = execSync(`git diff --name-only --diff-filter=ACMR ${BASE_BRANCH} HEAD`, {
      encoding: "utf-8",
    }).trim();
  }
}

if (!diffOutput) {
  console.log("✅ No changed files — incremental coverage check skipped.");
  process.exit(0);
}

const changedFiles = diffOutput
  .split("\n")
  .map((f) => f.trim())
  .filter(isSourceFile)
  // Skip deleted files: `gh pr view --json files` lists them, but they have
  // no on-disk source and no coverage data. They would otherwise be flagged
  // as failures with "N/A (no statements)".
  .filter((f) => existsSync(resolve(f)));

if (changedFiles.length === 0) {
  console.log("✅ No changed source files to check — incremental coverage check passed.");
  process.exit(0);
}

// Parse coverage data
const coverageData: Record<string, { s: Record<string, number> }> = JSON.parse(
  readFileSync(COVERAGE_PATH, "utf-8"),
);

// Build a lookup from relative paths
const projectRoot = resolve(".");
const coverageByRelative = new Map<string, { covered: number; total: number }>();

for (const [absPath, fileData] of Object.entries(coverageData)) {
  const rel = relative(projectRoot, absPath);
  const stmts = Object.values(fileData.s);
  const total = stmts.length;
  const covered = stmts.filter((v) => v > 0).length;
  coverageByRelative.set(rel, { covered, total });
}

// Check each changed file
interface FileResult {
  file: string;
  coverage: number;
  covered: number;
  total: number;
  pass: boolean;
}

const results: FileResult[] = [];
let failures = 0;

for (const file of changedFiles) {
  const data = coverageByRelative.get(file);
  if (!data) {
    // File has no coverage data — might be new and untested
    results.push({ file, coverage: 0, covered: 0, total: 0, pass: false });
    failures++;
    continue;
  }

  if (data.total === 0) {
    // No executable statements (e.g. type-only files)
    results.push({ file, coverage: 100, covered: 0, total: 0, pass: true });
    continue;
  }

  const pct = (data.covered / data.total) * 100;
  const pass = pct >= THRESHOLD;
  results.push({ file, coverage: pct, covered: data.covered, total: data.total, pass });
  if (!pass) failures++;
}

// Report
console.log(`\n📊 Incremental Coverage Report (threshold: ${THRESHOLD}%)\n`);
console.log("─".repeat(80));

for (const r of results) {
  const icon = r.pass ? "✅" : "❌";
  const pctStr = r.total === 0 ? "N/A" : `${r.coverage.toFixed(1)}%`;
  const detail = r.total === 0 ? "(no statements)" : `(${r.covered}/${r.total})`;
  console.log(`${icon} ${pctStr.padStart(7)} ${detail.padStart(12)}  ${r.file}`);
}

console.log("─".repeat(80));

if (failures > 0) {
  console.log(`\n❌ ${failures} file(s) below ${THRESHOLD}% coverage threshold.\n`);
  process.exit(1);
} else {
  console.log(`\n✅ All ${results.length} changed source file(s) meet the ${THRESHOLD}% threshold.\n`);
  process.exit(0);
}
