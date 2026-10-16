import { DateTime } from "luxon";
import {
  For,
  Show,
  Match,
  Switch,
  createMemo,
  createSignal,
  createEffect,
  onCleanup,
  type ParentProps,
} from "solid-js";
import {
  IconHashtag,
  IconSparkles,
  IconGlobeAlt,
  IconDocument,
  IconQueueList,
  IconCommandLine,
  IconCheckCircle,
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
import { ContentError } from "./content-error";
import { ContentMarkdown } from "./content-markdown";
import { ContentText } from "./content-text";
import { UserTextContent } from "./UserTextContent";
import AttachmentContent from "./AttachmentContent";
import { formatDuration, createElapsedTimer } from "./common";
import {
  ToolIcon,
  ToolDuration,
  formatErrorString,
  TodoWriteTool,
  TaskTool,
  FallbackTool,
  GrepTool,
  GlobTool,
  ListTool,
  WebFetchTool,
  ReadTool,
  WriteTool,
  EditTool,
  BashTool,
} from "./tools";
import type { UnifiedMessage, UnifiedPart, UnifiedPermission, UnifiedQuestion, ToolPart, SystemNoticePart, ReasoningPart } from "../../types/unified";
import { formatMessage, useI18n } from "../../lib/i18n";
import { getReasoningDisplayText, getReasoningDuration } from "../../lib/reasoning-display";
import { copyResponseToClipboard } from "../../lib/clipboard";
import { createStreamScroll } from "../../lib/stream-scroll";
import { logger } from "../../lib/logger";
import { isExpanded, setExpanded, toggleExpanded } from "../../stores/message";
import { SystemNotice } from "./SystemNotice";

import styles from "./part.module.css";

/** Typed accessor for tool state input fields (state.input is `unknown`) */
function getToolInput(state: ToolPart["state"]): Record<string, any> | undefined {
  if (state.status === "pending") return state.input as Record<string, any> | undefined;
  if (state.status === "running" || state.status === "completed" || state.status === "error") {
    return state.input as Record<string, any> | undefined;
  }
  return undefined;
}

export interface PartProps {
  index: number;
  message: UnifiedMessage;
  part: UnifiedPart;
  last: boolean;
  expandText?: boolean;
  isStreaming?: boolean;
  permission?: UnifiedPermission;
  onPermissionRespond?: (sessionID: string, permissionID: string, reply: string) => void;
  question?: UnifiedQuestion;
  onQuestionRespond?: (sessionID: string, questionID: string, answers: string[][]) => void;
  onQuestionDismiss?: (sessionID: string, questionID: string) => void;
}

export function Part(props: PartProps) {
  const { t } = useI18n();
  const [copied, setCopied] = createSignal(false);
  const [responseCopied, setResponseCopied] = createSignal(false);
  let responseMarkdown: HTMLDivElement | undefined;
  let responseCopyTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (responseCopyTimer) clearTimeout(responseCopyTimer);
  });
  const handleCopyResponse = async () => {
    if (props.part.type !== "text") return;
    if (!await copyResponseToClipboard(props.part, responseMarkdown)) {
      logger.error("Copy response failed");
      return;
    }
    setResponseCopied(true);
    if (responseCopyTimer) clearTimeout(responseCopyTimer);
    responseCopyTimer = setTimeout(() => setResponseCopied(false), 2000);
  };
  const id = createMemo(() => props.message.id + "-" + props.index);

  // System notices render as centered banners, not the standard part layout
  if (props.part.type === "system-notice") {
    return <SystemNotice part={props.part as SystemNoticePart} />;
  }

  // Tool parts can opt out of stream rendering (e.g. when they have a dedicated
  // UI surface like Copilot's `ask_user` → Question Dock). The adapter layer
  // owns this decision; the renderer stays engine-agnostic.
  if (
    props.part.type === "tool" &&
    (props.part as ToolPart).suppressInStream
  ) {
    return null;
  }

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
              <Match when={props.part.type === "tool"}>
                <div data-slot="icon-wrapper">
                  <ToolIcon tool={(props.part as ToolPart).originalTool} size={18} />
                </div>
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
            <UserTextContent part={props.part} expand={props.last} workingDirectory={props.message.workingDirectory} />
          </div>
        )}
        {props.message.role === "assistant" && props.part.type === "text" && (
          <div data-component="assistant-text" data-copyable={!props.isStreaming && !!props.message.time.completed && props.part.phase !== "commentary" && !!(props.part.displayText ?? props.part.text).trim() ? "" : undefined}>
            <div data-component="assistant-text-markdown" ref={responseMarkdown}>
              <ContentMarkdown expand={props.expandText ?? props.last} text={props.part.displayText ?? props.part.text} isStreaming={props.isStreaming} buffered={props.part.phase !== "commentary"} workingDirectory={props.message.workingDirectory} inlineAssets={props.part.inlineAssets} />
            </div>
            <Show when={!props.isStreaming && props.message.time.completed && props.part.phase !== "commentary" && (props.part.displayText ?? props.part.text).trim()}>
                <button
                  type="button"
                  data-component="response-copy-button"
                  data-markdown-decoration=""
                  aria-label={responseCopied() ? t().common.copied : t().common.copyToClipboard}
                  title={responseCopied() ? t().common.copied : t().common.copyToClipboard}
                  onClick={handleCopyResponse}
                >
                  <Show when={responseCopied()} fallback={
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  }>
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6" /></svg>
                  </Show>
                  <span class="sr-only" role="status">{responseCopied() ? t().common.copied : ""}</span>
                </button>
            </Show>
            <Show when={!props.isStreaming && props.part.citations?.length}>
              <Footer title={t().parts.memorySources}>
                <details data-component="response-citations">
                  <summary>{t().parts.memorySources}</summary>
                  <ul>
                    <For each={props.part.citations}>
                      {(citation) => <li>{citation.note}</li>}
                    </For>
                  </ul>
                </details>
              </Footer>
            </Show>
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
        {props.message.role === "assistant" && props.part.type === "reasoning" && (() => {
          const reasoning = () => props.part as ReasoningPart;
          const isStreaming = () => props.isStreaming === true &&
            !(reasoning().completed ?? reasoning().time?.end !== undefined);
          const nativeSummary = () => reasoning().summaryFormat === "heading-prefixed";
          const body = createMemo(() => getReasoningDisplayText(reasoning(), isStreaming()));
          const [streamCollapsed, setStreamCollapsed] = createSignal(false);
          const [reasoningViewport, setReasoningViewport] = createSignal<HTMLDivElement>();
          let readingEarlier = false;
          let previousTop = 0;
          let previousHeight = 0;
          let previousTouchY: number | undefined;
          const reasoningScroll = createStreamScroll({
            viewport: reasoningViewport,
            sessionId: () => props.part.id,
            following: () => isStreaming() && !readingEarlier,
          });
          onCleanup(reasoningScroll.cancel);
          createEffect(() => { body(); reasoningScroll.schedule(); });
          createEffect(() => {
            const viewport = reasoningViewport();
            if (!viewport) return;
            const observer = new ResizeObserver(reasoningScroll.schedule);
            observer.observe(viewport);
            if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
            onCleanup(() => observer.disconnect());
          });
          const [observedTime, setObservedTime] = createSignal<{ start: number; end?: number }>();
          createEffect(() => {
            if (isStreaming()) setObservedTime((current) => current ?? { start: Date.now() });
            else setObservedTime((current) => current && current.end === undefined ? { ...current, end: Date.now() } : current);
          });
          const duration = createMemo(() => getReasoningDuration(reasoning().time) ?? getReasoningDuration(observedTime()));
          const title = () => {
            if (!nativeSummary() || isStreaming()) return t().parts.thinking;
            const elapsed = duration();
            return elapsed === undefined ? t().parts.thought
              : formatMessage(t().parts.thoughtFor, { duration: formatDuration(elapsed) });
          };
          return (
            <div data-component="reasoning" data-streaming={isStreaming() ? "" : undefined}>
               <Collapsible
                 open={!!body().trim() && (isStreaming() ? !streamCollapsed() : isExpanded(`reasoning-${props.part.id}`))}
                 onOpenChange={(open) => {
                   if (isStreaming()) setStreamCollapsed(!open);
                   if (body().trim()) setExpanded(`reasoning-${props.part.id}`, open);
                 }}
               >
                  <Collapsible.Trigger disabled={!body().trim()}>
                     <div data-slot="title">
                        <IconBrain width={14} height={14} />
                        <span>{title()}</span>
                        <Show when={isStreaming()}>
                          <span data-slot="streaming-dot" />
                        </Show>
                     </div>
                     <Show when={body().trim()}>
                       <Collapsible.Arrow />
                     </Show>
                  </Collapsible.Trigger>
                  <Show when={!nativeSummary() && !isStreaming() && !isExpanded(`reasoning-${props.part.id}`) && body().trim()}>
                    <div data-slot="reasoning-preview">{body().replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s*/, "").slice(0, 100)}</div>
                  </Show>
                  <Collapsible.Content>
                      <div
                        ref={setReasoningViewport}
                        data-component="assistant-reasoning-markdown"
                        tabIndex={isStreaming() ? 0 : undefined}
                        role="region"
                        aria-label={t().parts.thinking}
                        onWheel={(event) => { if (event.deltaY < 0) readingEarlier = true; }}
                        onTouchStart={(event) => { previousTouchY = event.touches[0]?.clientY; }}
                        onTouchMove={(event) => {
                          const next = event.touches[0]?.clientY;
                          if (next !== undefined && previousTouchY !== undefined && next > previousTouchY) readingEarlier = true;
                          previousTouchY = next;
                        }}
                        onKeyDown={(event) => {
                          if (event.defaultPrevented || !isStreaming() || event.target !== event.currentTarget) return;
                          const viewport = event.currentTarget;
                          const step = event.key.startsWith("Page") ? viewport.clientHeight * 0.8 : 40;
                          const next = event.key === "Home" ? 0
                            : event.key === "End" ? viewport.scrollHeight
                            : ["ArrowUp", "PageUp"].includes(event.key) ? viewport.scrollTop - step
                            : ["ArrowDown", "PageDown"].includes(event.key) ? viewport.scrollTop + step
                            : undefined;
                          if (next === undefined) return;
                          event.preventDefault();
                          event.stopPropagation();
                          readingEarlier = next < viewport.scrollHeight - viewport.clientHeight;
                          viewport.scrollTop = next;
                        }}
                        onScroll={(event) => {
                          const viewport = event.currentTarget;
                          if (viewport.scrollTop < previousTop && viewport.scrollHeight >= previousHeight) readingEarlier = true;
                          else if (viewport.scrollTop > previousTop && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1) readingEarlier = false;
                          previousTop = viewport.scrollTop;
                          previousHeight = viewport.scrollHeight;
                        }}
                      >
                          <ContentMarkdown expand text={body()} isStreaming={isStreaming()} workingDirectory={props.message.workingDirectory} />
                      </div>
                  </Collapsible.Content>
               </Collapsible>
            </div>
          );
        })()}

        {props.part.type === "file" && (
          <AttachmentContent part={props.part} message={props.message} />
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
                  <span data-slot="icon" data-icon-color="red">
                    <IconSparkles width={14} height={14} />
                  </span>
                  <span data-slot="name">{t().common.error}</span>
                  <span data-slot="target">{(props.part as ToolPart).title || (props.part as ToolPart).originalTool}</span>
                </div>
                <Collapsible.Arrow />
              </Collapsible.Trigger>
              <Collapsible.Content>
                <ContentError>
                  {formatErrorString(props.part.state.error)}
                </ContentError>
                <Show when={props.part.state.output != null}>
                  <ContentText expand compact text={typeof props.part.state.output === "string"
                    ? props.part.state.output : JSON.stringify(props.part.state.output, null, 2)} />
                </Show>
              </Collapsible.Content>
            </Collapsible>
          </div>
        )}
        {/* Tool with pending permission - show permission prompt */}
        {props.part.type === "tool" && props.permission && (
          <div data-component="tool-permission">
            <div data-component="tool-title" data-waiting>
              <span data-slot="icon" data-icon-color="orange">
                <ToolIcon tool={(props.part as ToolPart).normalizedTool} />
              </span>
              <span data-slot="name">{(props.part as ToolPart).title || (props.part as ToolPart).originalTool}</span>
              <span data-slot="target">
                {(() => { const inp = getToolInput(props.part.state); return props.part.state.status === "running" && inp ? (
                  <>
                    {inp.description}
                    {inp.filePath}
                    {inp.command && (inp.command.length > 50 ? inp.command.slice(0, 50) + "..." : inp.command)}
                  </>
                ) : null; })()}
              </span>
            </div>
            <PermissionPrompt
              permission={props.permission}
              onRespond={props.onPermissionRespond}
            />
          </div>
        )}
        {/* Tool with pending question - show question prompt */}
        {props.part.type === "tool" && props.question && (
          <div data-component="tool-question">
            <div data-component="tool-title" data-waiting>
              <span data-slot="icon" data-icon-color="blue">
                <ToolIcon tool={(props.part as ToolPart).normalizedTool} />
              </span>
              <span data-slot="name">{(props.part as ToolPart).title || (props.part as ToolPart).originalTool}</span>
              <span data-slot="target">{t().question.waitingAnswer}</span>
            </div>
            <QuestionPrompt
              question={props.question}
              onRespond={props.onQuestionRespond}
              onDismiss={props.onQuestionDismiss}
            />
          </div>
        )}
        {/* Tool running without permission */}
        {props.part.type === "tool" &&
          (props.part.state.status === "pending" || props.part.state.status === "running") &&
          !props.permission &&
          props.message.role === "assistant" && (
            <RunningToolCard part={props.part as ToolPart} />
        )}
        {props.part.type === "tool" &&
          props.part.state.status === "completed" &&
          props.message.role === "assistant" && (
            <>
              <div data-component="tool" data-tool={(props.part as ToolPart).normalizedTool}>
                {/* Guard: if tool state has no input (e.g. interrupted session replay), render FallbackTool */}
                {!getToolInput(props.part.state) ? (
                    <FallbackTool
                    message={props.message}
                    id={props.part.id}
                    tool={(props.part as ToolPart).title || (props.part as ToolPart).originalTool}
                    state={{ ...props.part.state, input: {} }}
                  />
                ) : (
                <Switch>
                  <Match when={(props.part as ToolPart).normalizedTool === "grep"}>
                    <GrepTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).normalizedTool}
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).normalizedTool === "glob"}>
                    <GlobTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).normalizedTool}
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).normalizedTool === "list"}>
                    <ListTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).normalizedTool}
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).normalizedTool === "read"}>
                    <ReadTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).normalizedTool}
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).normalizedTool === "write"}>
                    <WriteTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).normalizedTool}
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).normalizedTool === "edit"}>
                    <EditTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).normalizedTool}
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).normalizedTool === "shell"}>
                    <BashTool
                      id={props.part.id}
                      tool={(props.part as ToolPart).normalizedTool}
                      state={props.part.state}
                      message={props.message}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).normalizedTool === "todo"}>
                    <TodoWriteTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).normalizedTool}
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).normalizedTool === "web_fetch"}>
                    <WebFetchTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).normalizedTool}
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={(props.part as ToolPart).normalizedTool === "task"}>
                    <TaskTool
                      id={props.part.id}
                      tool={(props.part as ToolPart).normalizedTool}
                      message={props.message}
                      state={props.part.state}
                    />
                  </Match>
                  <Match when={true}>
                    <FallbackTool
                      message={props.message}
                      id={props.part.id}
                      tool={(props.part as ToolPart).title || (props.part as ToolPart).originalTool}
                      state={props.part.state}
                    />
                  </Match>
                </Switch>
                )}
              </div>
            </>
          )}
      </div>
    </div>
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

