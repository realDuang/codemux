import { For, Show, createMemo } from "solid-js";
import type { ProjectPathFilter } from "../../shared/project-path-filter";
import { formatMessage, useI18n } from "../lib/i18n";
import { isElectron } from "../lib/platform";

interface ProjectPathListProps {
  kind: keyof ProjectPathFilter;
  paths: string[];
  pendingPath: string;
  expanded: boolean;
  disabled: boolean;
  error: string;
  knownPaths: string[];
  inputRef: (element: HTMLInputElement) => void;
  addButtonRef: (element: HTMLButtonElement) => void;
  onOpen: () => void;
  onAdd: (event: SubmitEvent) => void;
  onRemove: (path: string, event: MouseEvent) => void;
  onInput: (value: string) => void;
  onCancel: () => void;
  onBrowse: () => void;
  onSuggestion: (path: string) => void;
}

interface FolderIconProps {
  class?: string;
}

function FolderIcon(props: FolderIconProps) {
  return (
    <svg
      class={props.class}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z" />
    </svg>
  );
}

function pathName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) || path;
}

export function ProjectPathList(props: ProjectPathListProps) {
  const { t } = useI18n();
  const title = createMemo(() => (
    props.kind === "whitelist" ? t().settings.projectWhitelist : t().settings.projectBlacklist
  ));
  const hint = createMemo(() => (
    props.kind === "whitelist" ? t().settings.projectWhitelistHint : t().settings.projectBlacklistHint
  ));
  const emptyMessage = createMemo(() => (
    props.kind === "whitelist" ? t().settings.projectFilterWhitelistEmpty : t().settings.projectFilterBlacklistEmpty
  ));
  const inputId = createMemo(() => `project-${props.kind}`);
  const hintId = () => `${inputId()}-hint`;
  const errorId = () => `${inputId()}-error`;
  const formId = () => `${inputId()}-form`;
  const suggestions = createMemo(() => (
    props.knownPaths.filter((path) => !props.paths.includes(path)).slice(0, 3)
  ));

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && event.isComposing) event.preventDefault();
  };

  return (
    <div
      class="overflow-hidden rounded-lg border border-[var(--cm-hairline-strong)]"
      data-project-path-list={props.kind}
    >
      <div class="flex flex-wrap items-start justify-between gap-3 bg-[var(--cm-surface-2)] px-4 py-3.5">
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--cm-hairline)] bg-[var(--cm-surface)] text-[var(--cm-text-muted)]">
            <FolderIcon />
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h4 class="text-sm font-medium text-[var(--cm-text)]">{title()}</h4>
              <span
                class="rounded-md border border-[var(--cm-hairline)] bg-[var(--cm-surface)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--cm-text-muted)]"
                aria-label={formatMessage(t().settings.projectFilterPathCount, { count: props.paths.length })}
              >
                {props.paths.length}
              </span>
            </div>
            <p id={hintId()} class="mt-1 text-xs leading-relaxed text-[var(--cm-text-muted)]">
              {hint()}
            </p>
          </div>
        </div>
        <button
          ref={props.addButtonRef}
          type="button"
          onClick={() => props.onOpen()}
          disabled={props.disabled || props.expanded}
          aria-expanded={props.expanded}
          aria-controls={formId()}
          class="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--cm-text)] transition-colors hover:bg-[var(--cm-surface-3)] focus-visible:outline-2 focus-visible:outline-[var(--cm-accent)] disabled:opacity-40"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          {t().settings.projectFilterAddPath}
        </button>
      </div>
      <Show
        when={props.paths.length > 0}
        fallback={
          <div class="flex items-center gap-3 border-t border-[var(--cm-hairline)] px-4 py-5 text-[var(--cm-text-faint)]">
            <FolderIcon class="shrink-0 opacity-60" />
            <div>
              <p class="text-xs text-[var(--cm-text-muted)]">{emptyMessage()}</p>
              <p class="mt-1 text-[11px]">{t().settings.projectFilterEmptyHint}</p>
            </div>
          </div>
        }
      >
        <ul
          class="max-h-80 overflow-y-auto border-t border-[var(--cm-hairline)]"
          aria-label={title()}
        >
          <For each={props.paths}>
            {(path) => (
              <li
                class="group flex items-center gap-3 border-b border-[var(--cm-hairline)] px-4 py-3 last:border-b-0 hover:bg-[var(--cm-surface-2)]"
                data-project-path={path}
              >
                <FolderIcon class="shrink-0 text-[var(--cm-text-faint)]" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-xs font-medium text-[var(--cm-text)]">{pathName(path)}</p>
                  <p class="mt-1 break-all font-mono text-[11px] leading-relaxed text-[var(--cm-text-muted)]">
                    {path}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={(event) => props.onRemove(path, event)}
                  disabled={props.disabled}
                  aria-label={formatMessage(t().settings.projectFilterRemovePath, { path })}
                  title={formatMessage(t().settings.projectFilterRemovePath, { path })}
                  class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--cm-text-faint)] transition-colors hover:bg-red-500/10 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-[var(--cm-accent)] disabled:opacity-40 dark:hover:text-red-400"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />
                  </svg>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.expanded}>
        <form
          id={formId()}
          onSubmit={(event) => props.onAdd(event)}
          class="border-t border-[var(--cm-hairline)] bg-[var(--cm-surface-2)] p-4"
        >
          <div class="mb-2 flex items-center justify-between gap-2">
            <label for={inputId()} class="text-xs font-medium text-[var(--cm-text)]">
              {t().settings.projectFilterPathLabel}
            </label>
            <Show when={isElectron()}>
              <button
                type="button"
                onClick={() => props.onBrowse()}
                disabled={props.disabled}
                class="inline-flex items-center gap-1.5 text-xs text-[var(--cm-text-muted)] hover:text-[var(--cm-text)] disabled:opacity-40"
              >
                <FolderIcon class="!h-3.5 !w-3.5" />
                {t().settings.projectFilterBrowse}
              </button>
            </Show>
          </div>
          <div class="flex flex-col gap-2 sm:flex-row">
            <input
              ref={props.inputRef}
              id={inputId()}
              type="text"
              autocomplete="off"
              spellcheck={false}
              value={props.pendingPath}
              onInput={(event) => props.onInput(event.currentTarget.value)}
              onKeyDown={handleKeyDown}
              disabled={props.disabled}
              aria-describedby={`${hintId()} ${errorId()}`}
              aria-invalid={!!props.error}
              placeholder={t().settings.projectFilterPlaceholder}
              class="min-w-0 flex-1 rounded-md border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] px-3 py-2 font-mono text-xs text-[var(--cm-text)] placeholder:text-[var(--cm-text-faint)] focus:border-[var(--cm-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--cm-accent)] disabled:opacity-50"
            />
            <div class="flex items-center gap-2">
              <button
                type="submit"
                disabled={props.disabled}
                class="rounded-md bg-[var(--cm-accent)] px-3 py-2 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
              >
                {t().settings.projectFilterAdd}
              </button>
              <button
                type="button"
                onClick={() => props.onCancel()}
                disabled={props.disabled}
                class="rounded-md px-2.5 py-2 text-xs text-[var(--cm-text-muted)] hover:bg-[var(--cm-surface-3)] disabled:opacity-40"
              >
                {t().settings.projectFilterCancel}
              </button>
            </div>
          </div>
          <Show when={props.error}>
            <p id={errorId()} role="alert" class="mt-2 break-all text-xs text-red-600 dark:text-red-400">
              {props.error}
            </p>
          </Show>
          <Show when={suggestions().length > 0}>
            <div class="mt-3 flex flex-wrap items-center gap-1.5">
              <span class="mr-1 text-[10px] text-[var(--cm-text-faint)]">
                {t().settings.projectFilterSuggestions}
              </span>
              <For each={suggestions()}>
                {(path) => (
                  <button
                    type="button"
                    onClick={() => props.onSuggestion(path)}
                    disabled={props.disabled}
                    title={path}
                    class="max-w-full truncate rounded border border-[var(--cm-hairline)] bg-[var(--cm-surface)] px-2 py-1 font-mono text-[10px] text-[var(--cm-text-muted)] hover:border-[var(--cm-hairline-strong)] hover:text-[var(--cm-text)] disabled:opacity-40"
                  >
                    {pathName(path)}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </form>
      </Show>
    </div>
  );
}
