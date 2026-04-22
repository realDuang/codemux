import { For, Show } from "solid-js";
import { parsePatch } from "diff";
import type { UnifiedPermission, PermissionDetail } from "../types/unified";
import { useI18n } from "../lib/i18n";
import { getPermissionTargets } from "./input-area-context";
import { ContentDiff } from "./share/content-diff";
import styles from "./InputAreaPermission.module.css";

interface InputAreaPermissionProps {
  permission: UnifiedPermission;
  onRespond: (sessionID: string, permissionID: string, reply: string) => void;
}

const MAX_VISIBLE_TARGETS = 4;

/** SVG icon paths keyed by permission kind + toolName */
const KIND_ICONS: Record<string, string> = {
  web_fetch: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z",
  web_search: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z",
  shell: "M4 17l6-6-6-6M12 19h8",
  edit: "M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z",
  read: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M16 13H8M16 17H8M10 9H8",
};

function getKindIcon(kind: string, toolName?: string): string {
  if (toolName && KIND_ICONS[toolName]) return KIND_ICONS[toolName];
  if (kind === "edit") return KIND_ICONS.edit;
  if (kind === "read") return KIND_ICONS.read;
  return "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z";
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

  const kindLabel = () => {
    const toolName = props.permission.toolName;
    if (toolName === "web_fetch") return t().permission.kindUrlAccess;
    if (toolName === "web_search") return t().permission.kindWebSearch;
    if (toolName === "shell") return t().permission.kindShell;
    switch (props.permission.kind) {
      case "read":
        return t().permission.kindRead;
      case "edit":
        return t().permission.kindEdit;
      default:
        return t().permission.kindOther;
    }
  };

  const targets = () => getPermissionTargets(props.permission);
  const visibleTargets = () => targets().slice(0, MAX_VISIBLE_TARGETS);
  const hiddenTargetCount = () => Math.max(0, targets().length - visibleTargets().length);

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
            <path d={getKindIcon(props.permission.kind, props.permission.toolName)} />
          </svg>
          {kindLabel()}
        </span>
      </div>

      <p class={styles.title}>{props.permission.title}</p>

      <Show when={visibleTargets().length > 0}>
        <div class={styles.contextSection}>
          <div class={styles.contextLabel}>{t().permission.targets}</div>
          <div class={styles.targetList}>
            <For each={visibleTargets()}>
              {(target) => <span class={styles.targetChip}>{target}</span>}
            </For>
            <Show when={hiddenTargetCount() > 0}>
              <span class={styles.targetChip}>+{hiddenTargetCount()}</span>
            </Show>
          </div>
        </div>
      </Show>

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
        {(diff) => {
          const canParseDiff = () => {
            try { return parsePatch(diff()).some(p => p.hunks.length > 0); } catch { return false; }
          };
          return (
            <div class={styles.contextSection}>
              <div class={styles.contextLabel}>{t().permission.diffPreview}</div>
              <Show when={canParseDiff()} fallback={<pre class={styles.preview}>{diff()}</pre>}>
                <div class={styles.diffContainer}>
                  <ContentDiff diff={diff()} />
                </div>
              </Show>
            </div>
          );
        }}
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
