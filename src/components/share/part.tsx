import map from "lang-map";
import { DateTime } from "luxon";
import {
  For,
  Show,
  Match,
  Switch,
  type JSX,
  createMemo,
  createSignal,
  type ParentProps,
} from "solid-js";
import {
  IconHashtag,
  IconSparkles,
  IconGlobeAlt,
  IconDocument,
  IconPaperClip,
  IconQueueList,
  IconUserCircle,
  IconCommandLine,
  IconCheckCircle,
  IconChevronDown,
  IconChevronRight,
  IconDocumentPlus,
  IconPencilSquare,
  IconRectangleStack,
  IconMagnifyingGlass,
  IconDocumentMagnifyingGlass,
} from "../icons";
import {
  IconMeta,
  IconRobot,
  IconOpenAI,
  IconGemini,
  IconAnthropic,
  IconBrain,
} from "../icons/custom";
import { Collapsible } from "../Collapsible";
import { ContentCode } from "./content-code";
import { ContentDiff } from "./content-diff";
import { ContentText } from "./content-text";
import { ContentBash } from "./content-bash";
import { ContentError } from "./content-error";
import { formatDuration } from "./common";
import { ContentMarkdown } from "./content-markdown";
import type { UnifiedMessage, UnifiedPart, UnifiedPermission, ToolPart } from "../../types/unified";
import type { Diagnostic } from "vscode-languageserver-types";
import { useI18n, formatMessage } from "../../lib/i18n";
import { logger } from "../../lib/logger";
import { isExpanded, toggleExpanded, messageStore, setExpanded } from "../../stores/message";

import styles from "./part.module.css";

const MIN_DURATION = 2000;

export interface PartProps {
  index: number;
  message: UnifiedMessage;
  part: UnifiedPart;
  last: boolean;
  permission?: UnifiedPermission;
  onPermissionRespond?: (sessionID: string, permissionID: string, reply: string) => void;
}

