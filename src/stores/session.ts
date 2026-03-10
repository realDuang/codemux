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
}>({
  list: [],
  current: null,
  loading: false,
  initError: null,
  projects: [],
  projectExpanded: {},
});

export function getProjectName(project: UnifiedProject): string {
  if (project.name) return project.name;
  const parts = project.directory.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "Unknown";
}
