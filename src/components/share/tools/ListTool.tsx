import { Switch, Match, createMemo } from "solid-js";
import { DateTime } from "luxon";
import { IconRectangleStack } from "../../icons";
import { Collapsible } from "../../Collapsible";
import { ContentText } from "../content-text";
import { isExpanded, toggleExpanded } from "../../../stores/message";
import type { ToolProps } from "./tool-utils";
import { ToolDuration, stripWorkingDirectory } from "./tool-utils";

export function ListTool(props: ToolProps) {
  const path = createMemo(() =>
    props.state.input?.path !== props.message.workingDirectory
      ? stripWorkingDirectory(props.state.input?.path, props.message.workingDirectory)
      : props.state.input?.path,
  );

  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
          <span data-slot="icon" data-icon-color="indigo"><IconRectangleStack width={14} height={14} /></span>
          <span data-slot="name">LS</span>
          <span data-slot="target" title={props.state.input?.path}>
            {path()}
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
        <div data-component="tool-result">
          <Switch>
            <Match when={props.state.output}>
               <ContentText expand compact text={props.state.output} />
            </Match>
          </Switch>
        </div>
      </Collapsible.Content>
    </Collapsible>
  );
}
