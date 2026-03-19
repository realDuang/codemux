/**
 * Notification system — signal-based store for toast notifications.
 * Provides a simple API to show transient error/warning/info messages.
 */

import { createSignal } from "solid-js";

export type NotificationType = "error" | "warning" | "info";

export interface Notification {
  id: number;
  type: NotificationType;
  message: string;
  duration: number;
}

const [notifications, setNotifications] = createSignal<Notification[]>([]);
let nextId = 0;

/**
 * Show a toast notification. Auto-dismisses after `duration` ms (default 5000).
 */
export function notify(
  message: string,
  type: NotificationType = "error",
  duration = 5000,
): void {
  const id = nextId++;
  setNotifications((prev) => [...prev, { id, type, message, duration }]);
  setTimeout(() => dismiss(id), duration);
}

/** Manually dismiss a notification. */
export function dismiss(id: number): void {
  setNotifications((prev) => prev.filter((n) => n.id !== id));
}

/** Reactive accessor for current notifications. */
export { notifications };
