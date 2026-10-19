import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { ConnectionDialog } from "./ConnectionDialog";
import { DEFAULT_WEB_PORT } from "../../shared/ports";
import { getDirectHostUrl, normalizeRemoteHostInput, parseSshAddress, type RemoteHostConnection, type RemoteHostInput, type RemoteHostState } from "../../shared/remote-hosts";
import { formatMessage, useI18n } from "../lib/i18n";
import { Spinner } from "./Spinner";

type ConnectionStep = "method" | "direct" | "ssh";

const inputClass = "w-full min-w-0 rounded-lg border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] dark:bg-[var(--cm-surface-2)] px-3 py-2.5 text-sm text-gray-900 dark:text-white outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50";
const secondaryButtonClass = "rounded-lg border border-[var(--cm-hairline-strong)] px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed";

interface ConnectionIconProps {
  ssh?: boolean;
  class?: string;
}

function ConnectionIcon(props: ConnectionIconProps) {
  return (
    <svg class={props.class} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <Show when={props.ssh} fallback={<><path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7" /></>}>
        <rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3M13 15h4" />
      </Show>
    </svg>
  );
}

interface ConnectionMethodsProps {
  onSelect: (method: "direct" | "ssh") => void;
  sshAvailable: boolean;
  inline?: boolean;
}

function ConnectionMethods(props: ConnectionMethodsProps) {
  const { t } = useI18n();
  return (
    <div class={`grid gap-3 ${props.inline ? "sm:grid-cols-2" : "grid-cols-1"}`}>
      <For each={["direct", "ssh"] as const}>{method => (
        <button type="button" onClick={() => props.onSelect(method)} disabled={method === "ssh" && !props.sshAvailable}
          class="flex min-h-24 items-center gap-3 rounded-xl border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] p-4 text-left transition-colors hover:border-[var(--cm-accent)] hover:bg-[var(--cm-accent-soft)] disabled:cursor-default disabled:opacity-50"
          data-testid={`add-host-${method}`}>
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--cm-surface-2)] text-[var(--cm-text-muted)]"><ConnectionIcon ssh={method === "ssh"} /></span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium text-[var(--cm-text)]">{method === "direct" ? t().hostConnections.directTitle : t().hostConnections.sshTitle}</span>
            <span class="mt-1 block text-xs leading-relaxed text-[var(--cm-text-muted)]">
              <Show when={method !== "ssh" || props.sshAvailable} fallback={t().connectionCenter.desktopOnly}>
                {method === "direct" ? t().hostConnections.directDescription : t().hostConnections.sshDescription}
              </Show>
            </span>
          </span>
          <span class="text-[var(--cm-text-faint)]" aria-hidden="true">›</span>
        </button>
      )}</For>
    </div>
  );
}

