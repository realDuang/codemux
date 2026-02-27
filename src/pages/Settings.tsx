import { For, Show, Switch, Match, createSignal, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { useI18n } from "../lib/i18n";
import { useAuthGuard } from "../lib/useAuthGuard";
import { isElectron } from "../lib/platform";
import { Auth } from "../lib/auth";
import { configStore } from "../stores/config";

export default function Settings() {
  const { t } = useI18n();
  const navigate = useNavigate();

  useAuthGuard("Settings");

  const [logPath, setLogPath] = createSignal("");
  const [logLevel, setLogLevel] = createSignal("warn");
  const [showLogSection, setShowLogSection] = createSignal(isElectron());

  const logLevels = ["error", "warn", "info", "verbose", "debug", "silly"];

  onMount(async () => {
    if (isElectron()) {
      const api = (window as any).electronAPI;
      if (api?.log) {
        const [path, level] = await Promise.all([
          api.log.getPath(),
          api.log.getLevel(),
        ]);
        setLogPath(path);
        setLogLevel(level);
      }
    } else {
      // Web mode: check if localhost, then fetch log info via REST
      const localAccess = await Auth.isLocalAccess();
      if (localAccess) {
        setShowLogSection(true);
        try {
          const [pathRes, levelRes] = await Promise.all([
            fetch("/api/system/log/path"),
            fetch("/api/system/log/level"),
          ]);
          if (pathRes.ok) {
            const { path } = await pathRes.json();
            setLogPath(path || "");
          }
          if (levelRes.ok) {
            const { level } = await levelRes.json();
            setLogLevel(level || "warn");
          }
        } catch {
          // Log API not available
        }
      }
    }
  });

  const handleLogLevelChange = async (level: string) => {
    if (isElectron()) {
      const api = (window as any).electronAPI;
      if (api?.log) {
        await api.log.setLevel(level);
        setLogLevel(level);
      }
    } else {
      try {
        const res = await fetch("/api/system/log/level", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ level }),
        });
        if (res.ok) {
          setLogLevel(level);
        }
      } catch {
        // Failed to set log level
      }
    }
  };

  const handleOpenLogFolder = async () => {
    const api = (window as any).electronAPI;
    const path = logPath();
    if (api?.system?.openPath && path) {
      // Open the directory containing the log file
      const dir = path.replace(/[\\/][^\\/]+$/, "");
      try {
        await api.system.openPath(dir);
      } catch {
        // fallback: try shell.openExternal for the directory
      }
    }
  };

  return (
    <div class="flex h-screen bg-gray-50 dark:bg-slate-900 font-sans text-gray-900 dark:text-gray-100 electron-safe-top">
      <div class="flex-1 flex flex-col overflow-hidden max-w-4xl mx-auto w-full">
        {/* Header */}
        <header class="flex items-center gap-4 px-6 py-6 electron-drag-region">
          <button
            onClick={() => navigate("/chat")}
            class="p-2 -ml-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors electron-no-drag"
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
              <div class="bg-white dark:bg-slate-800 rounded-xl shadow-xs border border-gray-200 dark:border-slate-700 overflow-visible">
                {/* Language Setting */}
                <div class="p-4 sm:p-6 flex items-center justify-between gap-4 border-b border-gray-200 dark:border-slate-700">
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

            {/* Engines Section */}
            <section>
              <h2 class="text-sm font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-4 px-1">
                {t().engine.engines}
              </h2>
              <Show
                when={configStore.engines.length > 0}
                fallback={
                  <div class="bg-white dark:bg-slate-800 rounded-xl shadow-xs border border-slate-200 dark:border-slate-700 p-6 text-center text-sm text-slate-400 dark:text-slate-500">
                    {t().engine.noEngines}
                  </div>
                }
              >
                <div class="bg-white dark:bg-slate-800 rounded-xl shadow-xs border border-slate-200 dark:border-slate-700">
                  <For each={configStore.engines}>
                    {(engine, index) => (
                      <div
                        class={`p-4 sm:p-6 flex items-center justify-between gap-4 ${index() < configStore.engines.length - 1 ? "border-b border-slate-100 dark:border-slate-700" : ""}`}
                      >
                        <div class="flex items-center gap-3 min-w-0">
                          {/* Status indicator dot */}
                          <span
                            class={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                              engine.status === "running"
                                ? "bg-emerald-500"
                                : engine.status === "starting"
                                  ? "bg-amber-500"
                                  : engine.status === "error"
                                    ? "bg-red-500"
                                    : "bg-slate-400"
                            }`}
                          />
                          <div class="min-w-0">
                            <div class="flex items-center gap-2">
                              <span class="text-base font-medium text-gray-900 dark:text-white truncate">
                                {engine.name}
                              </span>
                              {/* Engine type badge */}
                              <Switch>
                                <Match when={engine.type === "opencode"}>
                                  <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                                    OpenCode
                                  </span>
                                </Match>
                                <Match when={engine.type === "copilot"}>
                                  <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
                                    Copilot
                                  </span>
                                </Match>
                                <Match when={engine.type === "claude"}>
                                  <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300">
                                    Claude
                                  </span>
                                </Match>
                              </Switch>
                            </div>
                            <div class="flex items-center gap-2 mt-0.5">
                              {/* Status text */}
                              <span class="text-sm text-gray-500 dark:text-gray-400">
                                <Switch>
                                  <Match when={engine.status === "running"}>
                                    {t().engine.running}
                                  </Match>
                                  <Match when={engine.status === "starting"}>
                                    {t().engine.starting}
                                  </Match>
                                  <Match when={engine.status === "error"}>
                                    {t().engine.error}
                                  </Match>
                                  <Match when={engine.status === "stopped"}>
                                    {t().engine.stopped}
                                  </Match>
                                </Switch>
                              </span>
                              {/* Version */}
                              <Show when={engine.version}>
                                <span class="text-xs text-gray-400 dark:text-gray-500">
                                  v{engine.version}
                                </span>
                              </Show>
                            </div>
                          </div>
                        </div>
                        {/* Auth login button */}
                        <Show
                          when={
                            engine.authMethods &&
                            engine.authMethods.length > 0 &&
                            engine.status !== "running"
                          }
                        >
                          <button class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors flex-shrink-0">
                            {t().engine.login}
                          </button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </section>

            {/* Logging Section */}
            <Show when={showLogSection()}>
              <section>
                <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 px-1">
                  {t().settings.logging}
                </h2>
                <div class="bg-white dark:bg-slate-800 rounded-xl shadow-xs border border-gray-200 dark:border-slate-700 overflow-visible">
                  {/* Log file path */}
                  <div class="p-4 sm:p-6 flex items-center justify-between gap-4 border-b border-gray-200 dark:border-slate-700">
                    <div class="min-w-0">
                      <h3 class="text-base font-medium text-gray-900 dark:text-white">
                        {t().settings.logFilePath}
                      </h3>
                      <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        {t().settings.logFilePathDesc}
                      </p>
                      <Show when={logPath()}>
                        <p class="text-xs text-gray-400 dark:text-gray-500 mt-2 font-mono truncate" title={logPath()}>
                          {logPath()}
                        </p>
                      </Show>
                    </div>
                    <div class="flex-shrink-0">
                      <Show when={isElectron()}>
                        <button
                          onClick={handleOpenLogFolder}
                          disabled={!logPath()}
                          class="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {t().settings.openLogFolder}
                        </button>
                      </Show>
                    </div>
                  </div>
                  {/* Log level */}
                  <div class="p-4 sm:p-6 flex items-center justify-between gap-4">
                    <div>
                      <h3 class="text-base font-medium text-gray-900 dark:text-white">
                        {t().settings.logLevel}
                      </h3>
                      <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        {t().settings.logLevelDesc}
                      </p>
                    </div>
                    <div class="flex-shrink-0">
                      <select
                        value={logLevel()}
                        onChange={(e) => handleLogLevelChange(e.currentTarget.value)}
                        class="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-600 transition-colors cursor-pointer"
                      >
                        <For each={logLevels}>
                          {(level) => (
                            <option value={level}>{level}</option>
                          )}
                        </For>
                      </select>
                    </div>
                  </div>
                </div>
              </section>
            </Show>

          </div>
        </main>
      </div>
    </div>
  );
}
