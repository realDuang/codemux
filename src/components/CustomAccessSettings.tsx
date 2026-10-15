import { createEffect, createMemo, createSignal, createUniqueId, Show } from "solid-js";
import { normalizeAccessUrl } from "../../shared/access-url";
import { useI18n } from "../lib/i18n";
import { remoteAccessAPI } from "../lib/electron-api";

interface CustomAccessSettingsProps {
  value: string;
  onSaved: (url: string) => void;
  disabled?: boolean;
}

export function CustomAccessSettings(props: CustomAccessSettingsProps) {
  const { t } = useI18n();
  const inputId = createUniqueId();
  const [draft, setDraft] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [feedback, setFeedback] = createSignal<"saved" | "invalid" | "failed" | null>(null);

  const savedValue = createMemo(() => props.value);
  createEffect(() => setDraft(savedValue()));

  const saveUrl = async (input: string) => {
    let url: string;
    try {
      url = normalizeAccessUrl(input);
    } catch {
      setFeedback("invalid");
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      const status = await remoteAccessAPI.getStatus();
      await remoteAccessAPI.update({ customAccessUrl: url, ...(status.mode === "custom" && !url ? { mode: "off" } : {}) });
      setDraft(url);
      props.onSaved(url);
      setFeedback("saved");
    } catch {
      setFeedback("failed");
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    void saveUrl(draft());
  };

  return (
    <form onSubmit={handleSubmit} class="rounded-lg border border-[var(--cm-hairline-strong)] p-4">
      <h3 class="text-sm font-medium text-gray-900 dark:text-white">{t().remote.customAccessTitle}</h3>
      <p id={`${inputId}-description`} class="text-xs text-gray-500 dark:text-gray-400 mt-1">
        {t().remote.customAccessDesc}
      </p>
      <div class="mt-3">
        <label for={inputId} class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
          {t().remote.customAccessUrl}
        </label>
        <input
          id={inputId}
          type="text"
          inputMode="url"
          spellcheck={false}
          autocomplete="off"
          value={draft()}
          onInput={(event) => {
            setDraft(event.currentTarget.value);
            setFeedback(null);
          }}
          disabled={saving() || props.disabled}
          placeholder={t().remote.customAccessUrlPlaceholder}
          aria-describedby={`${inputId}-description ${inputId}-feedback`}
          aria-invalid={feedback() === "invalid"}
          class="w-full px-3 py-1.5 text-sm rounded-md border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] dark:bg-[var(--cm-surface-2)] text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
        />
      </div>
      <div class="mt-3 flex items-center gap-2">
        <button
          type="submit"
          disabled={saving() || props.disabled}
          class="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          <Show when={saving()} fallback={t().common.save}>{t().channel.saving}</Show>
        </button>
        <button
          type="button"
          disabled={saving() || props.disabled || (!draft() && !props.value)}
          onClick={() => void saveUrl("")}
          class="px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--cm-hairline-strong)] text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
        >
          {t().remote.customAccessClear}
        </button>
      </div>
      <p
        id={`${inputId}-feedback`}
        role="status"
        class={`mt-2 text-xs ${feedback() === "saved" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
      >
        <Show when={feedback() === "saved"}>{t().remote.customAccessSaved}</Show>
        <Show when={feedback() === "invalid"}>{t().remote.customAccessInvalid}</Show>
        <Show when={feedback() === "failed"}>{t().remote.customAccessSaveFailed}</Show>
      </p>
    </form>
  );
}
