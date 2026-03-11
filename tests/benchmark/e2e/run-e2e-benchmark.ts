#!/usr/bin/env npx tsx
// =============================================================================
// E2E Benchmark Runner — Orchestrates test server + benchmark execution
//
// This script handles the server-side setup for E2E performance benchmarks:
//   1. Build the renderer (if needed)
//   2. Start the test server
//   3. Enable streaming mode
//   4. Print instructions for browser_run execution
//   5. Optionally run benchmarks via CLI (headless not supported — use AI Browser)
//
// Usage:
//   npx tsx tests/benchmark/e2e/run-e2e-benchmark.ts [--port PORT] [--skip-build]
//
// For AI Browser integration:
//   1. Run this script in background
//   2. Navigate browser to the printed URL
//   3. Use browser_run with e2e-benchmark.js
// =============================================================================

import path from "path";
import { fileURLToPath } from "url";
import { startTestServer } from "../../e2e/setup/test-server";
import { seedTestData } from "../../e2e/setup/seed-data";
import type { TestServerInstance } from "../../e2e/setup/test-server";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// CLI args parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let port = 4567;
let skipBuild = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  }
  if (args[i] === "--skip-build") {
    skipBuild = true;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║         CodeMux E2E Performance Benchmark Server           ║");
  console.log("╠══════════════════════════════════════════════════════════════╣\n");

  // Step 1: Check for built renderer
  const staticRoot = path.resolve(__dirname, "../../../out/renderer");
  const fs = await import("fs");

  if (!fs.existsSync(path.join(staticRoot, "index.html"))) {
    if (skipBuild) {
      console.error("  ERROR: Built renderer not found at:", staticRoot);
      console.error("  Run 'npm run build' first, or omit --skip-build\n");
      process.exit(1);
    }

    console.log("  Building renderer...");
    const { execSync } = await import("child_process");
    try {
      execSync("npx electron-vite build", {
        cwd: path.resolve(__dirname, "../../.."),
        stdio: "inherit",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });
      console.log("  Build complete.\n");
    } catch (err) {
      console.error("  Build failed:", err);
      process.exit(1);
    }
  } else {
    console.log("  Using existing build:", staticRoot);
  }

  // Step 2: Start test server
  console.log(`  Starting test server on port ${port}...`);

  let server: TestServerInstance;
  try {
    server = await startTestServer({ port, staticRoot });
  } catch (err) {
    console.error("  Failed to start server:", err);
    process.exit(1);
  }

  // Step 3: Seed test data
  seedTestData(server.mockAdapters);
  await server.registerSessionRoutes();
  console.log("  Test data seeded.\n");

  // Step 4: Print instructions
  const benchmarkScript = path.resolve(__dirname, "e2e-benchmark.js");

  console.log("  ┌─ Server Ready ───────────────────────────────────────────┐");
  console.log(`  │  URL:        ${server.baseUrl}`);
  console.log(`  │  WebSocket:  ${server.wsUrl}`);
  console.log("  │                                                          │");
  console.log("  │  Benchmark script: e2e-benchmark.js                      │");
  console.log("  └──────────────────────────────────────────────────────────┘\n");

  console.log("  ┌─ AI Browser Instructions ────────────────────────────────┐");
  console.log("  │                                                          │");
  console.log(`  │  1. browser_navigate({ url: "${server.baseUrl}" })`);
  console.log("  │                                                          │");
  console.log("  │  2. browser_run({                                        │");
  console.log(`  │       file: "${benchmarkScript}",`);
  console.log("  │       params: {                                          │");
  console.log(`  │         baseUrl: "${server.baseUrl}",`);
  console.log('  │         scenario: "streaming",                           │');
  console.log("  │         messageCount: 5,                                 │");
  console.log("  │         waitMs: 8000                                     │");
  console.log("  │       },                                                 │");
  console.log("  │       timeout: 120000                                    │");
  console.log("  │     })                                                   │");
  console.log("  │                                                          │");
  console.log("  │  Available scenarios:                                    │");
  console.log('  │    - "streaming"    (text-heavy, SSE token streaming)     │');
  console.log('  │    - "multi-turn"   (rapid turn exchange)                │');
  console.log('  │    - "heavy-tools"  (many tool calls per response)       │');
  console.log("  │                                                          │");
  console.log("  └──────────────────────────────────────────────────────────┘\n");

  console.log("  Press Ctrl+C to stop.\n");

  // Keep server running until killed
  process.on("SIGINT", async () => {
    console.log("\n  Shutting down...");
    await server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.stop();
    process.exit(0);
  });

  // Keep the process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
