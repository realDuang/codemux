// Creates the small sample repository the README demo works on.

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CART_TS = `export interface CartItem {
  sku: string;
  name: string;
  price: number;
  quantity: number;
}

export interface Coupon {
  code: string;
  percentOff: number;
}

export function subtotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function applyCoupon(amount: number, coupon?: Coupon): number {
  if (!coupon) return amount;
  return amount * (1 - coupon.percentOff / 100);
}

export function cartTotal(items: CartItem[], coupon?: Coupon, taxRate = 0.08): number {
  const discounted = applyCoupon(subtotal(items), coupon);
  const taxed = applyCoupon(discounted * (1 + taxRate), coupon);
  return Math.round(taxed * 100) / 100;
}
`;

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "acme-shop", version: "0.4.2", private: true, type: "module",
    scripts: { dev: "vite", build: "tsc && vite build", test: "vitest run" },
    dependencies: { react: "^19.1.0", "react-dom": "^19.1.0", zod: "^3.25.0" },
    devDependencies: { typescript: "^5.8.3", vite: "^7.0.0", vitest: "^3.2.0" },
  }, null, 2) + "\n",
  "README.md": "# Acme Shop\n\nA small storefront used to try out coding agents.\n\n```bash\nnpm install\nnpm run dev\n```\n",
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, jsx: "react-jsx" }, include: ["src"] }, null, 2) + "\n",
  "src/cart.ts": CART_TS,
  "src/cart.test.ts": `import { describe, expect, it } from "vitest";
import { cartTotal, subtotal } from "./cart";

const items = [
  { sku: "TEE-01", name: "Logo tee", price: 25, quantity: 2 },
  { sku: "MUG-02", name: "Mug", price: 12.5, quantity: 4 },
];

describe("cart", () => {
  it("sums line items", () => {
    expect(subtotal(items)).toBe(100);
  });

  it("adds tax", () => {
    expect(cartTotal(items)).toBe(108);
  });
});
`,
  "src/checkout/summary.ts": `import { cartTotal, subtotal, type CartItem, type Coupon } from "../cart";

export function summarize(items: CartItem[], coupon?: Coupon) {
  return {
    count: items.reduce((n, item) => n + item.quantity, 0),
    subtotal: subtotal(items),
    total: cartTotal(items, coupon),
  };
}
`,
  "src/checkout/summary.test.ts": `import { describe, expect, it } from "vitest";
import { summarize } from "./summary";

describe("summarize", () => {
  it("counts items", () => expect(summarize([{ sku: "A", name: "A", price: 1, quantity: 3 }]).count).toBe(3));
  it("reports the subtotal", () => expect(summarize([{ sku: "A", name: "A", price: 2, quantity: 2 }]).subtotal).toBe(4));
  it("handles an empty cart", () => expect(summarize([]).total).toBe(0));
});
`,
  "src/api/orders.ts": `import type { CartItem } from "../cart";

export interface CreateOrderRequest {
  email: string;
  items: CartItem[];
  couponCode?: string;
}

export async function createOrder(body: CreateOrderRequest) {
  const response = await fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(\`Order failed: \${response.status}\`);
  return response.json();
}
`,
  "src/components/CartSummary.tsx": `import { summarize } from "../checkout/summary";
import type { CartItem, Coupon } from "../cart";

export function CartSummary({ items, coupon }: { items: CartItem[]; coupon?: Coupon }) {
  const { count, subtotal, total } = summarize(items, coupon);
  return (
    <aside className="cart-summary">
      <p>{count} items</p>
      <p>Subtotal: \${subtotal.toFixed(2)}</p>
      {coupon && <p>Coupon {coupon.code}: -{coupon.percentOff}%</p>}
      <strong>Total: \${total.toFixed(2)}</strong>
    </aside>
  );
}
`,
  "src/main.tsx": `import { createRoot } from "react-dom/client";
import { CartSummary } from "./components/CartSummary";

createRoot(document.getElementById("root")!).render(<CartSummary items={[]} />);
`,
};

export async function createDemoProject(directory: string): Promise<void> {
  for (const [path, content] of Object.entries(FILES)) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Alex", "-c", "user.email=alex@example.com", "add", "-A");
  git("-c", "user.name=Alex", "-c", "user.email=alex@example.com", "commit", "-q", "-m", "Initial storefront");
}
