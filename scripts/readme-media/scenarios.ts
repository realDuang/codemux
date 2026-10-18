// Scripted agent turns for the README demo. Content is illustrative; nothing
// here is captured from a real provider run.

import { join } from "node:path";
import type { ToolPart } from "../../src/types/unified";
import { CART_TS } from "./demo-project";

export type Step =
  | { kind: "reasoning"; text: string }
  | { kind: "text"; text: string }
  | { kind: "permission"; title: string; command: string; autoApproveMs?: number }
  | {
    kind: "tool";
    tool: ToolPart["normalizedTool"];
    originalTool?: string;
    title: string;
    input: unknown | ((directory: string) => unknown);
    output?: unknown;
    metadata?: Record<string, unknown>;
    file?: string;
    diff?: string;
    durationMs?: number;
    /** Applied to the real file in the demo project when the tool completes. */
    apply?: (before: string) => string;
  };

export interface Scenario {
  match: RegExp;
  steps: Step[];
  tokens: { input: number; output: number; cache?: { read: number; write: number } };
  cost: number;
}

type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };
const todo = (todos: Todo[]): Step => ({
  kind: "tool", tool: "todo", originalTool: "TodoWrite", title: "Update plan", input: { todos }, output: "", durationMs: 150,
});
const plan = (states: Array<Todo["status"]>): Step => todo([
  { content: "Locate the coupon logic", activeForm: "Locating the coupon logic" },
  { content: "Fix the total calculation", activeForm: "Fixing the total calculation" },
  { content: "Add a regression test", activeForm: "Adding a regression test" },
  { content: "Run the test suite", activeForm: "Running the test suite" },
].map((item, index) => ({ ...item, status: states[index] })));

const FIXED_LINE = "  const taxed = discounted * (1 + taxRate);";
const BUGGY_LINE = "  const taxed = applyCoupon(discounted * (1 + taxRate), coupon);";
const REGRESSION_TEST = `
  it("applies a coupon once, before tax", () => {
    const coupon = { code: "SPRING20", percentOff: 20 };
    expect(cartTotal(items, coupon)).toBe(86.4);
  });
});
`;

const numbered = (text: string) => text.trimEnd().split("\n").map((line, i) => `${String(i + 1).padStart(4)}\t${line}`).join("\n");

