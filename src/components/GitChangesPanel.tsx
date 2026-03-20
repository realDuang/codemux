/**
 * GitChangesPanel — Right sidebar showing file changes for the current session.
 *
 * Two views:
 *   1. File list — shows changed files with status badges
 *   2. Diff view — drill-down into a single file's diff with Shiki syntax highlighting
 *
 * Data source: backend `session.fileChanges` endpoint that extracts write/edit
 * ToolPart metadata from .steps.json — lightweight, no full step loading.
 */

import {
  createSignal,
  createResource,
  Show,
  For,
  createMemo,
} from "solid-js";
import { useI18n } from "../lib/i18n";
import { gateway } from "../lib/gateway-api";
import { resolveLang } from "../lib/shiki-highlighter";
import { ContentDiff } from "./share/content-diff";
import type { SessionFileChange } from "../types/unified";
import styles from "./GitChangesPanel.module.css";

const STATUS_LETTERS: Record<string, string> = {
  created: "A",
  modified: "M",
};

interface GitChangesPanelProps {
  /** Current session ID */
  sessionId: string | null;
  /** Whether the AI is currently streaming */
  isWorking: boolean;
  /** Whether the panel is collapsed */
  collapsed: boolean;
  /** Callback to toggle collapsed state */
  onToggleCollapse: () => void;
}

export function GitChangesPanel(props: GitChangesPanelProps) {
  const { t } = useI18n();
  const [selectedFile, setSelectedFile] = createSignal<SessionFileChange | null>(null);

  // Track working→idle transitions to auto-refresh
  let wasWorking = false;
  const [refreshTick, setRefreshTick] = createSignal(0);
  createMemo(() => {
    const working = props.isWorking;
    if (wasWorking && !working) {
      setRefreshTick((c) => c + 1);
    }
    wasWorking = working;
  });

  // Fetch file changes from backend (reads .steps.json, extracts paths+diffs)
  const [fileChanges] = createResource(
    () => {
      const sid = props.sessionId;
      if (!sid) return null;
      const _ = refreshTick(); // reactive dependency for auto-refresh
      return sid;
    },
    async (sessionId) => {
      try {
        return await gateway.getSessionFileChanges(sessionId);
      } catch {
        return [];
      }
    },
  );

  const entries = () => fileChanges() ?? [];

  const handleFileClick = (file: SessionFileChange) => {
    if (file.diff || file.content) {
      setSelectedFile(file);
    }
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
            <FileChangesIcon size={16} />
          </span>
          <Show when={entries().length > 0}>
            <span class={styles.collapsedBadge}>{entries().length}</span>
          </Show>
        </div>
      </div>
    );
  }

  // --- Diff drill-down view ---
  const selected = selectedFile();
  if (selected) {
    const lang = resolveLang(selected.langExt);

    return (
      <div class={styles.root}>
        <div class={styles.diffHeader}>
          <button class={styles.backBtn} onClick={() => setSelectedFile(null)}>
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
            when={selected.diff}
            fallback={
              <Show
                when={selected.content}
                fallback={<div class={styles.emptyState}>{t().gitPanel.noChanges}</div>}
              >
                <ContentDiff
                  diff={`--- /dev/null\n+++ b/${selected.path}\n@@ -0,0 +1,${selected.content!.split("\n").length} @@\n${selected.content!.split("\n").map((l) => `+${l}`).join("\n")}`}
                  language={lang}
                />
              </Show>
            }
          >
            <ContentDiff diff={selected.diff!} language={lang} />
          </Show>
        </div>
      </div>
    );
  }

  // --- File list view ---
  return (
    <div class={styles.root}>
      <div class={styles.header}>
        <span class={styles.headerIcon}>
          <FileChangesIcon size={14} />
        </span>
        <span class={styles.headerTitle}>{t().gitPanel.title}</span>
        <Show when={entries().length > 0}>
          <span class={styles.headerBadge}>{entries().length}</span>
        </Show>
        <div class={styles.headerActions}>
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

      <div class={styles.fileList}>
        <Show
          when={!fileChanges.loading && entries().length > 0}
          fallback={
            <Show when={fileChanges.loading}>
              <div class={styles.emptyState}>{t().gitPanel.loading}</div>
            </Show>
          }
        >
          <For each={entries()}>
            {(file) => (
              <div
                class={styles.fileItem}
                data-clickable={file.diff || file.content ? "" : undefined}
                onClick={() => handleFileClick(file)}
              >
                <span
                  class={styles.statusBadge}
                  data-status={file.status}
                  title={(t().gitPanel as Record<string, string>)[file.status] ?? file.status}
                >
                  {STATUS_LETTERS[file.status] ?? "M"}
                </span>
                <span class={styles.filePath} title={file.path}>
                  <span class={styles.fileDir}>{fileDirectory(file.path)}</span>
                  {fileBasename(file.path)}
                </span>
                <Show when={file.diff || file.content}>
                  <span class={styles.fileStats}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </span>
                </Show>
              </div>
            )}
          </For>
        </Show>
        <Show when={!fileChanges.loading && entries().length === 0}>
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
      </div>
    </div>
  );
}

function FileChangesIcon(props: { size?: number }) {
  const s = props.size ?? 16;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M9 15h6" />
      <path d="M12 12v6" />
    </svg>
  );
}
