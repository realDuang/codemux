// =============================================================================
// Session Store — File-based session & project metadata persistence
// =============================================================================

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { app } from "electron";
import { sessionStoreLog } from "./logger";
import type {
  EngineType,
  UnifiedSession,
  UnifiedProject,
} from "../../../src/types/unified";

// =============================================================================
// Types
// =============================================================================

interface SessionsFile {
  version: number;
  engineType: string;
  directory: string;
  sessions: UnifiedSession[];
}

// =============================================================================
// Session Store
// =============================================================================

class SessionStore {
  private basePath = "";
  private initialized = false;

  // In-memory caches
  private sessionCache = new Map<string, UnifiedSession>();

  // Debounced write tracking
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private dirtySessionFiles = new Map<string, SessionsFile>();

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  init(): void {
    if (this.initialized) return;

    // Always use userData to avoid triggering Vite's file watcher in dev mode
    this.basePath = path.join(app.getPath("userData"), "sessions");

    this.ensureDir(this.basePath);
    this.loadAllSessions();
    this.initialized = true;
    sessionStoreLog.info(`Initialized at ${this.basePath}, ${this.sessionCache.size} sessions`);

    // Re-save all sessions so they migrate from old hash-based folders
    // to new project-id-based folders, then clean up old empty dirs.
    this.migrateToProjectIdFolders();
  }

  flushAll(): void {
    // Flush all pending session file writes
    for (const [key, timer] of this.pendingTimers) {
      clearTimeout(timer);
      this.flushSessionFile(key);
    }
    this.pendingTimers.clear();
  }

  // -------------------------------------------------------------------------
  // Session CRUD
  // -------------------------------------------------------------------------

  getAllSessions(): UnifiedSession[] {
    this.ensureInitialized();
    const sessions = Array.from(this.sessionCache.values());
    sessions.sort((a, b) => b.time.updated - a.time.updated);
    return sessions;
  }

  getSessionsByEngine(engineType: EngineType): UnifiedSession[] {
    this.ensureInitialized();
    const result: UnifiedSession[] = [];
    for (const s of this.sessionCache.values()) {
      if (s.engineType === engineType) result.push(s);
    }
    result.sort((a, b) => b.time.updated - a.time.updated);
    return result;
  }

  getSessionsByDirectory(directory: string, engineType?: EngineType): UnifiedSession[] {
    this.ensureInitialized();
    const norm = this.normalizeDir(directory);
    const result: UnifiedSession[] = [];
    for (const s of this.sessionCache.values()) {
      if (s.directory === norm && (!engineType || s.engineType === engineType)) {
        result.push(s);
      }
    }
    result.sort((a, b) => b.time.updated - a.time.updated);
    return result;
  }

  getSession(sessionId: string): UnifiedSession | null {
    this.ensureInitialized();
    return this.sessionCache.get(sessionId) ?? null;
  }

  upsertSession(session: UnifiedSession): void {
    this.ensureInitialized();
    this.resolveProjectId(session);
    this.sessionCache.set(session.id, session);
    this.scheduleSessionSave(session.engineType, session.directory);
  }

  deleteSession(sessionId: string): void {
    this.ensureInitialized();
    const session = this.sessionCache.get(sessionId);
    if (!session) return;
    this.sessionCache.delete(sessionId);
    this.scheduleSessionSave(session.engineType, session.directory);
  }

  /**
   * Merge engine-sourced sessions with local data.
   * If local copy has a newer time.updated, keep local; otherwise take engine data.
   */
  mergeSessions(sessions: UnifiedSession[], engineType: EngineType): void {
    this.ensureInitialized();
    const affectedDirs = new Set<string>();

    for (const s of sessions) {
      const existing = this.sessionCache.get(s.id);
      if (!existing || s.time.updated >= existing.time.updated) {
        this.resolveProjectId(s);
        this.sessionCache.set(s.id, s);
        affectedDirs.add(s.directory);
      }
    }

    for (const dir of affectedDirs) {
      this.scheduleSessionSave(engineType, dir);
    }
  }

  // -------------------------------------------------------------------------
  // Project — derived from sessions (no persistent projects.json)
  // -------------------------------------------------------------------------

