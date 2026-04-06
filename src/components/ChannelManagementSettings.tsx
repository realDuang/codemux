import { Show, For, createSignal, onMount, type JSX, type Accessor } from "solid-js";
import { useI18n } from "../lib/i18n";
import { logger } from "../lib/logger";
import { isElectron } from "../lib/platform";
import { channelAPI, getElectronAPI, tunnelAPI, type ChannelInfo, type TunnelInfo } from "../lib/electron-api";
import { FeishuConfigModal } from "./FeishuConfigModal";
import { ChannelConfigModal, type ConfigField } from "./ChannelConfigModal";

// ---------------------------------------------------------------------------
// Channel registry — each entry drives one ChannelCard + modal
// ---------------------------------------------------------------------------

interface ChannelDef {
  type: string;
  badge: string;
  badgeClass: string;
  titleKey: string;
  descKey: string;
  /** "direct" channels appear in the top group; "webhook" channels need a tunnel */
  connection: "direct" | "webhook";
  defaultConfig: Record<string, unknown>;
  /** Return the config fields for the generic ChannelConfigModal (omit for Feishu). */
  fields?: (t: ReturnType<typeof useI18n>["t"]) => ConfigField[];
  /** Return true when enough required fields are filled to start the channel. */
  isConfigured: (cfg: Record<string, unknown>) => boolean;
}

const channelRegistry: ChannelDef[] = [
  {
    type: "feishu",
    badge: "FS",
    badgeClass: "bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400",
    titleKey: "feishuBot",
    descKey: "feishuBotDesc",
    connection: "direct",
    defaultConfig: { platform: "feishu", appId: "", appSecret: "", autoApprovePermissions: true, streamingThrottleMs: 1500 },
    isConfigured: (c) => !!(c.appId && c.appSecret),
  },
  {
    type: "dingtalk",
    badge: "DT",
    badgeClass: "bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400",
    titleKey: "dingtalkBot",
    descKey: "dingtalkBotDesc",
    connection: "direct",
    defaultConfig: { appKey: "", appSecret: "", robotCode: "", autoApprovePermissions: true, streamingThrottleMs: 1500 },
    fields: (t) => [
      { key: "appKey", label: t().channel.appKey, type: "text", placeholder: t().channel.appKeyPlaceholder, required: true },
      { key: "appSecret", label: t().channel.appSecret, type: "password", placeholder: t().channel.appSecretPlaceholder, required: true },
      { key: "robotCode", label: t().channel.robotCode, type: "text", placeholder: t().channel.robotCodePlaceholder },
      { key: "autoApprovePermissions", label: t().channel.autoApprove, type: "toggle", disabled: true },
    ],
    isConfigured: (c) => !!(c.appKey && c.appSecret),
  },
  {
    type: "telegram",
    badge: "TG",
    badgeClass: "bg-sky-100 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400",
    titleKey: "telegramBot",
    descKey: "telegramBotDesc",
    connection: "direct",
    defaultConfig: { botToken: "", webhookUrl: "", autoApprovePermissions: true, streamingThrottleMs: 1500 },
    fields: (t) => [
      { key: "botToken", label: t().channel.botToken, type: "password", placeholder: t().channel.botTokenPlaceholder, required: true },
      { key: "webhookUrl", label: t().channel.webhookUrl, type: "text", placeholder: t().channel.webhookUrlPlaceholder },
      { key: "autoApprovePermissions", label: t().channel.autoApprove, type: "toggle", disabled: true },
    ],
    isConfigured: (c) => !!c.botToken,
  },
  {
    type: "teams",
    badge: "MS",
    badgeClass: "bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400",
    titleKey: "teamsBot",
    descKey: "teamsBotDesc",
    connection: "webhook",
    defaultConfig: { microsoftAppId: "", microsoftAppPassword: "", tenantId: "", autoApprovePermissions: true, streamingThrottleMs: 1500 },
    fields: (t) => [
      { key: "microsoftAppId", label: t().channel.microsoftAppId, type: "text", placeholder: t().channel.microsoftAppIdPlaceholder, required: true },
      { key: "microsoftAppPassword", label: t().channel.microsoftAppPassword, type: "password", placeholder: t().channel.microsoftAppPasswordPlaceholder, required: true },
      { key: "tenantId", label: t().channel.tenantId, type: "text", placeholder: t().channel.tenantIdPlaceholder },
      { key: "autoApprovePermissions", label: t().channel.autoApprove, type: "toggle", disabled: true },
    ],
    isConfigured: (c) => !!(c.microsoftAppId && c.microsoftAppPassword),
  },
  {
    type: "wecom",
    badge: "WC",
    badgeClass: "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400",
    titleKey: "wecomBot",
    descKey: "wecomBotDesc",
    connection: "webhook",
    defaultConfig: { corpId: "", corpSecret: "", agentId: 0, callbackToken: "", callbackEncodingAESKey: "", autoApprovePermissions: true },
    fields: (t) => [
      { key: "corpId", label: t().channel.corpId, type: "text", placeholder: t().channel.corpIdPlaceholder, required: true },
      { key: "corpSecret", label: t().channel.corpSecret, type: "password", placeholder: t().channel.corpSecretPlaceholder, required: true },
      { key: "agentId", label: t().channel.agentId, type: "number", placeholder: t().channel.agentIdPlaceholder, required: true },
      { key: "callbackToken", label: t().channel.callbackToken, type: "text", placeholder: t().channel.callbackTokenPlaceholder, required: true },
      { key: "callbackEncodingAESKey", label: t().channel.callbackEncodingAESKey, type: "password", placeholder: t().channel.callbackEncodingAESKeyPlaceholder, required: true },
      { key: "autoApprovePermissions", label: t().channel.autoApprove, type: "toggle", disabled: true },
    ],
    isConfigured: (c) => !!(c.corpId && c.corpSecret && c.agentId && c.callbackToken && c.callbackEncodingAESKey),
  },
];

