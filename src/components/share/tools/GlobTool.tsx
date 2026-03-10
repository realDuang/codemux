import { Show, Switch, Match } from "solid-js";
import { DateTime } from "luxon";
import { IconMagnifyingGlass } from "../../icons";
import { Collapsible } from "../../Collapsible";
import { ContentText } from "../content-text";
import { useI18n, formatMessage } from "../../../lib/i18n";
import { isExpanded, toggleExpanded } from "../../../stores/message";
import type { ToolProps } from "./tool-utils";
import { ToolDuration } from "./tool-utils";

export function GlobTool(props: ToolProps) {
  const { t } = useI18n();
  const count = () => props.state.metadata?.count ?? 0;

  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
       <Collapsible.Trigger>
          <div data-component="tool-title">
            <span data-slot="icon" data-icon-color="indigo"><IconMagnifyingGlass width={14} height={14} /></span>
            <span data-slot="name">Glob</span>
            <span data-slot="target">
              &ldquo;{props.state.input.pattern}&rdquo;
            </span>
             <Show when={props.state.status === "completed"}>
              <span data-slot="summary" data-color="dimmed">
                {count() === 1
                  ? formatMessage(t().parts.result, { count: count() })
                  : formatMessage(t().parts.results, { count: count() })}
              </span>
            </Show>
          </div>
          <ToolDuration
            time={DateTime.fromMillis(props.state.time.end)
              .diff(DateTime.fromMillis(props.state.time.start))
              .toMillis()}
          />
          <Collapsible.Arrow />
       </Collapsible.Trigger>

       <Collapsible.Content>
        <Switch>
          <Match when={count() > 0 || props.state.output}>
            <div data-component="tool-result">
                 <ContentText expand compact text={props.state.output} />
            </div>
          </Match>
        </Switch>
       </Collapsible.Content>
    </Collapsible>
  );
}