export function Part(props: PartProps) {
  const { t } = useI18n();
  const [copied, setCopied] = createSignal(false);
  const id = createMemo(() => props.message.id + "-" + props.index);

  return (
    <div
      class={styles.root}
      id={id()}
      data-component="part"
      data-type={props.part.type}
      data-role={props.message.role}
      data-copied={copied() ? true : undefined}
    >
      <div data-component="decoration">
        <div data-slot="anchor" title={t().parts.linkToMessage}>
          <a
            href={`#${id()}`}
            onClick={(e) => {
              e.preventDefault();
              const anchor = e.currentTarget;
              const hash = anchor.getAttribute("href") || "";
              const { origin, pathname, search } = window.location;
              navigator.clipboard
                .writeText(`${origin}${pathname}${search}${hash}`)
                .catch((err) => logger.error("Copy failed", err));

              setCopied(true);
              setTimeout(() => setCopied(false), 3000);
            }}
          >
            <Switch>
              <Match
                when={
                  props.part.type === "step-start" &&
                  props.message.role === "assistant" &&
                  props.message.modelId
                }
              >
                <div title={props.message.modelId}>
                   <ProviderIcon model={props.message.modelId || ""} size={18} />
                </div>
              </Match>
              <Match
                when={
                  props.part.type === "reasoning" &&
                  props.message.role === "assistant"
                }
              >
                <IconBrain width={18} height={18} />
              </Match>
              <Match
                when={
                  props.part.type === "tool" && (props.part as ToolPart).originalTool === "todowrite"
                }
              >
                <IconQueueList width={18} height={18} />
              </Match>
              <Match
                when={
                  props.part.type === "tool" && (props.part as ToolPart).originalTool === "todoread"
                }
              >
                <IconQueueList width={18} height={18} />
              </Match>
              <Match
                when={props.part.type === "tool" && (props.part as ToolPart).originalTool === "bash"}
              >
                <IconCommandLine width={18} height={18} />
              </Match>
              <Match
                when={props.part.type === "tool" && (props.part as ToolPart).originalTool === "edit"}
              >
                <IconPencilSquare width={18} height={18} />
              </Match>
              <Match
                when={props.part.type === "tool" && (props.part as ToolPart).originalTool === "write"}
              >
                <IconDocumentPlus width={18} height={18} />
              </Match>
              <Match
                when={props.part.type === "tool" && (props.part as ToolPart).originalTool === "read"}
              >
                <IconDocument width={18} height={18} />
              </Match>
              <Match
                when={props.part.type === "tool" && (props.part as ToolPart).originalTool === "grep"}
              >
                <IconDocumentMagnifyingGlass width={18} height={18} />
              </Match>
              <Match
                when={props.part.type === "tool" && (props.part as ToolPart).originalTool === "list"}
              >
                <IconRectangleStack width={18} height={18} />
              </Match>
              <Match
                when={props.part.type === "tool" && (props.part as ToolPart).originalTool === "glob"}
              >
                <IconMagnifyingGlass width={18} height={18} />
              </Match>
              <Match
                when={
                  props.part.type === "tool" && (props.part as ToolPart).originalTool === "webfetch"
                }
              >
                <IconGlobeAlt width={18} height={18} />
              </Match>
              <Match
                when={props.part.type === "tool" && (props.part as ToolPart).originalTool === "task"}
              >
                <IconRobot width={18} height={18} />
              </Match>
              <Match when={true}>
                <IconSparkles width={18} height={18} />
              </Match>
            </Switch>
            <IconHashtag width={18} height={18} />
            <IconCheckCircle width={18} height={18} />
          </a>
          <span data-slot="tooltip">{t().common.copied}</span>
        </div>
        <div data-slot="bar"></div>
      </div>
      <div data-component="content">
        {props.message.role === "user" && props.part.type === "text" && (
          <div data-component="user-text">
            <ContentMarkdown text={props.part.text} expand={props.last} />
          </div>
        )}
        {props.message.role === "assistant" && props.part.type === "text" && (
          <div data-component="assistant-text">
            <div data-component="assistant-text-markdown">
              <ContentMarkdown expand={props.last} text={props.part.text} />
            </div>
            {props.last &&
              props.message.role === "assistant" &&
              props.message.time.completed && (
                <Footer
                  title={DateTime.fromMillis(
                    props.message.time.completed,
                  ).toLocaleString(DateTime.DATETIME_FULL_WITH_SECONDS)}
                >
                  {DateTime.fromMillis(
                    props.message.time.completed,
                  ).toLocaleString(DateTime.DATETIME_MED)}
                </Footer>
              )}
          </div>
        )}
        {props.message.role === "assistant" && props.part.type === "reasoning" && (
          <div data-component="reasoning">
             <Collapsible open={isExpanded(`reasoning-${props.part.id}`)} onOpenChange={() => toggleExpanded(`reasoning-${props.part.id}`)}>
                <Collapsible.Trigger>
                   <div data-slot="title">
                      <IconBrain width={14} height={14} />
                      <span>{t().parts.thinking}</span>
                   </div>
                   <Collapsible.Arrow />
                </Collapsible.Trigger>
                <Collapsible.Content>
                    <div data-component="assistant-reasoning-markdown">
                        <ContentMarkdown expand text={props.part.text || t().parts.thinking + "..."} />
                    </div>
                </Collapsible.Content>
             </Collapsible>
          </div>
        )}

        {props.message.role === "user" && props.part.type === "file" && (
          <div data-component="attachment">
            <Show
              when={props.part.mime.startsWith("image/")}
              fallback={
                <>
                  <div data-slot="copy">{t().parts.attachment}</div>
                  <div data-slot="filename">{props.part.filename}</div>
                </>
              }
            >
              <div data-slot="image-container">
                <img
                  src={props.part.url}
                  alt={props.part.filename}
                  data-slot="image"
                  loading="lazy"
                />
                <div data-slot="image-filename">{props.part.filename}</div>
              </div>
            </Show>
          </div>
        )}
        {props.part.type === "step-start" &&
          props.message.role === "assistant" && (
            <div data-component="step-start">
              <div data-slot="provider">{props.message.providerId}</div>
              <div data-slot="model">{props.message.modelId}</div>
            </div>
          )}
        {props.part.type === "tool" && props.part.state.status === "error" && (
          <div data-component="tool" data-tool="error">
            <Collapsible open={isExpanded(`error-${props.part.id}`)} onOpenChange={() => toggleExpanded(`error-${props.part.id}`)} class={styles.root}>
              <Collapsible.Trigger>
                <div data-component="tool-title">
                  <span data-slot="name">Error</span>
                  <span data-slot="target">{(props.part as ToolPart).originalTool}</span>
                </div>
                <Collapsible.Arrow />
              </Collapsible.Trigger>
              <Collapsible.Content>
                <ContentError>
                  {formatErrorString(props.part.state.error)}
                </ContentError>
              </Collapsible.Content>
            </Collapsible>
          </div>
        )}
        {/* Tool with pending permission - show permission prompt */}
        {props.part.type === "tool" && props.permission && (
          <div data-component="tool-permission">
            <div data-component="tool-title" data-waiting>
              <span data-slot="name">{(props.part as ToolPart).originalTool}</span>
              <span data-slot="target">
                {props.part.state.status === "running" && (props.part.state as any).input?.description}
                {props.part.state.status === "running" && (props.part.state as any).input?.filePath}
                {props.part.state.status === "running" && (props.part.state as any).input?.command && 
                  ((props.part.state as any).input.command.length > 50 
                    ? (props.part.state as any).input.command.slice(0, 50) + "..." 
                    : (props.part.state as any).input.command)}
              </span>
            </div>
            <PermissionPrompt
              permission={props.permission}
              onRespond={props.onPermissionRespond}
            />
          </div>
        )}
        {/* Tool running without permission */}
        {props.part.type === "tool" &&
          (props.part.state.status === "pending" || props.part.state.status === "running") &&
          !props.permission &&
          props.message.role === "assistant" && (
            <div data-component="tool-running">
              <div data-component="tool-title" data-running>
                <span data-slot="name">{(props.part as ToolPart).originalTool}</span>
                <Show when={props.part.state.status === "running" && (props.part.state as any).input}>
                  <span data-slot="target">
                    {(props.part.state as any).input?.description}
                    {(props.part.state as any).input?.filePath}
                    {(props.part.state as any).input?.pattern}
                  </span>
                </Show>
                <span data-slot="status">{t().common.running}</span>
              </div>
            </div>
        )}
        {props.part.type === "tool" &&
          props.part.state.status === "completed" &&
          props.message.role === "assistant" && (
            <>
              <div data-component="tool" data-tool={(props.part as ToolPart).originalTool}>
                <Switch>
                  <Match when={(props.part as ToolPart).originalTool === "grep"}>
                    <GrepTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).originalTool}
                      // @ts-ignore
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).originalTool === "glob"}>
                    <GlobTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).originalTool}
                      // @ts-ignore
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).originalTool === "list"}>
                    <ListTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).originalTool}
                      // @ts-ignore
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).originalTool === "read"}>
                    <ReadTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).originalTool}
                      // @ts-ignore
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).originalTool === "write"}>
                    <WriteTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).originalTool}
                      // @ts-ignore
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).originalTool === "edit"}>
                    <EditTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).originalTool}
                      // @ts-ignore
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).originalTool === "bash"}>
                    <BashTool
                      id={props.part.id}
                      tool={(props.part as ToolPart).originalTool}
                      // @ts-ignore
                      state={props.part.state}
                      message={props.message}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).originalTool === "todowrite"}>
                    <TodoWriteTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).originalTool}
                      // @ts-ignore
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).originalTool === "webfetch"}>
                    <WebFetchTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).originalTool}
                      // @ts-ignore
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).originalTool === "task"}>
                    <TaskTool
                      id={props.part.id}
                      tool={(props.part as ToolPart).originalTool}
                      message={props.message}
                      // @ts-ignore
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={true}>
                    <FallbackTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).originalTool}
                      // @ts-ignore
                      state={props.part.state}
                    />
                  </Match>
                </Switch>
              </div>
              <ToolFooter
                // @ts-ignore
                time={DateTime.fromMillis(props.part.state.time.end)
                  // @ts-ignore
                  .diff(DateTime.fromMillis(props.part.state.time.start))
                  .toMillis()}
              />
            </>
          )}
      </div>
    </div>
  );
}

