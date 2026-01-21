import { createSignal, createEffect, Show, Switch, Match } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useI18n } from "../lib/i18n";
import { logger } from "../lib/logger";
import { Auth } from "../lib/auth";
import { useAuthGuard } from "../lib/useAuthGuard";

interface TunnelInfo {
  url: string;
  status: "starting" | "running" | "stopped" | "error";
  startTime?: number;
  error?: string;
}

export default function RemoteAccess() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [tunnelEnabled, setTunnelEnabled] = createSignal(false);
  const [tunnelInfo, setTunnelInfo] = createSignal<TunnelInfo>({
    url: "",
    status: "stopped",
  });
  const [loading, setLoading] = createSignal(false);
  const [localIp, setLocalIp] = createSignal("127.0.0.1");
  const [accessCode, setAccessCode] = createSignal("......");
  const [port, setPort] = createSignal(5174);
  
  // UI States
  const [showPassword, setShowPassword] = createSignal(false);
  const [activeQrTab, setActiveQrTab] = createSignal<"lan" | "public">("lan");

  useAuthGuard("RemoteAccess");

  // Load system info
  createEffect(() => {
    // Get system info
    fetch("/api/system/info")
      .then((res) => res.json())
      .then((data) => {
        if (data.localIp) setLocalIp(data.localIp);
        if (data.port) setPort(data.port);
      })
      .catch((err) => logger.error("[RemoteAccess] Failed to get system info:", err));

    // Get access code using Auth module (requires authentication)
    Auth.getAccessCode()
      .then((code) => {
        if (code) setAccessCode(code);
      })
      .catch((err) => logger.error("[RemoteAccess] Failed to get access code:", err));

    // Get tunnel status
    checkTunnelStatus();
  });

  // Automatically switch QR tab when tunnel status changes
  createEffect(() => {
    if (tunnelInfo().status === "running") {
      setActiveQrTab("public");
    } else {
      setActiveQrTab("lan");
    }
  });

  const checkTunnelStatus = async () => {
    try {
      const res = await fetch("/api/tunnel/status");
      const info = await res.json();
      setTunnelInfo(info);
      setTunnelEnabled(info.status === "running");
    } catch (error) {
      logger.error("[RemoteAccess] Failed to check tunnel status:", error);
    }
  };

  const handleTunnelToggle = () => tunnelEnabled() ? stopTunnel() : startTunnel();

  const startTunnel = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/tunnel/start", { method: "POST" });
      const info = await res.json();
      setTunnelInfo(info);
      setTunnelEnabled(true);

      // Start polling if status is starting
      if (info.status === "starting") {
        const pollInterval = setInterval(async () => {
          const statusRes = await fetch("/api/tunnel/status");
          const statusInfo = await statusRes.json();
          setTunnelInfo(statusInfo);

          // Stop polling if running or error
          if (statusInfo.status === "running" || statusInfo.status === "error") {
            clearInterval(pollInterval);
            setLoading(false);
          }
        }, 1000); // Check every second

        // Timeout after 30 seconds
        setTimeout(() => {
          clearInterval(pollInterval);
          setLoading(false);
        }, 30000);
      } else {
        setLoading(false);
      }
    } catch (error) {
      logger.error("[RemoteAccess] Failed to start tunnel:", error);
      setTunnelInfo({
        url: "",
        status: "error",
        error: t().remote.startFailed,
      });
      setLoading(false);
    }
  };

  const stopTunnel = async () => {
    setLoading(true);
    try {
      await fetch("/api/tunnel/stop", { method: "POST" });
      setTunnelInfo({ url: "", status: "stopped" });
      setTunnelEnabled(false);
    } catch (error) {
      logger.error("[RemoteAccess] Failed to stop tunnel:", error);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    // Optional: Add toast notification logic here
  };

  const generateQRCode = (url: string) => {
    return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
  };

  const handleBack = () => {
    navigate("/chat");
  };

  const getLanUrl = () => `http://${localIp()}:${port()}`;
  const getLocalUrl = () => `http://localhost:${port()}`;

  return (
    <div class="flex flex-col h-screen bg-gray-50/50 dark:bg-zinc-950 font-sans text-gray-900 dark:text-gray-100">
      {/* Header */}
      <header class="sticky top-0 z-10 backdrop-blur-md bg-white/70 dark:bg-zinc-900/70 border-b border-gray-200 dark:border-zinc-800 px-4 h-14 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <button
            onClick={handleBack}
            class="p-2 -ml-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-600 dark:text-gray-400 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m15 18-6-6 6-6"/>
            </svg>
          </button>
          <h1 class="font-semibold text-lg">{t().remote.title}</h1>
        </div>
        <div class="text-xs font-medium px-2 py-1 rounded bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-gray-400">
          OpenCode Remote
        </div>
      </header>

      {/* Main Content */}
      <main class="flex-1 overflow-y-auto p-4 md:p-6">
        <div class="max-w-2xl mx-auto space-y-6">
          
          {/* Status & Toggle Card */}
          <div class="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm overflow-hidden">
            <div class="p-5 flex items-center justify-between">
              <div class="space-y-1">
                <div class="flex items-center gap-2">
                  <h2 class="font-semibold text-base">{t().remote.publicAccess}</h2>
                  <Show when={loading() || tunnelInfo().status === "starting"}>
                    <span class="inline-flex h-2 w-2 rounded-full bg-yellow-400 animate-pulse"></span>
                  </Show>
                  <Show when={!loading() && tunnelInfo().status === "running"}>
                    <span class="inline-flex h-2 w-2 rounded-full bg-green-500"></span>
                  </Show>
                </div>
                <p class="text-sm text-gray-500 dark:text-gray-400">
                  {t().remote.publicAccessDesc}
                </p>
              </div>
              
              <button
                onClick={handleTunnelToggle}
                disabled={loading()}
                class={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                  tunnelEnabled() ? "bg-blue-600" : "bg-gray-200 dark:bg-zinc-700"
                } ${loading() ? "opacity-50 cursor-not-allowed" : ""}`}
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
              <div class="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm p-5">
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
              <div class="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm overflow-hidden">
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
            <div class="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm p-6 flex flex-col items-center justify-center min-h-[300px]">
              
              <div class="w-full flex justify-center mb-6">
                 <div class="inline-flex bg-gray-100 dark:bg-zinc-800 p-1 rounded-lg">
                    <button
                      onClick={() => setActiveQrTab("lan")}
                      class={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeQrTab() === "lan" ? 'bg-white dark:bg-zinc-700 shadow-sm text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                    >
                      {t().remote.lan}
                    </button>
                    <button
                      disabled={tunnelInfo().status !== "running"}
                      onClick={() => setActiveQrTab("public")}
                      class={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeQrTab() === "public" ? 'bg-white dark:bg-zinc-700 shadow-sm text-green-700 dark:text-green-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'} ${tunnelInfo().status !== "running" ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      {t().remote.public}
                    </button>
                 </div>
              </div>

              <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
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
            class="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm p-5 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors"
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
  );
}
