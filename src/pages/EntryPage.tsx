import { createSignal, onMount, onCleanup, Show, createEffect, Switch, Match } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Auth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { FeishuConfigModal } from "../components/FeishuConfigModal";
import { ChannelConfigModal } from "../components/ChannelConfigModal";
import { WeixinIlinkLoginModal } from "../components/WeixinIlinkLoginModal";
import { logger } from "../lib/logger";
import { WEB_PORT, WEB_STANDALONE_PORT } from "../../shared/ports";
import { isElectron } from "../lib/platform";
import { systemAPI, tunnelAPI, channelAPI, type ChannelInfo, type TunnelInfo, type TunnelConfig } from "../lib/electron-api";
import { getSetting, saveSetting, bootstrapHostSettings } from "../lib/settings";
import { refreshThemeFromSettings } from "../lib/theme";
import { refreshLocaleFromSettings } from "../lib/i18n";

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

  /** Fetch host settings and apply theme/locale before navigating to chat. */
  const applyHostSettingsIfNeeded = async () => {
    if (isElectron()) return;
    const applied = await bootstrapHostSettings();
    if (applied) {
      refreshThemeFromSettings();
      refreshLocaleFromSettings();
    }
  };

  // Local mode states (remote access config)
  const [tunnelEnabled, setTunnelEnabled] = createSignal(false);
  const [tunnelInfo, setTunnelInfo] = createSignal<TunnelInfo>({
    url: "",
    status: "stopped",
  });
  const [tunnelLoading, setTunnelLoading] = createSignal(false);

  // Named Tunnel config
  const savedTunnelConfig = getSetting<TunnelConfig>("tunnelConfig") || {};
  const [namedTunnelHostname, setNamedTunnelHostname] = createSignal(savedTunnelConfig.hostname || "");

  const isNamedTunnel = () => !!namedTunnelHostname().trim();
  const [localIp, setLocalIp] = createSignal("127.0.0.1");
  const [accessCode, setAccessCode] = createSignal("......");
  const [port, setPort] = createSignal(WEB_STANDALONE_PORT);
  const [showPassword, setShowPassword] = createSignal(false);
  const [activeQrTab, setActiveQrTab] = createSignal<"lan" | "public">("lan");
  const [enteringChat, setEnteringChat] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal<"webApp" | "channels" | "publicAccess">("channels");

  // Feishu channel states
  const [feishuStatus, setFeishuStatus] = createSignal<ChannelInfo | null>(null);
  const [feishuConfig, setFeishuConfig] = createSignal({
    platform: "feishu" as "feishu" | "lark",
    appId: "",
    appSecret: "",
    autoApprovePermissions: true,
    streamingThrottleMs: 1500,
  });
  const [feishuConfigOpen, setFeishuConfigOpen] = createSignal(false);
  const [feishuLoading, setFeishuLoading] = createSignal(false);

  // DingTalk channel states
  const [dingtalkStatus, setDingtalkStatus] = createSignal<ChannelInfo | null>(null);
  const [dingtalkConfig, setDingtalkConfig] = createSignal({
    appKey: "",
    appSecret: "",
    robotCode: "",
    autoApprovePermissions: true,
    streamingThrottleMs: 1500,
  });
  const [dingtalkConfigOpen, setDingtalkConfigOpen] = createSignal(false);
  const [dingtalkLoading, setDingtalkLoading] = createSignal(false);

  // Telegram channel states
  const [telegramStatus, setTelegramStatus] = createSignal<ChannelInfo | null>(null);
  const [telegramConfig, setTelegramConfig] = createSignal({
    botToken: "",
    webhookUrl: "",
    autoApprovePermissions: true,
    streamingThrottleMs: 1500,
  });
  const [telegramConfigOpen, setTelegramConfigOpen] = createSignal(false);
  const [telegramLoading, setTelegramLoading] = createSignal(false);

  // WeChat iLink channel states
  const [weixinIlinkStatus, setWeixinIlinkStatus] = createSignal<ChannelInfo | null>(null);
  const [weixinIlinkConfig, setWeixinIlinkConfig] = createSignal({
    botToken: "",
    accountId: "",
    baseUrl: "https://ilinkai.weixin.qq.com",
    autoApprovePermissions: true,
    streamingThrottleMs: 1500,
  });
  const [weixinIlinkLoginOpen, setWeixinIlinkLoginOpen] = createSignal(false);
  const [weixinIlinkLoading, setWeixinIlinkLoading] = createSignal(false);

  // WeCom channel states
  const [wecomStatus, setWecomStatus] = createSignal<ChannelInfo | null>(null);
  const [wecomConfig, setWecomConfig] = createSignal({
    corpId: "",
    corpSecret: "",
    agentId: 0,
    callbackToken: "",
    callbackEncodingAESKey: "",
    autoApprovePermissions: true,
  });
  const [wecomConfigOpen, setWecomConfigOpen] = createSignal(false);
  const [wecomLoading, setWecomLoading] = createSignal(false);

  // Teams channel states
  const [teamsStatus, setTeamsStatus] = createSignal<ChannelInfo | null>(null);
  const [teamsConfig, setTeamsConfig] = createSignal({
    microsoftAppId: "",
    microsoftAppPassword: "",
    tenantId: "",
    autoApprovePermissions: true,
    streamingThrottleMs: 1500,
  });
  const [teamsConfigOpen, setTeamsConfigOpen] = createSignal(false);
  const [teamsLoading, setTeamsLoading] = createSignal(false);

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
      await applyHostSettingsIfNeeded();
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

  // Listen for unexpected tunnel disconnects (cloudflared process crash)
  const unsubTunnel = tunnelAPI.onDisconnected(() => {
    logger.warn("[EntryPage] Tunnel disconnected unexpectedly");
    setTunnelInfo({ url: "", status: "stopped" });
    setTunnelEnabled(false);
    setTunnelLoading(false);
  });
  onCleanup(() => unsubTunnel?.());

  // Re-poll channel statuses after startup:ready so we pick up channels
  // that were auto-started by initFromConfig after the initial mount poll.
  const api = isElectron() ? window.electronAPI : null;
  if (api?.startup) {
    api.startup.onReady(() => {
      loadFeishuStatus();
      loadDingtalkStatus();
      loadTelegramStatus();
      loadWeixinIlinkStatus();
      loadWecomStatus();
      loadTeamsStatus();
    });
  }

  const loadLocalModeData = async () => {
    // Get system info - different sources for Electron vs Browser
    try {
      if (isElectron()) {
        // Electron: use IPC APIs for local IP
        const localIpResult = await systemAPI.getLocalIp();
        if (localIpResult) setLocalIp(localIpResult);

        // For port, use the current window's port in dev mode
        // In production (file:// protocol), use default port WEB_PORT
        const currentPort = window.location.port;
        if (currentPort) {
          setPort(parseInt(currentPort, 10));
        } else {
          // Production Electron: default to WEB_PORT
          setPort(WEB_PORT);
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

    // Load Feishu channel status and config
    loadFeishuStatus();
    loadDingtalkStatus();
    loadTelegramStatus();
    loadWeixinIlinkStatus();
    loadWecomStatus();
    loadTeamsStatus();
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
          await applyHostSettingsIfNeeded();
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
    saveNamedTunnelConfig();
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

  const saveNamedTunnelConfig = () => {
    const hostname = namedTunnelHostname().trim();
    if (hostname) {
      saveSetting("tunnelConfig", { hostname });
    } else {
      // Clear the config entirely when hostname is removed
      saveSetting("tunnelConfig", undefined);
    }
  };

  // =========================================================================
  // Feishu channel handlers
  // =========================================================================

  const loadFeishuStatus = async () => {
    try {
      const status = await channelAPI.getStatus("feishu");
      if (status) setFeishuStatus(status);

      const config = await channelAPI.getConfig("feishu");
      if (config?.options) {
        setFeishuConfig({
          platform: config.options.platform === "lark" ? "lark" : "feishu",
          appId: (config.options.appId as string) || "",
          appSecret: (config.options.appSecret as string) || "",
          autoApprovePermissions: config.options.autoApprovePermissions !== false,
          streamingThrottleMs: (config.options.streamingThrottleMs as number) || 1500,
        });
      }
    } catch (err) {
      logger.error("[EntryPage] Failed to load Feishu status:", err);
    }
  };

  const handleFeishuToggle = async () => {
    const currentStatus = feishuStatus();
    const isRunning = currentStatus?.status === "running" || currentStatus?.status === "starting";

    setFeishuLoading(true);
    try {
      if (isRunning) {
        await channelAPI.stop("feishu");
        setFeishuStatus({ type: "feishu", name: "feishu", status: "stopped" });
      } else {
        // Check if config is complete
        const cfg = feishuConfig();
        if (!cfg.appId || !cfg.appSecret) {
          setFeishuConfigOpen(true);
          setFeishuLoading(false);
          return;
        }
        await channelAPI.start("feishu");
        // Poll for status after a delay to let the adapter initialize
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const status = await channelAPI.getStatus("feishu");
        if (status) setFeishuStatus(status);
      }
    } catch (err) {
      logger.error("[EntryPage] Failed to toggle Feishu:", err);
      const status = await channelAPI.getStatus("feishu");
      if (status) setFeishuStatus(status);
    } finally {
      setFeishuLoading(false);
    }
  };

  const handleFeishuConfigSave = async (config: {
    platform: "feishu" | "lark";
    appId: string;
    appSecret: string;
    autoApprovePermissions: boolean;
    streamingThrottleMs: number;
  }) => {
    await channelAPI.updateConfig("feishu", { options: config });
    setFeishuConfig(config);

    // If not running, start it now
    const status = feishuStatus();
    if (status?.status !== "running") {
      try {
        await channelAPI.start("feishu");
        setTimeout(async () => {
          const newStatus = await channelAPI.getStatus("feishu");
          if (newStatus) setFeishuStatus(newStatus);
        }, 1500);
      } catch (err) {
        logger.error("[EntryPage] Failed to start Feishu after config save:", err);
        const newStatus = await channelAPI.getStatus("feishu");
        if (newStatus) setFeishuStatus(newStatus);
      }
    }
  };

  // =========================================================================
  // DingTalk channel handlers
  // =========================================================================

  const loadDingtalkStatus = async () => {
    try {
      const status = await channelAPI.getStatus("dingtalk");
      if (status) setDingtalkStatus(status);

      const config = await channelAPI.getConfig("dingtalk");
      if (config?.options) {
        setDingtalkConfig({
          appKey: (config.options.appKey as string) || "",
          appSecret: (config.options.appSecret as string) || "",
          robotCode: (config.options.robotCode as string) || "",
          autoApprovePermissions: config.options.autoApprovePermissions !== false,
          streamingThrottleMs: (config.options.streamingThrottleMs as number) || 1500,
        });
      }
    } catch (err) {
      logger.error("[EntryPage] Failed to load DingTalk status:", err);
    }
  };

  const handleDingtalkToggle = async () => {
    const currentStatus = dingtalkStatus();
    const isRunning = currentStatus?.status === "running" || currentStatus?.status === "starting";

    setDingtalkLoading(true);
    try {
      if (isRunning) {
        await channelAPI.stop("dingtalk");
        setDingtalkStatus({ type: "dingtalk", name: "dingtalk", status: "stopped" });
      } else {
        const cfg = dingtalkConfig();
        if (!cfg.appKey || !cfg.appSecret) {
          setDingtalkConfigOpen(true);
          setDingtalkLoading(false);
          return;
        }
        await channelAPI.start("dingtalk");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const status = await channelAPI.getStatus("dingtalk");
        if (status) setDingtalkStatus(status);
      }
    } catch (err) {
      logger.error("[EntryPage] Failed to toggle DingTalk:", err);
      const status = await channelAPI.getStatus("dingtalk");
      if (status) setDingtalkStatus(status);
    } finally {
      setDingtalkLoading(false);
    }
  };

  const handleDingtalkConfigSave = async (config: Record<string, unknown>) => {
    await channelAPI.updateConfig("dingtalk", { options: config });
    setDingtalkConfig(config as typeof dingtalkConfig extends () => infer R ? R : never);

    const status = dingtalkStatus();
    if (status?.status !== "running") {
      try {
        await channelAPI.start("dingtalk");
        setTimeout(async () => {
          const newStatus = await channelAPI.getStatus("dingtalk");
          if (newStatus) setDingtalkStatus(newStatus);
        }, 1500);
      } catch (err) {
        logger.error("[EntryPage] Failed to start DingTalk after config save:", err);
        const newStatus = await channelAPI.getStatus("dingtalk");
        if (newStatus) setDingtalkStatus(newStatus);
      }
    }
  };

  // =========================================================================
  // Telegram channel handlers
  // =========================================================================

  const loadTelegramStatus = async () => {
    try {
      const status = await channelAPI.getStatus("telegram");
      if (status) setTelegramStatus(status);

      const config = await channelAPI.getConfig("telegram");
      if (config?.options) {
        setTelegramConfig({
          botToken: (config.options.botToken as string) || "",
          webhookUrl: (config.options.webhookUrl as string) || "",
          autoApprovePermissions: config.options.autoApprovePermissions !== false,
          streamingThrottleMs: (config.options.streamingThrottleMs as number) || 1500,
        });
      }
    } catch (err) {
      logger.error("[EntryPage] Failed to load Telegram status:", err);
    }
  };

  const handleTelegramToggle = async () => {
    const currentStatus = telegramStatus();
    const isRunning = currentStatus?.status === "running" || currentStatus?.status === "starting";

    setTelegramLoading(true);
    try {
      if (isRunning) {
        await channelAPI.stop("telegram");
        setTelegramStatus({ type: "telegram", name: "telegram", status: "stopped" });
      } else {
        const cfg = telegramConfig();
        if (!cfg.botToken) {
          setTelegramConfigOpen(true);
          setTelegramLoading(false);
          return;
        }
        await channelAPI.start("telegram");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const status = await channelAPI.getStatus("telegram");
        if (status) setTelegramStatus(status);
      }
    } catch (err) {
      logger.error("[EntryPage] Failed to toggle Telegram:", err);
      const status = await channelAPI.getStatus("telegram");
      if (status) setTelegramStatus(status);
    } finally {
      setTelegramLoading(false);
    }
  };

  const handleTelegramConfigSave = async (config: Record<string, unknown>) => {
    await channelAPI.updateConfig("telegram", { options: config });
    setTelegramConfig(config as typeof telegramConfig extends () => infer R ? R : never);

    const status = telegramStatus();
    if (status?.status !== "running") {
      try {
        await channelAPI.start("telegram");
        setTimeout(async () => {
          const newStatus = await channelAPI.getStatus("telegram");
          if (newStatus) setTelegramStatus(newStatus);
        }, 1500);
      } catch (err) {
        logger.error("[EntryPage] Failed to start Telegram after config save:", err);
        const newStatus = await channelAPI.getStatus("telegram");
        if (newStatus) setTelegramStatus(newStatus);
      }
    }
  };

  // =========================================================================
  // WeChat iLink channel handlers
  // =========================================================================

  const loadWeixinIlinkStatus = async () => {
    try {
      const status = await channelAPI.getStatus("weixin-ilink");
      if (status) setWeixinIlinkStatus(status);

      const config = await channelAPI.getConfig("weixin-ilink");
      if (config?.options) {
        setWeixinIlinkConfig({
          botToken: (config.options.botToken as string) || "",
          accountId: (config.options.accountId as string) || "",
          baseUrl: (config.options.baseUrl as string) || "https://ilinkai.weixin.qq.com",
          autoApprovePermissions: config.options.autoApprovePermissions !== false,
          streamingThrottleMs: (config.options.streamingThrottleMs as number) || 1500,
        });
      }
    } catch (err) {
      logger.error("[EntryPage] Failed to load WeChat iLink status:", err);
    }
  };

  const handleWeixinIlinkToggle = async () => {
    const currentStatus = weixinIlinkStatus();
    const isRunning = currentStatus?.status === "running" || currentStatus?.status === "starting";

    setWeixinIlinkLoading(true);
    try {
      if (isRunning) {
        await channelAPI.stop("weixin-ilink");
        setWeixinIlinkStatus({ type: "weixin-ilink", name: "WeChat iLink", status: "stopped" });
      } else {
        const cfg = weixinIlinkConfig();
        if (!cfg.botToken || !cfg.accountId) {
          setWeixinIlinkLoginOpen(true);
          setWeixinIlinkLoading(false);
          return;
        }
        await channelAPI.start("weixin-ilink");
        setTimeout(async () => {
          const status = await channelAPI.getStatus("weixin-ilink");
          if (status) setWeixinIlinkStatus(status);
        }, 1500);
      }
    } catch (err) {
      logger.error("[EntryPage] Failed to toggle WeChat iLink:", err);
      const status = await channelAPI.getStatus("weixin-ilink");
      if (status) setWeixinIlinkStatus(status);
    } finally {
      setWeixinIlinkLoading(false);
    }
  };

  const handleWeixinIlinkLoginSuccess = async (loginData: {
    botToken: string;
    accountId: string;
    baseUrl?: string;
  }) => {
    const config = {
      botToken: loginData.botToken,
      accountId: loginData.accountId,
      baseUrl: loginData.baseUrl || "https://ilinkai.weixin.qq.com",
      autoApprovePermissions: weixinIlinkConfig().autoApprovePermissions,
      streamingThrottleMs: weixinIlinkConfig().streamingThrottleMs,
    };

    await channelAPI.updateConfig("weixin-ilink", { options: config });
    setWeixinIlinkConfig(config);

    const status = weixinIlinkStatus();
    if (status?.status !== "running") {
      try {
        await channelAPI.start("weixin-ilink");
        setTimeout(async () => {
          const newStatus = await channelAPI.getStatus("weixin-ilink");
          if (newStatus) setWeixinIlinkStatus(newStatus);
        }, 1500);
      } catch (err) {
        logger.error("[EntryPage] Failed to start WeChat iLink after login:", err);
        const newStatus = await channelAPI.getStatus("weixin-ilink");
        if (newStatus) setWeixinIlinkStatus(newStatus);
      }
    }
  };

  // =========================================================================
  // WeCom channel handlers
  // =========================================================================

  const loadWecomStatus = async () => {
    try {
      const status = await channelAPI.getStatus("wecom");
      if (status) setWecomStatus(status);

      const config = await channelAPI.getConfig("wecom");
      if (config?.options) {
        setWecomConfig({
          corpId: (config.options.corpId as string) || "",
          corpSecret: (config.options.corpSecret as string) || "",
          agentId: (config.options.agentId as number) || 0,
          callbackToken: (config.options.callbackToken as string) || "",
          callbackEncodingAESKey: (config.options.callbackEncodingAESKey as string) || "",
          autoApprovePermissions: config.options.autoApprovePermissions !== false,
        });
      }
    } catch (err) {
      logger.error("[EntryPage] Failed to load WeCom status:", err);
    }
  };

  const handleWecomToggle = async () => {
    const currentStatus = wecomStatus();
    const isRunning = currentStatus?.status === "running" || currentStatus?.status === "starting";

    setWecomLoading(true);
    try {
      if (isRunning) {
        await channelAPI.stop("wecom");
        setWecomStatus({ type: "wecom", name: "wecom", status: "stopped" });
      } else {
        const cfg = wecomConfig();
        if (!cfg.corpId || !cfg.corpSecret || !cfg.agentId || !cfg.callbackToken || !cfg.callbackEncodingAESKey) {
          setWecomConfigOpen(true);
          setWecomLoading(false);
          return;
        }
        await channelAPI.start("wecom");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const status = await channelAPI.getStatus("wecom");
        if (status) setWecomStatus(status);
      }
    } catch (err) {
      logger.error("[EntryPage] Failed to toggle WeCom:", err);
      const status = await channelAPI.getStatus("wecom");
      if (status) setWecomStatus(status);
    } finally {
      setWecomLoading(false);
    }
  };

  const handleWecomConfigSave = async (config: Record<string, unknown>) => {
    await channelAPI.updateConfig("wecom", { options: config });
    setWecomConfig(config as typeof wecomConfig extends () => infer R ? R : never);

    const status = wecomStatus();
    if (status?.status !== "running") {
      try {
        await channelAPI.start("wecom");
        setTimeout(async () => {
          const newStatus = await channelAPI.getStatus("wecom");
          if (newStatus) setWecomStatus(newStatus);
        }, 1500);
      } catch (err) {
        logger.error("[EntryPage] Failed to start WeCom after config save:", err);
        const newStatus = await channelAPI.getStatus("wecom");
        if (newStatus) setWecomStatus(newStatus);
      }
    }
  };

  // =========================================================================
  // Teams channel handlers
  // =========================================================================

  const loadTeamsStatus = async () => {
    try {
      const status = await channelAPI.getStatus("teams");
      if (status) setTeamsStatus(status);

      const config = await channelAPI.getConfig("teams");
      if (config?.options) {
        setTeamsConfig({
          microsoftAppId: (config.options.microsoftAppId as string) || "",
          microsoftAppPassword: (config.options.microsoftAppPassword as string) || "",
          tenantId: (config.options.tenantId as string) || "",
          autoApprovePermissions: config.options.autoApprovePermissions !== false,
          streamingThrottleMs: (config.options.streamingThrottleMs as number) || 1500,
        });
      }
    } catch (err) {
      logger.error("[EntryPage] Failed to load Teams status:", err);
    }
  };

  const handleTeamsToggle = async () => {
    const currentStatus = teamsStatus();
    const isRunning = currentStatus?.status === "running" || currentStatus?.status === "starting";

    setTeamsLoading(true);
    try {
      if (isRunning) {
        await channelAPI.stop("teams");
        setTeamsStatus({ type: "teams", name: "teams", status: "stopped" });
      } else {
        const cfg = teamsConfig();
        if (!cfg.microsoftAppId || !cfg.microsoftAppPassword) {
          setTeamsConfigOpen(true);
          setTeamsLoading(false);
          return;
        }
        await channelAPI.start("teams");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const status = await channelAPI.getStatus("teams");
        if (status) setTeamsStatus(status);
      }
    } catch (err) {
      logger.error("[EntryPage] Failed to toggle Teams:", err);
      const status = await channelAPI.getStatus("teams");
      if (status) setTeamsStatus(status);
    } finally {
      setTeamsLoading(false);
    }
  };

  const handleTeamsConfigSave = async (config: Record<string, unknown>) => {
    await channelAPI.updateConfig("teams", { options: config });
    setTeamsConfig(config as typeof teamsConfig extends () => infer R ? R : never);

    const status = teamsStatus();
    if (status?.status !== "running") {
      try {
        await channelAPI.start("teams");
        setTimeout(async () => {
          const newStatus = await channelAPI.getStatus("teams");
          if (newStatus) setTeamsStatus(newStatus);
        }, 1500);
      } catch (err) {
        logger.error("[EntryPage] Failed to start Teams after config save:", err);
        const newStatus = await channelAPI.getStatus("teams");
        if (newStatus) setTeamsStatus(newStatus);
      }
    }
  };

  const handleEnterChat = async () => {
    setEnteringChat(true);
    try {
      // Token should already be set from loadLocalModeData
      if (Auth.isAuthenticated()) {
        await applyHostSettingsIfNeeded();
        navigate("/chat", { replace: true });
      } else {
        // Fallback: try to auth again
        const result = await Auth.localAuth();
        if (result.success) {
          await applyHostSettingsIfNeeded();
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
    <div class="flex flex-col h-screen overflow-hidden bg-gray-50/50 dark:bg-slate-950 font-sans text-gray-900 dark:text-gray-100">
      {/* Unified Titlebar */}
      <div
        class="w-full flex-shrink-0 flex items-center px-2 border-b border-gray-200 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-950 electron-drag-region electron-titlebar-pad-left electron-titlebar-pad-right"
        style={{ height: "var(--electron-title-bar-height, 40px)", "min-height": "var(--electron-title-bar-height, 40px)" }}
      >
        <div class="flex items-center gap-1.5 electron-no-drag flex-shrink-0 titlebar-brand">
          <img src={`${import.meta.env.BASE_URL}assets/logo.png`} alt="CodeMux" class="w-5 h-5 rounded" />
          <span class="hidden sm:inline text-[11px] font-semibold tracking-wide text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-slate-800 px-2 py-0.5 rounded-md border border-gray-200 dark:border-slate-700 select-none">CodeMux</span>
        </div>
        <div class="flex-1" />
        <div class="electron-no-drag">
          <LanguageSwitcher />
        </div>
      </div>

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
          <div class="w-full max-w-md p-8 bg-white dark:bg-slate-800 rounded-lg shadow-md transition-all duration-300">
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
                    
                    <div class="bg-gray-50 dark:bg-slate-700/50 rounded-lg p-4 text-left text-sm space-y-2">
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
                      class="w-full mt-4 py-2 px-4 border border-gray-300 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-700 text-gray-700 dark:text-gray-300 font-medium rounded-md transition-colors"
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
                      class="w-full py-2 px-4 bg-gray-200 dark:bg-slate-700 hover:bg-gray-300 dark:hover:bg-slate-600 text-gray-800 dark:text-white font-medium rounded-md transition-colors"
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
                    class="w-full px-4 py-2 border rounded-md focus:ring-2 focus:ring-blue-500 focus:outline-none dark:bg-slate-700 dark:border-slate-600 dark:text-white text-center text-lg tracking-widest font-mono"
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

          {/* Main Content */}
          <main class="p-4 md:p-6">
            <div class="max-w-4xl mx-auto space-y-6">

              {/* Local Mode Banner */}
              <div class="rounded-xl bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 p-4 flex gap-3">
                <svg xmlns="http://www.w3.org/2000/svg" class="shrink-0 text-blue-600 dark:text-blue-400 mt-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>
                <div class="text-sm text-blue-800 dark:text-blue-200">
                  <span class="font-medium">{t().entry.localModeTitle}</span> {t().entry.localModeDesc}
                </div>
              </div>

              {/* Vertical Tab Layout (horizontal on mobile) */}
              <div class="flex flex-col md:flex-row gap-0 bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-800 shadow-xs overflow-hidden md:min-h-[520px]">
                {/* Left: Tab Navigation (top on mobile) */}
                <nav class="w-full md:w-auto md:min-w-44 md:max-w-56 shrink-0 border-b md:border-b-0 md:border-r border-gray-200 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-950/50 p-2 md:p-3 flex md:flex-col gap-1 overflow-x-auto">
                  <Show when={isElectron()}>
                    <button
                      onClick={() => setActiveTab("channels")}
                      class={`flex items-center gap-2 md:gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all text-left whitespace-nowrap ${
                        activeTab() === "channels"
                          ? "bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-xs"
                          : "text-gray-600 dark:text-gray-400 hover:bg-white/60 dark:hover:bg-slate-800/60 hover:text-gray-900 dark:hover:text-gray-200"
                      }`}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                      <span class="hidden md:inline">{t().channel.channels}</span>
                    </button>
                  </Show>
                  <button
                    onClick={() => setActiveTab("webApp")}
                    class={`flex items-center gap-2 md:gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all text-left whitespace-nowrap ${
                      activeTab() === "webApp"
                        ? "bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-xs"
                        : "text-gray-600 dark:text-gray-400 hover:bg-white/60 dark:hover:bg-slate-800/60 hover:text-gray-900 dark:hover:text-gray-200"
                    }`}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
                    <span class="hidden md:inline">{t().remote.webApp}</span>
                  </button>
                  <Show when={isElectron()}>
                    <button
                      onClick={() => setActiveTab("publicAccess")}
                      class={`flex items-center gap-2 md:gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all text-left relative whitespace-nowrap ${
                        activeTab() === "publicAccess"
                          ? "bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-xs"
                          : "text-gray-600 dark:text-gray-400 hover:bg-white/60 dark:hover:bg-slate-800/60 hover:text-gray-900 dark:hover:text-gray-200"
                      }`}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
                      <span class="hidden md:inline">{t().remote.publicAccessTab}</span>
                      <Show when={tunnelInfo().status === "running"}>
                        <span class="absolute right-2.5 top-1/2 -translate-y-1/2 inline-flex h-1.5 w-1.5 rounded-full bg-green-500"></span>
                      </Show>
                      <Show when={tunnelInfo().status === "starting"}>
                        <span class="absolute right-2.5 top-1/2 -translate-y-1/2 inline-flex h-1.5 w-1.5 rounded-full bg-yellow-400 animate-pulse"></span>
                      </Show>
                    </button>
                  </Show>
                </nav>

                {/* Right: Tab Content (bottom on mobile) */}
                <div class="flex-1 p-3 md:p-5 overflow-y-auto">
                  {/* Web App Tab */}
                  <Show when={activeTab() === "webApp"}>
                    <div class="space-y-5">
                      {/* Warning Banner */}
                      <div class="rounded-lg bg-orange-50 dark:bg-orange-900/10 border border-orange-100 dark:border-orange-900/30 p-3 flex gap-3">
                        <svg xmlns="http://www.w3.org/2000/svg" class="shrink-0 text-orange-600 dark:text-orange-400 mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
                        <div class="text-xs text-orange-800 dark:text-orange-200">
                          <span class="font-medium">{t().remote.securityWarning}</span> {t().remote.securityWarningDesc}
                        </div>
                      </div>

                      <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
                        {/* Left Column: Info */}
                        <div class="space-y-5">

                          {/* Access Code Card */}
                          <div class="rounded-lg border border-gray-200 dark:border-slate-800 p-4">
                            <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3 flex items-center gap-2">
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                              {t().remote.accessPassword}
                            </h3>
                            <div class="flex items-center justify-between bg-gray-50 dark:bg-slate-950 rounded-lg border border-gray-200 dark:border-slate-800 px-4 py-3">
                              <span class="font-mono text-xl font-bold tracking-widest text-gray-900 dark:text-white">
                                {showPassword() ? accessCode() : "••••••"}
                              </span>
                              <div class="flex items-center gap-2">
                                <button
                                  onClick={() => setShowPassword(!showPassword())}
                                  class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors rounded-md hover:bg-gray-200 dark:hover:bg-slate-800"
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
                          <div class="rounded-lg border border-gray-200 dark:border-slate-800 overflow-hidden">
                            <div class="p-3 border-b border-gray-100 dark:border-slate-800/50">
                              <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">{t().remote.connectionAddress}</h3>
                            </div>
                            <div class="divide-y divide-gray-100 dark:divide-slate-800/50">

                              {/* Public Address */}
                              <Show when={tunnelInfo().status === "running"}>
                                <div class="p-3 flex items-center justify-between group hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors">
                                  <div class="min-w-0 flex-1 mr-3">
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
                              <div class="p-3 flex items-center justify-between group hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors">
                                <div class="min-w-0 flex-1 mr-3">
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
                              <div class="p-3 flex items-center justify-between group hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors">
                                <div class="min-w-0 flex-1 mr-3">
                                  <div class="flex items-center gap-2 mb-1">
                                    <span class="inline-flex items-center justify-center w-5 h-5 rounded bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-gray-400">
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
                        <div class="rounded-lg border border-gray-200 dark:border-slate-800 p-5 flex flex-col items-center justify-center min-h-[280px]">

                          <div class="w-full flex justify-center mb-5">
                            <div class="inline-flex bg-gray-100 dark:bg-slate-800 p-1 rounded-lg">
                              <button
                                onClick={() => setActiveQrTab("lan")}
                                class={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeQrTab() === "lan" ? 'bg-white dark:bg-slate-700 shadow-xs text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                              >
                                {t().remote.lan}
                              </button>
                              <button
                                disabled={tunnelInfo().status !== "running"}
                                onClick={() => setActiveQrTab("public")}
                                class={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeQrTab() === "public" ? 'bg-white dark:bg-slate-700 shadow-xs text-green-700 dark:text-green-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'} ${tunnelInfo().status !== "running" ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                                  class="w-44 h-44 object-contain"
                                />
                              </Match>
                              <Match when={activeQrTab() === "public"}>
                                <div class="w-44 h-44 flex items-center justify-center bg-gray-50 text-gray-400 text-sm">
                                  {t().remote.notConnected}
                                </div>
                              </Match>
                              <Match when={activeQrTab() === "lan"}>
                                <img
                                  src={generateQRCode(getLanUrl())}
                                  alt="LAN QR Code"
                                  class="w-44 h-44 object-contain"
                                />
                              </Match>
                            </Switch>
                          </div>

                          <div class="mt-4 text-center space-y-1">
                            <h4 class="font-medium text-sm text-gray-900 dark:text-white">
                              {activeQrTab() === "public" ? t().remote.publicQrScan : t().remote.lanQrScan}
                            </h4>
                            <p class="text-xs text-gray-500 dark:text-gray-400 max-w-[200px]">
                              {activeQrTab() === "public" ? t().remote.publicQrDesc : t().remote.lanQrDesc}
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Public Access Link Banner */}
                      <Show when={isElectron()}>
                        <div
                          onClick={() => setActiveTab("publicAccess")}
                          class="rounded-lg border border-gray-200 dark:border-slate-800 p-4 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors"
                        >
                          <div class="flex items-center gap-3">
                            <div class={`w-9 h-9 rounded-lg flex items-center justify-center ${
                              tunnelInfo().status === "running"
                                ? "bg-green-100 dark:bg-green-900/30"
                                : "bg-gray-100 dark:bg-slate-800"
                            }`}>
                              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={tunnelInfo().status === "running" ? "text-green-600 dark:text-green-400" : "text-gray-400 dark:text-gray-500"}>
                                <circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>
                              </svg>
                            </div>
                            <div>
                              <h3 class="text-sm font-medium text-gray-900 dark:text-white">
                                {t().remote.publicAccessTab}
                              </h3>
                              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 flex items-center gap-1.5">
                                <Show when={tunnelInfo().status === "running"}>
                                  <span class="inline-flex h-1.5 w-1.5 rounded-full bg-green-500"></span>
                                  {t().remote.publicAccessEnabled}
                                </Show>
                                <Show when={tunnelInfo().status !== "running"}>
                                  {t().remote.publicAccessDisabled}
                                </Show>
                              </p>
                            </div>
                          </div>
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-gray-400">
                            <path d="m9 18 6-6-6-6"/>
                          </svg>
                        </div>
                      </Show>

                      {/* Authorized Devices Card */}
                      <div
                        onClick={() => navigate("/devices")}
                        class="rounded-lg border border-gray-200 dark:border-slate-800 p-4 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors"
                      >
                        <div class="flex items-center gap-3">
                          <div class="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
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
                              class="text-blue-600 dark:text-blue-400"
                            >
                              <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
                              <path d="M12 18h.01" />
                            </svg>
                          </div>
                          <div>
                            <h3 class="text-sm font-medium text-gray-900 dark:text-white">
                              {t().devices.title}
                            </h3>
                            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                              {t().remote.devicesDesc}
                            </p>
                          </div>
                        </div>
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
                          class="text-gray-400"
                        >
                          <path d="m9 18 6-6-6-6" />
                        </svg>
                      </div>
                    </div>
                  </Show>

                  {/* Channels Tab */}
                  <Show when={activeTab() === "channels"}>
                    <div class="space-y-5">
                      {/* Direct Connect Group */}
                      <div>
                        <div class="flex items-center gap-2 mb-3">
                          <h3 class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">{t().channel.directConnect}</h3>
                          <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400">{t().channel.directConnectBadge}</span>
                          <div class="flex-1 h-px bg-gray-100 dark:bg-slate-800"></div>
                        </div>
                        <div class="space-y-3">
                          {/* Feishu Bot Row */}
                          <div class="rounded-lg border border-gray-200 dark:border-slate-800 overflow-hidden">
                            <div class="p-4 flex items-center justify-between">
                              <div class="flex items-center gap-3">
                                <div class="w-9 h-9 rounded-lg bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-indigo-600 dark:text-indigo-400"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                                </div>
                                <div>
                                  <div class="flex items-center gap-2">
                                    <h3 class="text-sm font-medium text-gray-900 dark:text-white">
                                      {t().channel.feishuBot}
                                    </h3>
                                    <Show when={feishuLoading() || feishuStatus()?.status === "starting"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-yellow-400 animate-pulse"></span>
                                    </Show>
                                    <Show when={!feishuLoading() && feishuStatus()?.status === "running"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-green-500"></span>
                                    </Show>
                                    <Show when={!feishuLoading() && feishuStatus()?.status === "error"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-red-500"></span>
                                    </Show>
                                  </div>
                                  <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                    {t().channel.feishuBotDesc}
                                  </p>
                                </div>
                              </div>

                              <div class="flex items-center gap-3">
                                <button
                                  onClick={() => setFeishuConfigOpen(true)}
                                  class="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors border border-gray-200 dark:border-slate-700"
                                >
                                  {t().channel.configure}
                                </button>
                                <button
                                  onClick={handleFeishuToggle}
                                  disabled={feishuLoading()}
                                  class={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                                    feishuStatus()?.status === "running" ? "bg-blue-600" : "bg-gray-200 dark:bg-slate-700"
                                  } ${feishuLoading() ? "opacity-50 cursor-not-allowed" : ""}`}
                                >
                                  <span class="sr-only">Toggle Feishu Bot</span>
                                  <span
                                    class={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                      feishuStatus()?.status === "running" ? "translate-x-5" : "translate-x-0"
                                    }`}
                                  />
                                </button>
                              </div>
                            </div>

                            <Show when={feishuStatus()?.status === "error" && feishuStatus()?.error}>
                              <div class="px-4 py-3 bg-red-50 dark:bg-red-900/10 border-t border-red-100 dark:border-red-900/30">
                                <p class="text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
                                  {feishuStatus()?.error}
                                </p>
                              </div>
                            </Show>
                          </div>

                          {/* DingTalk Bot Row */}
                          <div class="rounded-lg border border-gray-200 dark:border-slate-800 overflow-hidden">
                            <div class="p-4 flex items-center justify-between">
                              <div class="flex items-center gap-3">
                                <div class="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-blue-600 dark:text-blue-400"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>
                                </div>
                                <div>
                                  <div class="flex items-center gap-2">
                                    <h3 class="text-sm font-medium text-gray-900 dark:text-white">
                                      {t().channel.dingtalkBot}
                                    </h3>
                                    <Show when={dingtalkLoading() || dingtalkStatus()?.status === "starting"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-yellow-400 animate-pulse"></span>
                                    </Show>
                                    <Show when={!dingtalkLoading() && dingtalkStatus()?.status === "running"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-green-500"></span>
                                    </Show>
                                    <Show when={!dingtalkLoading() && dingtalkStatus()?.status === "error"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-red-500"></span>
                                    </Show>
                                  </div>
                                  <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                    {t().channel.dingtalkBotDesc}
                                  </p>
                                </div>
                              </div>

                              <div class="flex items-center gap-3">
                                <button
                                  onClick={() => setDingtalkConfigOpen(true)}
                                  class="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors border border-gray-200 dark:border-slate-700"
                                >
                                  {t().channel.configure}
                                </button>
                                <button
                                  onClick={handleDingtalkToggle}
                                  disabled={dingtalkLoading()}
                                  class={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                                    dingtalkStatus()?.status === "running" ? "bg-blue-600" : "bg-gray-200 dark:bg-slate-700"
                                  } ${dingtalkLoading() ? "opacity-50 cursor-not-allowed" : ""}`}
                                >
                                  <span class="sr-only">Toggle DingTalk Bot</span>
                                  <span
                                    class={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                      dingtalkStatus()?.status === "running" ? "translate-x-5" : "translate-x-0"
                                    }`}
                                  />
                                </button>
                              </div>
                            </div>

                            <Show when={dingtalkStatus()?.status === "error" && dingtalkStatus()?.error}>
                              <div class="px-4 py-3 bg-red-50 dark:bg-red-900/10 border-t border-red-100 dark:border-red-900/30">
                                <p class="text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
                                  {dingtalkStatus()?.error}
                                </p>
                              </div>
                            </Show>
                          </div>

                          {/* Telegram Bot Row */}
                          <div class="rounded-lg border border-gray-200 dark:border-slate-800 overflow-hidden">
                            <div class="p-4 flex items-center justify-between">
                              <div class="flex items-center gap-3">
                                <div class="w-9 h-9 rounded-lg bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-sky-600 dark:text-sky-400"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
                                </div>
                                <div>
                                  <div class="flex items-center gap-2">
                                    <h3 class="text-sm font-medium text-gray-900 dark:text-white">
                                      {t().channel.telegramBot}
                                    </h3>
                                    <Show when={telegramLoading() || telegramStatus()?.status === "starting"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-yellow-400 animate-pulse"></span>
                                    </Show>
                                    <Show when={!telegramLoading() && telegramStatus()?.status === "running"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-green-500"></span>
                                    </Show>
                                    <Show when={!telegramLoading() && telegramStatus()?.status === "error"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-red-500"></span>
                                    </Show>
                                  </div>
                                  <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                    {t().channel.telegramBotDesc}
                                  </p>
                                </div>
                              </div>

                              <div class="flex items-center gap-3">
                                <button
                                  onClick={() => setTelegramConfigOpen(true)}
                                  class="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors border border-gray-200 dark:border-slate-700"
                                >
                                  {t().channel.configure}
                                </button>
                                <button
                                  onClick={handleTelegramToggle}
                                  disabled={telegramLoading()}
                                  class={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                                    telegramStatus()?.status === "running" ? "bg-blue-600" : "bg-gray-200 dark:bg-slate-700"
                                  } ${telegramLoading() ? "opacity-50 cursor-not-allowed" : ""}`}
                                >
                                  <span class="sr-only">Toggle Telegram Bot</span>
                                  <span
                                    class={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                      telegramStatus()?.status === "running" ? "translate-x-5" : "translate-x-0"
                                    }`}
                                  />
                                </button>
                              </div>
                            </div>

                            <Show when={telegramStatus()?.status === "error" && telegramStatus()?.error}>
                              <div class="px-4 py-3 bg-red-50 dark:bg-red-900/10 border-t border-red-100 dark:border-red-900/30">
                                <p class="text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
                                  {telegramStatus()?.error}
                                </p>
                              </div>
                            </Show>
                          </div>

                          {/* WeChat iLink Bot Row */}
                          <div class="rounded-lg border border-gray-200 dark:border-slate-800 overflow-hidden">
                            <div class="p-4 flex items-center justify-between">
                              <div class="flex items-center gap-3">
                                <div class="w-9 h-9 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" class="text-green-600 dark:text-green-400">
                                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                                  </svg>
                                </div>
                                <div>
                                  <div class="flex items-center gap-2">
                                    <h3 class="text-sm font-medium text-gray-900 dark:text-white">
                                      {t().channel.weixinIlinkBot}
                                    </h3>
                                    <Show when={weixinIlinkLoading() || weixinIlinkStatus()?.status === "starting"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-yellow-400 animate-pulse"></span>
                                    </Show>
                                    <Show when={!weixinIlinkLoading() && weixinIlinkStatus()?.status === "running"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-green-500"></span>
                                    </Show>
                                    <Show when={!weixinIlinkLoading() && weixinIlinkStatus()?.status === "error"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-red-500"></span>
                                    </Show>
                                  </div>
                                  <p class="text-xs text-gray-500 dark:text-gray-400">
                                    {t().channel.weixinIlinkBotDesc}
                                  </p>
                                </div>
                              </div>
                              <div class="flex items-center gap-2">
                                <button
                                  onClick={() => setWeixinIlinkLoginOpen(true)}
                                  class="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors border border-gray-200 dark:border-slate-700"
                                >
                                  {t().channel.login}
                                </button>
                                <button
                                  onClick={handleWeixinIlinkToggle}
                                  disabled={weixinIlinkLoading()}
                                  class={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                                    weixinIlinkStatus()?.status === "running" ? "bg-blue-600" : "bg-gray-200 dark:bg-slate-700"
                                  } ${weixinIlinkLoading() ? "opacity-50 cursor-not-allowed" : ""}`}
                                >
                                  <span class="sr-only">Toggle WeChat iLink Bot</span>
                                  <span
                                    class={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                      weixinIlinkStatus()?.status === "running" ? "translate-x-5" : "translate-x-0"
                                    }`}
                                  />
                                </button>
                              </div>
                            </div>
                            {/* Error message display */}
                            <Show when={weixinIlinkStatus()?.status === "error" && weixinIlinkStatus()?.error}>
                              <div class="px-4 py-3 bg-red-50 dark:bg-red-900/10 border-t border-red-100 dark:border-red-900/30">
                                <p class="text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
                                  {weixinIlinkStatus()?.error}
                                </p>
                              </div>
                            </Show>
                          </div>
                        </div>
                      </div>

                      {/* Webhook Group */}
                      <div>
                        <div class="flex items-center gap-2 mb-3">
                          <h3 class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">{t().channel.webhookConnect}</h3>
                          <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">{t().channel.webhookConnectBadge}</span>
                          <div class="flex-1 h-px bg-gray-100 dark:bg-slate-800"></div>
                        </div>

                        {/* Tunnel required banner when tunnel is not running */}
                        <Show when={tunnelInfo().status !== "running"}>
                          <div
                            onClick={() => setActiveTab("publicAccess")}
                            class="rounded-lg border border-amber-200 dark:border-amber-900/30 bg-amber-50 dark:bg-amber-900/10 p-3 flex items-center justify-between cursor-pointer hover:bg-amber-100 dark:hover:bg-amber-900/20 transition-colors mb-3"
                          >
                            <div class="flex items-center gap-2.5">
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-600 dark:text-amber-400 shrink-0"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
                              <div>
                                <span class="text-xs font-medium text-amber-700 dark:text-amber-400">{t().channel.tunnelRequired}</span>
                                <span class="text-xs text-amber-600 dark:text-amber-400/70 ml-1">— {t().channel.tunnelRequiredDesc}</span>
                              </div>
                            </div>
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-400 shrink-0"><path d="m9 18 6-6-6-6"/></svg>
                          </div>
                        </Show>

                        <div class={`space-y-3 ${tunnelInfo().status !== "running" ? "opacity-55" : ""}`}>
                          {/* Teams Bot Row */}
                          <div class="rounded-lg border border-gray-200 dark:border-slate-800 overflow-hidden">
                            <div class="p-4 flex items-center justify-between">
                              <div class="flex items-center gap-3">
                                <div class="w-9 h-9 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" class="text-purple-600 dark:text-purple-400"><path d="M19.27 4.26h-3.42v-.7A1.56 1.56 0 0 0 14.3 2H9.7a1.56 1.56 0 0 0-1.55 1.56v.7H4.73A1.73 1.73 0 0 0 3 6v1.73h18V6a1.73 1.73 0 0 0-1.73-1.74zM9.88 3.56a.43.43 0 0 1 .43-.43h3.38a.43.43 0 0 1 .43.43v.7H9.88z"/><path d="M3 9v11.27A1.73 1.73 0 0 0 4.73 22h14.54A1.73 1.73 0 0 0 21 20.27V9zm7.13 8.59H7.36v-2.77h-.01V12.5h2.78v5.09zm3.74 0h-2.37V12.5h2.37zm3.77 0h-2.37V12.5h2.37z"/></svg>
                                </div>
                                <div>
                                  <div class="flex items-center gap-2">
                                    <h3 class="text-sm font-medium text-gray-900 dark:text-white">
                                      {t().channel.teamsBot}
                                    </h3>
                                    <Show when={teamsLoading() || teamsStatus()?.status === "starting"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-yellow-400 animate-pulse"></span>
                                    </Show>
                                    <Show when={!teamsLoading() && teamsStatus()?.status === "running"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-green-500"></span>
                                    </Show>
                                    <Show when={!teamsLoading() && teamsStatus()?.status === "error"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-red-500"></span>
                                    </Show>
                                  </div>
                                  <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                    {t().channel.teamsBotDesc}
                                  </p>
                                </div>
                              </div>

                              <div class="flex items-center gap-3">
                                <button
                                  onClick={() => setTeamsConfigOpen(true)}
                                  class="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors border border-gray-200 dark:border-slate-700"
                                >
                                  {t().channel.configure}
                                </button>
                                <button
                                  onClick={handleTeamsToggle}
                                  disabled={teamsLoading() || tunnelInfo().status !== "running"}
                                  class={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                                    teamsStatus()?.status === "running" ? "bg-blue-600" : "bg-gray-200 dark:bg-slate-700"
                                  } ${teamsLoading() || tunnelInfo().status !== "running" ? "opacity-50 cursor-not-allowed" : ""}`}
                                >
                                  <span class="sr-only">Toggle Teams Bot</span>
                                  <span
                                    class={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                      teamsStatus()?.status === "running" ? "translate-x-5" : "translate-x-0"
                                    }`}
                                  />
                                </button>
                              </div>
                            </div>

                            <Show when={teamsStatus()?.status === "error" && teamsStatus()?.error}>
                              <div class="px-4 py-3 bg-red-50 dark:bg-red-900/10 border-t border-red-100 dark:border-red-900/30">
                                <p class="text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
                                  {teamsStatus()?.error}
                                </p>
                              </div>
                            </Show>

                            {/* Webhook endpoint info when tunnel is running and channel is active */}
                            <Show when={tunnelInfo().status === "running" && teamsStatus()?.status === "running"}>
                              <div class="px-4 py-2.5 bg-blue-50 dark:bg-blue-900/5 border-t border-blue-100 dark:border-blue-900/20 flex items-start gap-2">
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-blue-500 dark:text-blue-400 shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                                <div class="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
                                  <span class="text-gray-500 dark:text-gray-500">{t().channel.webhookEndpoint}:</span>{" "}
                                  <code class="text-[11px] font-mono bg-gray-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-blue-600 dark:text-blue-400 border border-gray-200 dark:border-slate-700">{tunnelInfo().url}/api/messages</code>
                                  <br/>
                                  <span class="text-gray-400 dark:text-gray-500">{t().channel.teamsWebhookGuide}</span>
                                </div>
                              </div>
                            </Show>
                          </div>

                          {/* WeCom Bot Row */}
                          <div class="rounded-lg border border-gray-200 dark:border-slate-800 overflow-hidden">
                            <div class="p-4 flex items-center justify-between">
                              <div class="flex items-center gap-3">
                                <div class="w-9 h-9 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" class="text-green-600 dark:text-green-400"><path d="M8.69 4.47C5.29 5.2 2.8 8.14 2.8 11.6c0 1.73.58 3.33 1.55 4.62l-.97 2.87 3.02-.98c1.12.65 2.42 1.03 3.8 1.08-.2-.6-.3-1.24-.3-1.9 0-3.75 3.15-6.8 7.02-6.8.5 0 .99.06 1.46.16C17.79 7.17 14.93 4.8 11.5 4.4c-.94-.11-1.89-.08-2.81.07zM7.5 8.1a1.05 1.05 0 1 1 0 2.1 1.05 1.05 0 0 1 0-2.1zm5.2 0a1.05 1.05 0 1 1 0 2.1 1.05 1.05 0 0 1 0-2.1z"/><path d="M21.2 17.3c0-2.94-2.87-5.33-6.4-5.33s-6.4 2.39-6.4 5.33c0 2.94 2.87 5.33 6.4 5.33.98 0 1.9-.18 2.73-.5l2.27.74-.72-2.15c.72-1 1.12-2.17 1.12-3.42zm-8.65-.6a.88.88 0 1 1 0-1.75.88.88 0 0 1 0 1.75zm4.5 0a.88.88 0 1 1 0-1.75.88.88 0 0 1 0 1.75z"/></svg>
                                </div>
                                <div>
                                  <div class="flex items-center gap-2">
                                    <h3 class="text-sm font-medium text-gray-900 dark:text-white">
                                      {t().channel.wecomBot}
                                    </h3>
                                    <Show when={wecomLoading() || wecomStatus()?.status === "starting"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-yellow-400 animate-pulse"></span>
                                    </Show>
                                    <Show when={!wecomLoading() && wecomStatus()?.status === "running"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-green-500"></span>
                                    </Show>
                                    <Show when={!wecomLoading() && wecomStatus()?.status === "error"}>
                                      <span class="inline-flex h-2 w-2 rounded-full bg-red-500"></span>
                                    </Show>
                                  </div>
                                  <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                    {t().channel.wecomBotDesc}
                                  </p>
                                </div>
                              </div>

                              <div class="flex items-center gap-3">
                                <button
                                  onClick={() => setWecomConfigOpen(true)}
                                  class="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors border border-gray-200 dark:border-slate-700"
                                >
                                  {t().channel.configure}
                                </button>
                                <button
                                  onClick={handleWecomToggle}
                                  disabled={wecomLoading() || tunnelInfo().status !== "running"}
                                  class={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                                    wecomStatus()?.status === "running" ? "bg-blue-600" : "bg-gray-200 dark:bg-slate-700"
                                  } ${wecomLoading() || tunnelInfo().status !== "running" ? "opacity-50 cursor-not-allowed" : ""}`}
                                >
                                  <span class="sr-only">Toggle WeCom Bot</span>
                                  <span
                                    class={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                      wecomStatus()?.status === "running" ? "translate-x-5" : "translate-x-0"
                                    }`}
                                  />
                                </button>
                              </div>
                            </div>

                            <Show when={wecomStatus()?.status === "error" && wecomStatus()?.error}>
                              <div class="px-4 py-3 bg-red-50 dark:bg-red-900/10 border-t border-red-100 dark:border-red-900/30">
                                <p class="text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
                                  {wecomStatus()?.error}
                                </p>
                              </div>
                            </Show>

                            {/* Webhook endpoint info when tunnel is running and channel is active */}
                            <Show when={tunnelInfo().status === "running" && wecomStatus()?.status === "running"}>
                              <div class="px-4 py-2.5 bg-blue-50 dark:bg-blue-900/5 border-t border-blue-100 dark:border-blue-900/20 flex items-start gap-2">
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-blue-500 dark:text-blue-400 shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                                <div class="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
                                  <span class="text-gray-500 dark:text-gray-500">{t().channel.webhookEndpoint}:</span>{" "}
                                  <code class="text-[11px] font-mono bg-gray-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-blue-600 dark:text-blue-400 border border-gray-200 dark:border-slate-700">{tunnelInfo().url}/webhook/wecom</code>
                                  <br/>
                                  <span class="text-gray-400 dark:text-gray-500">{t().channel.wecomWebhookGuide}</span>
                                </div>
                              </div>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </div>
                  </Show>

                  {/* Public Access Tab */}
                  <Show when={activeTab() === "publicAccess"}>
                    <div class="space-y-5">
                      <div>
                        <h2 class="text-base font-semibold text-gray-900 dark:text-white">{t().remote.publicAccessTab}</h2>
                        <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">{t().remote.publicAccessTabDesc}</p>
                      </div>

                      {/* Tunnel Toggle Card */}
                      <div class="rounded-lg border border-gray-200 dark:border-slate-800 overflow-hidden">
                        <div class="p-4 flex items-center justify-between">
                          <div class="flex items-center gap-3">
                            <div class={`w-9 h-9 rounded-lg flex items-center justify-center ${
                              tunnelInfo().status === "running"
                                ? "bg-blue-100 dark:bg-blue-900/30"
                                : "bg-gray-100 dark:bg-slate-800"
                            }`}>
                              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={tunnelInfo().status === "running" ? "text-blue-600 dark:text-blue-400" : "text-gray-400 dark:text-gray-500"}>
                                <circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>
                              </svg>
                            </div>
                            <div>
                              <h3 class="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-2">
                                Cloudflare Tunnel
                                <Show when={tunnelLoading() || tunnelInfo().status === "starting"}>
                                  <span class="inline-flex h-2 w-2 rounded-full bg-yellow-400 animate-pulse"></span>
                                </Show>
                                <Show when={!tunnelLoading() && tunnelInfo().status === "running"}>
                                  <span class="inline-flex h-2 w-2 rounded-full bg-green-500"></span>
                                </Show>
                              </h3>
                              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                {tunnelInfo().status === "running" ? t().remote.tunnelRunning : t().remote.tunnelStopped}
                              </p>
                            </div>
                          </div>
                          <button
                            onClick={handleTunnelToggle}
                            disabled={tunnelLoading()}
                            class={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                              tunnelEnabled() ? "bg-blue-600" : "bg-gray-200 dark:bg-slate-700"
                            } ${tunnelLoading() ? "opacity-50 cursor-not-allowed" : ""}`}
                          >
                            <span class="sr-only">Toggle Tunnel</span>
                            <span
                              class={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                tunnelEnabled() ? "translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </button>
                        </div>

                        <Show when={tunnelInfo().status === "running" && tunnelInfo().url}>
                          <div class="px-4 py-3 border-t border-gray-100 dark:border-slate-800">
                            <div class="flex items-center justify-between bg-gray-50 dark:bg-slate-950 rounded-lg border border-gray-200 dark:border-slate-800 px-3 py-2">
                              <span class="font-mono text-xs text-blue-600 dark:text-blue-400 truncate">{tunnelInfo().url}</span>
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(tunnelInfo().url);
                                }}
                                class="shrink-0 ml-2 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors rounded hover:bg-gray-200 dark:hover:bg-slate-800"
                                title={t().common.copied}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                              </button>
                            </div>
                          </div>
                        </Show>

                        <Show when={tunnelInfo().error}>
                          <div class="px-4 py-3 bg-red-50 dark:bg-red-900/10 border-t border-red-100 dark:border-red-900/30">
                            <p class="text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
                              {tunnelInfo().error}
                            </p>
                          </div>
                        </Show>

                        <Show when={tunnelEnabled() && tunnelInfo().status === "starting"}>
                          <div class="px-4 py-3 bg-blue-50 dark:bg-blue-900/10 border-t border-blue-100 dark:border-blue-900/30">
                            <p class="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-2">
                              <svg class="animate-spin" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                              {t().remote.starting}
                            </p>
                          </div>
                        </Show>
                      </div>

                      {/* Named Tunnel Configuration */}
                      <div class="rounded-lg border border-gray-200 dark:border-slate-800 overflow-hidden">
                        <div class="p-4">
                          <h3 class="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-2">
                            {t().remote.namedTunnel}
                            <Show when={isNamedTunnel()}>
                              <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">✓</span>
                            </Show>
                          </h3>
                          <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">{t().remote.namedTunnelDesc}</p>

                          <div class="mt-3">
                            <label class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t().remote.tunnelHostname}</label>
                            <input
                              type="text"
                              value={namedTunnelHostname()}
                              onInput={(e) => setNamedTunnelHostname(e.currentTarget.value)}
                              onBlur={saveNamedTunnelConfig}
                              placeholder={t().remote.tunnelHostnamePlaceholder}
                              class="w-full px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                            />
                          </div>

                          <Show when={!isNamedTunnel()}>
                            <p class="mt-2 text-[11px] text-gray-400 dark:text-gray-500">{t().remote.namedTunnelSetupHint}</p>
                          </Show>
                          <Show when={isNamedTunnel()}>
                            <p class="mt-2 text-[11px] text-green-600 dark:text-green-400">{t().remote.namedTunnelActive}</p>
                          </Show>
                        </div>
                      </div>

                      {/* Notes */}
                      <div>
                        <h3 class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">{t().remote.notes}</h3>
                        <div class="space-y-2">
                          <div class="rounded-lg border border-gray-200 dark:border-slate-800 p-3.5 flex items-start gap-3">
                            <div class={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
                              isNamedTunnel()
                                ? "bg-green-100 dark:bg-green-900/30"
                                : "bg-amber-100 dark:bg-amber-900/30"
                            }`}>
                              <Show when={isNamedTunnel()} fallback={
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-600 dark:text-amber-400"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                              }>
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-green-600 dark:text-green-400"><polyline points="20 6 9 17 4 12"/></svg>
                              </Show>
                            </div>
                            <div>
                              <Show when={isNamedTunnel()} fallback={
                                <>
                                  <div class="text-sm font-medium text-gray-900 dark:text-white">{t().remote.noteUrlChanges}</div>
                                  <div class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t().remote.noteUrlChangesDesc}</div>
                                </>
                              }>
                                <div class="text-sm font-medium text-gray-900 dark:text-white">{t().remote.namedTunnel}</div>
                                <div class="text-xs text-green-600 dark:text-green-400 mt-0.5">{t().remote.noteUrlFixedDomain}</div>
                              </Show>
                            </div>
                          </div>
                          <div class="rounded-lg border border-gray-200 dark:border-slate-800 p-3.5 flex items-start gap-3">
                            <div class="w-7 h-7 rounded-md bg-green-100 dark:bg-green-900/30 flex items-center justify-center shrink-0">
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-green-600 dark:text-green-400"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                            </div>
                            <div>
                              <div class="text-sm font-medium text-gray-900 dark:text-white">{t().remote.noteSecurity}</div>
                              <div class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t().remote.noteSecurityDesc}</div>
                            </div>
                          </div>
                          <div class="rounded-lg border border-gray-200 dark:border-slate-800 p-3.5 flex items-start gap-3">
                            <div class="w-7 h-7 rounded-md bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-blue-600 dark:text-blue-400"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                            </div>
                            <div>
                              <div class="text-sm font-medium text-gray-900 dark:text-white">{t().remote.noteKeepRunning}</div>
                              <div class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t().remote.noteKeepRunningDesc}</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </Show>
                </div>
              </div>

              <FeishuConfigModal
                isOpen={feishuConfigOpen()}
                onClose={() => setFeishuConfigOpen(false)}
                initialConfig={feishuConfig()}
                onSave={handleFeishuConfigSave}
              />

              <WeixinIlinkLoginModal
                isOpen={weixinIlinkLoginOpen()}
                onClose={() => setWeixinIlinkLoginOpen(false)}
                initialConfig={weixinIlinkConfig()}
                onSave={async (config: any) => {
                  const loginData = {
                    botToken: config.botToken,
                    accountId: config.accountId,
                    baseUrl: config.baseUrl,
                  };
                  await handleWeixinIlinkLoginSuccess(loginData);
                  setWeixinIlinkLoginOpen(false);
                }}
              />

              <ChannelConfigModal
                isOpen={dingtalkConfigOpen()}
                onClose={() => setDingtalkConfigOpen(false)}
                title={t().channel.dingtalkBot}
                fields={[
                  { key: "appKey", label: t().channel.appKey, type: "text", placeholder: t().channel.appKeyPlaceholder, required: true },
                  { key: "appSecret", label: t().channel.appSecret, type: "password", placeholder: t().channel.appSecretPlaceholder, required: true },
                  { key: "robotCode", label: t().channel.robotCode, type: "text", placeholder: t().channel.robotCodePlaceholder },
                  { key: "autoApprovePermissions", label: t().channel.autoApprove, type: "toggle", disabled: true },
                ]}
                initialConfig={dingtalkConfig()}
                onSave={handleDingtalkConfigSave}
              />

              <ChannelConfigModal
                isOpen={telegramConfigOpen()}
                onClose={() => setTelegramConfigOpen(false)}
                title={t().channel.telegramBot}
                fields={[
                  { key: "botToken", label: t().channel.botToken, type: "password", placeholder: t().channel.botTokenPlaceholder, required: true },
                  { key: "webhookUrl", label: t().channel.webhookUrl, type: "text", placeholder: t().channel.webhookUrlPlaceholder },
                  { key: "autoApprovePermissions", label: t().channel.autoApprove, type: "toggle", disabled: true },
                ]}
                initialConfig={telegramConfig()}
                onSave={handleTelegramConfigSave}
              />

              <ChannelConfigModal
                isOpen={wecomConfigOpen()}
                onClose={() => setWecomConfigOpen(false)}
                title={t().channel.wecomBot}
                fields={[
                  { key: "corpId", label: t().channel.corpId, type: "text", placeholder: t().channel.corpIdPlaceholder, required: true },
                  { key: "corpSecret", label: t().channel.corpSecret, type: "password", placeholder: t().channel.corpSecretPlaceholder, required: true },
                  { key: "agentId", label: t().channel.agentId, type: "number", placeholder: t().channel.agentIdPlaceholder, required: true },
                  { key: "callbackToken", label: t().channel.callbackToken, type: "text", placeholder: t().channel.callbackTokenPlaceholder, required: true },
                  { key: "callbackEncodingAESKey", label: t().channel.callbackEncodingAESKey, type: "password", placeholder: t().channel.callbackEncodingAESKeyPlaceholder, required: true },
                  { key: "autoApprovePermissions", label: t().channel.autoApprove, type: "toggle", disabled: true },
                ]}
                initialConfig={wecomConfig()}
                onSave={handleWecomConfigSave}
              />

              <ChannelConfigModal
                isOpen={teamsConfigOpen()}
                onClose={() => setTeamsConfigOpen(false)}
                title={t().channel.teamsBot}
                fields={[
                  { key: "microsoftAppId", label: t().channel.microsoftAppId, type: "text", placeholder: t().channel.microsoftAppIdPlaceholder, required: true },
                  { key: "microsoftAppPassword", label: t().channel.microsoftAppPassword, type: "password", placeholder: t().channel.microsoftAppPasswordPlaceholder, required: true },
                  { key: "tenantId", label: t().channel.tenantId, type: "text", placeholder: t().channel.tenantIdPlaceholder },
                  { key: "autoApprovePermissions", label: t().channel.autoApprove, type: "toggle", disabled: true },
                ]}
                initialConfig={teamsConfig()}
                onSave={handleTeamsConfigSave}
              />
            </div>
          </main>
        </div>

        {/* Bottom: Enter Chat Button (sticky) */}
        <div class="sticky bottom-0 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-t border-gray-200 dark:border-slate-800 p-4">
          <div class="max-w-4xl mx-auto">
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
