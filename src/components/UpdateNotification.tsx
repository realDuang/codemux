import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { useI18n } from "../lib/i18n";
import { isElectron } from "../lib/platform";
import { updateAPI, type UpdateStateInfo } from "../lib/electron-api";

export function UpdateNotification() {
  const { t } = useI18n();
  const [state, setState] = createSignal<UpdateStateInfo | null>(null);
  const [dismissed, setDismissed] = createSignal(false);

  onMount(() => {
    if (!isElectron()) return;

    const cleanups: (() => void)[] = [];

    const addCleanup = (fn: (() => void) | null) => {
      if (fn) cleanups.push(fn);
    };

    addCleanup(updateAPI.onUpdateAvailable((s) => {
      setState(s);
      setDismissed(false);
    }));

    addCleanup(updateAPI.onDownloadProgress((s) => {
      setState(s);
    }));

    addCleanup(updateAPI.onUpdateDownloaded((s) => {
      setState(s);
      setDismissed(false);
    }));

    addCleanup(updateAPI.onUpdateError((s) => {
      setState(s);
    }));

    onCleanup(() => {
      for (const cleanup of cleanups) cleanup();
    });
  });

  const handleRestart = () => {
    updateAPI.quitAndInstall();
  };

  const handleDismiss = () => {
    setDismissed(true);
  };

  const handleRetry = () => {
    updateAPI.checkForUpdates();
  };

  const shouldShow = () => {
    const s = state();
    if (!s || dismissed()) return false;
    return s.status === "available" || s.status === "downloading" || s.status === "downloaded" || s.status === "error";
  };

  const progressPercent = () => {
    const s = state();
    return s?.progress?.percent ?? 0;
  };

  return (
    <Show when={shouldShow()}>
      <div class="fixed bottom-6 right-6 z-50 w-80 max-w-[calc(100vw-3rem)] font-sans animate-in fade-in slide-in-from-bottom-4 duration-300">
        <div class="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-gray-100 dark:border-slate-800 overflow-hidden">
          {/* Downloading state */}
          <Show when={state()?.status === "available" || state()?.status === "downloading"}>
            <div class="p-4">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2.5">
                  <div class="w-8 h-8 rounded-full bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center text-blue-600 dark:text-blue-400">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>
                    </svg>
                  </div>
                  <div>
                    <p class="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {t().update.downloading}
                    </p>
                    <Show when={state()?.version}>
                      <p class="text-xs text-gray-500 dark:text-gray-400">v{state()!.version}</p>
                    </Show>
                  </div>
                </div>
                <button
                  onClick={handleDismiss}
                  class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                  </svg>
                </button>
              </div>
              {/* Progress bar */}
              <div class="w-full h-1.5 bg-gray-100 dark:bg-slate-800 rounded-full overflow-hidden">
                <div
                  class="h-full bg-blue-500 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round(progressPercent())}%` }}
                />
              </div>
              <p class="text-xs text-gray-400 dark:text-gray-500 mt-1.5 text-right">
                {Math.round(progressPercent())}%
              </p>
            </div>
          </Show>

          {/* Downloaded state */}
          <Show when={state()?.status === "downloaded"}>
            <div class="p-4">
              <div class="flex items-center gap-2.5 mb-3">
                <div class="w-8 h-8 rounded-full bg-green-50 dark:bg-green-900/20 flex items-center justify-center text-green-600 dark:text-green-400">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
                <div>
                  <p class="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t().update.downloaded}
                  </p>
                  <Show when={state()?.version}>
                    <p class="text-xs text-gray-500 dark:text-gray-400">v{state()!.version}</p>
                  </Show>
                </div>
              </div>
              <div class="flex gap-2">
                <button
                  onClick={handleDismiss}
                  class="flex-1 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
                >
                  {t().update.restartLater}
                </button>
                <button
                  onClick={handleRestart}
                  class="flex-1 px-3 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 rounded-lg transition-colors"
                >
                  {t().update.restartNow}
                </button>
              </div>
            </div>
          </Show>

          {/* Error state */}
          <Show when={state()?.status === "error"}>
            <div class="p-4">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2.5">
                  <div class="w-8 h-8 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center text-red-500 dark:text-red-400">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>
                    </svg>
                  </div>
                  <p class="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t().update.error}
                  </p>
                </div>
                <button
                  onClick={handleRetry}
                  class="px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors"
                >
                  {t().update.retry}
                </button>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
