import { For, Show, createSignal, createMemo } from "solid-js";
import { SessionInfo, sessionStore, setSessionStore, getProjectName } from "../stores/session";
import { useI18n, formatMessage } from "../lib/i18n";
import { Project } from "../types/opencode";
import { ProjectStore } from "../lib/project-store";

interface SessionSidebarProps {
  sessions: SessionInfo[];
  currentSessionId: string | null;
  projects: Project.Info[];
  onSelectSession: (sessionId: string) => void;
  onNewSession: (directory?: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, newTitle: string) => void;
  onDeleteProjectSessions: (projectID: string, projectName: string, sessionCount: number) => void;
  onAddProject: () => void;
}

// Project grouping data structure
interface ProjectGroup {
  projectID: string;
  project: Project.Info | null;
  name: string;
  sessions: SessionInfo[];
}

export function SessionSidebar(props: SessionSidebarProps) {
  const { t, locale } = useI18n();
  const [hoveredProject, setHoveredProject] = createSignal<string | null>(null);
  const [editingSessionId, setEditingSessionId] = createSignal<string | null>(null);
  const [editingTitle, setEditingTitle] = createSignal("");

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

    const filteredProjects = props.projects.filter((p) => p.worktree !== "/");

    for (const project of filteredProjects) {
      groups.set(project.id, []);
    }

    const rootSessions = props.sessions.filter((s) => !s.parentID);

    for (const session of rootSessions) {
      const projectID = session.projectID || "";
      
      if (groups.has(projectID)) {
        groups.get(projectID)!.push(session);
      } else if (projectID) {
        const matchingProject = filteredProjects.find(
          (p) => session.directory && p.worktree === session.directory
        );
        if (matchingProject) {
          groups.get(matchingProject.id)!.push(session);
        }
      }
    }

    const result: ProjectGroup[] = [];
    for (const [projectID, sessions] of groups) {
      const sortedSessions = sessions.slice().sort((a, b) => {
        const aTime = new Date(a.updatedAt).getTime();
        const bTime = new Date(b.updatedAt).getTime();
        return bTime - aTime;
      });

      const project = filteredProjects.find((p) => p.id === projectID) || null;
      if (!project) continue;
      
      const name = getProjectName(project);

      result.push({
        projectID,
        project,
        name,
        sessions: sortedSessions,
      });
    }

    result.sort((a, b) => {
      const aLatest = a.sessions[0]
        ? new Date(a.sessions[0].updatedAt).getTime()
        : a.project?.time.updated || 0;
      const bLatest = b.sessions[0]
        ? new Date(b.sessions[0].updatedAt).getTime()
        : b.project?.time.updated || 0;
      return bLatest - aLatest;
    });

    return result;
  });

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

  const getProjectDirectory = (project: Project.Info): string | undefined => {
    return ProjectStore.getPath(project.id) || project.worktree || undefined;
  };

  return (
    <div class="w-full bg-gray-50 dark:bg-zinc-950 border-r border-gray-200 dark:border-zinc-800 flex flex-col h-full">
      {/* Session List */}
      <div class="flex-1 overflow-y-auto px-2 py-2">
        <Show
          when={projectGroups().length > 0}
          fallback={
            <div class="p-8 text-center">
              <div class="inline-flex items-center justify-center w-10 h-10 rounded-full bg-gray-100 dark:bg-zinc-800 mb-3 text-gray-400">
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
          <For each={projectGroups()}>
            {(project) => {
              const isHovered = () => hoveredProject() === project.projectID;
              const isExpanded = () => isProjectExpanded(project.projectID);

              return (
                <div class="mb-2">
                  {/* Project Header */}
                  <div
                    class="group flex items-center justify-between px-2 py-1.5 rounded-md cursor-pointer hover:bg-gray-100 dark:hover:bg-zinc-900 transition-colors"
                    onMouseEnter={() => setHoveredProject(project.projectID)}
                    onMouseLeave={() => setHoveredProject(null)}
                    onClick={() => toggleProjectExpanded(project.projectID)}
                    title={project.project?.worktree || project.sessions[0]?.directory || ""}
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
                        <span class="text-sm font-medium text-gray-700 dark:text-gray-300 truncate block">
                          {project.name}
                        </span>
                        <span class="text-[10px] text-gray-400 dark:text-gray-500 truncate block">
                          {project.project?.worktree || project.sessions[0]?.directory || ""}
                        </span>
                      </div>
                    </div>

                    {/* New session button on hover */}
                    <div class={`flex items-center gap-0.5 ${isHovered() ? "opacity-100" : "opacity-0"}`}>
                      <button
                        class="p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded transition-all"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onNewSession(project.project ? getProjectDirectory(project.project) : undefined);
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
                                  ? "bg-white dark:bg-zinc-800 shadow-sm"
                                  : "hover:bg-gray-100 dark:hover:bg-zinc-900"
                              }`}
                              onClick={() => !isEditing() && props.onSelectSession(session.id)}
                            >
                              <div class="flex items-center justify-between gap-2">
                                <div class="flex-1 min-w-0">
                                  <div class="flex items-center gap-2">
                                    <Show
                                      when={isEditing()}
                                      fallback={
                                        <div
                                          class={`text-sm truncate ${
                                            isActive()
                                              ? "text-gray-900 dark:text-gray-100 font-medium"
                                              : "text-gray-600 dark:text-gray-400"
                                          }`}
                                          onDblClick={startEditing}
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
                                        class="text-sm w-full px-1 py-0.5 bg-white dark:bg-zinc-700 border border-blue-500 rounded outline-none text-gray-900 dark:text-gray-100"
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
        </Show>
      </div>

      <div class="px-2 py-2 border-t border-gray-200 dark:border-zinc-800">
        <button
          onClick={props.onAddProject}
          class="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-800 hover:text-gray-900 dark:hover:text-white rounded-lg transition-colors"
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
    </div>
  );
}
