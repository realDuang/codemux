import { createSignal, createEffect, createMemo, Show, For } from "solid-js";
import { useI18n } from "../lib/i18n";

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "toggle";
  placeholder?: string;
  required?: boolean;
  /** When true, the field is shown but cannot be changed */
  disabled?: boolean;
}

interface ChannelConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  fields: ConfigField[];
  initialConfig: Record<string, unknown>;
  onSave: (config: Record<string, unknown>) => Promise<void>;
}

export function ChannelConfigModal(props: ChannelConfigModalProps) {
  const { t } = useI18n();
  const [config, setConfig] = createSignal<Record<string, unknown>>({ ...props.initialConfig });
  const [saving, setSaving] = createSignal(false);

  createEffect(() => {
    if (props.isOpen) {
      setConfig({ ...props.initialConfig });
    }
  });

  const hasRequiredFields = createMemo(() => {
    return props.fields.every((field) => {
      if (!field.required) return true;
      const val = config()[field.key];
      if (typeof val === "string") return val.trim() !== "";
      if (typeof val === "number") return Number.isFinite(val);
      return val != null;
    });
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

  const updateField = (key: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
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
          aria-labelledby="channel-config-modal-title"
          class="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        >
          {/* Header */}
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-slate-800">
            <h2 id="channel-config-modal-title" class="text-lg font-semibold text-gray-900 dark:text-white">
              {props.title}
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
          <div class="p-6 space-y-5">
            <For each={props.fields}>
              {(field) => (
                <Show
                  when={field.type !== "toggle"}
                  fallback={
                    <div class="flex items-center justify-between">
                      <div>
                        <h4 class="text-sm font-medium text-gray-700 dark:text-gray-300">
                          {field.label}
                        </h4>
                      </div>
                      <button
                        onClick={() => { if (!field.disabled) updateField(field.key, !config()[field.key]); }}
                        disabled={field.disabled}
                        class={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          config()[field.key]
                            ? "bg-blue-500"
                            : "bg-gray-300 dark:bg-slate-600"
                        } ${field.disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                      >
                        <span
                          class={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            config()[field.key]
                              ? "translate-x-6"
                              : "translate-x-1"
                          }`}
                        />
                      </button>
                    </div>
                  }
                >
                  <div>
                    <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                      {field.label}
                    </label>
                    <input
                      type={field.type}
                      value={(config()[field.key] as string | number) ?? ""}
                      onInput={(e) => {
                        const raw = e.currentTarget.value;
                        const val = field.type === "number"
                          ? (raw === "" ? undefined : Number(raw))
                          : raw;
                        updateField(field.key, val);
                      }}
                      placeholder={field.placeholder}
                      class="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                </Show>
              )}
            </For>

            <Show when={!hasRequiredFields()}>
              <p class="text-xs text-gray-400 dark:text-gray-500">
                {t().channel.configRequired}
              </p>
            </Show>
          </div>

          {/* Footer */}
          <div class="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/50">
            <button
              onClick={props.onClose}
              class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
            >
              {t().common.cancel}
            </button>
            <button
              onClick={handleSave}
              disabled={saving() || !hasRequiredFields()}
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