const fixCoupon: Scenario = {
  match: /coupon/i,
  tokens: { input: 18_420, output: 1_236, cache: { read: 12_800, write: 2_100 } },
  cost: 0.042,
  steps: [
    { kind: "reasoning", text: "**Tracing the coupon math**\n\nTotals are too low only when a coupon is used, so the discount is probably applied in the wrong place. I'll find every call to the coupon helper, check the order of discount and tax, then prove the fix with a test." },
    plan(["in_progress", "pending", "pending", "pending"]),
    { kind: "tool", tool: "grep", originalTool: "Grep", title: "Search applyCoupon", input: (d: string) => ({ pattern: "applyCoupon", path: join(d, "src") }),
      output: "src/cart.ts:17:export function applyCoupon(amount: number, coupon?: Coupon): number {\nsrc/cart.ts:23:  const discounted = applyCoupon(subtotal(items), coupon);\nsrc/cart.ts:24:  const taxed = applyCoupon(discounted * (1 + taxRate), coupon);", durationMs: 600 },
    { kind: "tool", tool: "read", originalTool: "Read", title: "Read src/cart.ts", file: "src/cart.ts",
      input: (d: string) => ({ filePath: join(d, "src/cart.ts") }), output: numbered(CART_TS), durationMs: 500 },
    { kind: "text", text: "Found it. `cartTotal` applies the coupon **twice**: once to the subtotal and again after tax, so a 20% coupon actually takes about 36% off." },
    plan(["completed", "in_progress", "pending", "pending"]),
    { kind: "tool", tool: "edit", originalTool: "Edit", title: "Edit src/cart.ts", file: "src/cart.ts",
      input: (d: string) => ({ filePath: join(d, "src/cart.ts"), oldString: BUGGY_LINE, newString: FIXED_LINE }),
      output: "Updated src/cart.ts", durationMs: 800,
      diff: `--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -22,5 +22,5 @@ export function cartTotal(items: CartItem[], coupon?: Coupon, taxRate = 0.08): number {\n   const discounted = applyCoupon(subtotal(items), coupon);\n-${BUGGY_LINE}\n+${FIXED_LINE}\n   return Math.round(taxed * 100) / 100;\n }`,
      apply: (before) => before.replace(BUGGY_LINE, FIXED_LINE) },
    plan(["completed", "completed", "in_progress", "pending"]),
    { kind: "tool", tool: "edit", originalTool: "Edit", title: "Edit src/cart.test.ts", file: "src/cart.test.ts",
      input: (d: string) => ({ filePath: join(d, "src/cart.test.ts"), oldString: "  });\n});\n", newString: `  });\n${REGRESSION_TEST}` }),
      output: "Updated src/cart.test.ts", durationMs: 700,
      diff: `--- a/src/cart.test.ts\n+++ b/src/cart.test.ts\n@@ -15,4 +15,9 @@ describe("cart", () => {\n   it("adds tax", () => {\n     expect(cartTotal(items)).toBe(108);\n   });\n+\n+  it("applies a coupon once, before tax", () => {\n+    const coupon = { code: "SPRING20", percentOff: 20 };\n+    expect(cartTotal(items, coupon)).toBe(86.4);\n+  });\n });`,
      apply: (before) => before.replace(/ {2}\}\);\n\}\);\n$/, `  });\n${REGRESSION_TEST}`) },
    plan(["completed", "completed", "completed", "in_progress"]),
    { kind: "permission", title: "Run the test suite", command: "npm test", autoApproveMs: 20_000 },
    { kind: "tool", tool: "shell", originalTool: "Bash", title: "npm test", input: { command: "npm test", description: "Run the test suite" }, durationMs: 1400,
      output: "> acme-shop@0.4.2 test\n> vitest run\n\n ✓ src/cart.test.ts (3 tests) 4ms\n ✓ src/checkout/summary.test.ts (3 tests) 3ms\n\n Test Files  2 passed (2)\n      Tests  6 passed (6)\n   Duration  412ms" },
    plan(["completed", "completed", "completed", "completed"]),
    { kind: "text", text: "## Fixed: coupon applied twice\n\n**Root cause:** `cartTotal` discounted the subtotal, then discounted again after adding tax.\n\n| Cart | Before | After |\n| --- | ---: | ---: |\n| $100, `SPRING20`, 8% tax | $69.12 | **$86.40** |\n\n**Changes**\n- `src/cart.ts`: apply the coupon once, before tax\n- `src/cart.test.ts`: regression test for coupon + tax\n\nAll 6 tests pass." },
  ],
};

const validation: Scenario = {
  match: /validat/i,
  tokens: { input: 9_310, output: 842 }, cost: 0.021,
  steps: [
    { kind: "reasoning", text: "**Planning request validation**\n\n`zod` is already a dependency, so I'll describe the order payload with a schema and parse it before sending." },
    { kind: "tool", tool: "read", originalTool: "Read", title: "Read src/api/orders.ts", file: "src/api/orders.ts", input: (d: string) => ({ filePath: join(d, "src/api/orders.ts") }), output: "export interface CreateOrderRequest { … }" },
    { kind: "tool", tool: "edit", originalTool: "Edit", title: "Edit src/api/orders.ts", file: "src/api/orders.ts", input: (d: string) => ({ filePath: join(d, "src/api/orders.ts") }), output: "Updated src/api/orders.ts",
      diff: "--- a/src/api/orders.ts\n+++ b/src/api/orders.ts\n@@ -1,3 +1,15 @@\n+import { z } from \"zod\";\n import type { CartItem } from \"../cart\";\n \n+export const CreateOrderSchema = z.object({\n+  email: z.string().email(),\n+  items: z.array(z.object({\n+    sku: z.string().min(1),\n+    quantity: z.number().int().positive(),\n+  })).nonempty(),\n+  couponCode: z.string().optional(),\n+});\n" },
    { kind: "tool", tool: "shell", originalTool: "Bash", title: "npx tsc --noEmit", input: { command: "npx tsc --noEmit" }, output: "" },
    { kind: "text", text: "Added a `CreateOrderSchema` with zod. `createOrder` now rejects an empty cart, a bad email, or a non-positive quantity before any network call. Type check is clean." },
  ],
};

