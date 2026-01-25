import { createStore } from "solid-js/store";

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseBranch: string;
  status: 'active' | 'merged' | 'pushed' | 'abandoned';
  createdAt: string;
  ahead?: number;
  behind?: number;
  hasUncommitted?: boolean;
}

export interface SessionInfo {
  id: string;
  title: string;
  directory: string;
  parentID?: string;
  createdAt: string;
  updatedAt: string;
  summary?: {
    additions: number;
    deletions: number;
    files: number;
  };
  worktree?: WorktreeInfo;
}

export interface ProjectExpandState {
  [directory: string]: boolean;
}

export const [sessionStore, setSessionStore] = createStore<{
  list: SessionInfo[];
  current: string | null;
  loading: boolean;
  projectExpanded: ProjectExpandState;
}>({
  list: [],
  current: null,
  loading: false,
  projectExpanded: {},
});