  /**
   * Derive projects by grouping sessions by (directory, engineType).
   * Each unique combination becomes a virtual project.
   */
  getAllProjects(): UnifiedProject[] {
    this.ensureInitialized();
    const dirEngineMap = new Map<string, { directory: string; engineType: EngineType }>();

    for (const session of this.sessionCache.values()) {
      if (!session.directory || session.directory === "/") continue;
      const key = `${session.engineType}::${session.directory}`;
      if (!dirEngineMap.has(key)) {
        dirEngineMap.set(key, {
          directory: session.directory,
          engineType: session.engineType,
        });
      }
    }

    const projects: UnifiedProject[] = [];
    for (const { directory, engineType } of dirEngineMap.values()) {
      const name = directory.split(/[/\\]/).filter(Boolean).pop() || directory;
      projects.push({
        id: `${engineType}-${directory}`,
        directory,
        name,
        engineType,
      });
    }
    return projects;
  }

  getVisibleProjects(): UnifiedProject[] {
    // No more hidden filtering — all session-derived projects are visible
    return this.getAllProjects();
  }

  /**
   * No-op: projects are now derived from sessions, not independently persisted.
   * Kept for API compatibility — callers can safely call this without effect.
   */
  upsertProject(_project: UnifiedProject): void {
    // Intentionally empty — projects are derived from sessions
  }

