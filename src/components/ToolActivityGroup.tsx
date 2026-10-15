import { createMemo, For, Index, Show, createUniqueId, type JSX } from "solid-js";
import type { ToolDisplayAction, ToolPart } from "../types/unified";
import type { TurnPart } from "../lib/message-parts";
import { useI18n, formatMessage } from "../lib/i18n";
import { isExpanded, setExpanded } from "../stores/message";
import { ContentDiff } from "./share/content-diff";
import { IconCommandLine, IconDocument, IconMagnifyingGlass, IconPencilSquare } from "./icons";
import styles from "./ToolActivityGroup.module.css";

interface Props {
  id: string;
  items: TurnPart[];
  expanded: boolean;
  working: boolean;
  onToggle: () => void;
  renderReasoning: (item: () => TurnPart) => JSX.Element;
}

interface Row {
  id: string;
  part: ToolPart;
  action?: ToolDisplayAction;
}

function detail(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2);
}

function errorText(part: ToolPart): string {
  if (part.state.status === "error") return part.state.error;
  if (part.state.status !== "completed" || !part.state.metadata || typeof part.state.metadata !== "object") return "";
  const meta = part.state.metadata as Record<string, unknown>;
  return meta.error ? detail(meta.message ?? meta.error) : "";
}

function ActivityIcon(props: { kind: string }) {
  return <Show when={props.kind !== "skill" && props.kind !== "tool"} fallback={
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a5 5 0 0 0-6.4 6.4L3 18a2.1 2.1 0 0 0 3 3l5.3-5.3a5 5 0 0 0 6.4-6.4l-3.2 3.2-3-3z" /></svg>
  }>
    <Show when={props.kind !== "shell"} fallback={<IconCommandLine width={14} height={14} />}>
      <Show when={props.kind !== "read" && props.kind !== "list"} fallback={<IconDocument width={14} height={14} />}>
        <Show when={props.kind !== "edit"} fallback={<IconPencilSquare width={14} height={14} />}>
          <IconMagnifyingGlass width={14} height={14} />
        </Show>
      </Show>
    </Show>
  </Show>;
}

