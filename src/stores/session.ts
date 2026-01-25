import { createStore } from "solid-js/store";
import { Project } from "../types/opencode";

export interface SessionInfo {
  id: string;
  title: string;
  directory: string;
  projectID?: string;
  parentID?: string;
  createdAt: string;
  updatedAt: string;
  summary?: {
    additions: number;
    deletions: number;
    files: number;
  };
}

export interface ProjectExpandState {
  [projectID: string]: boolean;
}

export const [sessionStore, setSessionStore] = createStore<{
  list: SessionInfo[];
  current: string | null;
  loading: boolean;
  projects: Project.Info[];
  projectExpanded: ProjectExpandState;
}>({
  list: [],
  current: null,
  loading: false,
  projects: [],
  projectExpanded: {},
});

export function getProjectName(project: Project.Info): string {
  if (project.name) return project.name;
  const parts = project.worktree.split("/").filter(Boolean);
  return parts[parts.length - 1] || "Unknown";
}

export function getProjectByDirectory(directory: string): Project.Info | undefined {
  return sessionStore.projects.find(
    (p) => p.worktree === directory || p.sandboxes.includes(directory)
  );
}

export function getProjectById(projectID: string): Project.Info | undefined {
  return sessionStore.projects.find((p) => p.id === projectID);
}
