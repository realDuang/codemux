import { createStore } from "solid-js/store";
import type { ScheduledTask } from "../types/unified";

export const [scheduledTaskStore, setScheduledTaskStore] = createStore<{
  tasks: ScheduledTask[];
  loading: boolean;
  /** Sidebar section collapse state */
  expanded: boolean;
}>({
  tasks: [],
  loading: false,
  expanded: true,
});