/** A visual group never changes the identity or result of its source tool calls. */
export function ToolActivityGroup(props: Props) {
  const { t } = useI18n();
  const controlId = createUniqueId();
  const tools = createMemo(() => props.items.flatMap(({ part }) => part.type === "tool" ? [part] : []));
  const rowsFor = (part: ToolPart): Row[] => (part.displayActions?.length ? part.displayActions : [undefined])
    .map((action, index) => ({ id: `${part.messageId}:${part.id}:${index}`, part, action }));
  const rows = createMemo(() => tools().flatMap(rowsFor));
  const inFlight = createMemo(() => tools().some(part => part.state.status === "pending" || part.state.status === "running"));
  const active = createMemo(() => props.working && (inFlight()
    || props.items.some(({ part }) => part.type === "reasoning" && part.completed !== true && part.time?.end === undefined)));
  const errors = createMemo(() => tools().filter(part => !!errorText(part)));
  const grouped = createMemo(() => rows().length > 1 || inFlight() || active() || tools().some(part =>
    (part.normalizedTool === "edit" || part.normalizedTool === "write") && (part.locations?.length ?? 0) > 1));
  const kind = (row: Row): string => {
    const fallback: Partial<Record<ToolPart["normalizedTool"], string>> = {
      read: "read", grep: "search", glob: "search", list: "list", shell: "shell", edit: "edit", write: "edit", web_fetch: "web",
    };
    return row.action?.kind ?? fallback[row.part.normalizedTool] ?? "tool";
  };
  const target = (row: Row): string => row.action?.label || row.action?.path || row.action?.query || row.action?.command || row.part.title || row.part.originalTool;
  const label = (row: Row): string => {
    if (!row.action) return row.part.title || row.part.originalTool;
    if (row.part.state.status === "error") return target(row);
    const running = row.part.state.status === "pending" || row.part.state.status === "running";
    const labels = t().activity;
    if (row.action.kind === "search" && row.action.query) {
      return row.action.path ? formatMessage(running ? labels.searchingIn : labels.searchedIn, {
        path: row.action.path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? row.action.path,
        query: row.action.query,
      }) : formatMessage(running ? labels.searching : labels.searched, { target: row.action.query });
    }
    const templates: Record<string, string> = {
      skill: running ? labels.readingSkill : labels.readSkill,
      read: running ? labels.readingFile : labels.readFile,
      search: running ? labels.searching : labels.searched,
      list: running ? labels.listing : labels.listed,
      shell: running ? labels.runningCommand : labels.ranCommand,
      edit: running ? labels.editingFile : labels.editedFile,
      web: running ? labels.fetching : labels.fetched,
    };
    return templates[kind(row)] ? formatMessage(templates[kind(row)], { target: target(row) }) : target(row);
  };
  const summary = createMemo(() => {
    const kinds = new Set(rows().map(kind));
    const labels = t().activity;
    const words = [
      kinds.has("skill") ? (active() ? labels.loadingTools : labels.loadedTools) : "",
      kinds.has("edit") ? (active() ? labels.changingFiles : labels.changedFiles) : "",
      [...kinds].some(value => ["read", "search", "list"].includes(value)) ? (active() ? labels.readingFiles : labels.readFiles) : "",
      kinds.has("shell") ? (active() ? labels.runningCommands : labels.ranCommands) : "",
      kinds.has("web") ? (active() ? labels.searchingWeb : labels.searchedWeb) : "",
      kinds.has("tool") ? (active() ? labels.callingTools : labels.calledTools) : "",
    ].filter(Boolean);
    return words.join(t().activity.separator);
  });

  const renderRow = (row: () => Row) => {
    const state = () => row().part.state;
    const output = () => {
      const value = state();
      if (value.status === "completed" && row().part.normalizedTool === "shell") {
        const meta = value.metadata && typeof value.metadata === "object" ? value.metadata as Record<string, unknown> : undefined;
        return detail(meta?.output ?? meta?.stdout ?? value.output);
      }
      return value.status === "completed" || value.status === "error" ? detail(value.output) : "";
    };
    const key = () => `activity-detail-${props.id}-${row().id}`;
    return <details class={styles.row} open={isExpanded(key())} onToggle={(event) => setExpanded(key(), event.currentTarget.open)} data-tool-id={row().part.id}>
      <summary class={styles.rowTrigger} title={row().action?.path || row().action?.command || label(row())}>
        <span class={styles.icon} aria-hidden="true"><ActivityIcon kind={kind(row())} /></span>
        <span class={styles.rowLabel}>{label(row())}</span>
        <Show when={errorText(row().part)}><span class={styles.errorLabel}>{t().common.error}</span></Show>
        <Show when={state().status === "pending" || state().status === "running"}><span class={styles.running} aria-label={t().common.running}>·</span></Show>
        <span class={styles.chevron} aria-hidden="true">›</span>
      </summary>
      <Show when={isExpanded(key())}><div class={styles.detail}>
        <Show when={state().input != null && !row().part.diff}>
          <section aria-label={t().parts.toolInput}><div class={styles.detailLabel}>{t().parts.toolInput}</div><pre>{detail(state().input)}</pre></section>
        </Show>
        <Show when={output()}>
          <section aria-label={t().parts.toolOutput}><div class={styles.detailLabel}>{t().parts.toolOutput}</div><pre>{output()}</pre></section>
        </Show>
        <Show when={row().part.diff}>{diff => <ContentDiff diff={diff()} />}</Show>
        <Show when={errorText(row().part)}><pre class={styles.error}>{errorText(row().part)}</pre></Show>
      </div></Show>
    </details>;
  };
  const contents = () => <Index each={props.items}>{item => <Show when={item().part.type === "tool"} fallback={props.renderReasoning(item)}>
    <Index each={rowsFor(item().part as ToolPart)}>{renderRow}</Index>
  </Show>}</Index>;

  return <div class={styles.root} data-component="tool-activity-group" data-group-id={props.id} data-grouped={grouped() ? "" : undefined} data-working={active() ? "" : undefined}>
    <Show when={grouped()} fallback={contents()}>
      <button type="button" class={styles.trigger} id={`${controlId}-trigger`} aria-expanded={props.expanded} aria-controls={`${controlId}-body`} onClick={() => props.onToggle()}>
        <span class={styles.icon} aria-hidden="true"><ActivityIcon kind={rows().every(row => ["read", "search", "list"].includes(kind(row))) ? "search" : "tool"} /></span>
        <span class={styles.summary}>{summary()}</span>
        <Show when={errors().length > 0}><span class={styles.errorLabel}>{t().common.error}</span></Show>
        <span class={styles.groupChevron} data-open={props.expanded ? "" : undefined} aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m6 9 6 6 6-6" /></svg></span>
      </button>
      <div id={`${controlId}-body`} hidden={!props.expanded} aria-labelledby={`${controlId}-trigger`}>
        <Show when={props.expanded}>
          <div class={styles.body} tabIndex={0} role="region" aria-label={summary()} onKeyDown={(event) => {
            const el = event.currentTarget;
            if (event.defaultPrevented || event.target !== el || el.scrollHeight <= el.clientHeight) return;
            const next = event.key === "Home" ? 0 : event.key === "End" ? el.scrollHeight
              : event.key === "PageUp" ? el.scrollTop - el.clientHeight * .8 : event.key === "PageDown" ? el.scrollTop + el.clientHeight * .8
              : event.key === "ArrowUp" ? el.scrollTop - 40 : event.key === "ArrowDown" ? el.scrollTop + 40
              : event.key === " " ? el.scrollTop + el.clientHeight * .8 * (event.shiftKey ? -1 : 1) : undefined;
            if (next === undefined) return;
            event.preventDefault(); event.stopPropagation(); el.scrollTop = next;
          }}>{contents()}</div>
        </Show>
      </div>
    </Show>
    <Show when={grouped() && !props.expanded && errors().length > 0}><div class={styles.errorSummary}><For each={errors()}>{part => <p>{errorText(part)}</p>}</For></div></Show>
  </div>;
}
