import { For, Switch, Match } from "solid-js";
import { DateTime } from "luxon";
import { Collapsible } from "../../Collapsible";
import { ContentText } from "../content-text";
import { isExpanded, toggleExpanded } from "../../../stores/message";
import type { ToolProps } from "./tool-utils";
import { ToolIcon, ToolDuration, flattenToolArgs } from "./tool-utils";

export function FallbackTool(props: ToolProps) {
  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
          <span data-slot="icon" data-icon-color="indigo"><ToolIcon tool={props.tool} /></span>
          <span data-slot="name">{props.tool}</span>
          {props.state.input?.description && (
            <span data-slot="target">{props.state.input.description}</span>
          )}
        </div>
        <ToolDuration
          time={DateTime.fromMillis(props.state.time.end)
            .diff(DateTime.fromMillis(props.state.time.start))
            .toMillis()}
        />
        <Collapsible.Arrow />
      </Collapsible.Trigger>

      <Collapsible.Content>
        <div data-component="tool-args">
          <For each={flattenToolArgs(props.state.input)}>
            {(arg) => (
              <>
                <div></div>
                <div>{arg[0]}</div>
                <div>{arg[1]}</div>
              </>
            )}
          </For>
        </div>
        <Switch>
          <Match when={props.state.output}>
            <div data-component="tool-result">
                <ContentText
                  expand
                  compact
                  text={props.state.output}
                  data-size="sm"
                  data-color="dimmed"
                />
            </div>
          </Match>
        </Switch>
      </Collapsible.Content>
    </Collapsible>
  );
}
