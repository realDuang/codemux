import { createMemo, createSignal, createUniqueId, Index, Show, Switch, Match } from "solid-js";
import {
  IconDocument,
  IconMagnifyingGlass,
  IconDocumentMagnifyingGlass,
  IconRectangleStack,
} from "./icons";
import { formatMessage, useI18n } from "../lib/i18n";
import type { ToolPart } from "../types/unified";
import styles from "./ContextGroup.module.css";

/** Context tool types that can be grouped. */
export const CONTEXT_TOOLS = new Set(["read", "grep", "glob", "list"]);

export interface ContextGroupItem {
  part: ToolPart;
  action: string;
  detail: string;
}

interface ContextGroupProps {
  items: ContextGroupItem[];
  isStreaming?: boolean;
  defaultOpen?: boolean;
}

function ContextToolIcon(props: { tool: string }) {
  return (
    <Switch fallback={<IconMagnifyingGlass width={14} height={14} />}>
      <Match when={props.tool === "read"}><IconDocument width={14} height={14} /></Match>
      <Match when={props.tool === "grep"}><IconDocumentMagnifyingGlass width={14} height={14} /></Match>
      <Match when={props.tool === "list"}><IconRectangleStack width={14} height={14} /></Match>
    </Switch>
  );
}

function formatDetail(value: unknown): string {
  if (typeof value === "string") return value;
  return value == null ? "" : JSON.stringify(value, null, 2);
}

function toolError(part: ToolPart): string {
  if (part.state.status === "error") return part.state.error;
  if (part.state.status !== "completed" || !part.state.metadata || typeof part.state.metadata !== "object") return "";
  const metadata = part.state.metadata as Record<string, unknown>;
  if (!metadata.error) return "";
  return formatDetail(metadata.message ?? metadata.error);
}

/** Compact context summary; every item retains its input, output and error details. */
export function ContextGroup(props: ContextGroupProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = createSignal(props.defaultOpen ?? false);
  const [itemExpanded, setItemExpanded] = createSignal<Record<string, boolean>>({});
  const groupId = createUniqueId();
  const active = createMemo(() => props.isStreaming || props.items.some(({ part }) =>
    part.state.status === "pending" || part.state.status === "running"));
  const errors = createMemo(() => props.items.map(({ part }) => toolError(part)).filter(Boolean));
  const label = () => active() ? t().steps.gatheringContext : t().steps.gatheredContext;
  const statusLabel = (part: ToolPart) => {
    if (toolError(part)) return t().common.error;
    switch (part.state.status) {
      case "pending": return t().parts.toolPending;
      case "running": return t().common.running;
      case "completed": return t().parts.toolCompleted;
      case "error": return t().common.error;
    }
  };

  return (
    <div class={styles.root} data-component="context-group">
      <button
        type="button"
        id={groupId + "-trigger"}
        class={styles.trigger}
        aria-expanded={expanded()}
        aria-controls={groupId + "-content"}
        onClick={() => setExpanded(!expanded())}
      >
        <span class={styles.icon} aria-hidden="true"><IconMagnifyingGlass width={14} height={14} /></span>
        <span class={styles.label}>{label()}</span>
        <span class={styles.summary}>{formatMessage(t().parts.toolUses, { count: props.items.length })}</span>
        <Show when={errors().length > 0}><span class={styles.errorStatus}>{t().common.error}</span></Show>
        <Show when={active()}><span class={styles.streamingDot} aria-hidden="true" /></Show>
        <span class={styles.arrow} data-expanded={expanded() ? "" : undefined} aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      <Show when={!expanded() && errors().length > 0}>
        <pre class={styles.error}>{errors().join("\n\n")}</pre>
      </Show>
      <div id={groupId + "-content"} hidden={!expanded()} aria-labelledby={groupId + "-trigger"}>
        <Show when={expanded()}>
          <div class={styles.list}>
            <Index each={props.items}>
              {(item) => {
                const state = () => item().part.state;
                const output = () => {
                  const current = state();
                  return current.status === "completed" || current.status === "error" ? formatDetail(current.output) : "";
                };
                return (
                  <div class={styles.item}>
                    <details
                      open={itemExpanded()[item().part.id] ?? false}
                      onToggle={(event) => {
                        const open = event.currentTarget.open;
                        setItemExpanded((previous) => ({ ...previous, [item().part.id]: open }));
                      }}
                    >
                      <summary class={styles.itemTrigger}>
                        <span class={styles.itemIcon} aria-hidden="true"><ContextToolIcon tool={item().part.normalizedTool} /></span>
                        <span class={styles.itemAction}>{item().action}</span>
                        <span class={styles.itemDetail} title={item().detail}>{item().detail}</span>
                        <span class={styles.itemStatus} data-error={toolError(item().part) ? "" : undefined}>{statusLabel(item().part)}</span>
                        <span class={styles.itemArrow} aria-hidden="true">›</span>
                      </summary>
                      <div class={styles.itemBody}>
                        <Show when={item().part.title && item().part.title !== item().detail}>
                          <p class={styles.itemTitle}>{item().part.title}</p>
                        </Show>
                        <Show when={state().input != null}>
                          <section aria-label={t().parts.toolInput}>
                            <div class={styles.detailLabel}>{t().parts.toolInput}</div>
                            <pre class={styles.detailText}>{formatDetail(state().input)}</pre>
                          </section>
                        </Show>
                        <Show when={output()}>
                          <section aria-label={t().parts.toolOutput}>
                            <div class={styles.detailLabel}>{t().parts.toolOutput}</div>
                            <pre class={styles.detailText}>{output()}</pre>
                          </section>
                        </Show>
                      </div>
                    </details>
                    <Show when={toolError(item().part)}><pre class={styles.error}>{toolError(item().part)}</pre></Show>
                  </div>
                );
              }}
            </Index>
          </div>
        </Show>
      </div>
    </div>
  );
}