const explain: Scenario = {
  match: /how does|explain/i,
  tokens: { input: 7_200, output: 690 }, cost: 0.6,
  steps: [
    { kind: "tool", tool: "glob", originalTool: "glob", title: "Find checkout files", input: { pattern: "src/**/*.{ts,tsx}" }, output: "src/cart.ts\nsrc/checkout/summary.ts\nsrc/api/orders.ts\nsrc/components/CartSummary.tsx\nsrc/main.tsx" },
    { kind: "tool", tool: "read", originalTool: "view", title: "Read src/checkout/summary.ts", file: "src/checkout/summary.ts", input: (d: string) => ({ filePath: join(d, "src/checkout/summary.ts") }), output: "export function summarize(…)" },
    { kind: "text", text: "Checkout is three small layers:\n\n```mermaid\nflowchart LR\n  UI[CartSummary.tsx] --> S[checkout/summary.ts]\n  S --> C[cart.ts]\n  UI --> A[api/orders.ts]\n```\n\n1. **`cart.ts`** holds the pricing rules: subtotal, coupon, tax.\n2. **`checkout/summary.ts`** turns a cart into display numbers.\n3. **`api/orders.ts`** posts the final order to the backend.\n\nPricing lives in one place, so a fix in `cart.ts` reaches both the UI and the order request." },
  ],
};

const unitTests: Scenario = {
  match: /unit tests?/i,
  tokens: { input: 6_540, output: 1_010 }, cost: 0.018,
  steps: [
    { kind: "tool", tool: "read", originalTool: "read", title: "Read src/components/CartSummary.tsx", file: "src/components/CartSummary.tsx", input: (d: string) => ({ filePath: join(d, "src/components/CartSummary.tsx") }), output: "export function CartSummary(…)" },
    { kind: "tool", tool: "write", originalTool: "write", title: "Write src/components/CartSummary.test.tsx", file: "src/components/CartSummary.test.tsx", input: (d: string) => ({ filePath: join(d, "src/components/CartSummary.test.tsx"), content: "import { render, screen } from \"@testing-library/react\";\n…" }), output: "Created file" },
    { kind: "tool", tool: "shell", originalTool: "bash", title: "npx vitest run CartSummary", input: { command: "npx vitest run CartSummary" }, output: " ✓ src/components/CartSummary.test.tsx (4 tests) 21ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)" },
    { kind: "text", text: "Added four tests for `CartSummary`: item count, subtotal formatting, the coupon line, and the empty cart. All pass." },
  ],
};

const upgrade: Scenario = {
  match: /typescript/i,
  tokens: { input: 11_900, output: 930 }, cost: 0.024,
  steps: [
    { kind: "tool", tool: "shell", originalTool: "exec_command", title: "npm i -D typescript@5.9", input: { command: "npm i -D typescript@5.9" }, output: "changed 1 package in 2s" },
    { kind: "tool", tool: "shell", originalTool: "exec_command", title: "npx tsc --noEmit", input: { command: "npx tsc --noEmit" }, output: "src/main.tsx(4,46): error TS2322: Type 'never[]' is not assignable to type 'CartItem[]'." },
    { kind: "tool", tool: "edit", originalTool: "apply_patch", title: "Edit src/main.tsx", file: "src/main.tsx", input: (d: string) => ({ filePath: join(d, "src/main.tsx") }), output: "Updated src/main.tsx",
      diff: "--- a/src/main.tsx\n+++ b/src/main.tsx\n@@ -1,4 +1,6 @@\n import { createRoot } from \"react-dom/client\";\n import { CartSummary } from \"./components/CartSummary\";\n+import type { CartItem } from \"./cart\";\n \n-createRoot(document.getElementById(\"root\")!).render(<CartSummary items={[]} />);\n+const items: CartItem[] = [];\n+createRoot(document.getElementById(\"root\")!).render(<CartSummary items={items} />);" },
    { kind: "text", text: "TypeScript is on 5.9. The only new error was an untyped empty array in `main.tsx`; it is now typed and `tsc` passes." },
  ],
};

const fallback: Scenario = {
  match: /.*/,
  tokens: { input: 1_200, output: 160 }, cost: 0.003,
  steps: [{ kind: "text", text: "Sure. Tell me which part of **acme-shop** you'd like to change and I'll take it from there." }],
};

const SCENARIOS = [fixCoupon, validation, explain, unitTests, upgrade];

export function pickScenario(prompt: string): Scenario {
  return SCENARIOS.find((scenario) => scenario.match.test(prompt)) ?? fallback;
}
