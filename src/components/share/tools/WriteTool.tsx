import { Show, Switch, Match, createMemo } from "solid-js";
import { DateTime } from "luxon";
import { IconDocumentPlus } from "../../icons";
import { Collapsible } from "../../Collapsible";
import { ContentCode } from "../content-code";
import { ContentError } from "../content-error";
import { isExpanded, toggleExpanded } from "../../../stores/message";
import type { ToolProps } from "./tool-utils";
import { ToolDuration, stripWorkingDirectory, getShikiLang, getDiagnostics, formatErrorString } from "./tool-utils";

export function WriteTool(props: ToolProps) {
  const filePath = createMemo(() =>
    stripWorkingDirectory(props.state.input?.filePath, props.message.workingDirectory),
  );
  const diagnostics = createMemo(() =>
    getDiagnostics(
      props.state.metadata?.diagnostics,
      props.state.input.filePath,
    ),
  );

  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
          <span data-slot="icon" data-icon-color="emerald"><IconDocumentPlus width={14} height={14} /></span>
          <span data-slot="name">Write</span>
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
        <Show when={diagnostics().length > 0}>
          <ContentError>{diagnostics()}</ContentError>
        </Show>
        <div data-component="tool-result">
          <Switch>
            <Match when={props.state.metadata?.error}>
              <ContentError>{formatErrorString(props.state.output)}</ContentError>
            </Match>
            <Match when={props.state.input?.content}>
               <ContentCode
                 lang={getShikiLang(filePath() || "")}
                 code={props.state.input?.content}
               />
            </Match>
          </Switch>
        </div>
      </Collapsible.Content>
    </Collapsible>
  );
}
