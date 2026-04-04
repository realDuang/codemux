import { Show, createMemo } from "solid-js";
import { isExpanded, toggleExpanded } from "../stores/message";
import { formatTokenCount, formatCostWithUnit } from "./share/common";
import { useI18n, formatMessage } from "../lib/i18n";
import type { UnifiedMessage } from "../types/unified";
import styles from "./TokenUsage.module.css";

interface TokenUsageProps {
  /** All assistant messages in this turn — tokens are aggregated */
  messages: UnifiedMessage[];
}

export function TokenUsage(props: TokenUsageProps) {
  const { t } = useI18n();

  const reasoningEffortSuffix = createMemo(() => {
    const firstMsg = props.messages[0];
    return firstMsg?.reasoningEffort ? ` (${firstMsg.reasoningEffort})` : "";
  });

  const usage = () => {
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    let hasTokens = false, hasCost = false, hasCache = false;
    let modelId: string | undefined;
    let costUnit: "usd" | "premium_requests" | undefined;

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
      if (msg.cost != null) { cost += msg.cost; hasCost = true; costUnit = msg.costUnit; }
      if (!modelId && msg.modelId) modelId = msg.modelId;
    }

    if (!hasTokens) return null;
    return { input, output, total: input + output, cacheRead, cacheWrite, cost, hasCache, hasCost, modelId, costUnit };
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
            <span class={styles.totalTokens}>{formatTokenCount(u().total)} {t().tokenUsage.tokens}</span>
            <Show when={u().hasCost}>
              <span class={styles.sep}>·</span>
              <span class={styles.cost}>{formatCostWithUnit(u().cost, u().costUnit)}</span>
            </Show>
            <Show when={u().modelId}>
              <span class={styles.sep}>·</span>
              <span class={styles.model}>{u().modelId}{reasoningEffortSuffix()}</span>
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
                <span class={styles.detailLabel}>{t().tokenUsage.input}</span>
                <span class={styles.detailValue}>{u().input.toLocaleString()}</span>
              </div>
              <div class={styles.detailRow}>
                <span class={styles.detailLabel}>{t().tokenUsage.output}</span>
                <span class={styles.detailValue}>{u().output.toLocaleString()}</span>
              </div>
              <Show when={u().hasCache}>
                <div class={styles.detailRow}>
                  <span class={styles.detailLabel}>{t().tokenUsage.cache}</span>
                  <span class={styles.detailValue}>{formatMessage(t().tokenUsage.cacheReadWrite, { read: u().cacheRead.toLocaleString(), write: u().cacheWrite.toLocaleString() })}</span>
                </div>
              </Show>
              <Show when={u().hasCost}>
                <div class={styles.detailRow}>
                  <span class={styles.detailLabel}>{t().tokenUsage.cost}</span>
                  <span class={styles.detailValue}>{formatCostWithUnit(u().cost, u().costUnit)}</span>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
