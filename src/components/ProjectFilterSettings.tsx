import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import {
  MAX_PROJECT_FILTER_PATHS,
  normalizeProjectPath,
  readProjectPathFilter,
  type ProjectPathFilter,
} from "../../shared/project-path-filter";
import { systemAPI } from "../lib/electron-api";
import { formatMessage, useI18n } from "../lib/i18n";
import { bootstrapHostSettings, getSetting, saveSetting } from "../lib/settings";
import { sessionStore, setSessionStore } from "../stores/session";
import { ProjectPathList } from "./ProjectPathList";
import { Spinner } from "./Spinner";

type PathListKind = keyof ProjectPathFilter;
const PATH_LIST_KINDS: PathListKind[] = ["whitelist", "blacklist"];

export function ProjectFilterSettings() {
  const { t } = useI18n();
  const initial = readProjectPathFilter(getSetting("projectPathFilter"));
  const [savedFilter, setSavedFilter] = createSignal(initial);
  const [draftFilter, setDraftFilter] = createSignal(readProjectPathFilter(initial));
  const [pendingPaths, setPendingPaths] = createSignal({ whitelist: "", blacklist: "" });
  const [expandedLists, setExpandedLists] = createSignal({ whitelist: false, blacklist: false });
  const [entryErrors, setEntryErrors] = createSignal({ whitelist: "", blacklist: "" });
  const [error, setError] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [edited, setEdited] = createSignal(false);
  const [browsing, setBrowsing] = createSignal<PathListKind | null>(null);
  const inputRefs: Partial<Record<PathListKind, HTMLInputElement>> = {};
  const addButtonRefs: Partial<Record<PathListKind, HTMLButtonElement>> = {};
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const disabled = createMemo(() => loading() || saving() || browsing() !== null);
  const isDirty = createMemo(() => JSON.stringify(draftFilter()) !== JSON.stringify(savedFilter()));
  const hasPendingInput = createMemo(() => PATH_LIST_KINDS.some((kind) => pendingPaths()[kind].trim()));
  const hasChanges = createMemo(() => isDirty() || hasPendingInput());
  const statusColor = createMemo(() => {
    if (saved()) return "bg-emerald-500";
    if (hasChanges()) return "bg-amber-500";
    return "bg-[var(--cm-text-faint)]";
  });
  const statusMessage = createMemo(() => {
    if (saved()) return t().settings.projectFilterSaved;
    if (hasChanges()) return t().settings.projectFilterUnsaved;
    return t().settings.projectFilterPreserveHistory;
  });
  const knownPaths = createMemo(() => {
    const projects = [
      ...sessionStore.projects,
      ...Object.values(sessionStore.catalogs).flatMap((catalog) => catalog.projects),
    ];
    const paths = projects.flatMap((project) => [project.directory, ...(project.roots ?? [])]);
    const normalizedPaths = paths
      .map(normalizeProjectPath)
      .filter((path): path is string => path !== null && path !== "/");
    return [...new Set(normalizedPaths)];
  });

  onMount(async () => {
    await bootstrapHostSettings();
    if (disposed) return;
    setSessionStore("projectPathFilter", readProjectPathFilter(getSetting("projectPathFilter")));
    setLoading(false);
  });

  // A save may finish after navigation; untouched forms follow the applied rules.
  createEffect(() => {
    const filter = sessionStore.projectPathFilter;
    if (loading() || saving() || edited()) return;
    const snapshot = { whitelist: [...filter.whitelist], blacklist: [...filter.blacklist] };
    setSavedFilter(snapshot);
    setDraftFilter(readProjectPathFilter(snapshot));
  });

  const handleEdit = () => {
    setEdited(true);
    setError("");
    setSaved(false);
  };

  const handleInput = (kind: PathListKind, value: string) => {
    handleEdit();
    setPendingPaths((current) => ({ ...current, [kind]: value }));
    setEntryErrors((current) => ({ ...current, [kind]: "" }));
  };

  const focusInput = (kind: PathListKind) => {
    queueMicrotask(() => {
      if (!disposed) inputRefs[kind]?.focus();
    });
  };

  const handleOpen = (kind: PathListKind) => {
    setExpandedLists((current) => ({ ...current, [kind]: true }));
    focusInput(kind);
  };

  const validateEntry = (kind: PathListKind, paths: string[], allowDuplicate = false): string | null => {
    const value = pendingPaths()[kind].trim();
    const path = normalizeProjectPath(value);
    let message = "";
    if (!value) {
      message = t().settings.projectFilterPathRequired;
    } else if (!path) {
      message = formatMessage(t().settings.projectFilterInvalidPath, { path: value });
    } else if (paths.includes(path)) {
      if (!allowDuplicate) message = t().settings.projectFilterDuplicatePath;
    } else if (paths.length >= MAX_PROJECT_FILTER_PATHS) {
      message = formatMessage(t().settings.projectFilterTooManyPaths, { count: MAX_PROJECT_FILTER_PATHS });
    }
    setEntryErrors((current) => ({ ...current, [kind]: message }));
    if (message) {
      handleOpen(kind);
      return null;
    }
    return path;
  };

  const handleAdd = (kind: PathListKind, event: SubmitEvent) => {
    event.preventDefault();
    if (disabled()) return;
    const paths = draftFilter()[kind];
    const path = validateEntry(kind, paths);
    if (!path) return;
    handleEdit();
    setDraftFilter((current) => ({ ...current, [kind]: [...paths, path] }));
    setPendingPaths((current) => ({ ...current, [kind]: "" }));
    focusInput(kind);
  };

  const handleRemove = (kind: PathListKind, path: string, event: MouseEvent) => {
    if (disabled()) return;
    const row = (event.currentTarget as HTMLButtonElement).closest("li");
    const adjacentRow = row?.nextElementSibling ?? row?.previousElementSibling;
    const adjacentButton = adjacentRow?.querySelector<HTMLButtonElement>("button");
    const fallback = expandedLists()[kind] ? inputRefs[kind] : addButtonRefs[kind];
    handleEdit();
    setDraftFilter((current) => ({ ...current, [kind]: current[kind].filter((item) => item !== path) }));
    (adjacentButton ?? fallback)?.focus();
  };

  const handleCancel = (kind: PathListKind) => {
    setPendingPaths((current) => ({ ...current, [kind]: "" }));
    setEntryErrors((current) => ({ ...current, [kind]: "" }));
    setExpandedLists((current) => ({ ...current, [kind]: false }));
    if (!hasChanges()) setEdited(false);
    addButtonRefs[kind]?.focus();
  };

  const handleBrowse = async (kind: PathListKind) => {
    if (disabled()) return;
    setBrowsing(kind);
    try {
      const path = await systemAPI.selectDirectory();
      if (path && !disposed) handleInput(kind, path);
    } catch {
      if (!disposed) {
        setEntryErrors((current) => ({ ...current, [kind]: t().settings.projectFilterBrowseFailed }));
      }
    } finally {
      if (!disposed) {
        setBrowsing(null);
        focusInput(kind);
      }
    }
  };

  const handleDiscard = () => {
    setPendingPaths({ whitelist: "", blacklist: "" });
    setExpandedLists({ whitelist: false, blacklist: false });
    setEntryErrors({ whitelist: "", blacklist: "" });
    setError("");
    setSaved(false);
    setEdited(false);
  };

  const handleSave = async () => {
    if (disabled() || !hasChanges()) return;
    const filter = readProjectPathFilter(draftFilter());
    // Save includes unfinished valid entries rather than silently losing typed paths.
    for (const kind of PATH_LIST_KINDS) {
      if (!pendingPaths()[kind].trim()) continue;
      const path = validateEntry(kind, filter[kind], true);
      if (!path) return;
      if (!filter[kind].includes(path)) filter[kind].push(path);
    }
    handleEdit();
    setDraftFilter(filter);
    setPendingPaths({ whitelist: "", blacklist: "" });
    setSaving(true);
    try {
      await saveSetting("projectPathFilter", filter, { requireHostPersistence: true });
      setSessionStore("projectPathFilter", filter);
      if (disposed) return;
      setSavedFilter(readProjectPathFilter(filter));
      setExpandedLists({ whitelist: false, blacklist: false });
      setSaved(true);
      setEdited(false);
    } catch {
      if (!disposed) setError(t().settings.projectFilterSaveFailed);
    } finally {
      if (!disposed) setSaving(false);
    }
  };

  return (
    <section id="section-projects">
      <h2 class="cm-eyebrow !text-[11px] mb-3 px-1">{t().settings.projectFilterTitle}</h2>
      <div class="overflow-hidden rounded-xl border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] shadow-[var(--cm-shadow-sm)] dark:bg-white/[0.025]">
        <div class="p-4 sm:p-6">
          <h3 class="text-base font-medium text-[var(--cm-text)]">
            {t().settings.projectFilterHeading}
          </h3>
          <p class="mt-1 text-sm leading-relaxed text-[var(--cm-text-muted)]">
            {t().settings.projectFilterDescription}
          </p>
          <div class="mt-5 space-y-4">
            <For each={PATH_LIST_KINDS}>
              {(kind) => (
                <ProjectPathList
                  kind={kind}
                  paths={draftFilter()[kind]}
                  pendingPath={pendingPaths()[kind]}
                  expanded={expandedLists()[kind]}
                  disabled={disabled()}
                  error={entryErrors()[kind]}
                  knownPaths={knownPaths()}
                  inputRef={(element) => {
                    inputRefs[kind] = element;
                  }}
                  addButtonRef={(element) => {
                    addButtonRefs[kind] = element;
                  }}
                  onOpen={() => handleOpen(kind)}
                  onAdd={(event) => handleAdd(kind, event)}
                  onRemove={(path, event) => handleRemove(kind, path, event)}
                  onInput={(value) => handleInput(kind, value)}
                  onCancel={() => handleCancel(kind)}
                  onBrowse={() => void handleBrowse(kind)}
                  onSuggestion={(path) => {
                    handleInput(kind, path);
                    focusInput(kind);
                  }}
                />
              )}
            </For>
          </div>
          <Show when={error()}>
            <p role="alert" class="mt-3 break-words text-xs text-red-600 dark:text-red-400">
              {error()}
            </p>
          </Show>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--cm-hairline)] px-4 py-3 sm:px-6">
          <p role="status" aria-live="polite" class="flex items-center gap-2 text-xs text-[var(--cm-text-muted)]">
            <span
              class={`h-1.5 w-1.5 shrink-0 rounded-full ${statusColor()}`}
              aria-hidden="true"
            />
            {statusMessage()}
          </p>
          <div class="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDiscard}
              disabled={disabled() || !hasChanges()}
              class="rounded-md px-3 py-2 text-xs font-medium text-[var(--cm-text-muted)] hover:bg-[var(--cm-surface-3)] disabled:opacity-40"
            >
              {t().settings.projectFilterDiscard}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={disabled() || !hasChanges()}
              class="inline-flex items-center gap-2 rounded-md bg-[var(--cm-accent)] px-4 py-2 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              <Show when={saving()}>
                <Spinner size="small" />
              </Show>
              <Show when={saving()} fallback={t().settings.projectFilterSave}>
                {t().channel.saving}
              </Show>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
