import { For, Show, createSignal, createMemo } from "solid-js";
import { useI18n, formatMessage } from "../lib/i18n";
import { gateway } from "../lib/gateway-api";
import type { EngineType, ImportableSession, SessionImportProgress } from "../types/unified";

interface Props {
  engineType: EngineType;
  onClose: () => void;
  onImportComplete: () => void;
}

type Phase = "select" | "preview" | "importing" | "done";

export default function ImportHistoryModal(props: Props) {
  const { t } = useI18n();

  const [phase, setPhase] = createSignal<Phase>("select");
  const [limit, setLimit] = createSignal(50);
  const [sessions, setSessions] = createSignal<ImportableSession[]>([]);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [loading, setLoading] = createSignal(false);
  const [progress, setProgress] = createSignal<SessionImportProgress | null>(null);
  const [result, setResult] = createSignal<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const [error, setError] = createSignal("");

  const importableSessions = createMemo(() =>
    sessions().filter((s) => !s.alreadyImported),
  );

  const selectedCount = createMemo(() => selected().size);

  const handlePreview = async () => {
    setLoading(true);
    setError("");
    try {
      const list = await gateway.importPreview(props.engineType, limit());
      setSessions(list);
      // Auto-select all importable sessions
      const sel = new Set<string>();
      for (const s of list) {
        if (!s.alreadyImported) sel.add(s.engineSessionId);
      }
      setSelected(sel);
      setPhase("preview");
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  const toggleSession = (id: string) => {
    const s = new Set(selected());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSelected(s);
  };

  const toggleAll = () => {
    if (selectedCount() === importableSessions().length) {
      setSelected(new Set<string>());
    } else {
      const sel = new Set<string>();
      for (const s of importableSessions()) sel.add(s.engineSessionId);
      setSelected(sel);
    }
  };

  const handleImport = async () => {
    const toImport = sessions().filter((s) => selected().has(s.engineSessionId));
    if (toImport.length === 0) return;

    setPhase("importing");
    setProgress({ total: toImport.length, completed: 0, currentTitle: "", errors: [] });

    try {
      const r = await gateway.importExecute(
        props.engineType,
        toImport.map((s) => ({
          engineSessionId: s.engineSessionId,
          directory: s.directory,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          engineMeta: s.engineMeta,
        })),
        (p) => setProgress(p),
      );
      setResult(r);
      setPhase("done");
      props.onImportComplete();
    } catch (err: any) {
      setResult({ imported: 0, skipped: 0, errors: [err?.message ?? String(err)] });
      setPhase("done");
    }
  };

  const formatTime = (ts: number) => {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const truncateDir = (dir: string) => {
    const parts = dir.split(/[/\\]/).filter(Boolean);
    return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : dir;
  };

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget && phase() !== "importing") props.onClose(); }}>
      <div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div class="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h3 class="text-lg font-semibold text-gray-900 dark:text-white">
            {t().settings.importHistory}
          </h3>
          <Show when={phase() !== "importing"}>
            <button onClick={props.onClose} class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none">&times;</button>
          </Show>
        </div>

        {/* Body */}
        <div class="flex-1 overflow-y-auto px-6 py-4">
          {/* Phase: Select limit */}
          <Show when={phase() === "select"}>
            <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
              {t().settings.importHistoryDesc}
            </p>
            <div class="flex flex-wrap gap-2 mb-4">
              <For each={[
                { value: 10, label: t().settings.importLast10 },
                { value: 50, label: t().settings.importLast50 },
                { value: 100, label: t().settings.importLast100 },
                { value: 0, label: t().settings.importAll },
              ]}>
                {(opt) => (
                  <button
                    onClick={() => setLimit(opt.value)}
                    class={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                      limit() === opt.value
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-600"
                    }`}
                  >
                    {opt.label}
                  </button>
                )}
              </For>
            </div>
            <Show when={error()}>
              <p class="text-sm text-red-600 dark:text-red-400 mb-2">{error()}</p>
            </Show>
          </Show>

          {/* Phase: Preview list */}
          <Show when={phase() === "preview"}>
            <Show when={sessions().length === 0}>
              <p class="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
                {t().settings.importNoSessions}
              </p>
            </Show>
            <Show when={sessions().length > 0}>
              <div class="flex items-center justify-between mb-3">
                <label class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedCount() === importableSessions().length && importableSessions().length > 0}
                    onChange={toggleAll}
                    class="rounded border-gray-300 dark:border-slate-600"
                  />
                  {selectedCount()}/{sessions().length}
                </label>
              </div>
              <div class="space-y-1 max-h-[45vh] overflow-y-auto">
                <For each={sessions()}>
                  {(s) => (
                    <div class={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm ${
                      s.alreadyImported
                        ? (selected().has(s.engineSessionId)
                          ? "bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800"
                          : "bg-gray-50 dark:bg-slate-700/50")
                        : "hover:bg-gray-50 dark:hover:bg-slate-700/50"
                    }`}>
                      <input
                        type="checkbox"
                        checked={selected().has(s.engineSessionId)}
                        onChange={() => toggleSession(s.engineSessionId)}
                        class="rounded border-gray-300 dark:border-slate-600 flex-shrink-0"
                      />
                      <div class="min-w-0 flex-1">
                        <div class="truncate font-medium text-gray-800 dark:text-gray-200">
                          {s.title}
                        </div>
                        <div class="flex gap-2 text-xs text-gray-400 dark:text-gray-500">
                          <span>{truncateDir(s.directory)}</span>
                          <span>{formatTime(s.updatedAt)}</span>
                        </div>
                      </div>
                      <Show when={s.alreadyImported}>
                        <span class={`text-xs flex-shrink-0 ${
                          selected().has(s.engineSessionId)
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-green-600 dark:text-green-400"
                        }`}>
                          {selected().has(s.engineSessionId)
                            ? t().settings.importWillReimport
                            : t().settings.importAlreadyImported}
                        </span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>

          {/* Phase: Importing */}
          <Show when={phase() === "importing"}>
            <div class="py-8 text-center">
              <div class="mb-4">
                <div class="w-full bg-gray-200 dark:bg-slate-700 rounded-full h-2">
                  <div
                    class="bg-blue-600 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${progress() ? (progress()!.completed / progress()!.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
              <p class="text-sm text-gray-600 dark:text-gray-400">
                {progress() ? formatMessage(t().settings.importProgress, {
                  completed: String(progress()!.completed),
                  total: String(progress()!.total),
                  title: progress()!.currentTitle || "...",
                }) : t().common.loading}
              </p>
            </div>
          </Show>

          {/* Phase: Done */}
          <Show when={phase() === "done"}>
            <div class="py-6 text-center">
              <div class="text-3xl mb-2">✅</div>
              <h4 class="text-base font-medium text-gray-900 dark:text-white mb-1">
                {t().settings.importComplete}
              </h4>
              <p class="text-sm text-gray-600 dark:text-gray-400">
                {result() ? formatMessage(t().settings.importCompleteDesc, {
                  imported: String(result()!.imported),
                  skipped: String(result()!.skipped),
                  errors: String(result()!.errors.length),
                }) : ""}
              </p>
              <Show when={result()?.errors && result()!.errors.length > 0}>
                <div class="mt-3 text-left max-h-32 overflow-y-auto bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
                  <For each={result()!.errors}>
                    {(err) => (
                      <p class="text-xs text-red-600 dark:text-red-400 mb-1">{err}</p>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
        </div>

        {/* Footer */}
        <div class="px-6 py-4 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-3">
          <Show when={phase() === "select"}>
            <button
              onClick={props.onClose}
              class="px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-700"
            >
              {t().common.cancel}
            </button>
            <button
              onClick={handlePreview}
              disabled={loading()}
              class="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {loading() ? t().common.loading : t().settings.importPreview}
            </button>
          </Show>

          <Show when={phase() === "preview"}>
            <button
              onClick={() => setPhase("select")}
              class="px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-700"
            >
              {t().settings.back}
            </button>
            <button
              onClick={handleImport}
              disabled={selectedCount() === 0}
              class="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {t().settings.importExecute} ({selectedCount()})
            </button>
          </Show>

          <Show when={phase() === "done"}>
            <button
              onClick={props.onClose}
              class="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700"
            >
              {t().common.confirm}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
