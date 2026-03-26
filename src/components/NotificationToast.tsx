/**
 * NotificationToast — renders stacked toast notifications.
 * Positioned at the bottom-right of the viewport.
 */

import { For } from "solid-js";
import { notifications, dismiss, type NotificationType } from "../lib/notifications";
import { useI18n } from "../lib/i18n";

const typeStyles: Record<NotificationType, string> = {
  error: "bg-red-600 text-white",
  warning: "bg-yellow-500 text-gray-900",
  info: "bg-blue-600 text-white",
};

const typeIcons: Record<NotificationType, string> = {
  error: "✕",
  warning: "⚠",
  info: "ℹ",
};

export function NotificationToast() {
  const { t } = useI18n();
  return (
    <div class="fixed bottom-4 right-4 z-[10000] flex flex-col-reverse gap-2 max-w-sm pointer-events-none">
      <For each={notifications()}>
        {(n) => (
          <div
            class={`pointer-events-auto flex items-start gap-2 px-4 py-3 rounded-lg shadow-lg text-sm ${typeStyles[n.type]} animate-[toast-in_0.25s_ease-out]`}
          >
            <span class="font-bold text-base leading-5 shrink-0">{typeIcons[n.type]}</span>
            <span class="flex-1 break-words leading-5">{n.message}</span>
            <button
              class="shrink-0 opacity-70 hover:opacity-100 ml-2 text-base leading-5 cursor-pointer"
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
          from { opacity: 0; transform: translateY(100%); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
