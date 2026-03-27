import { For, Show, Switch, Match, createSignal, createMemo, createEffect } from "solid-js";
import { SessionInfo, sessionStore, setSessionStore, getProjectName } from "../stores/session";
import { useI18n, formatMessage } from "../lib/i18n";
import { isDefaultTitle } from "../lib/session-utils";
import type { UnifiedProject, EngineType, SessionActivityStatus, ScheduledTask } from "../types/unified";
import { configStore, isEngineEnabled, getDefaultEngineType, setDefaultNewSessionEngine } from "../stores/config";
import { getEngineBadge } from "./share/common";
import { ScheduledTaskSection } from "./ScheduledTaskSection";

import { isElectron } from "../lib/platform";
import { systemAPI } from "../lib/electron-api";

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
  onRefreshSessions?: () => void;
  refreshingSessions?: boolean;
  showAddProject?: boolean;
  collapsed?: boolean;
  // Scheduled Tasks
  scheduledTasks?: ScheduledTask[];
  onCreateTask?: () => void;
  onEditTask?: (task: ScheduledTask) => void;
  onDeleteTask?: (taskId: string) => void;
  onRunTaskNow?: (taskId: string) => void;
  onToggleTaskEnabled?: (taskId: string, enabled: boolean) => void;
}

// Project grouping data structure
interface ProjectGroup {
  projectID: string;
  project: UnifiedProject | null;
  name: string;
  sessions: SessionInfo[];
}

