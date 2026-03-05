import { For, Show, Switch, Match, createSignal, createMemo, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { useI18n } from "../lib/i18n";
import { useAuthGuard } from "../lib/useAuthGuard";
import { isElectron } from "../lib/platform";
import { Auth } from "../lib/auth";
import { configStore, saveEngineModelSelection, isEngineEnabled, setEngineEnabled } from "../stores/config";
import { systemAPI, updateAPI } from "../lib/electron-api";
import type { UnifiedModelInfo } from "../types/unified";

export default function Settings() {
  const { t } = useI18n();
  const navigate = useNavigate();

  useAuthGuard("Settings");

  const [logPath, setLogPath] = createSignal("");
  const [logLevel, setLogLevel] = createSignal("warn");
  const [showLogSection, setShowLogSection] = createSignal(isElectron());

  // Update section state
  const [appVersion, setAppVersion] = createSignal("");
  const [updateCheckStatus, setUpdateCheckStatus] = createSignal<"idle" | "checking" | "up-to-date" | "available" | "error">("idle");
  const [autoCheckEnabled, setAutoCheckEnabled] = createSignal(true);

  const logLevels = ["error", "warn", "info", "verbose", "debug", "silly"];

  onMount(async () => {
    // Load app version and update settings
    if (isElectron()) {
      const info = await systemAPI.getInfo();
      if (info) setAppVersion(info.version);

      const autoCheck = await updateAPI.isAutoCheckEnabled();
      setAutoCheckEnabled(autoCheck);
    }

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

  const handleCheckForUpdates = async () => {
    setUpdateCheckStatus("checking");
    const result = await updateAPI.checkForUpdates();
    if (!result) {
      setUpdateCheckStatus("idle");
      return;
    }
    if (result.status === "available" || result.status === "downloading" || result.status === "downloaded") {
      setUpdateCheckStatus("available");
    } else if (result.status === "error") {
      setUpdateCheckStatus("error");
      // Reset after 3 seconds
      setTimeout(() => setUpdateCheckStatus("idle"), 3000);
    } else {
      setUpdateCheckStatus("up-to-date");
      // Reset after 3 seconds
      setTimeout(() => setUpdateCheckStatus("idle"), 3000);
    }
  };

  const handleAutoCheckToggle = async () => {
    const newValue = !autoCheckEnabled();
    setAutoCheckEnabled(newValue);
    await updateAPI.setAutoCheck(newValue);
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
                    {(engine, index) => {
                      const models = createMemo(() => configStore.engineModels[engine.type] || []);
                      const showModelSelector = createMemo(() =>
                        engine.status === "running"
                      );
                      const selectedModelId = createMemo(() => {
                        const selection = configStore.engineModelSelections[engine.type];
                        if (selection?.modelID) {
                          // For claude engine (combo input) or empty model list, always trust saved value
                          // For other engines with a model list, validate against known models
                          if (engine.type === "claude" || models().length === 0 || models().some(m => m.modelId === selection.modelID)) {
                            return selection.modelID;
                          }
                        }
                        return models()[0]?.modelId || "";
                      });

                      // Group models by provider for optgroup display
                      const providerGroups = createMemo(() => {
                        const groups = new Map<string, { name: string; models: UnifiedModelInfo[] }>();
                        for (const model of models()) {
                          const pid = model.providerId || "default";
                          if (!groups.has(pid)) {
                            groups.set(pid, { name: model.providerName || pid, models: [] });
                          }
                          groups.get(pid)!.models.push(model);
                        }
                        return Array.from(groups.entries());
                      });

                      const handleModelSelect = (modelId: string) => {
                        const model = models().find(m => m.modelId === modelId);
                        saveEngineModelSelection(engine.type, {
                          providerID: model?.providerId || "",
                          modelID: modelId,
                        });
                      };

                      return (
                        <div
                          class={index() < configStore.engines.length - 1 ? "border-b border-slate-100 dark:border-slate-700" : ""}
                        >
                          <div class="p-4 sm:p-6 flex items-center justify-between gap-4">
                            <div class="flex items-center gap-3 min-w-0">
                              {/* Status indicator dot — hidden when engine is disabled */}
                              <Show when={isEngineEnabled(engine.type)}>
                                <span
                                  class={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                                    engine.status === "running" && engine.authenticated === false
                                      ? "bg-amber-500"
                                      : engine.status === "running"
                                        ? "bg-emerald-500"
                                        : engine.status === "starting"
                                          ? "bg-amber-500"
                                          : engine.status === "error"
                                            ? "bg-red-500"
                                            : "bg-slate-400"
                                  }`}
                                />
                              </Show>
                              <div class="min-w-0">
                                <div class="flex items-center gap-2">
                                  <span class={`text-base font-medium truncate ${isEngineEnabled(engine.type) ? "text-gray-900 dark:text-white" : "text-gray-400 dark:text-gray-500"}`}>
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
                                {/* Status text, auth info, version — only shown when enabled */}
                                <Show when={isEngineEnabled(engine.type)}>
                                  <div class="flex items-center gap-2 mt-0.5">
                                    {/* Status text */}
                                    <span class="text-sm text-gray-500 dark:text-gray-400">
                                      <Switch>
                                        <Match when={engine.status === "running" && engine.authenticated === false}>
                                          <span class="text-amber-600 dark:text-amber-400">{t().engine.notAuthenticated}</span>
                                        </Match>
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
                                    {/* Auth info */}
                                    <Show when={engine.authMessage}>
                                      <span class={`text-xs ${engine.authenticated ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                                        {engine.authMessage}
                                      </span>
                                    </Show>
                                    {/* Version */}
                                    <Show when={engine.version}>
                                      <span class="text-xs text-gray-400 dark:text-gray-500">
                                        v{engine.version}
                                      </span>
                                    </Show>
                                  </div>
                                </Show>
                                {/* Show "Disabled" label when engine is off */}
                                <Show when={!isEngineEnabled(engine.type)}>
                                  <span class="block text-sm text-gray-400 dark:text-gray-500 mt-0.5">
                                    {t().engine.disabled}
                                  </span>
                                </Show>
                              </div>
                            </div>
                            {/* Toggle switch */}
                            <button
                              onClick={() => setEngineEnabled(engine.type, !isEngineEnabled(engine.type))}
                              class={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-800 ${
                                isEngineEnabled(engine.type) ? "bg-blue-600" : "bg-gray-200 dark:bg-slate-600"
                              }`}
                              role="switch"
                              aria-checked={isEngineEnabled(engine.type)}
                              aria-label={isEngineEnabled(engine.type) ? t().engine.enabled : t().engine.disabled}
                            >
                              <span
                                class={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                  isEngineEnabled(engine.type) ? "translate-x-5" : "translate-x-0"
                                }`}
                              />
                            </button>
                          </div>

                          {/* Model selector - only for running + enabled engines */}
                          <Show when={showModelSelector() && isEngineEnabled(engine.type)}>
                            <div class="px-4 sm:px-6 pb-4 sm:pb-6 pt-0 flex items-center justify-between gap-4 -mt-2">
                              <div>
                                <h4 class="text-sm font-medium text-gray-700 dark:text-gray-300">
                                  {t().engine.defaultModel}
                                </h4>
                                <p class="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                                  {t().engine.defaultModelDesc}
                                </p>
                              </div>
                              <div class="flex-shrink-0">
                                <Show
                                  when={engine.type !== "claude" && models().length > 0}
                                  fallback={
                                    <>
                                      <input
                                        type="text"
                                        list={`model-list-${engine.type}`}
                                        value={selectedModelId()}
                                        placeholder={t().engine.modelInputPlaceholder}
                                        onBlur={(e) => {
                                          const val = e.currentTarget.value.trim();
                                          if (val) handleModelSelect(val);
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") {
                                            const val = e.currentTarget.value.trim();
                                            if (val) handleModelSelect(val);
                                            e.currentTarget.blur();
                                          }
                                        }}
                                        class="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 transition-colors max-w-[240px] focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400"
                                      />
                                      <Show when={models().length > 0}>
                                        <datalist id={`model-list-${engine.type}`}>
                                          <For each={models()}>
                                            {(model) => <option value={model.modelId}>{model.name}</option>}
                                          </For>
                                        </datalist>
                                      </Show>
                                    </>
                                  }
                                >
                                  <select
                                    value={selectedModelId()}
                                    onChange={(e) => handleModelSelect(e.currentTarget.value)}
                                    disabled={engine.capabilities.modelSwitchable === false}
                                    class={`px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 transition-colors max-w-[240px] ${engine.capabilities.modelSwitchable === false ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-600"}`}
                                  >
                                    <For each={providerGroups()}>
                                      {([pid, group]) => (
                                        <Show
                                          when={providerGroups().length > 1}
                                          fallback={
                                            <For each={group.models}>
                                              {(model) => (
                                                <option value={model.modelId}>{model.name}</option>
                                              )}
                                            </For>
                                          }
                                        >
                                          <optgroup label={group.name}>
                                            <For each={group.models}>
                                              {(model) => (
                                                <option value={model.modelId}>{model.name}</option>
                                              )}
                                            </For>
                                          </optgroup>
                                        </Show>
                                      )}
                                    </For>
                                  </select>
                                </Show>
                              </div>
                            </div>
                          </Show>
                        </div>
                      );
                    }}
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

            {/* Update Section (Electron only) */}
            <Show when={isElectron()}>
              <section>
                <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 px-1">
                  {t().update.title}
                </h2>
                <div class="bg-white dark:bg-slate-800 rounded-xl shadow-xs border border-gray-200 dark:border-slate-700 overflow-visible">
                  {/* Current version + check for updates */}
                  <div class="p-4 sm:p-6 flex items-center justify-between gap-4 border-b border-gray-200 dark:border-slate-700">
                    <div>
                      <h3 class="text-base font-medium text-gray-900 dark:text-white">
                        {t().update.currentVersion}
                      </h3>
                      <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        v{appVersion()}
                      </p>
                      <Show when={updateCheckStatus() === "up-to-date"}>
                        <p class="text-xs text-emerald-600 dark:text-emerald-400 mt-1">
                          {t().update.upToDate}
                        </p>
                      </Show>
                      <Show when={updateCheckStatus() === "available"}>
                        <p class="text-xs text-blue-600 dark:text-blue-400 mt-1">
                          {t().update.available}
                        </p>
                      </Show>
                      <Show when={updateCheckStatus() === "error"}>
                        <p class="text-xs text-red-500 mt-1">
                          {t().update.error}
                        </p>
                      </Show>
                    </div>
                    <div class="flex-shrink-0">
                      <button
                        onClick={handleCheckForUpdates}
                        disabled={updateCheckStatus() === "checking"}
                        class="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {updateCheckStatus() === "checking" ? t().update.checking : t().update.checkForUpdates}
                      </button>
                    </div>
                  </div>
                  {/* Auto-check toggle */}
                  <div class="p-4 sm:p-6 flex items-center justify-between gap-4">
                    <div>
                      <h3 class="text-base font-medium text-gray-900 dark:text-white">
                        {t().update.autoCheck}
                      </h3>
                      <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        {t().update.autoCheckDesc}
                      </p>
                    </div>
                    <div class="flex-shrink-0">
                      <button
                        onClick={handleAutoCheckToggle}
                        class={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          autoCheckEnabled() ? "bg-blue-600" : "bg-gray-300 dark:bg-slate-600"
                        }`}
                        role="switch"
                        aria-checked={autoCheckEnabled()}
                      >
                        <span
                          class={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            autoCheckEnabled() ? "translate-x-6" : "translate-x-1"
                          }`}
                        />
                      </button>
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
