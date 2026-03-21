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
import { Spinner } from "./Spinner";
import {
  fileStore,
  setFileStore,
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

function ImagePreview(props: { mimeType: string; data: string }) {
  const { t } = useI18n();
  const [zoom, setZoom] = createSignal(1);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [dragging, setDragging] = createSignal(false);
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

  function handleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    setDragging(true);
    setDragStart({ x: e.clientX - pan().x, y: e.clientY - pan().y });
  }

  function handleMouseMove(e: MouseEvent) {
    if (!dragging()) return;
    setPan({ x: e.clientX - dragStart().x, y: e.clientY - dragStart().y });
  }

  function handleMouseUp() {
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

  onMount(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  });

  onCleanup(() => {
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  });

  return (
    <div class="flex flex-col h-full">
      {/* Toolbar */}
      <div class="flex items-center gap-1 px-3 py-1.5 border-b border-gray-200 dark:border-zinc-700 text-xs">
        <button
          class="px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-zinc-800"
          onClick={() => setZoom((z) => Math.min(5, z * 1.25))}
          title={t().fileExplorer.imageZoomIn}
        >
          +
        </button>
        <button
          class="px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-zinc-800"
          onClick={() => setZoom((z) => Math.max(0.1, z * 0.8))}
          title={t().fileExplorer.imageZoomOut}
        >
          −
        </button>
        <button
          class="px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-zinc-800"
          onClick={fitToWindow}
          title={t().fileExplorer.imageFitToWindow}
        >
          ⊡
        </button>
        <button
          class="px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-zinc-800"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          title={t().fileExplorer.imageResetZoom}
        >
          1:1
        </button>
        <span class="ml-2 text-gray-500 dark:text-zinc-400">
          {Math.round(zoom() * 100)}%
        </span>
        <Show when={naturalSize()}>
          <span class="ml-2 text-gray-400 dark:text-zinc-500">
            {naturalSize()!.w} × {naturalSize()!.h}
          </span>
        </Show>
      </div>

      {/* Image area */}
      <div
        ref={containerRef}
        class="flex-1 overflow-hidden cursor-grab active:cursor-grabbing"
        style={{
          background:
            "repeating-conic-gradient(#e5e7eb 0% 25%, transparent 0% 50%) 0 0 / 16px 16px",
        }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
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
            draggable={false}
            class="max-w-none"
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
          />
        </div>
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
  let scrollRef: HTMLDivElement | undefined;

  const preview = createMemo(() => fileStore.preview);
  const lang = createMemo(() =>
    preview()?.name ? getLangFromFilename(preview()!.name) : "plaintext",
  );

  const hasGitChanges = createMemo(() => {
    const p = preview();
    if (!p) return false;
    return !!getFileGitStatus(p.path);
  });

  // Default to diff view when opened from Changes tab on a file with changes
  createEffect(
    on(
      () => preview()?.path,
      () => {
        if (hasGitChanges() && fileStore.activeTab === "changes") {
          setViewMode("diff");
        } else {
          setViewMode("content");
        }
      },
    ),
  );

  // Load diff when switching to diff mode
  createEffect(
    on(viewMode, (mode) => {
      if (mode === "diff" && fileStore.rootDirectory && preview()) {
        const p = preview()!;
        if (!p.diff) {
          loadDiff(fileStore.rootDirectory!, p.path);
        }
      }
    }),
  );

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

  function handleClose() {
    setFileStore("preview", null);
    setFileStore("openTabs", "active", null);
  }

  return (
    <Show when={preview()}>
      {(prev) => (
        <div class="flex flex-col h-full bg-white dark:bg-zinc-900">
          {/* Header */}
          <div class="flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 dark:border-zinc-700 text-[13px] min-h-[34px] shrink-0">
            <span class="font-semibold text-gray-900 dark:text-zinc-100 truncate">
              {prev().name}
            </span>
            <span class="text-gray-400 dark:text-zinc-500 truncate flex-1 text-xs">
              {prev().path}
            </span>

            <Show when={hasGitChanges()}>
              <div class="flex rounded border border-gray-200 dark:border-zinc-700 overflow-hidden text-xs shrink-0">
                <button
                  class={`px-2 py-0.5 ${
                    viewMode() === "content"
                      ? "bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400"
                      : "text-gray-600 dark:text-zinc-400 hover:bg-gray-50 dark:hover:bg-zinc-800"
                  }`}
                  onClick={() => setViewMode("content")}
                >
                  {t().fileExplorer.content}
                </button>
                <button
                  class={`px-2 py-0.5 ${
                    viewMode() === "diff"
                      ? "bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400"
                      : "text-gray-600 dark:text-zinc-400 hover:bg-gray-50 dark:hover:bg-zinc-800"
                  }`}
                  onClick={() => setViewMode("diff")}
                >
                  {t().fileExplorer.diff}
                </button>
              </div>
            </Show>

            <button
              class="ml-1 p-0.5 rounded text-gray-400 dark:text-zinc-500 hover:text-gray-600 dark:hover:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-800 shrink-0"
              onClick={handleClose}
              title={t().fileExplorer.close}
            >
              <svg
                class="w-4 h-4"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>

          {/* Content */}
          <div
            ref={scrollRef}
            class="flex-1 overflow-auto"
            onScroll={handleScroll}
          >
            <Show when={prev().loading}>
              <div class="flex items-center justify-center h-full">
                <Spinner size="medium" />
              </div>
            </Show>

            <Show when={prev().error}>
              <div class="p-4 text-red-500 text-sm">{prev().error}</div>
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
                    />
                  </Show>

                  {/* Binary (non-image) */}
                  <Show
                    when={
                      content().binary &&
                      !content().mimeType?.startsWith("image/")
                    }
                  >
                    <div class="flex items-center justify-center h-full text-gray-400 dark:text-zinc-500 text-sm">
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
