import { DateTime } from "luxon";
import { IconCommandLine } from "../../icons";
import { Collapsible } from "../../Collapsible";
import { ContentBash } from "../content-bash";
import { isExpanded, toggleExpanded } from "../../../stores/message";
import type { ToolProps } from "./tool-utils";
import { ToolDuration } from "./tool-utils";

export function BashTool(props: ToolProps) {
  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
           <span data-slot="icon" data-icon-color="green"><IconCommandLine width={14} height={14} /></span>
           <span data-slot="name">Bash</span>
           <span data-slot="target" title={props.state.input.command} style={{ "font-family": "var(--font-mono)", "font-size": "0.75rem" }}>
             {props.state.input.command.length > 50
               ? props.state.input.command.slice(0, 50) + "..."
               : props.state.input.command}
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
         <ContentBash
          command={props.state.input.command}
          output={props.state.metadata?.output ?? props.state.metadata?.stdout}
          description={props.state.metadata?.description}
        />
      </Collapsible.Content>
    </Collapsible>
  );
}