// ... rest of the file ...

type ToolProps = {
  id: string;
  tool: string;
  state: any; // Using any to avoid complex type matching for now
  message: UnifiedMessage;
  isLastPart?: boolean;
};

interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "low" | "medium" | "high";
}

function stripWorkingDirectory(filePath?: string, workingDir?: string) {
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

function getShikiLang(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const langs = map.languages(ext);
  const type = langs?.[0]?.toLowerCase();

  const overrides: Record<string, string> = {
    conf: "shellscript",
  };

  return type ? (overrides[type] ?? type) : "plaintext";
}

function getDiagnostics(
  diagnosticsByFile: Record<string, Diagnostic[]>,
  currentFile: string,
): JSX.Element[] {
  const result: JSX.Element[] = [];

  if (
    diagnosticsByFile === undefined ||
    diagnosticsByFile[currentFile] === undefined
  )
    return result;

  for (const diags of Object.values(diagnosticsByFile)) {
    for (const d of diags) {
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
  }

  return result;
}

function formatErrorString(error: string): JSX.Element {
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


export function TodoWriteTool(props: ToolProps) {
  const { t } = useI18n();
  const priority: Record<Todo["status"], number> = {
    in_progress: 0,
    pending: 1,
    completed: 2,
  };
  const todos = createMemo(() =>
    ((props.state.input?.todos ?? []) as Todo[])
      .slice()
      .sort((a, b) => priority[a.status] - priority[b.status]),
  );
  const starting = () => todos().every((t: Todo) => t.status === "pending");
  const finished = () => todos().every((t: Todo) => t.status === "completed");

  const expandedKey = () => `todowrite-${props.id}`;
  const expanded = () => messageStore.expanded[expandedKey()] ?? true;

  return (
    <Collapsible open={expanded()} onOpenChange={() => setExpanded(expandedKey(), !expanded())}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
          <span data-slot="name">
            <Switch fallback={t().parts.updatingPlan}>
              <Match when={starting()}>{t().parts.creatingPlan}</Match>
              <Match when={finished()}>{t().parts.completingPlan}</Match>
            </Switch>
          </span>
        </div>
        <Collapsible.Arrow />
      </Collapsible.Trigger>
      
      <Collapsible.Content>
        <Show when={todos().length > 0}>
          <ul data-component="todos">
            <For each={todos()}>
              {(todo) => (
                <li data-slot="item" data-status={todo.status}>
                  <span></span>
                  {todo.content}
                </li>
              )}
            </For>
          </ul>
        </Show>
        <ToolFooter
            time={DateTime.fromMillis(props.state.time.end)
              .diff(DateTime.fromMillis(props.state.time.start))
              .toMillis()}
          />
      </Collapsible.Content>
    </Collapsible>
  );
}

function TaskTool(props: ToolProps) {
  const { t } = useI18n();
  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
          <span data-slot="name">Task</span>
          <span data-slot="target">{props.state.input.description}</span>
        </div>
        <Collapsible.Arrow />
      </Collapsible.Trigger>

      <Collapsible.Content>
        <div data-component="tool-input">
          &ldquo;{props.state.input.prompt}&rdquo;
        </div>
        <div data-component="tool-output">
           <ContentMarkdown expand text={props.state.output} />
        </div>
        <ToolFooter
            time={DateTime.fromMillis(props.state.time.end)
              .diff(DateTime.fromMillis(props.state.time.start))
              .toMillis()}
          />
      </Collapsible.Content>
    </Collapsible>
  );
}


export function FallbackTool(props: ToolProps) {
  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
          <span data-slot="name">{props.tool}</span>
          {props.state.input?.description && (
            <span data-slot="target">{props.state.input.description}</span>
          )}
        </div>
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
        <ToolFooter
            time={DateTime.fromMillis(props.state.time.end)
              .diff(DateTime.fromMillis(props.state.time.start))
              .toMillis()}
          />
      </Collapsible.Content>
    </Collapsible>
  );
}

// Converts nested objects/arrays into [path, value] pairs.
// E.g. {a:{b:{c:1}}, d:[{e:2}, 3]} => [["a.b.c",1], ["d[0].e",2], ["d[1]",3]]
function flattenToolArgs(obj: any, prefix: string = ""): Array<[string, any]> {
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



export function GrepTool(props: ToolProps) {
  const { t } = useI18n();
  const matchCount = () => props.state.metadata?.matches ?? 0;
  
  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
          <span data-slot="name">Grep</span>
          <span data-slot="target" title={props.state.input.pattern}>
            &ldquo;{props.state.input.pattern}&rdquo;
          </span>
          <Show when={props.state.status === "completed"}>
            <span data-slot="summary" data-color="dimmed">
              {matchCount() === 1 
                ? formatMessage(t().parts.match, { count: matchCount() })
                : formatMessage(t().parts.matches, { count: matchCount() })}
            </span>
          </Show>
        </div>
        <Collapsible.Arrow />
      </Collapsible.Trigger>
      
      <Collapsible.Content>
         <div data-component="tool-result">
           <Switch>
             <Match when={matchCount() > 0 || props.state.output}>
                <ContentText expand compact text={props.state.output} />
             </Match>
           </Switch>
         </div>
         <ToolFooter
            time={DateTime.fromMillis(props.state.time.end)
              .diff(DateTime.fromMillis(props.state.time.start))
              .toMillis()}
          />
      </Collapsible.Content>
    </Collapsible>
  );
}

export function ListTool(props: ToolProps) {
  const path = createMemo(() =>
    props.state.input?.path !== (props.message.engineMeta as any)?.path?.cwd
      ? stripWorkingDirectory(props.state.input?.path, (props.message.engineMeta as any)?.path?.cwd)
      : props.state.input?.path,
  );

  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
          <span data-slot="name">LS</span>
          <span data-slot="target" title={props.state.input?.path}>
            {path()}
          </span>
        </div>
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
        <ToolFooter
            time={DateTime.fromMillis(props.state.time.end)
              .diff(DateTime.fromMillis(props.state.time.start))
              .toMillis()}
          />
      </Collapsible.Content>
    </Collapsible>
  );
}

