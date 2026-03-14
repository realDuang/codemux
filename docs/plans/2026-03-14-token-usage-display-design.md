# Token Usage Display Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Display per-turn and per-session token usage / cost in the chat UI, using data already available in `UnifiedMessage`.

**Architecture:** Frontend-only (Phase 1). All three engine adapters already populate `UnifiedMessage.tokens` and `cost`. We add formatting utilities, a reusable `TokenUsage` component for per-turn display, and a session status bar in `Chat.tsx`. Graceful degradation — only show fields with data.

**Tech Stack:** SolidJS 1.8, TypeScript 5, CSS Modules, Vitest 4

---

## Context

### Data Already Available

Each `UnifiedMessage` (in `src/types/unified.ts:179-211`) has:
```typescript
tokens?: { input: number; output: number; cache?: { read: number; write: number }; reasoning?: number; };
cost?: number;
modelId?: string;
```

All three engines populate these fields (with caveats — some may be `undefined`).  
Data flows: Engine SDK → adapter → `message.updated` WS broadcast → `messageStore.message[sessionId][]`.

### Existing Patterns to Follow

- **Muted text style**: `SessionTurn.module.css` lines 149-157 — `.duration` uses `color: #9ca3af`, `font-size: 0.6875rem`, dark: `#71717a`
- **Separator**: `.separator` uses `color: #9ca3af`, dark: `#71717a`
- **Expand/collapse**: `isExpanded()` / `toggleExpanded()` from `src/stores/message.ts`
- **Formatting helpers**: `src/components/share/common.tsx` has `formatDuration` etc.
- **Tests**: `vitest.config.ts` — `tests/unit/**/*.test.ts`, env: `node`

---

### Task 1: Token formatting utilities

**Files:**
- Modify: `src/components/share/common.tsx`
- Create: `tests/unit/src/components/share/common.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/unit/src/components/share/common.test.ts
import { describe, it, expect } from "vitest";
import { formatTokenCount, formatCost } from "../../../../../src/components/share/common";

describe("formatTokenCount", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1.0K"],
    [1500, "1.5K"],
    [12345, "12.3K"],
    [999999, "1000.0K"],
    [1000000, "1.0M"],
    [1234567, "1.2M"],
  ] as const)("formats %d as %s", (input, expected) => {
    expect(formatTokenCount(input)).toBe(expected);
  });
});

describe("formatCost", () => {
  it.each([
    [0, "$0.0000"],
    [0.0001, "$0.0001"],
    [0.0182, "$0.0182"],
    [0.5, "$0.5000"],
    [1.2345, "$1.2345"],
    [12.1, "$12.1000"],
  ] as const)("formats %d as %s", (input, expected) => {
    expect(formatCost(input)).toBe(expected);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/src/components/share/common.test.ts`
Expected: FAIL — `formatTokenCount` and `formatCost` not found

**Step 3: Write minimal implementation**

Add to `src/components/share/common.tsx` (after existing exports):

```typescript
/** Format token count: <1000 as-is, ≥1000 as X.XK, ≥1M as X.XM */
export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return (count / 1000).toFixed(1) + "K";
  return (count / 1_000_000).toFixed(1) + "M";
}

/** Format USD cost with 4 decimal places */
export function formatCost(cost: number): string {
  return "$" + cost.toFixed(4);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/src/components/share/common.test.ts`
Expected: PASS (all cases)

**Step 5: Commit**

```bash
git add src/components/share/common.tsx tests/unit/src/components/share/common.test.ts
git commit -m "feat: add formatTokenCount and formatCost utilities

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: TokenUsage component (per-turn display)

**Files:**
- Create: `src/components/TokenUsage.tsx`
- Create: `src/components/TokenUsage.module.css`

**Step 1: Create the component**

```tsx
// src/components/TokenUsage.tsx
import { Show } from "solid-js";
import { isExpanded, toggleExpanded } from "../stores/message";
import { formatTokenCount, formatCost } from "./share/common";
import type { UnifiedMessage } from "../types/unified";
import styles from "./TokenUsage.module.css";

interface TokenUsageProps {
  /** All assistant messages in this turn — tokens are aggregated */
  messages: UnifiedMessage[];
}

