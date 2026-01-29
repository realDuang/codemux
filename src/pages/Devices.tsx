import { createSignal, createResource, For, Show, onMount, type JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Auth, type DeviceInfo } from "../lib/auth";
import { useI18n, formatMessage } from "../lib/i18n";
import { isElectron } from "../lib/platform";

// ============================================================================
// Helper Functions
// ============================================================================

function formatRelativeTime(timestamp: number, translations: ReturnType<ReturnType<typeof useI18n>["t"]>): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return translations.devices.justNow;
  if (minutes < 60) return formatMessage(translations.devices.minutesAgo, { count: minutes });
  if (hours < 24) return formatMessage(translations.devices.hoursAgo, { count: hours });
  return formatMessage(translations.devices.daysAgo, { count: days });
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getDeviceIcon(platform: string): string {
  const icons: Record<string, string> = {
    ios: "📱",
    android: "📱",
    macos: "💻",
    windows: "🖥️",
    linux: "🐧",
  };
  return icons[platform.toLowerCase()] || "💻";
}

// ============================================================================
// DeviceCard Component
// ============================================================================

interface DeviceCardProps {
  device: DeviceInfo;
  isCurrent: boolean;
  isRenaming: boolean;
  isLoading: boolean;
  newName: string;
  onNewNameChange: (name: string) => void;
  onStartRename: () => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  onRevoke?: () => void;
  subtitle: JSX.Element;
}