/** Running tool card with live elapsed timer */
function RunningToolCard(props: { part: ToolPart }) {
  const { t } = useI18n();
  const startTime = () => getToolInput(props.part.state)?.time?.start ?? (props.part.state as any).time?.start ?? Date.now();
  const isRunning = () =>
    props.part.state.status === "pending" || props.part.state.status === "running";
  const elapsed = createElapsedTimer(startTime, isRunning);

  const isTask = () => props.part.normalizedTool === "task";
  const taskMeta = () => {
    if (!isTask()) return undefined;
    const inp = getToolInput(props.part.state);
    if (!inp) return undefined;
    const currentTool = (inp._currentTool ?? inp._lastToolName) as string | undefined;
    const usage = inp._taskUsage as { toolUses?: number } | undefined;
    if (!currentTool && !usage?.toolUses) return undefined;
    return { currentTool, toolUses: usage?.toolUses };
  };

  return (
    <div data-component="tool-running">
      <div data-component="tool-title" data-running>
        <span data-slot="icon" data-icon-color="cyan">
          <ToolIcon tool={props.part.normalizedTool} />
        </span>
        <span data-slot="name">{props.part.title || props.part.normalizedTool}</span>
        <Show when={props.part.state.status === "running" && getToolInput(props.part.state)}>
          <span data-slot="target">
            {getToolInput(props.part.state)?.description}
            {getToolInput(props.part.state)?.filePath}
            {getToolInput(props.part.state)?.pattern}
          </span>
        </Show>
        <span data-slot="status">{formatDuration(elapsed())}</span>
      </div>
      <Show when={taskMeta()}>
        {(meta) => (
          <div data-component="task-progress">
            <Show when={meta().currentTool}>
              <span data-slot="subtool">{meta().currentTool}</span>
            </Show>
            <Show when={meta().toolUses}>
              <span data-slot="tool-count">{t().parts.toolUses.replace("{count}", String(meta().toolUses))}</span>
            </Show>
          </div>
        )}
      </Show>
    </div>
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

export function PermissionPrompt(props: PermissionPromptProps) {
  const { t } = useI18n();

  const handleRespond = (reply: string) => {
    if (props.permission && props.onRespond) {
      props.onRespond(props.permission.sessionId, props.permission.id, reply);
    }
  };

  const getVariant = (type: string) => {
    if (type.includes("reject")) return "deny";
    if (type.includes("always")) return "always";
    return "once";
  };

  const getLabel = (opt: { label: string; type: string }) => {
    if (opt.label) return opt.label;
    if (opt.type.includes("reject")) return t().permission.deny;
    if (opt.type.includes("always")) return t().permission.allowAlways;
    return t().permission.allowOnce;
  };

  const options = () => {
    if (!props.permission) return [];
    return props.permission.options?.length > 0
      ? props.permission.options
      : [
          { id: "reject", label: t().permission.deny, type: "reject" },
          { id: "always", label: t().permission.allowAlways, type: "accept_always" },
          { id: "once", label: t().permission.allowOnce, type: "accept_once" },
        ];
  };

  return (
    <Show when={props.permission}>
      <div data-component="permission-prompt">
        <div data-slot="permission-info">
          <span data-slot="permission-type">{props.permission?.title}</span>
          <Show when={props.permission?.patterns && props.permission!.patterns.length > 0}>
            <span data-slot="permission-patterns">
              {props.permission?.patterns?.join(", ")}
            </span>
          </Show>
        </div>
        <div data-slot="permission-actions">
          <For each={options()}>
            {(opt) => (
              <button
                type="button"
                data-slot="permission-button"
                data-variant={getVariant(opt.type)}
                onClick={() => handleRespond(opt.id)}
              >
                {getLabel(opt)}
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}

// Question Prompt Component
interface QuestionPromptProps {
  question: UnifiedQuestion;
  onRespond?: (sessionID: string, questionID: string, answers: string[][]) => void;
  onDismiss?: (sessionID: string, questionID: string) => void;
}

export function QuestionPrompt(props: QuestionPromptProps) {
  const { t } = useI18n();

  const [answers, setAnswers] = createSignal<string[][]>(
    props.question.questions.map(() => [])
  );
  const [customTexts, setCustomTexts] = createSignal<string[]>(
    props.question.questions.map(() => "")
  );

  const toggleOption = (questionIndex: number, optionLabel: string, multiple?: boolean) => {
    setAnswers((prev) => {
      const next = [...prev];
      const current = [...(next[questionIndex] || [])];
      const idx = current.indexOf(optionLabel);
      if (idx >= 0) {
        current.splice(idx, 1);
      } else {
        if (multiple) {
          current.push(optionLabel);
        } else {
          next[questionIndex] = [optionLabel];
          return next;
        }
      }
      next[questionIndex] = current;
      return next;
    });
  };

  const handleSubmit = () => {
    if (!props.onRespond) return;
    const finalAnswers = props.question.questions.map((_q, i) => {
      const selected = [...(answers()[i] || [])];
      const custom = (customTexts()[i] || "").trim();
      if (custom) {
        selected.push(custom);
      }
      return selected;
    });
    props.onRespond(props.question.sessionId, props.question.id, finalAnswers);
  };

  const handleDismiss = () => {
    if (props.onDismiss) {
      props.onDismiss(props.question.sessionId, props.question.id);
    }
  };

  return (
    <Show when={props.question}>
      <div data-component="question-prompt">
        <For each={props.question.questions}>
          {(q, qi) => (
            <div data-slot="question-item">
              <div data-slot="question-header">
                <span data-slot="question-badge">{q.header}</span>
                <span data-slot="question-text">{q.question}</span>
              </div>
              <div data-slot="question-options">
                <For each={q.options}>
                  {(opt) => {
                    const isSelected = () => (answers()[qi()] || []).includes(opt.label);
                    return (
                      <button
                        type="button"
                        data-slot="question-option"
                        data-selected={isSelected() ? "" : undefined}
                        onClick={() => toggleOption(qi(), opt.label, q.multiple)}
                        title={opt.description}
                      >
                        {opt.label}
                      </button>
                    );
                  }}
                </For>
              </div>
              <Show when={q.custom !== false}>
                <input
                  type="text"
                  data-slot="question-custom-input"
                  placeholder={t().question.customPlaceholder}
                  value={customTexts()[qi()] || ""}
                  onInput={(e) => {
                    const idx = qi();
                    setCustomTexts((prev) => {
                      const next = [...prev];
                      next[idx] = e.currentTarget.value;
                      return next;
                    });
                  }}
                />
              </Show>
            </div>
          )}
        </For>
        <div data-slot="question-actions">
          <button
            type="button"
            data-slot="permission-button"
            data-variant="deny"
            onClick={handleDismiss}
          >
            {t().question.dismiss}
          </button>
          <button
            type="button"
            data-slot="permission-button"
            data-variant="once"
            onClick={handleSubmit}
          >
            {t().question.submit}
          </button>
        </div>
      </div>
    </Show>
  );
}
