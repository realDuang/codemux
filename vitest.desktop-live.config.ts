import { defineConfig } from "vitest/config";

// Opt-in live integration suite; the normal unit-test command never includes it.
export default defineConfig({
  test: {
    include: [
      "tests/integration/codex-desktop-gateway.test.ts",
      "tests/integration/codex-desktop-owned.test.ts",
      "tests/integration/codex-desktop-catalog.test.ts",
    ],
    environment: "node",
    globals: false,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
