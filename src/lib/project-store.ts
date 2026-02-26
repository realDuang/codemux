const STORAGE_KEY = "codemux_projects";
const HIDDEN_KEY = "codemux_hidden_projects";

export interface LocalProject {
  id: string;
  path: string;
  addedAt: number;
}

export const ProjectStore = {
  getAll(): LocalProject[] {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  add(projectId: string, path: string): void {
    const normalizedPath = path.replaceAll("\\", "/");
    const projects = this.getAll();
    const existing = projects.find((p) => p.id === projectId);
    if (existing) {
      existing.path = normalizedPath;
    } else {
      projects.push({ id: projectId, path: normalizedPath, addedAt: Date.now() });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
    this.unhide(projectId);
  },

  getPath(projectId: string): string | null {
    const projects = this.getAll();
    return projects.find((p) => p.id === projectId)?.path ?? null;
  },

  remove(projectId: string): void {
    const projects = this.getAll().filter((p) => p.id !== projectId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  },

  clear(): void {
    localStorage.removeItem(STORAGE_KEY);
  },

  getHiddenIds(): string[] {
    try {
      const data = localStorage.getItem(HIDDEN_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  hide(projectId: string): void {
    const hidden = this.getHiddenIds();
    if (!hidden.includes(projectId)) {
      hidden.push(projectId);
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden));
    }
    this.remove(projectId);
  },

  unhide(projectId: string): void {
    const hidden = this.getHiddenIds().filter((id) => id !== projectId);
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden));
  },

  isHidden(projectId: string): boolean {
    return this.getHiddenIds().includes(projectId);
  },
};
