import {
  Show,
  createSignal,
  createMemo,
  createEffect,
  on,
  onMount,
  onCleanup,
} from "solid-js";
import { ContentCode } from "./share/content-code";
import { ContentDiff } from "./share/content-diff";
import { FileSearchBar } from "./FileSearchBar";
import { Spinner } from "./Spinner";
import {
  fileStore,
  loadDiff,
  saveTabScroll,
  getFileGitStatus,
} from "../stores/file";
import { useI18n } from "../lib/i18n";

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", rs: "rust", go: "go", java: "java",
  rb: "ruby", php: "php", cs: "csharp", kt: "kotlin", swift: "swift",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp",
  html: "html", css: "css", scss: "scss",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  md: "markdown", sql: "sql", graphql: "graphql",
  sh: "bash", bash: "bash", zsh: "bash",
  xml: "xml", svg: "xml",
  dockerfile: "dockerfile",
  ps1: "powershell", bat: "bat", cmd: "bat",
  ini: "ini", conf: "ini",
};

function getLangFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower === "dockerfile" || lower === "containerfile") return "dockerfile";
  if (lower === "makefile") return "bash";
  const ext = lower.split(".").pop() || "";
  return EXT_TO_LANG[ext] || "plaintext";
}

// ---------------------------------------------------------------------------
// ImagePreview sub-component
// ---------------------------------------------------------------------------

