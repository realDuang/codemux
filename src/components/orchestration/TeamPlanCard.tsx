import { createSignal, For, Show } from "solid-js";
import type { OrchestrationRun, OrchestrationSubtask, RoleEngineMapping, OrchestratorRole } from "../../types/unified";
import { getRoleMappings, updateRoleMappings, DEFAULT_ROLE_MAPPINGS } from "../../stores/orchestration";
import { SubtaskEditor } from "./SubtaskEditor";
import { Collapsible } from "../Collapsible";
import styles from "./orchestration.module.css";

interface TeamPlanCardProps {
  run: OrchestrationRun;
  onConfirm: (subtasks: OrchestrationSubtask[]) => void;
  onCancel: () => void;
}

function makeSubtaskId(): string {
  return `stask_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function TeamPlanCard(props: TeamPlanCardProps) {
  const [subtasks, setSubtasks] = createSignal<OrchestrationSubtask[]>(
    props.run.subtasks.map((t) => ({ ...t })),
  );
  const [confirming, setConfirming] = createSignal(false);
  const [roleMappings, setRoleMappings] = createSignal<RoleEngineMapping[]>(
    getRoleMappings().map((m) => ({ ...m })),
  );

  // Build engine options from run.engineTypes
  const availableEngines = () =>
    props.run.engineTypes.map((type) => ({
      type,
      name: engineLabel(type),
      models: [],
    }));

  const updateSubtask = (index: number, updated: OrchestrationSubtask) => {
    setSubtasks((prev) => {
      const next = [...prev];
      next[index] = updated;
      return next;
    });
  };

  const deleteSubtask = (index: number) => {
    setSubtasks((prev) => prev.filter((_, i) => i !== index));
  };

  const addSubtask = () => {
    const firstEngine = props.run.engineTypes[0] ?? "claude";
    setSubtasks((prev) => [
      ...prev,
      {
        id: makeSubtaskId(),
        description: "",
        engineType: firstEngine,
        dependsOn: [],
        needsWorktree: false,
        status: "blocked",
      },
    ]);
  };

  const handleConfirm = async () => {
    // Persist role mappings before confirming
    updateRoleMappings(roleMappings());
    setConfirming(true);
    try {
      await props.onConfirm(subtasks());
    } finally {
      setConfirming(false);
    }
  };

  const updateRoleEngine = (role: OrchestratorRole, engineType: string) => {
    setRoleMappings((prev) =>
      prev.map((m) => (m.role === role ? { ...m, engineType } : m)),
    );
  };

  const handleRoleChange = (subtaskIndex: number, role: OrchestratorRole) => {
    const mapping = roleMappings().find((m) => m.role === role);
    if (!mapping) return;
    setSubtasks((prev) => {
      const next = [...prev];
      next[subtaskIndex] = {
        ...next[subtaskIndex],
        role,
        engineType: mapping.engineType,
        modelId: mapping.modelId,
      };
      return next;
    });
  };

  return (
    <div class={`${styles.teamCard} ${styles.slideUp} flex flex-col gap-4`}>
      {/* Header */}
      <div class="flex items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 uppercase tracking-wider">
              Team Plan
            </span>
            <span class="text-[11px] text-slate-400 dark:text-slate-500">
              {subtasks().length} subtask{subtasks().length !== 1 ? "s" : ""}
            </span>
          </div>
          <h2 class="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Review & Edit Execution Plan
          </h2>
        </div>
        <button
          type="button"
          onClick={props.onCancel}
          class="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          Cancel
        </button>
      </div>

      {/* Original prompt */}
      <div class="rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700/40 px-3 py-2.5">
        <p class="text-[10px] font-medium text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
          Original prompt
        </p>
        <p class="text-sm text-slate-700 dark:text-slate-200 leading-relaxed">
          {props.run.prompt}
        </p>
      </div>

      {/* Role Configuration */}
      <Collapsible defaultOpen={false}>
        <div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50/50 dark:bg-slate-800/30">
          <Collapsible.Trigger class="w-full flex items-center gap-2 px-3 py-2 text-left">
            <Collapsible.Arrow />
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-slate-400">
              <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span class="text-[11px] font-medium text-slate-600 dark:text-slate-300">
              Role Configuration
            </span>
            <span class="text-[10px] text-slate-400 dark:text-slate-500 ml-auto">
              {roleMappings().length} roles
            </span>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div class="px-3 pb-3 pt-1 flex flex-col gap-2 border-t border-slate-200 dark:border-slate-700/50">
              <For each={roleMappings()}>
                {(mapping) => (
                  <div class="flex items-center gap-2">
                    <span class="text-[11px] font-medium text-slate-600 dark:text-slate-300 w-20 flex-shrink-0 capitalize">
                      {mapping.label}
                    </span>
                    <span class="text-[10px] text-slate-400 dark:text-slate-500 flex-1 min-w-0 truncate">
                      {mapping.description}
                    </span>
                    <select
                      class="text-[11px] rounded border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-400/50 w-24 flex-shrink-0"
                      value={mapping.engineType}
                      onChange={(e) => updateRoleEngine(mapping.role, e.currentTarget.value)}
                    >
                      <For each={availableEngines()}>
                        {(eng) => <option value={eng.type}>{eng.name}</option>}
                      </For>
                    </select>
                  </div>
                )}
              </For>
            </div>
          </Collapsible.Content>
        </div>
      </Collapsible>

      {/* Subtask list */}
      <div class="flex flex-col gap-2">
        <For each={subtasks()}>
          {(task, idx) => (
            <SubtaskEditor
              subtask={task}
              index={idx()}
              availableEngines={availableEngines()}
              allSubtasks={subtasks()}
              roleMappings={roleMappings()}
              onUpdate={(updated) => updateSubtask(idx(), updated)}
              onDelete={() => deleteSubtask(idx())}
              onRoleChange={(role) => handleRoleChange(idx(), role)}
            />
          )}
        </For>
      </div>

      {/* Add subtask */}
      <button
        type="button"
        onClick={addSubtask}
        class="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:border-indigo-400 dark:hover:border-indigo-600 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50/50 dark:hover:bg-indigo-900/20 transition-all text-sm"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 12h14" /><path d="M12 5v14" />
        </svg>
        Add Subtask
      </button>

      {/* Actions */}
      <div class="flex items-center justify-between pt-1 border-t border-slate-100 dark:border-slate-800/60">
        <span class="text-[11px] text-slate-400 dark:text-slate-500">
          Engines: {props.run.engineTypes.join(", ")}
        </span>
        <button
          type="button"
          disabled={subtasks().length === 0 || confirming()}
          onClick={handleConfirm}
          class="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors shadow-sm"
        >
          <Show
            when={!confirming()}
            fallback={
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="animate-spin">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            }
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 3l14 9-14 9V3z" />
            </svg>
          </Show>
          Execute →
        </button>
      </div>
    </div>
  );
}

function engineLabel(type: string): string {
  const map: Record<string, string> = {
    claude: "Claude",
    opencode: "OpenCode",
    copilot: "Copilot",
    codex: "Codex",
  };
  return map[type] ?? type;
}
