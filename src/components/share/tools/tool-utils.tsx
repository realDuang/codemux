import map from "lang-map";
import { Show, Switch, Match, type JSX } from "solid-js";
import {
  IconSparkles,
  IconGlobeAlt,
  IconDocument,
  IconQueueList,
  IconCommandLine,
  IconDocumentPlus,
  IconPencilSquare,
  IconRectangleStack,
  IconMagnifyingGlass,
  IconDocumentMagnifyingGlass,
} from "../../icons";
import { IconRobot } from "../../icons/custom";
import { formatDuration } from "../common";
import type { UnifiedMessage } from "../../../types/unified";
import type { Diagnostic } from "vscode-languageserver-types";
import { useI18n } from "../../../lib/i18n";

const MIN_DURATION = 2000;

export type ToolProps = {
  id: string;
  tool: string;
  state: any; // Using any to avoid complex type matching for now
  message: UnifiedMessage;
  isLastPart?: boolean;
};

export interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "low" | "medium" | "high";
}

/** Strip the working directory prefix from a file path for display */
export function stripWorkingDirectory(filePath?: string, workingDir?: string) {
  if (filePath === undefined || workingDir === undefined) return filePath;

  const prefix = workingDir.endsWith("/") ? workingDir : workingDir + "/";

  if (filePath === workingDir) {
    return "";
  }

  if (filePath.startsWith(prefix)) {
    return filePath.slice(prefix.length);
  }

  return filePath;
}

/** Map a file extension to its shiki language identifier */
export function getShikiLang(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const langs = map.languages(ext);
  const type = langs?.[0]?.toLowerCase();

  const overrides: Record<string, string> = {
    conf: "shellscript",
  };

  return type ? (overrides[type] ?? type) : "plaintext";
}

/** Extract error diagnostics for a specific file, rendering as JSX elements */
export function getDiagnostics(
  diagnosticsByFile: Record<string, Diagnostic[]>,
  currentFile: string,
): JSX.Element[] {
  const result: JSX.Element[] = [];

  if (
    diagnosticsByFile === undefined ||
    diagnosticsByFile[currentFile] === undefined
  )
    return result;

  for (const d of diagnosticsByFile[currentFile]) {
    if (d.severity !== 1) continue;

    const line = d.range.start.line + 1;
    const column = d.range.start.character + 1;

    result.push(
      <pre>
        <span data-color="red" data-marker="label">
          Error
        </span>
        <span data-color="dimmed" data-separator>
          [{line}:{column}]
        </span>
        <span>{d.message}</span>
      </pre>,
    );
  }

  return result;
}

/** Format an error string into a styled JSX element */
export function formatErrorString(error: string): JSX.Element {
  const { t } = useI18n();
  if (!error) return <></>;
  const errorMarker = "Error: ";
  const startsWithError = error.startsWith(errorMarker);

  return startsWithError ? (
    <pre>
      <span data-color="red" data-marker="label" data-separator>
        {t().common.error}
      </span>
      <span>{error.slice(errorMarker.length)}</span>
    </pre>
  ) : (
    <pre>
      <span data-color="dimmed">{error}</span>
    </pre>
  );
}

/**
 * Converts nested objects/arrays into [path, value] pairs.
 * E.g. {a:{b:{c:1}}, d:[{e:2}, 3]} => [["a.b.c",1], ["d[0].e",2], ["d[1]",3]]
 */
export function flattenToolArgs(obj: any, prefix: string = ""): Array<[string, any]> {
  if (obj == null) return [];
  const entries: Array<[string, any]> = [];

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          const arrayPath = `${path}[${index}]`;
          if (item !== null && typeof item === "object") {
            entries.push(...flattenToolArgs(item, arrayPath));
          } else {
            entries.push([arrayPath, item]);
          }
        });
      } else {
        entries.push(...flattenToolArgs(value, path));
      }
    } else {
      entries.push([path, value]);
    }
  }

  return entries;
}

/** Maps tool name to its corresponding icon */
export function ToolIcon(props: { tool: string }) {
  return (
    <Switch fallback={<IconSparkles width={14} height={14} />}>
      <Match when={props.tool === "bash" || props.tool === "shell"}><IconCommandLine width={14} height={14} /></Match>
      <Match when={props.tool === "edit"}><IconPencilSquare width={14} height={14} /></Match>
      <Match when={props.tool === "write"}><IconDocumentPlus width={14} height={14} /></Match>
      <Match when={props.tool === "read"}><IconDocument width={14} height={14} /></Match>
      <Match when={props.tool === "grep"}><IconDocumentMagnifyingGlass width={14} height={14} /></Match>
      <Match when={props.tool === "glob"}><IconMagnifyingGlass width={14} height={14} /></Match>
      <Match when={props.tool === "list"}><IconRectangleStack width={14} height={14} /></Match>
      <Match when={props.tool === "webfetch" || props.tool === "web_fetch"}><IconGlobeAlt width={14} height={14} /></Match>
      <Match when={props.tool === "task"}><IconRobot width={14} height={14} /></Match>
      <Match when={props.tool === "todowrite" || props.tool === "todoread" || props.tool === "todo"}><IconQueueList width={14} height={14} /></Match>
    </Switch>
  );
}

/** Inline duration badge shown in the trigger row */
export function ToolDuration(props: { time: number }) {
  return (
    <Show when={props.time > MIN_DURATION}>
      <span data-slot="duration" title={`${props.time}ms`}>{formatDuration(props.time)}</span>
    </Show>
  );
}
