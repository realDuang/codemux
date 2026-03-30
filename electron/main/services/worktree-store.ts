/**
 * Persistent storage for worktree metadata.
 * Stores per-project worktree index at {appData}/codemux/worktrees/{projectId}/index.json.
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { app } from "electron";
import log from "electron-log/main";

const worktreeStoreLog = log.scope("WorktreeStore");

export interface WorktreeInfo {
  name: string;
  branch: string;
  directory: string;
  baseBranch: string;
  projectId: string;
  createdAt: number;
  status: "pending" | "ready" | "error";
}

interface WorktreeIndex {
  version: number;
  updatedAt: string;
  worktrees: WorktreeInfo[];
}

const INDEX_VERSION = 1;
const INDEX_DEBOUNCE_MS = 500;

export class WorktreeStore {
  private basePath!: string;
  private initialized = false;
  // projectId → Map<name, WorktreeInfo>
  private cache = new Map<string, Map<string, WorktreeInfo>>();
  private dirtyProjects = new Set<string>();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  init(): void {
    if (this.initialized) return;
    this.basePath = path.join(app.getPath("userData"), "worktrees");
    this.ensureDirSync(this.basePath);
    this.initialized = true;
    worktreeStoreLog.info(`Initialized at ${this.basePath}`);
  }

  private ensureDirSync(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private projectDir(projectId: string): string {
    return path.join(this.basePath, projectId);
  }

  private indexPath(projectId: string): string {
    return path.join(this.projectDir(projectId), "index.json");
  }

  private loadProject(projectId: string): Map<string, WorktreeInfo> {
    const cached = this.cache.get(projectId);
    if (cached) return cached;

    const map = new Map<string, WorktreeInfo>();
    const indexFile = this.indexPath(projectId);

    if (fs.existsSync(indexFile)) {
      try {
        const raw = fs.readFileSync(indexFile, "utf-8");
        const data: WorktreeIndex = JSON.parse(raw);
        if (data.version === INDEX_VERSION) {
          for (const wt of data.worktrees) {
            map.set(wt.name, wt);
          }
        } else {
          worktreeStoreLog.warn(
            `Index version mismatch for ${projectId} (${data.version} vs ${INDEX_VERSION})`,
          );
        }
      } catch (err) {
        worktreeStoreLog.error(`Failed to read worktree index for ${projectId}:`, err);
      }
    }

    this.cache.set(projectId, map);
    return map;
  }

  list(projectId: string): WorktreeInfo[] {
    const map = this.loadProject(projectId);
    return Array.from(map.values());
  }

  get(projectId: string, name: string): WorktreeInfo | undefined {
    const map = this.loadProject(projectId);
    return map.get(name);
  }

  add(info: WorktreeInfo): void {
    const map = this.loadProject(info.projectId);
    map.set(info.name, info);
    this.scheduleWrite(info.projectId);
  }

  update(projectId: string, name: string, patch: Partial<WorktreeInfo>): void {
    const map = this.loadProject(projectId);
    const existing = map.get(name);
    if (!existing) return;
    map.set(name, { ...existing, ...patch });
    this.scheduleWrite(projectId);
  }

  remove(projectId: string, name: string): boolean {
    const map = this.loadProject(projectId);
    const deleted = map.delete(name);
    if (deleted) {
      this.scheduleWrite(projectId);
    }
    return deleted;
  }

  findByDirectory(directory: string): WorktreeInfo | undefined {
    const normalized = directory.replace(/\\/g, "/").replace(/\/+$/, "");
    for (const map of this.cache.values()) {
      for (const wt of map.values()) {
        const wtDir = wt.directory.replace(/\\/g, "/").replace(/\/+$/, "");
        if (wtDir === normalized) return wt;
      }
    }
    return undefined;
  }

  private scheduleWrite(projectId: string): void {
    this.dirtyProjects.add(projectId);
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flushDirty();
    }, INDEX_DEBOUNCE_MS);
  }

  private async flushDirty(): Promise<void> {
    const projects = Array.from(this.dirtyProjects);
    this.dirtyProjects.clear();
    await Promise.all(projects.map((pid) => this.writeIndex(pid)));
  }

  private async writeIndex(projectId: string): Promise<void> {
    const map = this.cache.get(projectId);
    if (!map) return;

    const worktrees = Array.from(map.values());
    worktrees.sort((a, b) => b.createdAt - a.createdAt);

    const data: WorktreeIndex = {
      version: INDEX_VERSION,
      updatedAt: new Date().toISOString(),
      worktrees,
    };

    const dir = this.projectDir(projectId);
    await fsp.mkdir(dir, { recursive: true });

    const filePath = this.indexPath(projectId);
    const tmpPath = filePath + ".tmp";
    try {
      await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      await fsp.rename(tmpPath, filePath);
    } catch (err) {
      worktreeStoreLog.error(`Failed to write worktree index for ${projectId}:`, err);
      try {
        await fsp.unlink(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.flushDirty();
  }
}

export const worktreeStore = new WorktreeStore();
