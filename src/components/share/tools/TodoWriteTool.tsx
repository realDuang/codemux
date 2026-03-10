import { For, Show, Switch, Match, createMemo } from "solid-js";
import { DateTime } from "luxon";
import { IconQueueList } from "../../icons";
import { Collapsible } from "../../Collapsible";
import { useI18n } from "../../../lib/i18n";
import { messageStore, setExpanded } from "../../../stores/message";
import type { ToolProps, Todo } from "./tool-utils";
import { ToolDuration } from "./tool-utils";

export function TodoWriteTool(props: ToolProps) {
  const { t } = useI18n();
  const priority: Record<Todo["status"], number> = {
    in_progress: 0,
    pending: 1,
    completed: 2,
  };
  const todos = createMemo(() =>
    ((props.state.input?.todos ?? []) as Todo[])
      .slice()
      .sort((a, b) => priority[a.status] - priority[b.status]),
  );
  const starting = () => todos().every((t: Todo) => t.status === "pending");
  const finished = () => todos().every((t: Todo) => t.status === "completed");

  const expandedKey = () => `todowrite-${props.id}`;
  const expanded = () => messageStore.expanded[expandedKey()] ?? false;

  return (
    <Collapsible open={expanded()} onOpenChange={() => setExpanded(expandedKey(), !expanded())}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
          <span data-slot="icon" data-icon-color="violet"><IconQueueList width={14} height={14} /></span>
          <span data-slot="name">
            <Switch fallback={t().parts.updatingPlan}>
              <Match when={starting()}>{t().parts.creatingPlan}</Match>
              <Match when={finished()}>{t().parts.completingPlan}</Match>
            </Switch>
          </span>
        </div>
        <ToolDuration
          time={DateTime.fromMillis(props.state.time.end)
            .diff(DateTime.fromMillis(props.state.time.start))
            .toMillis()}
        />
        <Collapsible.Arrow />
      </Collapsible.Trigger>

      <Collapsible.Content>
        <Show when={todos().length > 0}>
          <ul data-component="todos">
            <For each={todos()}>
              {(todo) => (
                <li data-slot="item" data-status={todo.status}>
                  <span></span>
                  {todo.content}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Collapsible.Content>
    </Collapsible>
  );
}
