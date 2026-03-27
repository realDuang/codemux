import { createSignal, createEffect, Show, For } from "solid-js";
import { useI18n, formatMessage } from "../lib/i18n";
import { isElectron } from "../lib/platform";
import { systemAPI } from "../lib/electron-api";
import type {
  ScheduledTask,
  ScheduledTaskCreateRequest,
  ScheduledTaskUpdateRequest,
  ScheduledTaskFrequencyType,
  ScheduledTaskFrequency,
  DayOfWeek,
  EngineType,
  UnifiedProject,
  EngineInfo,
} from "../types/unified";

interface ScheduledTaskModalProps {
  isOpen: boolean;
  editingTask?: ScheduledTask;
  projects: UnifiedProject[];
  engines: EngineInfo[];
  onClose: () => void;
  onSave: (req: ScheduledTaskCreateRequest | ScheduledTaskUpdateRequest) => Promise<void>;
}

export function ScheduledTaskModal(props: ScheduledTaskModalProps) {
  const { t } = useI18n();

  // Form state
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [prompt, setPrompt] = createSignal("");
  const [engineType, setEngineType] = createSignal("");
  const [directory, setDirectory] = createSignal("");
  const [frequencyType, setFrequencyType] = createSignal<ScheduledTaskFrequencyType>("daily");
  const [intervalMinutes, setIntervalMinutes] = createSignal(60);
  const [hour, setHour] = createSignal(9);
  const [minute, setMinute] = createSignal(0);
  const [daysOfWeek, setDaysOfWeek] = createSignal<DayOfWeek[]>([1]); // Monday
  const [enabled, setEnabled] = createSignal(true);

  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Reset form when modal opens/closes or editing task changes
  createEffect(() => {
    if (props.isOpen) {
      const task = props.editingTask;
      if (task) {
        setName(task.name);
        setDescription(task.description);
        setPrompt(task.prompt);
        setEngineType(task.engineType);
        setDirectory(task.directory);
        setFrequencyType(task.frequency.type);
        setIntervalMinutes(task.frequency.intervalMinutes ?? 60);
        setHour(task.frequency.hour ?? 9);
        setMinute(task.frequency.minute ?? 0);
        setDaysOfWeek(task.frequency.daysOfWeek ?? [1]);
        setEnabled(task.enabled);
      } else {
        // Create mode defaults
        setName("");
        setDescription("");
        setPrompt("");
        setEngineType(props.engines.find(e => e.status === "running")?.type || props.engines[0]?.type || "");
        setDirectory(props.projects[0]?.directory || "");
        setFrequencyType("daily");
        setIntervalMinutes(60);
        setHour(9);
        setMinute(0);
        setDaysOfWeek([1]);
        setEnabled(true);
      }
      setError(null);
    }
  });

  const isEdit = () => !!props.editingTask;

  const showTimeFields = () =>
    frequencyType() === "daily" || frequencyType() === "weekly";

  const showDaysOfWeek = () => frequencyType() === "weekly";
  const showInterval = () => frequencyType() === "interval";

  const handleSave = async () => {
    if (!name().trim()) {
      setError(formatMessage(t().scheduledTask.fieldRequired, { field: t().scheduledTask.name }));
      return;
    }
    if (!prompt().trim()) {
      setError(formatMessage(t().scheduledTask.fieldRequired, { field: t().scheduledTask.prompt }));
      return;
    }
    if (!engineType()) {
      setError(formatMessage(t().scheduledTask.fieldRequired, { field: t().scheduledTask.engineType }));
      return;
    }
    if (!directory().trim()) {
      setError(formatMessage(t().scheduledTask.fieldRequired, { field: t().scheduledTask.directory }));
      return;
    }
    if (frequencyType() === "weekly" && daysOfWeek().length === 0) {
      setError(t().scheduledTask.daysRequired);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const frequency: ScheduledTaskFrequency = { type: frequencyType() };
      if (showInterval()) {
        frequency.intervalMinutes = intervalMinutes();
      }
      if (showTimeFields()) {
        frequency.hour = hour();
        frequency.minute = minute();
      }
      if (showDaysOfWeek()) {
        frequency.daysOfWeek = [...daysOfWeek()].sort() as DayOfWeek[];
      }

      if (isEdit()) {
        const req: ScheduledTaskUpdateRequest = {
          id: props.editingTask!.id,
          name: name().trim(),
          description: description().trim(),
          prompt: prompt().trim(),
          engineType: engineType() as EngineType,
          directory: directory().trim(),
          frequency,
          enabled: enabled(),
        };
        await props.onSave(req);
      } else {
        const req: ScheduledTaskCreateRequest = {
          name: name().trim(),
          description: description().trim(),
          prompt: prompt().trim(),
          engineType: engineType() as EngineType,
          directory: directory().trim(),
          frequency,
          enabled: enabled(),
        };
        await props.onSave(req);
      }
      props.onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setError(null);
    props.onClose();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") handleClose();
  };

  const handleBrowseDirectory = async () => {
    const selected = await systemAPI.selectDirectory();
    if (selected) setDirectory(selected);
  };

  const toggleDayOfWeek = (day: DayOfWeek) => {
    setDaysOfWeek((prev) => {
      if (prev.includes(day)) {
        return prev.filter((d) => d !== day);
      }
      return [...prev, day];
    });
  };

  // Options
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from({ length: 12 }, (_, i) => i * 5);

  const intervalOptions = [
    { value: 5, label: () => t().scheduledTask.interval5m },
    { value: 10, label: () => t().scheduledTask.interval10m },
    { value: 30, label: () => t().scheduledTask.interval30m },
    { value: 60, label: () => t().scheduledTask.interval1h },
    { value: 120, label: () => t().scheduledTask.interval2h },
    { value: 360, label: () => t().scheduledTask.interval6h },
    { value: 720, label: () => t().scheduledTask.interval12h },
  ];

  const frequencyOptions: { value: ScheduledTaskFrequencyType; label: () => string }[] = [
    { value: "manual", label: () => t().scheduledTask.frequencyManual },
    { value: "interval", label: () => t().scheduledTask.frequencyInterval },
    { value: "daily", label: () => t().scheduledTask.frequencyDaily },
    { value: "weekly", label: () => t().scheduledTask.frequencyWeekly },
  ];

  // Shared input classes
  const inputClass = "w-full px-3 py-1.5 text-sm bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500";
  const selectClass = "w-full px-3 py-1.5 text-sm bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500";
  const labelClass = "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1";

  return (
    <Show when={props.isOpen}>
      <div class="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={handleKeyDown}>
        <div
          class="absolute inset-0 bg-black/50 backdrop-blur-xs"
          onClick={handleClose}
          aria-hidden="true"
        />

        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="task-modal-title"
          class="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden flex flex-col max-h-[calc(100vh-2rem)]"
        >
          {/* Header */}
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-slate-800">
            <h2 id="task-modal-title" class="text-lg font-semibold text-gray-900 dark:text-white">
              {isEdit() ? t().scheduledTask.edit : t().scheduledTask.create}
            </h2>
            <button
              onClick={handleClose}
              class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>

          {/* Body */}
          <div class="p-6 space-y-4 overflow-y-auto flex-1">
            {/* Name */}
            <div>
              <label class={labelClass}>{t().scheduledTask.name}</label>
              <input
                type="text"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                placeholder={t().scheduledTask.namePlaceholder}
                class={inputClass}
                autofocus
              />
            </div>

            {/* Description */}
            <div>
              <label class={labelClass}>{t().scheduledTask.description}</label>
              <input
                type="text"
                value={description()}
                onInput={(e) => setDescription(e.currentTarget.value)}
                placeholder={t().scheduledTask.descriptionPlaceholder}
                class={inputClass}
              />
            </div>

            {/* Prompt */}
            <div>
              <label class={labelClass}>{t().scheduledTask.prompt}</label>
              <textarea
                value={prompt()}
                onInput={(e) => setPrompt(e.currentTarget.value)}
                placeholder={t().scheduledTask.promptPlaceholder}
                rows={4}
                class={`${inputClass} resize-none`}
              />
            </div>

            {/* Engine */}
            <div>
              <label class={labelClass}>{t().scheduledTask.engineType}</label>
              <select
                value={engineType()}
                onChange={(e) => setEngineType(e.currentTarget.value)}
                class={selectClass}
              >
                <For each={props.engines.filter((e) => e.status === "running")}>
                  {(engine) => (
                    <option value={engine.type}>{engine.name}</option>
                  )}
                </For>
              </select>
            </div>

            {/* Directory / Project */}
            <div>
              <label class={labelClass}>{t().scheduledTask.directory}</label>
              <div class="flex gap-2">
                <Show
                  when={props.projects.length > 0}
                  fallback={
                    <input
                      type="text"
                      value={directory()}
                      onInput={(e) => setDirectory(e.currentTarget.value)}
                      placeholder={t().scheduledTask.directoryPlaceholder}
                      class={`flex-1 ${inputClass}`}
                    />
                  }
                >
                  <select
                    value={directory()}
                    onChange={(e) => setDirectory(e.currentTarget.value)}
                    class={`flex-1 ${selectClass}`}
                  >
                    <For each={props.projects}>
                      {(project) => (
                        <option value={project.directory}>
                          {project.name || project.directory.split(/[\\/]/).pop() || project.directory}
                        </option>
                      )}
                    </For>
                  </select>
                </Show>
                <Show when={isElectron()}>
                  <button
                    type="button"
                    onClick={handleBrowseDirectory}
                    class="px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600 border border-gray-300 dark:border-slate-600 rounded-lg transition-colors whitespace-nowrap"
                  >
                    ...
                  </button>
                </Show>
              </div>
            </div>

            {/* Frequency */}
            <div>
              <label class={labelClass}>{t().scheduledTask.frequency}</label>
              <div class="flex flex-wrap gap-2">
                <For each={frequencyOptions}>
                  {(opt) => (
                    <button
                      type="button"
                      onClick={() => setFrequencyType(opt.value)}
                      class={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                        frequencyType() === opt.value
                          ? "bg-blue-600 text-white border-blue-600"
                          : "bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-700"
                      }`}
                    >
                      {opt.label()}
                    </button>
                  )}
                </For>
              </div>
            </div>

            {/* Interval selector */}
            <Show when={showInterval()}>
              <div>
                <label class={labelClass}>{t().scheduledTask.intervalLabel}</label>
                <div class="flex flex-wrap gap-2">
                  <For each={intervalOptions}>
                    {(opt) => (
                      <button
                        type="button"
                        onClick={() => setIntervalMinutes(opt.value)}
                        class={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                          intervalMinutes() === opt.value
                            ? "bg-indigo-600 text-white border-indigo-600"
                            : "bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-700"
                        }`}
                      >
                        {opt.label()}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Time (hour:minute) */}
            <Show when={showTimeFields()}>
              <div>
                <label class={labelClass}>{t().scheduledTask.time}</label>
                <div class="flex items-center gap-2">
                  <select
                    value={hour()}
                    onChange={(e) => setHour(parseInt(e.currentTarget.value))}
                    class={`w-20 ${selectClass}`}
                  >
                    <For each={hours}>
                      {(h) => (
                        <option value={h}>{String(h).padStart(2, "0")}</option>
                      )}
                    </For>
                  </select>
                  <span class="text-gray-500 dark:text-gray-400 font-medium">:</span>
                  <select
                    value={minute()}
                    onChange={(e) => setMinute(parseInt(e.currentTarget.value))}
                    class={`w-20 ${selectClass}`}
                  >
                    <For each={minutes}>
                      {(m) => (
                        <option value={m}>{String(m).padStart(2, "0")}</option>
                      )}
                    </For>
                  </select>
                </div>
              </div>
            </Show>

            {/* Days of Week (multi-select) */}
            <Show when={showDaysOfWeek()}>
              <div>
                <label class={labelClass}>{t().scheduledTask.dayOfWeek}</label>
                <div class="flex flex-wrap gap-1.5">
                  <For each={[0, 1, 2, 3, 4, 5, 6] as DayOfWeek[]}>
                    {(d) => (
                      <button
                        type="button"
                        onClick={() => toggleDayOfWeek(d)}
                        class={`w-10 h-8 text-xs rounded-md border transition-colors ${
                          daysOfWeek().includes(d)
                            ? "bg-blue-600 text-white border-blue-600"
                            : "bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-700"
                        }`}
                      >
                        {t().scheduledTask.daysShort[d]}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Enabled toggle */}
            <div class="flex items-center justify-between">
              <label class="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t().scheduledTask.enabled}
              </label>
              <button
                type="button"
                onClick={() => setEnabled(!enabled())}
                class={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  enabled() ? "bg-blue-600" : "bg-gray-300 dark:bg-slate-600"
                }`}
                role="switch"
                aria-checked={enabled()}
              >
                <span
                  class={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    enabled() ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            {/* Error */}
            <Show when={error()}>
              <div class="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p class="text-sm text-red-700 dark:text-red-400">{error()}</p>
              </div>
            </Show>
          </div>

          {/* Footer */}
          <div class="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 px-6 py-4 border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/50 flex-shrink-0">
            <button
              onClick={handleClose}
              class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
            >
              {t().common.cancel}
            </button>
            <button
              onClick={handleSave}
              disabled={loading()}
              class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
            >
              {loading() ? t().common.loading : t().scheduledTask.save}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
