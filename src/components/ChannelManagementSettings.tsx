import { Show, createSignal, onMount, type JSX } from "solid-js";
import { useI18n } from "../lib/i18n";
import { logger } from "../lib/logger";
import { isElectron } from "../lib/platform";
import { channelAPI, getElectronAPI, tunnelAPI, type ChannelInfo, type TunnelInfo } from "../lib/electron-api";
import { FeishuConfigModal } from "./FeishuConfigModal";
import { ChannelConfigModal, type ConfigField } from "./ChannelConfigModal";

type FeishuConfig = {
  platform: "feishu" | "lark";
  appId: string;
  appSecret: string;
  autoApprovePermissions: boolean;
  streamingThrottleMs: number;
};

type DingTalkConfig = {
  appKey: string;
  appSecret: string;
  robotCode: string;
  autoApprovePermissions: boolean;
  streamingThrottleMs: number;
};

type TelegramConfig = {
  botToken: string;
  webhookUrl: string;
  autoApprovePermissions: boolean;
  streamingThrottleMs: number;
};

type WeComConfig = {
  corpId: string;
  corpSecret: string;
  agentId: number;
  callbackToken: string;
  callbackEncodingAESKey: string;
  autoApprovePermissions: boolean;
};

type TeamsConfig = {
  microsoftAppId: string;
  microsoftAppPassword: string;
  tenantId: string;
  autoApprovePermissions: boolean;
  streamingThrottleMs: number;
};

interface ChannelCardProps {
  badge: string;
  badgeClass: string;
  title: string;
  description: string;
  status: ChannelInfo | null;
  loading: boolean;
  onConfigure: () => void;
  onToggle: () => void;
  footer?: JSX.Element;
}

