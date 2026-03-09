import { createSignal, createMemo, createEffect, For, Show, onCleanup } from "solid-js";
import { IconQueueList } from "./icons";
import { useI18n } from "../lib/i18n";
import styles from "./TodoDock.module.css";

interface Todo {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

interface TodoDockProps {
  /** Array of todo items from the latest TodoWrite tool */
  todos: Todo[];
  /** Whether the AI is currently working */
  isWorking: boolean;
}

/**
 * TodoDock — Persistent task list displayed above the input area.
 *
 * Shows todos extracted from the latest TodoWrite tool call.
 * Auto-hides 400ms after all items are completed.
 */
export function TodoDock(props: TodoDockProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = createSignal(true);
  const [hiding, setHiding] = createSignal(false);

  const completedCount = createMemo(() =>
    props.todos.filter((t) => t.status === "completed").length
  );

  const totalCount = createMemo(() => props.todos.length);

  const allCompleted = createMemo(() =>
    totalCount() > 0 && completedCount() === totalCount()
  );

  // Auto-hide after all completed (with delay)
  createEffect(() => {
    if (allCompleted() && !props.isWorking) {
      const timer = setTimeout(() => setHiding(true), 400);
      onCleanup(() => clearTimeout(timer));
    } else {
      setHiding(false);
    }
  });

  // Sort: in_progress first, then pending, then completed
  const sortedTodos = createMemo(() => {
    const priority: Record<string, number> = {
      in_progress: 0,
      pending: 1,
      completed: 2,
    };
    return [...props.todos].sort(
      (a, b) => (priority[a.status] ?? 1) - (priority[b.status] ?? 1)
    );
  });

  return (
    <Show when={totalCount() > 0}>
      <div class={styles.root} data-hiding={hiding() ? "" : undefined}>
        {/* Header */}
        <button
          type="button"
          class={styles.header}
          onClick={() => setExpanded(!expanded())}
        >
          <span class={styles.headerIcon}>
            <IconQueueList width={14} height={14} />
          </span>
          <span class={styles.headerLabel}>
            {t().parts.todoTitle || "Tasks"}
          </span>
          <span class={styles.headerCount}>
            {completedCount()}/{totalCount()}
          </span>
          <span class={styles.headerArrow} data-expanded={expanded() ? "" : undefined}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </span>
        </button>

        {/* Todo list */}
        <Show when={expanded()}>
          <div class={styles.list}>
            <For each={sortedTodos()}>
              {(todo) => (
                <div class={styles.item} data-status={todo.status}>
                  <span class={styles.checkbox}>
                    <Show when={todo.status === "completed"}>
                      <svg class={styles.checkIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </Show>
                    <Show when={todo.status === "in_progress"}>
                      <span class={styles.progressDot} />
                    </Show>
                  </span>
                  <span class={styles.itemText}>{todo.content}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
