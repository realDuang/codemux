/**
 * WorktreeModal — Simple dialog to create a new git worktree.
 * Management actions (delete, merge) live on the sidebar worktree row.
 */

import { createSignal, For, Show } from "solid-js";
import { useI18n } from "../lib/i18n";
import { gateway } from "../lib/gateway-api";
import type { UnifiedWorktree } from "../types/unified";

interface WorktreeModalProps {
  projectDirectory: string;
  onClose: () => void;
  onWorktreeCreated?: (worktree: UnifiedWorktree) => void;
}

export default function WorktreeModal(props: WorktreeModalProps) {
  const { t } = useI18n();

  const [branches, setBranches] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [creating, setCreating] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [baseBranch, setBaseBranch] = createSignal("");
  const [error, setError] = createSignal("");

  // Load branches on mount
  gateway.listBranches(props.projectDirectory).then((brs) => {
    setBranches(brs);
    if (brs.length > 0) {
      setBaseBranch(brs.find((b) => b === "main" || b === "master") || brs[0]);
    }
    setLoading(false);
  }).catch((err) => {
    setError(String(err));
    setLoading(false);
  });

  const handleCreate = async () => {
    setCreating(true);
    setError("");
    try {
      const wt = await gateway.createWorktree(props.projectDirectory, {
        name: newName().trim() || undefined,
        baseBranch: baseBranch() || undefined,
      });
      props.onWorktreeCreated?.(wt);
      props.onClose();
    } catch (err) {
      setError(String(err));
      setCreating(false);
    }
  };

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={props.onClose}>
      <div
        class="bg-white dark:bg-slate-800 rounded-xl shadow-xl max-w-md w-full mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div class="px-6 py-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-gray-900 dark:text-white">
            {t().worktree.create}
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
        <div class="px-6 py-4 space-y-4">
          <Show when={error()}>
            <div class="p-3 bg-red-50 dark:bg-red-900/20 rounded-lg text-sm text-red-700 dark:text-red-300">
              {error()}
            </div>
          </Show>

          <div>
            <label class="text-sm text-gray-600 dark:text-gray-400 mb-1.5 block">
              {t().worktree.name}
            </label>
            <input
              type="text"
              value={newName()}
              onInput={(e) => setNewName(e.currentTarget.value)}
              placeholder={t().worktree.namePlaceholder}
              class="w-full px-3 py-2 text-sm bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-600 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label class="text-sm text-gray-600 dark:text-gray-400 mb-1.5 block">
              {t().worktree.baseBranch}
            </label>
            <select
              value={baseBranch()}
              onChange={(e) => setBaseBranch(e.target.value)}
              disabled={loading()}
              class="w-full px-3 py-2 text-sm bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-600 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            >
              <For each={branches()}>
                {(branch) => <option value={branch}>{branch}</option>}
              </For>
            </select>
          </div>
        </div>

        {/* Footer */}
        <div class="px-6 py-4 border-t border-gray-200 dark:border-slate-700 flex justify-end gap-3">
          <button
            onClick={props.onClose}
            class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
          >
            {t().common.cancel}
          </button>
          <button
            onClick={handleCreate}
            disabled={creating() || loading()}
            class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            {creating() ? t().worktree.creating : t().worktree.create}
          </button>
        </div>
      </div>
    </div>
  );
}

