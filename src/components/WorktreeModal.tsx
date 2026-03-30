/**
 * WorktreeModal — Create, manage, and merge git worktrees for a project.
 */

import { createSignal, For, Show } from "solid-js";
import { useI18n, formatMessage } from "../lib/i18n";
import { gateway } from "../lib/gateway-api";
import { sessionStore, setSessionStore } from "../stores/session";
import type { UnifiedWorktree, WorktreeMergeResult } from "../types/unified";

interface WorktreeModalProps {
  projectDirectory: string;
  onClose: () => void;
  onWorktreeCreated?: (worktree: UnifiedWorktree) => void;
}

export default function WorktreeModal(props: WorktreeModalProps) {
  const { t } = useI18n();

  const [worktrees, setWorktrees] = createSignal<UnifiedWorktree[]>([]);
  const [branches, setBranches] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [creating, setCreating] = createSignal(false);

  // Create form
  const [newName, setNewName] = createSignal("");
  const [baseBranch, setBaseBranch] = createSignal("");

  // Merge
  const [mergingWorktree, setMergingWorktree] = createSignal<string | null>(null);
  const [mergeTarget, setMergeTarget] = createSignal("");
  const [mergeResult, setMergeResult] = createSignal<WorktreeMergeResult | null>(null);

  // Error
  const [error, setError] = createSignal("");

  // Load data
  const loadData = async () => {
    setLoading(true);
    try {
      const [wts, brs] = await Promise.all([
        gateway.listWorktrees(props.projectDirectory),
        gateway.listBranches(props.projectDirectory),
      ]);
      setWorktrees(wts);
      setBranches(brs);
      if (brs.length > 0 && !baseBranch()) {
        setBaseBranch(brs.find((b) => b === "main" || b === "master") || brs[0]);
      }
      if (brs.length > 0 && !mergeTarget()) {
        setMergeTarget(brs.find((b) => b === "main" || b === "master") || brs[0]);
      }
    } catch (err) {
      setError(String(err));
    }
    setLoading(false);
  };

  loadData();

  const handleCreate = async () => {
    setCreating(true);
    setError("");
    try {
      const wt = await gateway.createWorktree(props.projectDirectory, {
        name: newName().trim() || undefined,
        baseBranch: baseBranch() || undefined,
      });
      setNewName("");
      setWorktrees((prev) => [...prev, wt]);
      setSessionStore("worktrees", props.projectDirectory, [...(sessionStore.worktrees[props.projectDirectory] || []), wt]);
      props.onWorktreeCreated?.(wt);
    } catch (err) {
      setError(String(err));
    }
    setCreating(false);
  };

  const handleRemove = async (name: string) => {
    if (!confirm(formatMessage(t().worktree.confirmDelete, { name }))) return;
    setError("");
    try {
      await gateway.removeWorktree(props.projectDirectory, name);
      setWorktrees((prev) => prev.filter((w) => w.name !== name));
      setSessionStore("worktrees", props.projectDirectory,
        (sessionStore.worktrees[props.projectDirectory] || []).filter((w) => w.name !== name),
      );
    } catch (err) {
      setError(String(err));
    }
  };

  const handleMerge = async (name: string) => {
    setError("");
    setMergeResult(null);
    try {
      const result = await gateway.mergeWorktree(
        props.projectDirectory,
        name,
        mergeTarget() || undefined,
      );
      setMergeResult(result);
      setMergingWorktree(null);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={props.onClose}>
      <div
        class="bg-white dark:bg-slate-800 rounded-xl shadow-xl max-w-lg w-full mx-4 max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div class="px-6 py-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-gray-900 dark:text-white">
            {t().worktree.title}
          </h2>
          <button
            onClick={props.onClose}
            class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div class="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {/* Error */}
          <Show when={error()}>
            <div class="p-3 bg-red-50 dark:bg-red-900/20 rounded-lg text-sm text-red-700 dark:text-red-300">
              {error()}
            </div>
          </Show>

          {/* Merge result */}
          <Show when={mergeResult()}>
            {(result) => (
              <div class={`p-3 rounded-lg text-sm ${
                result().success
                  ? "bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300"
                  : "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300"
              }`}>
                <p>{result().message}</p>
                <Show when={result().conflicts && result().conflicts!.length > 0}>
                  <ul class="mt-2 space-y-1">
                    <For each={result().conflicts}>
                      {(file) => <li class="font-mono text-xs">• {file}</li>}
                    </For>
                  </ul>
                </Show>
              </div>
            )}
          </Show>

          {/* Create new worktree */}
          <div class="space-y-3">
            <h3 class="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t().worktree.create}
            </h3>
            <div class="flex gap-2">
              <input
                type="text"
                value={newName()}
                onInput={(e) => setNewName(e.currentTarget.value)}
                placeholder={t().worktree.namePlaceholder}
                class="flex-1 px-3 py-2 text-sm bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-600 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div class="flex gap-2 items-end">
              <div class="flex-1">
                <label class="text-xs text-gray-500 dark:text-gray-400 mb-1 block">
                  {t().worktree.baseBranch}
                </label>
                <select
                  value={baseBranch()}
                  onChange={(e) => setBaseBranch(e.target.value)}
                  class="w-full px-3 py-2 text-sm bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-600 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <For each={branches()}>
                    {(branch) => <option value={branch}>{branch}</option>}
                  </For>
                </select>
              </div>
              <button
                onClick={handleCreate}
                disabled={creating() || loading()}
                class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {creating() ? t().worktree.creating : t().worktree.create}
              </button>
            </div>
          </div>

          {/* Existing worktrees */}
          <Show when={!loading()} fallback={
            <div class="py-4 text-center text-sm text-gray-400">Loading...</div>
          }>
            <Show when={worktrees().length > 0}>
              <div class="space-y-2">
                <h3 class="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t().worktree.title} ({worktrees().length})
                </h3>
                <For each={worktrees()}>
                  {(wt) => (
                    <div class="p-3 bg-gray-50 dark:bg-slate-900 rounded-lg border border-gray-200 dark:border-slate-700">
                      <div class="flex items-center justify-between">
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                              class="text-emerald-500 dark:text-emerald-400 flex-shrink-0"
                            >
                              <path d="M6 3v12" /><path d="M18 9a3 3 0 0 0-3-3h-4a3 3 0 0 0-3 3" />
                              <circle cx="18" cy="18" r="3" /><path d="M6 21v-6" />
                            </svg>
                            <span class="text-sm font-medium text-gray-900 dark:text-white truncate">
                              {wt.name}
                            </span>
                          </div>
                          <div class="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate font-mono">
                            {wt.branch} ← {wt.baseBranch}
                          </div>
                        </div>
                        <div class="flex items-center gap-1 ml-2">
                          {/* Merge button */}
                          <button
                            onClick={() => setMergingWorktree(mergingWorktree() === wt.name ? null : wt.name)}
                            class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded transition-all"
                            title={t().worktree.merge}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="m18 9-6 6-6-6" />
                            </svg>
                          </button>
                          {/* Delete button */}
                          <button
                            onClick={() => handleRemove(wt.name)}
                            class="p-1.5 text-gray-400 hover:text-red-500 rounded transition-all"
                            title={t().worktree.remove}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      </div>
                      {/* Merge UI (expanded) */}
                      <Show when={mergingWorktree() === wt.name}>
                        <div class="mt-3 pt-3 border-t border-gray-200 dark:border-slate-700">
                          <div class="flex gap-2 items-end">
                            <div class="flex-1">
                              <label class="text-xs text-gray-500 dark:text-gray-400 mb-1 block">
                                {t().worktree.targetBranch}
                              </label>
                              <select
                                value={mergeTarget()}
                                onChange={(e) => setMergeTarget(e.target.value)}
                                class="w-full px-2 py-1.5 text-sm bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                              >
                                <For each={branches().filter((b) => b !== wt.branch)}>
                                  {(branch) => <option value={branch}>{branch}</option>}
                                </For>
                              </select>
                            </div>
                            <button
                              onClick={() => handleMerge(wt.name)}
                              class="px-3 py-1.5 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors"
                            >
                              {t().worktree.merge}
                            </button>
                          </div>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
