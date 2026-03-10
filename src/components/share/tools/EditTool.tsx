import { Show, Switch, Match, createMemo } from "solid-js";
import { DateTime } from "luxon";
import { IconPencilSquare } from "../../icons";
import { Collapsible } from "../../Collapsible";
import { ContentDiff } from "../content-diff";
import { ContentError } from "../content-error";
import { isExpanded, toggleExpanded } from "../../../stores/message";
import type { ToolProps } from "./tool-utils";
import { ToolDuration, stripWorkingDirectory, getShikiLang, getDiagnostics, formatErrorString } from "./tool-utils";

export function EditTool(props: ToolProps) {
  const filePath = createMemo(() =>
    stripWorkingDirectory(props.state.input?.filePath, props.message.workingDirectory),
  );
  const diagnostics = createMemo(() =>
    getDiagnostics(
      props.state.metadata?.diagnostics,
      props.state.input?.filePath,
    ),
  );

  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
          <span data-slot="icon" data-icon-color="amber"><IconPencilSquare width={14} height={14} /></span>
          <span data-slot="name">Edit</span>
          <span data-slot="target" title={props.state.input?.filePath}>
            {filePath()}
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
            <Match when={props.state.metadata?.error}>
              <ContentError>
                {formatErrorString(props.state.metadata?.message || "")}
              </ContentError>
            </Match>
            <Match when={props.state.metadata?.diff}>
              <div data-component="diff">
                <ContentDiff
                  diff={props.state.metadata?.diff}
                />
              </div>
            </Match>
          </Switch>
        </div>
        <Show when={diagnostics().length > 0}>
          <ContentError>{diagnostics()}</ContentError>
        </Show>
      </Collapsible.Content>
    </Collapsible>
  );
}
