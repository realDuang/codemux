import { createSignal, For, Show } from "solid-js";
import type { OrchestrationSubtask, RoleEngineMapping, OrchestratorRole } from "../../types/unified";

interface AvailableEngine {
  type: string;
  name: string;
  models?: { id: string; name?: string }[];
}

interface SubtaskEditorProps {
  subtask: OrchestrationSubtask;
  index: number;
  availableEngines: AvailableEngine[];
  allSubtasks: OrchestrationSubtask[];
  roleMappings?: RoleEngineMapping[];
  onUpdate: (updated: OrchestrationSubtask) => void;
  onDelete: () => void;
  onRoleChange?: (role: OrchestratorRole) => void;
  readOnly?: boolean;
}

const ROLE_LABELS: Record<string, string> = {
  explorer: "Explorer",
  researcher: "Researcher",
  reviewer: "Reviewer",
  designer: "Designer",
  coder: "Coder",
};

export function SubtaskEditor(props: SubtaskEditorProps) {
  const [expanded, setExpanded] = createSignal(false);

  const engineName = () => {
    const eng = props.availableEngines.find((e) => e.type === props.subtask.engineType);
    return eng?.name ?? props.subtask.engineType;
  };

  const depsLabel = () => {
    if (!props.subtask.dependsOn.length) return "";
    const labels = props.subtask.dependsOn.map((depId) => {
      const idx = props.allSubtasks.findIndex((t) => t.id === depId);
      return idx >= 0 ? `#${idx + 1}` : depId.slice(0, 6);
    });
    return `→ ${labels.join(", ")}`;
  };

  const selectedEngine = () =>
    props.availableEngines.find((e) => e.type === props.subtask.engineType);

  const availableModels = () => selectedEngine()?.models ?? [];

  const update = (partial: Partial<OrchestrationSubtask>) => {
    props.onUpdate({ ...props.subtask, ...partial });
  };

  const toggleDep = (id: string) => {
    const current = props.subtask.dependsOn;
    if (current.includes(id)) {
      update({ dependsOn: current.filter((d) => d !== id) });
    } else {
      update({ dependsOn: [...current, id] });
    }
  };

  const animationDelay = `${props.index * 50}ms`;

  return (
    <div
      class="rounded-lg border transition-all duration-200"
      style={{ "animation-delay": animationDelay }}
      classList={{
        "border-indigo-200 dark:border-indigo-800/60 bg-indigo-50/50 dark:bg-indigo-950/20": expanded(),
        "border-slate-200 dark:border-slate-700/50 bg-white/80 dark:bg-slate-800/50 hover:border-indigo-200 dark:hover:border-indigo-800/40": !expanded(),
      }}
    >
      {/* Collapsed header */}
      <button
        type="button"
        class="w-full flex items-center gap-2 px-3 py-2.5 text-left"
        onClick={() => !props.readOnly && setExpanded((v) => !v)}
      >
        {/* Expand triangle */}
        <span
          class="text-slate-400 dark:text-slate-500 text-xs transition-transform duration-200 flex-shrink-0"
          style={{ transform: expanded() ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▸
        </span>

        {/* Index badge */}
        <span class="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 text-[10px] font-bold flex items-center justify-center">
          {props.index + 1}
        </span>

        {/* Description */}
        <span class="flex-1 text-sm text-slate-700 dark:text-slate-200 truncate min-w-0">
          {props.subtask.description || <em class="text-slate-400 dark:text-slate-500">No description</em>}
        </span>

        {/* Role badge */}
        <Show when={props.subtask.role}>
          <span class="flex-shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded bg-violet-100/80 dark:bg-violet-900/40 text-violet-600 dark:text-violet-400 uppercase tracking-wide">
            {ROLE_LABELS[props.subtask.role!] ?? props.subtask.role}
          </span>
        </Show>

        {/* Engine badge */}
        <span class="flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-100/80 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 uppercase tracking-wide">
          {engineName()}
        </span>

        {/* Deps */}
        <Show when={depsLabel()}>
          <span class="flex-shrink-0 text-[10px] text-slate-400 dark:text-slate-500">
            {depsLabel()}
          </span>
        </Show>
      </button>

      {/* Expanded editor */}
      <Show when={expanded() && !props.readOnly}>
        <div class="px-3 pb-3 flex flex-col gap-3 border-t border-slate-100 dark:border-slate-700/50 pt-3">
          {/* Description */}
          <div class="flex flex-col gap-1">
            <label class="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Description
            </label>
            <textarea
              class="w-full text-sm rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-400/50 focus:border-indigo-400 transition-colors"
              rows={2}
              value={props.subtask.description}
              onInput={(e) => update({ description: e.currentTarget.value })}
              placeholder="Describe what this subtask should do..."
            />
          </div>

          {/* Role + Engine + Model row */}
          <div class="flex gap-2">
            {/* Role selector */}
            <Show when={props.roleMappings && props.roleMappings.length > 0}>
              <div class="flex flex-col gap-1 flex-1">
                <label class="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  Role
                </label>
                <select
                  class="text-sm rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400/50 focus:border-indigo-400 transition-colors"
                  value={props.subtask.role ?? ""}
                  onChange={(e) => {
                    const role = e.currentTarget.value as OrchestratorRole;
                    if (role && props.onRoleChange) {
                      props.onRoleChange(role);
                    }
                  }}
                >
                  <option value="">No role</option>
                  <For each={props.roleMappings!}>
                    {(mapping) => (
                      <option value={mapping.role}>
                        {mapping.label}
                      </option>
                    )}
                  </For>
                </select>
              </div>
            </Show>

            <div class="flex flex-col gap-1 flex-1">
              <label class="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Engine
              </label>
              <select
                class="text-sm rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400/50 focus:border-indigo-400 transition-colors"
                value={props.subtask.engineType}
                onChange={(e) => update({ engineType: e.currentTarget.value, modelId: undefined })}
              >
                <For each={props.availableEngines}>
                  {(eng) => <option value={eng.type}>{eng.name}</option>}
                </For>
              </select>
            </div>

            <Show when={availableModels().length > 0}>
              <div class="flex flex-col gap-1 flex-1">
                <label class="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  Model
                </label>
                <select
                  class="text-sm rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400/50 focus:border-indigo-400 transition-colors"
                  value={props.subtask.modelId ?? ""}
                  onChange={(e) => update({ modelId: e.currentTarget.value || undefined })}
                >
                  <option value="">Default</option>
                  <For each={availableModels()}>
                    {(m) => <option value={m.id}>{m.name ?? m.id}</option>}
                  </For>
                </select>
              </div>
            </Show>
          </div>

          {/* Dependencies */}
          <Show when={props.allSubtasks.length > 1}>
            <div class="flex flex-col gap-1">
              <label class="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Depends on
              </label>
              <div class="flex flex-wrap gap-1.5">
                <For each={props.allSubtasks.filter((t) => t.id !== props.subtask.id)}>
                  {(other, otherIdx) => {
                    const isSelected = () => props.subtask.dependsOn.includes(other.id);
                    return (
                      <button
                        type="button"
                        onClick={() => toggleDep(other.id)}
                        class="text-[11px] px-2 py-1 rounded border transition-colors"
                        classList={{
                          "border-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300": isSelected(),
                          "border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:border-indigo-300 dark:hover:border-indigo-700": !isSelected(),
                        }}
                      >
                        #{otherIdx() + 1} {other.description.slice(0, 24)}{other.description.length > 24 ? "…" : ""}
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>
          </Show>

          {/* Delete */}
          <div class="flex justify-end pt-1">
            <button
              type="button"
              onClick={props.onDelete}
              class="text-xs text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              Remove subtask
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
