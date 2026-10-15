import { Show, createMemo } from "solid-js";
import { DateTime } from "luxon";
import { IconDocument } from "../../icons";
import { useI18n, formatMessage } from "../../../lib/i18n";
import type { ToolProps } from "./tool-utils";
import { ToolDuration, stripWorkingDirectory } from "./tool-utils";
import { Collapsible } from "../../Collapsible";
import { ContentText } from "../content-text";
import { isExpanded, toggleExpanded } from "../../../stores/message";

export function ReadTool(props: ToolProps) {
  const { t } = useI18n();
  const output = createMemo(() => typeof props.state.output === "string"
    ? props.state.output : props.state.output == null ? "" : JSON.stringify(props.state.output, null, 2));
  const filePath = createMemo(() =>
    stripWorkingDirectory(props.state.input?.filePath, props.message.workingDirectory),
  );
  const lineCount = createMemo(() => {
    const lines = props.state.metadata?.lines;
    if (typeof lines === "number") return lines;
    if (output()) {
      return output().split("\n").length;
    }
    return null;
  });

  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger disabled={!output()}>
      <div data-component="tool-title">
        <span data-slot="icon" data-icon-color="indigo"><IconDocument width={14} height={14} /></span>
        <span data-slot="name">{t().parts.readFile}</span>
        <span data-slot="target" title={props.state.input?.filePath}>
          {filePath()}
        </span>
        <Show when={lineCount() !== null}>
          <span data-slot="summary" data-color="dimmed">
            {formatMessage(t().parts.lines, { count: lineCount() })}
          </span>
        </Show>
        <Show when={props.state.metadata?.error}>
          <span data-slot="error" data-color="red">
            {t().common.error}
          </span>
        </Show>
      </div>
      <ToolDuration
        time={DateTime.fromMillis(props.state.time.end)
          .diff(DateTime.fromMillis(props.state.time.start))
          .toMillis()}
      />
      <Show when={output()}><Collapsible.Arrow /></Show>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <ContentText expand compact text={output()} />
      </Collapsible.Content>
    </Collapsible>
  );
}