function DeviceCard(props: DeviceCardProps) {
  const { t } = useI18n();

  const borderClass = props.isCurrent
    ? "border-2 border-blue-500 dark:border-blue-600"
    : "border border-gray-200 dark:border-zinc-800";

  return (
    <div class={`bg-white dark:bg-zinc-900 rounded-xl ${borderClass} shadow-xs overflow-hidden`}>
      <div class="p-5">
        <div class="flex items-start justify-between">
          <div class="flex items-start gap-3">
            <span class="text-2xl">{getDeviceIcon(props.device.platform)}</span>
            <div>
              <div class="flex items-center gap-2">
                <Show
                  when={props.isRenaming}
                  fallback={<h3 class="font-semibold text-gray-900 dark:text-white">{props.device.name}</h3>}
                >
                  <input
                    type="text"
                    value={props.newName}
                    onInput={(e) => props.onNewNameChange(e.currentTarget.value)}
                    class="px-2 py-1 text-sm border rounded dark:bg-zinc-800 dark:border-zinc-700"
                    placeholder={t().devices.renameDevicePlaceholder}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") props.onConfirmRename();
                      if (e.key === "Escape") props.onCancelRename();
                    }}
                    autofocus
                  />
                </Show>
                <Show when={props.isCurrent}>
                  <span class="px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 rounded-full">
                    {t().devices.currentDevice}
                  </span>
                </Show>
                <Show when={props.device.isHost}>
                  <span class="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 rounded-full">
                    {t().devices.hostDevice}
                  </span>
                </Show>
              </div>
              {props.subtitle}
              <p class="text-xs text-gray-400 dark:text-gray-500 mt-1">
                {t().devices.firstLogin}: {formatDate(props.device.createdAt)}
              </p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <Show
              when={props.isRenaming}
              fallback={
                <>
                  <button
                    onClick={props.onStartRename}
                    class="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                  >
                    {t().devices.rename}
                  </button>
                  <Show when={props.onRevoke}>
                    <button
                      onClick={props.onRevoke}
                      disabled={props.isLoading}
                      class="text-sm text-red-500 hover:text-red-700 disabled:opacity-50"
                    >
                      {props.isLoading ? "..." : t().devices.revoke}
                    </button>
                  </Show>
                </>
              }
            >
              <button
                onClick={props.onConfirmRename}
                disabled={props.isLoading}
                class="text-sm text-blue-600 hover:text-blue-700"
              >
                {t().common.save}
              </button>
              <button
                onClick={props.onCancelRename}
                class="text-sm text-gray-500 hover:text-gray-700"
              >
                {t().common.cancel}
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function Devices() {
  const navigate = useNavigate();
  const { t } = useI18n();

  // Devices page is only accessible in host mode (Electron OR localhost web)
  // Remote web clients should be redirected to chat
  onMount(async () => {
    if (!isElectron()) {
      // Check if this is localhost web access
      const isLocalAccess = await Auth.isLocalAccess();
      if (!isLocalAccess) {
        navigate("/chat", { replace: true });
      }
    }
  });

  const [devicesData, { refetch }] = createResource(() => Auth.getDevices());
  const [renamingDevice, setRenamingDevice] = createSignal<string | null>(null);
  const [newName, setNewName] = createSignal("");
  const [actionLoading, setActionLoading] = createSignal<string | null>(null);

  const currentDeviceId = () => devicesData()?.currentDeviceId;
  const devices = () => devicesData()?.devices || [];
  const currentDevice = () => devices().find((d) => d.id === currentDeviceId());
  const otherDevices = () => devices().filter((d) => d.id !== currentDeviceId());

  const handleRevoke = async (deviceId: string) => {
    if (!confirm(t().devices.revokeConfirm)) return;
    setActionLoading(deviceId);
    const success = await Auth.revokeDevice(deviceId);
    setActionLoading(null);
    if (success) refetch();
  };

  const handleRevokeOthers = async () => {
    if (!confirm(t().devices.revokeOthersConfirm)) return;
    setActionLoading("revoke-others");
    const result = await Auth.revokeOtherDevices();
    setActionLoading(null);
    if (result.success && result.revokedCount !== undefined) {
      alert(formatMessage(t().devices.revokeOthersSuccess, { count: result.revokedCount }));
      refetch();
    }
  };

  const startRename = (device: DeviceInfo) => {
    setRenamingDevice(device.id);
    setNewName(device.name);
  };

  const cancelRename = () => {
    setRenamingDevice(null);
    setNewName("");
  };

  const confirmRename = async (deviceId: string) => {
    if (!newName().trim()) return;
    setActionLoading(deviceId);
    const success = await Auth.renameDevice(deviceId, newName().trim());
    setActionLoading(null);
    if (success) {
      setRenamingDevice(null);
      setNewName("");
      refetch();
    }
  };

  return (
    <div class="flex flex-col h-screen bg-gray-50/50 dark:bg-zinc-950 font-sans text-gray-900 dark:text-gray-100 electron-safe-top">
      {/* Header */}
      <header class="sticky top-0 z-10 backdrop-blur-md bg-white/70 dark:bg-zinc-900/70 border-b border-gray-200 dark:border-zinc-800 px-4 h-14 flex items-center justify-between electron-drag-region">
        <div class="flex items-center gap-2 electron-no-drag">
          <button
            onClick={() => navigate("/")}
            class="p-2 -ml-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-600 dark:text-gray-400 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m15 18-6-6 6-6"/>
            </svg>
          </button>
          <h1 class="font-semibold text-lg">{t().devices.title}</h1>
        </div>
      </header>

      {/* Main Content */}
      <main class="flex-1 overflow-y-auto p-4 md:p-6">
        <div class="max-w-2xl mx-auto space-y-6">
          {/* Loading State */}
          <Show when={devicesData.loading}>
            <div class="flex justify-center py-8">
              <div class="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
            </div>
          </Show>

          <Show when={!devicesData.loading && devices().length > 0}>
            {/* Current Device */}
            <Show when={currentDevice()}>
              {(device) => (
                <DeviceCard
                  device={device()}
                  isCurrent={true}
                  isRenaming={renamingDevice() === device().id}
                  isLoading={actionLoading() === device().id}
                  newName={newName()}
                  onNewNameChange={setNewName}
                  onStartRename={() => startRename(device())}
                  onConfirmRename={() => confirmRename(device().id)}
                  onCancelRename={cancelRename}
                  subtitle={
                    <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      {device().platform} · {device().browser}
                    </p>
                  }
                />
              )}
            </Show>

            {/* Other Devices */}
            <Show when={otherDevices().length > 0}>
              <div class="space-y-3">
                <For each={otherDevices()}>
                  {(device) => (
                    <DeviceCard
                      device={device}
                      isCurrent={false}
                      isRenaming={renamingDevice() === device.id}
                      isLoading={actionLoading() === device.id}
                      newName={newName()}
                      onNewNameChange={setNewName}
                      onStartRename={() => startRename(device)}
                      onConfirmRename={() => confirmRename(device.id)}
                      onCancelRename={cancelRename}
                      onRevoke={() => handleRevoke(device.id)}
                      subtitle={
                        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                          {device.platform} · {device.browser} · {t().devices.lastSeen}: {formatRelativeTime(device.lastSeenAt, t())}
                        </p>
                      }
                    />
                  )}
                </For>
              </div>

              {/* Revoke All Others Button */}
              <div class="pt-4">
                <button
                  onClick={handleRevokeOthers}
                  disabled={actionLoading() === "revoke-others"}
                  class="w-full py-3 px-4 bg-red-50 dark:bg-red-900/10 text-red-600 dark:text-red-400 font-medium rounded-xl border border-red-200 dark:border-red-900/30 hover:bg-red-100 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                >
                  {actionLoading() === "revoke-others" ? "..." : t().devices.revokeOthers}
                </button>
              </div>
            </Show>

            {/* No Other Devices */}
            <Show when={otherDevices().length === 0}>
              <div class="text-center py-8 text-gray-500 dark:text-gray-400">
                <p>{t().devices.noOtherDevices}</p>
              </div>
            </Show>

            {/* Security Tip */}
            <div class="rounded-xl bg-orange-50 dark:bg-orange-900/10 border border-orange-100 dark:border-orange-900/30 p-4 flex gap-3">
              <svg xmlns="http://www.w3.org/2000/svg" class="shrink-0 text-orange-600 dark:text-orange-400 mt-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
                <line x1="12" x2="12" y1="9" y2="13"/>
                <line x1="12" x2="12.01" y1="17" y2="17"/>
              </svg>
              <p class="text-sm text-orange-800 dark:text-orange-200">
                {t().devices.securityTip}
              </p>
            </div>
          </Show>
        </div>
      </main>
    </div>
  );
}
