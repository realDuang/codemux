import { createSignal, onMount, onCleanup, Show, createEffect, Switch, Match } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Auth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { logger } from "../lib/logger";
import { isElectron } from "../lib/platform";
import { systemAPI, tunnelAPI } from "../lib/electron-api";

interface TunnelInfo {
  url: string;
  status: "starting" | "running" | "stopped" | "error";
  startTime?: number;
  error?: string;
}

export default function EntryPage() {
  const { t } = useI18n();
  const navigate = useNavigate();

  // Access detection states
  const [checking, setChecking] = createSignal(true);
  // isHost: true in Electron OR localhost web access (show remote access config)
  const [isHost, setIsHost] = createSignal(false);

  // Login form states (for remote access)
  const [code, setCode] = createSignal("");
  const [loginError, setLoginError] = createSignal("");
  const [loginLoading, setLoginLoading] = createSignal(false);
  
  // Approval flow states
  const [waitingApproval, setWaitingApproval] = createSignal(false);
  const [approvalStatus, setApprovalStatus] = createSignal<"pending" | "denied" | "expired" | null>(null);
  const [deviceInfo, setDeviceInfo] = createSignal<{ name: string; platform: string; browser: string } | null>(null);
  let statusPollTimer: ReturnType<typeof setInterval> | null = null;

  // Local mode states (remote access config)
  const [tunnelEnabled, setTunnelEnabled] = createSignal(false);
  const [tunnelInfo, setTunnelInfo] = createSignal<TunnelInfo>({
    url: "",
    status: "stopped",
  });
  const [tunnelLoading, setTunnelLoading] = createSignal(false);
  const [localIp, setLocalIp] = createSignal("127.0.0.1");
  const [accessCode, setAccessCode] = createSignal("......");
  const [port, setPort] = createSignal(5174);
  const [showPassword, setShowPassword] = createSignal(false);
  const [activeQrTab, setActiveQrTab] = createSignal<"lan" | "public">("lan");
  const [enteringChat, setEnteringChat] = createSignal(false);

  onMount(async () => {
    logger.debug("[EntryPage] Mounted, checking access type...");

    // Host mode: Electron OR localhost web access
    const inElectron = isElectron();
    logger.debug("[EntryPage] Is Electron:", inElectron);

    // For Electron, always host mode
    if (inElectron) {
      setIsHost(true);
      setChecking(false);
      loadLocalModeData();
      return;
    }

    // For Web clients, check if already authenticated
    const hasValidToken = await Auth.checkDeviceToken();
    
    // Check if accessing from localhost
    const isLocal = await Auth.isLocalAccess();
    logger.debug("[EntryPage] Is localhost:", isLocal);

    if (isLocal) {
      // Localhost web access - treat as host mode (show remote access config)
      setIsHost(true);
      setChecking(false);
      
      // Auto-authenticate if not already
      if (!hasValidToken) {
        const authResult = await Auth.localAuth();
        if (!authResult.success) {
          logger.error("[EntryPage] Local auth failed:", authResult.error);
        }
      }
      
      loadLocalModeData();
      return;
    }

    // Remote access - check auth and show login if needed
    if (hasValidToken) {
      logger.debug("[EntryPage] Already authenticated, redirecting to chat");
      navigate("/chat", { replace: true });
      return;
    }

    setChecking(false);
  });

  onCleanup(() => {
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
    }
  });

  const loadLocalModeData = async () => {
    // Get system info - different sources for Electron vs Browser
    try {
      if (isElectron()) {
        // Electron: use IPC APIs for local IP
        const localIpResult = await systemAPI.getLocalIp();
        if (localIpResult) setLocalIp(localIpResult);

        // For port, use the current window's port in dev mode
        // In production (file:// protocol), use default port 5173
        const currentPort = window.location.port;
        if (currentPort) {
          setPort(parseInt(currentPort, 10));
        } else {
          // Production Electron: default to 5173
          setPort(5173);
        }
      } else {
        // Browser: use HTTP API
        const res = await fetch("/api/system/info");
        const data = await res.json();
        if (data.localIp) setLocalIp(data.localIp);
        if (data.port) setPort(data.port);
      }
    } catch (err) {
      logger.error("[EntryPage] Failed to get system info:", err);
    }

    // Check if we already have a valid token before creating a new device
    const hasValidToken = await Auth.checkDeviceToken();
    if (!hasValidToken) {
      const authResult = await Auth.localAuth();
      if (!authResult.success) {
        logger.error("[EntryPage] Local auth failed:", authResult.error);
      }
    }

    // Now we can get the access code
    const code = await Auth.getAccessCode();
    if (code) setAccessCode(code);

    // Get tunnel status
    checkTunnelStatus();
  };

  const checkTunnelStatus = async () => {
    try {
      if (isElectron()) {
        // Electron: use IPC API
        const info = await tunnelAPI.getStatus();
        if (info) {
          setTunnelInfo(info);
          setTunnelEnabled(info.status === "running");
        }
      } else {
        // Browser: use HTTP API
        const res = await fetch("/api/tunnel/status");
        const info = await res.json();
        setTunnelInfo(info);
        setTunnelEnabled(info.status === "running");
      }
    } catch (error) {
      logger.error("[EntryPage] Failed to check tunnel status:", error);
    }
  };

  // Auto switch QR tab when tunnel status changes
  createEffect(() => {
    if (tunnelInfo().status === "running") {
      setActiveQrTab("public");
    } else {
      setActiveQrTab("lan");
    }
  });

  // =========================================================================
  // Remote login handlers
  // =========================================================================

  const handleLoginSubmit = async (e: Event) => {
    e.preventDefault();
    setLoginError("");
    setLoginLoading(true);

    try {
      // Collect device info for display
      const info = Auth.collectDeviceInfo();
      setDeviceInfo(info);
      
      const result = await Auth.requestAccess(code());
      
      if (result.success && result.requestId) {
        setWaitingApproval(true);
        setApprovalStatus("pending");
        startPollingStatus(result.requestId);
      } else {
        setLoginError(result.error || t().login.invalidCode);
      }
    } catch (err) {
      logger.error("[EntryPage] Login error:", err);
      setLoginError(t().login.errorOccurred);
    } finally {
      setLoginLoading(false);
    }
  };

  const startPollingStatus = (requestId: string) => {
    // Clear existing timer if any
    if (statusPollTimer) clearInterval(statusPollTimer);
    
    statusPollTimer = setInterval(async () => {
      try {
        const result = await Auth.checkAccessStatus(requestId);
        
        if (result.status === "approved") {
          if (statusPollTimer) clearInterval(statusPollTimer);
          setApprovalStatus(null);
          navigate("/chat", { replace: true });
        } else if (result.status === "denied") {
          if (statusPollTimer) clearInterval(statusPollTimer);
          setApprovalStatus("denied");
        } else if (result.status === "expired") {
          if (statusPollTimer) clearInterval(statusPollTimer);
          setApprovalStatus("expired");
        }
        // "pending" -> continue polling
      } catch (err) {
        logger.error("[EntryPage] Status check error:", err);
      }
    }, 2000);
  };

  const handleRetry = () => {
    setWaitingApproval(false);
    setApprovalStatus(null);
    setCode("");
    setLoginError("");
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
  };

  // =========================================================================
  // Local mode handlers
  // =========================================================================

  const handleTunnelToggle = () => tunnelEnabled() ? stopTunnel() : startTunnel();

  const startTunnel = async () => {
    setTunnelLoading(true);
    try {
      let info: TunnelInfo;

      if (isElectron()) {
        // Electron: use IPC API
        const result = await tunnelAPI.start(port());
        info = result || { url: "", status: "error", error: t().remote.startFailed };
      } else {
        // Browser: use HTTP API
        const res = await fetch("/api/tunnel/start", { method: "POST" });
        info = await res.json();
      }

      setTunnelInfo(info);
      setTunnelEnabled(true);

      if (info.status === "starting") {
        const pollInterval = setInterval(async () => {
          let statusInfo: TunnelInfo;
          if (isElectron()) {
            const result = await tunnelAPI.getStatus();
            statusInfo = result || { url: "", status: "stopped" };
          } else {
            const statusRes = await fetch("/api/tunnel/status");
            statusInfo = await statusRes.json();
          }
          setTunnelInfo(statusInfo);

          if (statusInfo.status === "running" || statusInfo.status === "error") {
            clearInterval(pollInterval);
            setTunnelLoading(false);
          }
        }, 1000);

        setTimeout(() => {
          clearInterval(pollInterval);
          setTunnelLoading(false);
        }, 30000);
      } else {
        setTunnelLoading(false);
      }
    } catch (error) {
      logger.error("[EntryPage] Failed to start tunnel:", error);
      setTunnelInfo({
        url: "",
        status: "error",
        error: t().remote.startFailed,
      });
      setTunnelLoading(false);
    }
  };

  const stopTunnel = async () => {
    setTunnelLoading(true);
    try {
      if (isElectron()) {
        await tunnelAPI.stop();
      } else {
        await fetch("/api/tunnel/stop", { method: "POST" });
      }
      setTunnelInfo({ url: "", status: "stopped" });
      setTunnelEnabled(false);
    } catch (error) {
      logger.error("[EntryPage] Failed to stop tunnel:", error);
    } finally {
      setTunnelLoading(false);
    }
  };

  const handleEnterChat = async () => {
    setEnteringChat(true);
    try {
      // Token should already be set from loadLocalModeData
      if (Auth.isAuthenticated()) {
        navigate("/chat", { replace: true });
      } else {
        // Fallback: try to auth again
        const result = await Auth.localAuth();
        if (result.success) {
          navigate("/chat", { replace: true });
        } else {
          logger.error("[EntryPage] Failed to enter chat:", result.error);
        }
      }
    } finally {
      setEnteringChat(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const generateQRCode = (url: string) => {
    return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
  };

  const getLanUrl = () => `http://${localIp()}:${port()}`;
  const getLocalUrl = () => `http://localhost:${port()}`;

  // =========================================================================
  // Render
  // =========================================================================

  return (
    <div class="flex flex-col min-h-screen bg-gray-50/50 dark:bg-zinc-950 font-sans text-gray-900 dark:text-gray-100 electron-safe-top">
      {/* Language switcher for remote login page (non-host mode) */}
      <Show when={!isHost()}>
        <div class="absolute top-4 right-4 z-20" style={{ top: "calc(1rem + var(--electron-title-bar-height, 0px))" }}>
          <LanguageSwitcher />
        </div>
      </Show>

      {/* Loading state */}
      <Show when={checking()}>
        <div class="flex-1 flex items-center justify-center">
          <div class="text-center">
            <div class="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-4" />
            <p class="text-gray-500 dark:text-gray-400">{t().entry.checkingAccess}</p>
          </div>
        </div>
      </Show>

      {/* Remote access: Show login form or approval status */}
      <Show when={!checking() && !isHost()}>
        <div class="flex-1 flex items-center justify-center p-4">
          <div class="w-full max-w-md p-8 bg-white dark:bg-zinc-800 rounded-lg shadow-md transition-all duration-300">
            <Show when={!waitingApproval()} fallback={
              <div class="text-center space-y-6">
                <Switch>
                  <Match when={approvalStatus() === "pending"}>
                    <div class="animate-pulse w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-blue-600 dark:text-blue-400">
                        <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
                        <path d="M12 6v6l4 2"/>
                      </svg>
                    </div>
                    <h2 class="text-xl font-bold text-gray-900 dark:text-white">
                      {t().approval.waitingTitle}
                    </h2>
                    <p class="text-gray-500 dark:text-gray-400">
                      {t().approval.waitingDesc}
                    </p>
                    
                    <div class="bg-gray-50 dark:bg-zinc-700/50 rounded-lg p-4 text-left text-sm space-y-2">
                      <div class="flex justify-between">
                        <span class="text-gray-500 dark:text-gray-400">{t().approval.deviceName}:</span>
                        <span class="font-medium text-gray-900 dark:text-white">{deviceInfo()?.name}</span>
                      </div>
                      <div class="flex justify-between">
                        <span class="text-gray-500 dark:text-gray-400">{t().approval.platform}:</span>
                        <span class="font-medium text-gray-900 dark:text-white">{deviceInfo()?.platform}</span>
                      </div>
                      <div class="flex justify-between">
                        <span class="text-gray-500 dark:text-gray-400">{t().approval.browser}:</span>
                        <span class="font-medium text-gray-900 dark:text-white">{deviceInfo()?.browser}</span>
                      </div>
                    </div>

                    <div class="text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/10 p-3 rounded-md">
                      {t().approval.waitingHint}
                    </div>

                    <button
                      onClick={handleRetry}
                      class="w-full mt-4 py-2 px-4 border border-gray-300 dark:border-zinc-600 hover:bg-gray-50 dark:hover:bg-zinc-700 text-gray-700 dark:text-gray-300 font-medium rounded-md transition-colors"
                    >
                      {t().common.cancel}
                    </button>
                  </Match>

                  <Match when={approvalStatus() === "denied"}>
                    <div class="w-16 h-16 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-red-600 dark:text-red-400">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="15" y1="9" x2="9" y2="15"/>
                        <line x1="9" y1="9" x2="15" y2="15"/>
                      </svg>
                    </div>
                    <h2 class="text-xl font-bold text-gray-900 dark:text-white">
                      {t().approval.denied}
                    </h2>
                    <p class="text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/10 p-3 rounded-md text-sm">
                      {t().approval.deniedDesc}
                    </p>
                    <button
                      onClick={handleRetry}
                      class="w-full py-2 px-4 bg-gray-200 dark:bg-zinc-700 hover:bg-gray-300 dark:hover:bg-zinc-600 text-gray-800 dark:text-white font-medium rounded-md transition-colors"
                    >
                      {t().approval.tryAgain}
                    </button>
                  </Match>

                  <Match when={approvalStatus() === "expired"}>
                    <div class="w-16 h-16 bg-orange-100 dark:bg-orange-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-orange-600 dark:text-orange-400">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                      </svg>
                    </div>
                    <h2 class="text-xl font-bold text-gray-900 dark:text-white">
                      {t().approval.expired}
                    </h2>
                    <p class="text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/10 p-3 rounded-md text-sm">
                      {t().approval.expiredDesc}
                    </p>
                    <button
                      onClick={handleRetry}
                      class="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md transition-colors"
                    >
                      {t().approval.tryAgain}
                    </button>
                  </Match>
                </Switch>
              </div>
            }>
              <h1 class="text-2xl font-bold text-center mb-6 text-gray-800 dark:text-white">
                {t().login.title}
              </h1>

              <form onSubmit={handleLoginSubmit} class="space-y-4">
                <div>
                  <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t().login.accessCode}
                  </label>
                  <input
                    type="text"
                    value={code()}
                    onInput={(e) => setCode(e.currentTarget.value)}
                    placeholder={t().login.placeholder}
                    class="w-full px-4 py-2 border rounded-md focus:ring-2 focus:ring-blue-500 focus:outline-none dark:bg-zinc-700 dark:border-zinc-600 dark:text-white text-center text-lg tracking-widest font-mono"
                    maxLength={6}
                    disabled={loginLoading()}
                    autofocus
                  />
                </div>

                <Show when={loginError()}>
                  <div class="text-red-500 text-sm text-center bg-red-50 dark:bg-red-900/10 p-2 rounded border border-red-100 dark:border-red-900/30">
                    {loginError()}
                  </div>
                </Show>

                <button
                  type="submit"
                  disabled={loginLoading() || code().length !== 6}
                  class="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  <Show when={loginLoading()} fallback={t().login.connect}>
                    <div class="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                    <span>{t().login.verifying}</span>
                  </Show>
                </button>
              </form>

              <p class="text-xs text-gray-500 dark:text-gray-400 text-center mt-6">
                {t().login.rememberDevice}
              </p>
            </Show>
          </div>
        </div>
      </Show>

      {/* Host mode (Electron): Show remote access config + enter chat button */}
      <Show when={!checking() && isHost()}>
        <div class="flex-1 overflow-y-auto">
          {/* Header */}
          <header class="sticky top-0 z-10 backdrop-blur-md bg-white/70 dark:bg-zinc-900/70 border-b border-gray-200 dark:border-zinc-800 px-4 h-14 flex items-center justify-between">
            <div class="flex items-center gap-2">
              <h1 class="font-semibold text-lg">{t().remote.title}</h1>
            </div>
            <div class="flex items-center gap-3">
              <LanguageSwitcher />
              <div class="text-xs font-medium px-2 py-1 rounded bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-gray-400">
                OpenCode Remote
              </div>
            </div>
          </header>

          {/* Main Content */}
          <main class="p-4 md:p-6">
            <div class="max-w-2xl mx-auto space-y-6">

              {/* Local Mode Banner */}
              <div class="rounded-xl bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 p-4 flex gap-3">
                <svg xmlns="http://www.w3.org/2000/svg" class="shrink-0 text-blue-600 dark:text-blue-400 mt-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>
                <div class="text-sm text-blue-800 dark:text-blue-200">
                  <span class="font-medium">{t().entry.localModeTitle}</span> {t().entry.localModeDesc}
                </div>
              </div>

              {/* Status & Toggle Card */}
              <div class="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-xs overflow-hidden">
                <div class="p-5 flex items-center justify-between">
                  <div class="space-y-1">
                    <div class="flex items-center gap-2">
                      <h2 class="font-semibold text-base">{t().remote.publicAccess}</h2>
                      <Show when={tunnelLoading() || tunnelInfo().status === "starting"}>
                        <span class="inline-flex h-2 w-2 rounded-full bg-yellow-400 animate-pulse"></span>
                      </Show>
                      <Show when={!tunnelLoading() && tunnelInfo().status === "running"}>
                        <span class="inline-flex h-2 w-2 rounded-full bg-green-500"></span>
                      </Show>
                    </div>
                    <p class="text-sm text-gray-500 dark:text-gray-400">
                      {t().remote.publicAccessDesc}
                    </p>
                  </div>

                  <button
                    onClick={handleTunnelToggle}
                    disabled={tunnelLoading()}
                    class={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                      tunnelEnabled() ? "bg-blue-600" : "bg-gray-200 dark:bg-zinc-700"
                    } ${tunnelLoading() ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    <span class="sr-only">Toggle Remote Access</span>
                    <span
                      class={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        tunnelEnabled() ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>

                <Show when={tunnelInfo().error}>
                  <div class="px-5 py-3 bg-red-50 dark:bg-red-900/10 border-t border-red-100 dark:border-red-900/30">
                    <p class="text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
                      {tunnelInfo().error}
                    </p>
                  </div>
                </Show>

                <Show when={tunnelEnabled() && tunnelInfo().status === "starting"}>
                  <div class="px-5 py-3 bg-blue-50 dark:bg-blue-900/10 border-t border-blue-100 dark:border-blue-900/30">
                    <p class="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-2">
                      <svg class="animate-spin" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                      {t().remote.starting}
                    </p>
                  </div>
                </Show>
              </div>

              {/* Warning Banner */}
              <div class="rounded-xl bg-orange-50 dark:bg-orange-900/10 border border-orange-100 dark:border-orange-900/30 p-4 flex gap-3">
                <svg xmlns="http://www.w3.org/2000/svg" class="shrink-0 text-orange-600 dark:text-orange-400 mt-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
                <div class="text-sm text-orange-800 dark:text-orange-200">
                  <span class="font-medium">{t().remote.securityWarning}</span> {t().remote.securityWarningDesc}
                </div>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Left Column: Info */}
                <div class="space-y-6">

                  {/* Access Code Card */}
                  <div class="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-xs p-5">
                    <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3 flex items-center gap-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                      {t().remote.accessPassword}
                    </h3>
                    <div class="flex items-center justify-between bg-gray-50 dark:bg-zinc-950 rounded-lg border border-gray-200 dark:border-zinc-800 px-4 py-3">
                      <span class="font-mono text-xl font-bold tracking-widest text-gray-900 dark:text-white">
                        {showPassword() ? accessCode() : "••••••"}
                      </span>
                      <div class="flex items-center gap-2">
                        <button
                          onClick={() => setShowPassword(!showPassword())}
                          class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors rounded-md hover:bg-gray-200 dark:hover:bg-zinc-800"
                          title={showPassword() ? "Hide" : "Show"}
                        >
                          <Show when={showPassword()} fallback={
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7c.44 0 .87-.03 1.28-.09"/><path d="M2 2l20 20"/></svg>
                          }>
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                          </Show>
                        </button>
                        <button
                          onClick={() => copyToClipboard(accessCode())}
                          class="p-1.5 text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/30"
                          title="Copy"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Connection Addresses */}
                  <div class="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-xs overflow-hidden">
                    <div class="p-4 border-b border-gray-100 dark:border-zinc-800/50">
                      <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">{t().remote.connectionAddress}</h3>
                    </div>
                    <div class="divide-y divide-gray-100 dark:divide-zinc-800/50">

                      {/* Public Address */}
                      <Show when={tunnelInfo().status === "running"}>
                        <div class="p-4 flex items-center justify-between group hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors">
                          <div class="min-w-0 flex-1 mr-4">
                            <div class="flex items-center gap-2 mb-1">
                              <span class="inline-flex items-center justify-center w-5 h-5 rounded bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400">
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
                              </span>
                              <span class="text-xs font-medium text-gray-500">{t().remote.publicAddress}</span>
                            </div>
                            <p class="font-mono text-sm text-green-700 dark:text-green-400 truncate select-all">{tunnelInfo().url}</p>
                          </div>
                          <button
                            onClick={() => copyToClipboard(tunnelInfo().url)}
                            class="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 opacity-0 group-hover:opacity-100 transition-all"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                          </button>
                        </div>
                      </Show>

                      {/* LAN Address */}
                      <div class="p-4 flex items-center justify-between group hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors">
                        <div class="min-w-0 flex-1 mr-4">
                          <div class="flex items-center gap-2 mb-1">
                            <span class="inline-flex items-center justify-center w-5 h-5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" x2="12.01" y1="20" y2="20"/></svg>
                            </span>
                            <span class="text-xs font-medium text-gray-500">{t().remote.lanAddress}</span>
                          </div>
                          <p class="font-mono text-sm text-gray-700 dark:text-gray-300 truncate select-all">{getLanUrl()}</p>
                        </div>
                        <button
                          onClick={() => copyToClipboard(getLanUrl())}
                          class="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                        </button>
                      </div>

                      {/* Local Address */}
                      <div class="p-4 flex items-center justify-between group hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors">
                        <div class="min-w-0 flex-1 mr-4">
                          <div class="flex items-center gap-2 mb-1">
                            <span class="inline-flex items-center justify-center w-5 h-5 rounded bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-400">
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>
                            </span>
                            <span class="text-xs font-medium text-gray-500">{t().remote.localAddress}</span>
                          </div>
                          <p class="font-mono text-sm text-gray-700 dark:text-gray-300 truncate select-all">{getLocalUrl()}</p>
                        </div>
                        <button
                          onClick={() => copyToClipboard(getLocalUrl())}
                          class="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right Column: QR Code */}
                <div class="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-xs p-6 flex flex-col items-center justify-center min-h-[300px]">

                  <div class="w-full flex justify-center mb-6">
                    <div class="inline-flex bg-gray-100 dark:bg-zinc-800 p-1 rounded-lg">
                      <button
                        onClick={() => setActiveQrTab("lan")}
                        class={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeQrTab() === "lan" ? 'bg-white dark:bg-zinc-700 shadow-xs text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                      >
                        {t().remote.lan}
                      </button>
                      <button
                        disabled={tunnelInfo().status !== "running"}
                        onClick={() => setActiveQrTab("public")}
                        class={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeQrTab() === "public" ? 'bg-white dark:bg-zinc-700 shadow-xs text-green-700 dark:text-green-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'} ${tunnelInfo().status !== "running" ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        {t().remote.public}
                      </button>
                    </div>
                  </div>

                  <div class="bg-white p-4 rounded-xl shadow-xs border border-gray-100">
                    <Switch>
                      <Match when={activeQrTab() === "public" && tunnelInfo().status === "running"}>
                        <img
                          src={generateQRCode(tunnelInfo().url)}
                          alt="Public QR Code"
                          class="w-48 h-48 object-contain"
                        />
                      </Match>
                      <Match when={activeQrTab() === "public"}>
                        <div class="w-48 h-48 flex items-center justify-center bg-gray-50 text-gray-400 text-sm">
                          {t().remote.notConnected}
                        </div>
                      </Match>
                      <Match when={activeQrTab() === "lan"}>
                        <img
                          src={generateQRCode(getLanUrl())}
                          alt="LAN QR Code"
                          class="w-48 h-48 object-contain"
                        />
                      </Match>
                    </Switch>
                  </div>

                  <div class="mt-6 text-center space-y-2">
                    <h4 class="font-medium text-gray-900 dark:text-white">
                      {activeQrTab() === "public" ? t().remote.publicQrScan : t().remote.lanQrScan}
                    </h4>
                    <p class="text-xs text-gray-500 dark:text-gray-400 max-w-[200px]">
                      {activeQrTab() === "public" ? t().remote.publicQrDesc : t().remote.lanQrDesc}
                    </p>
                  </div>
                </div>
              </div>

              {/* Authorized Devices Card */}
              <div
                onClick={() => navigate("/devices")}
                class="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-xs p-5 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors"
              >
                <div class="flex items-center gap-4">
                  <div class="w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
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
                      <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
                      <path d="M12 18h.01" />
                    </svg>
                  </div>
                  <div>
                    <h3 class="text-base font-medium text-gray-900 dark:text-white">
                      {t().devices.title}
                    </h3>
                    <p class="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                      {t().remote.devicesDesc}
                    </p>
                  </div>
                </div>
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
                  class="text-gray-400"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </div>
            </div>
          </main>
        </div>

        {/* Bottom: Enter Chat Button (sticky) */}
        <div class="sticky bottom-0 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md border-t border-gray-200 dark:border-zinc-800 p-4">
          <div class="max-w-2xl mx-auto">
            <button
              onClick={handleEnterChat}
              disabled={enteringChat()}
              class="w-full py-3 px-6 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
            >
              <Show when={enteringChat()} fallback={
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                  </svg>
                  <span>{t().entry.enterChat}</span>
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m9 18 6-6-6-6"/>
                  </svg>
                </>
              }>
                <div class="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" />
                <span>{t().common.loading}</span>
              </Show>
            </button>
            <p class="text-xs text-gray-500 dark:text-gray-400 text-center mt-2">
              {t().entry.enterChatDesc}
            </p>
          </div>
        </div>
      </Show>
    </div>
  );
}
