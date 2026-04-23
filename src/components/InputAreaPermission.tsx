import { For, Show } from "solid-js";
import type { UnifiedPermission, PermissionDetail } from "../types/unified";
import { useI18n } from "../lib/i18n";
import { getKindIconPath } from "./icons/permission-icons";
import { ContentDiff } from "./share/content-diff";
import styles from "./InputAreaPermission.module.css";

interface InputAreaPermissionProps {
  permission: UnifiedPermission;
  onRespond: (sessionID: string, permissionID: string, reply: string) => void;
}

/**
 * InputAreaPermission — Permission prompt displayed in the input area.
 * Renders adapter-provided `details[]` for structured display and
 * uses `ContentDiff` for syntax-highlighted diff previews.
 */
export function InputAreaPermission(props: InputAreaPermissionProps) {
  const { t } = useI18n();

  const handleRespond = (reply: string) => {
    props.onRespond(props.permission.sessionId, props.permission.id, reply);
  };

  const getVariant = (type: string) => {
    if (type.includes("reject")) return "reject";
    if (type.includes("always")) return "always";
    return "once";
  };

  const getLabel = (opt: { label: string; type: string }) => {
    if (opt.label) return opt.label;
    if (opt.type.includes("reject")) return t().permission.deny;
    if (opt.type.includes("always")) return t().permission.allowAlways;
    return t().permission.allowOnce;
  };

  const options = () => {
    return props.permission.options?.length > 0
      ? props.permission.options
      : [
          { id: "reject", label: t().permission.deny, type: "reject" },
          { id: "always", label: t().permission.allowAlways, type: "accept_always" },
          { id: "once", label: t().permission.allowOnce, type: "accept_once" },
        ];
  };

  const TOOL_KIND_LABELS: Record<string, () => string> = {
    web_fetch: () => t().permission.kindUrlAccess,
    web_search: () => t().permission.kindWebSearch,
    shell: () => t().permission.kindShell,
  };

  const kindLabel = () => {
    const toolName = props.permission.toolName;
    if (toolName && TOOL_KIND_LABELS[toolName]) return TOOL_KIND_LABELS[toolName]();
    switch (props.permission.kind) {
      case "read": return t().permission.kindRead;
      case "edit": return t().permission.kindEdit;
      default: return t().permission.kindOther;
    }
  };

  const details = () => props.permission.details ?? [];

  return (
    <div class={styles.root}>
      <div class={styles.header}>
        <span class={styles.headerIcon}>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 9v4" /><path d="M12 17h.01" /><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          </svg>
        </span>
        <span class={styles.headerLabel}>{t().permission.waitingApproval}</span>
      </div>

      <div class={styles.meta}>
        <span class={styles.metaBadge}>
          <svg class={styles.kindIcon} xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d={getKindIconPath(props.permission.kind, props.permission.toolName)} />
          </svg>
          {kindLabel()}
        </span>
      </div>

      <p class={styles.title}>{props.permission.title}</p>

      <Show when={details().length > 0}>
        <div class={styles.contextSection}>
          <For each={details()}>
            {(detail: PermissionDetail) => (
              <div class={styles.detailRow}>
                <div class={styles.detailLabel}>{detail.label}</div>
                <div
                  class={styles.detailValue}
                  classList={{ [styles.detailMono]: !!detail.mono }}
                >
                  {detail.value}
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.permission.diff}>
        {(diff) => (
          <div class={styles.contextSection}>
            <div class={styles.contextLabel}>{t().permission.diffPreview}</div>
            <div class={styles.diffContainer}>
              <ContentDiff diff={diff()} />
            </div>
          </div>
        )}
      </Show>

      <div class={styles.actions}>
        <For each={options()}>
          {(opt) => (
            <button
              type="button"
              class={styles.btn}
              data-variant={getVariant(opt.type)}
              onClick={() => handleRespond(opt.id)}
            >
              {getLabel(opt)}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
