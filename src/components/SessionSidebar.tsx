import { For, Show, createSignal, createMemo, onMount } from "solid-js";
import { SessionInfo, sessionStore, setSessionStore, getProjectName } from "../stores/session";
import { useI18n, formatMessage } from "../lib/i18n";
import type { UnifiedProject, EngineType, SessionActivityStatus } from "../types/unified";
import { ProjectStore } from "../lib/project-store";
import { isElectron } from "../lib/platform";
import { systemAPI, getOpenCodeStoragePath, getCopilotStoragePath } from "../lib/electron-api";

interface SessionSidebarProps {
  sessions: SessionInfo[];
  currentSessionId: string | null;
  projects: UnifiedProject[];
  getSessionStatus: (sessionId: string) => SessionActivityStatus;
  onSelectSession: (sessionId: string) => void;
  onNewSession: (directory?: string, engineType?: EngineType) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, newTitle: string) => void;
  onDeleteProjectSessions: (projectID: string, projectName: string, sessionCount: number) => void;
  onAddProject: () => void;
  showAddProject?: boolean;
}

// Project grouping data structure
interface ProjectGroup {
  projectID: string;
  project: UnifiedProject | null;
  name: string;
  sessions: SessionInfo[];
}

// Engine section — groups projects by engine type
interface EngineSection {
  engineType: string;
  label: string;
  projects: ProjectGroup[];
}

function getEngineLabel(engineType: string): string {
  switch (engineType) {
    case "opencode": return "OpenCode";
    case "copilot": return "Copilot";
    case "claude": return "Claude";
    default: return engineType;
  }
}

