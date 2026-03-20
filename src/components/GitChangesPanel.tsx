/**
 * GitChangesPanel — Right sidebar showing git changes for the current session.
 *
 * Two views:
 *   1. File list — shows changed files with status badges and +/-stats
 *   2. Diff view — drill-down into a single file's unified diff with Shiki syntax highlighting
 *
 * Data source:
 *   - Git repo: queries gateway git.status / git.fileDiff
 *   - Non-git: falls back to extracting write/edit tool parts from messages
 */

import {
  createSignal,
  createResource,
  createMemo,
  Show,
  For,
  onCleanup,
} from "solid-js";
import { useI18n, formatMessage } from "../lib/i18n";
import { gateway } from "../lib/gateway-api";
import { extractFileChanges } from "../lib/extract-file-changes";
import { resolveLang } from "../lib/shiki-highlighter";
import { ContentDiff } from "./share/content-diff";
import type {
  GitFileChange,
  GitStatusResponse,
  UnifiedPart,
} from "../types/unified";
import styles from "./GitChangesPanel.module.css";

// --- Status badge labels ---

const STATUS_LETTERS: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  created: "A",
};

// --- Types ---

interface GitChangesPanelProps {
  /** Project directory for the current session */
  directory: string | undefined;
  /** All parts for the current session (used for non-git fallback) */
  sessionParts: UnifiedPart[];
  /** Whether the AI is currently streaming (triggers auto-refresh on finish) */
  isWorking: boolean;
  /** Whether the panel is collapsed */
  collapsed: boolean;
  /** Callback to toggle collapsed state */
  onToggleCollapse: () => void;
}

interface FileEntry {
  path: string;
  status: string;
  oldPath?: string;
  insertions?: number;
  deletions?: number;
  isGit: boolean;
}

// --- Component ---