export function WebFetchTool(props: ToolProps) {
  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
          <span data-slot="name">Fetch</span>
          <span data-slot="target" title={props.state.input.url}>{props.state.input.url}</span>
        </div>
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
                lang={props.state.input.format || "text"}
                code={props.state.output}
              />
            </Match>
          </Switch>
        </div>
        <ToolFooter
            time={DateTime.fromMillis(props.state.time.end)
              .diff(DateTime.fromMillis(props.state.time.start))
              .toMillis()}
          />
      </Collapsible.Content>
    </Collapsible>
  );
}

export function ReadTool(props: ToolProps) {
  const { t } = useI18n();
  const filePath = createMemo(() =>
    stripWorkingDirectory(props.state.input?.filePath, (props.message.engineMeta as any)?.path?.cwd),
  );
  const lineCount = createMemo(() => {
    const lines = props.state.metadata?.lines;
    if (typeof lines === "number") return lines;
    if (props.state.output) {
      return props.state.output.split("\n").length;
    }
    return null;
  });

  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
          <span data-slot="name">Read</span>
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
        <Collapsible.Arrow />
      </Collapsible.Trigger>

      <Collapsible.Content>
        <Show when={props.state.output}>
          <div data-component="tool-result">
            <ContentCode
              lang={getShikiLang(filePath() || "")}
              code={props.state.output}
            />
          </div>
        </Show>
        <ToolFooter
          time={DateTime.fromMillis(props.state.time.end)
            .diff(DateTime.fromMillis(props.state.time.start))
            .toMillis()}
        />
      </Collapsible.Content>
    </Collapsible>
  );
}

