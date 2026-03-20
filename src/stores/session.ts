import { createStore } from "solid-js/store";
import type { EngineType, UnifiedProject } from "../types/unified";

export interface SessionInfo {
  id: string;
  engineType: EngineType;
  title: string;
  directory: string;
  projectID?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectExpandState {
  [projectID: string]: boolean;
}

export const [sessionStore, setSessionStore] = createStore<{
  list: SessionInfo[];
  current: string | null;
  loading: boolean;
  initError: string | null;
  projects: UnifiedProject[];
  projectExpanded: ProjectExpandState;
  /** Per-session sending (streaming) state — persists across Chat navigations. */
  sendingMap: Record<string, boolean>;
  /** Whether to show default workspace in sidebar (reactive mirror of setting). */
  showDefaultWorkspace: boolean;
}>({
  list: [],
  current: null,
  loading: false,
  initError: null,
  projects: [],
  projectExpanded: {},
  sendingMap: {},
  showDefaultWorkspace: false,
});

/** Set the sending (streaming) state for a session. */
export function setSendingFor(sessionId: string, value: boolean): void {
  setSessionStore("sendingMap", sessionId, value);
}

export function getProjectName(project: UnifiedProject): string {
  if (project.name) return project.name;
  const parts = project.directory.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "Unknown";
}
