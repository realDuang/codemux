import { createSignal, Show } from "solid-js";
import { useI18n } from "../lib/i18n";

interface NewSessionDialogProps {
  isOpen: boolean;
  projectPath: string;
  onClose: () => void;
  onCreate: (options: {
    title: string;
    isolated: boolean;
    branchName?: string;
  }) => void;
}

export function NewSessionDialog(props: NewSessionDialogProps) {
  const { t } = useI18n();
  const [title, setTitle] = createSignal("");
  const [mode, setMode] = createSignal<"normal" | "isolated">("normal");
  const [branchSlug, setBranchSlug] = createSignal("");
  const [isCreating, setIsCreating] = createSignal(false);

  const slugify = (text: string): string => {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 50);
  };

  const handleTitleChange = (value: string) => {
    setTitle(value);
    if (mode() === "isolated" && !branchSlug()) {
      setBranchSlug(slugify(value));
    }
  };

  const handleCreate = async () => {
    if (!title().trim()) return;

    setIsCreating(true);
    try {
      await props.onCreate({
        title: title().trim(),
        isolated: mode() === "isolated",
        branchName: mode() === "isolated" ? branchSlug() : undefined,
      });
      resetForm();
    } finally {
      setIsCreating(false);
    }
  };

  const resetForm = () => {
    setTitle("");
    setMode("normal");
    setBranchSlug("");
  };

  const handleClose = () => {
    resetForm();
    props.onClose();
  };

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  return (
    <Show when={props.isOpen}>
      <div
        class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
        onClick={handleBackdropClick}
      >
        <div class="bg-white dark:bg-zinc-900 rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden">
          <div class="px-6 py-4 border-b border-gray-200 dark:border-zinc-700">
            <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t().worktree.newSessionTitle}
            </h2>
          </div>

          <div class="px-6 py-4 space-y-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t().worktree.sessionTitle}
              </label>
              <input
                type="text"
                value={title()}
                onInput={(e) => handleTitleChange(e.currentTarget.value)}
                placeholder={t().worktree.sessionTitlePlaceholder}
                class="w-full px-3 py-2 border border-gray-300 dark:border-zinc-600 rounded-md bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                autofocus
              />
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t().worktree.workingMode}
              </label>
              <div class="space-y-2">
                <label
                  class={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    mode() === "normal"
                      ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                      : "border-gray-200 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800"
                  }`}
                >
                  <input
                    type="radio"
                    name="mode"
                    value="normal"
                    checked={mode() === "normal"}
                    onChange={() => setMode("normal")}
                    class="mt-1"
                  />
                  <div class="flex-1">
                    <div class="font-medium text-gray-900 dark:text-gray-100">
                      {t().worktree.normalMode}
                    </div>
                    <div class="text-sm text-gray-500 dark:text-gray-400">
                      {t().worktree.normalModeDesc}
                    </div>
                  </div>
                </label>

                <label
                  class={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    mode() === "isolated"
                      ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                      : "border-gray-200 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800"
                  }`}
                >
                  <input
                    type="radio"
                    name="mode"
                    value="isolated"
                    checked={mode() === "isolated"}
                    onChange={() => setMode("isolated")}
                    class="mt-1"
                  />
                  <div class="flex-1">
                    <div class="font-medium text-gray-900 dark:text-gray-100">
                      {t().worktree.isolatedMode}
                    </div>
                    <div class="text-sm text-gray-500 dark:text-gray-400">
                      {t().worktree.isolatedModeDesc}
                    </div>
                  </div>
                </label>
              </div>
            </div>

            <Show when={mode() === "isolated"}>
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {t().worktree.branchName}
                </label>
                <div class="flex items-center">
                  <span class="px-3 py-2 bg-gray-100 dark:bg-zinc-700 border border-r-0 border-gray-300 dark:border-zinc-600 rounded-l-md text-gray-500 dark:text-gray-400 text-sm">
                    {t().worktree.branchPrefix}
                  </span>
                  <input
                    type="text"
                    value={branchSlug()}
                    onInput={(e) => setBranchSlug(slugify(e.currentTarget.value))}
                    placeholder="my-feature"
                    class="flex-1 px-3 py-2 border border-gray-300 dark:border-zinc-600 rounded-r-md bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              </div>
            </Show>
          </div>

          <div class="px-6 py-4 border-t border-gray-200 dark:border-zinc-700 flex justify-end gap-3">
            <button
              type="button"
              onClick={handleClose}
              disabled={isCreating()}
              class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-600 rounded-md hover:bg-gray-50 dark:hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {t().common.cancel}
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={isCreating() || !title().trim() || (mode() === "isolated" && !branchSlug().trim())}
              class="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isCreating() ? t().worktree.creating : t().worktree.create}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
