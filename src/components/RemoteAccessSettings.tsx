import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import { remoteAccessAPI, type RemoteAccessStatus, type RemoteAccessUpdate, type RemoteAccessMode } from "../lib/electron-api";
import { copyTextToClipboard } from "../lib/clipboard";
import { useI18n } from "../lib/i18n";
import { AccessQRCode } from "./AccessQRCode";
import { ConnectionDialog } from "./ConnectionDialog";
import { CustomAccessSettings } from "./CustomAccessSettings";

type AccessMethod = Exclude<RemoteAccessMode, "off">;

interface RemoteAccessSettingsProps {
  status: RemoteAccessStatus;
  onChanged: (status: RemoteAccessStatus) => void;
  defaultHost?: string;
  defaultPort?: number;
  accessCode?: string;
  onManageDevices?: () => void;
}

function MethodIcon(props: { method: AccessMethod }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <Show when={props.method === "custom"} fallback={<path d="M6 17a4 4 0 0 1-.9-7.9 6 6 0 0 1 11.7-1.2A4.6 4.6 0 0 1 18 17H6Z" />}>
        <rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" />
      </Show>
    </svg>
  );
}

export function RemoteAccessSettings(props: RemoteAccessSettingsProps) {
  const { t } = useI18n();
  const id = createUniqueId();
  const [editing, setEditing] = createSignal(false);
  const [provider, setProvider] = createSignal<AccessMethod>("custom");
  const [hostname, setHostname] = createSignal("");
  const [fixedDomain, setFixedDomain] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [validationError, setValidationError] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);
  const [showCode, setShowCode] = createSignal(false);
  const [copyFeedback, setCopyFeedback] = createSignal<"copied" | "failed" | null>(null);
  const [failedPatch, setFailedPatch] = createSignal<RemoteAccessUpdate | null>(null);
  let disposed = false;
  let mutationRevision = 0;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  const enabled = () => props.status.mode !== "off";
  const methods: AccessMethod[] = ["custom", "cloudflare"];
  const methodName = (method: AccessMethod) => method === "custom" ? t().remote.customAccessTitle : t().remote.accessCloudflare;
  const methodDescription = (method: AccessMethod) => method === "custom" ? t().connectionCenter.directDescription : t().connectionCenter.cloudflareDescription;
  const unavailable = (method: AccessMethod) => method === "cloudflare" && !props.status.cloudflareAvailable;
  const tunnelError = () => props.status.tunnel.status === "error";
  const statusLabel = createMemo(() => {
    if (!loaded()) return t().connectionCenter.loading;
    if (props.status.mode === "custom") return t().connectionCenter.directConfigured;
    if (props.status.mode === "cloudflare") {
      return t().connectionCenter[props.status.tunnel.status];
    }
    return tunnelError() || failedPatch() ? t().connectionCenter.error : t().connectionCenter.disabled;
  });
  // A retained tunnel URL is not a usable link until the tunnel confirms it is running.
  const address = createMemo(() => {
    if (props.status.mode === "custom") return props.status.customAccessUrl;
    if (props.status.mode === "cloudflare" && props.status.tunnel.status === "running") return props.status.url;
    return "";
  });
  const failureDetail = () => error() || (tunnelError() ? props.status.tunnel.error : "");
  const failureCode = () => tunnelError() ? props.status.tunnel.errorCode : "";
  const canRetry = () => !!failedPatch() || (props.status.mode === "cloudflare" && ["error", "stopped"].includes(props.status.tunnel.status));

  const refresh = async () => {
    const revision = mutationRevision;
    try {
      const status = await remoteAccessAPI.getStatus();
      if (!disposed && !busy() && revision === mutationRevision) {
        props.onChanged(status);
        if (!loaded() && !failedPatch()) setError("");
        setLoaded(true);
      }
    } catch {
      if (!disposed && !loaded()) setError(t().remote.accessUpdateFailed);
    }
  };
  onMount(() => void refresh());
  const timer = setInterval(() => { if (!busy()) void refresh(); }, 2000);
  onCleanup(() => { disposed = true; clearInterval(timer); clearTimeout(copyTimer); });

  const update = async (patch: RemoteAccessUpdate) => {
    if (busy()) return false;
    mutationRevision += 1;
    setBusy(true);
    setError("");
    setValidationError("");
    setFailedPatch(null);
    try {
      const status = await remoteAccessAPI.update(patch);
      if (!disposed) {
        props.onChanged(status);
        setLoaded(true);
        setShowCode(false);
      }
      return true;
    } catch (cause) {
      if (!disposed) {
        setError(cause instanceof Error && cause.message ? cause.message : t().remote.accessUpdateFailed);
        setFailedPatch(patch);
        try { props.onChanged(await remoteAccessAPI.getStatus()); } catch { /* Keep the last confirmed state. */ }
      }
      return false;
    } finally { if (!disposed) setBusy(false); }
  };

  const openEditor = (method: AccessMethod) => {
    setProvider(method);
    setHostname(props.status.tunnelConfig.hostname ?? "");
    setFixedDomain(!!props.status.tunnelConfig.hostname);
    setValidationError("");
    setEditing(true);
  };
  const closeEditor = () => { if (!busy()) setEditing(false); };
  const save = async (patch: RemoteAccessUpdate) => {
    const success = await update(patch);
    if (success && !disposed) setEditing(false);
    return success;
  };
  const saveCloudflare = (event: SubmitEvent) => {
    event.preventDefault();
    if (fixedDomain() && !hostname().trim()) {
      setValidationError(t().connectionCenter.hostnameRequired);
      return;
    }
    void save({ mode: "cloudflare", tunnelConfig: { hostname: fixedDomain() ? hostname().trim() : "" } });
  };
  const retry = () => void update(failedPatch() ?? { mode: "cloudflare" });
  const copy = async (text: string) => {
    const success = await copyTextToClipboard(text);
    if (disposed) return;
    setCopyFeedback(success ? "copied" : "failed");
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => setCopyFeedback(null), 3000);
  };
  const secondaryButton = "inline-flex min-h-9 items-center justify-center rounded-lg border border-[var(--cm-hairline-strong)] px-3 text-xs font-medium text-gray-700 transition-colors hover:bg-black/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-500 disabled:opacity-50 dark:text-gray-200 dark:hover:bg-white/[0.05]";

  return (
    <section data-testid="share-access" aria-labelledby={`${id}-title`} class="space-y-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="max-w-xl">
          <h3 id={`${id}-title`} class="text-sm font-semibold text-gray-900 dark:text-gray-100">{t().connectionCenter.sharingHeading}</h3>
          <p class="mt-1.5 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{t().connectionCenter.sharingDescription}</p>
        </div>
        <span role="status" class={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${tunnelError() || failedPatch() ? "border-red-200 text-red-700 dark:border-red-900 dark:text-red-300" : "border-[var(--cm-hairline-strong)] text-gray-600 dark:text-gray-300"}`}>
          <span aria-hidden="true" class={`h-1.5 w-1.5 rounded-full ${tunnelError() || failedPatch() ? "bg-red-500" : props.status.mode === "cloudflare" && props.status.tunnel.status === "running" ? "bg-emerald-500" : "bg-gray-400"} ${busy() || props.status.mode === "cloudflare" && props.status.tunnel.status === "starting" ? "animate-pulse" : ""}`} />
          {statusLabel()}
        </span>
      </div>

      <Show when={enabled()} fallback={
        <div class="grid gap-3 sm:grid-cols-2">
          <For each={methods}>{method => (
            <button type="button" data-testid={`share-method-${method}`} disabled={busy() || !loaded() || unavailable(method)} onClick={() => openEditor(method)}
              class="group flex items-start gap-3 rounded-xl border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] p-4 text-left transition-colors hover:bg-black/[0.025] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-500 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/[0.03]">
              <span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-black/[0.04] text-gray-600 dark:bg-white/[0.05] dark:text-gray-300"><MethodIcon method={method} /></span>
              <span class="min-w-0 flex-1"><span class="block text-sm font-medium text-gray-900 dark:text-gray-100">{methodName(method)}</span><span class="mt-1 block text-xs leading-relaxed text-gray-500 dark:text-gray-400">{unavailable(method) ? t().connectionCenter.cloudflareUnavailable : methodDescription(method)}</span></span>
              <span aria-hidden="true" class="mt-2 text-gray-400 transition-transform group-hover:translate-x-0.5">→</span>
            </button>
          )}</For>
        </div>
      }>
        <div class="overflow-hidden rounded-xl border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)]">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--cm-hairline)] px-4 py-3">
            <span class="flex items-center gap-2.5 text-sm font-medium text-gray-900 dark:text-gray-100"><MethodIcon method={props.status.mode === "custom" ? "custom" : "cloudflare"} />{methodName(props.status.mode === "custom" ? "custom" : "cloudflare")}</span>
            <div class="flex items-center gap-2">
              <button type="button" data-testid="edit-share-access" disabled={busy()} onClick={() => openEditor(props.status.mode === "custom" ? "custom" : "cloudflare")} class={secondaryButton}>{t().connectionCenter.edit}</button>
              <button type="button" data-testid="disable-share-access" disabled={busy()} onClick={() => void update({ mode: "off" })} class={secondaryButton}>{t().connectionCenter.disable}</button>
            </div>
          </div>
          <Show when={address()} fallback={
            <div class="px-4 py-6">
              <p class="text-sm text-gray-600 dark:text-gray-300">{props.status.tunnel.url ? t().connectionCenter.staleAddress : t().connectionCenter.addressPending}</p>
              <Show when={canRetry()}><button type="button" disabled={busy()} onClick={retry} class={`${secondaryButton} mt-3`}>{t().connectionCenter.retry}</button></Show>
            </div>
          }>
            <div class="flex flex-col gap-5 p-4 sm:flex-row sm:items-center">
              <div class="min-w-0 flex-1 space-y-4">
                <div>
                  <p class="text-[11px] font-medium text-gray-500 dark:text-gray-400">{t().connectionCenter.shareAddress}</p>
                  <p data-testid="active-share-address" class="mt-1.5 select-all break-all font-mono text-sm leading-relaxed text-gray-900 dark:text-gray-100">{address()}</p>
                  <p class="mt-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{props.status.mode === "custom" ? t().connectionCenter.configuredDescription : t().connectionCenter.activeDescription}</p>
                  <button type="button" onClick={() => void copy(address())} class={`${secondaryButton} mt-3`}>{t().remote.copyAddress}</button>
                </div>
                <Show when={props.accessCode}>
                  <div class="border-t border-[var(--cm-hairline)] pt-3">
                    <p class="text-[11px] font-medium text-gray-500 dark:text-gray-400">{t().connectionCenter.accessCode}</p>
                    <div class="mt-1.5 flex flex-wrap items-center gap-3">
                      <code data-testid="share-access-code" class="select-all font-mono text-lg tracking-[0.18em] text-gray-900 dark:text-gray-100">{showCode() ? props.accessCode : "••••••"}</code>
                      <button type="button" aria-pressed={showCode()} onClick={() => setShowCode(value => !value)} class="min-h-9 rounded-md px-1 text-xs text-gray-500 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-gray-500 dark:text-gray-400 dark:hover:text-gray-100">{showCode() ? t().connectionCenter.hideCode : t().connectionCenter.showCode}</button>
                      <button type="button" onClick={() => void copy(props.accessCode ?? "")} class={secondaryButton}>{t().remote.copyAccessCode}</button>
                    </div>
                  </div>
                </Show>
              </div>
              <div class="flex shrink-0 flex-col items-center self-center rounded-xl border border-[var(--cm-hairline)] bg-white p-2">
                <AccessQRCode url={address()} />
              </div>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={failureDetail() || failureCode()}>
        <div role="alert" class="rounded-lg border border-red-200 bg-red-50/50 px-3 py-2.5 text-xs leading-relaxed text-red-700 dark:border-red-900/60 dark:bg-red-950/15 dark:text-red-300">
          <Show when={failureCode()}><p class="mb-1 break-all font-mono">{failureCode()}</p></Show>
          <p class="break-words">{failureDetail()}</p>
          <Show when={(canRetry() || !loaded()) && !editing() && !enabled()}><button type="button" disabled={busy()} onClick={() => loaded() ? retry() : void refresh()} class={`${secondaryButton} mt-2`}>{t().connectionCenter.retry}</button></Show>
        </div>
      </Show>
      <Show when={copyFeedback()}><p role="status" class="text-xs text-gray-500 dark:text-gray-400">{copyFeedback() === "copied" ? t().connectionCenter.copied : t().connectionCenter.copyFailed}</p></Show>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="max-w-lg text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{t().remote.noteKeepRunningDesc}</p>
        <Show when={props.onManageDevices}><button type="button" onClick={() => props.onManageDevices?.()} class="min-h-9 shrink-0 rounded-md px-1 text-xs font-medium text-gray-600 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-gray-500 dark:text-gray-300 dark:hover:text-gray-100">{t().connectionCenter.manageDevices} <span aria-hidden="true">→</span></button></Show>
      </div>

      <Show when={editing()}>
        <ConnectionDialog title={t().connectionCenter.configureTitle} busy={busy()} onClose={closeEditor}>
          <p class="mb-4 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{t().connectionCenter.methodChangeDescription}</p>
          <fieldset disabled={busy()}>
            <legend class="mb-2 text-xs font-medium text-gray-600 dark:text-gray-400">{t().connectionCenter.methodLabel}</legend>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <For each={methods}>{method => (
                <label class={`flex min-h-11 items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${provider() === method ? "border-gray-600 bg-black/[0.035] dark:border-gray-400 dark:bg-white/[0.05]" : "border-[var(--cm-hairline-strong)]"} ${unavailable(method) ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
                  <input type="radio" name={`${id}-provider`} checked={provider() === method} disabled={unavailable(method)} onChange={() => { setProvider(method); setValidationError(""); }} class="accent-gray-800 dark:accent-gray-200" />
                  {methodName(method)}
                </label>
              )}</For>
            </div>
          </fieldset>
          <Show when={enabled() && provider() !== props.status.mode}><p class="mt-3 rounded-lg bg-black/[0.035] px-3 py-2.5 text-xs leading-relaxed text-gray-600 dark:bg-white/[0.05] dark:text-gray-300">{t().connectionCenter.switchNotice}</p></Show>
          <div class="mt-5 border-t border-[var(--cm-hairline)] pt-5">
            <Show when={provider() === "custom"}>
              <CustomAccessSettings value={props.status.customAccessUrl} active={props.status.mode === "custom"} defaultHost={props.defaultHost} defaultPort={props.defaultPort} disabled={busy()} onCancel={closeEditor} onSave={url => save({ customAccessUrl: url, mode: "custom" })} />
            </Show>
            <Show when={provider() === "cloudflare"}>
              <form onSubmit={saveCloudflare}>
                <h4 class="text-sm font-medium text-gray-900 dark:text-gray-100">{fixedDomain() ? t().connectionCenter.fixedDomain : t().connectionCenter.quickLink}</h4>
                <p class="mt-1.5 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{fixedDomain() ? t().connectionCenter.fixedDescription : t().connectionCenter.quickDescription}</p>
                <label for={`${id}-fixed`} class="mt-4 flex min-h-9 cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input id={`${id}-fixed`} type="checkbox" checked={fixedDomain()} disabled={busy()} onChange={event => setFixedDomain(event.currentTarget.checked)} class="h-4 w-4 accent-gray-800 dark:accent-gray-200" />{t().connectionCenter.fixedDomain}
                </label>
                <Show when={fixedDomain()}>
                  <div class="mt-2 rounded-lg border border-[var(--cm-hairline-strong)] p-3">
                    <label for={`${id}-hostname`} class="mb-1.5 block text-xs font-medium text-gray-600 dark:text-gray-400">{t().connectionCenter.domain}</label>
                    <input data-testid="cloudflare-hostname" id={`${id}-hostname`} value={hostname()} onInput={event => { setHostname(event.currentTarget.value); setValidationError(""); }} disabled={busy()} required={fixedDomain()} spellcheck={false} autocomplete="off" placeholder={t().remote.tunnelHostnamePlaceholder} class="w-full rounded-lg border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:bg-[var(--cm-surface-2)]" />
                    <p class="mt-3 break-words text-xs leading-relaxed text-gray-500 dark:text-gray-400">{t().remote.namedTunnelSetupHint}</p>
                  </div>
                </Show>
                <div class="mt-6 flex items-center justify-end gap-2">
                  <button type="button" disabled={busy()} onClick={closeEditor} class={secondaryButton}>{t().common.cancel}</button>
                  <button type="submit" data-testid="save-cloudflare" disabled={busy() || !props.status.cloudflareAvailable} class="cm-btn-primary min-h-9 rounded-lg px-4 text-xs font-medium disabled:opacity-50">
                    <Show when={busy()} fallback={props.status.mode === "cloudflare" ? t().remote.updateAccess : t().remote.enableCloudflare}>{t().remote.accessSwitching}</Show>
                  </button>
                </div>
              </form>
            </Show>
          </div>
          <Show when={validationError()}><p role="alert" class="mt-3 text-xs leading-relaxed text-red-600 dark:text-red-400">{validationError()}</p></Show>
          <Show when={(failureDetail() || failureCode()) && (!failedPatch() || failedPatch()?.mode === provider())}><div role="alert" class="mt-3 text-xs leading-relaxed text-red-600 dark:text-red-400"><Show when={failureCode()}><p class="break-all font-mono">{failureCode()}</p></Show><p class="break-words">{failureDetail()}</p></div></Show>
        </ConnectionDialog>
      </Show>
    </section>
  );
}
