/**
 * NotificationToast — renders stacked toast notifications.
 * Positioned at the bottom-right of the viewport.
 */

import { For } from "solid-js";
import { notifications, dismiss, type NotificationType } from "../lib/notifications";
import { useI18n } from "../lib/i18n";

// Glass toasts: neutral surface, a coloured status dot carries the type.
const typeStyles: Record<NotificationType, string> = {
  error: "text-red-500",
  warning: "text-amber-500",
  info: "text-indigo-500 dark:text-indigo-400",
};

const typeIcons: Record<NotificationType, string> = {
  error: "✕",
  warning: "⚠",
  info: "ℹ",
};

export function NotificationToast() {
  const { t } = useI18n();
  return (
    <div data-component="notification-toasts" class="fixed bottom-4 right-4 z-[10000] flex flex-col gap-2 max-w-sm pointer-events-none">
      <For each={notifications()}>
        {(n) => (
          <div
            class={`pointer-events-auto flex items-start gap-2.5 pl-3 pr-2.5 py-2.5 rounded-xl text-[13px] text-gray-800 dark:text-gray-100 bg-[var(--cm-surface)]/90 dark:bg-[var(--cm-surface-2)]/90 backdrop-blur-xl ring-1 ring-[var(--cm-hairline-strong)] shadow-[var(--cm-shadow-lg)] animate-[toast-in_0.25s_ease-out]`}
          >
            <span class={`mt-[3px] w-[18px] h-[18px] rounded-md flex items-center justify-center shrink-0 text-[11px] font-bold bg-current/10 ${typeStyles[n.type]}`}>
              <span class="text-current">{typeIcons[n.type]}</span>
            </span>
            <span class="flex-1 break-words leading-6">{n.message}</span>
            <button
              class="shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-900/5 dark:hover:bg-white/10 text-base leading-5 cursor-pointer"
              onClick={() => dismiss(n.id)}
              aria-label={t().question.dismiss}
            >
              ×
            </button>
          </div>
        )}
      </For>
      <style>{`
        @keyframes toast-in {
          from { opacity: 0; transform: translateY(8px) scale(0.98); }
          to { opacity: 1; transform: none; }
        }
      `}</style>
    </div>
  );
}
