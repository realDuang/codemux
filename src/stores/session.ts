import { createStore } from "solid-js/store";

export interface SessionInfo {
  id: string;
  title: string;
  directory: string;           // 项目目录路径（用于分组）
  parentID?: string;           // 父会话 ID
  createdAt: string;
  updatedAt: string;
  summary?: {
    additions: number;
    deletions: number;
    files: number;
  };
}

// 项目展开状态
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
