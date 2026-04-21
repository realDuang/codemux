import { createStore } from "solid-js/store";
import type {
  CodexServiceTier,
  EngineType,
  ImageAttachment,
  ReasoningEffort,
  UnifiedProject,
  UnifiedWorktree,
} from "../types/unified";

export interface SessionInfo {
  id: string;
  engineType: EngineType;
  title: string;
  directory: string;
  mode?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: CodexServiceTier;
  projectID?: string;
  worktreeId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionInputDraft {
  text: string;
  images: ImageAttachment[];
}

export interface ProjectExpandState {
  [projectID: string]: boolean;
}

export interface WorktreeExpandState {
  [key: string]: boolean;
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
  /** Worktrees grouped by project directory */
  worktrees: Record<string, UnifiedWorktree[]>;
  /** Worktree expand/collapse state */
  worktreeExpanded: WorktreeExpandState;
  /** Per-session prompt drafts kept while switching sessions */
  inputDrafts: Record<string, SessionInputDraft>;
}>({
  list: [],
  current: null,
  loading: false,
  initError: null,
  projects: [],
  projectExpanded: {},
  sendingMap: {},
  showDefaultWorkspace: true,
  worktrees: {},
  worktreeExpanded: {},
  inputDrafts: {},
});

/** Set the sending (streaming) state for a session. */
export function setSendingFor(sessionId: string, value: boolean): void {
  setSessionStore("sendingMap", sessionId, value);
}

export function updateSessionInfo(sessionId: string, patch: Partial<SessionInfo>): void {
  setSessionStore("list", (list) =>
    list.map((session) => (session.id === sessionId ? { ...session, ...patch } : session)),
  );
}

export function getInputDraft(sessionId: string): SessionInputDraft {
  return sessionStore.inputDrafts[sessionId] ?? { text: "", images: [] };
}

export function setInputDraft(
  sessionId: string,
  patch: Partial<SessionInputDraft>,
): void {
  const current = getInputDraft(sessionId);
  setSessionStore("inputDrafts", sessionId, {
    text: patch.text ?? current.text,
    images: patch.images ?? current.images,
  });
}

export function clearInputDraft(sessionId: string): void {
  setSessionStore("inputDrafts", sessionId, { text: "", images: [] });
}

export function getProjectName(project: UnifiedProject): string {
  if (project.name) return project.name;
  const parts = project.directory.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "Unknown";
}
