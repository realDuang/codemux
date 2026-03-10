import { DateTime } from "luxon";
import { IconRobot } from "../../icons/custom";
import { Collapsible } from "../../Collapsible";
import { ContentMarkdown } from "../content-markdown";
import { isExpanded, toggleExpanded } from "../../../stores/message";
import type { ToolProps } from "./tool-utils";
import { ToolDuration } from "./tool-utils";

export function TaskTool(props: ToolProps) {
  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
          <span data-slot="icon" data-icon-color="blue"><IconRobot width={14} height={14} /></span>
          <span data-slot="name">Task</span>
          <span data-slot="target">{props.state.input.description}</span>
        </div>
        <ToolDuration
          time={DateTime.fromMillis(props.state.time.end)
            .diff(DateTime.fromMillis(props.state.time.start))
            .toMillis()}
        />
        <Collapsible.Arrow />
      </Collapsible.Trigger>

      <Collapsible.Content>
        <div data-component="tool-input">
          &ldquo;{props.state.input.prompt}&rdquo;
        </div>
        <div data-component="tool-output">
           <ContentMarkdown expand text={props.state.output} />
        </div>
      </Collapsible.Content>
    </Collapsible>
  );
}