  /**
   * Delete a project by removing all its sessions from cache and disk.
   */
  deleteProject(projectId: string): void {
    this.ensureInitialized();

    // Parse directory and engineType from project id format: "engineType-directory"
    // Also try to find by matching derived projects
    const derived = this.getAllProjects();
    const project = derived.find(p => p.id === projectId);
    if (!project) return;

    // Remove all sessions belonging to this project from cache
    const normDir = this.normalizeDir(project.directory);
    const toDelete: string[] = [];
    for (const [id, s] of this.sessionCache) {
      if (s.engineType === project.engineType && this.normalizeDir(s.directory) === normDir) {
        toDelete.push(id);
      }
    }
    for (const id of toDelete) {
      this.sessionCache.delete(id);
    }

    // Remove the sessions file and directory from disk
    const filePath = this.getSessionFilePath(project.engineType, project.directory);
    const dirPath = path.dirname(filePath);
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    } catch (err) {
      sessionStoreLog.error(`Failed to clean up project dir ${dirPath}:`, err);
    }
  }

  /**
   * Legacy import — no-op since projects are now session-derived.
   */
  importLegacyProjects(
    _projects: Array<{ id: string; path: string }>,
  ): void {
    // Intentionally empty — projects are derived from sessions
  }

  // -------------------------------------------------------------------------
  // Private — Path helpers
  // -------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("SessionStore not initialized. Call init() after app.whenReady()");
    }
  }

  /**
   * Resolve and set projectId on a session by matching (directory, engineType).
   * Uses engineMeta.projectID as fallback, then derives from directory.
   */
  private resolveProjectId(session: UnifiedSession): void {
    // Already has a projectId from a previous resolution? Keep it.
    if (session.projectId) return;

    // Try engineMeta.projectID first (OpenCode provides this)
    const metaProjectId = session.engineMeta?.projectID as string | undefined;
    if (metaProjectId) {
      session.projectId = metaProjectId;
      return;
    }

    // Derive projectId from (engineType, directory) — deterministic format
    if (session.directory) {
      session.projectId = `${session.engineType}-${this.normalizeDir(session.directory)}`;
    }
  }

  private normalizeDir(dir: string): string {
    return dir.replaceAll("\\", "/");
  }

  /**
   * Create a filesystem-safe folder name from a project id.
   * OpenCode ids are already hex-safe. Copilot ids like "copilot-C:/Users/..."
   * contain path separators, so we replace unsafe chars with underscores.
   */
  private safeProjectFolder(projectId: string): string {
    // Replace characters that are invalid in Windows/Unix folder names
    return projectId.replace(/[<>:"/\\|?*]/g, "_");
  }

  /**
   * Resolve the project id for a given (directory, engineType) pair.
   * Uses deterministic format: "engineType-directory" or session's existing projectId.
   */
  private resolveProjectIdForPath(engineType: string, directory: string): string | null {
    const normDir = this.normalizeDir(directory);
    // First check if any session in this group already has a projectId
    for (const s of this.sessionCache.values()) {
      if (s.engineType === engineType && this.normalizeDir(s.directory) === normDir && s.projectId) {
        return s.projectId;
      }
    }
    // Fall back to deterministic project id
    return `${engineType}-${normDir}`;
  }

  private getSessionFilePath(engineType: string, directory: string): string {
    const projectId = this.resolveProjectIdForPath(engineType, directory);
    const folder = projectId ? this.safeProjectFolder(projectId) : this.projectHash(directory);
    return path.join(this.basePath, engineType, folder, "sessions.json");
  }

  private projectHash(directory: string): string {
    const normalized = this.normalizeDir(directory).toLowerCase();
    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  }

  private getSessionFileKey(engineType: string, directory: string): string {
    return `${engineType}::${this.normalizeDir(directory)}`;
  }

  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  // -------------------------------------------------------------------------
  // Private — Load on startup
  // -------------------------------------------------------------------------

  private loadAllSessions(): void {
    // Scan all engine directories
    if (!fs.existsSync(this.basePath)) return;

    const engineDirs = fs.readdirSync(this.basePath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const engineDir of engineDirs) {
      const enginePath = path.join(this.basePath, engineDir);
      const hashDirs = fs.readdirSync(enginePath, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const hashDir of hashDirs) {
        const sessionsFile = path.join(enginePath, hashDir, "sessions.json");
        if (!fs.existsSync(sessionsFile)) continue;

        try {
          const raw = fs.readFileSync(sessionsFile, "utf-8");
          const data: SessionsFile = JSON.parse(raw);
          if (data.sessions) {
            for (const session of data.sessions) {
              this.sessionCache.set(session.id, session);
            }
          }
        } catch (err) {
          sessionStoreLog.error(`Failed to read ${sessionsFile}:`, err);
        }
      }
    }
  }

  /**
   * One-time migration: re-save all sessions into project-id-based folders
   * and delete the old hash-based folders that are now empty.
   */
  private migrateToProjectIdFolders(): void {
    // Resolve projectId for all cached sessions first
    for (const s of this.sessionCache.values()) {
      this.resolveProjectId(s);
    }

    // Group sessions by (engineType, directory) and flush each to new path
    const groups = new Map<string, { engineType: string; directory: string }>();
    for (const s of this.sessionCache.values()) {
      const key = this.getSessionFileKey(s.engineType, s.directory);
      if (!groups.has(key)) {
        groups.set(key, { engineType: s.engineType, directory: s.directory });
      }
    }
    for (const { engineType, directory } of groups.values()) {
      this.flushSessionFile(this.getSessionFileKey(engineType, directory));
    }

    // Clean up old directories: any subfolder that is no longer the target
    // path for any group is an orphan from the old hash-based naming.
    const activeFolders = new Set<string>();
    for (const { engineType, directory } of groups.values()) {
      const filePath = this.getSessionFilePath(engineType, directory);
      activeFolders.add(path.dirname(filePath));
    }

    if (!fs.existsSync(this.basePath)) return;
    const engineDirs = fs.readdirSync(this.basePath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    let cleaned = 0;
    for (const engineDir of engineDirs) {
      const enginePath = path.join(this.basePath, engineDir);
      const subDirs = fs.readdirSync(enginePath, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const sub of subDirs) {
        const fullPath = path.join(enginePath, sub);
        if (!activeFolders.has(fullPath)) {
          try {
            fs.rmSync(fullPath, { recursive: true, force: true });
            cleaned++;
          } catch { /* ignore cleanup errors */ }
        }
      }
    }
    if (cleaned > 0) {
      sessionStoreLog.info(`Migration: cleaned up ${cleaned} old hash-based folder(s)`);
    }
  }

  // -------------------------------------------------------------------------
  // Private — Debounced persistence
  // -------------------------------------------------------------------------

  private scheduleSessionSave(engineType: string, directory: string): void {
    const key = this.getSessionFileKey(engineType, directory);
    const existing = this.pendingTimers.get(key);
    if (existing) clearTimeout(existing);

    this.pendingTimers.set(key, setTimeout(() => {
      this.flushSessionFile(key);
      this.pendingTimers.delete(key);
    }, 500));
  }

  private flushSessionFile(key: string): void {
    const [engineType, directory] = key.split("::");
    if (!engineType || !directory) return;

    // Collect all sessions for this engine+directory
    const sessions: UnifiedSession[] = [];
    for (const s of this.sessionCache.values()) {
      if (s.engineType === engineType && this.normalizeDir(s.directory) === directory) {
        sessions.push(s);
      }
    }

    const filePath = this.getSessionFilePath(engineType, directory);
    const data: SessionsFile = {
      version: 1,
      engineType,
      directory,
      sessions,
    };

    this.atomicWrite(filePath, data);
  }

  /**
   * Atomic write: write to .tmp file first, then rename.
   */
  private atomicWrite(filePath: string, data: unknown): void {
    const dir = path.dirname(filePath);
    this.ensureDir(dir);

    const tmpPath = filePath + ".tmp";
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      sessionStoreLog.error(`Failed to write ${filePath}:`, err);
      // Clean up tmp file if rename failed
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}

export const sessionStore = new SessionStore();
