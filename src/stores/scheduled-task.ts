import { createStore } from "solid-js/store";
import type { ScheduledTask } from "../types/unified";

export const [scheduledTaskStore, setScheduledTaskStore] = createStore<{
  tasks: ScheduledTask[];
  /** Sidebar section collapse state */
  expanded: boolean;
  /** Master switch — when false, hide scheduled tasks UI entirely. */
  enabled: boolean;
}>({
  tasks: [],
  expanded: true,
  enabled: true,
});
