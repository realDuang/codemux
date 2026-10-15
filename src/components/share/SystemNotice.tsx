import type { SystemNoticePart } from "../../types/unified";
import { useI18n } from "../../lib/i18n";
import styles from "./SystemNotice.module.css";

/** Fill {placeholders}; `*At` params are epoch-ms timestamps rendered as local time. */
function interpolateNoticeParams(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    if (value === undefined) return match;
    if (key.endsWith("At") && typeof value === "number") {
      const date = new Date(value);
      const sameDay = date.toDateString() === new Date().toDateString();
      return sameDay
        ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    }
    return String(value);
  });
}

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
      "notice:elicitation_accepted": () => t().steps.elicitationAccepted,
      "notice:elicitation_declined": () => t().steps.elicitationDeclined,
      "notice:elicitation_cancelled": () => t().steps.elicitationCancelled,
      "notice:elicitation_completed": () => t().steps.elicitationCompleted,
      "notice:plan_implementation_pending": () => t().steps.planImplementationPending,
      "notice:plan_implementation_completed": () => t().steps.planImplementationCompleted,
      "notice:stream_reconnecting": () => t().steps.streamReconnecting,
      "notice:session_resumed": () => t().steps.sessionResumed,
      "notice:automatic_approval_review": () => t().steps.automaticApprovalReview,
      "notice:automatic_approval_approved": () => t().steps.automaticApprovalApproved,
      "notice:automatic_approval_denied": () => t().steps.automaticApprovalDenied,
      "notice:automatic_approval_aborted": () => t().steps.automaticApprovalAborted,
      "notice:automatic_approval_timed_out": () => t().steps.automaticApprovalTimedOut,
      "notice:strict_review_required": () => t().steps.strictReviewRequired,
      "notice:auto_review_interrupted": () => t().steps.autoReviewInterrupted,
      "notice:api_retry": () => t().steps.apiRetry,
      "notice:permission_denied": () => t().steps.permissionDenied,
      "notice:rate_limit_warning": () => t().steps.rateLimitWarning,
      "notice:rate_limit_rejected": () => t().steps.rateLimitRejected,
      "notice:rate_limit_rejected_no_reset": () => t().steps.rateLimitRejectedNoReset,
      "notice:compact_failed": () => t().steps.compactFailed,
      "notice:auth_error": () => t().steps.authError,
      "notice:conversation_reset": () => t().steps.conversationReset,
    };
    return interpolateNoticeParams(keyMap[raw]?.() ?? raw, props.part.params);
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