function getEngineBadge(engineType?: string): { label: string; class: string } | null {
  if (!engineType) return null;
  switch (engineType) {
    case "opencode": return { label: "OC", class: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" };
    case "copilot": return { label: "Copilot", class: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" };
    case "claude": return { label: "Claude", class: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" };
    default: return { label: engineType, class: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400" };
  }
}

export function SessionSidebar(props: SessionSidebarProps) {
  const { t, locale } = useI18n();
  const [hoveredProject, setHoveredProject] = createSignal<string | null>(null);
  const [editingSessionId, setEditingSessionId] = createSignal<string | null>(null);
  const [editingTitle, setEditingTitle] = createSignal("");
  const [homePath, setHomePath] = createSignal<string | null>(null);

  const StatusIndicator = (p: { status: SessionActivityStatus }) => {
    switch (p.status) {
      case "running":
        return (
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
            class="text-blue-500 dark:text-blue-400 flex-shrink-0 animate-spin">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        );
      case "completed":
        return (
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
            class="text-green-500 dark:text-green-400 flex-shrink-0">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        );
      case "waiting":
        return (
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
            class="text-amber-500 dark:text-amber-400 flex-shrink-0">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
        );
      case "error":
        return (
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
            class="text-red-500 dark:text-red-400 flex-shrink-0">
            <circle cx="12" cy="12" r="10" />
            <path d="m15 9-6 6" />
            <path d="m9 9 6 6" />
          </svg>
        );
      default:
        return null;
    }
  };

  // Load homePath once on mount (only in Electron, needed for storage folder button)
  if (isElectron()) {
    systemAPI.getInfo().then((info) => {
      if (info) setHomePath(info.homePath);
    });
  }

  const isDefaultTitle = (title: string): boolean => {
    return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title);
  };

  const getDisplayTitle = (title: string): string => {
    if (!title || isDefaultTitle(title)) {
      return t().sidebar.newSession;
    }
    return title;
  };

  const projectGroups = createMemo((): ProjectGroup[] => {
    const groups: Map<string, SessionInfo[]> = new Map();

    const filteredProjects = props.projects.filter((p) => p.directory !== "/");

    for (const project of filteredProjects) {
      groups.set(project.id, []);
    }

    const rootSessions = props.sessions.filter((s) => !s.parentID);

    for (const session of rootSessions) {
      const projectID = session.projectID || "";

      if (groups.has(projectID)) {
        groups.get(projectID)!.push(session);
      } else {
        // Fallback: match by directory AND engine type when projectID is missing or unknown
        const matchingProject = filteredProjects.find(
          (p) => session.directory && p.directory === session.directory && p.engineType === session.engineType
        );
        if (matchingProject) {
          groups.get(matchingProject.id)!.push(session);
        }
      }
    }

    const result: ProjectGroup[] = [];
    for (const [projectID, sessions] of groups) {
      const project = filteredProjects.find((p) => p.id === projectID) || null;
      if (!project) continue;

      const name = getProjectName(project);

      result.push({
        projectID,
        project,
        name,
        sessions,
      });
    }

    return result;
  });

  // Group projects by engine type
  const engineSections = createMemo((): EngineSection[] => {
    const groups = projectGroups();
    const engineMap = new Map<string, ProjectGroup[]>();

    for (const group of groups) {
      const engineType = group.project?.engineType || "opencode";
      if (!engineMap.has(engineType)) {
        engineMap.set(engineType, []);
      }
      engineMap.get(engineType)!.push(group);
    }

    const sections: EngineSection[] = [];
    for (const [engineType, projects] of engineMap) {
      sections.push({
        engineType,
        label: getEngineLabel(engineType),
        projects,
      });
    }

    return sections;
  });

  const multipleEngines = createMemo(() => engineSections().length > 1);

  // Check if project is expanded
  const isProjectExpanded = (directory: string): boolean => {
    // Expanded by default
    return sessionStore.projectExpanded[directory] !== false;
  };

  // Toggle project expansion
  const toggleProjectExpanded = (directory: string) => {
    const currentState = isProjectExpanded(directory);
    setSessionStore("projectExpanded", directory, !currentState);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t().sidebar.justNow;
    if (diffMins < 60) return formatMessage(t().sidebar.minutesAgo, { count: diffMins });
    if (diffHours < 24) return formatMessage(t().sidebar.hoursAgo, { count: diffHours });
    if (diffDays < 7) return formatMessage(t().sidebar.daysAgo, { count: diffDays });

    return date.toLocaleDateString(locale() === "zh" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
    });
  };

  // Get project initial or icon
  const getProjectInitial = (name: string): string => {
    if (!name) return "?";
    // For English, take first initial
    const firstChar = name.charAt(0);
    if (/[a-zA-Z]/.test(firstChar)) {
      return firstChar.toUpperCase();
    }
    // For other characters, take the first one
    return firstChar;
  };

  // Generate color based on project name
  const getProjectColor = (name: string): string => {
    const colors = [
      "bg-blue-500",
      "bg-green-500",
      "bg-purple-500",
      "bg-orange-500",
      "bg-pink-500",
      "bg-cyan-500",
      "bg-indigo-500",
      "bg-teal-500",
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };

  const getProjectDirectory = (project: UnifiedProject): string | undefined => {
    return ProjectStore.getPath(project.id) || project.directory || undefined;
  };

  return (
    <div class="w-full bg-gray-50 dark:bg-slate-950 border-r border-gray-200 dark:border-slate-800 flex flex-col h-full">
      {/* Session List */}
      <div class="flex-1 overflow-y-auto px-2 py-2">
        <Show
          when={engineSections().length > 0}
          fallback={
            <div class="p-8 text-center">
              <div class="inline-flex items-center justify-center w-10 h-10 rounded-full bg-gray-100 dark:bg-slate-800 mb-3 text-gray-400">
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
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <p class="text-sm text-gray-500 dark:text-gray-400">{t().sidebar.noSessions}</p>
            </div>
          }
        >
          <For each={engineSections()}>
            {(section) => (
              <>
                {/* Engine separator label (only when multiple engines) */}
                <Show when={multipleEngines()}>
                  <div class="flex items-center justify-between px-2 py-1.5 mt-1 first:mt-0">
                    <span class="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                      {section.label}
                    </span>
                    <span class="text-[10px] text-gray-400 dark:text-gray-500">
                      {section.projects.length}
                    </span>
                  </div>
                </Show>
                <For each={section.projects}>
            {(project) => {
              const isHovered = () => hoveredProject() === project.projectID;
              const isExpanded = () => isProjectExpanded(project.projectID);

              return (
                <div class="mb-2">
                  {/* Project Header */}
                  <div
                    class="group flex items-center justify-between px-2 py-1.5 rounded-md cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-900 transition-colors"
                    onMouseEnter={() => setHoveredProject(project.projectID)}
                    onMouseLeave={() => setHoveredProject(null)}
                    onClick={() => toggleProjectExpanded(project.projectID)}
                    title={project.project?.directory || project.sessions[0]?.directory || ""}
                  >
                    <div class="flex items-center gap-2 min-w-0 flex-1">
                      {/* Expand/Collapse Arrow */}
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        class={`text-gray-400 transition-transform flex-shrink-0 ${
                          isExpanded() ? "rotate-90" : ""
                        }`}
                      >
                        <path d="m9 18 6-6-6-6" />
                      </svg>

                      {/* Project Icon */}
                      <div
                        class={`w-5 h-5 rounded flex items-center justify-center text-white text-xs font-medium flex-shrink-0 ${getProjectColor(project.name)}`}
                      >
                        {getProjectInitial(project.name)}
                      </div>

                      {/* Project Name and Path */}
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-1.5">
                          <span class="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
                            {project.name}
                          </span>
                          <Show when={getEngineBadge(project.project?.engineType)}>
                            {(badge) => (
                              <span class={`text-[10px] font-medium px-1.5 py-0.5 rounded-full leading-none flex-shrink-0 ${badge().class}`}>
                                {badge().label}
                              </span>
                            )}
                          </Show>
                        </div>
                        <span class="text-[10px] text-gray-400 dark:text-gray-500 truncate block">
                          {project.project?.directory || project.sessions[0]?.directory || ""}
                        </span>
                      </div>
                    </div>

                    {/* New session button on hover */}
                    <div class={`flex items-center gap-0.5 ${isHovered() ? "opacity-100" : "opacity-0"}`}>
                      <button
                        class="p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded transition-all"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onNewSession(project.project ? getProjectDirectory(project.project) : undefined, project.project?.engineType);
                        }}
                        title={t().sidebar.newSession}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="M5 12h14" />
                          <path d="M12 5v14" />
                        </svg>
                      </button>
                      <Show when={isElectron() && (project.project?.engineType === "opencode" || project.project?.engineType === "copilot") && homePath()}>
                        <button
                          class="p-1 text-gray-400 hover:text-green-600 dark:hover:text-green-400 rounded transition-all"
                          onClick={(e) => {
                            e.stopPropagation();
                            const engineType = project.project?.engineType;
                            const storagePath = engineType === "opencode"
                              ? getOpenCodeStoragePath(homePath()!, project.projectID)
                              : getCopilotStoragePath(homePath()!);
                            systemAPI.openPath(storagePath);
                          }}
                          title={t().sidebar.openStorageFolder}
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                          </svg>
                        </button>
                      </Show>
                      <button
                        class="p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400 rounded transition-all"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onDeleteProjectSessions(project.projectID, project.name, project.sessions.length);
                        }}
                        title={t().project.hideTitle}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="M3 6h18" />
                          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Session List (Collapsible) */}
                  <Show when={isExpanded()}>
                    <div class="ml-4 mt-1">
                      <For each={project.sessions}>
                        {(session) => {
                          const isActive = () =>
                            session.id === props.currentSessionId;
                          const isEditing = () => editingSessionId() === session.id;
                          const sessionStatus = () =>
                            props.getSessionStatus(session.id);

                          const startEditing = (e: MouseEvent) => {
                            e.stopPropagation();
                            setEditingSessionId(session.id);
                            setEditingTitle(session.title || "");
                          };

                          const saveTitle = () => {
                            const newTitle = editingTitle().trim();
                            if (newTitle && newTitle !== session.title) {
                              props.onRenameSession(session.id, newTitle);
                            }
                            setEditingSessionId(null);
                          };

                          const cancelEditing = () => {
                            setEditingSessionId(null);
                          };

                          const handleKeyDown = (e: KeyboardEvent) => {
                            if (e.key === "Enter") {
                              saveTitle();
                            } else if (e.key === "Escape") {
                              cancelEditing();
                            }
                          };

                          return (
                            <div
                              class={`group relative px-3 py-2 mb-0.5 rounded-md cursor-pointer transition-all duration-150 ${
                                isActive()
                                  ? "bg-white dark:bg-slate-800 shadow-xs"
                                  : "hover:bg-gray-100 dark:hover:bg-slate-900"
                              }`}
                              onClick={() => !isEditing() && props.onSelectSession(session.id)}
                            >
                              <div class="flex items-center justify-between gap-2">
                                <div class="flex-1 min-w-0">
                                  <div class="flex items-center gap-1.5">
                                    <Show when={sessionStatus() !== "idle"}>
                                      <StatusIndicator status={sessionStatus()} />
                                    </Show>
                                    <Show
                                      when={isEditing()}
                                      fallback={
                                        <div
                                          class={`text-sm truncate ${
                                            isActive() || sessionStatus() === "completed"
                                              ? "text-gray-900 dark:text-gray-100 font-medium"
                                              : "text-gray-600 dark:text-gray-400"
                                          }`}
                                          onDblClick={startEditing}
                                          title={session.id}
                                        >
                                          {getDisplayTitle(session.title)}
                                        </div>
                                      }
                                    >
                                      <input
                                        type="text"
                                        value={editingTitle()}
                                        onInput={(e) => setEditingTitle(e.currentTarget.value)}
                                        onKeyDown={handleKeyDown}
                                        onBlur={saveTitle}
                                        autofocus
                                        class="text-sm w-full px-1 py-0.5 bg-white dark:bg-slate-700 border border-blue-500 rounded outline-none text-gray-900 dark:text-gray-100"
                                        onClick={(e) => e.stopPropagation()}
                                      />
                                    </Show>
                                    <Show when={!isEditing()}>
                                      <span class="text-[10px] text-gray-400 dark:text-gray-500 flex-shrink-0">
                                        {formatDate(session.updatedAt)}
                                      </span>
                                    </Show>
                                  </div>

                                  {/* Change Statistics */}
                                  <Show when={session.summary}>
                                    <div class="flex items-center gap-2 mt-0.5">
                                      <span class="text-[10px] text-gray-400">
                                        {formatMessage(t().sidebar.files, { count: session.summary!.files })}
                                      </span>
                                      <Show when={session.summary!.additions > 0}>
                                        <span class="text-[10px] text-green-500">
                                          +{session.summary!.additions}
                                        </span>
                                      </Show>
                                      <Show when={session.summary!.deletions > 0}>
                                        <span class="text-[10px] text-red-500">
                                          -{session.summary!.deletions}
                                        </span>
                                      </Show>
                                    </div>
                                  </Show>
                                </div>

                                <Show when={!isEditing()}>
                                  <div class="flex items-center gap-0.5 flex-shrink-0">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        navigator.clipboard.writeText(session.id).catch(() => {});
                                      }}
                                      class="opacity-0 group-hover:opacity-100 p-1.5 text-gray-400 hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20 rounded transition-all"
                                      title={`${t().sidebar.copySessionId}: ${session.id}`}
                                    >
                                      <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="12"
                                        height="12"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                      >
                                        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                                        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                                      </svg>
                                    </button>
                                    <button
                                      onClick={startEditing}
                                      class="opacity-0 group-hover:opacity-100 p-1.5 text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-all"
                                      title={t().sidebar.renameSession}
                                    >
                                      <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="12"
                                        height="12"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                      >
                                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                                        <path d="m15 5 4 4" />
                                      </svg>
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        e.preventDefault();
                                        const confirmed = window.confirm(t().sidebar.deleteConfirm);
                                        if (confirmed) {
                                          props.onDeleteSession(session.id);
                                        }
                                      }}
                                      class="opacity-0 group-hover:opacity-100 p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-all"
                                      title={t().sidebar.deleteSession}
                                    >
                                      <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="12"
                                        height="12"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                      >
                                        <path d="M3 6h18" />
                                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                                      </svg>
                                    </button>
                                  </div>
                                </Show>
                              </div>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
              </>
            )}
          </For>
        </Show>
      </div>

      <Show when={props.showAddProject !== false}>
        <div class="px-2 py-2 border-t border-gray-200 dark:border-slate-800">
          <button
            onClick={props.onAddProject}
            class="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-900 dark:hover:text-white rounded-lg transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
              <path d="M12 10v6" />
              <path d="M9 13h6" />
            </svg>
            {t().project.add}
          </button>
        </div>
      </Show>
    </div>
  );
}
