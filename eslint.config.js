import js from "@eslint/js";
import tseslint from "typescript-eslint";
import solid from "eslint-plugin-solid/configs/typescript";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "dist/**",
      "out/**",
      "release/**",
      "coverage/**",
      "node_modules/**",
      ".bench/**",
      "patches/**",
      "homebrew/**",
      "resources/**",
    ],
  },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript recommended rules
  ...tseslint.configs.recommended,

  // SolidJS rules for renderer code (browser environment)
  {
    files: ["src/**/*.{ts,tsx}"],
    ...solid,
    languageOptions: {
      ...solid.languageOptions,
      globals: {
        // Browser globals
        document: "readonly",
        window: "readonly",
        navigator: "readonly",
        performance: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        Event: "readonly",
        CustomEvent: "readonly",
        MouseEvent: "readonly",
        KeyboardEvent: "readonly",
        HTMLElement: "readonly",
        HTMLDivElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLFormElement: "readonly",
        MutationObserver: "readonly",
        IntersectionObserver: "readonly",
        ResizeObserver: "readonly",
        PerformanceObserver: "readonly",
        Clipboard: "readonly",
        ClipboardEvent: "readonly",
        FileReader: "readonly",
        Blob: "readonly",
        FormData: "readonly",
        WebSocket: "readonly",
        EventSource: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        getComputedStyle: "readonly",
      },
    },
    rules: {
      ...solid.rules,
      // SolidJS uses innerHTML for rendering markdown/HTML content safely
      "solid/no-innerhtml": "warn",
      // SolidJS ref pattern: let ref; <div ref={ref}> is handled correctly by @typescript-eslint/no-unused-vars
    },
  },

  // Project-wide TypeScript overrides
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // Relaxed for initial adoption — tighten over time
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unsafe-declaration-merging": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      "no-control-regex": "off",
      "prefer-const": "warn",
      "no-var": "error",
    },
  },

  // Electron main process & scripts — allow console
  {
    files: ["electron/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // Test & benchmark files — relaxed rules
  {
    files: [
      "tests/**/*.{ts,tsx,js}",
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
      "**/*.bench.{ts,tsx}",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "no-console": "off",
      "no-empty": "off",
      "no-undef": "off",
    },
  },

  // Config files — relaxed rules
  {
    files: ["*.config.{ts,js,mjs}", "*.config.*.{ts,js,mjs}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "no-console": "off",
    },
  },
);
