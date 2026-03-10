import { Show, Switch, Match } from "solid-js";
import { DateTime } from "luxon";
import { IconDocumentMagnifyingGlass } from "../../icons";
import { Collapsible } from "../../Collapsible";
import { ContentText } from "../content-text";
import { useI18n, formatMessage } from "../../../lib/i18n";
import { isExpanded, toggleExpanded } from "../../../stores/message";
import type { ToolProps } from "./tool-utils";
import { ToolDuration } from "./tool-utils";

export function GrepTool(props: ToolProps) {
  const { t } = useI18n();
  const matchCount = () => props.state.metadata?.matches ?? 0;
  
  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
          <span data-slot="icon" data-icon-color="indigo"><IconDocumentMagnifyingGlass width={14} height={14} /></span>
          <span data-slot="name">Grep</span>
          <span data-slot="target" title={props.state.input?.pattern}>
            &ldquo;{props.state.input?.pattern}&rdquo;
          </span>
          <Show when={props.state.status === "completed"}>
            <span data-slot="summary" data-color="dimmed">
              {matchCount() === 1 
                ? formatMessage(t().parts.match, { count: matchCount() })
                : formatMessage(t().parts.matches, { count: matchCount() })}
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
         <Show when={matchCount() > 0 || props.state.output}>
           <div data-component="tool-result">
             <ContentText expand compact text={props.state.output} />
           </div>
         </Show>
       </Collapsible.Content>
    </Collapsible>
  );
}