export function GitChangesPanel(props: GitChangesPanelProps) {
  const { t } = useI18n();
  const [selectedFile, setSelectedFile] = createSignal<FileEntry | null>(null);
  const [refreshCounter, setRefreshCounter] = createSignal(0);
  const [isRefreshing, setIsRefreshing] = createSignal(false);

  // Track working state transitions for auto-refresh
  let wasWorking = false;
  const checkAutoRefresh = () => {
    if (wasWorking && !props.isWorking) {
      setRefreshCounter((c) => c + 1);
    }
    wasWorking = props.isWorking;
  };

  // Use createMemo to trigger the effect reactively
  createMemo(() => {
    const _ = props.isWorking;
    checkAutoRefresh();
  });

  // Fetch git status (or fall back to parts extraction)
  const [statusData] = createResource(
    () => ({
      dir: props.directory,
      counter: refreshCounter(),
    }),
    async ({ dir }) => {
      if (!dir) return { isGitRepo: false, files: [], branch: undefined };

      try {
        const result: GitStatusResponse = await gateway.gitStatus(dir);
        return result;
      } catch {
        return { isGitRepo: false, files: [], branch: undefined };
      }
    },
  );

  // Compute file entries: git data or fallback from parts
  const fileEntries = createMemo<FileEntry[]>(() => {
    const data = statusData();
    if (!data) return [];

    if (data.isGitRepo) {
      return data.files.map((f: GitFileChange) => ({
        path: f.path,
        status: f.status,
        oldPath: f.oldPath,
        insertions: f.insertions,
        deletions: f.deletions,
        isGit: true,
      }));
    }

    // Non-git fallback: extract from tool parts
    const changes = extractFileChanges(props.sessionParts);
    return changes.map((c) => ({
      path: c.path,
      status: c.status,
      isGit: false,
    }));
  });

  // Fetch diff for selected file
  const [diffData] = createResource(
    () => {
      const file = selectedFile();
      return file && props.directory
        ? { dir: props.directory, file }
        : null;
    },
    async ({ dir, file }) => {
      if (!file.isGit) return { diff: "", language: "" };
      try {
        return await gateway.gitFileDiff(dir, file.path);
      } catch {
        return { diff: "", language: "" };
      }
    },
  );

  const handleRefresh = () => {
    setIsRefreshing(true);
    setRefreshCounter((c) => c + 1);
    // Clear spinning state after resource resolves
    setTimeout(() => setIsRefreshing(false), 600);
  };

  const handleFileClick = (file: FileEntry) => {
    if (file.status === "deleted" && !file.isGit) return;
    setSelectedFile(file);
  };

  const handleBack = () => {
    setSelectedFile(null);
  };

  const fileBasename = (path: string) => {
    const parts = path.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1];
  };

  const fileDirectory = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    return lastSlash > 0 ? normalized.slice(0, lastSlash + 1) : "";
  };

  // --- Collapsed view ---
  if (props.collapsed) {
    return (
      <div
        class={`${styles.root} ${styles.collapsed}`}
        onClick={props.onToggleCollapse}
        title={t().gitPanel.expand}
      >
        <div class={styles.collapsedContent}>
          <span class={styles.collapsedIcon}>
            <GitBranchIcon size={16} />
          </span>
          <Show when={fileEntries().length > 0}>
            <span class={styles.collapsedBadge}>{fileEntries().length}</span>
          </Show>
        </div>
      </div>
    );
  }

  // --- Diff drill-down view ---
  const selected = selectedFile();
  if (selected) {
    const lang = resolveLang(selected.path.split(".").pop());

    return (
      <div class={styles.root}>
        <div class={styles.diffHeader}>
          <button class={styles.backBtn} onClick={handleBack}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
            {t().gitPanel.back}
          </button>
          <span class={styles.diffFileName} title={selected.path}>
            {fileBasename(selected.path)}
          </span>
        </div>
        <div class={styles.diffContent}>
          <Show
            when={!diffData.loading}
            fallback={<div class={styles.diffLoading}>{t().gitPanel.loading}</div>}
          >
            <Show
              when={diffData()?.diff}
              fallback={
                <div class={styles.emptyState}>
                  {t().gitPanel.noChanges}
                </div>
              }
            >
              <ContentDiff diff={diffData()!.diff} language={lang} />
            </Show>
          </Show>
        </div>
      </div>
    );
  }

  // --- File list view ---
  return (
    <div class={styles.root}>
      {/* Header */}
      <div class={styles.header}>
        <span class={styles.headerIcon}>
          <GitBranchIcon size={14} />
        </span>
        <span class={styles.headerTitle}>{t().gitPanel.title}</span>
        <Show when={fileEntries().length > 0}>
          <span class={styles.headerBadge}>{fileEntries().length}</span>
        </Show>
        <div class={styles.headerActions}>
          <button
            class={styles.iconBtn}
            onClick={handleRefresh}
            title={t().gitPanel.refresh}
          >
            <svg
              class={isRefreshing() ? styles.spinning : ""}
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 16h5v5" />
            </svg>
          </button>
          <button
            class={styles.iconBtn}
            onClick={props.onToggleCollapse}
            title={t().gitPanel.collapse}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </div>
      </div>

      {/* Branch info */}
      <Show when={statusData()?.branch}>
        <div class={styles.branchInfo}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          {statusData()!.branch}
        </div>
      </Show>

      {/* Non-git notice */}
      <Show when={statusData() && !statusData()!.isGitRepo && fileEntries().length > 0}>
        <div class={styles.branchInfo}>
          {t().gitPanel.notGitRepo}
        </div>
      </Show>

      {/* File list */}
      <div class={styles.fileList}>
        <Show
          when={fileEntries().length > 0}
          fallback={
            <Show when={!statusData.loading}>
              <div class={styles.emptyState}>
                <span class={styles.emptyIcon}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
                    <circle cx="12" cy="12" r="10" />
                    <path d="m9 12 2 2 4-4" />
                  </svg>
                </span>
                {t().gitPanel.noChanges}
              </div>
            </Show>
          }
        >
          <For each={fileEntries()}>
            {(file) => (
              <div
                class={styles.fileItem}
                onClick={() => handleFileClick(file)}
              >
                <span
                  class={styles.statusBadge}
                  data-status={file.status}
                  title={
                    (t().gitPanel as Record<string, string>)[file.status] ??
                    file.status
                  }
                >
                  {STATUS_LETTERS[file.status] ?? "?"}
                </span>
                <span class={styles.filePath} title={file.path}>
                  <span class={styles.fileDir}>{fileDirectory(file.path)}</span>
                  {fileBasename(file.path)}
                </span>
                <Show when={file.insertions != null || file.deletions != null}>
                  <span class={styles.fileStats}>
                    <Show when={file.insertions != null && file.insertions > 0}>
                      <span class={styles.statAdd}>+{file.insertions}</span>
                    </Show>
                    <Show when={file.deletions != null && file.deletions > 0}>
                      <span class={styles.statDel}>-{file.deletions}</span>
                    </Show>
                  </span>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

// --- Inline icon components ---

function GitBranchIcon(props: { size?: number }) {
  const s = props.size ?? 16;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}
