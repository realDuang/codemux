import { createEffect, createMemo, createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import { remoteAccessAPI, type RemoteAccessStatus, type RemoteAccessUpdate, type RemoteAccessMode } from "../lib/electron-api";
import { useI18n } from "../lib/i18n";
import { CustomAccessSettings } from "./CustomAccessSettings";

interface RemoteAccessSettingsProps {
  status: RemoteAccessStatus;
  onChanged: (status: RemoteAccessStatus) => void;
}

export function RemoteAccessSettings(props: RemoteAccessSettingsProps) {
  const { t } = useI18n();
  const id = createUniqueId();
  const [provider, setProvider] = createSignal<Exclude<RemoteAccessMode, "off">>("custom");
  const [hostname, setHostname] = createSignal(props.status.tunnelConfig.hostname ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);
  let disposed = false;
  const enabled = () => props.status.mode !== "off";

  const activeMode = createMemo(() => props.status.mode);
  const savedHostname = createMemo(() => props.status.tunnelConfig.hostname ?? "");
  createEffect(() => { const mode = activeMode(); if (mode !== "off") setProvider(mode); });
  createEffect(() => setHostname(savedHostname()));

  const refresh = async () => {
    try {
      const status = await remoteAccessAPI.getStatus();
      if (!disposed && !busy()) { props.onChanged(status); setLoaded(true); }
    } catch { if (!disposed) setError(t().remote.accessUpdateFailed); }
  };
  void refresh();
  const timer = setInterval(() => { if (!busy()) void refresh(); }, 2000);
  onCleanup(() => { disposed = true; clearInterval(timer); });

  const update = async (patch: RemoteAccessUpdate) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try { props.onChanged(await remoteAccessAPI.update(patch)); }
    catch {
      setError(t().remote.accessUpdateFailed);
      try { props.onChanged(await remoteAccessAPI.getStatus()); } catch { /* Keep the last confirmed state. */ }
    } finally { setBusy(false); }
  };

  const handleToggle = () => {
    if (enabled()) { void update({ mode: "off" }); return; }
    if (provider() === "custom" && !props.status.customAccessUrl) {
      setError(t().remote.accessUrlRequired);
      return;
    }
    void update({ mode: provider() });
  };
  const handleProvider = (value: "custom" | "cloudflare") => {
    if (value === provider()) return;
    if (enabled()) {
      if (value === "custom" && !props.status.customAccessUrl) { setError(t().remote.accessUrlRequired); return; }
      void update({ mode: value });
    } else { setProvider(value); setError(""); }
  };

  return (
    <div class="space-y-4">
      <div class="rounded-lg border border-[var(--cm-hairline-strong)] p-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <h3 id={`${id}-title`} class="text-sm font-medium text-gray-900 dark:text-white">{t().remote.publicAccessTab}</h3>
            <p id={`${id}-description`} class="text-xs text-gray-500 dark:text-gray-400 mt-1">
              <Show when={enabled()} fallback={t().remote.accessOffDescription}>
                <Show when={props.status.tunnel.status === "starting" && provider() === "cloudflare"} fallback={t().remote.accessOnDescription}>{t().remote.starting}</Show>
              </Show>
            </p>
          </div>
          <button type="button" role="switch" aria-checked={enabled()} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
            disabled={busy() || !loaded()} onClick={handleToggle}
            class={`relative h-7 w-12 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50 ${enabled() ? "bg-blue-600" : "bg-gray-200 dark:bg-slate-700"}`}>
            <span class={`block h-6 w-6 rounded-full bg-white shadow transition-transform ${enabled() ? "translate-x-5" : "translate-x-0"}`} />
          </button>
        </div>
        <fieldset disabled={busy() || !loaded()} class="mt-5">
          <legend class="text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">{t().remote.accessMethod}</legend>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label class={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer ${provider() === "custom" ? "border-blue-500 bg-blue-50 dark:bg-blue-900/15" : "border-[var(--cm-hairline-strong)]"}`}>
              <input type="radio" name={`${id}-provider`} value="custom" checked={provider() === "custom"} onChange={() => handleProvider("custom")} class="mt-1 accent-blue-600" />
              <span><span class="block text-sm font-medium">{t().remote.customAccessTitle}</span><span class="block mt-1 text-xs text-gray-500 dark:text-gray-400">{t().remote.accessCustomMethod}</span></span>
            </label>
            <label class={`flex items-start gap-3 p-3 rounded-lg border ${provider() === "cloudflare" ? "border-blue-500 bg-blue-50 dark:bg-blue-900/15" : "border-[var(--cm-hairline-strong)]"} ${props.status.cloudflareAvailable ? "cursor-pointer" : "opacity-50"}`}>
              <input type="radio" name={`${id}-provider`} value="cloudflare" checked={provider() === "cloudflare"} disabled={!props.status.cloudflareAvailable} onChange={() => handleProvider("cloudflare")} class="mt-1 accent-blue-600" />
              <span><span class="block text-sm font-medium">{t().remote.accessCloudflare}</span><span class="block mt-1 text-xs text-gray-500 dark:text-gray-400">{t().remote.accessCloudflareMethod}</span></span>
            </label>
          </div>
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">{t().remote.accessExclusive}</p>
        </fieldset>
        <Show when={busy()}><p role="status" class="mt-3 text-xs text-blue-600 dark:text-blue-400">{t().remote.accessSwitching}</p></Show>
        <Show when={error()}><p role="alert" class="mt-3 text-xs text-red-600 dark:text-red-400">{error()}</p></Show>
      </div>
      <Show when={provider() === "custom"}>
        <CustomAccessSettings value={props.status.customAccessUrl} disabled={busy() || !loaded()} onSaved={() => void refresh()} />
      </Show>
      <Show when={provider() === "cloudflare"}>
        <form class="rounded-lg border border-[var(--cm-hairline-strong)] p-4" onSubmit={event => { event.preventDefault(); void update({ tunnelConfig: { hostname: hostname() } }); }}>
          <label for={`${id}-hostname`} class="text-sm font-medium">{t().remote.namedTunnel}</label>
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">{t().remote.namedTunnelDesc}</p>
          <input id={`${id}-hostname`} value={hostname()} onInput={event => setHostname(event.currentTarget.value)} disabled={busy() || !loaded()}
            placeholder={t().remote.tunnelHostnamePlaceholder} class="mt-3 w-full px-3 py-2 text-sm rounded-md border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] dark:bg-[var(--cm-surface-2)]" />
          <button type="submit" disabled={busy() || !loaded()} class="mt-3 px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white disabled:opacity-50">{t().common.save}</button>
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">{t().remote.namedTunnelSetupHint}</p>
        </form>
      </Show>
    </div>
  );
}
