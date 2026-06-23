import { createEffect, createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import { formatMessage, useI18n } from "../lib/i18n";
import { ensureGatewayInitialized } from "../lib/engine-bootstrap";
import { gateway } from "../lib/gateway-api";
import { systemAPI } from "../lib/electron-api";
import { getProjectName, sessionStore } from "../stores/session";
import type {
  SkillDiagnostic,
  SkillListResponse,
  SkillMutableScope,
  SkillScope,
  SkillSummary,
  UnifiedProject,
} from "../types/unified";
import { Spinner } from "./Spinner";

interface WorkspaceOption {
  directory: string;
  label: string;
}

function scopeBadgeClass(scope: SkillScope): string {
  switch (scope) {
    case "project":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300";
    case "global":
      return "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300";
    case "builtin":
      return "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300";
  }
}

function diagnosticClass(diagnostic: SkillDiagnostic): string {
  if (diagnostic.severity === "error") {
    return "border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300";
  }
  if (diagnostic.severity === "warning") {
    return "border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300";
  }
  return "border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300";
}

function getDisabledAt(skill: SkillSummary, scope: SkillMutableScope): boolean {
  return skill.disabledAt?.some((entry) => entry.scope === scope) ?? false;
}

export function SkillSettingsSection() {
  const { t } = useI18n();
  const [workspaceProjects, setWorkspaceProjects] = createSignal<UnifiedProject[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = createSignal("");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [loadingWorkspaces, setLoadingWorkspaces] = createSignal(true);
  const [workspaceError, setWorkspaceError] = createSignal<string | null>(null);
  const [actionLoading, setActionLoading] = createSignal<string | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);

  const currentSessionDirectory = createMemo(() => {
    const currentId = sessionStore.current;
    return sessionStore.list.find((session) => session.id === currentId)?.directory;
  });

  const workspaceOptions = createMemo<WorkspaceOption[]>(() => {
    const byDirectory = new Map<string, WorkspaceOption>();
    for (const project of [...sessionStore.projects, ...workspaceProjects()]) {
      if (!project.directory) continue;
      byDirectory.set(project.directory, {
        directory: project.directory,
        label: project.isDefault ? `${getProjectName(project)} (${t().skill.defaultWorkspace})` : getProjectName(project),
      });
    }

    const currentDirectory = currentSessionDirectory();
    if (currentDirectory && !byDirectory.has(currentDirectory)) {
      byDirectory.set(currentDirectory, {
        directory: currentDirectory,
        label: t().skill.currentSessionWorkspace,
      });
    }

    return [...byDirectory.values()].sort((a, b) => a.label.localeCompare(b.label));
  });

  const [skillResponse, { mutate: setSkillResponse, refetch }] = createResource(
    selectedWorkspace,
    async (workspaceDirectory) => {
      if (!workspaceDirectory) return null;
      setActionError(null);
      await ensureGatewayInitialized();
      return gateway.listSkills(workspaceDirectory);
    },
  );

  onMount(async () => {
    setLoadingWorkspaces(true);
    setWorkspaceError(null);
    try {
      await ensureGatewayInitialized();
      const projects = await gateway.listAllProjects();
      setWorkspaceProjects(projects);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingWorkspaces(false);
    }
  });

  createEffect(() => {
    if (selectedWorkspace()) return;
    const options = workspaceOptions();
    if (options.length === 0) return;

    const currentDirectory = currentSessionDirectory();
    const defaultProject = [...sessionStore.projects, ...workspaceProjects()].find((project) => project.isDefault);
    const preferred =
      options.find((option) => option.directory === currentDirectory)
      ?? options.find((option) => option.directory === defaultProject?.directory)
      ?? options[0];
    setSelectedWorkspace(preferred.directory);
  });

  const applyResponse = (response: SkillListResponse) => {
    setSkillResponse(response);
    setActionError(null);
  };

  const runAction = async (
    key: string,
    action: () => Promise<SkillListResponse>,
  ) => {
    setActionLoading(key);
    setActionError(null);
    try {
      applyResponse(await action());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionLoading(null);
    }
  };

  const handleRefresh = () => {
    const workspaceDirectory = selectedWorkspace();
    if (!workspaceDirectory) return;
    void runAction("refresh", () => gateway.refreshSkills(workspaceDirectory));
  };

  const handleSetEnabled = (
    skillName: string,
    scope: SkillMutableScope,
    enabled: boolean,
  ) => {
    const workspaceDirectory = selectedWorkspace();
    if (!workspaceDirectory) return;
    void runAction(
      `${scope}:${skillName}:${enabled ? "enable" : "disable"}`,
      () => gateway.setSkillEnabled(workspaceDirectory, skillName, scope, enabled),
    );
  };

  const getMutableScopes = (skill: SkillSummary): SkillMutableScope[] => {
    const scopes = new Set<SkillMutableScope>();
    for (const instance of skill.scopes) {
      if (instance.scope === "project" || instance.scope === "global") {
        scopes.add(instance.scope);
      }
    }
    return [...scopes];
  };

  const handleDelete = (skill: SkillSummary) => {
    const workspaceDirectory = selectedWorkspace();
    if (!workspaceDirectory) return;
    if (!confirm(formatMessage(t().skill.deleteConfirm, {
      name: skill.name,
    }))) {
      return;
    }
    const mutableScopes = getMutableScopes(skill);
    void runAction(
      `delete:${skill.name}`,
      async () => {
        let latestResponse: SkillListResponse | null = null;
        for (const scope of mutableScopes) {
          latestResponse = await gateway.deleteSkill(workspaceDirectory, skill.name, scope);
        }
        return latestResponse ?? gateway.listSkills(workspaceDirectory);
      },
    );
  };

  const handleOpenDiagnosticAction = async (diagnostic: SkillDiagnostic) => {
    const action = diagnostic.action;
    if (!action?.path) return;
    try {
      await systemAPI.openPath(action.path);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const scopeLabel = (scope: SkillScope): string => {
    switch (scope) {
      case "project":
        return t().skill.scopeProject;
      case "global":
        return t().skill.scopeGlobal;
      case "builtin":
        return t().skill.scopeBuiltin;
    }
  };

  const disabledText = (skill: SkillSummary): string => {
    const disabledScopes = skill.disabledAt?.map((entry) => scopeLabel(entry.scope)) ?? [];
    if (disabledScopes.length === 0) return t().skill.disabled;
    return formatMessage(t().skill.disabledAt, { scopes: disabledScopes.join(", ") });
  };

  const projectDisabled = (skill: SkillSummary) => getDisabledAt(skill, "project");
  const globalDisabled = (skill: SkillSummary) => getDisabledAt(skill, "global");
  const filteredSkills = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    const skills = skillResponse()?.skills ?? [];
    if (!query) return skills;
    return skills.filter((skill) =>
      skill.name.toLowerCase().includes(query)
      || (skill.description ?? "").toLowerCase().includes(query)
      || skill.scopes.some((instance) => scopeLabel(instance.scope).toLowerCase().includes(query))
    );
  });

  return (
    <section id="section-skills">
      <div class="flex items-start justify-between gap-4 mb-4 px-1">
        <div>
          <h2 class="text-sm font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            {t().skill.title}
          </h2>
          <p class="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {t().skill.description}
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!selectedWorkspace() || actionLoading() === "refresh" || skillResponse.loading}
          class="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Show when={actionLoading() === "refresh"} fallback={t().skill.refresh}>
            {t().skill.refreshing}
          </Show>
        </button>
      </div>

      <div class="bg-white dark:bg-slate-800 rounded-xl shadow-xs border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div class="p-4 sm:p-6 border-b border-slate-100 dark:border-slate-700">
          <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <h3 class="text-base font-medium text-gray-900 dark:text-white">
                {t().skill.workspace}
              </h3>
              <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {t().skill.workspaceDesc}
              </p>
            </div>
            <Show
              when={workspaceOptions().length > 0}
              fallback={
                <div class="text-sm text-slate-400 dark:text-slate-500">
                  <Show when={loadingWorkspaces()} fallback={t().skill.noWorkspace}>
                    <div class="flex items-center gap-2">
                      <Spinner size="small" class="text-slate-400 dark:text-slate-500" />
                      <span>{t().common.loading}</span>
                    </div>
                  </Show>
                </div>
              }
            >
              <div class="flex flex-col sm:flex-row gap-2 w-full lg:w-auto">
                <select
                  value={selectedWorkspace()}
                  onChange={(event) => setSelectedWorkspace(event.currentTarget.value)}
                  class="w-full sm:w-[320px] px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 transition-colors"
                >
                  <For each={workspaceOptions()}>
                    {(workspace) => (
                      <option value={workspace.directory}>{workspace.label}</option>
                    )}
                  </For>
                </select>
                <input
                  type="search"
                  value={searchQuery()}
                  onInput={(event) => setSearchQuery(event.currentTarget.value)}
                  placeholder={t().skill.searchPlaceholder}
                  class="w-full sm:w-[240px] px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </Show>
          </div>
          <Show when={selectedWorkspace()}>
            <p class="text-xs text-gray-400 dark:text-gray-500 mt-2 font-mono truncate" title={selectedWorkspace()}>
              {selectedWorkspace()}
            </p>
          </Show>
        </div>

        <Show when={workspaceError()}>
          <div class="mx-4 sm:mx-6 mt-4 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 p-3">
            <p class="text-xs text-red-700 dark:text-red-300 break-words">{workspaceError()}</p>
          </div>
        </Show>

        <Show when={actionError()}>
          <div class="mx-4 sm:mx-6 mt-4 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 p-3">
            <p class="text-xs text-red-700 dark:text-red-300 break-words">{actionError()}</p>
          </div>
        </Show>

        <Show when={(skillResponse()?.diagnostics.length ?? 0) > 0}>
          <div class="p-4 sm:p-6 pb-0 space-y-2">
            <For each={skillResponse()?.diagnostics ?? []}>
              {(diagnostic) => (
                <div class={`rounded-lg border p-3 ${diagnosticClass(diagnostic)}`}>
                  <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                    <p class="text-xs break-words">
                      <span class="font-medium">{t().skill.diagnostic}: </span>
                      {diagnostic.message}
                    </p>
                    <Show when={diagnostic.action?.path}>
                      <button
                        onClick={() => void handleOpenDiagnosticAction(diagnostic)}
                        class="text-xs font-medium underline underline-offset-2 hover:opacity-80"
                      >
                        {t().skill.openPath}
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show
          when={!skillResponse.loading}
          fallback={
            <div class="p-6 flex items-center justify-center gap-2 text-sm text-slate-400 dark:text-slate-500">
              <Spinner size="small" class="text-slate-400 dark:text-slate-500" />
              <span>{t().common.loading}</span>
            </div>
          }
        >
          <Show
            when={filteredSkills().length > 0}
            fallback={
              <div class="p-6 text-center text-sm text-slate-400 dark:text-slate-500">
                {selectedWorkspace()
                  ? searchQuery().trim()
                    ? t().skill.noSearchResults
                    : t().skill.empty
                  : t().skill.noWorkspace}
              </div>
            }
          >
            <div class="divide-y divide-slate-100 dark:divide-slate-700">
              <For each={filteredSkills()}>
                {(skill) => (
                  <div class="p-4 sm:p-6">
                    <div class="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                      <div class="min-w-0">
                        <div class="flex flex-wrap items-center gap-2">
                          <h3 class="text-base font-medium text-gray-900 dark:text-white break-all">
                            {skill.name}
                          </h3>
                          <Show
                            when={skill.effectiveScope}
                            fallback={
                              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                                {t().skill.disabled}
                              </span>
                            }
                          >
                            {(scope) => (
                              <span class={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${scopeBadgeClass(scope())}`}>
                                {formatMessage(t().skill.effectiveScope, { scope: scopeLabel(scope()) })}
                              </span>
                            )}
                          </Show>
                        </div>
                        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1 break-words">
                          {skill.description || t().skill.noDescription}
                        </p>
                        <div class="flex flex-wrap items-center gap-2 mt-3">
                          <For each={skill.scopes}>
                            {(instance) => (
                              <span
                                class={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${scopeBadgeClass(instance.scope)}`}
                                title={
                                  instance.shadowedBy
                                    ? formatMessage(t().skill.shadowedBy, { scope: scopeLabel(instance.shadowedBy) })
                                    : instance.shadows && instance.shadows.length > 0
                                      ? formatMessage(t().skill.shadows, { scopes: instance.shadows.map(scopeLabel).join(", ") })
                                      : scopeLabel(instance.scope)
                                }
                              >
                                {scopeLabel(instance.scope)}
                              </span>
                            )}
                          </For>
                          <span class={`text-xs ${skill.enabled ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                            {skill.enabled ? t().skill.enabled : disabledText(skill)}
                          </span>
                        </div>
                      </div>

                      <div class="flex flex-wrap lg:justify-end gap-2 lg:max-w-[360px]">
                        <button
                          onClick={() => handleSetEnabled(skill.name, "project", projectDisabled(skill))}
                          disabled={!!actionLoading()}
                          class="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {projectDisabled(skill) ? t().skill.enableForProject : t().skill.disableForProject}
                        </button>
                        <button
                          onClick={() => handleSetEnabled(skill.name, "global", globalDisabled(skill))}
                          disabled={!!actionLoading()}
                          class="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {globalDisabled(skill) ? t().skill.enableGlobally : t().skill.disableGlobally}
                        </button>
                        <Show when={getMutableScopes(skill).length > 0}>
                          <button
                            onClick={() => handleDelete(skill)}
                            disabled={!!actionLoading()}
                            class="px-3 py-1.5 text-xs font-medium rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            {t().skill.deleteSkill}
                          </button>
                        </Show>
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </section>
  );
}
