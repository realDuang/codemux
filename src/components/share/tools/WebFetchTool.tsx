import { Switch, Match } from "solid-js";
import { DateTime } from "luxon";
import { IconGlobeAlt } from "../../icons";
import { Collapsible } from "../../Collapsible";
import { ContentCode } from "../content-code";
import { ContentError } from "../content-error";
import { isExpanded, toggleExpanded } from "../../../stores/message";
import type { ToolProps } from "./tool-utils";
import { ToolDuration, formatErrorString } from "./tool-utils";

export function WebFetchTool(props: ToolProps) {
  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
          <span data-slot="icon" data-icon-color="teal"><IconGlobeAlt width={14} height={14} /></span>
          <span data-slot="name">Fetch</span>
          <span data-slot="target" title={props.state.input?.url}>{props.state.input?.url}</span>
        </div>
        <ToolDuration
          time={DateTime.fromMillis(props.state.time.end)
            .diff(DateTime.fromMillis(props.state.time.start))
            .toMillis()}
        />
        <Collapsible.Arrow />
      </Collapsible.Trigger>

      <Collapsible.Content>
        <div data-component="tool-result">
          <Switch>
            <Match when={props.state.metadata?.error}>
              <ContentError>{formatErrorString(props.state.output)}</ContentError>
            </Match>
            <Match when={props.state.output}>
              <ContentCode
                lang={props.state.input?.format || "text"}
                code={props.state.output}
              />
            </Match>
          </Switch>
        </div>
      </Collapsible.Content>
    </Collapsible>
  );
}
