import { createSignal, Show } from "solid-js";
import { useI18n, formatMessage } from "../lib/i18n";
import { WorktreeInfo } from "../stores/session";

interface MergeDialogProps {
  isOpen: boolean;
  worktree: WorktreeInfo | null;
  onClose: () => void;
  onMerge: (commitMessage: string) => Promise<void>;
}

export function MergeDialog(props: MergeDialogProps) {
  const { t } = useI18n();
  const [commitMessage, setCommitMessage] = createSignal("");
  const [isMerging, setIsMerging] = createSignal(false);

  const handleMerge = async () => {
    if (!commitMessage().trim()) return;
    setIsMerging(true);
    try {
      await props.onMerge(commitMessage().trim());
      setCommitMessage("");
      props.onClose();
    } finally {
      setIsMerging(false);
    }
  };

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && !isMerging()) {
      props.onClose();
    }
  };

  return (
    <Show when={props.isOpen && props.worktree}>
      <div
        class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
        onClick={handleBackdropClick}
      >
        <div class="bg-white dark:bg-zinc-900 rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden">
          <div class="px-6 py-4 border-b border-gray-200 dark:border-zinc-700">
            <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t().worktree.mergeTitle}
            </h2>
          </div>

          <div class="px-6 py-4 space-y-4">
            <p class="text-sm text-gray-600 dark:text-gray-400">
              {t().worktree.mergeDesc}
            </p>

            <Show when={props.worktree?.hasUncommitted}>
              <div class="flex items-center gap-2 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="text-yellow-600 dark:text-yellow-400"
                >
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                </svg>
                <span class="text-sm text-yellow-800 dark:text-yellow-200">
                  {t().worktree.uncommittedWarning}
                </span>
              </div>
            </Show>

            <div class="text-sm text-gray-500 dark:text-gray-400 space-y-1">
              <div>
                <span class="font-medium">{t().worktree.branchName}:</span>{" "}
                <code class="px-1 py-0.5 bg-gray-100 dark:bg-zinc-800 rounded">
                  {props.worktree?.branch}
                </code>
              </div>
              <Show when={(props.worktree?.ahead ?? 0) > 0 || (props.worktree?.behind ?? 0) > 0}>
                <div>
                  {formatMessage(t().worktree.aheadBehind, {
                    ahead: props.worktree?.ahead ?? 0,
                    behind: props.worktree?.behind ?? 0,
                  })}
                </div>
              </Show>
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t().worktree.commitMessage}
              </label>
              <textarea
                value={commitMessage()}
                onInput={(e) => setCommitMessage(e.currentTarget.value)}
                placeholder={t().worktree.commitMessagePlaceholder}
                rows={3}
                class="w-full px-3 py-2 border border-gray-300 dark:border-zinc-600 rounded-md bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              />
            </div>
          </div>

          <div class="px-6 py-4 border-t border-gray-200 dark:border-zinc-700 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => props.onClose()}
              disabled={isMerging()}
              class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-600 rounded-md hover:bg-gray-50 dark:hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {t().common.cancel}
            </button>
            <button
              type="button"
              onClick={handleMerge}
              disabled={isMerging() || !commitMessage().trim()}
              class="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isMerging() ? t().worktree.merging : t().worktree.merge}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

interface PushDialogProps {
  isOpen: boolean;
  worktree: WorktreeInfo | null;
  onClose: () => void;
  onPush: (newBranchName?: string) => Promise<void>;
}