export function TokenUsage(props: TokenUsageProps) {
  const usage = () => {
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    let hasTokens = false, hasCost = false, hasCache = false;
    let modelId: string | undefined;

    for (const msg of props.messages) {
      if (!msg.tokens) continue;
      hasTokens = true;
      input += msg.tokens.input ?? 0;
      output += msg.tokens.output ?? 0;
      if (msg.tokens.cache) {
        const r = msg.tokens.cache.read ?? 0;
        const w = msg.tokens.cache.write ?? 0;
        if (r > 0 || w > 0) { hasCache = true; cacheRead += r; cacheWrite += w; }
      }
      if (msg.cost != null) { cost += msg.cost; hasCost = true; }
      if (!modelId && msg.modelId) modelId = msg.modelId;
    }

    if (!hasTokens) return null;
    return { input, output, total: input + output, cacheRead, cacheWrite, cost, hasCache, hasCost, modelId };
  };

  const expandKey = () => {
    const first = props.messages[0];
    return first ? `token-usage-${first.id}` : "";
  };
  const expanded = () => isExpanded(expandKey());
  const handleToggle = () => toggleExpanded(expandKey());

  return (
    <Show when={usage()}>
      {(u) => (
        <div class={styles.tokenUsage}>
          <button type="button" class={styles.summary} onClick={handleToggle}>
            <span class={styles.totalTokens}>{formatTokenCount(u().total)} tokens</span>
            <Show when={u().hasCost}>
              <span class={styles.sep}>·</span>
              <span class={styles.cost}>{formatCost(u().cost)}</span>
            </Show>
            <Show when={u().modelId}>
              <span class={styles.sep}>·</span>
              <span class={styles.model}>{u().modelId}</span>
            </Show>
            <span class={styles.chevron} data-expanded={expanded() ? "" : undefined}>
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
          </button>
          <Show when={expanded()}>
            <div class={styles.details}>
              <div class={styles.detailRow}>
                <span class={styles.detailLabel}>Input</span>
                <span class={styles.detailValue}>{u().input.toLocaleString()}</span>
              </div>
              <div class={styles.detailRow}>
                <span class={styles.detailLabel}>Output</span>
                <span class={styles.detailValue}>{u().output.toLocaleString()}</span>
              </div>
              <Show when={u().hasCache}>
                <div class={styles.detailRow}>
                  <span class={styles.detailLabel}>Cache</span>
                  <span class={styles.detailValue}>{u().cacheRead.toLocaleString()} read / {u().cacheWrite.toLocaleString()} write</span>
                </div>
              </Show>
              <Show when={u().hasCost}>
                <div class={styles.detailRow}>
                  <span class={styles.detailLabel}>Cost</span>
                  <span class={styles.detailValue}>{formatCost(u().cost)}</span>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
```

**Step 2: Create the CSS module**

```css
/* src/components/TokenUsage.module.css */
.tokenUsage {
  margin-top: 0.25rem;
}

.summary {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 0.6875rem;
  color: #9ca3af;
  font-variant-numeric: tabular-nums;
  line-height: 1.25rem;
}
.summary:hover { color: #6b7280; }
:global(.dark) .summary { color: #71717a; }
:global(.dark) .summary:hover { color: #a1a1aa; }

.totalTokens { font-weight: 500; }
.sep { color: #d1d5db; }
:global(.dark) .sep { color: #52525b; }
.cost { /* inherits */ }
.model { max-width: 10rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.chevron {
  display: inline-flex;
  transition: transform 150ms ease;
}
.chevron[data-expanded] { transform: rotate(180deg); }

.details {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: 0.25rem 0 0 0.5rem;
  font-size: 0.6875rem;
  color: #9ca3af;
  font-variant-numeric: tabular-nums;
}
:global(.dark) .details { color: #71717a; }

.detailRow {
  display: flex;
  gap: 0.75rem;
}
.detailLabel {
  min-width: 3rem;
  color: #b0b4ba;
}
:global(.dark) .detailLabel { color: #63636e; }
.detailValue { /* inherits */ }
```

**Step 3: Verify build compiles (no test for UI component in node env)**

Run: `npx tsc --noEmit --pretty`  
Expected: No new errors

**Step 4: Commit**

```bash
git add src/components/TokenUsage.tsx src/components/TokenUsage.module.css
git commit -m "feat: add TokenUsage component for per-turn display

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Wire TokenUsage into SessionTurn

**Files:**
- Modify: `src/components/SessionTurn.tsx` (3 small changes)

**Step 1: Add import (line 22, after existing imports)**

Add after the `import type { UnifiedMessage, ... }` line:
```typescript
import { TokenUsage } from "./TokenUsage";
```

**Step 2: Insert TokenUsage after the response section**

In `SessionTurn.tsx`, after the `{/* Response (last text part) */}` `</Show>` block (around line 994) and before the `{/* Error/Cancelled Banner */}` section (line 996), add:

```tsx
          {/* Per-turn token usage (collapsed by default) */}
          <Show when={!props.isWorking && props.assistantMessages.length > 0}>
            <TokenUsage messages={props.assistantMessages} />
          </Show>
```

**Step 3: Verify build**

Run: `npx tsc --noEmit --pretty`  
Expected: No new errors

**Step 4: Commit**

```bash
git add src/components/SessionTurn.tsx
git commit -m "feat: wire TokenUsage into SessionTurn

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Session usage status bar in Chat.tsx

**Files:**
- Modify: `src/pages/Chat.tsx` (2 changes)

**Step 1: Add import and session usage memo**

Add import at top of `Chat.tsx`:
```typescript
import { formatTokenCount, formatCost } from "../components/share/common";
```

Inside the `Chat` component, add a `createMemo` for session usage (near other memos):

```typescript
  const sessionUsage = createMemo(() => {
    const sid = sessionStore.current;
    if (!sid) return null;
    const messages = messageStore.message[sid] ?? [];
    let input = 0, output = 0, cost = 0;
    let hasTokens = false, hasCost = false;
    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.tokens) continue;
      hasTokens = true;
      input += msg.tokens.input ?? 0;
      output += msg.tokens.output ?? 0;
      if (msg.cost != null) { cost += msg.cost; hasCost = true; }
    }
    return hasTokens ? { input, output, cost: hasCost ? cost : undefined } : null;
  });
```

**Step 2: Add status bar above PromptInput**

In `Chat.tsx`, just before the `<PromptInput` line (line 1680), insert:

```tsx
                    <Show when={sessionUsage()}>
                      {(u) => (
                        <div class="flex items-center justify-center gap-1.5 py-1 text-[11px] tabular-nums" style={{ color: "var(--color-text-tertiary, #9ca3af)" }}>
                          <span>Session:</span>
                          <span>↑{formatTokenCount(u().input)}</span>
                          <span>↓{formatTokenCount(u().output)}</span>
                          <span>tokens</span>
                          <Show when={u().cost != null}>
                            <span style={{ color: "var(--color-text-quaternary, #d1d5db)" }}>·</span>
                            <span>{formatCost(u().cost!)}</span>
                          </Show>
                        </div>
                      )}
                    </Show>
```

**Step 3: Verify build**

Run: `npx tsc --noEmit --pretty`  
Expected: No new errors

**Step 4: Commit**

```bash
git add src/pages/Chat.tsx
git commit -m "feat: add session token usage status bar above input

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Run full test suite and verify

**Step 1: Run all unit tests**

Run: `bun run test:unit`
Expected: All existing tests pass, new `common.test.ts` passes

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Final commit (if any fixes needed)**

---

## Summary of Changes

| File | Action | Description |
|------|--------|-------------|
| `src/components/share/common.tsx` | Modify | Add `formatTokenCount()` + `formatCost()` |
| `tests/unit/src/components/share/common.test.ts` | Create | Tests for formatting utilities |
| `src/components/TokenUsage.tsx` | Create | Per-turn token display component |
| `src/components/TokenUsage.module.css` | Create | Styles for TokenUsage |
| `src/components/SessionTurn.tsx` | Modify | Import + render `<TokenUsage>` after response |
| `src/pages/Chat.tsx` | Modify | Import formatters + add `sessionUsage` memo + status bar |

## Not In Scope (Phase 1)

- Backend aggregation / gateway-level usage tracking
- Settings page with historical usage stats
- Per-engine / per-model usage breakdown
- Token budget alerts / limits
- Persistent usage history across sessions
