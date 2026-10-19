import { createEffect, createMemo, createSignal, createUniqueId, Show } from "solid-js";
import { normalizeAccessUrl } from "../../shared/access-url";
import { getDirectHostUrl } from "../../shared/remote-hosts";
import { useI18n } from "../lib/i18n";

interface CustomAccessSettingsProps {
  value: string;
  active: boolean;
  onSave: (url: string) => Promise<boolean>;
  defaultHost?: string;
  defaultPort?: number;
  disabled?: boolean;
  onCancel?: () => void;
}

export function CustomAccessSettings(props: CustomAccessSettingsProps) {
  const { t } = useI18n();
  const inputId = createUniqueId();
  const [host, setHost] = createSignal("");
  const [port, setPort] = createSignal("8233");
  const [useTls, setUseTls] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [feedback, setFeedback] = createSignal<"saved" | "invalid" | null>(null);
  let edited = false;
  let defaultsApplied = false;

  const applyAddress = (input: string) => {
    const url = new URL(normalizeAccessUrl(input));
    setHost(url.hostname.replace(/^\[|\]$/g, ""));
    setPort(url.port || (url.protocol === "https:" ? "443" : "80"));
    setUseTls(url.protocol === "https:");
    return url.origin;
  };

  const savedValue = createMemo(() => props.value);
  createEffect(() => {
    const value = savedValue();
    if (value) {
      try { applyAddress(value); } catch { setHost(value); }
    }
  });
  createEffect(() => {
    const defaultHost = props.defaultHost;
    const defaultPort = props.defaultPort;
    if (!savedValue() && !edited && !defaultsApplied && defaultHost && defaultPort) {
      setHost(defaultHost);
      setPort(String(defaultPort));
      defaultsApplied = true;
    }
  });

  const saveUrl = async () => {
    if (saving() || props.disabled) return;
    let url: string;
    try {
      if (/^https?:\/\//i.test(host().trim())) {
        url = applyAddress(host());
      } else {
        if (!/^\d+$/.test(port().trim())) throw new Error("Invalid port.");
        url = normalizeAccessUrl(getDirectHostUrl({
          type: "direct", host: host(), port: Number(port()), useTls: useTls(),
        }));
      }
    } catch {
      setFeedback("invalid");
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      if (await props.onSave(url)) {
        applyAddress(url);
        setFeedback("saved");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    void saveUrl();
  };

  return (
    <form onSubmit={handleSubmit}>
      <h3 class="text-sm font-medium text-gray-900 dark:text-gray-100">{t().remote.customAccessTitle}</h3>
      <p id={`${inputId}-description`} class="mt-1.5 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
        {t().remote.customAccessDesc}
      </p>
      <div class="mt-4 flex gap-3">
        <div class="min-w-0 flex-1">
          <label for={inputId} class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
            {t().remote.directHost}
          </label>
          <input
            id={inputId}
            data-testid="direct-access-host"
            type="text"
            inputMode="url"
            spellcheck={false}
            autocomplete="off"
            value={host()}
            onInput={(event) => {
              edited = true;
              setHost(event.currentTarget.value);
              setFeedback(null);
            }}
            onBlur={() => {
              if (/^https?:\/\//i.test(host().trim())) {
                try { applyAddress(host()); } catch { /* Keep invalid input editable until submit. */ }
              }
            }}
            disabled={saving() || props.disabled}
            placeholder={t().remote.directHostPlaceholder}
            aria-describedby={`${inputId}-description ${inputId}-feedback`}
            aria-invalid={feedback() === "invalid"}
            class="w-full px-3 py-2 text-sm rounded-md border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] dark:bg-[var(--cm-surface-2)] text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent disabled:opacity-50"
          />
        </div>
        <div class="w-24 shrink-0">
          <label for={`${inputId}-port`} class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
            {t().remote.directPort}
          </label>
          <input
            data-testid="direct-access-port"
            id={`${inputId}-port`}
            type="text"
            inputMode="numeric"
            autocomplete="off"
            value={port()}
            onInput={event => { edited = true; setPort(event.currentTarget.value); setFeedback(null); }}
            disabled={saving() || props.disabled}
            aria-describedby={`${inputId}-feedback`}
            aria-invalid={feedback() === "invalid"}
            class="w-full px-3 py-2 text-sm rounded-md border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] dark:bg-[var(--cm-surface-2)] text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent disabled:opacity-50"
          />
        </div>
      </div>
      <label for={`${inputId}-ssl`} class="mt-3 flex w-fit items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
        <input
          id={`${inputId}-ssl`}
          type="checkbox"
          checked={useTls()}
          onChange={event => { edited = true; setUseTls(event.currentTarget.checked); setFeedback(null); }}
          disabled={saving() || props.disabled}
          class="h-4 w-4 accent-gray-800 dark:accent-gray-200"
        />
        {t().remote.directUseSsl}
      </label>
      <div class="mt-6 flex items-center justify-end gap-2">
        <Show when={props.onCancel}>
          <button type="button" disabled={saving() || props.disabled} onClick={() => props.onCancel?.()} class="min-h-9 rounded-lg border border-[var(--cm-hairline-strong)] px-3 text-xs font-medium text-gray-700 hover:bg-black/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-500 disabled:opacity-50 dark:text-gray-200 dark:hover:bg-white/[0.05]">{t().common.cancel}</button>
        </Show>
        <button
          type="submit"
          data-testid="save-direct-access"
          disabled={saving() || props.disabled}
          class="cm-btn-primary min-h-9 rounded-lg px-4 text-xs font-medium disabled:opacity-50"
        >
          <Show when={saving()} fallback={props.active ? t().remote.updateAccess : t().remote.enableDirectAccess}>
            {t().remote.accessSwitching}
          </Show>
        </button>
      </div>
      <p
        id={`${inputId}-feedback`}
        role="status"
        class={`mt-2 text-xs ${feedback() === "saved" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
      >
        <Show when={feedback() === "saved" && props.active}>{t().remote.customAccessSaved}</Show>
        <Show when={feedback() === "invalid"}>{t().remote.customAccessInvalid}</Show>
      </p>
    </form>
  );
}