export function WriteTool(props: ToolProps) {
  const { t } = useI18n();
  const filePath = createMemo(() =>
    stripWorkingDirectory(props.state.input?.filePath, (props.message.engineMeta as any)?.path?.cwd),
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
          <span data-slot="name">Write</span>
          <span data-slot="target" title={props.state.input?.filePath}>
            {filePath()}
          </span>
        </div>
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
        <ToolFooter
            time={DateTime.fromMillis(props.state.time.end)
              .diff(DateTime.fromMillis(props.state.time.start))
              .toMillis()}
          />
      </Collapsible.Content>
    </Collapsible>
  );
}

export function EditTool(props: ToolProps) {
  const filePath = createMemo(() =>
    stripWorkingDirectory(props.state.input.filePath, (props.message.engineMeta as any)?.path?.cwd),
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
          <span data-slot="name">Edit</span>
          <span data-slot="target" title={props.state.input?.filePath}>
            {filePath()}
          </span>
        </div>
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
                  lang={getShikiLang(filePath() || "")}
                />
              </div>
            </Match>
          </Switch>
        </div>
        <Show when={diagnostics().length > 0}>
          <ContentError>{diagnostics()}</ContentError>
        </Show>
        <ToolFooter
            time={DateTime.fromMillis(props.state.time.end)
              .diff(DateTime.fromMillis(props.state.time.start))
              .toMillis()}
          />
      </Collapsible.Content>
    </Collapsible>
  );
}

