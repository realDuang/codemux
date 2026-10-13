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
  UnifiedSession,
  EngineCatalogSnapshot,
} from "../types/unified";

export interface SessionInfo {
  id: string;
  engineType: EngineType;
  title: string;
  sourceUrl?: string;
  sourceName?: string;
  archived?: boolean;
  catalogSourceId?: string;
  catalogAvailable?: boolean;
  directory: string;
  mode?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: CodexServiceTier;
  projectID?: string | null;
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
  catalogs: Record<string, EngineCatalogSnapshot>;
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
  catalogs: {},
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

export function toSessionInfo(session: UnifiedSession, fallbackProjectId?: string): SessionInfo {
  return {
    id: session.id, engineType: session.engineType, title: session.title || "",
    ...(session.sourceUrl ? { sourceUrl: session.sourceUrl, sourceName: session.sourceName } : {}),
    archived: session.archived, catalogSourceId: session.catalogSourceId, catalogAvailable: session.catalogAvailable,
    directory: session.directory || "", mode: session.mode, modelId: session.modelId,
    reasoningEffort: session.reasoningEffort, serviceTier: session.serviceTier,
    projectID: session.catalogSourceId ? session.projectId ?? null : fallbackProjectId ?? session.projectId ?? undefined,
    worktreeId: session.worktreeId,
    createdAt: new Date(session.time.created).toISOString(), updatedAt: new Date(session.time.updated).toISOString(),
  };
}

/** Catalog updates never reset the selected conversation, its messages or drafts. */
export function applySessionCatalog(snapshot: EngineCatalogSnapshot): void {
  setSessionStore("catalogs", snapshot.sourceId, snapshot);
  const incoming = new Map(snapshot.sessions.map((session) => [session.id, toSessionInfo({ ...session, catalogSourceId: snapshot.sourceId })]));
  setSessionStore("list", (current) => {
    const result = current.map((session) => {
      const next = incoming.get(session.id);
      if (next) {
        incoming.delete(session.id);
        const defined = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined));
        return { ...session, ...defined };
      }
      if (snapshot.complete && session.catalogSourceId === snapshot.sourceId && session.catalogAvailable !== undefined) {
        return { ...session, catalogAvailable: false };
      }
      return session;
    });
    return [...result, ...incoming.values()];
  });
}

/** Ordinary list refreshes must not replace newer catalog events. */
export function replaceListedSessions(sessions: SessionInfo[]): void {
  setSessionStore("list", (current) => {
    const catalog = new Map(sessions.filter((session) => session.catalogSourceId).map((session) => [session.id, session]));
    for (const session of current) if (session.catalogSourceId) catalog.set(session.id, session);
    return [...sessions.filter((session) => !session.catalogSourceId), ...catalog.values()];
  });
}

export function visibleSessionsForEngines(sessions: readonly SessionInfo[], hideArchivedFor: ReadonlySet<EngineType>): SessionInfo[] {
  return sessions.filter((session) => !session.archived || !hideArchivedFor.has(session.engineType));
}

export function removeListedSession(sessionId: string): void {
  setSessionStore("list", (sessions) => sessions.filter((session) => session.id !== sessionId));
  for (const [sourceId, catalog] of Object.entries(sessionStore.catalogs)) {
    if (catalog.sessions.some((session) => session.id === sessionId)) {
      setSessionStore("catalogs", sourceId, { ...catalog, sessions: catalog.sessions.filter((session) => session.id !== sessionId) });
    }
  }
  setSendingFor(sessionId, false);
  if (sessionStore.current === sessionId) setSessionStore("current", null);
}

/** Resolve sidebar groups without changing native project membership or cwd. */
export function buildSessionProjectView(
  sessions: readonly SessionInfo[],
  projects: readonly UnifiedProject[],
  catalogs: readonly EngineCatalogSnapshot[] = [],
): { projects: UnifiedProject[]; projectIds: Map<string, string | undefined>; displayOnlyIds: Set<string> } {
  const normalize = (path: string) => path ? path.replaceAll("\\", "/").replace(/\/+$/, "") || "/" : "";
  const byId = new Map(projects.map((project) => [project.id, project]));
  for (const catalog of catalogs) for (const project of catalog.projects) byId.set(project.id, project);
  const projectIds = new Map<string, string | undefined>();
  const displayOnlyIds = new Set<string>();
  for (const session of sessions) {
    if (!session.catalogSourceId) { projectIds.set(session.id, session.projectID ?? undefined); continue; }
    if (session.projectID) {
      projectIds.set(session.id, session.projectID);
      if (!byId.has(session.projectID)) {
        byId.set(session.projectID, { id: session.projectID, directory: "", catalogSourceId: session.catalogSourceId });
        displayOnlyIds.add(session.projectID);
      }
      continue;
    }
    const cwd = normalize(session.directory);
    const available = [...byId.values()].filter((project) => project.catalogAvailable !== false
      && (normalize(project.directory) !== "/" || project.catalogSourceId || project.isDefault));
    const defaultProject = available.find((project) => project.isDefault && normalize(project.directory) === cwd && cwd);
    const matches = available.flatMap((project) => [...new Set([project.directory, ...(project.roots ?? [])])]
      .map(normalize).filter((root) => root && cwd && (cwd === root || cwd.startsWith(root === "/" ? "/" : `${root}/`)))
      .map((root) => ({ project, length: root.length })));
    matches.sort((left, right) => right.length - left.length);
    const matched = defaultProject ?? matches[0]?.project;
    if (matched) { projectIds.set(session.id, matched.id); continue; }
    const id = `view:directory:${encodeURIComponent(cwd)}`;
    if (!byId.has(id)) byId.set(id, { id, directory: session.directory, engineType: session.engineType });
    displayOnlyIds.add(id);
    projectIds.set(session.id, id);
  }
  return {
    projects: [...byId.values()].map((project) => project.directory || !project.roots?.length ? project : { ...project, directory: project.roots[0] }),
    projectIds, displayOnlyIds,
  };
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
