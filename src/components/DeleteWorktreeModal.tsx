import { createSignal, Show } from "solid-js";
import { useI18n, formatMessage } from "../lib/i18n";
import { logger } from "../lib/logger";

interface DeleteWorktreeModalProps {
  isOpen: boolean;
  worktreeName: string;
  worktreeBranch: string;
  sessionCount: number;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function DeleteWorktreeModal(props: DeleteWorktreeModalProps) {
  const { t } = useI18n();
  const [loading, setLoading] = createSignal(false);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await props.onConfirm();
      props.onClose();
    } catch (error) {
      logger.error("Failed to delete worktree:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Show when={props.isOpen}>
      <div class="fixed inset-0 z-50 flex items-center justify-center">
        <div
          class="absolute inset-0 bg-black/50 backdrop-blur-xs"
          onClick={props.onClose}
          aria-hidden="true"
        />

        <div
          role="dialog"
          aria-modal="true"
          class="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden flex flex-col max-h-[calc(100vh-2rem)]"
        >
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-slate-800">
            <h2 class="text-lg font-semibold text-gray-900 dark:text-white">
              {t().worktree.remove}
            </h2>
            <button
              onClick={props.onClose}
              class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
              </svg>
            </button>
          </div>

          <div class="p-6 space-y-4 overflow-y-auto flex-1">
            <div class="flex items-start gap-3">
              <div class="flex-shrink-0 w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-red-600 dark:text-red-400">
                  <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              </div>
              <div>
                <p class="text-gray-900 dark:text-white font-medium">
                  {formatMessage(t().worktree.deleteConfirmTitle, { name: props.worktreeName })}
                </p>
                <p class="mt-1 text-sm text-gray-500 dark:text-gray-400 font-mono">
                  {props.worktreeBranch}
                </p>
              </div>
            </div>

            <div class="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg space-y-2">
              <p class="text-sm font-medium text-red-700 dark:text-red-400">
                {t().worktree.deleteWarningTitle}
              </p>
              <ul class="text-sm text-red-600 dark:text-red-400 space-y-1 list-disc list-inside">
                <li>{t().worktree.deleteImpactFiles}</li>
                <li>{t().worktree.deleteImpactBranch}</li>
                <li>{formatMessage(t().worktree.deleteImpactSessions, { count: props.sessionCount })}</li>
              </ul>
              <p class="text-xs text-red-500 dark:text-red-500 mt-1">
                {t().worktree.deleteIrreversible}
              </p>
            </div>
          </div>

          <div class="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 px-6 py-4 border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/50 flex-shrink-0">
            <button
              onClick={props.onClose}
              class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
            >
              {t().common.cancel}
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading()}
              class="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
            >
              {loading() ? t().common.loading : t().worktree.remove}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
