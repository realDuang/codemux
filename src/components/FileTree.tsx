import { For, Show, createMemo, createEffect } from "solid-js";
import { FileIcon } from "./FileIcon";
import { Spinner } from "./Spinner";
import {
  fileStore,
  toggleDirectory,
  previewFile,
  getFileGitStatus,
  getGitStatusLabel,
  getGitStatusColor,
  dirHasGitChanges,
} from "../stores/file";
import type { FileExplorerNode } from "../types/unified";

const MAX_DEPTH = 128;

// ---------------------------------------------------------------------------
// FileTree — recursive list of FileTreeNode
// ---------------------------------------------------------------------------

interface FileTreeProps {
  rootDirectory: string;
  nodes: FileExplorerNode[];
  level?: number;
  /** When set, only show files in this set (for "Changes" tab) */
  filter?: Set<string>;
}

export function FileTree(props: FileTreeProps) {
  const level = () => props.level ?? 0;

  const visibleNodes = createMemo(() => {
    if (!props.filter) return props.nodes;

    return props.nodes.filter((node) => {
      if (node.type === "file") return props.filter!.has(node.path);
      // Keep directories that are ancestors of any filtered file
      const prefix = node.path.endsWith("/") ? node.path : node.path + "/";
      for (const p of props.filter!) {
        if (p.startsWith(prefix)) return true;
      }
      return false;
    });
  });

  return (
    <Show when={level() < MAX_DEPTH}>
      <For each={visibleNodes()}>
        {(node) => (
          <FileTreeNode
            rootDirectory={props.rootDirectory}
            node={node}
            level={level()}
            filter={props.filter}
          />
        )}
      </For>
    </Show>
  );
}

// ---------------------------------------------------------------------------
// FileTreeNode — single node (file or directory)
// ---------------------------------------------------------------------------

interface FileTreeNodeProps {
  rootDirectory: string;
  node: FileExplorerNode;
  level: number;
  filter?: Set<string>;
}

function FileTreeNode(props: FileTreeNodeProps) {
  const isDir = () => props.node.type === "directory";
  const dirState = () => fileStore.directories[props.node.path];
  const isExpanded = () => dirState()?.expanded ?? false;
  const isLoading = () => dirState()?.loading ?? false;

  const isActive = () => fileStore.preview?.path === props.node.path;

  const status = createMemo(() => getFileGitStatus(props.node.path));

  // For directories: O(1) check via precomputed map
  const hasChanges = () => isDir() && dirHasGitChanges(props.node.path);

  const dirDotColor = () => {
    if (!hasChanges()) return "";
    return "bg-yellow-500"; // simplified — directory dot is always yellow (mixed changes)
  };

  const paddingLeft = () => `${8 + props.level * 16}px`;

  // Auto-expand directories when filter is active
  const shouldAutoExpand = createMemo(() => {
    if (!props.filter || !isDir()) return false;
    const prefix = props.node.path.endsWith("/")
      ? props.node.path
      : props.node.path + "/";
    for (const p of props.filter!) {
      if (p.startsWith(prefix)) return true;
    }
    return false;
  });

  // Trigger auto-expand via effect
  createEffect(() => {
    if (shouldAutoExpand() && !isExpanded() && !isLoading()) {
      toggleDirectory(props.rootDirectory, props.node.path);
    }
  });

  function handleClick() {
    if (isDir()) {
      toggleDirectory(props.rootDirectory, props.node.path);
    } else {
      previewFile(props.node.absolutePath, props.node.name, props.node.path);
    }
  }

  return (
    <div class="group">
      <button
        class={`w-full flex items-center gap-1 py-[3px] rounded-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-800 ${
          isActive() ? "bg-blue-100 dark:bg-blue-900/40" : ""
        } ${props.node.ignored ? "opacity-50" : ""}`}
        style={{ "padding-left": paddingLeft(), "font-size": "13px" }}
        onClick={handleClick}
        title={props.node.path}
      >
        {/* Chevron or spacer */}
        <Show
          when={isDir()}
          fallback={<span class="w-4 h-4 flex-shrink-0" />}
        >
          <Show
            when={!isLoading()}
            fallback={
              <span class="w-4 h-4 flex-shrink-0 flex items-center justify-center">
                <Spinner size="small" class="w-3 h-3" />
              </span>
            }
          >
            <span
              class="w-4 h-4 flex-shrink-0 flex items-center justify-center"
              style={{
                transition: "transform 0.15s ease",
                transform: isExpanded() ? "rotate(90deg)" : "rotate(0deg)",
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </span>
          </Show>
        </Show>

        {/* File/folder icon */}
        <FileIcon
          name={props.node.name}
          type={props.node.type}
          expanded={isExpanded()}
          dimmed={props.node.ignored}
        />

        {/* Name */}
        <span class="truncate flex-1 text-left">{props.node.name}</span>

        {/* Git status indicators */}
        <Show when={!isDir() && status()}>
          <span class="flex items-center gap-1 mr-2 flex-shrink-0">
            <Show when={status()!.added != null}>
              <span class="text-[10px] text-green-600 dark:text-green-400">
                +{status()!.added}
              </span>
            </Show>
            <Show when={status()!.removed != null}>
              <span class="text-[10px] text-red-600 dark:text-red-400">
                -{status()!.removed}
              </span>
            </Show>
            <span
              class={`text-xs font-medium ${getGitStatusColor(status()!.status)}`}
            >
              {getGitStatusLabel(status()!.status)}
            </span>
          </span>
        </Show>

        {/* Directory dot indicator */}
        <Show when={isDir() && hasChanges()}>
          <span class="flex items-center mr-2 flex-shrink-0">
            <span class={`w-1.5 h-1.5 rounded-full ${dirDotColor()}`} />
          </span>
        </Show>
      </button>

      {/* Nested children for expanded directories */}
      <Show when={isDir() && isExpanded() && dirState()?.children}>
        <FileTree
          rootDirectory={props.rootDirectory}
          nodes={dirState()!.children}
          level={props.level + 1}
          filter={props.filter}
        />
      </Show>
    </div>
  );
}
