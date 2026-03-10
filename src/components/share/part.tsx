import { DateTime } from "luxon";
import {
  For,
  Show,
  Match,
  Switch,
  createMemo,
  createSignal,
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
import type { UnifiedMessage, UnifiedPart, UnifiedPermission, UnifiedQuestion, ToolPart } from "../../types/unified";
import { useI18n } from "../../lib/i18n";
import { logger } from "../../lib/logger";
import { isExpanded, toggleExpanded } from "../../stores/message";

import styles from "./part.module.css";

export interface PartProps {
  index: number;
  message: UnifiedMessage;
  part: UnifiedPart;
  last: boolean;
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
        {props.message.role === "assistant" && props.part.type === "reasoning" && (() => {
          const reasoningText = () => (props.part as any).text || "";
          const heading = () => {
            const text = reasoningText();
            if (!text) return undefined;
            const atx = text.trimStart().match(/^#{1,3}\s+(.+)$/m);
            if (atx) { const h = atx[1].trim(); return h.length > 45 ? h.slice(0, 44) + "\u2026" : h; }
            const bold = text.trimStart().match(/^\*\*(.+?)\*\*/);
            if (bold) { const h = bold[1].trim(); return h.length > 45 ? h.slice(0, 44) + "\u2026" : h; }
            return undefined;
          };
          const preview = () => {
            const text = reasoningText().replace(/^#{1,3}\s+.+$/m, "").replace(/\*\*(.+?)\*\*/g, "$1").trim();
            return text.length > 100 ? text.slice(0, 99) + "\u2026" : text;
          };
          const isCollapsed = () => !props.isStreaming && !isExpanded(`reasoning-${props.part.id}`);
          return (
            <div data-component="reasoning" data-streaming={props.isStreaming ? "" : undefined}>
               <Collapsible
                 open={props.isStreaming || isExpanded(`reasoning-${props.part.id}`)}
                 onOpenChange={() => toggleExpanded(`reasoning-${props.part.id}`)}
               >
                  <Collapsible.Trigger>
                     <div data-slot="title">
                        <IconBrain width={14} height={14} />
                        <span>{t().parts.thinking}</span>
                        <Show when={heading()}>
                          <span data-slot="reasoning-heading">{heading()}</span>
                        </Show>
                        <Show when={props.isStreaming}>
                          <span data-slot="streaming-dot" />
                        </Show>
                     </div>
                     <Collapsible.Arrow />
                  </Collapsible.Trigger>
                  {/* Collapsed preview — shows first ~100 chars when folded */}
                  <Show when={isCollapsed() && preview()}>
                    <div data-slot="reasoning-preview">{preview()}</div>
                  </Show>
                  <Collapsible.Content>
                      <div data-component="assistant-reasoning-markdown">
                          <ContentMarkdown expand text={reasoningText() || t().parts.thinking + "..."} />
                      </div>
                  </Collapsible.Content>
               </Collapsible>
            </div>
          );
        })()}

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
                  <span data-slot="icon" data-icon-color="amber">
                    <IconSparkles width={14} height={14} />
                  </span>
                  <span data-slot="name">{t().parts.toolHint}</span>
                  <span data-slot="target">{(props.part as ToolPart).title || (props.part as ToolPart).originalTool}</span>
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
              <span data-slot="icon" data-icon-color="orange">
                <ToolIcon tool={(props.part as ToolPart).normalizedTool} />
              </span>
              <span data-slot="name">{(props.part as ToolPart).title || (props.part as ToolPart).originalTool}</span>
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
                {!(props.part.state as any).input ? (
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
  const startTime = () => (props.part.state as any).time?.start ?? Date.now();
  const isRunning = () =>
    props.part.state.status === "pending" || props.part.state.status === "running";
  const elapsed = createElapsedTimer(startTime, isRunning);

  return (
    <div data-component="tool-running">
      <div data-component="tool-title" data-running>
        <span data-slot="icon" data-icon-color="cyan">
          <ToolIcon tool={props.part.normalizedTool} />
        </span>
        <span data-slot="name">{props.part.title || props.part.normalizedTool}</span>
        <Show when={props.part.state.status === "running" && (props.part.state as any).input}>
          <span data-slot="target">
            {(props.part.state as any).input?.description}
            {(props.part.state as any).input?.filePath}
            {(props.part.state as any).input?.pattern}
          </span>
        </Show>
        <span data-slot="status">{formatDuration(elapsed())}</span>
      </div>
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
