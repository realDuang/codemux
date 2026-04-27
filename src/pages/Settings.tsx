import { For, Show, Switch, Match, createSignal, createMemo, createEffect, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { Spinner } from "../components/Spinner";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import ImportHistoryModal from "../components/ImportHistoryModal";
import { ensureGatewayInitialized, refreshEngineConfigState } from "../lib/engine-bootstrap";
import { ChannelManagementSettings } from "../components/ChannelManagementSettings";
import { useI18n } from "../lib/i18n";
import { logger } from "../lib/logger";
import { useAuthGuard } from "../lib/useAuthGuard";
import { isElectron } from "../lib/platform";
import { Auth } from "../lib/auth";
import { configStore, saveEngineModelSelection, isEngineEnabled, setEngineEnabled } from "../stores/config";
import { ReasoningEffortSelector } from "../components/ReasoningEffortSelector";
import { CodexFastModeToggle } from "../components/CodexFastModeToggle";
import { sessionStore, setSessionStore } from "../stores/session";
import { setScheduledTaskStore } from "../stores/scheduled-task";
import { orchestrationStore, DEFAULT_ROLE_MAPPINGS, updateRoleMappings } from "../stores/orchestration";
import { gateway } from "../lib/gateway-api";
import { systemAPI, updateAPI, autostartAPI } from "../lib/electron-api";
import { getSetting, saveSetting } from "../lib/settings";
import type { UnifiedModelInfo, EngineType, UnifiedSession } from "../types/unified";

export default function Settings() {
  const { t } = useI18n();
  const navigate = useNavigate();

  useAuthGuard("Settings");

  const [logPath, setLogPath] = createSignal("");
  const [logLevel, setLogLevel] = createSignal("warn");
  const [showLogSection, setShowLogSection] = createSignal(isElectron());
  const [showWebChannelSection, setShowWebChannelSection] = createSignal(false);
  const [conversationsPath, setConversationsPath] = createSignal("");

  // Update section state
  const [appVersion, setAppVersion] = createSignal("");
  const [updateCheckStatus, setUpdateCheckStatus] = createSignal<"idle" | "checking" | "up-to-date" | "available" | "error">("idle");
  const [autoCheckEnabled, setAutoCheckEnabled] = createSignal(true);
  const [launchAtLoginEnabled, setLaunchAtLoginEnabled] = createSignal(false);

  // Import history modal state
  const [importModalEngine, setImportModalEngine] = createSignal<EngineType | null>(null);

  // Default workspace visibility
  const [showDefaultWorkspace, setShowDefaultWorkspace] = createSignal(
    getSetting<boolean>("showDefaultWorkspace") ?? true,
  );

  const handleShowDefaultWorkspaceToggle = () => {
    const newValue = !showDefaultWorkspace();
    setShowDefaultWorkspace(newValue);
    saveSetting("showDefaultWorkspace", newValue);
    setSessionStore("showDefaultWorkspace", newValue);
  };

  // Scheduled tasks toggle
  const [scheduledTasksEnabled, setScheduledTasksEnabled] = createSignal(
    getSetting<boolean>("scheduledTasksEnabled") ?? true,
  );

  const handleScheduledTasksToggle = () => {
    const newValue = !scheduledTasksEnabled();
    setScheduledTasksEnabled(newValue);
    saveSetting("scheduledTasksEnabled", newValue);
    setScheduledTaskStore("enabled", newValue);
  };

  // Worktree toggle
  const [worktreeEnabled, setWorktreeEnabledSignal] = createSignal(
    getSetting<boolean>("worktreeEnabled") ?? false,
  );

  const handleWorktreeToggle = () => {
    const newValue = !worktreeEnabled();
    setWorktreeEnabledSignal(newValue);
    saveSetting("worktreeEnabled", newValue);
  };

  // Team orchestration toggle
  const [teamOrchestrationEnabled, setTeamOrchestrationEnabled] = createSignal(
    getSetting<boolean>("teamOrchestrationEnabled") ?? false,
  );

  const handleTeamOrchestrationToggle = () => {
    const newValue = !teamOrchestrationEnabled();
    setTeamOrchestrationEnabled(newValue);
    saveSetting("teamOrchestrationEnabled", newValue);
    setSessionStore("teamOrchestrationEnabled", newValue);
  };

  // Role-engine mapping (reads from orchestration store which already handles persistence)
  const handleRoleEngineChange = (role: string, engineType: string) => {
    const mappings = [...orchestrationStore.roleMappings];
    const idx = mappings.findIndex(m => m.role === role);
    if (idx >= 0) {
      mappings[idx] = { ...mappings[idx], engineType: engineType as EngineType };
      updateRoleMappings(mappings);
    }
  };

  const [enginesLoading, setEnginesLoading] = createSignal(true);

  const logLevels = ["error", "warn", "info", "verbose", "debug", "silly"];

  onMount(async () => {
    // Load engines independently so Settings works even without Chat
    (async () => {
      try {
        await ensureGatewayInitialized();
        await refreshEngineConfigState();
      } catch {
        // Keep existing fallback UI when engine bootstrap fails.
      } finally {
        setEnginesLoading(false);
      }
    })();

    // Load app version and update settings
    if (isElectron()) {
      const info = await systemAPI.getInfo();
      if (info) {
        setAppVersion(info.version);
        // Derive conversations storage path from userData
        const sep = info.platform === "win32" ? "\\" : "/";
        setConversationsPath(info.userDataPath + sep + "conversations");
      }

      const autoCheck = await updateAPI.isAutoCheckEnabled();
      setAutoCheckEnabled(autoCheck);

      const launchAtLogin = await autostartAPI.isEnabled();
      setLaunchAtLoginEnabled(launchAtLogin);

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
      // Web mode: check host capabilities and localhost-only sections
      const localAccess = await Auth.isLocalAccess();
      const serverMode = getSetting<boolean>("serverMode") === true;
      setShowWebChannelSection(serverMode);
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

  const handleOpenConversationsFolder = async () => {
    const path = conversationsPath();
    if (path) {
      try {
        await systemAPI.openPath(path);
      } catch {
        // Failed to open conversations folder
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

  const handleLaunchAtLoginToggle = async () => {
    const newValue = !launchAtLoginEnabled();
    setLaunchAtLoginEnabled(newValue);
    try {
      await autostartAPI.setEnabled(newValue);
    } catch (error) {
      setLaunchAtLoginEnabled(!newValue);
      console.error("[Settings] Failed to toggle launch at login:", error);
    }
  };

  const statusDotColor = (engine: { status: string; authenticated?: boolean }): string => {
    if (engine.status === "running" && engine.authenticated === false) return "bg-amber-500";
    if (engine.status === "running") return "bg-emerald-500";
    if (engine.status === "starting") return "bg-amber-500";
    if (engine.status === "error") return "bg-red-500";
    return "bg-slate-400";
  };

  return (
    <div class="flex flex-col h-screen bg-gray-50 dark:bg-slate-950 font-sans text-gray-900 dark:text-gray-100">
      {/* Unified Titlebar */}
      <div
        class="w-full flex-shrink-0 flex items-center px-2 border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-950 electron-drag-region electron-titlebar-pad-left electron-titlebar-pad-right"
        style={{ height: "var(--electron-title-bar-height, 40px)", "min-height": "var(--electron-title-bar-height, 40px)" }}
      >
        <div class="flex items-center gap-1.5 electron-no-drag flex-shrink-0 titlebar-brand">
          <img src={`${import.meta.env.BASE_URL}assets/logo.png`} alt="CodeMux" class="w-5 h-5 rounded" />
          <span class="hidden sm:inline text-[11px] font-semibold tracking-wide text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-slate-800 px-2 py-0.5 rounded-md border border-gray-200 dark:border-slate-700 select-none">CodeMux</span>
        </div>
        <div class="flex items-center gap-2 electron-no-drag flex-shrink-0">
          <button
            onClick={() => navigate("/chat")}
            class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-slate-700 rounded transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <h1 class="text-[13px] font-medium text-gray-600 dark:text-gray-400">{t().settings.title}</h1>
        </div>
        <div class="flex-1" />
      </div>

      <div class="flex-1 flex overflow-hidden max-w-5xl mx-auto w-full">

        {/* Left navigation tabs */}
        <nav class="hidden md:flex flex-col w-44 flex-shrink-0 pt-6 pl-4 pr-2 overflow-y-auto">
          <ul class="space-y-0.5 sticky top-0">
            <li>
              <button onClick={() => document.getElementById("section-general")?.scrollIntoView({ behavior: "smooth" })} class="w-full text-left block px-3 py-2 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors">
                {t().settings.general}
              </button>
            </li>
            <li>
              <button onClick={() => document.getElementById("section-engines")?.scrollIntoView({ behavior: "smooth" })} class="w-full text-left block px-3 py-2 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors">
                {t().engine.engines}
              </button>
            </li>
            <Show when={showLogSection()}>
              <li>
                <button onClick={() => document.getElementById("section-logging")?.scrollIntoView({ behavior: "smooth" })} class="w-full text-left block px-3 py-2 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors">
                  {t().settings.logging}
                </button>
              </li>
            </Show>
            <li>
              <button onClick={() => document.getElementById("section-features")?.scrollIntoView({ behavior: "smooth" })} class="w-full text-left block px-3 py-2 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors">
                {t().settings.features}
              </button>
            </li>
            <li>
              <button onClick={() => document.getElementById("section-experimental")?.scrollIntoView({ behavior: "smooth" })} class="w-full text-left block px-3 py-2 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors">
                {t().settings.experimental}
              </button>
            </li>
            <Show when={isElectron()}>
              <li>
                <button onClick={() => document.getElementById("section-update")?.scrollIntoView({ behavior: "smooth" })} class="w-full text-left block px-3 py-2 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors">
                  {t().update.title}
                </button>
              </li>
            </Show>
          </ul>
        </nav>

        {/* Main Content */}
        <main class="flex-1 overflow-y-auto px-3 sm:px-6 pb-8 pt-6 scroll-smooth">
          <div class="space-y-8">
            {/* General Settings Section */}
            <section id="section-general">
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
            <section id="section-engines">
              <h2 class="text-sm font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1 px-1">
                {t().engine.engines}
              </h2>
              <p class="text-xs text-slate-500 dark:text-slate-400 mb-4 px-1">
                {t().engine.sessionDefaultsHint}
              </p>
              <Show
                when={configStore.engines.length > 0}
                fallback={
                  <div class="bg-white dark:bg-slate-800 rounded-xl shadow-xs border border-slate-200 dark:border-slate-700 p-6 text-center text-sm text-slate-400 dark:text-slate-500">
                    <Show
                      when={enginesLoading()}
                      fallback={t().engine.noEngines}
                    >
                      <div class="flex items-center justify-center gap-2">
                        <Spinner size="small" class="text-slate-400 dark:text-slate-500" />
                        <span>{t().common.loading}</span>
                      </div>
                    </Show>
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
                      let modelSelectRef: HTMLSelectElement | undefined;
                      const selectedModelId = createMemo(() => {
                        const selection = configStore.engineModelSelections[engine.type];
                        if (selection?.modelID) {
                          // Engines with customModelInput accept arbitrary model IDs
                          if (engine.capabilities?.customModelInput || models().length === 0 || models().some(m => m.modelId === selection.modelID)) {
                            return selection.modelID;
                          }
                        }
                        return models()[0]?.modelId || "";
                      });

                      // Sync native <select> value with reactive state — SolidJS
                      // doesn't reliably update select.value when <For> re-renders options.
                      createEffect(() => {
                        const selectedId = selectedModelId();
                        if (engine.capabilities?.customModelInput || !modelSelectRef) return;
                        if (models().length === 0) return;
                        if (modelSelectRef.value !== selectedId) {
                          modelSelectRef.value = selectedId;
                        }
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
                              {/* Status indicator dot */}
                              <span
                                class={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${statusDotColor(engine)}`}
                              />
                              <div class="min-w-0">
                                <div class="flex items-center gap-2">
                                  <span class={`text-base font-medium truncate ${engine.status === "running" ? "text-gray-900 dark:text-white" : "text-gray-400 dark:text-gray-500"}`}>
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
                                {/* Status text, auth info, version */}
                                <div class="flex items-center gap-2 mt-0.5">
                                  <span class="text-sm text-gray-500 dark:text-gray-400">
                                    <Switch>
                                      <Match when={engine.status === "running" && engine.authenticated === false}>
                                        <span class="text-amber-600 dark:text-amber-400">{t().engine.notAuthenticated}</span>
                                      </Match>
                                      <Match when={engine.status === "running" && !isEngineEnabled(engine.type)}>
                                        {t().engine.disabled}
                                      </Match>
                                      <Match when={engine.status === "running"}>
                                        {t().engine.running}
                                      </Match>
                                      <Match when={engine.status === "starting"}>
                                        {t().engine.starting}
                                      </Match>
                                      <Match when={engine.status === "error"}>
                                        <span class="text-red-600 dark:text-red-400">{t().engine.unavailable}</span>
                                      </Match>
                                      <Match when={engine.status === "stopped"}>
                                        {t().engine.unavailable}
                                      </Match>
                                    </Switch>
                                  </span>
                                  {/* Auth info */}
                                  <Show when={engine.status === "running" && engine.authMessage}>
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
                                {/* Error details */}
                                <Show when={engine.status === "error" && engine.errorMessage}>
                                  <p class="text-xs text-red-500 dark:text-red-400 mt-1 break-words">
                                    {engine.errorMessage}
                                  </p>
                                </Show>
                              </div>
                            </div>
                            {/* Toggle switch: ON only when running+enabled, disabled when not running */}
                            <button
                              onClick={() => engine.status === "running" && setEngineEnabled(engine.type, !isEngineEnabled(engine.type))}
                              disabled={engine.status !== "running"}
                              class={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                                engine.status !== "running"
                                  ? "bg-gray-200 dark:bg-slate-700 opacity-50 cursor-not-allowed"
                                  : isEngineEnabled(engine.type)
                                    ? "bg-blue-600 cursor-pointer focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-800"
                                    : "bg-gray-200 dark:bg-slate-600 cursor-pointer focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-800"
                              }`}
                              role="switch"
                              aria-checked={engine.status === "running" && isEngineEnabled(engine.type)}
                              aria-label={engine.status === "running" && isEngineEnabled(engine.type) ? t().engine.enabled : t().engine.disabled}
                            >
                              <span
                                class={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                  engine.status === "running" && isEngineEnabled(engine.type) ? "translate-x-5" : "translate-x-0"
                                }`}
                              />
                            </button>
                          </div>

                          {/* Model selector - only for running + enabled engines */}
                          <Show when={showModelSelector() && isEngineEnabled(engine.type)}>
                            <div class="px-4 sm:px-6 pb-4 sm:pb-6 pt-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4 -mt-2">
                              <div>
                                <h4 class="text-sm font-medium text-gray-700 dark:text-gray-300">
                                  {t().engine.defaultModel}
                                </h4>
                                <p class="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                                  {t().engine.defaultModelDesc}
                                </p>
                              </div>
                              <div class="flex-shrink-0 w-full sm:w-auto">
                                <Show
                                  when={engine.capabilities?.customModelInput}
                                  fallback={
                                    <select
                                      ref={modelSelectRef}
                                      value={selectedModelId()}
                                      onChange={(e) => handleModelSelect(e.currentTarget.value)}
                                      disabled={engine.capabilities?.modelSwitchable === false}
                                      class={`w-full sm:w-[260px] px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 transition-colors ${engine.capabilities?.modelSwitchable === false ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-600"}`}
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
                                  }
                                >
                                  {/* Custom model input with dropdown for engines that allow arbitrary model IDs */}
                                  <div class="relative w-full sm:w-[260px]">
                                    <input
                                      type="text"
                                      value={selectedModelId()}
                                      onInput={(e) => handleModelSelect(e.currentTarget.value)}
                                      onFocus={(e) => {
                                        const dropdown = e.currentTarget.nextElementSibling as HTMLElement;
                                        if (dropdown) dropdown.style.display = "block";
                                      }}
                                      onBlur={(e) => {
                                        const dropdown = e.currentTarget.nextElementSibling as HTMLElement;
                                        setTimeout(() => {
                                          if (dropdown) dropdown.style.display = "none";
                                        }, 150);
                                      }}
                                      placeholder="Enter model ID..."
                                      class="w-full px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 transition-colors hover:bg-gray-100 dark:hover:bg-slate-600"
                                    />
                                    <div
                                      style="display:none"
                                      class="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 shadow-lg"
                                    >
                                      <For each={models()}>
                                        {(model) => (
                                          <div
                                            class="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-600"
                                            onMouseDown={(e) => {
                                              e.preventDefault();
                                              handleModelSelect(model.modelId);
                                              const input = e.currentTarget.closest("div.relative")?.querySelector("input") as HTMLInputElement;
                                              if (input) { input.value = model.modelId; input.blur(); }
                                            }}
                                          >
                                            {model.name || model.modelId}
                                          </div>
                                        )}
                                      </For>
                                    </div>
                                  </div>
                                </Show>
                              </div>
                            </div>
                          </Show>

                          {/* Reasoning effort selector - only for running + enabled engines */}
                          <Show when={showModelSelector() && isEngineEnabled(engine.type)}>
                            <ReasoningEffortSelector
                              engineType={engine.type}
                              models={models}
                              selectedModelId={selectedModelId}
                            />
                          </Show>

                          {/* Codex Fast Mode toggle */}
                          <Show when={engine.type === "codex" && showModelSelector() && isEngineEnabled(engine.type)}>
                            <CodexFastModeToggle engineType={engine.type} />
                          </Show>

                          {/* Import History button - only for running + enabled engines */}
                          <Show when={engine.status === "running" && isEngineEnabled(engine.type)}>
                            <div class="px-4 sm:px-6 pb-4 sm:pb-6 pt-0 -mt-2">
                              <button
                                onClick={() => setImportModalEngine(engine.type)}
                                class="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
                              >
                                {t().settings.importHistory}
                              </button>
                            </div>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </section>

            <Show when={!isElectron() && showWebChannelSection()}>
              <ChannelManagementSettings />
            </Show>

            {/* Logging Section */}
            <Show when={showLogSection()}>
              <section id="section-logging">
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
                  {/* Conversations storage */}
                  <Show when={isElectron()}>
                    <div class="p-4 sm:p-6 flex items-center justify-between gap-4 border-b border-gray-200 dark:border-slate-700">
                      <div class="min-w-0">
                        <h3 class="text-base font-medium text-gray-900 dark:text-white">
                          {t().settings.conversationsPath}
                        </h3>
                        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                          {t().settings.conversationsPathDesc}
                        </p>
                        <Show when={conversationsPath()}>
                          <p class="text-xs text-gray-400 dark:text-gray-500 mt-2 font-mono truncate" title={conversationsPath()}>
                            {conversationsPath()}
                          </p>
                        </Show>
                      </div>
                      <div class="flex-shrink-0">
                        <button
                          onClick={handleOpenConversationsFolder}
                          disabled={!conversationsPath()}
                          class="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {t().settings.openConversationsFolder}
                        </button>
                      </div>
                    </div>
                  </Show>
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

            {/* Features Section */}
            <section id="section-features">
              <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 px-1">
                {t().settings.features}
              </h2>
              <div class="bg-white dark:bg-slate-800 rounded-xl shadow-xs border border-gray-200 dark:border-slate-700 overflow-visible">
                {/* Show Default Workspace toggle */}
                <div class="p-4 sm:p-6 flex items-center justify-between gap-4 border-b border-gray-200 dark:border-slate-700">
                  <div>
                    <h3 class="text-base font-medium text-gray-900 dark:text-white">
                      {t().settings.showDefaultWorkspace}
                    </h3>
                    <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      {t().settings.showDefaultWorkspaceDesc}
                    </p>
                  </div>
                  <div class="flex-shrink-0">
                    <button
                      onClick={handleShowDefaultWorkspaceToggle}
                      class={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        showDefaultWorkspace() ? "bg-blue-600" : "bg-gray-300 dark:bg-slate-600"
                      }`}
                      role="switch"
                      aria-checked={showDefaultWorkspace()}
                      aria-label={t().settings.showDefaultWorkspace}
                    >
                      <span
                        class={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          showDefaultWorkspace() ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>
                </div>
                {/* Scheduled Tasks toggle */}
                <div class="p-4 sm:p-6 flex items-center justify-between gap-4 border-b border-gray-200 dark:border-slate-700">
                  <div>
                    <h3 class="text-base font-medium text-gray-900 dark:text-white">
                      {t().settings.scheduledTasksEnabled}
                    </h3>
                    <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      {t().settings.scheduledTasksEnabledDesc}
                    </p>
                  </div>
                  <div class="flex-shrink-0">
                    <button
                      onClick={handleScheduledTasksToggle}
                      class={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        scheduledTasksEnabled() ? "bg-blue-600" : "bg-gray-300 dark:bg-slate-600"
                      }`}
                      role="switch"
                      aria-checked={scheduledTasksEnabled()}
                      aria-label={t().settings.scheduledTasksEnabled}
                    >
                      <span
                        class={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          scheduledTasksEnabled() ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>
                </div>
                {/* Worktree toggle */}
                <div class="p-4 sm:p-6 flex items-center justify-between gap-4">
                  <div>
                    <h3 class="text-base font-medium text-gray-900 dark:text-white">
                      {t().worktree.enabled}
                    </h3>
                    <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      {t().worktree.enabledDesc}
                    </p>
                  </div>
                  <div class="flex-shrink-0">
                    <button
                      onClick={handleWorktreeToggle}
                      class={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        worktreeEnabled() ? "bg-blue-600" : "bg-gray-300 dark:bg-slate-600"
                      }`}
                      role="switch"
                      aria-checked={worktreeEnabled()}
                      aria-label={t().worktree.enabled}
                    >
                      <span
                        class={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          worktreeEnabled() ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>
            </section>

            {/* Experimental Section */}
            <section id="section-experimental">
              <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 px-1">
                {t().settings.experimental}
              </h2>
              <div class="bg-white dark:bg-slate-800 rounded-xl shadow-xs border border-gray-200 dark:border-slate-700 overflow-visible">
                {/* Team Orchestration toggle */}
                <div class="p-4 sm:p-6 flex items-center justify-between gap-4" classList={{ "border-b border-gray-200 dark:border-slate-700": teamOrchestrationEnabled() }}>
                  <div>
                    <h3 class="text-base font-medium text-gray-900 dark:text-white">
                      {t().settings.teamOrchestration}
                    </h3>
                    <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      {t().settings.teamOrchestrationDesc}
                    </p>
                  </div>
                  <div class="flex-shrink-0">
                    <button
                      onClick={handleTeamOrchestrationToggle}
                      class={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        teamOrchestrationEnabled() ? "bg-blue-600" : "bg-gray-300 dark:bg-slate-600"
                      }`}
                      role="switch"
                      aria-checked={teamOrchestrationEnabled()}
                      aria-label={t().settings.teamOrchestration}
                    >
                      <span
                        class={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          teamOrchestrationEnabled() ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>
                </div>
                {/* Role-Engine Mapping (shown only when team orchestration is enabled) */}
                <Show when={teamOrchestrationEnabled()}>
                  <div class="p-4 sm:p-6">
                    <h3 class="text-base font-medium text-gray-900 dark:text-white">
                      {t().settings.teamOrchestrationRoles}
                    </h3>
                    <p class="text-sm text-gray-500 dark:text-gray-400 mt-1 mb-4">
                      {t().settings.teamOrchestrationRolesDesc}
                    </p>
                    <div class="space-y-3">
                      <For each={orchestrationStore.roleMappings}>
                        {(mapping) => {
                          const roleLabels: Record<string, () => string> = {
                            explorer: () => t().settings.roleExplorer,
                            researcher: () => t().settings.roleResearcher,
                            reviewer: () => t().settings.roleReviewer,
                            designer: () => t().settings.roleDesigner,
                            coder: () => t().settings.roleCoder,
                          };
                          let selectRef: HTMLSelectElement | undefined;
                          // Sync native <select> value with reactive state — SolidJS
                          // doesn't reliably update select.value when <For> re-renders options.
                          createEffect(() => {
                            const val = mapping.engineType;
                            if (!selectRef) return;
                            if (configStore.engines.length === 0) return;
                            if (selectRef.value !== val) {
                              selectRef.value = val;
                            }
                          });
                          return (
                            <div class="flex items-center justify-between gap-3">
                              <div class="min-w-0">
                                <div class="text-sm font-medium text-gray-700 dark:text-gray-300">
                                  {roleLabels[mapping.role]?.() || mapping.role}
                                </div>
                                <div class="text-xs text-gray-400 dark:text-gray-500 truncate">
                                  {mapping.description}
                                </div>
                              </div>
                              <select
                                ref={selectRef}
                                value={mapping.engineType}
                                onChange={(e) => handleRoleEngineChange(mapping.role, e.currentTarget.value)}
                                class="px-2.5 py-1 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 cursor-pointer flex-shrink-0"
                              >
                                <For each={configStore.engines}>
                                  {(engine) => (
                                    <option value={engine.type}>
                                      {engine.type}{engine.status !== "running" ? " (stopped)" : ""}
                                    </option>
                                  )}
                                </For>
                              </select>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>
            </section>

            <Show when={isElectron()}>
              <section id="section-update">
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
                  <div class="p-4 sm:p-6 flex items-center justify-between gap-4 border-b border-gray-200 dark:border-slate-700">
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
                  {/* Launch at Login toggle */}
                  <div class="p-4 sm:p-6 flex items-center justify-between gap-4">
                    <div>
                      <h3 class="text-base font-medium text-gray-900 dark:text-white">
                        {t().update.launchAtLogin}
                      </h3>
                      <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        {t().update.launchAtLoginDesc}
                      </p>
                    </div>
                    <div class="flex-shrink-0">
                      <button
                        onClick={handleLaunchAtLoginToggle}
                        class={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          launchAtLoginEnabled() ? "bg-blue-600" : "bg-gray-300 dark:bg-slate-600"
                        }`}
                        role="switch"
                        aria-checked={launchAtLoginEnabled()}
                      >
                        <span
                          class={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            launchAtLoginEnabled() ? "translate-x-6" : "translate-x-1"
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

      {/* Import History Modal */}
      <Show when={importModalEngine()}>
        <ImportHistoryModal
          engineType={importModalEngine()!}
          onClose={() => setImportModalEngine(null)}
          onImportComplete={async () => {
            // Refresh session list so imported sessions appear immediately
            try {
              const [allProjects, allSessions] = await Promise.all([
                gateway.listAllProjects(),
                gateway.listAllSessions(),
              ]);
              setSessionStore("projects", allProjects);
              const validDirs = new Set(allProjects.map(p => p.directory));
              const normDir = (d: string) => d.replaceAll("\\", "/");
              const projectIndex = new Map(allProjects.map(p => [p.directory, p]));
              const infos = allSessions
                .filter(s => s.directory && (validDirs.has(normDir(s.directory)) || s.worktreeId))
                .map((s: UnifiedSession) => ({
                  id: s.id,
                  engineType: s.engineType,
                  title: s.title || "",
                  directory: s.directory || "",
                  projectID: s.projectId ?? projectIndex.get(normDir(s.directory))?.id,
                  worktreeId: s.worktreeId,
                  createdAt: new Date(s.time.created).toISOString(),
                  updatedAt: new Date(s.time.updated).toISOString(),
                }));
              setSessionStore("list", infos);
            } catch { /* ignore */ }
          }}
        />
      </Show>
    </div>
  );
}
