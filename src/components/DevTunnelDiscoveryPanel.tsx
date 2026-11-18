import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { DevTunnelDiscoveryResult, DiscoveredDevTunnel } from "../../shared/dev-tunnel-metadata";
import { useI18n } from "../lib/i18n";
import { Spinner } from "./Spinner";

interface DevTunnelDiscoveryPanelProps {
  disabled: boolean;
  onSelect: (tunnel: DiscoveredDevTunnel) => void;
}

export function DevTunnelDiscoveryPanel(props: DevTunnelDiscoveryPanelProps) {
  const { t } = useI18n();
  const api = window.electronAPI?.remoteHosts;
  const [result, setResult] = createSignal<DevTunnelDiscoveryResult>();
  const [loading, setLoading] = createSignal(false);
  const [signingIn, setSigningIn] = createSignal(false);
  let revision = 0;
  let disposed = false;

  const discover = async (interactive = false) => {
    if (!api?.discoverDevTunnels || loading() || props.disabled) return;
    const attempt = ++revision;
    setLoading(true); setSigningIn(interactive); setResult(undefined);
    try {
      const next = await api.discoverDevTunnels(interactive);
      if (!disposed && attempt === revision) setResult(next);
    } catch {
      if (!disposed && attempt === revision) setResult({ status: "error", tunnels: [] });
    } finally { if (!disposed && attempt === revision) setLoading(false); }
  };
  const cancel = async () => {
    revision += 1;
    try { await api?.cancelDevTunnelDiscovery(); }
    catch { if (!disposed) setResult({ status: "error", tunnels: [] }); }
    finally { if (!disposed) setLoading(false); }
  };
  onMount(() => void discover());
  onCleanup(() => {
    disposed = true;
    revision += 1;
    if (loading()) void api?.cancelDevTunnelDiscovery().catch(() => {});
  });

  return (
    <Show when={api?.discoverDevTunnels} fallback={<p class="text-xs leading-relaxed text-[var(--cm-text-muted)]">{t().devTunnel.discoveryDesktopOnly}</p>}>
      <div class="space-y-3 rounded-xl border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] p-3" data-testid="devtunnel-discovery">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-sm font-medium text-[var(--cm-text)]">{t().devTunnel.myComputers}</h3>
          <Show when={loading()} fallback={
            <button type="button" disabled={props.disabled} onClick={() => void discover()} class="shrink-0 text-xs font-medium text-[var(--cm-text-muted)] hover:text-[var(--cm-text)] disabled:opacity-50">{t().devTunnel.refresh}</button>
          }>
            <button type="button" onClick={() => void cancel()} class="shrink-0 text-xs text-[var(--cm-text-muted)]">{t().common.cancel}</button>
          </Show>
        </div>
        <p class="text-xs leading-relaxed text-[var(--cm-text-muted)]">{t().devTunnel.discoveryHint}</p>
        <Show when={loading()}>
          <p role="status" class="flex items-center gap-2 text-xs text-[var(--cm-text-muted)]"><Spinner size="small" />{signingIn() ? t().devTunnel.login : t().devTunnel.discovering}</p>
        </Show>
        <Show when={result()?.status === "loginRequired"}>
          <button type="button" disabled={props.disabled} onClick={() => void discover(true)} class="cm-btn-primary rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-50" data-testid="devtunnel-discovery-login">{t().devTunnel.signInDiscover}</button>
        </Show>
        <Show when={result()?.status === "unavailable"}>
          <p role="alert" class="text-xs leading-relaxed text-[var(--cm-text-muted)]">{t().devTunnel.discoveryInstallHint}</p>
        </Show>
        <Show when={result()?.status === "error"}>
          <p role="alert" class="text-xs leading-relaxed text-red-600 dark:text-red-400">{t().devTunnel.errors[result()?.errorCode ?? ""] || t().devTunnel.errors.DEVTUNNEL_COMMAND_FAILED}</p>
        </Show>
        <Show when={result()?.status === "ready"}>
          <Show when={result()!.tunnels.length} fallback={<p class="text-xs leading-relaxed text-[var(--cm-text-muted)]" data-testid="devtunnel-discovery-empty">{t().devTunnel.noComputers}</p>}>
            <ul class="max-h-56 space-y-2 overflow-y-auto" data-testid="devtunnel-discovery-list">
              <For each={result()!.tunnels}>{tunnel => (
                <li class="rounded-lg border border-[var(--cm-hairline)] p-3">
                  <div class="flex items-center gap-3">
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-medium text-[var(--cm-text)]" title={tunnel.name}>{tunnel.name}</p>
                      <p class="mt-1 flex items-center gap-1.5 text-xs text-[var(--cm-text-muted)]"><span class={`h-1.5 w-1.5 shrink-0 rounded-full ${tunnel.online ? "bg-emerald-500" : "bg-gray-400"}`} />{tunnel.online ? t().devTunnel.hostOnline : t().devTunnel.hostOffline}</p>
                    </div>
                    <button type="button" disabled={props.disabled || !tunnel.online || !tunnel.url} onClick={() => props.onSelect(tunnel)} class="shrink-0 rounded-lg border border-[var(--cm-hairline-strong)] px-3 py-2 text-xs font-medium text-[var(--cm-text)] hover:bg-[var(--cm-surface-2)] disabled:opacity-40">{t().hostConnections.connect}</button>
                  </div>
                  <p class="mt-2 truncate font-mono text-[11px] text-[var(--cm-text-muted)]" title={tunnel.url || tunnel.tunnelId}>{tunnel.url || tunnel.tunnelId}</p>
                  <Show when={tunnel.online && !tunnel.url}><p class="mt-1 text-xs text-[var(--cm-text-muted)]">{t().devTunnel.addressNotReady}</p></Show>
                </li>
              )}</For>
            </ul>
          </Show>
        </Show>
      </div>
    </Show>
  );
}