export function BashTool(props: ToolProps) {
  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
      <Collapsible.Trigger>
        <div data-component="tool-title">
           <span data-slot="name">Bash</span>
           <span data-slot="target" title={props.state.input.command} style={{ "font-family": "monospace", "font-size": "0.75rem" }}>
             {props.state.input.command.length > 50 
               ? props.state.input.command.slice(0, 50) + "..." 
               : props.state.input.command}
           </span>
        </div>
        <Collapsible.Arrow />
      </Collapsible.Trigger>
      
      <Collapsible.Content>
         <ContentBash
          command={props.state.input.command}
          output={props.state.metadata?.output ?? props.state.metadata?.stdout}
          description={props.state.metadata?.description}
        />
        <ToolFooter
            time={DateTime.fromMillis(props.state.time.end)
              .diff(DateTime.fromMillis(props.state.time.start))
              .toMillis()}
          />
      </Collapsible.Content>
    </Collapsible>
  );
}

export function GlobTool(props: ToolProps) {
  const { t } = useI18n();
  const count = () => props.state.metadata?.count ?? 0;

  return (
    <Collapsible open={isExpanded(props.id)} onOpenChange={() => toggleExpanded(props.id)}>
       <Collapsible.Trigger>
          <div data-component="tool-title">
            <span data-slot="name">Glob</span>
            <span data-slot="target">
              &ldquo;{props.state.input.pattern}&rdquo;
            </span>
             <Show when={props.state.status === "completed"}>
              <span data-slot="summary" data-color="dimmed">
                {count() === 1 
                  ? formatMessage(t().parts.result, { count: count() })
                  : formatMessage(t().parts.results, { count: count() })}
              </span>
            </Show>
          </div>
          <Collapsible.Arrow />
       </Collapsible.Trigger>

       <Collapsible.Content>
        <Switch>
          <Match when={count() > 0 || props.state.output}>
            <div data-component="tool-result">
                 <ContentText expand compact text={props.state.output} />
            </div>
          </Match>
        </Switch>
        <ToolFooter
            time={DateTime.fromMillis(props.state.time.end)
              .diff(DateTime.fromMillis(props.state.time.start))
              .toMillis()}
          />
       </Collapsible.Content>
    </Collapsible>
  );
}

