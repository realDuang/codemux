/**
 * MergeWorktreeModal — Select target branch, merge mode, and commit message.
 */

import { createSignal, For, Show } from "solid-js";
import { useI18n, formatMessage } from "../lib/i18n";
import { gateway } from "../lib/gateway-api";
import type { WorktreeMergeResult } from "../types/unified";

interface MergeWorktreeModalProps {
  projectDirectory: string;
  worktreeName: string;
  worktreeBranch: string;
  onClose: () => void;
  onMerged?: (result: WorktreeMergeResult) => void;
}

export default function MergeWorktreeModal(props: MergeWorktreeModalProps) {
  const { t } = useI18n();

  const [branches, setBranches] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [merging, setMerging] = createSignal(false);
  const [targetBranch, setTargetBranch] = createSignal("");
  const [mode, setMode] = createSignal<"merge" | "squash" | "rebase">("merge");
  const [message, setMessage] = createSignal("");
  const [result, setResult] = createSignal<WorktreeMergeResult | null>(null);
  const [error, setError] = createSignal("");

  // Load branches
  gateway.listBranches(props.projectDirectory).then((brs) => {
    // Exclude the worktree's own branch
    const filtered = brs.filter((b) => b !== props.worktreeBranch);
    setBranches(filtered);
    if (filtered.length > 0) {
      setTargetBranch(filtered.find((b) => b === "main" || b === "master") || filtered[0]);
    }
    setMessage(`Merge ${props.worktreeBranch} into ${filtered.find((b) => b === "main" || b === "master") || filtered[0] || "main"}`);
    setLoading(false);
  }).catch((err) => {
    setError(String(err));
    setLoading(false);
  });

  const handleMerge = async () => {
    setMerging(true);
    setError("");
    setResult(null);
    try {
      const res = await gateway.mergeWorktree(props.projectDirectory, props.worktreeName, {
        targetBranch: targetBranch(),
        mode: mode(),
        message: message().trim() || undefined,
      });
      setResult(res);
      if (res.success) {
        props.onMerged?.(res);
      }
    } catch (err) {
      setError(String(err));
    }
    setMerging(false);
  };

  const modeOptions = [
    { value: "merge" as const, label: "Merge", desc: t().worktree.modeMergeDesc },
    { value: "squash" as const, label: "Squash", desc: t().worktree.modeSquashDesc },
    { value: "rebase" as const, label: "Rebase", desc: t().worktree.modeRebaseDesc },
  ];

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={props.onClose}>
      <div
        class="bg-white dark:bg-slate-800 rounded-xl shadow-xl max-w-md w-full mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div class="px-6 py-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h2 class="text-lg font-semibold text-gray-900 dark:text-white">
              {t().worktree.merge}
            </h2>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 font-mono">
              {props.worktreeBranch}
            </p>
          </div>
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
          {/* Error */}
          <Show when={error()}>
            <div class="p-3 bg-red-50 dark:bg-red-900/20 rounded-lg text-sm text-red-700 dark:text-red-300">
              {error()}
            </div>
          </Show>

          {/* Result */}
          <Show when={result()}>
            {(res) => (
              <div class={`p-3 rounded-lg text-sm ${
                res().success
                  ? "bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300"
                  : "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300"
              }`}>
                <p>
                  {res().success
                    ? formatMessage(t().worktree.mergeSuccess, { branch: props.worktreeBranch, target: targetBranch() })
                    : res().conflicts?.length
                      ? formatMessage(t().worktree.mergeConflict, { count: String(res().conflicts!.length) })
                      : formatMessage(t().worktree.mergeFailed, { message: res().message })
                  }
                </p>
                <Show when={res().conflicts && res().conflicts!.length > 0}>
                  <ul class="mt-2 space-y-0.5">
                    <For each={res().conflicts}>
                      {(file) => <li class="font-mono text-xs">• {file}</li>}
                    </For>
                  </ul>
                </Show>
              </div>
            )}
          </Show>

          {/* Target branch */}
          <Show when={!result()?.success}>
            <div>
              <label class="text-sm text-gray-600 dark:text-gray-400 mb-1.5 block">
                {t().worktree.targetBranch}
              </label>
              <select
                value={targetBranch()}
                onChange={(e) => {
                  setTargetBranch(e.target.value);
                  setMessage(`Merge ${props.worktreeBranch} into ${e.target.value}`);
                }}
                disabled={loading()}
                class="w-full px-3 py-2 text-sm bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-600 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
              >
                <For each={branches()}>
                  {(branch) => <option value={branch}>{branch}</option>}
                </For>
              </select>
            </div>

            {/* Merge mode */}
            <div>
              <label class="text-sm text-gray-600 dark:text-gray-400 mb-1.5 block">
                {t().worktree.mergeMode}
              </label>
              <div class="space-y-2">
                <For each={modeOptions}>
                  {(opt) => (
                    <label class={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                      mode() === opt.value
                        ? "border-blue-500 bg-blue-50/50 dark:bg-blue-900/20"
                        : "border-gray-200 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-900"
                    }`}>
                      <input
                        type="radio"
                        name="mergeMode"
                        value={opt.value}
                        checked={mode() === opt.value}
                        onChange={() => setMode(opt.value)}
                        class="mt-0.5 accent-blue-600"
                      />
                      <div>
                        <div class="text-sm font-medium text-gray-900 dark:text-white">{opt.label}</div>
                        <div class="text-xs text-gray-500 dark:text-gray-400">{opt.desc}</div>
                      </div>
                    </label>
                  )}
                </For>
              </div>
            </div>

            {/* Commit message */}
            <div>
              <label class="text-sm text-gray-600 dark:text-gray-400 mb-1.5 block">
                {t().worktree.mergeMessage}
              </label>
              <input
                type="text"
                value={message()}
                onInput={(e) => setMessage(e.currentTarget.value)}
                class="w-full px-3 py-2 text-sm bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-600 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </Show>
        </div>

        {/* Footer */}
        <div class="px-6 py-4 border-t border-gray-200 dark:border-slate-700 flex justify-end gap-3">
          <button
            onClick={props.onClose}
            class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
          >
            {t().common.cancel}
          </button>
          <Show when={!result()?.success}>
            <button
              onClick={handleMerge}
              disabled={merging() || loading() || !targetBranch()}
              class="px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
            >
              {merging() ? t().worktree.merging : t().worktree.merge}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
