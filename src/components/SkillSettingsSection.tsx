import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
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
  SkillScopedInstance,
  SkillSummary,
  UnifiedProject,
} from "../types/unified";
import { Spinner } from "./Spinner";

interface WorkspaceOption {
  directory: string;
  label: string;
}

interface SelectedSkillReference {
  name: string;
  scope: SkillScope;
}

interface ScopeGroup {
  scope: SkillScope;
  title: string;
  description: string;
  skills: Array<{
    skill: SkillSummary;
    instance: SkillScopedInstance;
  }>;
}

type SkillScopeStatus = "effective" | "disabled" | "overridden";

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

function scopeCardClass(scope: SkillScope): string {
  switch (scope) {
    case "project":
      return "border-blue-200 hover:border-blue-300 hover:bg-blue-50/60 dark:border-blue-900/50 dark:hover:border-blue-700 dark:hover:bg-blue-900/10";
    case "global":
      return "border-purple-200 hover:border-purple-300 hover:bg-purple-50/60 dark:border-purple-900/50 dark:hover:border-purple-700 dark:hover:bg-purple-900/10";
    case "builtin":
      return "border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:border-slate-600 dark:hover:bg-slate-700/30";
  }
}

function isMutableScope(scope: SkillScope): scope is SkillMutableScope {
  return scope === "project" || scope === "global";
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
  const [selectedSkillRef, setSelectedSkillRef] = createSignal<SelectedSkillReference | null>(null);

  const formatDiagnosticMessage = (diagnostic: SkillDiagnostic): string => {
    const params = diagnostic.params ?? {};
    const values = {
      name: params.name ?? diagnostic.skillName ?? "",
      path: params.path ?? "",
      reason: params.reason ?? diagnostic.code,
      scope: params.scope ?? "",
    };
    switch (diagnostic.code) {
      case "exposure-conflict":
        return formatMessage(t().skill.diagnosticExposureConflict, values);
      case "engine-exposure-failed":
        return formatMessage(t().skill.diagnosticEngineExposureFailed, values);
      case "invalid-skill":
        return formatMessage(t().skill.diagnosticInvalidSkill, values);
      case "skill-shadowed":
        return formatMessage(t().skill.diagnosticSkillShadowed, values);
    }
  };

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

  const fetchSkillResponse = async (workspaceDirectory: string) => {
    if (!workspaceDirectory) return null;
    setActionError(null);
    await ensureGatewayInitialized();
    return gateway.listSkills(workspaceDirectory);
  };

  const [skillResponse, { mutate: setSkillResponse }] = createResource(
    selectedWorkspace,
    fetchSkillResponse,
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

  const handleEscapeKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && selectedSkillRef()) {
      setSelectedSkillRef(null);
    }
  };

  onMount(() => {
    window.addEventListener("keydown", handleEscapeKey);
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleEscapeKey);
  });

  createEffect(() => {
    const options = workspaceOptions();
    if (options.length === 0) return;

    const currentDirectory = currentSessionDirectory();
    const defaultProject = [...sessionStore.projects, ...workspaceProjects()].find((project) => project.isDefault);
    const preferred =
      options.find((option) => option.directory === currentDirectory)
      ?? options.find((option) => option.directory === defaultProject?.directory)
      ?? options[0];
    if (!selectedWorkspace()) {
      setSelectedWorkspace(preferred.directory);
    }
  });

  const runAction = async (
    key: string,
    action: () => Promise<void>,
  ) => {
    setActionLoading(key);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionLoading(null);
    }
  };

  const updateSkillResponsesAfterMutation = async (
    workspaceDirectory: string,
    response: SkillListResponse,
  ) => {
    const visibleWorkspace = selectedWorkspace();
    if (!visibleWorkspace) return;
    const visibleResponse = visibleWorkspace === workspaceDirectory
      ? response
      : await gateway.listSkills(visibleWorkspace);
    setSkillResponse(visibleResponse);
  };

  const handleRefresh = () => {
    const workspaceDirectory = selectedWorkspace();
    if (!workspaceDirectory) return;
    void runAction("refresh", async () => {
      const response = await gateway.refreshSkills(workspaceDirectory);
      setSkillResponse(response);
    });
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
      async () => {
        const response = await gateway.setSkillEnabled(workspaceDirectory, skillName, scope, enabled);
        await updateSkillResponsesAfterMutation(workspaceDirectory, response);
      },
    );
  };

  const handleDelete = (skill: SkillSummary, scope: SkillMutableScope) => {
    const workspaceDirectory = selectedWorkspace();
    if (!workspaceDirectory) return;
    if (!confirm(formatMessage(t().skill.deleteConfirm, {
      name: `${skill.name} (${scopeLabel(scope)})`,
    }))) {
      return;
    }
    void runAction(
      `delete:${scope}:${skill.name}`,
      async () => {
        const response = await gateway.deleteSkill(workspaceDirectory, skill.name, scope);
        await updateSkillResponsesAfterMutation(workspaceDirectory, response);
      },
    );
  };

  const handleOpenPath = async (filePath?: string) => {
    if (!filePath) return;
    setActionError(null);
    try {
      const openError = await systemAPI.openPath(filePath);
      if (openError) {
        setActionError(openError);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleOpenDiagnosticAction = async (diagnostic: SkillDiagnostic) => {
    await handleOpenPath(diagnostic.action?.path);
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

  const disabledAtScopeText = (scope: SkillMutableScope): string =>
    formatMessage(t().skill.disabledAt, { scopes: scopeLabel(scope) });

  const isScopeDisabled = (skill: SkillSummary, scope: SkillScope): boolean =>
    isMutableScope(scope) && getDisabledAt(skill, scope);

  const scopeStatus = (skill: SkillSummary, scope: SkillScope): SkillScopeStatus => {
    if (isScopeDisabled(skill, scope)) {
      return "disabled";
    }
    if (skill.effectiveScope === scope) {
      return "effective";
    }
    return "overridden";
  };

  const scopeStatusText = (skill: SkillSummary, scope: SkillScope): string => {
    switch (scopeStatus(skill, scope)) {
      case "effective":
        return t().skill.effective;
      case "disabled":
        return t().skill.disabled;
      case "overridden":
        return t().skill.overridden;
    }
  };

  const scopeStatusTitle = (skill: SkillSummary, scope: SkillScope): string => {
    if (isMutableScope(scope) && getDisabledAt(skill, scope)) {
      return disabledAtScopeText(scope);
    }
    return scopeStatusText(skill, scope);
  };

  const scopeStatusBadgeClass = (skill: SkillSummary, scope: SkillScope): string => {
    switch (scopeStatus(skill, scope)) {
      case "effective":
        return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300";
      case "disabled":
        return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300";
      case "overridden":
        return "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300";
    }
  };

  const scopeToggleLabel = (skill: SkillSummary, scope: SkillMutableScope): string => {
    return getDisabledAt(skill, scope) ? t().skill.enableSkill : t().skill.disableSkill;
  };

  const scopeToggleTitle = (skill: SkillSummary, scope: SkillMutableScope): string => {
    if (scope === "project") {
      return getDisabledAt(skill, "project") ? t().skill.enableForProject : t().skill.disableForProject;
    }
    return getDisabledAt(skill, "global") ? t().skill.enableGlobally : t().skill.disableGlobally;
  };

  const matchesSearch = (skill: SkillSummary): boolean => {
    const query = searchQuery().trim().toLowerCase();
    if (!query) return true;
    return (
      skill.name.toLowerCase().includes(query)
      || (skill.description ?? "").toLowerCase().includes(query)
      || skill.scopes.some((instance) => scopeLabel(instance.scope).toLowerCase().includes(query))
    );
  };

  const visibleSkills = createMemo(() => (skillResponse()?.skills ?? []).filter(matchesSearch));

  const scopeDefinitions = createMemo(() => [
    {
      scope: "global" as const,
      title: scopeLabel("global"),
      description: t().skill.scopeGlobalDesc,
    },
    {
      scope: "project" as const,
      title: scopeLabel("project"),
      description: t().skill.scopeProjectDesc,
    },
    {
      scope: "builtin" as const,
      title: scopeLabel("builtin"),
      description: t().skill.scopeBuiltinDesc,
    },
  ]);

  const groupedSkills = createMemo<ScopeGroup[]>(() =>
    scopeDefinitions().map((definition) => ({
      ...definition,
      skills: visibleSkills()
        .map((skill) => ({
          skill,
          instance: skill.scopes.find((instance) => instance.scope === definition.scope),
        }))
        .filter((entry): entry is { skill: SkillSummary; instance: SkillScopedInstance } => !!entry.instance),
    })),
  );

  const selectedSkill = createMemo(() => {
    const selected = selectedSkillRef();
    if (!selected) return null;
    return skillResponse()?.skills.find((skill) => skill.name === selected.name) ?? null;
  });

  const selectedInstance = createMemo(() => {
    const skill = selectedSkill();
    const selected = selectedSkillRef();
    if (!skill || !selected) return null;
    return skill.scopes.find((instance) => instance.scope === selected.scope) ?? null;
  });

  const selectedOtherScopes = createMemo(() => {
    const skill = selectedSkill();
    const selected = selectedSkillRef();
    if (!skill || !selected) return [];
    return skill.scopes.filter((instance) => instance.scope !== selected.scope);
  });

  const selectedMutableScope = createMemo<SkillMutableScope | null>(() => {
    const scope = selectedInstance()?.scope;
    return scope && isMutableScope(scope) ? scope : null;
  });

  const selectedDiagnostics = createMemo(() => {
    const selected = selectedSkillRef();
    const skill = selectedSkill();
    if (!selected || !skill) return [];
    return (skillResponse()?.diagnostics ?? []).filter((diagnostic) => diagnostic.skillName === skill.name);
  });

  const selectedHasBodyContent = createMemo(() =>
    selectedOtherScopes().length > 0 || selectedDiagnostics().length > 0,
  );

  const diagnostics = createMemo(() => skillResponse()?.diagnostics ?? []);

  const skillsLoading = createMemo(() => skillResponse.loading);
  const hasVisibleSkills = createMemo(() => groupedSkills().some((group) => group.skills.length > 0));

  const selectedProjectWorkspaceLabel = createMemo(() =>
    workspaceOptions().find((workspace) => workspace.directory === selectedWorkspace())?.label ?? t().skill.currentSessionWorkspace,
  );

  createEffect(() => {
    const selected = selectedSkillRef();
    const response = skillResponse();
    if (selected && response && !response.skills.some((skill) => skill.name === selected.name)) {
      setSelectedSkillRef(null);
    }
  });

  return (
    <section id="section-skills">
      <div class="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-4 px-1">
        <div>
          <h2 class="text-sm font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            {t().skill.title}
          </h2>
          <p class="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {t().skill.description}
          </p>
        </div>
        <div class="flex flex-col sm:flex-row gap-2 w-full lg:w-auto">
          <input
            type="search"
            value={searchQuery()}
            onInput={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder={t().skill.searchPlaceholder}
            class="w-full sm:w-[240px] px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button
            onClick={handleRefresh}
            disabled={!selectedWorkspace() || actionLoading() === "refresh" || skillsLoading()}
            class="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Show when={actionLoading() === "refresh"} fallback={t().skill.refresh}>
              {t().skill.refreshing}
            </Show>
          </button>
        </div>
      </div>

      <div class="space-y-4">
        <Show when={workspaceError()}>
          <div class="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 p-3">
            <p class="text-xs text-red-700 dark:text-red-300 break-words">{workspaceError()}</p>
          </div>
        </Show>

        <Show when={actionError()}>
          <div class="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 p-3">
            <p class="text-xs text-red-700 dark:text-red-300 break-words">{actionError()}</p>
          </div>
        </Show>

        <Show when={diagnostics().length > 0}>
          <div class="space-y-2">
            <For each={diagnostics()}>
              {(diagnostic) => (
                <div class={`rounded-lg border p-3 ${diagnosticClass(diagnostic)}`}>
                  <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                    <p class="text-xs break-words">
                      <span class="font-medium">{t().skill.diagnostic}: </span>
                      {formatDiagnosticMessage(diagnostic)}
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
          when={!skillsLoading()}
          fallback={
            <div class="p-6 flex items-center justify-center gap-2 text-sm text-slate-400 dark:text-slate-500">
              <Spinner size="small" class="text-slate-400 dark:text-slate-500" />
              <span>{t().common.loading}</span>
            </div>
          }
        >
          <Show
            when={hasVisibleSkills()}
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
            <div class="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
              <For each={groupedSkills()}>
                {(group) => (
                  <section class="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/30 p-4 min-h-[360px]">
                    <div class="flex items-start justify-between gap-3 pb-3 border-b border-slate-200/70 dark:border-slate-700">
                      <div class="min-w-0">
                        <h3 class="text-sm font-semibold text-gray-900 dark:text-white">
                          {group.title}
                        </h3>
                        <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          {group.description}
                        </p>
                      </div>
                      <span class={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${scopeBadgeClass(group.scope)}`}>
                        {group.skills.length}
                      </span>
                    </div>

                    <Show when={group.scope === "project"}>
                      <div class="mt-3 rounded-xl border border-blue-100 dark:border-blue-900/40 bg-blue-50/60 dark:bg-blue-900/10 p-3">
                        <Show
                          when={workspaceOptions().length > 0}
                          fallback={
                            <div class="text-xs text-slate-400 dark:text-slate-500">
                              <Show when={loadingWorkspaces()} fallback={t().skill.noWorkspace}>
                                <div class="flex items-center gap-2">
                                  <Spinner size="small" class="text-slate-400 dark:text-slate-500" />
                                  <span>{t().common.loading}</span>
                                </div>
                              </Show>
                            </div>
                          }
                        >
                          <select
                            value={selectedWorkspace()}
                            onChange={(event) => setSelectedWorkspace(event.currentTarget.value)}
                            class="w-full px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 transition-colors"
                          >
                            <For each={workspaceOptions()}>
                              {(workspace) => (
                                <option value={workspace.directory}>{workspace.label}</option>
                              )}
                            </For>
                          </select>
                          <Show when={selectedWorkspace()}>
                            <p class="text-[11px] text-gray-400 dark:text-gray-500 mt-2 truncate" title={selectedWorkspace()}>
                              {selectedProjectWorkspaceLabel()}
                            </p>
                          </Show>
                        </Show>
                      </div>
                    </Show>

                    <div class="mt-4 space-y-3">
                      <Show
                        when={group.skills.length > 0}
                        fallback={
                          <div class="rounded-xl border border-dashed border-slate-200 dark:border-slate-700 p-4 text-center text-xs text-slate-400 dark:text-slate-500">
                            {t().skill.noSkillsInScope}
                          </div>
                        }
                      >
                        <For each={group.skills}>
                          {({ skill, instance }) => {
                            const status = () => scopeStatus(skill, instance.scope);
                            return (
                              <div
                                role="button"
                                tabIndex={0}
                                onClick={() => setSelectedSkillRef({ name: skill.name, scope: instance.scope })}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    setSelectedSkillRef({ name: skill.name, scope: instance.scope });
                                  }
                                }}
                                class={`text-left rounded-xl border bg-white dark:bg-slate-800 p-4 transition-colors ${scopeCardClass(instance.scope)}`}
                              >
                                <div class="flex items-start justify-between gap-3">
                                  <div class="min-w-0">
                                    <h4 class="text-sm font-semibold text-gray-900 dark:text-white break-all">
                                      {skill.name}
                                    </h4>
                                    <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 break-words max-h-10 overflow-hidden">
                                      {instance.description || skill.description || t().skill.noDescription}
                                    </p>
                                  </div>
                                  <span
                                    class={`shrink-0 mt-0.5 h-2.5 w-2.5 rounded-full ${
                                      status() === "disabled"
                                        ? "bg-amber-400"
                                        : status() === "effective"
                                          ? "bg-emerald-500"
                                          : "bg-slate-300 dark:bg-slate-600"
                                    }`}
                                    title={scopeStatusTitle(skill, instance.scope)}
                                  />
                                </div>

                                <div class="mt-3 flex flex-wrap items-center gap-1.5">
                                  <span
                                    class={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${scopeStatusBadgeClass(skill, instance.scope)}`}
                                    title={scopeStatusTitle(skill, instance.scope)}
                                  >
                                    {scopeStatusText(skill, instance.scope)}
                                  </span>
                                  <span class={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${scopeBadgeClass(instance.scope)}`}>
                                    {scopeLabel(instance.scope)}
                                  </span>
                                </div>

                                <div class="mt-4 flex items-center justify-between gap-3">
                                  <span class="text-[11px] text-slate-400 dark:text-slate-500">
                                    {t().skill.cardDetails}
                                  </span>
                                  <div class="flex items-center gap-1.5">
                                    <Show when={isMutableScope(instance.scope) ? instance.scope : null}>
                                      {(scope) => (
                                        <button
                                          type="button"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            handleSetEnabled(skill.name, scope(), getDisabledAt(skill, scope()));
                                          }}
                                          disabled={!!actionLoading()}
                                          title={scopeToggleTitle(skill, scope())}
                                          class="px-2 py-1 text-[11px] font-medium rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                        >
                                          {scopeToggleLabel(skill, scope())}
                                        </button>
                                      )}
                                    </Show>
                                  </div>
                                </div>
                              </div>
                            );
                          }}
                        </For>
                      </Show>
                    </div>
                  </section>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>

      <Show when={selectedSkill()} keyed>
        {(skill) => (
            <div
              class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 backdrop-blur-sm p-4 sm:p-6"
              onClick={() => setSelectedSkillRef(null)}
            >
              <div
                class="w-full max-w-5xl max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700"
                onClick={(event) => event.stopPropagation()}
              >
                <div class={`sticky top-0 z-10 bg-white/95 dark:bg-slate-900/95 backdrop-blur p-4 sm:p-6 rounded-t-2xl ${
                  selectedHasBodyContent() ? "border-b border-slate-200 dark:border-slate-700" : ""
                }`}>
                  <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div class="min-w-0 flex-1">
                      <p class="text-xs font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">
                        {t().skill.detailsTitle}
                      </p>
                      <h3 class="text-lg font-semibold text-gray-900 dark:text-white break-all mt-1">
                        {skill.name}
                      </h3>
                      <p class="text-sm text-gray-500 dark:text-gray-400 mt-2 break-words">
                        {skill.description || t().skill.noDescription}
                      </p>

                      <Show when={selectedInstance()?.path}>
                        {(sourcePath) => (
                          <div class="mt-3">
                            <p class="text-xs font-medium text-slate-400 dark:text-slate-500">
                              {t().skill.sourcePath}
                            </p>
                            <button
                              type="button"
                              onClick={() => void handleOpenPath(sourcePath())}
                              class="mt-1 block text-left text-xs font-mono break-all text-blue-600 dark:text-blue-400 hover:underline underline-offset-2"
                            >
                              {sourcePath()}
                            </button>
                          </div>
                        )}
                      </Show>

                      <div class="mt-4 flex flex-wrap items-center gap-2">
                        <Show when={selectedInstance()}>
                          {(instance) => (
                            <span class={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${scopeBadgeClass(instance().scope)}`}>
                              {scopeLabel(instance().scope)}
                            </span>
                          )}
                        </Show>
                        <Show when={selectedInstance()}>
                          {(instance) => (
                            <span
                              class={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${scopeStatusBadgeClass(skill, instance().scope)}`}
                              title={scopeStatusTitle(skill, instance().scope)}
                            >
                              {scopeStatusText(skill, instance().scope)}
                            </span>
                          )}
                        </Show>
                      </div>
                    </div>

                    <button
                      type="button"
                      aria-label={t().common.cancel}
                      title={t().common.cancel}
                      onClick={() => setSelectedSkillRef(null)}
                      class="shrink-0 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg transition-colors"
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
                  <Show when={selectedMutableScope()}>
                    {(scope) => (
                      <div class="mt-4 flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => handleSetEnabled(skill.name, scope(), getDisabledAt(skill, scope()))}
                          disabled={!!actionLoading()}
                          title={scopeToggleTitle(skill, scope())}
                          class="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {scopeToggleLabel(skill, scope())}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(skill, scope())}
                          disabled={!!actionLoading()}
                          title={formatMessage(t().skill.deleteConfirm, {
                            name: `${skill.name} (${scopeLabel(scope())})`,
                          })}
                          class="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {t().common.delete}
                        </button>
                      </div>
                    )}
                  </Show>
                </div>

                <Show when={selectedHasBodyContent()}>
                  <div class="p-4 sm:p-6 space-y-5">
                    <Show when={selectedOtherScopes().length > 0}>
                      <section>
                        <h4 class="text-sm font-semibold text-gray-900 dark:text-white mb-3">
                          {t().skill.otherScopes}
                        </h4>
                        <div class="space-y-3">
                          <For each={selectedOtherScopes()}>
                            {(instance) => (
                              <div class="rounded-xl border border-slate-200 dark:border-slate-700 p-4">
                                <div class="flex flex-wrap items-center gap-2">
                                  <span class={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${scopeBadgeClass(instance.scope)}`}>
                                    {scopeLabel(instance.scope)}
                                  </span>
                                  <span
                                    class={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${scopeStatusBadgeClass(skill, instance.scope)}`}
                                    title={scopeStatusTitle(skill, instance.scope)}
                                  >
                                    {scopeStatusText(skill, instance.scope)}
                                  </span>
                                </div>
                                <p class="text-sm text-gray-500 dark:text-gray-400 mt-3 break-words">
                                  {instance.description || skill.description || t().skill.noDescription}
                                </p>
                                <Show when={instance.path}>
                                  {(sourcePath) => (
                                    <button
                                      type="button"
                                      onClick={() => void handleOpenPath(sourcePath())}
                                      class="mt-3 text-left text-xs font-mono break-all text-blue-600 dark:text-blue-400 hover:underline underline-offset-2"
                                    >
                                      {sourcePath()}
                                    </button>
                                  )}
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      </section>
                    </Show>

                    <Show when={selectedDiagnostics().length > 0}>
                      <section>
                        <h4 class="text-sm font-semibold text-gray-900 dark:text-white mb-3">
                          {t().skill.diagnostic}
                        </h4>
                        <div class="space-y-2">
                          <For each={selectedDiagnostics()}>
                            {(diagnostic) => (
                              <div class={`rounded-lg border p-3 ${diagnosticClass(diagnostic)}`}>
                                <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                                  <p class="text-xs break-words">{formatDiagnosticMessage(diagnostic)}</p>
                                  <Show when={diagnostic.action?.path}>
                                    <button
                                      type="button"
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
                      </section>
                    </Show>
                  </div>
                </Show>
              </div>
            </div>
        )}
      </Show>
    </section>
  );
}
