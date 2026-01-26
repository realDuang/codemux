import { createSignal, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { client } from "../lib/opencode-client";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { useI18n } from "../lib/i18n";
import { logger } from "../lib/logger";
import { useAuthGuard } from "../lib/useAuthGuard";

export default function Settings() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [serverUrl, setServerUrl] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [checking, setChecking] = createSignal(false);
  const [saveStatus, setSaveStatus] = createSignal<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  useAuthGuard("Settings");

  onMount(() => {
    // Load current server URL
    setServerUrl(client.getServerUrl());
  });

  const checkConnection = async (url: string) => {
    setChecking(true);
    try {
      const testUrl = `${url}/session`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(testUrl, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.ok || response.status === 401 || response.status === 403) {
          return true;
        } else {
          throw new Error(`${t().settings.serverError} ${response.status}`);
        }
      } catch (e: any) {
        clearTimeout(timeoutId);
        throw e;
      }
    } catch (error: any) {
      logger.error("[Settings] Connection check failed:", error);
      throw new Error(`${t().settings.connectionFailed} ${error.message}`);
    } finally {
      setChecking(false);
    }
  };

  // Helper to normalize and validate URL
  const getNormalizedUrl = (): string | null => {
    const url = serverUrl().trim();
    if (!url) return null;
    return url.endsWith("/") ? url.slice(0, -1) : url;
  };

  const handleTestConnection = async () => {
    setSaveStatus(null);
    const url = getNormalizedUrl();
    if (!url) {
      setSaveStatus({ type: "error", message: t().settings.serverUrlEmpty });
      return;
    }

    try {
      await checkConnection(url);
      setSaveStatus({
        type: "success",
        message: t().settings.connectionSuccess,
      });
    } catch (error: any) {
      setSaveStatus({ type: "error", message: error.message });
    }
  };

  const handleSave = async () => {
    logger.debug("[Settings] Saving configuration");
    setSaving(true);
    setSaveStatus(null);

    try {
      const url = getNormalizedUrl();
      if (!url) {
        throw new Error(t().settings.serverUrlEmpty);
      }

      await checkConnection(url);
      client.setServerUrl(url);
      setSaveStatus({ type: "success", message: t().settings.urlUpdated });

      setTimeout(() => {
        navigate("/chat");
      }, 1000);
    } catch (error: any) {
      logger.error("[Settings] Failed to save config:", error);
      setSaveStatus({
        type: "error",
        message: error.message || t().settings.saveFailed,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    navigate("/chat");
  };

  return (
    <div class="flex h-screen bg-gray-50 dark:bg-zinc-900 font-sans text-gray-900 dark:text-gray-100">
      <div class="flex-1 flex flex-col overflow-hidden max-w-4xl mx-auto w-full">
        {/* Header */}
        <header class="flex items-center gap-4 px-6 py-6">
          <button
            onClick={handleCancel}
            class="p-2 -ml-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
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
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <h1 class="text-2xl font-bold text-gray-900 dark:text-white">
            {t().settings.title}
          </h1>
        </header>

        {/* Main Content */}
        <main class="flex-1 overflow-y-auto px-6 pb-8">
          <div class="space-y-8">
            {/* General Settings Section */}
            <section>
              <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 px-1">
                {t().settings.general}
              </h2>
              <div class="bg-white dark:bg-zinc-800 rounded-xl shadow-xs border border-gray-200 dark:border-zinc-700 overflow-visible">
                {/* Language Setting */}
                <div class="p-4 sm:p-6 flex items-center justify-between gap-4 border-b border-gray-200 dark:border-zinc-700">
                  <div>
                    <h3 class="text-base font-medium text-gray-900 dark:text-white">
                      {t().settings.language}
                    </h3>
                    <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      {t().settings.languageDesc}
                    </p>
                  </div>
                  <div class="flex-shrink-0">
                    <LanguageSwitcher />
                  </div>
                </div>
                {/* Theme Setting */}
                <div class="p-4 sm:p-6 flex items-center justify-between gap-4">
                  <div>
                    <h3 class="text-base font-medium text-gray-900 dark:text-white">
                      {t().settings.theme}
                    </h3>
                    <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      {t().settings.themeDesc}
                    </p>
                  </div>
                  <div class="flex-shrink-0">
                    <ThemeSwitcher />
                  </div>
                </div>
              </div>
            </section>

            {/* Connection Settings Section */}
            <section>
              <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 px-1">
                {t().settings.connection}
              </h2>
              <div class="bg-white dark:bg-zinc-800 rounded-xl shadow-xs border border-gray-200 dark:border-zinc-700 overflow-hidden">
                <div class="p-4 sm:p-6 space-y-6">
                  {/* Server URL Input */}
                  <div>
                    <label class="block text-base font-medium text-gray-900 dark:text-white mb-2">
                      {t().settings.serverUrl}
                    </label>
                    <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
                      {t().settings.serverUrlDesc}
                    </p>
                    <div class="flex gap-2">
                      <input
                        type="text"
                        value={serverUrl()}
                        onInput={(e) => setServerUrl(e.currentTarget.value)}
                        placeholder="http://localhost:4096"
                        class="flex-1 px-4 py-2.5 bg-gray-50 dark:bg-zinc-900 border border-gray-300 dark:border-zinc-600 rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all font-mono text-sm"
                      />
                      <button
                        onClick={handleTestConnection}
                        disabled={checking() || saving() || !serverUrl()}
                        class="px-4 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-gray-700 dark:text-gray-200 font-medium border border-gray-300 dark:border-zinc-600 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap text-sm"
                      >
                        {checking()
                          ? t().settings.testing
                          : t().settings.testConnection}
                      </button>
                    </div>
                  </div>

                  {/* Connection Info Alert */}
                  <div class="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800/50 rounded-lg">
                    <div class="flex gap-3">
                      <div class="flex-shrink-0 text-blue-600 dark:text-blue-400 mt-0.5">
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <circle cx="12" cy="12" r="10" />
                          <line x1="12" x2="12" y1="16" y2="12" />
                          <line x1="12" x2="12.01" y1="8" y2="8" />
                        </svg>
                      </div>
                      <div class="text-sm text-blue-800 dark:text-blue-200 space-y-1">
                        <p class="font-medium">{t().settings.infoTitle}</p>
                        <ul class="list-disc list-inside space-y-0.5 opacity-90 ml-1">
                          <li>{t().settings.infoDefault}</li>
                          <li>{t().settings.infoRemote}</li>
                          <li>{t().settings.infoChange}</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </main>

        {/* Footer Actions */}
        <footer class="p-6 bg-white dark:bg-zinc-900 border-t border-gray-200 dark:border-zinc-800">
          <div class="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
            {/* Status Message */}
            <div class="w-full sm:w-auto min-h-[24px]">
              <Show when={saveStatus()}>
                <div
                  class={`flex items-center gap-2 text-sm ${
                    saveStatus()?.type === "success"
                      ? "text-green-600 dark:text-green-400"
                      : "text-red-600 dark:text-red-400"
                  }`}
                >
                  <Show
                    when={saveStatus()?.type === "success"}
                    fallback={
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
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" x2="12" y1="8" y2="12" />
                        <line x1="12" x2="12.01" y1="16" y2="16" />
                      </svg>
                    }
                  >
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
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                  </Show>
                  {saveStatus()?.message}
                </div>
              </Show>
            </div>

            {/* Action Buttons */}
            <div class="flex gap-3 w-full sm:w-auto">
              <button
                onClick={handleCancel}
                disabled={saving() || checking()}
                class="flex-1 sm:flex-none px-5 py-2.5 bg-white hover:bg-gray-50 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-gray-700 dark:text-gray-200 font-medium border border-gray-300 dark:border-zinc-600 rounded-lg transition-colors disabled:opacity-50 text-sm shadow-xs"
              >
                {t().common.cancel}
              </button>
              <button
                onClick={handleSave}
                disabled={saving() || checking() || !serverUrl()}
                class="flex-1 sm:flex-none px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white font-medium rounded-lg transition-colors shadow-xs disabled:cursor-not-allowed text-sm flex items-center justify-center gap-2 min-w-[140px]"
              >
                <Show when={saving()} fallback={t().settings.saveAndConnect}>
                  <div class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {t().settings.saving}
                </Show>
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
