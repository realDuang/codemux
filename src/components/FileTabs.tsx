import { For, Show } from "solid-js";
import { fileStore, closeTab, switchTab } from "../stores/file";
import { useI18n } from "../lib/i18n";

export function FileTabs() {
  const { t } = useI18n();

  function handleClose(e: MouseEvent, path: string) {
    e.stopPropagation();
    closeTab(path);
  }

  function handleMiddleClick(e: MouseEvent, path: string) {
    if (e.button === 1) {
      e.preventDefault();
      closeTab(path);
    }
  }

  return (
    <Show when={fileStore.openTabs.all.length > 0}>
      <div class="flex items-center border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 overflow-x-auto shrink-0 scrollbar-none">
        <For each={fileStore.openTabs.all}>
          {(tab) => {
            const isActive = () => fileStore.openTabs.active === tab.path;

            return (
              <button
                class={`group flex items-center gap-1.5 px-3 h-[28px] text-[13px] border-r border-gray-200 dark:border-slate-700 shrink-0 transition-colors ${
                  isActive()
                    ? "bg-white dark:bg-slate-900 text-gray-900 dark:text-slate-100"
                    : "text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800/50"
                }`}
                onClick={() => switchTab(tab.path)}
                onMouseDown={(e) => handleMiddleClick(e, tab.path)}
              >
                <span class="truncate max-w-[120px]">{tab.name}</span>
                <span
                  class={`flex items-center justify-center w-4 h-4 rounded hover:bg-gray-200 dark:hover:bg-slate-700 ${
                    isActive()
                      ? "opacity-60 hover:opacity-100"
                      : "opacity-0 group-hover:opacity-60 hover:!opacity-100"
                  }`}
                  onClick={(e) => handleClose(e, tab.path)}
                  title={t().fileExplorer.closeTab}
                >
                  <svg
                    class="w-3 h-3"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                  >
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </span>
              </button>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
