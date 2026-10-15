import { createSignal, Show } from "solid-js";
import { useI18n } from "../lib/i18n";
import { systemAPI } from "../lib/electron-api";
import { isElectron } from "../lib/platform";

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
      setError(errorMessage || t().project.addFailed);
    } finally {
      setLoading(false);
    }
  };

  const handleBrowse = async () => {
    const selected = await systemAPI.selectDirectory();
    if (selected) {
      setDirectory(selected);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.isComposing && !loading()) {
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
          class="absolute inset-0 bg-black/40 backdrop-blur-sm backdrop-blur-xs"
          onClick={handleClose}
          aria-hidden="true"
        />

        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-project-modal-title"
          class="relative bg-[var(--cm-surface)] dark:bg-[var(--cm-surface-2)] rounded-2xl shadow-[var(--cm-shadow-[var(--cm-shadow-lg)])] ring-1 ring-[var(--cm-hairline-strong)] w-full max-w-md mx-4 overflow-hidden flex flex-col max-h-[calc(100vh-2rem)]"
        >
          <div class="flex items-center justify-between px-6 py-4 border-b border-[var(--cm-hairline-strong)]">
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

          <div class="p-6 space-y-4 overflow-y-auto flex-1">
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
                    class="flex-1 px-3 py-2 bg-[var(--cm-surface)] dark:bg-[var(--cm-surface-2)] border border-[var(--cm-hairline-strong)] rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  <Show when={isElectron()}>
                    <button
                      type="button"
                      onClick={handleBrowse}
                      class="px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600 border border-[var(--cm-hairline-strong)] rounded-lg transition-colors whitespace-nowrap"
                    >
                      {t().project.browse}
                    </button>
                  </Show>
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

          <div class="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 px-6 py-4 border-t border-[var(--cm-hairline-strong)] bg-gray-50 dark:bg-slate-900/50 flex-shrink-0">
            <button
              onClick={handleClose}
              class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-900/[0.04] dark:hover:bg-white/[0.05] rounded-lg transition-colors"
            >
              {t().common.cancel}
            </button>
            <button
              onClick={handleAdd}
              disabled={loading() || !directory().trim()}
              class="cm-btn-primary px-4 py-2 text-sm font-medium disabled:cursor-not-allowed rounded-lg"
            >
              {loading() ? t().project.adding : t().project.add}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