// ---------------------------------------------------------------------------
// Reactive state for a single channel (factory)
// ---------------------------------------------------------------------------

interface ChannelState {
  status: Accessor<ChannelInfo | null>;
  config: Accessor<Record<string, unknown>>;
  configOpen: Accessor<boolean>;
  loading: Accessor<boolean>;
  secretsConfigured: Accessor<string[]>;
  setConfigOpen: (v: boolean) => void;
  load: () => Promise<void>;
  toggle: () => Promise<void>;
  save: (cfg: Record<string, unknown>) => Promise<void>;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createChannelState(def: ChannelDef): ChannelState {
  const [status, setStatus] = createSignal<ChannelInfo | null>(null);
  const [config, setConfig] = createSignal<Record<string, unknown>>({ ...def.defaultConfig });
  const [configOpen, setConfigOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [secretsConfigured, setSecretsConfigured] = createSignal<string[]>([]);

  const refreshStatus = async () => {
    const s = await channelAPI.getStatus(def.type);
    setStatus(s);
  };

  const load = async () => {
    try {
      await refreshStatus();
      const remote = await channelAPI.getConfig(def.type);
      if (remote?.options) {
        const merged = { ...def.defaultConfig };
        const configured = Array.isArray(remote.options.secretsConfigured)
          ? (remote.options.secretsConfigured as string[])
          : [];
        for (const key of Object.keys(merged)) {
          const val = remote.options[key];
          if (val !== undefined && val !== null) {
            merged[key] = val;
          }
        }
        delete merged.secretsConfigured;
        setConfig(merged);
        setSecretsConfigured(configured);
      }
    } catch (error) {
      logger.error(`[ChannelManagement] Failed to load ${def.type}:`, error);
    }
  };

  const toggle = async () => {
    const isRunning = status()?.status === "running" || status()?.status === "starting";
    setLoading(true);
    try {
      if (isRunning) {
        await channelAPI.stop(def.type);
        setStatus({ type: def.type, name: def.type, status: "stopped" });
      } else {
        if (!def.isConfigured(config())) {
          setConfigOpen(true);
          return;
        }
        await channelAPI.start(def.type);
        await pause(1500);
        await refreshStatus();
      }
    } catch (error) {
      logger.error(`[ChannelManagement] Failed to toggle ${def.type}:`, error);
      await refreshStatus();
    } finally {
      setLoading(false);
    }
  };

  const save = async (cfg: Record<string, unknown>) => {
    await channelAPI.updateConfig(def.type, { options: cfg });
    setConfig(cfg);

    if (status()?.status !== "running") {
      try {
        await channelAPI.start(def.type);
        await pause(1500);
        await refreshStatus();
      } catch (error) {
        logger.error(`[ChannelManagement] Failed to start ${def.type} after save:`, error);
        await refreshStatus();
      }
    }
  };

  return { status, config, configOpen, loading, secretsConfigured, setConfigOpen, load, toggle, save };
}

// ---------------------------------------------------------------------------
// ChannelCard — presentational component (unchanged)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ChannelManagementSettings() {
  const { t } = useI18n();

  const [tunnelInfo, setTunnelInfo] = createSignal<TunnelInfo>({
    url: "",
    status: "stopped",
  });

  // Build reactive state for every channel in the registry
  const channels = channelRegistry.map((def) => ({
    def,
    state: createChannelState(def),
  }));

  const directChannels = channels.filter((c) => c.def.connection === "direct");
  const webhookChannels = channels.filter((c) => c.def.connection === "webhook");
  const channelMap = Object.fromEntries(channels.map((c) => [c.def.type, c.state]));

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
      logger.error("[ChannelManagement] Failed to load tunnel status:", error);
    }
  };

  const loadAll = async () => {
    await loadTunnelStatus();
    await Promise.all(channels.map((c) => c.state.load()));
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

  const renderChannelCard = (def: ChannelDef, state: ChannelState, footer?: JSX.Element) => (
    <ChannelCard
      badge={def.badge}
      badgeClass={def.badgeClass}
      title={(t().channel as Record<string, string>)[def.titleKey] ?? def.type}
      description={(t().channel as Record<string, string>)[def.descKey] ?? ""}
      status={state.status()}
      loading={state.loading()}
      onConfigure={() => state.setConfigOpen(true)}
      onToggle={state.toggle}
      footer={footer}
    />
  );

  return (
    <section>
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 px-1">
        {t().channel.channels}
      </h2>

      <div class="space-y-5">
        {/* Direct-connect channels */}
        <div>
          <div class="flex items-center gap-2 mb-3 px-1">
            <h3 class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">{t().channel.directConnect}</h3>
            <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400">
              {t().channel.directConnectBadge}
            </span>
            <div class="flex-1 h-px bg-gray-100 dark:bg-slate-800" />
          </div>

          <div class="space-y-3 bg-white dark:bg-slate-800 rounded-xl shadow-xs border border-gray-200 dark:border-slate-700 p-3">
            <For each={directChannels}>
              {(c) => renderChannelCard(c.def, c.state)}
            </For>
          </div>
        </div>

        {/* Webhook-based channels */}
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

            <For each={webhookChannels}>
              {(c) => (
                <div class={tunnelInfo().status !== "running" ? "opacity-55" : ""}>
                  {renderChannelCard(c.def, c.state, renderWebhookFooter(c.state.status()))}
                </div>
              )}
            </For>
          </div>
        </div>
      </div>

      {/* Feishu uses its own modal */}
      <FeishuConfigModal
        isOpen={channelMap.feishu.configOpen()}
        onClose={() => channelMap.feishu.setConfigOpen(false)}
        initialConfig={channelMap.feishu.config() as Record<string, unknown> & { platform: "feishu" | "lark"; appId: string; appSecret: string; autoApprovePermissions: boolean; streamingThrottleMs: number }}
        secretsConfigured={channelMap.feishu.secretsConfigured()}
        onSave={(cfg) => channelMap.feishu.save(cfg as unknown as Record<string, unknown>)}
      />

      {/* Generic modals for all other channels */}
      <For each={channels.filter((c) => c.def.type !== "feishu" && c.def.fields)}>
        {(c) => (
          <ChannelConfigModal
            isOpen={c.state.configOpen()}
            onClose={() => c.state.setConfigOpen(false)}
            title={(t().channel as Record<string, string>)[c.def.titleKey] ?? c.def.type}
            fields={c.def.fields!(t)}
            initialConfig={c.state.config()}
            secretsConfigured={c.state.secretsConfigured()}
            onSave={c.state.save}
          />
        )}
      </For>
    </section>
  );
}