export function SessionSidebar(props: SessionSidebarProps) {
  const { t, locale } = useI18n();
  const [hoveredProject, setHoveredProject] = createSignal<string | null>(null);
  const [editingSessionId, setEditingSessionId] = createSignal<string | null>(null);
  const [editingTitle, setEditingTitle] = createSignal("");
  const [pendingDeleteId, setPendingDeleteId] = createSignal<string | null>(null);
  const [searchQuery, setSearchQuery] = createSignal("");

  const StatusIndicator = (p: { status: SessionActivityStatus }) => {
    return (
      <Switch>
        <Match when={p.status === "running"}>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
            class="text-blue-500 dark:text-blue-400 flex-shrink-0 animate-spin">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        </Match>
        <Match when={p.status === "completed"}>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
            class="text-green-500 dark:text-green-400 flex-shrink-0">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </Match>
        <Match when={p.status === "waiting"}>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
            class="text-amber-500 dark:text-amber-400 flex-shrink-0">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
        </Match>
        <Match when={p.status === "cancelled"}>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
            class="text-amber-500 dark:text-amber-400 flex-shrink-0">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
        </Match>
        <Match when={p.status === "error"}>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
            class="text-red-500 dark:text-red-400 flex-shrink-0">
            <circle cx="12" cy="12" r="10" />
            <path d="m15 9-6 6" />
            <path d="m9 9 6 6" />
          </svg>
        </Match>
      </Switch>
    );
  };

  // Load info once on mount (only in Electron)
  if (isElectron()) {
    systemAPI.getInfo();
  }

  const getDisplayTitle = (title: string): string => {
    if (!title || isDefaultTitle(title)) {
      return t().sidebar.newSession;
    }
    return title;
  };

  // Default workspace — displayed above the projects divider
  const defaultWorkspaceGroup = createMemo((): ProjectGroup | null => {
    if (!sessionStore.showDefaultWorkspace) return null;
    const defaultProject = props.projects.find((p) => p.isDefault);
    if (!defaultProject) return null;

    const sessions = props.sessions.filter(
      (s) => isEngineEnabled(s.engineType) && s.projectID === defaultProject.id,
    );

    return {
      projectID: defaultProject.id,
      project: defaultProject,
      name: t().sidebar.defaultWorkspace,
      sessions,
    };
  });

  // Regular project groups (excludes default workspace)
  const projectGroups = createMemo((): ProjectGroup[] => {
    const groups: Map<string, SessionInfo[]> = new Map();

    const filteredProjects = props.projects.filter((p) => {
      if (p.directory === "/") return false;
      if (p.isDefault) return false; // handled separately above
      return true;
    });

    for (const project of filteredProjects) {
      groups.set(project.id, []);
    }

    const rootSessions = props.sessions.filter(s => isEngineEnabled(s.engineType));

    for (const session of rootSessions) {
      const projectID = session.projectID || "";

      if (groups.has(projectID)) {
        groups.get(projectID)!.push(session);
      }
    }

    const result: ProjectGroup[] = [];
    for (const [projectID, sessions] of groups) {
      if (sessions.length === 0) continue;
      const project = filteredProjects.find((p) => p.id === projectID) || null;
      if (!project) continue;

      result.push({
        projectID,
        project,
        name: getProjectName(project),
        sessions,
      });
    }

    return result;
  });

  // Filter project groups by search query (matches session title or project name)
  const filteredProjectGroups = createMemo((): ProjectGroup[] => {
    const query = searchQuery().trim().toLowerCase();
    if (!query) return projectGroups();

    const filtered: ProjectGroup[] = [];
    for (const group of projectGroups()) {
      // If project name matches, include all its sessions
      if (group.name.toLowerCase().includes(query)) {
        filtered.push(group);
        continue;
      }
      // Otherwise, filter sessions by title
      const matchingSessions = group.sessions.filter(
        (s) => (s.title || "").toLowerCase().includes(query),
      );
      if (matchingSessions.length > 0) {
        filtered.push({ ...group, sessions: matchingSessions });
      }
    }
    return filtered;
  });

  // Filtered default workspace group (respects search query)
  const filteredDefaultWorkspaceGroup = createMemo((): ProjectGroup | null => {
    const dwg = defaultWorkspaceGroup();
    if (!dwg) return null;
    const query = searchQuery().trim().toLowerCase();
    if (!query) return dwg;
    // Filter sessions by search query
    if (dwg.name.toLowerCase().includes(query)) return dwg;
    const matchingSessions = dwg.sessions.filter(
      (s) => (s.title || "").toLowerCase().includes(query),
    );
    if (matchingSessions.length > 0) {
      return { ...dwg, sessions: matchingSessions };
    }
    return null; // hide during search if no matches
  });

  const isSearching = () => searchQuery().trim().length > 0;

  // Running + enabled engines for default engine selector
  const runningEngines = createMemo(() =>
    configStore.engines.filter(e => e.status === "running" && isEngineEnabled(e.type))
  );

  // Check if project is expanded
  const isProjectExpanded = (directory: string): boolean => {
    // Collapsed by default
    return sessionStore.projectExpanded[directory] === true;
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
    return project.directory || undefined;
  };

  return (
    <div class="w-full bg-gray-50 dark:bg-slate-950 border-r border-gray-200 dark:border-slate-800 flex flex-col h-full overflow-hidden">
      {/* Search Box */}
      <Show when={!props.collapsed && (projectGroups().length > 0 || filteredDefaultWorkspaceGroup() !== null)}>
        <div class="flex items-center gap-1.5 px-2 pt-2">
          <div class="relative flex-1 min-w-0">
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
              class="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setSearchQuery(""); }}
              placeholder={t().sidebar.searchPlaceholder}
              class="w-full pl-8 pr-7 py-1.5 text-xs bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-md text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <Show when={searchQuery().length > 0}>
              <button
                onClick={() => setSearchQuery("")}
                class="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                </svg>
              </button>
            </Show>
          </div>

        </div>
      </Show>
      {/* Session List */}
      <div class={`flex-1 overflow-y-auto ${props.collapsed ? "px-1" : "px-2"} py-2`}>
        {/* Scheduled Tasks Section */}
        <Show when={(props.scheduledTasks?.length ?? 0) > 0 || (props.onCreateTask && !props.collapsed)}>
          <ScheduledTaskSection
            tasks={props.scheduledTasks ?? []}
            collapsed={props.collapsed}
            onCreateTask={() => props.onCreateTask?.()}
            onEditTask={(task) => props.onEditTask?.(task)}
            onDeleteTask={(id) => props.onDeleteTask?.(id)}
            onRunNow={(id) => props.onRunTaskNow?.(id)}
            onToggleEnabled={(id, enabled) => props.onToggleTaskEnabled?.(id, enabled)}
            onSelectTaskSession={(sessionId) => props.onSelectSession(sessionId)}
          />
        </Show>

        <Show
          when={projectGroups().length > 0 || filteredDefaultWorkspaceGroup() !== null}
          fallback={
            <Show when={!props.collapsed}>
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
            </Show>
          }
        >
          {/* Collapsed mode: show only project icons */}
          <Show when={props.collapsed}>
            <div class="flex flex-col items-center gap-1">
              {/* Default workspace icon (collapsed) */}
              <Show when={filteredDefaultWorkspaceGroup()}>
                {(dwg) => {
                  const hasActiveSession = () =>
                    dwg().sessions.some(s => s.id === props.currentSessionId);
                  return (
                    <button
                      class={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                        hasActiveSession()
                          ? "ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-slate-950"
                          : "hover:bg-gray-100 dark:hover:bg-slate-800"
                      }`}
                      onClick={() => {
                        if (hasActiveSession() && props.currentSessionId) {
                          props.onSelectSession(props.currentSessionId);
                          return;
                        }
                        const firstSession = dwg().sessions[0];
                        if (firstSession) props.onSelectSession(firstSession.id);
                        else props.onNewSession(dwg().project?.directory);
                      }}
                      title={dwg().name}
                      aria-label={dwg().name}
                    >
                      <div class="w-7 h-7 rounded flex items-center justify-center bg-slate-500 text-white">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <rect width="18" height="18" x="3" y="3" rx="2" />
                          <path d="M3 9h18" />
                          <path d="M9 21V9" />
                        </svg>
                      </div>
                    </button>
                  );
                }}
              </Show>
              <For each={projectGroups()}>
                {(project) => {
                  const hasActiveSession = () =>
                    project.sessions.some(s => s.id === props.currentSessionId);
                  return (
                    <button
                      class={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                        hasActiveSession()
                          ? "ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-slate-950"
                          : "hover:bg-gray-100 dark:hover:bg-slate-800"
                      }`}
                      onClick={() => {
                        if (hasActiveSession() && props.currentSessionId) {
                          props.onSelectSession(props.currentSessionId);
                          return;
                        }
                        const firstSession = project.sessions[0];
                        if (firstSession) props.onSelectSession(firstSession.id);
                      }}
                      title={project.name}
                      aria-label={project.name}
                    >
                      <div
                        class={`w-7 h-7 rounded flex items-center justify-center text-white text-xs font-medium ${getProjectColor(project.name)}`}
                      >
                        {getProjectInitial(project.name)}
                      </div>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>

          {/* Expanded mode: full session list */}
          <Show when={!props.collapsed}>
          {/* Default Workspace Section — above Projects divider */}
          <Show when={filteredDefaultWorkspaceGroup()}>
            {(dwg) => {
              const isExpanded = () => isSearching() || isProjectExpanded(dwg().projectID);
              return (
                <div class="mb-2">
                  {/* Default Workspace Header */}
                  <div
                    class="group flex items-center justify-between px-2 py-1.5 rounded-md cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-900 transition-colors"
                    onMouseEnter={() => setHoveredProject(dwg().projectID)}
                    onMouseLeave={() => setHoveredProject(null)}
                    onClick={() => toggleProjectExpanded(dwg().projectID)}
                    title={dwg().project?.directory || ""}
                  >
                    <div class="flex items-center gap-2 min-w-0 flex-1">
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
                      <div class="w-5 h-5 rounded flex items-center justify-center bg-slate-500 text-white flex-shrink-0">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <rect width="18" height="18" x="3" y="3" rx="2" />
                          <path d="M3 9h18" />
                          <path d="M9 21V9" />
                        </svg>
                      </div>
                      <div class="min-w-0 flex-1">
                        <span class="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
                          {dwg().name}
                        </span>
                      </div>
                    </div>
                    <div class={`flex items-center gap-0.5 ${hoveredProject() === dwg().projectID ? "opacity-100" : "opacity-0"}`}>
                      <button
                        class="p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded transition-all"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onNewSession(dwg().project ? getProjectDirectory(dwg().project!) : undefined);
                        }}
                        title={t().sidebar.newSession}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M5 12h14" />
                          <path d="M12 5v14" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Default Workspace Sessions */}
                  <div class="collapsible-grid" data-expanded={isExpanded() ? "true" : "false"}>
                    <div class="collapsible-content">
                      <div class="ml-4 mt-1">
                        <Show when={dwg().sessions.length === 0}>
                          <div class="px-3 py-2 text-xs text-gray-400 dark:text-gray-500 italic">
                            {t().sidebar.noSessions}
                          </div>
                        </Show>
                        <For each={dwg().sessions}>
                          {(session) => {
                            const isActive = () => session.id === props.currentSessionId;
                            const sessionStatus = () => props.getSessionStatus(session.id);
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

                            const cancelEditing = () => setEditingSessionId(null);

                            const handleKeyDown = (e: KeyboardEvent) => {
                              if (e.key === "Enter") saveTitle();
                              else if (e.key === "Escape") cancelEditing();
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
                                <div class="flex items-center gap-1.5 min-w-0">
                                  <Show when={sessionStatus() !== "idle"}>
                                    <StatusIndicator status={sessionStatus()} />
                                  </Show>
                                  <Show
                                    when={isEditing()}
                                    fallback={
                                      <div
                                        class={`text-sm truncate ${
                                          isActive() || sessionStatus() === "completed" || sessionStatus() === "cancelled" || sessionStatus() === "error"
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
                                </div>
                                <Show when={!isEditing()}>
                                  <div class="flex items-center gap-1.5 mt-0.5">
                                    <Show when={getEngineBadge(session.engineType)}>
                                      {(badge) => (
                                        <span class={`text-[9px] font-medium px-1 py-0.5 rounded leading-none flex-shrink-0 ${badge().class}`}>
                                          {badge().label}
                                        </span>
                                      )}
                                    </Show>
                                    <span class="text-[10px] text-gray-400 dark:text-gray-500">
                                      {formatDate(session.updatedAt)}
                                    </span>
                                  </div>
                                </Show>
                                <Show when={!isEditing()}>
                                  <Show
                                    when={pendingDeleteId() !== session.id}
                                    fallback={
                                      <div class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1 bg-white dark:bg-slate-800 rounded-md shadow-sm px-1 py-0.5">
                                        <button
                                          onClick={(e) => { e.stopPropagation(); props.onDeleteSession(session.id); setPendingDeleteId(null); }}
                                          class="px-2 py-1 text-[10px] font-medium text-white bg-red-500 hover:bg-red-600 rounded transition-colors"
                                        >{t().common.confirm}</button>
                                        <button
                                          onClick={(e) => { e.stopPropagation(); setPendingDeleteId(null); }}
                                          class="px-2 py-1 text-[10px] font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700 rounded transition-colors"
                                        >{t().common.cancel}</button>
                                      </div>
                                    }
                                  >
                                  <div class="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-0.5 bg-white/90 dark:bg-slate-800/90 backdrop-blur-xs rounded-md shadow-sm px-0.5 py-0.5">
                                    <button
                                      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(session.id).catch(() => {}); }}
                                      class="p-1.5 text-gray-400 hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20 rounded transition-all"
                                      title={`${t().sidebar.copySessionId}: ${session.id}`}
                                    >
                                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                                      </svg>
                                    </button>
                                    <button
                                      onClick={startEditing}
                                      class="p-1.5 text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-all"
                                      title={t().sidebar.renameSession}
                                    >
                                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" />
                                      </svg>
                                    </button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); e.preventDefault(); setPendingDeleteId(session.id); }}
                                      class="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-all"
                                      title={t().sidebar.deleteSession}
                                    >
                                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                                      </svg>
                                    </button>
                                  </div>
                                  </Show>
                                </Show>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    </div>
                  </div>
                </div>
              );
            }}
          </Show>

          {/* Projects section title */}
          <Show when={filteredProjectGroups().length > 0}>
          <div class="flex items-center gap-2 px-2 py-1.5 mb-1">
            <div class="w-5 h-5 rounded flex items-center justify-center bg-emerald-500 text-white flex-shrink-0">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
              </svg>
            </div>
            <span class="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t().sidebar.projectsTitle}
            </span>
            <span class="text-[10px] text-gray-400 dark:text-gray-500">
              [{filteredProjectGroups().length}]
            </span>
            <div class="flex-1" />
            <Show when={props.showAddProject !== false}>
              <button
                onClick={(e) => { e.stopPropagation(); props.onAddProject(); }}
                class="flex-shrink-0 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 rounded transition-colors"
                title={t().project.add}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                  <path d="M12 10v6" /><path d="M9 13h6" />
                </svg>
              </button>
            </Show>
            <Show when={props.onRefreshSessions}>
              <button
                onClick={(e) => { e.stopPropagation(); props.onRefreshSessions?.(); }}
                disabled={props.refreshingSessions}
                class="flex-shrink-0 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 rounded transition-colors disabled:opacity-50"
                title={t().sidebar.refreshSessions}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={props.refreshingSessions ? "animate-spin" : ""}>
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                  <path d="M8 16H3v5" />
                </svg>
              </button>
            </Show>
          </div>
          <For each={filteredProjectGroups()}>
            {(project) => {
              const isHovered = () => hoveredProject() === project.projectID;
              const isExpanded = () => isSearching() || isProjectExpanded(project.projectID);

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
                        </div>
                        <span class="text-[10px] text-gray-400 dark:text-gray-500 truncate block">
                          {project.project?.directory || project.sessions[0]?.directory || ""}
                        </span>
                      </div>
                    </div>

                    {/* Action buttons on hover */}
                    <div class={`flex items-center gap-0.5 ${isHovered() ? "opacity-100" : "opacity-0"}`}>
                      {/* Open in file explorer (Electron only) — first */}
                      <Show when={isElectron() && project.project}>
                        <button
                          class="p-1 text-gray-400 hover:text-amber-600 dark:hover:text-amber-400 rounded transition-all"
                          onClick={(e) => {
                            e.stopPropagation();
                            const dir = getProjectDirectory(project.project!);
                            if (dir) systemAPI.openPath(dir);
                          }}
                          title={t().sidebar.openInFileExplorer}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
                          </svg>
                        </button>
                      </Show>
                      {/* New session */}
                      <button
                        class="p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded transition-all"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onNewSession(project.project ? getProjectDirectory(project.project) : undefined);
                        }}
                        title={t().sidebar.newSession}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M5 12h14" />
                          <path d="M12 5v14" />
                        </svg>
                      </button>
                      {/* Hide project */}
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

                  {/* Session List (Collapsible with animation) */}
                  <div class="collapsible-grid" data-expanded={isExpanded() ? "true" : "false"}>
                    <div class="collapsible-content">
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
                              {/* Line 1: Status + Title */}
                              <div class="flex items-center gap-1.5 min-w-0">
                                <Show when={sessionStatus() !== "idle"}>
                                  <StatusIndicator status={sessionStatus()} />
                                </Show>
                                <Show
                                  when={isEditing()}
                                  fallback={
                                    <div
                                      class={`text-sm truncate ${
                                        isActive() || sessionStatus() === "completed" || sessionStatus() === "cancelled" || sessionStatus() === "error"
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
                              </div>

                              {/* Line 2: Engine badge + Time */}
                              <Show when={!isEditing()}>
                                <div class="flex items-center gap-1.5 mt-0.5">
                                  <Show when={getEngineBadge(session.engineType)}>
                                    {(badge) => (
                                      <span class={`text-[9px] font-medium px-1 py-0.5 rounded leading-none flex-shrink-0 ${badge().class}`}>
                                        {badge().label}
                                      </span>
                                    )}
                                  </Show>
                                  <span class="text-[10px] text-gray-400 dark:text-gray-500">
                                    {formatDate(session.updatedAt)}
                                  </span>
                                </div>
                              </Show>

                              {/* Overlay action buttons on hover */}
                              <Show when={!isEditing()}>
                                <Show
                                  when={pendingDeleteId() !== session.id}
                                  fallback={
                                    <div class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1 bg-white dark:bg-slate-800 rounded-md shadow-sm px-1 py-0.5">
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          props.onDeleteSession(session.id);
                                          setPendingDeleteId(null);
                                        }}
                                        class="px-2 py-1 text-[10px] font-medium text-white bg-red-500 hover:bg-red-600 rounded transition-colors"
                                      >
                                        {t().common.confirm}
                                      </button>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setPendingDeleteId(null);
                                        }}
                                        class="px-2 py-1 text-[10px] font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700 rounded transition-colors"
                                      >
                                        {t().common.cancel}
                                      </button>
                                    </div>
                                  }
                                >
                                <div class="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-0.5 bg-white/90 dark:bg-slate-800/90 backdrop-blur-xs rounded-md shadow-sm px-0.5 py-0.5">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigator.clipboard.writeText(session.id).catch(() => {});
                                    }}
                                    class="p-1.5 text-gray-400 hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20 rounded transition-all"
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
                                    class="p-1.5 text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-all"
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
                                      setPendingDeleteId(session.id);
                                    }}
                                    class="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-all"
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
                              </Show>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                    </div>
                  </div>
                </div>
              );
            }}
          </For>
          <Show when={isSearching() && filteredProjectGroups().length === 0 && !filteredDefaultWorkspaceGroup()}>
            <div class="p-6 text-center">
              <p class="text-sm text-gray-400 dark:text-gray-500">{t().sidebar.noSearchResults}</p>
            </div>
          </Show>
          </Show> {/* end filteredProjectGroups > 0 */}
          </Show>
        </Show>
      </div>

      {/* Default Engine Selector (footer, visible when at least one engine available) */}
      <Show when={runningEngines().length >= 1 && !props.collapsed}>
        <div class="px-3 py-2 border-t border-gray-200 dark:border-slate-800">
          <div class="flex items-center gap-2">
            <span class="text-[11px] font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{t().sidebar.defaultEngine}</span>
            <select
              ref={(el) => {
                // Re-apply value after <For> recreates option elements
                createEffect(() => {
                  const val = getDefaultEngineType();
                  runningEngines();
                  queueMicrotask(() => { el.value = val; });
                });
              }}
              value={getDefaultEngineType()}
              onChange={(e) => setDefaultNewSessionEngine(e.target.value)}
              class="flex-1 min-w-0 text-xs px-2 py-1 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-md text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <For each={runningEngines()}>
                {(engine) => (
                  <option value={engine.type}>{engine.name}</option>
                )}
              </For>
            </select>
          </div>
        </div>
      </Show>
    </div>
  );
}