export function PushDialog(props: PushDialogProps) {
  const { t } = useI18n();
  const [newBranchName, setNewBranchName] = createSignal("");
  const [isPushing, setIsPushing] = createSignal(false);

  const suggestedBranchName = () => {
    const branch = props.worktree?.branch || "";
    return branch.replace(/^opencode-remote\//, "feature/");
  };

  const handlePush = async () => {
    setIsPushing(true);
    try {
      const branchName = newBranchName().trim() || undefined;
      await props.onPush(branchName);
      setNewBranchName("");
      props.onClose();
    } finally {
      setIsPushing(false);
    }
  };

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && !isPushing()) {
      props.onClose();
    }
  };

  return (
    <Show when={props.isOpen && props.worktree}>
      <div
        class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
        onClick={handleBackdropClick}
      >
        <div class="bg-white dark:bg-zinc-900 rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden">
          <div class="px-6 py-4 border-b border-gray-200 dark:border-zinc-700">
            <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t().worktree.pushTitle}
            </h2>
          </div>

          <div class="px-6 py-4 space-y-4">
            <p class="text-sm text-gray-600 dark:text-gray-400">
              {t().worktree.pushDesc}
            </p>

            <div class="text-sm text-gray-500 dark:text-gray-400">
              <span class="font-medium">Current branch:</span>{" "}
              <code class="px-1 py-0.5 bg-gray-100 dark:bg-zinc-800 rounded">
                {props.worktree?.branch}
              </code>
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t().worktree.newBranchName}
              </label>
              <input
                type="text"
                value={newBranchName()}
                onInput={(e) => setNewBranchName(e.currentTarget.value)}
                placeholder={suggestedBranchName() || t().worktree.newBranchNamePlaceholder}
                class="w-full px-3 py-2 border border-gray-300 dark:border-zinc-600 rounded-md bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Leave empty to keep current branch name
              </p>
            </div>
          </div>

          <div class="px-6 py-4 border-t border-gray-200 dark:border-zinc-700 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => props.onClose()}
              disabled={isPushing()}
              class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-600 rounded-md hover:bg-gray-50 dark:hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {t().common.cancel}
            </button>
            <button
              type="button"
              onClick={handlePush}
              disabled={isPushing()}
              class="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPushing() ? t().worktree.pushing : t().worktree.push}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

interface AbandonDialogProps {
  isOpen: boolean;
  worktree: WorktreeInfo | null;
  onClose: () => void;
  onAbandon: () => Promise<void>;
}

export function AbandonDialog(props: AbandonDialogProps) {
  const { t } = useI18n();
  const [isAbandoning, setIsAbandoning] = createSignal(false);

  const handleAbandon = async () => {
    setIsAbandoning(true);
    try {
      await props.onAbandon();
      props.onClose();
    } finally {
      setIsAbandoning(false);
    }
  };

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && !isAbandoning()) {
      props.onClose();
    }
  };

  return (
    <Show when={props.isOpen && props.worktree}>
      <div
        class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
        onClick={handleBackdropClick}
      >
        <div class="bg-white dark:bg-zinc-900 rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden">
          <div class="px-6 py-4 border-b border-gray-200 dark:border-zinc-700">
            <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t().worktree.abandonTitle}
            </h2>
          </div>

          <div class="px-6 py-4 space-y-4">
            <p class="text-sm text-gray-600 dark:text-gray-400">
              {t().worktree.abandonDesc}
            </p>

            <div class="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0"
              >
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
              <span class="text-sm text-red-800 dark:text-red-200">
                {t().worktree.abandonWarning}
              </span>
            </div>

            <div class="text-sm text-gray-500 dark:text-gray-400 space-y-1">
              <div>
                <span class="font-medium">{t().worktree.branchName}:</span>{" "}
                <code class="px-1 py-0.5 bg-gray-100 dark:bg-zinc-800 rounded">
                  {props.worktree?.branch}
                </code>
              </div>
              <Show when={props.worktree?.hasUncommitted}>
                <div class="text-yellow-600 dark:text-yellow-400">
                  {t().worktree.uncommittedWarning}
                </div>
              </Show>
            </div>
          </div>

          <div class="px-6 py-4 border-t border-gray-200 dark:border-zinc-700 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => props.onClose()}
              disabled={isAbandoning()}
              class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-600 rounded-md hover:bg-gray-50 dark:hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {t().common.cancel}
            </button>
            <button
              type="button"
              onClick={handleAbandon}
              disabled={isAbandoning()}
              class="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isAbandoning() ? t().worktree.abandoning : t().worktree.abandon}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
