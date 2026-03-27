import { createSignal, createEffect, Show } from "solid-js";
import { useI18n } from "../lib/i18n";

interface FeishuConfig {
  platform: "feishu" | "lark";
  appId: string;
  appSecret: string;
  autoApprovePermissions: boolean;
  streamingThrottleMs: number;
}

interface FeishuConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialConfig: FeishuConfig;
  onSave: (config: FeishuConfig) => Promise<void>;
}

export function FeishuConfigModal(props: FeishuConfigModalProps) {
  const { t } = useI18n();
  const [config, setConfig] = createSignal<FeishuConfig>({ ...props.initialConfig });
  const [saving, setSaving] = createSignal(false);

  // Sync local state when modal opens with new initialConfig
  createEffect(() => {
    if (props.isOpen) {
      setConfig({ ...props.initialConfig });
    }
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      await props.onSave(config());
      props.onClose();
    } catch {
      // Error handled by parent
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      props.onClose();
    }
  };

  return (
    <Show when={props.isOpen}>
      <div class="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={handleKeyDown}>
        <div
          class="absolute inset-0 bg-black/50 backdrop-blur-xs"
          onClick={props.onClose}
          aria-hidden="true"
        />

        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="feishu-config-modal-title"
          class="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden flex flex-col max-h-[calc(100vh-2rem)]"
        >
          {/* Header */}
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-slate-800">
            <h2 id="feishu-config-modal-title" class="text-lg font-semibold text-gray-900 dark:text-white">
              {t().channel.feishuBot}
            </h2>
            <button
              onClick={props.onClose}
              class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg transition-colors"
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
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>

          {/* Body */}
          <div class="p-6 space-y-5 overflow-y-auto flex-1">
            {/* Platform */}
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t().channel.platform}
              </label>
              <select
                value={config().platform}
                onChange={(e) => setConfig((prev) => ({ ...prev, platform: e.currentTarget.value as "feishu" | "lark" }))}
                class="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="feishu">{t().channel.platformFeishu}</option>
                <option value="lark">{t().channel.platformLark}</option>
              </select>
              <p class="text-xs text-gray-400 dark:text-gray-500 mt-1.5">
                {t().channel.platformDesc}
              </p>
            </div>
            {/* App ID */}
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t().channel.appId}
              </label>
              <input
                type="text"
                value={config().appId}
                onInput={(e) => setConfig((prev) => ({ ...prev, appId: e.currentTarget.value }))}
                placeholder={t().channel.appIdPlaceholder}
                class="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* App Secret */}
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t().channel.appSecret}
              </label>
              <input
                type="password"
                value={config().appSecret}
                onInput={(e) => setConfig((prev) => ({ ...prev, appSecret: e.currentTarget.value }))}
                placeholder={t().channel.appSecretPlaceholder}
                class="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Auto-approve toggle (always on, not editable) */}
            <div class="flex items-center justify-between">
              <div>
                <h4 class="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t().channel.autoApprove}
                </h4>
                <p class="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                  {t().channel.autoApproveDesc}
                </p>
              </div>
              <button
                disabled
                class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors bg-blue-500 opacity-50 cursor-not-allowed"
              >
                <span class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-6" />
              </button>
            </div>

            {/* Config required hint */}
            <Show when={!config().appId || !config().appSecret}>
              <p class="text-xs text-gray-400 dark:text-gray-500">
                {t().channel.configRequired}
              </p>
            </Show>
          </div>

          {/* Footer */}
          <div class="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 px-6 py-4 border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/50 flex-shrink-0">
            <button
              onClick={props.onClose}
              class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
            >
              {t().common.cancel}
            </button>
            <button
              onClick={handleSave}
              disabled={saving() || !config().appId || !config().appSecret}
              class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
            >
              {saving() ? t().channel.saving : t().common.save}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
