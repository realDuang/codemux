import { For, Show } from "solid-js";
import type { UnifiedPermission } from "../types/unified";
import { useI18n } from "../lib/i18n";
import styles from "./InputAreaPermission.module.css";

interface InputAreaPermissionProps {
  permission: UnifiedPermission;
  onRespond: (sessionID: string, permissionID: string, reply: string) => void;
}

/**
 * InputAreaPermission — Permission prompt displayed in the input area.
 * Replaces the inline Tailwind permission cards in Chat.tsx with a
 * dedicated CSS Modules component.
 */
export function InputAreaPermission(props: InputAreaPermissionProps) {
  const { t } = useI18n();

  const handleRespond = (reply: string) => {
    props.onRespond(props.permission.sessionId, props.permission.id, reply);
  };

  // Map option type to variant for styling
  const getVariant = (type: string) => {
    if (type.includes("reject")) return "reject";
    if (type.includes("always")) return "always";
    return "once";
  };

  // Display label
  const getLabel = (opt: { label: string; type: string }) => {
    if (opt.label) return opt.label;
    if (opt.type.includes("reject")) return t().permission.deny;
    if (opt.type.includes("always")) return t().permission.allowAlways;
    return t().permission.allowOnce;
  };

  // Use agent-provided options or fallback defaults
  const options = () => {
    return props.permission.options?.length > 0
      ? props.permission.options
      : [
          { id: "reject", label: t().permission.deny, type: "reject" },
          { id: "always", label: t().permission.allowAlways, type: "accept_always" },
          { id: "once", label: t().permission.allowOnce, type: "accept_once" },
        ];
  };

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

      <p class={styles.title}>{props.permission.title}</p>

      <Show when={props.permission.patterns && props.permission.patterns.length > 0}>
        <p class={styles.patterns}>{props.permission.patterns?.join(", ")}</p>
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
