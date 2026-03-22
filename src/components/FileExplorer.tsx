import {
  Show,
  createMemo,
  createEffect,
  on,
} from "solid-js";
import { FileTree } from "./FileTree";
import { FileTabs } from "./FileTabs";
import { FilePreview } from "./FilePreview";
import { Spinner } from "./Spinner";
import {
  fileStore,
  setFileStore,
  setActiveFileTab,
  setRootDirectory,
  closePanel,
  setSearchQuery,
  loadGitStatus,
} from "../stores/file";
import { sessionStore } from "../stores/session";
import { useI18n } from "../lib/i18n";
import type { FileExplorerNode } from "../types/unified";

export function FileExplorer() {
  const { t } = useI18n();

  // Track current session's directory
  const currentDirectory = createMemo(() => {
    if (!sessionStore.current) return null;
    const session = sessionStore.list.find(
      (s) => s.id === sessionStore.current,
    );
    return session?.directory || null;
  });

  // Load root directory when session changes
  createEffect(
    on(currentDirectory, (dir) => {
      setRootDirectory(dir);
    }),
  );

  // Root nodes from the file store
  const rootNodes = createMemo(
    () => fileStore.directories["."]?.children ?? [],
  );

  // Root directory loading state
  const rootLoading = createMemo(
    () => fileStore.directories["."]?.loading ?? false,
  );

  // Root directory loaded state
  const rootLoaded = createMemo(
    () => fileStore.directories["."]?.loaded ?? false,
  );

  // Changed files set for "Changes" tab filter
  const changedFiles = createMemo(
    () => new Set(fileStore.gitStatus.map((s) => s.path)),
  );

  // Filter nodes by search query (case-insensitive path match)
  function filterNodes(
    nodes: FileExplorerNode[],
    query: string,
  ): FileExplorerNode[] {
    const lowerQuery = query.toLowerCase();
    return nodes.filter((node) => {
      if (node.type === "file") {
        return node.path.toLowerCase().includes(lowerQuery);
      }
      // For directories, keep if name matches or any descendant might match
      return (
        node.path.toLowerCase().includes(lowerQuery) ||
        node.name.toLowerCase().includes(lowerQuery)
      );
    });
  }

  // Displayed nodes: apply search and changes filters
  const displayedNodes = createMemo(() => {
    let nodes = rootNodes();
    const query = fileStore.searchQuery;
    if (query) {
      nodes = filterNodes(nodes, query);
    }
    return nodes;
  });

  // Whether a file is selected for preview (full-panel mode)
  const showPreview = createMemo(
    () => fileStore.preview !== null && fileStore.openTabs.all.length > 0,
  );

  const handleRefresh= () => {
    const dir = currentDirectory();
    if (dir) {
      loadGitStatus(dir);
    }
  };

  return (
    <div class="flex h-full flex-col border-l border-gray-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      {/* Header: show tabs+back when previewing, otherwise Files/Changes tabs */}
      <Show
        when={!showPreview()}
        fallback={
          <div class="flex items-center border-b border-gray-200 bg-gray-50/50 px-1 py-1 dark:border-zinc-800 dark:bg-zinc-900">
            <button
              class="mr-1 flex-shrink-0 rounded p-1 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
              onClick={() => setFileStore("preview", null)}
              title={t().fileExplorer.allFiles}
            >
              <svg
                class="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <div class="flex-1 overflow-x-auto">
              <FileTabs />
            </div>
          </div>
        }
      >
        {/* Normal header */}
        <div class="flex items-center border-b border-gray-200 bg-gray-50/50 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
          <div class="flex flex-1 items-center gap-1">
            <button
              class={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                fileStore.activeTab === "files"
                  ? "bg-white text-gray-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
                  : "text-gray-500 hover:text-gray-700 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
              onClick={() => setActiveFileTab("files")}
            >
              {t().fileExplorer.allFiles}
            </button>
            <button
              class={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                fileStore.activeTab === "changes"
                  ? "bg-white text-gray-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
                  : "text-gray-500 hover:text-gray-700 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
              onClick={() => setActiveFileTab("changes")}
            >
              {t().fileExplorer.changes}
              <Show when={fileStore.gitStatus.length > 0}>
                <span class="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
                  {fileStore.gitStatus.length}
                </span>
              </Show>
            </button>
          </div>
          <div class="flex items-center gap-0.5">
            <button
              class="rounded p-1 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
              onClick={handleRefresh}
              title={t().fileExplorer.refresh}
            >
              <svg
                class="h-3.5 w-3.5"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path d="M13.65 2.35A7.96 7.96 0 0 0 8 0a8 8 0 1 0 8 8h-2a6 6 0 1 1-1.76-4.24L10 6h6V0l-2.35 2.35z" />
              </svg>
            </button>
            <button
              class="rounded p-1 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
              onClick={() => closePanel()}
              title={t().fileExplorer.close}
            >
              <svg
                class="h-3.5 w-3.5"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path d="M12.59 3.41L8 7.99 3.41 3.41 2 4.82l4.59 4.59L2 13.99l1.41 1.41L8 10.82l4.59 4.58 1.41-1.41-4.59-4.58 4.59-4.59-1.41-1.41z" />
              </svg>
            </button>
          </div>
        </div>
      </Show>

      {/* Body: full-panel preview OR search+tree */}
      <Show
        when={!showPreview()}
        fallback={
          <div class="min-h-0 flex-1 overflow-auto">
            <FilePreview />
          </div>
        }
      >
        {/* Search input */}
        <div class="relative border-b border-gray-200 px-2 py-1.5 dark:border-zinc-800">
          <svg
            class="absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400 dark:text-zinc-500"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04-1.06 1.06-3.04-3.04z" />
          </svg>
          <input
            type="text"
            class="w-full rounded bg-gray-100 py-1 pl-7 pr-7 text-xs text-gray-900 placeholder-gray-400 outline-none focus:ring-1 focus:ring-blue-500 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500"
            placeholder={t().fileExplorer.searchPlaceholder}
            value={fileStore.searchQuery}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
          />
          <Show when={fileStore.searchQuery}>
            <button
              class="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:text-zinc-500 dark:hover:text-zinc-300"
              onClick={() => setSearchQuery("")}
            >
              <svg
                class="h-3.5 w-3.5"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path d="M12.59 3.41L8 7.99 3.41 3.41 2 4.82l4.59 4.59L2 13.99l1.41 1.41L8 10.82l4.59 4.58 1.41-1.41-4.59-4.58 4.59-4.59-1.41-1.41z" />
              </svg>
            </button>
          </Show>
        </div>

        {/* File tree */}
        <div class="min-h-0 flex-1 overflow-y-auto">
          <Show
            when={currentDirectory()}
            fallback={
              <div class="flex h-full items-center justify-center p-4 text-xs text-gray-400 dark:text-zinc-500">
                {t().fileExplorer.noProject}
              </div>
            }
          >
            <Show
              when={!rootLoading()}
              fallback={
                <div class="flex h-full items-center justify-center p-4">
                  <Spinner size="small" />
                </div>
              }
            >
              <Show
                when={rootLoaded()}
                fallback={
                  <div class="flex h-full items-center justify-center p-4">
                    <Spinner size="small" />
                  </div>
                }
              >
                <Show
                  when={
                    fileStore.activeTab === "changes"
                      ? changedFiles().size > 0
                      : displayedNodes().length > 0
                  }
                  fallback={
                    <div class="flex h-full items-center justify-center p-4 text-xs text-gray-400 dark:text-zinc-500">
                      {fileStore.activeTab === "changes"
                        ? t().fileExplorer.noChanges
                        : t().fileExplorer.noProject}
                    </div>
                  }
                >
                  <FileTree
                    rootDirectory={currentDirectory()!}
                    nodes={displayedNodes()}
                    filter={
                      fileStore.activeTab === "changes"
                        ? changedFiles()
                        : undefined
                    }
                  />
                </Show>
              </Show>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}
