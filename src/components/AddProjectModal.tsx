import { createSignal, Show } from "solid-js";
import { useI18n } from "../lib/i18n";

interface AddProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (directory: string) => Promise<void>;
}

export function AddProjectModal(props: AddProjectModalProps) {
  const { t } = useI18n();
  const [directory, setDirectory] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const handleAdd = async () => {
    const dir = directory().trim();
    if (!dir) return;

    setLoading(true);
    setError(null);

    try {
      await props.onAdd(dir);
      setDirectory("");
      props.onClose();
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "";
      if (errorMessage === "NOT_GIT_REPO") {
        setError(t().project.notGitRepo);
      } else {
        setError(errorMessage || t().project.addFailed);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !loading()) {
      handleAdd();
    } else if (e.key === "Escape") {
      props.onClose();
    }
  };

  const handleClose = () => {
    setDirectory("");
    setError(null);
    props.onClose();
  };

  return (
    <Show when={props.isOpen}>
      <div class="fixed inset-0 z-50 flex items-center justify-center">
        <div
          class="absolute inset-0 bg-black/50 backdrop-blur-xs"
          onClick={handleClose}
          aria-hidden="true"
        />

        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-project-modal-title"
          class="relative bg-white dark:bg-zinc-900 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        >
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-zinc-800">
            <h2 id="add-project-modal-title" class="text-lg font-semibold text-gray-900 dark:text-white">
              {t().project.addTitle}
            </h2>
            <button
              onClick={handleClose}
              class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg transition-colors"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>

          <div class="p-6 space-y-4">
            <div class="flex items-start gap-3">
              <div class="flex-shrink-0 w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="text-blue-600 dark:text-blue-400"
                >
                  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                  <path d="M12 10v6" />
                  <path d="M9 13h6" />
                </svg>
              </div>
              <div class="flex-1">
                <label class="block text-sm font-medium text-gray-900 dark:text-white mb-2">
                  {t().project.inputPath}
                </label>
                <div class="flex gap-2">
                  <input
                    type="text"
                    value={directory()}
                    onInput={(e) => setDirectory(e.currentTarget.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="/path/to/your/project"
                    autofocus
                    class="flex-1 px-3 py-2 bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  {t().project.pathHint}
                </p>
              </div>
            </div>

            <Show when={error()}>
              <div class="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p class="text-sm text-red-700 dark:text-red-400">{error()}</p>
              </div>
            </Show>
          </div>

          <div class="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900/50">
            <button
              onClick={handleClose}
              class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
            >
              {t().common.cancel}
            </button>
            <button
              onClick={handleAdd}
              disabled={loading() || !directory().trim()}
              class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
            >
              {loading() ? t().project.adding : t().project.add}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
