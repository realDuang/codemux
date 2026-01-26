import { createSignal, Show } from "solid-js";
import { useI18n, formatMessage } from "../lib/i18n";

interface HideProjectModalProps {
  isOpen: boolean;
  projectName: string;
  sessionCount: number;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function HideProjectModal(props: HideProjectModalProps) {
  const { t } = useI18n();
  const [loading, setLoading] = createSignal(false);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await props.onConfirm();
      props.onClose();
    } catch (error) {
      console.error("Failed to hide project:", error);
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
          aria-labelledby="hide-project-modal-title"
          class="relative bg-white dark:bg-zinc-900 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        >
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-zinc-800">
            <h2 id="hide-project-modal-title" class="text-lg font-semibold text-gray-900 dark:text-white">
              {t().project.hideTitle}
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

          <div class="p-6 space-y-4">
            <div class="flex items-start gap-3">
              <div class="flex-shrink-0 w-10 h-10 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-600 dark:text-amber-400">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" x2="23" y1="1" y2="23"/>
                </svg>
              </div>
              <div>
                <p class="text-gray-900 dark:text-white font-medium">
                  {formatMessage(t().project.hideConfirm, { name: props.projectName })}
                </p>
                <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {formatMessage(t().project.sessionCount, { count: props.sessionCount })}
                </p>
              </div>
            </div>

            <div class="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg space-y-1">
              <p class="text-sm text-amber-700 dark:text-amber-400">
                {t().project.hideWarning}
              </p>
              <p class="text-sm text-amber-600 dark:text-amber-500">
                {t().project.hideNote}
              </p>
            </div>
          </div>

          <div class="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900/50">
            <button
              onClick={props.onClose}
              class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
            >
              {t().common.cancel}
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading()}
              class="px-4 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
            >
              {loading() ? t().common.loading : t().common.confirm}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