/** Saved connections belong to the local desktop; remote pages keep their own origin and login. */
export function HostConnections() {
  const { t } = useI18n();
  const id = createUniqueId();
  const api = window.electronAPI?.remoteHosts;
  const [hosts, setHosts] = createSignal<RemoteHostState[]>([]);
  const [loading, setLoading] = createSignal(Boolean(api));
  const [listError, setListError] = createSignal("");
  const [rowBusy, setRowBusy] = createSignal<string | null>(null);
  const [removing, setRemoving] = createSignal<string | null>(null);
  const [step, setStep] = createSignal<ConnectionStep | null>(null);
  const [editingId, setEditingId] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [name, setName] = createSignal("");
  const [host, setHost] = createSignal("");
  const [port, setPort] = createSignal(String(DEFAULT_WEB_PORT));
  const [useTls, setUseTls] = createSignal(false);
  const [sshAddress, setSshAddress] = createSignal("");
  const [remotePort, setRemotePort] = createSignal(String(DEFAULT_WEB_PORT));
  const [advanced, setAdvanced] = createSignal(false);
  const [advancedUrl, setAdvancedUrl] = createSignal("");
  let disposed = false;
  let revision = 0;
  let connectAttempt = 0;
  let rowAttempt = 0;

  onMount(() => {
    if (!api) return;
    const unsubscribe = api.onChange(next => { revision += 1; if (!disposed) { setHosts(next); setLoading(false); } });
    const initialRevision = revision;
    void api.list().then(next => { if (!disposed && revision === initialRevision) setHosts(next); }).catch(() => { if (!disposed) setListError(t().hostConnections.loadFailed); }).finally(() => { if (!disposed) setLoading(false); });
    onCleanup(unsubscribe);
  });
  onCleanup(() => { disposed = true; });

  const dialogTitle = createMemo(() => {
    if (step() === "direct") return t().hostConnections.directTitle;
    if (step() === "ssh") return t().hostConnections.sshTitle;
    return t().hostConnections.addHost;
  });

  createEffect(() => {
    step();
    setError("");
  });

  const reset = () => {
    setEditingId(undefined); setName(""); setHost(""); setPort(String(DEFAULT_WEB_PORT));
    setUseTls(false); setSshAddress(""); setRemotePort(String(DEFAULT_WEB_PORT)); setAdvanced(false); setAdvancedUrl(""); setError("");
  };
  const handleAdd = () => { reset(); setStep("method"); };
  const handleMethod = (method: "direct" | "ssh") => { reset(); setStep(method); };
  const handleClose = () => { if (!busy()) { setStep(null); reset(); } };
  const handleBack = () => { if (editingId()) handleClose(); else { setAdvanced(false); setStep("method"); } };
  const handleCancelConnect = () => {
    connectAttempt += 1;
    const hostId = editingId();
    setBusy(false); setStep(null); reset();
    if (api && hostId) void api.disconnect(hostId).catch(() => setListError(t().hostConnections.tryAgain));
  };

  const directConnection = (): Extract<RemoteHostConnection, { type: "direct" }> => {
    const urlText = advanced() ? advancedUrl().trim() : host().trim();
    if (advanced() && !urlText) throw new Error(t().hostConnections.invalidUrl);
    if (urlText.includes("://")) {
      try {
        const url = new URL(urlText);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
        return { type: "direct", host: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), useTls: url.protocol === "https:" };
      } catch { throw new Error(t().hostConnections.invalidUrl); }
    }
    if (advanced() && urlText) throw new Error(t().hostConnections.invalidUrl);
    if (!host().trim()) throw new Error(t().hostConnections.hostRequired);
    if (!/^\d+$/.test(port().trim()) || Number(port()) < 1 || Number(port()) > 65535) throw new Error(t().hostConnections.invalidPort);
    return { type: "direct", host: host().trim(), port: Number(port()), useTls: useTls() };
  };

  const handleAdvanced = () => {
    if (!advanced() && step() === "direct") {
      try { setAdvancedUrl(getDirectHostUrl(directConnection())); } catch { setAdvancedUrl(""); }
    } else if (advanced() && step() === "direct" && advancedUrl().trim()) {
      try {
        const next = directConnection();
        setHost(next.host); setPort(String(next.port)); setUseTls(next.useTls);
      } catch (cause) { setError(cause instanceof Error ? cause.message : t().hostConnections.invalidUrl); return; }
    }
    setError(""); setAdvanced(value => !value);
  };

  const handleConnect = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy()) return;
    let input: RemoteHostInput;
    try {
      let connection: RemoteHostConnection;
      if (step() === "ssh") {
        if (!sshAddress().trim()) throw new Error(t().hostConnections.sshRequired);
        try { parseSshAddress(sshAddress()); } catch { throw new Error(t().hostConnections.invalidSsh); }
        if (!/^\d+$/.test(remotePort().trim()) || Number(remotePort()) < 1 || Number(remotePort()) > 65535) throw new Error(t().hostConnections.invalidPort);
        connection = { type: "ssh", address: sshAddress().trim(), remotePort: Number(remotePort()) };
      } else connection = directConnection();
      input = normalizeRemoteHostInput({ name: name().trim(), connection });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t().hostConnections.invalidConnection); return; }
    const attempt = ++connectAttempt;
    setBusy(true); setError("");
    try {
      if (api) {
        const saved = await api.save(input, editingId());
        if (disposed || attempt !== connectAttempt) return;
        setEditingId(saved.id);
        await api.connect(saved.id);
        if (disposed || attempt !== connectAttempt) return;
        setStep(null); reset();
      } else if (input.connection.type === "direct") {
        window.location.assign(new URL("/?connect=1", getDirectHostUrl(input.connection)).href);
      }
    } catch (cause) {
      if (!disposed && attempt === connectAttempt) setError(formatMessage(t().hostConnections.connectFailed, { detail: cause instanceof Error ? cause.message : t().hostConnections.tryAgain }));
    } finally { if (attempt === connectAttempt) setBusy(false); }
  };

  const handleEdit = (saved: RemoteHostState) => {
    reset(); setEditingId(saved.id); setName(saved.name);
    if (saved.connection.type === "direct") {
      setHost(saved.connection.host); setPort(String(saved.connection.port)); setUseTls(saved.connection.useTls); setStep("direct");
    } else { setSshAddress(saved.connection.address); setRemotePort(String(saved.connection.remotePort)); setStep("ssh"); }
  };

  const handleHostAction = async (saved: RemoteHostState, action: "connect" | "disconnect" | "remove") => {
    if (!api || (rowBusy() && !(action === "disconnect" && rowBusy() === saved.id))) return;
    const attempt = ++rowAttempt;
    setRowBusy(saved.id); setListError("");
    try { await api[action](saved.id); if (action === "remove") setRemoving(null); }
    catch (cause) { if (attempt === rowAttempt) setListError(cause instanceof Error ? cause.message : t().hostConnections.tryAgain); }
    finally { if (attempt === rowAttempt) setRowBusy(null); }
  };

  const connectionLabel = (connection: RemoteHostConnection) => connection.type === "direct" ? getDirectHostUrl(connection) : connection.address;

  return (
    <section class="space-y-4" aria-labelledby={`${id}-heading`} data-testid="host-connections">
      <div class="flex items-start justify-between gap-4">
        <div><h2 id={`${id}-heading`} class="text-sm font-semibold text-[var(--cm-text)]">{t().hostConnections.title}</h2><p class="mt-1 text-xs leading-relaxed text-[var(--cm-text-muted)]">{t().hostConnections.description}</p></div>
        <Show when={hosts().length > 0}>
          <button type="button" onClick={handleAdd} class="cm-btn-primary shrink-0 rounded-lg px-3 py-2 text-xs font-medium" data-testid="add-host">{t().hostConnections.addHost}</button>
        </Show>
      </div>
      <Show when={loading()}><div role="status" class="flex items-center gap-2 py-3 text-sm text-gray-500"><Spinner size="small" />{t().common.loading}</div></Show>
      <Show when={!loading() && !hosts().length}><ConnectionMethods onSelect={handleMethod} sshAvailable={Boolean(api)} inline /></Show>
      <Show when={hosts().length > 0}>
        <div class="divide-y divide-[var(--cm-hairline)] rounded-xl border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)]">
          <For each={hosts()}>{saved => (
            <div class="p-4" data-testid="saved-host">
              <div class="flex items-center gap-3">
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--cm-surface-2)] text-[var(--cm-text-muted)]"><ConnectionIcon ssh={saved.connection.type === "ssh"} /></span>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p class="truncate text-sm font-medium text-[var(--cm-text)]">{saved.name}</p>
                    <span role="status" class="flex items-center gap-1.5 text-[11px] text-[var(--cm-text-muted)]"><span class={`h-1.5 w-1.5 rounded-full ${saved.status === "connected" ? "bg-emerald-500" : saved.status === "error" ? "bg-red-500" : saved.status === "connecting" ? "animate-pulse bg-amber-500" : "bg-gray-400"}`} />{t().hostConnections[saved.status]}</span>
                  </div>
                  <p class="mt-1 truncate font-mono text-xs text-[var(--cm-text-muted)]" title={connectionLabel(saved.connection)}>{connectionLabel(saved.connection)}</p>
                </div>
                <Show when={saved.status === "connecting"} fallback={
                  <button type="button" disabled={Boolean(rowBusy())} onClick={() => void handleHostAction(saved, "connect")} class="shrink-0 rounded-lg border border-[var(--cm-hairline-strong)] px-3 py-2 text-xs font-medium text-[var(--cm-text)] hover:bg-[var(--cm-surface-2)] disabled:opacity-40"><Show when={saved.status === "connected"} fallback={<Show when={saved.status === "error"} fallback={t().hostConnections.connect}>{t().hostConnections.reconnect}</Show>}>{t().hostConnections.open}</Show></button>
                }>
                  <button type="button" onClick={() => void handleHostAction(saved, "disconnect")} class="shrink-0 px-2 py-2 text-xs text-[var(--cm-text-muted)]">{t().common.cancel}</button>
                </Show>
                <details class="relative shrink-0" name={`${id}-actions`}
                  onKeyDown={event => { if (event.key === "Escape") event.currentTarget.open = false; }}
                  onFocusOut={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false; }}>
                  <summary aria-label={t().connectionCenter.manageConnection} class="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md text-[var(--cm-text-muted)] hover:bg-[var(--cm-surface-2)] [&::-webkit-details-marker]:hidden">···</summary>
                  <div class="absolute right-0 top-10 z-20 w-36 rounded-lg border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] p-1 shadow-[var(--cm-shadow-lg)]">
                    <button type="button" disabled={Boolean(rowBusy()) || saved.status === "connecting"} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); handleEdit(saved); }} class="block w-full rounded px-3 py-2 text-left text-xs text-[var(--cm-text)] hover:bg-[var(--cm-surface-2)] disabled:opacity-40">{t().hostConnections.edit}</button>
                    <Show when={saved.status === "connected"}><button type="button" disabled={Boolean(rowBusy())} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); void handleHostAction(saved, "disconnect"); }} class="block w-full rounded px-3 py-2 text-left text-xs text-[var(--cm-text)] hover:bg-[var(--cm-surface-2)] disabled:opacity-40">{t().hostConnections.disconnect}</button></Show>
                    <button type="button" disabled={Boolean(rowBusy()) || saved.status === "connecting"} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setRemoving(saved.id); }} class="block w-full rounded px-3 py-2 text-left text-xs text-[var(--cm-text-muted)] hover:bg-[var(--cm-surface-2)] hover:text-red-500 disabled:opacity-40">{t().hostConnections.remove}</button>
                  </div>
                </details>
              </div>
              <Show when={saved.error}><p class="mt-3 break-words text-xs text-red-600 dark:text-red-400">{saved.error}</p></Show>
              <Show when={removing() === saved.id}>
                <div class="mt-3 border-t border-[var(--cm-hairline)] pt-3"><p class="text-xs text-[var(--cm-text-muted)]">{formatMessage(t().hostConnections.removeConfirm, { name: saved.name })}</p><div class="mt-2 flex justify-end gap-3 text-xs"><button type="button" disabled={Boolean(rowBusy())} onClick={() => setRemoving(null)}>{t().common.cancel}</button><button type="button" disabled={Boolean(rowBusy())} onClick={() => void handleHostAction(saved, "remove")} class="font-medium text-red-600 dark:text-red-400">{t().hostConnections.remove}</button></div></div>
              </Show>
            </div>
          )}</For>
        </div>
      </Show>
      <Show when={listError()}><p role="alert" class="break-words text-xs text-red-600 dark:text-red-400">{listError()}</p></Show>
      <Show when={step()}>
        <ConnectionDialog title={dialogTitle()} busy={busy()} onClose={handleClose}>
          <Show when={step() === "method"} fallback={
            <form onSubmit={event => void handleConnect(event)} class="space-y-4">
              <p class="text-sm leading-relaxed text-gray-500 dark:text-gray-400"><Show when={step() === "ssh"} fallback={t().hostConnections.directHint}>{t().hostConnections.sshHint}</Show></p>
              <Show when={step() === "direct"} fallback={
                <div><label for={`${id}-ssh`} class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">{t().hostConnections.sshAddress}</label><input id={`${id}-ssh`} value={sshAddress()} onInput={event => setSshAddress(event.currentTarget.value)} placeholder="ssh://user@host" spellcheck={false} autocapitalize="none" disabled={busy()} class={inputClass} data-testid="ssh-host-address" /></div>
              }>
                <div class="flex gap-3">
                  <div class="min-w-0 flex-1"><label for={`${id}-host`} class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">{t().hostConnections.host}</label><input id={`${id}-host`} value={host()} onInput={event => setHost(event.currentTarget.value)} onBlur={() => { if (host().includes("://")) { try { const next = directConnection(); setHost(next.host); setPort(String(next.port)); setUseTls(next.useTls); } catch { /* Keep the entered address for inline validation. */ } } }} placeholder="localhost" spellcheck={false} autocapitalize="none" disabled={busy() || advanced()} class={inputClass} data-testid="direct-host" /></div>
                  <div class="w-24 shrink-0"><label for={`${id}-port`} class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">{t().hostConnections.port}</label><input id={`${id}-port`} value={port()} onInput={event => setPort(event.currentTarget.value)} inputmode="numeric" disabled={busy() || advanced()} class={inputClass} data-testid="direct-port" /></div>
                </div>
                <label class="flex cursor-pointer items-center gap-3 text-sm text-gray-700 dark:text-gray-300"><input type="checkbox" checked={useTls()} onChange={event => setUseTls(event.currentTarget.checked)} disabled={busy() || advanced()} class="h-4 w-4 accent-blue-600" />{t().hostConnections.useTls}</label>
              </Show>
              <p class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{t().hostConnections.authHint}</p>
              <button type="button" onClick={handleAdvanced} disabled={busy()} aria-expanded={advanced()} class="flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 disabled:opacity-50"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class={advanced() ? "rotate-90" : ""} aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>{t().hostConnections.advanced}</button>
              <Show when={advanced()}>
                <div class="space-y-3 rounded-lg bg-gray-50 p-3 dark:bg-slate-900/50">
                  <Show when={step() === "direct"} fallback={<div><label for={`${id}-remote-port`} class="mb-2 block text-xs font-medium text-gray-600 dark:text-gray-400">{t().hostConnections.remotePort}</label><input id={`${id}-remote-port`} value={remotePort()} onInput={event => setRemotePort(event.currentTarget.value)} inputmode="numeric" disabled={busy()} class={inputClass} /></div>}>
                    <div><label for={`${id}-url`} class="mb-2 block text-xs font-medium text-gray-600 dark:text-gray-400">{t().hostConnections.connectionUrl}</label><input id={`${id}-url`} value={advancedUrl()} onInput={event => setAdvancedUrl(event.currentTarget.value)} placeholder="https://codemux.example.com" autocapitalize="none" spellcheck={false} disabled={busy()} class={inputClass} data-testid="direct-url" /></div>
                  </Show>
                  <div><label for={`${id}-name`} class="mb-2 block text-xs font-medium text-gray-600 dark:text-gray-400">{t().hostConnections.displayName}</label><input id={`${id}-name`} value={name()} onInput={event => setName(event.currentTarget.value)} placeholder={t().hostConnections.optional} maxlength={100} disabled={busy()} class={inputClass} /></div>
                </div>
              </Show>
              <Show when={error()}><p role="alert" class="whitespace-pre-wrap break-words rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{error()}</p></Show>
              <div class="flex gap-3 pt-1"><button type="button" onClick={() => busy() ? handleCancelConnect() : handleBack()} class={`${secondaryButtonClass} flex-1`}>{t().common.cancel}</button><button type="submit" disabled={busy()} class="cm-btn-primary flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60" data-testid="connect-host"><Show when={busy()} fallback={<ConnectionIcon ssh={step() === "ssh"} />}><Spinner size="small" /></Show><Show when={busy()} fallback={t().hostConnections.connect}>{t().hostConnections.connecting}</Show></button></div>
            </form>
          }>
            <ConnectionMethods onSelect={method => setStep(method)} sshAvailable={Boolean(api)} />
          </Show>
        </ConnectionDialog>
      </Show>
    </section>
  );
}