interface ResultsButtonProps extends ParentProps {

  showCopy?: string;
  hideCopy?: string;
}
function ResultsButton(props: ResultsButtonProps) {
  const { t } = useI18n();
  const [show, setShow] = createSignal(false);

  return (
    <>
      <button
        type="button"
        data-component="button-text"
        data-more
        onClick={() => setShow((e) => !e)}
      >
        <span>
          {show()
            ? props.hideCopy || t().common.hideResults
            : props.showCopy || t().common.showResults}
        </span>
        <span data-slot="icon">
          <Show
            when={show()}
            fallback={<IconChevronRight width={11} height={11} />}
          >
            <IconChevronDown width={11} height={11} />
          </Show>
        </span>
      </button>
      <Show when={show()}>{props.children}</Show>
    </>
  );
}

export function Spacer() {
  return <div data-component="spacer"></div>;
}

function Footer(props: ParentProps<{ title: string }>) {
  return (
    <div data-component="content-footer" title={props.title}>
      {props.children}
    </div>
  );
}

function ToolFooter(props: { time: number }) {
  return (
    props.time > MIN_DURATION && (
      <Footer title={`${props.time}ms`}>{formatDuration(props.time)}</Footer>
    )
  );
}


function getProvider(model: string) {
  const lowerModel = model.toLowerCase();

  if (/claude|anthropic/.test(lowerModel)) return "anthropic";
  if (/gpt|o[1-4]|codex|openai/.test(lowerModel)) return "openai";
  if (/gemini|palm|bard|google/.test(lowerModel)) return "gemini";
  if (/llama|meta/.test(lowerModel)) return "meta";

  return "any";
}

export function ProviderIcon(props: { model: string; size?: number }) {
  const provider = getProvider(props.model);
  const size = props.size || 16;
  return (
    <Switch fallback={<IconSparkles width={size} height={size} />}>
      <Match when={provider === "openai"}>
        <IconOpenAI width={size} height={size} />
      </Match>
      <Match when={provider === "anthropic"}>
        <IconAnthropic width={size} height={size} />
      </Match>
      <Match when={provider === "gemini"}>
        <IconGemini width={size} height={size} />
      </Match>
      <Match when={provider === "meta"}>
        <IconMeta width={size} height={size} />
      </Match>
    </Switch>
  );
}

// Permission Prompt Component
interface PermissionPromptProps {
  permission: UnifiedPermission;
  onRespond?: (sessionID: string, permissionID: string, reply: string) => void;
}

function PermissionPrompt(props: PermissionPromptProps) {
  const { t } = useI18n();

  const handleRespond = (reply: string) => {
    if (props.onRespond) {
      props.onRespond(props.permission.sessionId, props.permission.id, reply);
    }
  };

  return (
    <div data-component="permission-prompt">
      <div data-slot="permission-info">
        <span data-slot="permission-type">{props.permission.title}</span>
        <Show when={props.permission.patterns && props.permission.patterns.length > 0}>
          <span data-slot="permission-patterns">
            {props.permission.patterns?.join(", ")}
          </span>
        </Show>
      </div>
      <div data-slot="permission-actions">
        <button
          type="button"
          data-slot="permission-button"
          data-variant="deny"
          onClick={() => handleRespond("reject")}
        >
          {t().permission.deny}
        </button>
        <button
          type="button"
          data-slot="permission-button"
          data-variant="always"
          onClick={() => handleRespond("always")}
        >
          {t().permission.allowAlways}
        </button>
        <button
          type="button"
          data-slot="permission-button"
          data-variant="once"
          onClick={() => handleRespond("once")}
        >
          {t().permission.allowOnce}
        </button>
      </div>
    </div>
  );
}
