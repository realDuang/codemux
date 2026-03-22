// =============================================================================
// Benchmark: File Explorer — Project Switch Performance
//
// Measures the cost of the heavy server-side file operations that execute
// during file explorer interactions: listing directories, reading files,
// querying git status, and watch/unwatch cycles.
//
// These operations are the most likely sources of performance regressions
// during rapid project switching.
// =============================================================================

import { bench, describe } from "vitest";
import {
  listDirectory,
  readFile,
  getGitStatus,
  watchDirectory,
  unwatchAll,
} from "../../../electron/main/services/file-service";
import { join } from "node:path";

const projectDir = join(__dirname, "..", "..", "..");

describe("Project Switch Performance", () => {
  bench("listDirectory + getGitStatus (simulates panel open)", async () => {
    await Promise.all([
      listDirectory(projectDir),
      getGitStatus(projectDir),
    ]);
  });

  bench("repeated project switch simulation (10 cycles)", async () => {
    const dirs = [
      "src", "electron", "tests", "src/components", "src/pages",
      "src/stores", "src/lib", "electron/main", "electron/main/services", "src/locales",
    ];

    for (const dir of dirs) {
      const fullPath = join(projectDir, dir);
      await listDirectory(fullPath);
    }
  });

  bench("watch/unwatch cycle (10 cycles)", () => {
    for (let i = 0; i < 10; i++) {
      watchDirectory(projectDir);
      unwatchAll();
    }
  });

  bench("readFile — 5 files in sequence", async () => {
    const files = [
      "package.json", "tsconfig.json", "vitest.config.ts",
      "electron.vite.config.ts", "playwright.config.ts",
    ];
    for (const f of files) {
      await readFile(join(projectDir, f), projectDir);
    }
  });

  bench("readFile — 5 files in parallel", async () => {
    const files = [
      "package.json", "tsconfig.json", "vitest.config.ts",
      "electron.vite.config.ts", "playwright.config.ts",
    ];
    await Promise.all(files.map((f) => readFile(join(projectDir, f), projectDir)));
  });
});