function ChannelCard(props: ChannelCardProps) {
  const { t } = useI18n();
  const isRunning = () => props.status?.status === "running";
  const isStarting = () => props.loading || props.status?.status === "starting";
  const isError = () => props.status?.status === "error";

  return (
    <div class="rounded-lg border border-gray-200 dark:border-slate-800 overflow-hidden">
      <div class="p-4 flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-semibold ${props.badgeClass}`}>
            {props.badge}
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h3 class="text-sm font-medium text-gray-900 dark:text-white truncate">{props.title}</h3>
              <Show when={isStarting()}>
                <span class="inline-flex h-2 w-2 rounded-full bg-yellow-400 animate-pulse" />
              </Show>
              <Show when={!isStarting() && isRunning()}>
                <span class="inline-flex h-2 w-2 rounded-full bg-green-500" />
              </Show>
              <Show when={!isStarting() && isError()}>
                <span class="inline-flex h-2 w-2 rounded-full bg-red-500" />
              </Show>
            </div>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{props.description}</p>
          </div>
        </div>

        <div class="flex items-center gap-3 flex-shrink-0">
          <button
            onClick={() => props.onConfigure()}
            class="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors border border-gray-200 dark:border-slate-700"
          >
            {t().channel.configure}
          </button>
          <button
            onClick={() => props.onToggle()}
            disabled={props.loading}
            class={`relative inline-flex h-7 w-12 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              isRunning() ? "bg-blue-600" : "bg-gray-200 dark:bg-slate-700"
            } ${props.loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          >
            <span class="sr-only">{props.title}</span>
            <span
              class={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                isRunning() ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>

      <Show when={props.status?.status === "error" && props.status?.error}>
        <div class="px-4 py-3 bg-red-50 dark:bg-red-900/10 border-t border-red-100 dark:border-red-900/30">
          <p class="text-xs text-red-600 dark:text-red-400">{props.status?.error}</p>
        </div>
      </Show>

      <Show when={props.footer}>
        <div class="px-4 py-3 border-t border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/40">
          {props.footer}
        </div>
      </Show>
    </div>
  );
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function ChannelManagementSettings() {
  const { t } = useI18n();

  const [tunnelInfo, setTunnelInfo] = createSignal<TunnelInfo>({
    url: "",
    status: "stopped",
  });

  const [feishuStatus, setFeishuStatus] = createSignal<ChannelInfo | null>(null);
  const [feishuConfig, setFeishuConfig] = createSignal<FeishuConfig>({
    platform: "feishu",
    appId: "",
    appSecret: "",
    autoApprovePermissions: true,
    streamingThrottleMs: 1500,
  });
  const [feishuConfigOpen, setFeishuConfigOpen] = createSignal(false);
  const [feishuLoading, setFeishuLoading] = createSignal(false);

  const [dingtalkStatus, setDingtalkStatus] = createSignal<ChannelInfo | null>(null);
  const [dingtalkConfig, setDingtalkConfig] = createSignal<DingTalkConfig>({
    appKey: "",
    appSecret: "",
    robotCode: "",
    autoApprovePermissions: true,
    streamingThrottleMs: 1500,
  });
  const [dingtalkConfigOpen, setDingtalkConfigOpen] = createSignal(false);
  const [dingtalkLoading, setDingtalkLoading] = createSignal(false);

  const [telegramStatus, setTelegramStatus] = createSignal<ChannelInfo | null>(null);
  const [telegramConfig, setTelegramConfig] = createSignal<TelegramConfig>({
    botToken: "",
    webhookUrl: "",
    autoApprovePermissions: true,
    streamingThrottleMs: 1500,
  });
  const [telegramConfigOpen, setTelegramConfigOpen] = createSignal(false);
  const [telegramLoading, setTelegramLoading] = createSignal(false);

  const [wecomStatus, setWecomStatus] = createSignal<ChannelInfo | null>(null);
  const [wecomConfig, setWecomConfig] = createSignal<WeComConfig>({
    corpId: "",
    corpSecret: "",
    agentId: 0,
    callbackToken: "",
    callbackEncodingAESKey: "",
    autoApprovePermissions: true,
  });
  const [wecomConfigOpen, setWecomConfigOpen] = createSignal(false);
  const [wecomLoading, setWecomLoading] = createSignal(false);

  const [teamsStatus, setTeamsStatus] = createSignal<ChannelInfo | null>(null);
  const [teamsConfig, setTeamsConfig] = createSignal<TeamsConfig>({
    microsoftAppId: "",
    microsoftAppPassword: "",
    tenantId: "",
    autoApprovePermissions: true,
    streamingThrottleMs: 1500,
  });
  const [teamsConfigOpen, setTeamsConfigOpen] = createSignal(false);
  const [teamsLoading, setTeamsLoading] = createSignal(false);

  const dingtalkFields = (): ConfigField[] => ([
    { key: "appKey", label: t().channel.appKey, type: "text", placeholder: t().channel.appKeyPlaceholder, required: true },
    { key: "appSecret", label: t().channel.appSecret, type: "password", placeholder: t().channel.appSecretPlaceholder, required: true },
    { key: "robotCode", label: t().channel.robotCode, type: "text", placeholder: t().channel.robotCodePlaceholder },
    { key: "autoApprovePermissions", label: t().channel.autoApprove, type: "toggle", disabled: true },
  ]);

  const telegramFields = (): ConfigField[] => ([
    { key: "botToken", label: t().channel.botToken, type: "password", placeholder: t().channel.botTokenPlaceholder, required: true },
    { key: "webhookUrl", label: t().channel.webhookUrl, type: "text", placeholder: t().channel.webhookUrlPlaceholder },
    { key: "autoApprovePermissions", label: t().channel.autoApprove, type: "toggle", disabled: true },
  ]);

  const wecomFields = (): ConfigField[] => ([
    { key: "corpId", label: t().channel.corpId, type: "text", placeholder: t().channel.corpIdPlaceholder, required: true },
    { key: "corpSecret", label: t().channel.corpSecret, type: "password", placeholder: t().channel.corpSecretPlaceholder, required: true },
    { key: "agentId", label: t().channel.agentId, type: "number", placeholder: t().channel.agentIdPlaceholder, required: true },
    { key: "callbackToken", label: t().channel.callbackToken, type: "text", placeholder: t().channel.callbackTokenPlaceholder, required: true },
    { key: "callbackEncodingAESKey", label: t().channel.callbackEncodingAESKey, type: "password", placeholder: t().channel.callbackEncodingAESKeyPlaceholder, required: true },
    { key: "autoApprovePermissions", label: t().channel.autoApprove, type: "toggle", disabled: true },
  ]);

  const teamsFields = (): ConfigField[] => ([
    { key: "microsoftAppId", label: t().channel.microsoftAppId, type: "text", placeholder: t().channel.microsoftAppIdPlaceholder, required: true },
    { key: "microsoftAppPassword", label: t().channel.microsoftAppPassword, type: "password", placeholder: t().channel.microsoftAppPasswordPlaceholder, required: true },
    { key: "tenantId", label: t().channel.tenantId, type: "text", placeholder: t().channel.tenantIdPlaceholder },
    { key: "autoApprovePermissions", label: t().channel.autoApprove, type: "toggle", disabled: true },
  ]);

  const loadTunnelStatus = async () => {
    try {
      if (isElectron()) {
        const info = await tunnelAPI.getStatus();
        if (info) setTunnelInfo(info);
        return;
      }

      const response = await fetch("/api/tunnel/status");
      if (!response.ok) return;
      const info = await response.json() as TunnelInfo;
      setTunnelInfo(info);
    } catch (error) {
      logger.error("[ChannelManagementSettings] Failed to load tunnel status:", error);
    }
  };

  const refreshStatus = async (
    type: string,
    setStatus: (status: ChannelInfo | null) => void,
  ) => {
    const status = await channelAPI.getStatus(type);
    setStatus(status);
  };

  const refreshStatusAfterStart = async (
    type: string,
    setStatus: (status: ChannelInfo | null) => void,
  ) => {
    await pause(1500);
    await refreshStatus(type, setStatus);
  };

  const loadFeishuStatus = async () => {
    try {
      await refreshStatus("feishu", setFeishuStatus);
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
    } catch (error) {
      logger.error("[ChannelManagementSettings] Failed to load Feishu:", error);
    }
  };

  const loadDingtalkStatus = async () => {
    try {
      await refreshStatus("dingtalk", setDingtalkStatus);
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
    } catch (error) {
      logger.error("[ChannelManagementSettings] Failed to load DingTalk:", error);
    }
  };

  const loadTelegramStatus = async () => {
    try {
      await refreshStatus("telegram", setTelegramStatus);
      const config = await channelAPI.getConfig("telegram");
      if (config?.options) {
        setTelegramConfig({
          botToken: (config.options.botToken as string) || "",
          webhookUrl: (config.options.webhookUrl as string) || "",
          autoApprovePermissions: config.options.autoApprovePermissions !== false,
          streamingThrottleMs: (config.options.streamingThrottleMs as number) || 1500,
        });
      }
    } catch (error) {
      logger.error("[ChannelManagementSettings] Failed to load Telegram:", error);
    }
  };

  const loadWecomStatus = async () => {
    try {
      await refreshStatus("wecom", setWecomStatus);
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
    } catch (error) {
      logger.error("[ChannelManagementSettings] Failed to load WeCom:", error);
    }
  };

  const loadTeamsStatus = async () => {
    try {
      await refreshStatus("teams", setTeamsStatus);
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
    } catch (error) {
      logger.error("[ChannelManagementSettings] Failed to load Teams:", error);
    }
  };

  const loadAll = async () => {
    await loadTunnelStatus();
    await Promise.all([
      loadFeishuStatus(),
      loadDingtalkStatus(),
      loadTelegramStatus(),
      loadWecomStatus(),
      loadTeamsStatus(),
    ]);
  };

  onMount(async () => {
    await loadAll();

    const startup = isElectron() ? getElectronAPI()?.startup : null;
    if (startup?.onReady) {
      startup.onReady(() => {
        void loadAll();
      });
    }
  });

  const handleFeishuToggle = async () => {
    const isRunning = feishuStatus()?.status === "running" || feishuStatus()?.status === "starting";
    setFeishuLoading(true);
    try {
      if (isRunning) {
        await channelAPI.stop("feishu");
        setFeishuStatus({ type: "feishu", name: "feishu", status: "stopped" });
      } else {
        const config = feishuConfig();
        if (!config.appId || !config.appSecret) {
          setFeishuConfigOpen(true);
          return;
        }
        await channelAPI.start("feishu");
        await refreshStatusAfterStart("feishu", setFeishuStatus);
      }
    } catch (error) {
      logger.error("[ChannelManagementSettings] Failed to toggle Feishu:", error);
      await refreshStatus("feishu", setFeishuStatus);
    } finally {
      setFeishuLoading(false);
    }
  };

  const handleFeishuConfigSave = async (config: FeishuConfig) => {
    await channelAPI.updateConfig("feishu", { options: config });
    setFeishuConfig(config);

    if (feishuStatus()?.status !== "running") {
      try {
        await channelAPI.start("feishu");
        await refreshStatusAfterStart("feishu", setFeishuStatus);
      } catch (error) {
        logger.error("[ChannelManagementSettings] Failed to start Feishu after save:", error);
        await refreshStatus("feishu", setFeishuStatus);
      }
    }
  };

  const handleDingtalkToggle = async () => {
    const isRunning = dingtalkStatus()?.status === "running" || dingtalkStatus()?.status === "starting";
    setDingtalkLoading(true);
    try {
      if (isRunning) {
        await channelAPI.stop("dingtalk");
        setDingtalkStatus({ type: "dingtalk", name: "dingtalk", status: "stopped" });
      } else {
        const config = dingtalkConfig();
        if (!config.appKey || !config.appSecret) {
          setDingtalkConfigOpen(true);
          return;
        }
        await channelAPI.start("dingtalk");
        await refreshStatusAfterStart("dingtalk", setDingtalkStatus);
      }
    } catch (error) {
      logger.error("[ChannelManagementSettings] Failed to toggle DingTalk:", error);
      await refreshStatus("dingtalk", setDingtalkStatus);
    } finally {
      setDingtalkLoading(false);
    }
  };

  const handleDingtalkConfigSave = async (config: Record<string, unknown>) => {
    await channelAPI.updateConfig("dingtalk", { options: config });
    setDingtalkConfig(config as DingTalkConfig);

    if (dingtalkStatus()?.status !== "running") {
      try {
        await channelAPI.start("dingtalk");
        await refreshStatusAfterStart("dingtalk", setDingtalkStatus);
      } catch (error) {
        logger.error("[ChannelManagementSettings] Failed to start DingTalk after save:", error);
        await refreshStatus("dingtalk", setDingtalkStatus);
      }
    }
  };

  const handleTelegramToggle = async () => {
    const isRunning = telegramStatus()?.status === "running" || telegramStatus()?.status === "starting";
    setTelegramLoading(true);
    try {
      if (isRunning) {
        await channelAPI.stop("telegram");
        setTelegramStatus({ type: "telegram", name: "telegram", status: "stopped" });
      } else {
        const config = telegramConfig();
        if (!config.botToken) {
          setTelegramConfigOpen(true);
          return;
        }
        await channelAPI.start("telegram");
        await refreshStatusAfterStart("telegram", setTelegramStatus);
      }
    } catch (error) {
      logger.error("[ChannelManagementSettings] Failed to toggle Telegram:", error);
      await refreshStatus("telegram", setTelegramStatus);
    } finally {
      setTelegramLoading(false);
    }
  };

  const handleTelegramConfigSave = async (config: Record<string, unknown>) => {
    await channelAPI.updateConfig("telegram", { options: config });
    setTelegramConfig(config as TelegramConfig);

    if (telegramStatus()?.status !== "running") {
      try {
        await channelAPI.start("telegram");
        await refreshStatusAfterStart("telegram", setTelegramStatus);
      } catch (error) {
        logger.error("[ChannelManagementSettings] Failed to start Telegram after save:", error);
        await refreshStatus("telegram", setTelegramStatus);
      }
    }
  };

  const handleWecomToggle = async () => {
    const isRunning = wecomStatus()?.status === "running" || wecomStatus()?.status === "starting";
    setWecomLoading(true);
    try {
      if (isRunning) {
        await channelAPI.stop("wecom");
        setWecomStatus({ type: "wecom", name: "wecom", status: "stopped" });
      } else {
        const config = wecomConfig();
        if (!config.corpId || !config.corpSecret || !config.agentId || !config.callbackToken || !config.callbackEncodingAESKey) {
          setWecomConfigOpen(true);
          return;
        }
        await channelAPI.start("wecom");
        await refreshStatusAfterStart("wecom", setWecomStatus);
      }
    } catch (error) {
      logger.error("[ChannelManagementSettings] Failed to toggle WeCom:", error);
      await refreshStatus("wecom", setWecomStatus);
    } finally {
      setWecomLoading(false);
    }
  };

  const handleWecomConfigSave = async (config: Record<string, unknown>) => {
    await channelAPI.updateConfig("wecom", { options: config });
    setWecomConfig(config as WeComConfig);

    if (wecomStatus()?.status !== "running") {
      try {
        await channelAPI.start("wecom");
        await refreshStatusAfterStart("wecom", setWecomStatus);
      } catch (error) {
        logger.error("[ChannelManagementSettings] Failed to start WeCom after save:", error);
        await refreshStatus("wecom", setWecomStatus);
      }
    }
  };

  const handleTeamsToggle = async () => {
    const isRunning = teamsStatus()?.status === "running" || teamsStatus()?.status === "starting";
    setTeamsLoading(true);
    try {
      if (isRunning) {
        await channelAPI.stop("teams");
        setTeamsStatus({ type: "teams", name: "teams", status: "stopped" });
      } else {
        const config = teamsConfig();
        if (!config.microsoftAppId || !config.microsoftAppPassword) {
          setTeamsConfigOpen(true);
          return;
        }
        await channelAPI.start("teams");
        await refreshStatusAfterStart("teams", setTeamsStatus);
      }
    } catch (error) {
      logger.error("[ChannelManagementSettings] Failed to toggle Teams:", error);
      await refreshStatus("teams", setTeamsStatus);
    } finally {
      setTeamsLoading(false);
    }
  };

  const handleTeamsConfigSave = async (config: Record<string, unknown>) => {
    await channelAPI.updateConfig("teams", { options: config });
    setTeamsConfig(config as TeamsConfig);

    if (teamsStatus()?.status !== "running") {
      try {
        await channelAPI.start("teams");
        await refreshStatusAfterStart("teams", setTeamsStatus);
      } catch (error) {
        logger.error("[ChannelManagementSettings] Failed to start Teams after save:", error);
        await refreshStatus("teams", setTeamsStatus);
      }
    }
  };

  const renderWebhookFooter = (status: ChannelInfo | null) => {
    if (tunnelInfo().status !== "running" || !tunnelInfo().url || status?.status !== "running" || !status?.webhookMeta?.path) {
      return undefined;
    }

    return (
      <p class="text-xs text-gray-600 dark:text-gray-300 break-all">
        <span class="text-gray-500 dark:text-gray-500">{t().channel.webhookEndpoint}:</span>{" "}
        {`${tunnelInfo().url}${status.webhookMeta.path}`}
      </p>
    );
  };

  return (
    <section>
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 px-1">
        {t().channel.channels}
      </h2>

      <div class="space-y-5">
        <div>
          <div class="flex items-center gap-2 mb-3 px-1">
            <h3 class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">{t().channel.directConnect}</h3>
            <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400">
              {t().channel.directConnectBadge}
            </span>
            <div class="flex-1 h-px bg-gray-100 dark:bg-slate-800" />
          </div>

          <div class="space-y-3 bg-white dark:bg-slate-800 rounded-xl shadow-xs border border-gray-200 dark:border-slate-700 p-3">
            <ChannelCard
              badge="FS"
              badgeClass="bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400"
              title={t().channel.feishuBot}
              description={t().channel.feishuBotDesc}
              status={feishuStatus()}
              loading={feishuLoading()}
              onConfigure={() => setFeishuConfigOpen(true)}
              onToggle={handleFeishuToggle}
            />

            <ChannelCard
              badge="DT"
              badgeClass="bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
              title={t().channel.dingtalkBot}
              description={t().channel.dingtalkBotDesc}
              status={dingtalkStatus()}
              loading={dingtalkLoading()}
              onConfigure={() => setDingtalkConfigOpen(true)}
              onToggle={handleDingtalkToggle}
            />

            <ChannelCard
              badge="TG"
              badgeClass="bg-sky-100 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400"
              title={t().channel.telegramBot}
              description={t().channel.telegramBotDesc}
              status={telegramStatus()}
              loading={telegramLoading()}
              onConfigure={() => setTelegramConfigOpen(true)}
              onToggle={handleTelegramToggle}
            />
          </div>
        </div>

        <div>
          <div class="flex items-center gap-2 mb-3 px-1">
            <h3 class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">{t().channel.webhookConnect}</h3>
            <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">
              {t().channel.webhookConnectBadge}
            </span>
            <div class="flex-1 h-px bg-gray-100 dark:bg-slate-800" />
          </div>

          <div class="space-y-3 bg-white dark:bg-slate-800 rounded-xl shadow-xs border border-gray-200 dark:border-slate-700 p-3">
            <Show when={tunnelInfo().status !== "running"}>
              <div class="rounded-lg border border-amber-200 dark:border-amber-900/30 bg-amber-50 dark:bg-amber-900/10 p-3">
                <span class="text-xs font-medium text-amber-700 dark:text-amber-400">{t().channel.tunnelRequired}</span>
                <span class="text-xs text-amber-600 dark:text-amber-400/80 ml-1">— {t().channel.tunnelRequiredDesc}</span>
              </div>
            </Show>

            <div class={tunnelInfo().status !== "running" ? "opacity-55" : ""}>
              <ChannelCard
                badge="MS"
                badgeClass="bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400"
                title={t().channel.teamsBot}
                description={t().channel.teamsBotDesc}
                status={teamsStatus()}
                loading={teamsLoading()}
                onConfigure={() => setTeamsConfigOpen(true)}
                onToggle={handleTeamsToggle}
                footer={renderWebhookFooter(teamsStatus())}
              />
            </div>

            <div class={tunnelInfo().status !== "running" ? "opacity-55" : ""}>
              <ChannelCard
                badge="WC"
                badgeClass="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400"
                title={t().channel.wecomBot}
                description={t().channel.wecomBotDesc}
                status={wecomStatus()}
                loading={wecomLoading()}
                onConfigure={() => setWecomConfigOpen(true)}
                onToggle={handleWecomToggle}
                footer={renderWebhookFooter(wecomStatus())}
              />
            </div>
          </div>
        </div>
      </div>

      <FeishuConfigModal
        isOpen={feishuConfigOpen()}
        onClose={() => setFeishuConfigOpen(false)}
        initialConfig={feishuConfig()}
        onSave={handleFeishuConfigSave}
      />

      <ChannelConfigModal
        isOpen={dingtalkConfigOpen()}
        onClose={() => setDingtalkConfigOpen(false)}
        title={t().channel.dingtalkBot}
        fields={dingtalkFields()}
        initialConfig={dingtalkConfig()}
        onSave={handleDingtalkConfigSave}
      />

      <ChannelConfigModal
        isOpen={telegramConfigOpen()}
        onClose={() => setTelegramConfigOpen(false)}
        title={t().channel.telegramBot}
        fields={telegramFields()}
        initialConfig={telegramConfig()}
        onSave={handleTelegramConfigSave}
      />

      <ChannelConfigModal
        isOpen={wecomConfigOpen()}
        onClose={() => setWecomConfigOpen(false)}
        title={t().channel.wecomBot}
        fields={wecomFields()}
        initialConfig={wecomConfig()}
        onSave={handleWecomConfigSave}
      />

      <ChannelConfigModal
        isOpen={teamsConfigOpen()}
        onClose={() => setTeamsConfigOpen(false)}
        title={t().channel.teamsBot}
        fields={teamsFields()}
        initialConfig={teamsConfig()}
        onSave={handleTeamsConfigSave}
      />
    </section>
  );
}
