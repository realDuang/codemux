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
        "electron/main/engines/identity-prompt.ts",
        "electron/preload/**",
        "src/components/file-icons/**",
      ],
      thresholds: {
        lines: 15,
        functions: 15,
        branches: 15,
        statements: 15,
      },
    },
    benchmark: {
      include: ["tests/benchmark/**/*.bench.ts"],
    },
  },
});
