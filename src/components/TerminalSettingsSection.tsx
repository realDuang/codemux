import { createSignal, createEffect, For, onMount, Show } from "solid-js";
import { gateway, gatewayConnected } from "../lib/gateway-api";
import { useI18n } from "../lib/i18n";
import { logger } from "../lib/logger";
import { getNestedSetting, saveNestedSetting } from "../lib/settings";
import type { TerminalProfile } from "../types/unified";

type GpuMode = "auto" | "canvas" | "dom";

/**
 * Settings panel for the integrated terminal:
 *   - Default profile dropdown (populated from `terminal.profiles.list`)
 *   - GPU acceleration mode (Auto / Canvas / DOM)
 *
 * Custom-profile editing is intentionally out of scope for v1; users edit
 * `terminal.customProfiles` in `settings.json` directly.
 */
export function TerminalSettingsSection() {
  const { t } = useI18n();
  const [profiles, setProfiles] = createSignal<TerminalProfile[]>([]);
  const [defaultId, setDefaultId] = createSignal<string>(
    getNestedSetting<string>("terminal.defaultProfile") ?? "",
  );
  const [gpuMode, setGpuMode] = createSignal<GpuMode>(
    (getNestedSetting<GpuMode>("terminal.gpuAcceleration") ?? "auto") as GpuMode,
  );
  const [loading, setLoading] = createSignal(false);

  async function loadProfiles(refresh = false) {
    if (!gatewayConnected()) return;
    setLoading(true);
    try {
      const res = await gateway.listTerminalProfiles(refresh);
      setProfiles(res.profiles);
      // If user hasn't picked a default yet, surface the server-resolved one.
      if (!getNestedSetting<string>("terminal.defaultProfile") && res.defaultProfileId) {
        setDefaultId(res.defaultProfileId);
      }
    } catch (err) {
      logger.warn("[TerminalSettings] load failed:", err);
    } finally {
      setLoading(false);
    }
  }

  onMount(() => {
    void loadProfiles();
  });

  // Re-fetch when gateway reconnects.
  createEffect(() => {
    if (gatewayConnected() && profiles().length === 0) {
      void loadProfiles();
    }
  });

  async function handleDefaultChange(value: string) {
    setDefaultId(value);
    // Await the persist before refreshing so the server's next list call is
    // guaranteed to see the new default. Without the await, the cached value
    // could be stale if `loadProfiles(true)` races ahead of the disk write.
    try {
      await saveNestedSetting("terminal.defaultProfile", value);
    } catch (err) {
      logger.warn("[TerminalSettings] save default failed:", err);
    }
    // Server caches the default for ~5 min; refresh to force pickup on next list.
    void loadProfiles(true);
  }

  function handleGpuChange(value: GpuMode) {
    setGpuMode(value);
    void saveNestedSetting("terminal.gpuAcceleration", value);
  }

  return (
    <section id="section-terminal">
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 px-1">
        {t().terminal.settingsSectionTitle}
      </h2>
      <div class="bg-white dark:bg-slate-800 rounded-xl shadow-xs border border-gray-200 dark:border-slate-700 overflow-visible">
        <p class="px-4 sm:px-6 pt-4 sm:pt-6 text-sm text-gray-500 dark:text-gray-400">
          {t().terminal.settingsSectionDesc}
        </p>

        {/* Default profile */}
        <div class="p-4 sm:p-6 flex items-center justify-between gap-4 border-b border-gray-200 dark:border-slate-700">
          <div class="min-w-0">
            <h3 class="text-base font-medium text-gray-900 dark:text-white">
              {t().terminal.settingsDefaultProfile}
            </h3>
            <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {t().terminal.settingsDefaultProfileDesc}
            </p>
          </div>
          <div class="flex-shrink-0">
            <Show
              when={profiles().length > 0}
              fallback={
                <span class="text-xs text-gray-400 dark:text-gray-500">
                  {loading() ? "…" : t().terminal.profileNoneFound}
                </span>
              }
            >
              <select
                value={defaultId()}
                onChange={(e) => handleDefaultChange(e.currentTarget.value)}
                class="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <For each={profiles()}>
                  {(profile) => (
                    <option value={profile.id}>{profile.name}</option>
                  )}
                </For>
              </select>
            </Show>
          </div>
        </div>

        {/* GPU acceleration */}
        <div class="p-4 sm:p-6 flex items-center justify-between gap-4">
          <div class="min-w-0">
            <h3 class="text-base font-medium text-gray-900 dark:text-white">
              {t().terminal.settingsGpuMode}
            </h3>
            <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {t().terminal.settingsGpuModeDesc}
            </p>
          </div>
          <div class="flex-shrink-0">
            <select
              value={gpuMode()}
              onChange={(e) => handleGpuChange(e.currentTarget.value as GpuMode)}
              class="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="auto">{t().terminal.settingsGpuAuto}</option>
              <option value="canvas">{t().terminal.settingsGpuCanvas}</option>
              <option value="dom">{t().terminal.settingsGpuDom}</option>
            </select>
          </div>
        </div>
      </div>
    </section>
  );
}