function ImagePreview(props: { mimeType: string; data: string; name: string }) {
  const { t } = useI18n();
  const [zoom, setZoom] = createSignal(1);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [dragging, setDragging] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [dragStart, setDragStart] = createSignal({ x: 0, y: 0 });
  const [naturalSize, setNaturalSize] = createSignal<{
    w: number;
    h: number;
  } | null>(null);

  let containerRef: HTMLDivElement | undefined;

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom((z) => Math.max(0.1, Math.min(5, z + delta)));
  }

  function handlePointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (e.currentTarget instanceof HTMLElement) e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    setDragStart({ x: e.clientX - pan().x, y: e.clientY - pan().y });
  }

  function handlePointerMove(e: PointerEvent) {
    if (!dragging()) return;
    setPan({ x: e.clientX - dragStart().x, y: e.clientY - dragStart().y });
  }

  function handlePointerUp() {
    setDragging(false);
  }

  function fitToWindow() {
    if (!containerRef || !naturalSize()) return;
    const ns = naturalSize()!;
    const rect = containerRef.getBoundingClientRect();
    const scale = Math.min(rect.width / ns.w, rect.height / ns.h, 1);
    setZoom(scale);
    setPan({ x: 0, y: 0 });
  }

  createEffect(on(() => props.data, () => {
    setNaturalSize(null);
    setFailed(false);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }));

  const controlClass = "min-w-8 min-h-8 px-2 rounded hover:bg-[var(--conversation-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--conversation-focus)] [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";

  function handleImageKeyDown(event: KeyboardEvent) {
    const moves: Record<string, { x: number; y: number }> = {
      ArrowLeft: { x: 24, y: 0 }, ArrowRight: { x: -24, y: 0 },
      ArrowUp: { x: 0, y: 24 }, ArrowDown: { x: 0, y: -24 },
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    setPan((position) => ({ x: position.x + move.x, y: position.y + move.y }));
  }

  return (
    <div class="flex flex-col h-full min-h-64">
      {/* Toolbar */}
      <div class="flex flex-wrap items-center gap-1 px-2 py-1 border-b border-[var(--conversation-border)] text-xs text-[var(--conversation-muted)]">
        <button
          type="button"
          class={controlClass}
          onClick={() => setZoom((z) => Math.min(5, z * 1.25))}
          title={t().fileExplorer.imageZoomIn}
          aria-label={t().fileExplorer.imageZoomIn}
        >
          +
        </button>
        <button
          type="button"
          class={controlClass}
          onClick={() => setZoom((z) => Math.max(0.1, z * 0.8))}
          title={t().fileExplorer.imageZoomOut}
          aria-label={t().fileExplorer.imageZoomOut}
        >
          −
        </button>
        <button
          type="button"
          class={controlClass}
          onClick={fitToWindow}
          title={t().fileExplorer.imageFitToWindow}
          aria-label={t().fileExplorer.imageFitToWindow}
        >
          ⊡
        </button>
        <button
          type="button"
          class={controlClass}
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          title={t().fileExplorer.imageResetZoom}
          aria-label={t().fileExplorer.imageResetZoom}
        >
          1:1
        </button>
        <span class="ml-2 tabular-nums">
          {Math.round(zoom() * 100)}%
        </span>
        <Show when={naturalSize()}>
          <span class="ml-2 tabular-nums text-[var(--conversation-subtle)]">
            {naturalSize()!.w} × {naturalSize()!.h}
          </span>
        </Show>
      </div>

      {/* Image area */}
      <div
        ref={containerRef}
        class="relative flex-1 min-h-0 overflow-hidden cursor-grab active:cursor-grabbing touch-none"
        tabIndex={0}
        role="region"
        aria-label={props.name}
        aria-busy={!naturalSize() && !failed()}
        style={{
          background:
            "repeating-conic-gradient(var(--conversation-surface) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px",
        }}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={handlePointerUp}
        onKeyDown={handleImageKeyDown}
      >
        <div
          class="w-full h-full flex items-center justify-center"
          style={{
            transform: `translate(${pan().x}px, ${pan().y}px) scale(${zoom()})`,
            "transform-origin": "center center",
          }}
        >
          <img
            src={`data:${props.mimeType};base64,${props.data}`}
            loading="lazy"
            alt={props.name}
            draggable={false}
            class="max-w-none"
            classList={{ invisible: !naturalSize() || failed() }}
            onError={() => setFailed(true)}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
          />
        </div>
        <Show when={!naturalSize() || failed()}>
          <div class="absolute inset-0 flex items-center justify-center p-4 text-sm text-[var(--conversation-muted)]" role="status">
            {failed() ? t().markdown.imageUnavailable : t().common.loading}
          </div>
        </Show>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilePreview
// ---------------------------------------------------------------------------

export function FilePreview() {
  const { t } = useI18n();
  const [viewMode, setViewMode] = createSignal<"content" | "diff">("content");
  const [showSearch, setShowSearch] = createSignal(false);
  let scrollRef: HTMLDivElement | undefined;
  let appliedLineRequest: number | undefined;

  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
  });

  const preview = createMemo(() => fileStore.preview);
  const lang = createMemo(() =>
    preview()?.name ? getLangFromFilename(preview()!.name) : "plaintext",
  );

  const hasGitChanges = createMemo(() => {
    const p = preview();
    if (!p) return false;
    return !!getFileGitStatus(p.path);
  });

  // Reset view mode and close search when switching files
  createEffect(
    on(
      () => preview()?.path,
      (newPath) => {
        // Close search bar when file changes
        setShowSearch(false);

        // Determine view mode: diff for changed files opened from Changes tab
        if (newPath && fileStore.activeTab === "changes" && getFileGitStatus(newPath)) {
          setViewMode("diff");
        } else {
          setViewMode("content");
        }
      },
    ),
  );

  // Load diff when viewMode changes to "diff" or when preview path changes while in diff mode
  createEffect(() => {
    const mode = viewMode();
    const p = preview();
    const rootDir = fileStore.rootDirectory;
    if (mode === "diff" && rootDir && p && !p.diff && !p.loading) {
      loadDiff(rootDir, p.path);
    }
  });

  // Restore scroll position when switching tabs
  createEffect(
    on(
      () => fileStore.openTabs.active,
      (activePath) => {
        if (!activePath || !scrollRef) return;
        const tab = fileStore.openTabs.all.find((t) => t.path === activePath);
        if (tab?.scrollTop !== undefined) {
          requestAnimationFrame(() => {
            if (scrollRef) scrollRef.scrollTop = tab.scrollTop!;
          });
        }
      },
    ),
  );

  function handleScroll(e: Event) {
    const target = e.currentTarget as HTMLDivElement;
    const p = preview();
    if (p) {
      saveTabScroll(p.path, target.scrollTop, target.scrollLeft);
    }
  }

  // Syntax highlighting arrives asynchronously, so wait for the requested line.
  createEffect(() => {
    const current = preview();
    if (!scrollRef || !current?.lineRequestId || current.lineRequestId === appliedLineRequest
      || !current.line || current.loading || current.error || current.content?.binary) return;
    appliedLineRequest = current.lineRequestId;
    setViewMode("content");
    const container = scrollRef;
    const lineNumber = current.line;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = () => {
      finished = true;
      observer.disconnect();
      resizeObserver.disconnect();
      if (settleTimer) clearTimeout(settleTimer);
    };
    const jump = () => {
      if (finished) return;
      const lines = container.querySelectorAll<HTMLElement>(".line");
      if (!lines.length) return;
      const line = lines[Math.min(lineNumber, lines.length) - 1];
      const delta = line.getBoundingClientRect().top - container.getBoundingClientRect().top;
      if (Math.abs(delta) > 1) container.scrollTop += delta;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, 150);
    };
    const observer = new MutationObserver(jump);
    // The preview width animates when the first tab opens; wrapped line heights
    // may change after highlighting without another DOM mutation.
    const resizeObserver = new ResizeObserver(jump);
    observer.observe(container, { childList: true, subtree: true });
    resizeObserver.observe(container);
    container.addEventListener("wheel", finish, { passive: true });
    container.addEventListener("touchstart", finish, { passive: true });
    container.addEventListener("pointerdown", finish);
    const frame = requestAnimationFrame(jump);
    onCleanup(() => {
      finish();
      cancelAnimationFrame(frame);
      container.removeEventListener("wheel", finish);
      container.removeEventListener("touchstart", finish);
      container.removeEventListener("pointerdown", finish);
    });
  });

  return (
    <Show when={preview()}>
      {(prev) => (
        <div class="conversation flex flex-col h-full min-w-0">
          {/* Slim info bar: path + content/diff toggle */}
          <div class="flex items-start justify-between gap-2 px-3 py-1.5 border-b border-[var(--conversation-border)] bg-[var(--conversation-surface)] shrink-0 min-h-10">
            <span class="min-w-0 py-1 text-xs font-mono text-[var(--conversation-muted)] [overflow-wrap:anywhere]" title={prev().path}>
              {prev().path}
              <Show when={prev().line}>:{prev().line}</Show>
            </span>

            <Show when={hasGitChanges()}>
              <div class="flex rounded-md border border-[var(--conversation-border)] text-xs shrink-0">
                <button
                  type="button"
                  aria-pressed={viewMode() === "content"}
                  class={`min-h-8 px-2 rounded-l-md [@media(pointer:coarse)]:min-h-11 ${
                    viewMode() === "content"
                      ? "bg-[var(--conversation-bg)] text-[var(--conversation-text)]"
                      : "text-[var(--conversation-muted)] hover:bg-[var(--conversation-hover)]"
                  }`}
                  onClick={() => setViewMode("content")}
                >
                  {t().fileExplorer.content}
                </button>
                <button
                  type="button"
                  aria-pressed={viewMode() === "diff"}
                  class={`min-h-8 px-2 rounded-r-md [@media(pointer:coarse)]:min-h-11 ${
                    viewMode() === "diff"
                      ? "bg-[var(--conversation-bg)] text-[var(--conversation-text)]"
                      : "text-[var(--conversation-muted)] hover:bg-[var(--conversation-hover)]"
                  }`}
                  onClick={() => setViewMode("diff")}
                >
                  {t().fileExplorer.diff}
                </button>
              </div>
            </Show>
          </div>

          {/* Search bar */}
          <Show when={showSearch() && preview()?.content && !preview()!.content!.binary}>
            <FileSearchBar
              content={preview()!.content!.content}
              scrollContainer={scrollRef}
              onClose={() => setShowSearch(false)}
            />
          </Show>

          {/* Content */}
          <div
            ref={scrollRef}
            class="flex-1 min-h-0 min-w-0 overflow-auto"
            data-preview-mode={viewMode()}
            tabIndex={0}
            role="region"
            aria-label={prev().path}
            onScroll={handleScroll}
          >
            <Show when={prev().loading}>
              <div class="flex items-center justify-center gap-2 h-full min-h-48 text-sm text-[var(--conversation-muted)]" role="status">
                <Spinner size="medium" />
                {t().common.loading}
              </div>
            </Show>

            <Show when={prev().error}>
              <div class="m-3 rounded-lg border border-red-200 dark:border-red-900/60 p-3 text-sm [overflow-wrap:anywhere]" role="alert">
                <p class="mb-1 font-medium text-red-700 dark:text-red-300">{t().common.error}</p>
                <p class="text-[var(--conversation-muted)]">{prev().error}</p>
              </div>
            </Show>

            <Show when={!prev().loading && !prev().error && prev().content}>
              {(content) => (
                <>
                  {/* Image preview */}
                  <Show
                    when={
                      content().binary &&
                      content().mimeType?.startsWith("image/")
                    }
                  >
                    <ImagePreview
                      mimeType={content().mimeType!}
                      data={content().content}
                      name={prev().name}
                    />
                  </Show>

                  {/* Binary (non-image) */}
                  <Show
                    when={
                      content().binary &&
                      !content().mimeType?.startsWith("image/")
                    }
                  >
                    <div class="flex items-center justify-center h-full min-h-48 p-4 text-[var(--conversation-muted)] text-sm" role="status">
                      {t().fileExplorer.binaryFile}
                    </div>
                  </Show>

                  {/* Text content or diff */}
                  <Show when={!content().binary}>
                    <Show
                      when={viewMode() === "diff" && prev().diff}
                      fallback={
                        <ContentCode
                          code={content().content}
                          lang={lang()}
                          showLineNumbers={true}
                          transparentBg={true}
                          flush={true}
                        />
                      }
                    >
                      <ContentDiff diff={prev().diff!} />
                    </Show>
                  </Show>
                </>
              )}
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}
