import type { SystemNoticePart } from "../../types/unified";
import { useI18n } from "../../lib/i18n";
import styles from "./SystemNotice.module.css";

/** noticeType → icon mapping */
const noticeIcons: Record<string, string> = {
  compact: "⚡",
  info: "ℹ️",
  warning: "⚠️",
};

export function SystemNotice(props: { part: SystemNoticePart }) {
  const { t } = useI18n();

  /** Resolve notice:* i18n keys, fallback to raw text */
  const resolvedText = () => {
    const raw = props.part.text;
    const keyMap: Record<string, () => string> = {
      "notice:context_compressed": () => t().steps.contextCompressed,
      "notice:session_resumed": () => t().steps.sessionResumed,
    };
    return keyMap[raw]?.() ?? raw;
  };

  return (
    <div
      class={styles.systemNotice}
      data-type={props.part.noticeType}
    >
      <span class={styles.noticeIcon}>
        {noticeIcons[props.part.noticeType] ?? "ℹ️"}
      </span>
      <span class={styles.noticeText}>{resolvedText()}</span>
    </div>
  );
}
