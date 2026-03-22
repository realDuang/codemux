import { createStore } from "solid-js/store";
import { gateway } from "../lib/gateway-api";
import type {
  FileExplorerNode,
  FileExplorerContent,
  GitFileStatus,
} from "../types/unified";
import { getSetting, saveSetting } from "../lib/settings";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DirectoryState {
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  children: FileExplorerNode[];
  error?: string;
}

interface FilePreviewState {
  path: string; // relative path
  absolutePath: string;
  name: string;
  content?: FileExplorerContent;
  diff?: string; // unified diff string
  loading: boolean;
  error?: string;
}

interface OpenTab {
  path: string;
  absolutePath: string;
  name: string;
  scrollTop?: number;
  scrollLeft?: number;
}

interface FileStoreState {
  panelOpen: boolean;
  panelWidth: number;
  activeTab: "files" | "changes";
  rootDirectory: string | null;
  directories: Record<string, DirectoryState>; // keyed by relative path ("." for root)
  preview: FilePreviewState | null;
  openTabs: { active: string | null; all: OpenTab[] };
  gitStatus: GitFileStatus[];
  gitStatusLoading: boolean;
  searchQuery: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const [fileStore, setFileStore] = createStore<FileStoreState>({
  panelOpen: (getSetting("fileExplorerPanelOpen") as boolean | undefined) ?? false,
  panelWidth: (getSetting("fileExplorerPanelWidth") as number | undefined) ?? 260,
  activeTab: (getSetting("fileExplorerActiveTab") as "files" | "changes" | undefined) ?? "files",
  rootDirectory: null,
  directories: {},
  preview: null,
  openTabs: { active: null, all: [] },
  gitStatus: [],
  gitStatusLoading: false,
  searchQuery: "",
});

// ---------------------------------------------------------------------------
// LRU content cache
// ---------------------------------------------------------------------------

const MAX_CACHE_ENTRIES = 40;
const MAX_CACHE_BYTES = 20 * 1024 * 1024; // 20 MB

const contentCache = new Map<
  string,
  { content: FileExplorerContent; bytes: number }
>();
let totalBytes = 0;

function approxBytes(content: FileExplorerContent): number {
  return content.content.length * 2; // rough UTF-16 estimate
}

function cacheGet(path: string): FileExplorerContent | undefined {
  const entry = contentCache.get(path);
  if (!entry) return undefined;
  // Touch: move to end (most recently used)
  contentCache.delete(path);
  contentCache.set(path, entry);
  return entry.content;
}

function cacheSet(path: string, content: FileExplorerContent): void {
  const bytes = approxBytes(content);
  // Remove existing entry if present
  const existing = contentCache.get(path);
  if (existing) {
    totalBytes -= existing.bytes;
    contentCache.delete(path);
  }
  // Evict oldest until within limits
  while (
    contentCache.size >= MAX_CACHE_ENTRIES ||
    totalBytes + bytes > MAX_CACHE_BYTES
  ) {
    const oldest = contentCache.keys().next().value;
    if (!oldest) break;
    const oldEntry = contentCache.get(oldest)!;
    totalBytes -= oldEntry.bytes;
    contentCache.delete(oldest);
  }
  contentCache.set(path, { content, bytes });
  totalBytes += bytes;
}

// ---------------------------------------------------------------------------
// Request deduplication
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inflight = new Map<string, Promise<any>>();

// ---------------------------------------------------------------------------
// Panel actions
// ---------------------------------------------------------------------------

export function togglePanel(): void {
  setFileStore("panelOpen", (v) => !v);
  saveSetting("fileExplorerPanelOpen", fileStore.panelOpen);
}

export function openPanel(): void {
  setFileStore("panelOpen", true);
}

export function closePanel(): void {
  setFileStore("panelOpen", false);
}

export function setPanelWidth(width: number): void {
  const clamped = Math.max(200, Math.min(600, width));
  setFileStore("panelWidth", clamped);
  saveSetting("fileExplorerPanelWidth", clamped);
}

// ---------------------------------------------------------------------------
// Tab (files / changes) actions
// ---------------------------------------------------------------------------

export function setActiveFileTab(tab: "files" | "changes"): void {
  setFileStore("activeTab", tab);
  saveSetting("fileExplorerActiveTab", tab);
}

// ---------------------------------------------------------------------------
// Directory operations
// ---------------------------------------------------------------------------

export async function setRootDirectory(
  directory: string | null,
): Promise<void> {
  // Reset state
  setFileStore({
    rootDirectory: directory,
    directories: {},
    preview: null,
    openTabs: { active: null, all: [] },
    gitStatus: [],
    gitStatusLoading: false,
    searchQuery: "",
  });

  if (!directory) return;

  await Promise.all([loadDirectory(directory, "."), loadGitStatus(directory)]);
  // Start watching for changes
  gateway.watchDirectory(directory).catch(() => {});
}

export async function loadDirectory(
  rootDir: string,
  relativePath: string,
): Promise<void> {
  const key = `listFiles:${rootDir}:${relativePath}`;

  // Dedup
  if (inflight.has(key)) {
    await inflight.get(key);
    return;
  }

  setFileStore("directories", relativePath, {
    expanded: fileStore.directories[relativePath]?.expanded ?? false,
    loaded: false,
    loading: true,
    children: fileStore.directories[relativePath]?.children ?? [],
  });

  const fullPath =
    relativePath === "."
      ? rootDir
      : `${rootDir}/${relativePath}`.replace(/\\/g, "/");

  const promise = gateway
    .listFiles(fullPath)
    .then((children) => {
      // The service returns `path: entry.name` (just the filename).
      // Prepend the parent relativePath so nested lookups work correctly.
      const adjustedChildren = children.map((node) => ({
        ...node,
        path:
          relativePath === "." ? node.name : `${relativePath}/${node.name}`,
      }));
      setFileStore("directories", relativePath, {
        expanded: true,
        loaded: true,
        loading: false,
        children: adjustedChildren,
      });
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setFileStore("directories", relativePath, {
        expanded: fileStore.directories[relativePath]?.expanded ?? false,
        loaded: false,
        loading: false,
        children: fileStore.directories[relativePath]?.children ?? [],
        error: msg,
      });
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  await promise;
}

export async function toggleDirectory(
  rootDir: string,
  relativePath: string,
): Promise<void> {
  const dir = fileStore.directories[relativePath];

  if (dir?.expanded) {
    // Collapse
    setFileStore("directories", relativePath, "expanded", false);
    return;
  }

  if (dir?.loaded) {
    // Already loaded — just expand
    setFileStore("directories", relativePath, "expanded", true);
    return;
  }

  // First expand — lazy load
  await loadDirectory(rootDir, relativePath);
}

// ---------------------------------------------------------------------------
// File preview
// ---------------------------------------------------------------------------

export async function previewFile(
  absolutePath: string,
  name: string,
  relativePath: string,
): Promise<void> {
  // Open tab if not already open
  openTab(relativePath, absolutePath, name);

  // Check cache
  const cached = cacheGet(absolutePath);
  if (cached) {
    setFileStore("preview", {
      path: relativePath,
      absolutePath,
      name,
      content: cached,
      loading: false,
    });
    return;
  }

  // Set loading state
  setFileStore("preview", {
    path: relativePath,
    absolutePath,
    name,
    loading: true,
  });

  const rootDir = fileStore.rootDirectory;
  if (!rootDir) return;

  const key = `readFile:${absolutePath}`;

  // Dedup: reuse in-flight request
  if (inflight.has(key)) {
    try {
      const content = (await inflight.get(key)) as FileExplorerContent;
      setFileStore("preview", {
        path: relativePath,
        absolutePath,
        name,
        content,
        loading: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setFileStore("preview", {
        path: relativePath,
        absolutePath,
        name,
        loading: false,
        error: msg,
      });
    }
    return;
  }

  const promise = gateway.readFile(absolutePath, rootDir);
  inflight.set(key, promise);

  try {
    const content = await promise;
    cacheSet(absolutePath, content);
    setFileStore("preview", {
      path: relativePath,
      absolutePath,
      name,
      content,
      loading: false,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setFileStore("preview", {
      path: relativePath,
      absolutePath,
      name,
      loading: false,
      error: msg,
    });
  } finally {
    inflight.delete(key);
  }
}

export async function loadDiff(
  directory: string,
  relativePath: string,
): Promise<void> {
  if (!fileStore.preview) return;

  setFileStore("preview", "loading", true);

  try {
    const diff = await gateway.getGitDiff(directory, relativePath);
    setFileStore("preview", { diff, loading: false, error: undefined });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setFileStore("preview", { loading: false, error: msg });
  }
}

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------

export function openTab(
  path: string,
  absolutePath: string,
  name: string,
): void {
  const exists = fileStore.openTabs.all.some((t) => t.path === path);
  if (!exists) {
    setFileStore("openTabs", "all", (prev) => [
      ...prev,
      { path, absolutePath, name },
    ]);
  }
  setFileStore("openTabs", "active", path);
}

export function closeTab(path: string): void {
  const tabs = fileStore.openTabs.all;
  const idx = tabs.findIndex((t) => t.path === path);
  if (idx === -1) return;

  const newTabs = tabs.filter((t) => t.path !== path);
  setFileStore("openTabs", "all", newTabs);

  // If closing the active tab, switch to an adjacent one
  if (fileStore.openTabs.active === path) {
    if (newTabs.length === 0) {
      setFileStore("openTabs", "active", null);
      setFileStore("preview", null);
    } else {
      const next = newTabs[Math.min(idx, newTabs.length - 1)];
      setFileStore("openTabs", "active", next.path);
      // Load the file content for the newly active tab
      previewFile(next.absolutePath, next.name, next.path);
    }
  }
}

export function switchTab(path: string): void {
  setFileStore("openTabs", "active", path);
  // Load the file content for the newly active tab
  const tab = fileStore.openTabs.all.find((t) => t.path === path);
  if (tab) {
    previewFile(tab.absolutePath, tab.name, tab.path);
  }
}

export function saveTabScroll(
  path: string,
  scrollTop: number,
  scrollLeft?: number,
): void {
  const idx = fileStore.openTabs.all.findIndex((t) => t.path === path);
  if (idx === -1) return;
  setFileStore("openTabs", "all", idx, "scrollTop", scrollTop);
  if (scrollLeft !== undefined) {
    setFileStore("openTabs", "all", idx, "scrollLeft", scrollLeft);
  }
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export async function loadGitStatus(directory: string): Promise<void> {
  setFileStore("gitStatusLoading", true);

  try {
    const status = await gateway.getGitStatus(directory);
    setFileStore("gitStatus", status);
  } catch {
    setFileStore("gitStatus", []);
  } finally {
    setFileStore("gitStatusLoading", false);
  }
}

export function getFileGitStatus(
  relativePath: string,
): GitFileStatus | undefined {
  return fileStore.gitStatus.find((s) => s.path === relativePath);
}

export function getGitStatusLabel(status: GitFileStatus["status"]): string {
  if (status === "added" || status === "untracked") return "A";
  if (status === "deleted") return "D";
  return "M";
}

export function getGitStatusColor(status: GitFileStatus["status"]): string {
  if (status === "added" || status === "untracked") return "text-green-500";
  if (status === "deleted") return "text-red-500";
  return "text-yellow-500";
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function setSearchQuery(query: string): void {
  setFileStore("searchQuery", query);
}

// ---------------------------------------------------------------------------
// File watcher
// ---------------------------------------------------------------------------

let fileChangeDebounceTimer: ReturnType<typeof setTimeout> | undefined;

export function handleFileChanged(event: {
  type: string;
  path: string;
  directory: string;
}): void {
  const dir = fileStore.rootDirectory;
  if (!dir || event.directory !== dir) return;

  clearTimeout(fileChangeDebounceTimer);
  fileChangeDebounceTimer = setTimeout(() => {
    // Compute relative directory of the changed file
    const relativePath = event.path
      .replace(dir, "")
      .replace(/^[\/\\]/, "")
      .split(/[\/\\]/)
      .slice(0, -1)
      .join("/");
    const dirKey = relativePath || ".";

    // Reload the directory that changed
    if (fileStore.directories[dirKey]?.loaded) {
      loadDirectory(dir, dirKey);
    }

    // Also refresh git status
    loadGitStatus(dir);
  }, 500);
}
