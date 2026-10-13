import { createStore, reconcile } from "solid-js/store";
import { isElectron } from "../lib/platform";
import { clearPersistedInputDrafts, loadPersistedInputDrafts, persistInputDraft, readPersistedInputDrafts, type InputDraftStorage } from "../lib/input-draft-storage";
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
  /** Team orchestration group ID — groups parent + child sessions together */
  teamId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionInputDraft {
  text: string;
  images: ImageAttachment[];
}

export interface InputDraftSubmission {
  snapshot: SessionInputDraft;
  revision: number;
  scope: number;
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
  inputDraftSaveFailures: Record<string, boolean>;
  /** Whether cross-engine team orchestration is enabled */
  teamOrchestrationEnabled: boolean;
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
  inputDraftSaveFailures: {},
  teamOrchestrationEnabled: false,
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

let draftDeviceId: string | null | undefined;
let draftScope = 0;
const draftRevisions = new Map<string, number>();

function getDraftStorage(): InputDraftStorage | undefined {
  try {
    return typeof window !== "undefined" && !isElectron() ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function refreshInputDraftSaveFailures(storage: InputDraftStorage | undefined): void {
  const persisted = storage && draftDeviceId ? readPersistedInputDrafts(storage, draftDeviceId) : {};
  setSessionStore("inputDraftSaveFailures", reconcile(Object.fromEntries(
    Object.entries(sessionStore.inputDrafts).map(([id, draft]) => [id, draft.text !== (persisted[id] ?? "")]),
  )));
}

/** Restore only the current approved device's Web drafts. Electron keeps in-memory drafts. */
export function initializeWebInputDrafts(deviceId: string | null): void {
  if (isElectron() || draftDeviceId === deviceId) return;
  draftDeviceId = deviceId;
  draftScope++;
  draftRevisions.clear();
  const storage = getDraftStorage();
  const restored = storage && deviceId ? loadPersistedInputDrafts(storage, deviceId) : {};
  setSessionStore("inputDrafts", reconcile(Object.fromEntries(
    Object.entries(restored).map(([id, text]) => [id, { text, images: [] }]),
  )));
  refreshInputDraftSaveFailures(storage);
}

/** Called on logout or confirmed token revocation, before another device can authenticate. */
export function clearWebInputDrafts(): void {
  if (isElectron()) return;
  const storage = getDraftStorage();
  if (storage) clearPersistedInputDrafts(storage);
  draftDeviceId = undefined;
  initializeWebInputDrafts(null);
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
  draftRevisions.set(sessionId, (draftRevisions.get(sessionId) ?? 0) + 1);
  if (draftDeviceId && !isElectron()) {
    const storage = getDraftStorage();
    if (storage) persistInputDraft(storage, draftDeviceId, sessionId, patch.text ?? current.text);
    refreshInputDraftSaveFailures(storage);
  }
}

export function clearInputDraft(sessionId: string): void {
  setInputDraft(sessionId, { text: "", images: [] });
}

/** Consume after send validation, so failed validation never erases the prompt. */
export function consumeInputDraft(sessionId: string): InputDraftSubmission {
  const current = getInputDraft(sessionId);
  const snapshot = { text: current.text, images: current.images.map((image) => ({ ...image })) };
  clearInputDraft(sessionId);
  return { snapshot, revision: draftRevisions.get(sessionId) ?? 0, scope: draftScope };
}

/** A late failure cannot overwrite edits, a newer submission, or another login's draft. */
export function restoreInputDraftIfUnchanged(sessionId: string, submission: InputDraftSubmission): boolean {
  if (submission.scope !== draftScope || submission.revision !== draftRevisions.get(sessionId)) return false;
  setInputDraft(sessionId, submission.snapshot);
  return true;
}

export function getProjectName(project: UnifiedProject): string {
  if (project.name) return project.name;
  const parts = project.directory.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "Unknown";
}
