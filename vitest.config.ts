import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["electron/**/*.ts", "shared/**/*.ts", "src/**/*.ts"],
      exclude: [
        "**/*.d.ts",
        "**/*.test.ts",
        "**/*.bench.ts",
        "src/locales/**",
        "src/lib/i18n.tsx",
        "src/types/**",
        "shared/ports.ts",
        "shared/settings-keys.ts",
        "electron/main/index.ts",
        // Main-process lifecycle wiring requires a real Electron app; new path logic is covered separately.
        "electron/main/app-main.ts",
        "electron/main/engines/identity-prompt.ts",
        "electron/preload/**",
        "src/components/file-icons/**",
      ],
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 50,
        statements: 50,
      },
    },
    benchmark: {
      include: ["tests/benchmark/**/*.bench.ts"],
    },
  },
});
