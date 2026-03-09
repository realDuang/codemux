import { createSignal, For, Show, Switch, Match } from "solid-js";
import {
  IconDocument,
  IconMagnifyingGlass,
  IconDocumentMagnifyingGlass,
  IconRectangleStack,
} from "./icons";
import { useI18n, formatMessage } from "../lib/i18n";
import type { ToolPart } from "../types/unified";
import styles from "./ContextGroup.module.css";

/** Context tool types that can be grouped */
export const CONTEXT_TOOLS = new Set(["read", "grep", "glob", "list"]);

export interface ContextGroupItem {
  part: ToolPart;
  action: string;
  detail: string;
}

interface ContextGroupProps {
  items: ContextGroupItem[];
  /** Whether this group is still actively receiving new items */
  isStreaming?: boolean;
  /** Start expanded (typically false for completed groups) */
  defaultOpen?: boolean;
}

/** Icon for a context tool type */
function ContextToolIcon(props: { tool: string; size?: number }) {
  const s = props.size ?? 12;
  return (
    <Switch fallback={<IconMagnifyingGlass width={s} height={s} />}>
      <Match when={props.tool === "read"}><IconDocument width={s} height={s} /></Match>
      <Match when={props.tool === "grep"}><IconDocumentMagnifyingGlass width={s} height={s} /></Match>
      <Match when={props.tool === "glob"}><IconMagnifyingGlass width={s} height={s} /></Match>
      <Match when={props.tool === "list"}><IconRectangleStack width={s} height={s} /></Match>
    </Switch>
  );
}

/**
 * ContextGroup — Renders a collapsible group of context-gathering tools.
 *
 * Shows a summary like "Gathered context · 3 files read, 2 searches"
 * or "Gathering context..." while streaming.
 */
export function ContextGroup(props: ContextGroupProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = createSignal(props.defaultOpen ?? false);

  // Count by tool type
  const counts = () => {
    const c = { read: 0, grep: 0, glob: 0, list: 0, total: 0 };
    for (const item of props.items) {
      const tool = item.part.normalizedTool as keyof typeof c;
      if (tool in c) c[tool]++;
      c.total++;
    }
    return c;
  };

  // Build summary string
  const summaryText = () => {
    const c = counts();
    const parts: string[] = [];
    if (c.read > 0) parts.push(`${c.read} file${c.read > 1 ? "s" : ""} read`);
    if (c.grep > 0) parts.push(`${c.grep} search${c.grep > 1 ? "es" : ""}`);
    if (c.glob > 0) parts.push(`${c.glob} glob${c.glob > 1 ? "s" : ""}`);
    if (c.list > 0) parts.push(`${c.list} ls`);
    return parts.join(", ");
  };

  const label = () =>
    props.isStreaming
      ? t().steps.gatheringContext
      : (t().steps.gatheredContext || "Gathered context");

  return (
    <div class={styles.root}>
      <button
        type="button"
        class={styles.trigger}
        onClick={() => setExpanded(!expanded())}
      >
        <span class={styles.icon}>
          <IconMagnifyingGlass width={14} height={14} />
        </span>
        <span class={styles.label}>{label()}</span>
        <Show when={!props.isStreaming && summaryText()}>
          <span class={styles.summary}>· {summaryText()}</span>
        </Show>
        <Show when={props.isStreaming}>
          <span class={styles.streamingDot} />
        </Show>
        <span class={styles.arrow} data-expanded={expanded() ? "" : undefined}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>

      <Show when={expanded()}>
        <div class={styles.list}>
          <For each={props.items}>
            {(item) => (
              <div class={styles.item}>
                <span class={styles.itemIcon}>
                  <ContextToolIcon tool={item.part.normalizedTool} />
                </span>
                <span class={styles.itemAction}>{item.action}</span>
                <span class={styles.itemDetail} title={item.detail}>{item.detail}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
