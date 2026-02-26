import { For, Show, createSignal } from "solid-js";
import { Theme, ThemeMode, getThemeMode, setThemeMode } from "../lib/theme";
import { useI18n } from "../lib/i18n";

export function ThemeSwitcher() {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = createSignal(false);
  const themeMode = getThemeMode();

  const themes: ThemeMode[] = ["light", "dark", "system"];

  const getThemeLabel = (mode: ThemeMode): string => {
    switch (mode) {
      case "light":
        return t().settings.themeLight;
      case "dark":
        return t().settings.themeDark;
      case "system":
        return t().settings.themeSystem;
    }
  };

  const getThemeIcon = (mode: ThemeMode) => {
    switch (mode) {
      case "light":
        return (
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
          >
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2" />
            <path d="M12 20v2" />
            <path d="m4.93 4.93 1.41 1.41" />
            <path d="m17.66 17.66 1.41 1.41" />
            <path d="M2 12h2" />
            <path d="M20 12h2" />
            <path d="m6.34 17.66-1.41 1.41" />
            <path d="m19.07 4.93-1.41 1.41" />
          </svg>
        );
      case "dark":
        return (
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
          >
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
          </svg>
        );
      case "system":
        return (
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
          >
            <rect width="20" height="14" x="2" y="3" rx="2" />
            <line x1="8" x2="16" y1="21" y2="21" />
            <line x1="12" x2="12" y1="17" y2="21" />
          </svg>
        );
    }
  };

  return (
    <div class="relative">
      <button
        onClick={() => setIsOpen(!isOpen())}
        class="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
      >
        {getThemeIcon(themeMode())}
        <span>{getThemeLabel(themeMode())}</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <Show when={isOpen()}>
        <div class="absolute right-0 top-full mt-1 py-1 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg shadow-lg z-50 min-w-[120px]">
          <For each={themes}>
            {(mode) => (
              <button
                onClick={() => {
                  setThemeMode(mode);
                  setIsOpen(false);
                }}
                class={`w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors flex items-center justify-between gap-3 ${
                  themeMode() === mode
                    ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20"
                    : "text-gray-700 dark:text-gray-300"
                }`}
              >
                <span class="flex items-center gap-2">
                  {getThemeIcon(mode)}
                  {getThemeLabel(mode)}
                </span>
                <Show when={themeMode() === mode}>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={isOpen()}>
        <div class="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
      </Show>
    </div>
  );
}
