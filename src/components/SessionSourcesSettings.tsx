import { For, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import { gateway } from "../lib/gateway-api";
import { formatMessage, useI18n } from "../lib/i18n";
import type { SessionSourceState } from "../types/unified";

/** Source controls deliberately do not inspect engine IDs or provider metadata. */
export function SessionSourcesSettings() {
  const { t } = useI18n();
  const [sources, setSources] = createSignal<SessionSourceState[]>([]);
  const [pending, setPending] = createSignal<Record<string, boolean>>({});
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  let disposed = false;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout>;
  const refresh = async () => {
    const current = revision;
    try {
      const result = await gateway.listSessionSources();
      if (!disposed && current === revision && !Object.values(pending()).some(Boolean)) {
        setSources(result);
        setErrors(value => ({ ...value, load: "" }));
      }
    } catch (error) {
      if (!disposed) setErrors(value => ({ ...value, load: String(error) }));
    } finally {
      if (!disposed) timer = setTimeout(() => void refresh(), 5000);
    }
  };
  onMount(() => void refresh());
  onCleanup(() => { disposed = true; clearTimeout(timer); });
  const toggle = async (source: SessionSourceState) => {
    if (pending()[source.id]) return;
    revision++;
    setPending(value => ({ ...value, [source.id]: true }));
    setErrors(value => ({ ...value, [source.id]: "" }));
    try {
      const state = await gateway.setSessionSourceEnabled(source.id, !source.enabled);
      if (!disposed) setSources(values => values.map(value => value.id === state.id ? state : value));
    } catch (error) {
      if (!disposed) setErrors(value => ({ ...value, [source.id]: formatMessage(t().sessionSharing.updateFailed, {
        message: error instanceof Error ? error.message : String(error),
      }) }));
    } finally {
      revision++;
      if (!disposed) setPending(value => ({ ...value, [source.id]: false }));
    }
  };
  return (
    <section class="space-y-4" data-session-source-settings>
      <h2 class="text-lg font-semibold text-[var(--cm-text)]">{t().sessionSharing.sourcesTitle}</h2>
      <p class="text-sm text-[var(--cm-text-muted)]">{t().sessionSharing.sourcesDescription}</p>
      <Show when={errors().load}><p role="alert" class="text-sm text-red-600">{errors().load}</p></Show>
      <For each={sources()}>{source => (
        <div class="rounded-xl border border-[var(--cm-hairline)] bg-[var(--cm-surface)] p-4">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h3 class="font-medium">{formatMessage(t().sessionSharing.attachTitle, { peer: source.peerName })}</h3>
              <p class="mt-1 text-sm text-[var(--cm-text-muted)]">{formatMessage(t().sessionSharing.attachDescription, { peer: source.peerName })}</p>
            </div>
            <button type="button" role="switch" aria-checked={source.enabled}
              aria-label={formatMessage(t().sessionSharing.attachTitle, { peer: source.peerName })}
              aria-busy={pending()[source.id] === true} disabled={pending()[source.id]}
              onClick={() => void toggle(source)}
              class={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${source.enabled ? "bg-blue-600" : "bg-gray-300 dark:bg-slate-600"}`}>
              <span class={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${source.enabled ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>
          <div role="status" aria-live="polite" class="mt-3 text-xs text-[var(--cm-text-muted)]">
            <Switch fallback={t().sessionSharing.disabled}>
              <Match when={pending()[source.id]}>{t().sessionSharing.updating}</Match>
              <Match when={source.status === "connected"}>{t().sessionSharing.connected}</Match>
              <Match when={source.status === "connecting"}>{t().sessionSharing.connecting}</Match>
              <Match when={source.status === "unavailable"}>{t().sessionSharing.unavailable}</Match>
            </Switch>
          </div>
          <Show when={source.enabled && !source.available}>
            <p class="mt-2 text-xs text-[var(--cm-text-muted)]">{t().sessionSharing.attachUnavailableHint}</p>
          </Show>
          <Show when={source.providers.some(provider => !provider.supported)}>
            <p class="mt-2 text-xs text-[var(--cm-text-muted)]">{formatMessage(t().sessionSharing.unsupportedProviders, {
              providers: source.providers.filter(provider => !provider.supported).map(provider => provider.id).join(", "),
            })}</p>
          </Show>
          <Show when={errors()[source.id]}><p role="alert" class="mt-2 text-xs text-red-600">{errors()[source.id]}</p></Show>
        </div>
      )}</For>
    </section>
  );
}
