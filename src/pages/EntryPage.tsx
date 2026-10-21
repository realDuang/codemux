import { createSignal, onMount, onCleanup, Show, Switch, Match } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { Auth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { RemoteConnections } from "../components/RemoteConnections";
import { readCustomAccessUrl } from "../../shared/remote-access";
import type { RemoteAccessStatus } from "../../shared/remote-access";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { FeishuConfigModal } from "../components/FeishuConfigModal";
import { ChannelConfigModal } from "../components/ChannelConfigModal";
import { WeixinIlinkLoginModal } from "../components/WeixinIlinkLoginModal";
import { logger } from "../lib/logger";
import { WEB_STANDALONE_PORT } from "../../shared/ports";
import { isElectron } from "../lib/platform";
import { systemAPI, serverAPI, remoteAccessAPI, channelAPI, weixinIlinkAPI, type ChannelInfo } from "../lib/electron-api";
import { getSetting, bootstrapHostSettings } from "../lib/settings";
import { refreshThemeFromSettings } from "../lib/theme";
import { refreshLocaleFromSettings } from "../lib/i18n";
import { BrandMark } from "../components/BrandMark";
import { ChannelCard, channelButtonClass, type ChannelRunState } from "../components/ChannelCard";
import { publicAssetUrl } from "../lib/public-assets";
import { CONNECTION_CENTER_PATH } from "../lib/routes";

/** Loading wins over the last reported status while a toggle is in flight. */
function channelState(info: ChannelInfo | null, loading: boolean): ChannelRunState {
  if (loading || info?.status === "starting") return "starting";
  return info?.status === "running" || info?.status === "error" ? info.status : "stopped";
}

export default function EntryPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  // The host opens chat by default; the connection center has its own route.
  const showConnectionCenter = () => location.pathname === CONNECTION_CENTER_PATH;

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

  /** Authenticates this host and opens chat; false keeps the entry page visible. */
  const enterLocalChat = async (hasValidToken?: boolean): Promise<boolean> => {
    if (!(hasValidToken ?? await Auth.checkDeviceToken())) {
      const result = await Auth.localAuth();
      if (!result.success) {
        logger.error("[EntryPage] Local auth failed:", result.error);
        return false;
      }
    }
    await applyHostSettingsIfNeeded();
    navigate("/chat", { replace: true });
    return true;
  };

  // Local mode states (remote access config)
  const [remoteStatus, setRemoteStatus] = createSignal<RemoteAccessStatus>({
    mode: "off", customAccessUrl: readCustomAccessUrl({ customAccessUrl: getSetting("customAccessUrl") }),
    url: "", tunnel: { url: "", status: "stopped" }, tunnelConfig: {}, cloudflareAvailable: true,
  });
  const accessUrl = () => remoteStatus().url;
  const [accessCode, setAccessCode] = createSignal("......");
  const [port, setPort] = createSignal(WEB_STANDALONE_PORT);
  const [localIp, setLocalIp] = createSignal("");
  const [enteringChat, setEnteringChat] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal<"channels" | "remote">("remote");

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
      if (!showConnectionCenter() && await enterLocalChat()) return;
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
      if (!showConnectionCenter() && await enterLocalChat(hasValidToken)) return;
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

      // A saved SSH host enters its existing chat after loopback authentication.
      if (new URLSearchParams(window.location.search).get("connect") === "1" && Auth.isAuthenticated()) {
        await applyHostSettingsIfNeeded();
        navigate("/chat", { replace: true });
        return;
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
        const [webPort, ip] = await Promise.all([serverAPI.getPort(), systemAPI.getLocalIp()]);
        setPort(webPort);
        setLocalIp(ip);
      } else {
        // Browser: use HTTP API
        const res = await fetch("/api/system/info");
        const data = await res.json();
        if (data.port) setPort(data.port);
        if (typeof data.localIp === "string") setLocalIp(data.localIp);
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

    await applyHostSettingsIfNeeded();


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
    try { setRemoteStatus(await remoteAccessAPI.getStatus()); }
    catch (error) { logger.error("[EntryPage] Failed to load remote access:", error); }
  };

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

  const handleWeixinIlinkLogout = async () => {
    if (!confirm(t().channel.weixinIlinkLogoutConfirm)) return;
    setWeixinIlinkLoading(true);
    try {
      await weixinIlinkAPI.logout();
      // Reset local config snapshot so the UI immediately reflects logged-out state.
      setWeixinIlinkConfig({
        ...weixinIlinkConfig(),
        botToken: "",
        accountId: "",
      });
      const status = await channelAPI.getStatus("weixin-ilink");
      if (status) setWeixinIlinkStatus(status);
      else setWeixinIlinkStatus({ type: "weixin-ilink", name: "WeChat iLink", status: "stopped" });
    } catch (err) {
      logger.error("[EntryPage] Failed to logout WeChat iLink:", err);
    } finally {
      setWeixinIlinkLoading(false);
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

  // =========================================================================
  // Render
  // =========================================================================

  return (
    <div class="flex flex-col h-screen overflow-hidden bg-[var(--cm-canvas)] font-sans text-gray-900 dark:text-gray-100">
      {/* Unified Titlebar */}
      <div
        class="w-full flex-shrink-0 flex items-center px-2.5 border-b border-[var(--cm-hairline)] bg-[var(--cm-canvas)] electron-drag-region electron-titlebar-pad-left electron-titlebar-pad-right"
        style={{ height: "var(--electron-title-bar-height, 40px)", "min-height": "var(--electron-title-bar-height, 40px)" }}
      >
        <BrandMark />
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
        <div class="relative flex-1 flex items-center justify-center p-4 isolate overflow-hidden">
          <div aria-hidden="true" class="pointer-events-none absolute inset-0 -z-10 cm-grid-bg" />
          <div aria-hidden="true" class="pointer-events-none absolute inset-0 -z-10 cm-aurora" />
          <div class="animate-cm-fade-up w-full max-w-md p-8 bg-[var(--cm-surface)]/90 backdrop-blur-xl rounded-2xl ring-1 ring-[var(--cm-hairline-strong)] shadow-[var(--cm-shadow-lg)] transition-all duration-300">
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
                      class="w-full mt-4 py-2 px-4 border border-[var(--cm-hairline-strong)] hover:bg-gray-50 dark:hover:bg-slate-700 text-gray-700 dark:text-gray-300 font-medium rounded-md transition-colors"
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
                      class="cm-btn-primary w-full py-2 px-4 font-medium rounded-lg"
                    >
                      {t().approval.tryAgain}
                    </button>
                  </Match>
                </Switch>
              </div>
            }>
              <div class="flex justify-center mb-5">
                <span class="cm-brand-mark rounded-xl"><img src={publicAssetUrl("logo.png")} alt="" class="w-11 h-11 rounded-xl" /></span>
              </div>
              <h1 class="text-[22px] font-semibold tracking-tight text-center mb-6 text-gray-900 dark:text-white">
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
                    class="w-full h-14 px-4 bg-[var(--cm-surface-2)] border border-[var(--cm-hairline-strong)] rounded-xl focus:outline-none focus:border-indigo-500/60 focus:ring-4 focus:ring-indigo-500/15 text-gray-900 dark:text-white text-center text-2xl tracking-[0.5em] font-mono transition-shadow"
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
                  class="cm-btn-primary w-full h-11 px-4 font-medium rounded-xl disabled:cursor-not-allowed flex items-center justify-center gap-2"
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
            <div class="max-w-5xl mx-auto space-y-6">

              {/* Vertical Tab Layout (horizontal on mobile) */}
              <div class="flex flex-col md:flex-row gap-0 bg-[var(--cm-surface)] rounded-2xl border border-[var(--cm-hairline-strong)] shadow-[var(--cm-shadow-md)] overflow-hidden md:min-h-[520px]">
                <Show when={isElectron()}>
                  <nav aria-label={t().connectionCenter.title} class="w-full shrink-0 border-b border-[var(--cm-hairline)] bg-[var(--cm-surface-2)]/50 p-2 md:w-44 md:border-b-0 md:border-r md:p-3">
                    <div class="flex gap-1 md:flex-col">
                      <button type="button" onClick={() => setActiveTab("remote")} aria-current={activeTab() === "remote" ? "page" : undefined}
                        class={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium ${activeTab() === "remote" ? "bg-[var(--cm-surface)] text-[var(--cm-text)] shadow-sm" : "text-[var(--cm-text-muted)] hover:bg-[var(--cm-surface)]"}`}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18"/></svg>
                        {t().connectionCenter.title}
                      </button>
                      <button type="button" onClick={() => setActiveTab("channels")} aria-current={activeTab() === "channels" ? "page" : undefined}
                        class={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium ${activeTab() === "channels" ? "bg-[var(--cm-surface)] text-[var(--cm-text)] shadow-sm" : "text-[var(--cm-text-muted)] hover:bg-[var(--cm-surface)]"}`}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                        {t().channel.channels}
                      </button>
                    </div>
                  </nav>
                </Show>

                {/* Right: Tab Content (bottom on mobile) */}
                <div class="min-w-0 flex-1 p-4 sm:p-6 md:p-7">
                  {/* Channels Tab */}
                  <Show when={activeTab() === "channels"}>
                    <div class="space-y-7" data-testid="channels">
                      <header>
                        <h1 class="text-xl font-semibold tracking-tight text-[var(--cm-text)]">{t().channel.channels}</h1>
                        <p class="mt-2 max-w-xl text-sm leading-relaxed text-[var(--cm-text-muted)]">{t().channel.channelsDescription}</p>
                      </header>

                      <section class="space-y-4" aria-labelledby="channels-direct-heading">
                        <div>
                          <h2 id="channels-direct-heading" class="text-sm font-semibold text-[var(--cm-text)]">{t().channel.directConnect}</h2>
                          <p class="mt-1 text-xs leading-relaxed text-[var(--cm-text-muted)]">{t().channel.directConnectDescription}</p>
                        </div>
                        <div class="divide-y divide-[var(--cm-hairline)] rounded-xl border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)]">
                          <ChannelCard
                            icon={<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>}
                            name={t().channel.feishuBot}
                            description={t().channel.feishuBotDesc}
                            state={channelState(feishuStatus(), feishuLoading())}
                            enabled={feishuStatus()?.status === "running"}
                            onToggle={handleFeishuToggle}
                            toggleDisabled={feishuLoading()}
                            error={feishuStatus()?.status === "error" ? feishuStatus()?.error : undefined}
                            actions={<button type="button" onClick={() => setFeishuConfigOpen(true)} class={channelButtonClass}>{t().channel.configure}</button>}
                          />
                          <ChannelCard
                            icon={<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>}
                            name={t().channel.dingtalkBot}
                            description={t().channel.dingtalkBotDesc}
                            state={channelState(dingtalkStatus(), dingtalkLoading())}
                            enabled={dingtalkStatus()?.status === "running"}
                            onToggle={handleDingtalkToggle}
                            toggleDisabled={dingtalkLoading()}
                            error={dingtalkStatus()?.status === "error" ? dingtalkStatus()?.error : undefined}
                            actions={<button type="button" onClick={() => setDingtalkConfigOpen(true)} class={channelButtonClass}>{t().channel.configure}</button>}
                          />
                          <ChannelCard
                            icon={<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>}
                            name={t().channel.telegramBot}
                            description={t().channel.telegramBotDesc}
                            state={channelState(telegramStatus(), telegramLoading())}
                            enabled={telegramStatus()?.status === "running"}
                            onToggle={handleTelegramToggle}
                            toggleDisabled={telegramLoading()}
                            error={telegramStatus()?.status === "error" ? telegramStatus()?.error : undefined}
                            actions={<button type="button" onClick={() => setTelegramConfigOpen(true)} class={channelButtonClass}>{t().channel.configure}</button>}
                          />
                          <ChannelCard
                            icon={<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"> <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/> </svg>}
                            name={t().channel.weixinIlinkBot}
                            description={t().channel.weixinIlinkBotDesc}
                            state={channelState(weixinIlinkStatus(), weixinIlinkLoading())}
                            enabled={weixinIlinkStatus()?.status === "running"}
                            onToggle={handleWeixinIlinkToggle}
                            toggleDisabled={weixinIlinkLoading() || !weixinIlinkConfig().botToken || !weixinIlinkConfig().accountId}
                            toggleTitle={!weixinIlinkConfig().botToken || !weixinIlinkConfig().accountId ? t().channel.weixinIlinkLoginRequiredHint : undefined}
                            error={weixinIlinkStatus()?.status === "error" ? weixinIlinkStatus()?.error : undefined}
                            actions={<Show
                              when={!!weixinIlinkConfig().botToken && !!weixinIlinkConfig().accountId}
                              fallback={<button type="button" onClick={() => setWeixinIlinkLoginOpen(true)} class={channelButtonClass}>{t().channel.login}</button>}
                            >
                              <button type="button" onClick={handleWeixinIlinkLogout} disabled={weixinIlinkLoading()} class={`${channelButtonClass} text-red-600 dark:text-red-400`}>{t().channel.weixinIlinkLogout}</button>
                            </Show>}
                          />
                        </div>
                      </section>

                      <section class="space-y-4 border-t border-[var(--cm-hairline)] pt-6" aria-labelledby="channels-webhook-heading">
                        <div>
                          <h2 id="channels-webhook-heading" class="text-sm font-semibold text-[var(--cm-text)]">{t().channel.webhookConnect}</h2>
                          <p class="mt-1 text-xs leading-relaxed text-[var(--cm-text-muted)]">{accessUrl() ? t().channel.webhookReachabilityHint : t().channel.webhookConnectDescription}</p>
                        </div>
                        {/* Webhook callbacks need an address the channel platform can reach. */}
                        <Show when={!accessUrl()}>
                          <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-black/[0.035] px-3 py-2.5 dark:bg-white/[0.05]">
                            <p class="min-w-0 flex-1 text-xs leading-relaxed text-[var(--cm-text-muted)]"><span class="font-medium text-[var(--cm-text)]">{t().channel.accessUrlRequired}</span> {t().channel.accessUrlRequiredDesc}</p>
                            <button type="button" onClick={() => setActiveTab("remote")} class={channelButtonClass}>{t().channel.openRemoteConnections}</button>
                          </div>
                        </Show>
                        <div class="divide-y divide-[var(--cm-hairline)] rounded-xl border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)]">
                          <ChannelCard
                            icon={<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19.27 4.26h-3.42v-.7A1.56 1.56 0 0 0 14.3 2H9.7a1.56 1.56 0 0 0-1.55 1.56v.7H4.73A1.73 1.73 0 0 0 3 6v1.73h18V6a1.73 1.73 0 0 0-1.73-1.74zM9.88 3.56a.43.43 0 0 1 .43-.43h3.38a.43.43 0 0 1 .43.43v.7H9.88z"/><path d="M3 9v11.27A1.73 1.73 0 0 0 4.73 22h14.54A1.73 1.73 0 0 0 21 20.27V9zm7.13 8.59H7.36v-2.77h-.01V12.5h2.78v5.09zm3.74 0h-2.37V12.5h2.37zm3.77 0h-2.37V12.5h2.37z"/></svg>}
                            name={t().channel.teamsBot}
                            description={t().channel.teamsBotDesc}
                            state={channelState(teamsStatus(), teamsLoading())}
                            enabled={teamsStatus()?.status === "running"}
                            onToggle={handleTeamsToggle}
                            toggleDisabled={teamsLoading() || (!accessUrl() && teamsStatus()?.status !== "running")}
                            error={teamsStatus()?.status === "error" ? teamsStatus()?.error : undefined}
                            actions={<button type="button" onClick={() => setTeamsConfigOpen(true)} class={channelButtonClass}>{t().channel.configure}</button>}
                            details={accessUrl() && teamsStatus()?.status === "running" ? (
                              <div class="text-xs leading-relaxed text-[var(--cm-text-muted)]">
                                <p class="text-[11px] font-medium">{t().channel.webhookEndpoint}</p>
                                <p class="mt-1 select-all break-all font-mono text-[var(--cm-text)]">{accessUrl()}/api/messages</p>
                                <p class="mt-1.5">{t().channel.teamsWebhookGuide}</p>
                              </div>
                            ) : undefined}
                          />
                          <ChannelCard
                            icon={<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8.69 4.47C5.29 5.2 2.8 8.14 2.8 11.6c0 1.73.58 3.33 1.55 4.62l-.97 2.87 3.02-.98c1.12.65 2.42 1.03 3.8 1.08-.2-.6-.3-1.24-.3-1.9 0-3.75 3.15-6.8 7.02-6.8.5 0 .99.06 1.46.16C17.79 7.17 14.93 4.8 11.5 4.4c-.94-.11-1.89-.08-2.81.07zM7.5 8.1a1.05 1.05 0 1 1 0 2.1 1.05 1.05 0 0 1 0-2.1zm5.2 0a1.05 1.05 0 1 1 0 2.1 1.05 1.05 0 0 1 0-2.1z"/><path d="M21.2 17.3c0-2.94-2.87-5.33-6.4-5.33s-6.4 2.39-6.4 5.33c0 2.94 2.87 5.33 6.4 5.33.98 0 1.9-.18 2.73-.5l2.27.74-.72-2.15c.72-1 1.12-2.17 1.12-3.42zm-8.65-.6a.88.88 0 1 1 0-1.75.88.88 0 0 1 0 1.75zm4.5 0a.88.88 0 1 1 0-1.75.88.88 0 0 1 0 1.75z"/></svg>}
                            name={t().channel.wecomBot}
                            description={t().channel.wecomBotDesc}
                            state={channelState(wecomStatus(), wecomLoading())}
                            enabled={wecomStatus()?.status === "running"}
                            onToggle={handleWecomToggle}
                            toggleDisabled={wecomLoading() || (!accessUrl() && wecomStatus()?.status !== "running")}
                            error={wecomStatus()?.status === "error" ? wecomStatus()?.error : undefined}
                            actions={<button type="button" onClick={() => setWecomConfigOpen(true)} class={channelButtonClass}>{t().channel.configure}</button>}
                            details={accessUrl() && wecomStatus()?.status === "running" ? (
                              <div class="text-xs leading-relaxed text-[var(--cm-text-muted)]">
                                <p class="text-[11px] font-medium">{t().channel.webhookEndpoint}</p>
                                <p class="mt-1 select-all break-all font-mono text-[var(--cm-text)]">{accessUrl()}/webhook/wecom</p>
                                <p class="mt-1.5">{t().channel.wecomWebhookGuide}</p>
                              </div>
                            ) : undefined}
                          />
                        </div>
                      </section>
                    </div>
                  </Show>

                  <Show when={activeTab() === "remote"}>
                    <RemoteConnections status={remoteStatus()} onChanged={setRemoteStatus} defaultHost={localIp()} defaultPort={port()} accessCode={accessCode()} onManageDevices={() => navigate("/devices")} />
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

        {/* Keep the local conversation action distinct from remote host actions. */}
        <div class="sticky bottom-0 bg-[var(--cm-canvas)]/80 backdrop-blur-xl border-t border-[var(--cm-hairline)] p-4">
          <div class="max-w-5xl mx-auto">
            <button
              onClick={handleEnterChat}
              disabled={enteringChat()}
              class="group ml-auto flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] px-5 text-sm font-medium text-[var(--cm-text)] hover:bg-[var(--cm-surface-2)] disabled:cursor-not-allowed sm:w-auto"
            >
              <Show when={enteringChat()} fallback={
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                  </svg>
                  <span>{t().connectionCenter.openLocalChat}</span>
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="transition-transform duration-200 group-hover:translate-x-0.5">
                    <path d="m9 18 6-6-6-6"/>
                  </svg>
                </>
              }>
                <div class="animate-spin w-5 h-5 border-2 border-current border-t-transparent rounded-full" />
                <span>{t().common.loading}</span>
              </Show>
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
