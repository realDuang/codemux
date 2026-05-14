import { createSignal, createEffect, onCleanup, For, Show, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import { createStore } from "solid-js/store";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { gateway, gatewayConnected } from "../lib/gateway-api";
import { useI18n, formatMessage } from "../lib/i18n";
import { logger } from "../lib/logger";
import { getNestedSetting } from "../lib/settings";
import { openTab as openFileTab, openPanel as openFilePanel } from "../stores/file";
import type { TerminalActions } from "../stores/terminal";
import type { TerminalProfile } from "../types/unified";
import "@xterm/xterm/css/xterm.css";

export interface TerminalPanelProps {
  /** Active session ID — drives which session's tab list is visible. */
  sessionId: string;
  /** Working directory used when creating new tabs. */
  cwd: string;
  /** Whether the panel is visible (collapsed if false). */
  visible: boolean;
  /** User clicked the close button on the panel header. */
  onClose: () => void;
  /**
   * Receives the panel's imperative API. Called once on mount so the parent
   * (Chat.tsx) can wire keyboard shortcuts (Ctrl+Shift+`, Ctrl+PgUp, etc.)
   * and toggle handlers to the panel.
   */
  onReady?: (actions: TerminalActions) => void;
}

interface TabEntry {
  id: string;
  sessionId: string;
  cwd: string;
  label: string;
  exited: boolean;
  /** Profile ID used to spawn this tab. `undefined` = server default. */
  profileId?: string;
}

interface TabInstance {
  xterm: XTerm;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  /** WebGL / Canvas renderer addon — kept so we can dispose on tab close. */
  rendererAddon: WebglAddon | CanvasAddon | null;
  /** File-link provider registration handle; disposed on tab close. */
  linkProvider: { dispose: () => void } | null;
  /** PTY ID assigned by the gateway, set after async create completes. */
  terminalId: string | null;
  /** Pending writes queued before the PTY ID is known. */
  pendingWrites: string[];
  cleanupData: (() => void) | null;
  cleanupExit: (() => void) | null;
  resizeTimer: ReturnType<typeof setTimeout> | null;
  resizeObserver: ResizeObserver;
  themeObserver: MutationObserver;
}

type GpuMode = "auto" | "canvas" | "dom";

const isDarkTheme = () => document.documentElement.classList.contains("dark");

const buildXtermTheme = () =>
  isDarkTheme()
    ? {
        background: "#0f172a",
        foreground: "#e2e8f0",
        cursor: "#e2e8f0",
        selectionBackground: "#334155",
      }
    : {
        background: "#ffffff",
        foreground: "#1e293b",
        cursor: "#1e293b",
        selectionBackground: "#cbd5e1",
      };

function getGpuMode(): GpuMode {
  const v = getNestedSetting<string>("terminal.gpuAcceleration");
  if (v === "canvas" || v === "dom") return v;
  return "auto";
}

// ---- File-path link detection -------------------------------------------
// Matches likely file paths in terminal output (e.g. `src/foo.ts`,
// `/Users/x/y.txt`, `C:\foo\bar.txt`). Skips bare URLs (handled by
// WebLinksAddon).
//
// Tuned to require either a path separator (`/` / `\`) OR a dot extension,
// so common false positives like bare command names ("ls") aren't matched.
const FILE_PATH_REGEX =
  /(?:^|[\s"'`(<[])((?:~|\.{1,2}|[A-Za-z]:|\/)?[\w./\-+@\\][\w./\-+@\\]*\.[A-Za-z0-9]{1,8}|[A-Za-z]:[\\/][\w./\-+@\\]+|\/[\w./\-+@\\][\w./\-+@\\]*)/g;

interface PathMatch {
  text: string;
  start: number;
  end: number;
}

function extractFilePathMatches(line: string): PathMatch[] {
  const out: PathMatch[] = [];
  let m: RegExpExecArray | null;
  FILE_PATH_REGEX.lastIndex = 0;
  while ((m = FILE_PATH_REGEX.exec(line)) !== null) {
    const captured = m[1];
    const start = m.index + m[0].indexOf(captured);
    out.push({ text: captured, start, end: start + captured.length });
  }
  return out;
}

/**
 * Attach a renderer to an xterm instance with VS Code-style 3-tier fallback:
 * WebGL (auto only) → Canvas → DOM (default — no addon needed).
 *
 * On WebGL context loss (GPU reset, tab backgrounding, etc.) the addon is
 * disposed and a Canvas addon is loaded in its place — no further fallback
 * because Canvas doesn't have an equivalent "context loss" failure mode.
 */
function attachRenderer(xterm: XTerm, mode: GpuMode): WebglAddon | CanvasAddon | null {
  if (mode === "dom") return null;

  if (mode === "auto") {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        logger.warn("[Terminal] WebGL context lost; falling back to Canvas renderer");
        try { webgl.dispose(); } catch { /* ignore */ }
        try {
          const canvas = new CanvasAddon();
          xterm.loadAddon(canvas);
        } catch (err) {
          logger.warn("[Terminal] Canvas fallback also failed; using DOM renderer:", err);
        }
      });
      xterm.loadAddon(webgl);
      return webgl;
    } catch (err) {
      logger.warn("[Terminal] WebGL renderer unavailable, trying Canvas:", err);
    }
  }

  try {
    const canvas = new CanvasAddon();
    xterm.loadAddon(canvas);
    return canvas;
  } catch (err) {
    logger.warn("[Terminal] Canvas renderer unavailable; using DOM renderer:", err);
    return null;
  }
}

export function TerminalPanel(props: TerminalPanelProps) {
  const { t } = useI18n();

  // Flat list of all tabs across all sessions. Tabs stay mounted in the DOM
  // so PTY data keeps streaming visibly even when switching sessions.
  // The server-side PTYs are the source of truth — this is just a UI mirror.
  const [allTabs, setAllTabs] = createSignal<TabEntry[]>([]);
  // Per-session active tab id (so each session remembers its own selection).
  const [activeTabBySession, setActiveTabBySession] = createStore<Record<string, string>>({});
  // Per-session counter so new tab labels start at 1 within each session.
  const tabCounterBySession: Record<string, number> = {};

  // Live xterm/PTY instances keyed by tabId. Not reactive — accessed imperatively.
  const instances = new Map<string, TabInstance>();

  function ensureFirstTab(sessionId: string) {
    if (allTabs().some((t) => t.sessionId === sessionId)) return;
    addTab(sessionId);
  }

  function closeActiveTab(sessionId: string) {
    const id = activeTabBySession[sessionId];
    if (!id) return;
    closeTab(id);
  }

  function switchTab(sessionId: string, dir: 1 | -1) {
    const tabs = allTabs().filter((t) => t.sessionId === sessionId);
    if (tabs.length < 2) return;
    const active = activeTabBySession[sessionId];
    const idx = tabs.findIndex((t) => t.id === active);
    if (idx < 0) return;
    const nextIdx = (idx + dir + tabs.length) % tabs.length;
    const nextId = tabs[nextIdx].id;
    setActiveTabBySession(sessionId, nextId);
    requestAnimationFrame(() => fitTab(nextId));
  }

  // Expose the imperative API to the parent inside an effect so the parent's
  // ref-callback runs after mount (and re-runs if `props.onReady` changes).
  createEffect(() => {
    props.onReady?.({
      ensureFirstTab,
      newTab: (sid) => addTab(sid),
      closeActiveTab,
      switchTab,
    });
  });

  const currentTabs = () => allTabs().filter((tab) => tab.sessionId === props.sessionId);
  const currentActiveTab = () => activeTabBySession[props.sessionId] ?? "";

  // ---- Profile dropdown state ---------------------------------------------
  const [profiles, setProfiles] = createSignal<TerminalProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = createSignal<string | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = createSignal(false);

  async function refreshProfiles() {
    if (!gatewayConnected()) return;
    try {
      const res = await gateway.listTerminalProfiles();
      setProfiles(res.profiles);
      setDefaultProfileId(res.defaultProfileId);
    } catch (err) {
      logger.warn("[Terminal] listTerminalProfiles failed:", err);
    }
  }

  // Lazy-load profiles when the panel first becomes visible. Tracks
  // `gatewayConnected()` so the fetch retries automatically once the gateway
  // reconnects after a transient drop — otherwise the dropdown would stay
  // empty until the user manually re-opens the panel.
  createEffect(() => {
    if (props.visible && gatewayConnected() && profiles().length === 0) {
      void refreshProfiles();
    }
  });

  // Click-outside handler for the profile menu.
  let profileMenuRef: HTMLDivElement | undefined;
  let profileChevronRef: HTMLButtonElement | undefined;
  let profilePortalRef: HTMLDivElement | undefined;
  const [profileMenuPos, setProfileMenuPos] = createSignal<{ left: number; top: number } | null>(
    null,
  );

  function recomputeProfileMenuPos() {
    if (!profileChevronRef) return;
    const rect = profileChevronRef.getBoundingClientRect();
    // Anchor the dropdown's left edge to the start of the [+] button group
    // (slight offset so the menu doesn't shift when the chevron's width
    // changes), and its top edge directly under the chevron.
    setProfileMenuPos({ left: rect.left, top: rect.bottom + 2 });
  }

  const handleDocClick = (e: MouseEvent) => {
    if (!profileMenuOpen()) return;
    const target = e.target as Node;
    const insideAnchor = profileMenuRef?.contains(target) ?? false;
    const insidePortal = profilePortalRef?.contains(target) ?? false;
    if (!insideAnchor && !insidePortal) {
      setProfileMenuOpen(false);
    }
  };
  document.addEventListener("mousedown", handleDocClick);
  onCleanup(() => document.removeEventListener("mousedown", handleDocClick));

  // Recompute portal position on resize / scroll while the menu is open.
  const handleViewportChange = () => {
    if (profileMenuOpen()) recomputeProfileMenuPos();
  };
  window.addEventListener("resize", handleViewportChange);
  window.addEventListener("scroll", handleViewportChange, true);
  onCleanup(() => {
    window.removeEventListener("resize", handleViewportChange);
    window.removeEventListener("scroll", handleViewportChange, true);
  });

  // ---- Search state (Ctrl+F overlay) -------------------------------------
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchOpts, setSearchOpts] = createStore({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [searchMatch, setSearchMatch] = createSignal<{
    resultIndex: number;
    resultCount: number;
  } | null>(null);
  let searchInputRef: HTMLInputElement | undefined;

  function getActiveInstance(): TabInstance | null {
    const id = currentActiveTab();
    return id ? instances.get(id) ?? null : null;
  }

  function searchDecorations() {
    const dark = isDarkTheme();
    return {
      matchBackground: dark ? "#3b3b00" : "#fff3a3",
      matchOverviewRuler: dark ? "#fef08a" : "#ca8a04",
      activeMatchBackground: dark ? "#7c5b00" : "#ffcb6b",
      activeMatchColorOverviewRuler: dark ? "#facc15" : "#a16207",
    };
  }

  function openSearch() {
    setSearchOpen(true);
    queueMicrotask(() => searchInputRef?.focus());
  }

  function closeSearch() {
    const inst = getActiveInstance();
    inst?.searchAddon.clearDecorations();
    setSearchOpen(false);
    setSearchMatch(null);
    inst?.xterm.focus();
  }

  function findNext() {
    const inst = getActiveInstance();
    const q = searchQuery();
    if (!inst || !q) return;
    inst.searchAddon.findNext(q, {
      ...searchOpts,
      decorations: searchDecorations(),
    });
  }

  function findPrev() {
    const inst = getActiveInstance();
    const q = searchQuery();
    if (!inst || !q) return;
    inst.searchAddon.findPrevious(q, {
      ...searchOpts,
      decorations: searchDecorations(),
    });
  }

  // Wire onDidChangeResults when an instance becomes active so the result
  // counter stays in sync. We re-bind on each active-tab change.
  createEffect(() => {
    const tabId = currentActiveTab();
    if (!tabId) return;
    // Close any stale search overlay when switching tabs/sessions —
    // search state belongs to a single xterm instance. We `untrack` the
    // searchOpen() read so this effect only depends on `currentActiveTab()`;
    // otherwise opening the search overlay would immediately re-run this
    // effect and close itself.
    if (untrack(searchOpen)) closeSearch();
    const inst = instances.get(tabId);
    if (!inst) return;
    const sub = inst.searchAddon.onDidChangeResults((e) => {
      setSearchMatch(e ? { resultIndex: e.resultIndex, resultCount: e.resultCount } : null);
    });
    onCleanup(() => sub.dispose());
  });

  function nextTabLabel(sessionId: string): { id: string; label: string } {
    tabCounterBySession[sessionId] = (tabCounterBySession[sessionId] ?? 0) + 1;
    const n = tabCounterBySession[sessionId];
    return {
      id: `tab-${sessionId}-${n}`,
      label: formatMessage(t().terminal.tabLabel, { n }),
    };
  }

  function addTab(sessionId: string = props.sessionId, profileId?: string) {
    const { id, label } = nextTabLabel(sessionId);
    setAllTabs((prev) => [
      ...prev,
      { id, sessionId, cwd: props.cwd, label, exited: false, profileId },
    ]);
    setActiveTabBySession(sessionId, id);
  }

  function closeTab(tabId: string) {
    const tab = allTabs().find((t) => t.id === tabId);
    if (!tab) return;
    const sid = tab.sessionId;

    const sidTabs = allTabs().filter((t) => t.sessionId === sid);
    const idx = sidTabs.findIndex((t) => t.id === tabId);
    const remaining = sidTabs.filter((t) => t.id !== tabId);
    const nextTab = remaining[Math.min(idx, remaining.length - 1)];

    destroyInstance(tabId);
    setAllTabs((prev) => prev.filter((t) => t.id !== tabId));

    if (remaining.length === 0) {
      delete tabCounterBySession[sid];
      if (sid === props.sessionId) props.onClose();
      return;
    }

    if (activeTabBySession[sid] === tabId && nextTab) {
      setActiveTabBySession(sid, nextTab.id);
      requestAnimationFrame(() => fitTab(nextTab.id));
    }
  }

  function destroyInstance(tabId: string) {
    const inst = instances.get(tabId);
    if (!inst) return;
    inst.cleanupData?.();
    inst.cleanupExit?.();
    if (inst.terminalId) {
      gateway.destroyTerminal(inst.terminalId).catch((err) => {
        logger.warn("[Terminal] destroy failed:", err);
      });
    }
    if (inst.resizeTimer) clearTimeout(inst.resizeTimer);
    inst.resizeObserver.disconnect();
    inst.themeObserver.disconnect();
    try { inst.linkProvider?.dispose(); } catch { /* ignore */ }
    try { inst.rendererAddon?.dispose(); } catch { /* ignore */ }
    inst.xterm.dispose();
    instances.delete(tabId);
  }

  function fitTab(tabId: string) {
    const inst = instances.get(tabId);
    if (!inst) return;
    try {
      inst.fitAddon.fit();
    } catch {
      // fit() can throw if the container isn't laid out yet; safe to skip.
      return;
    }
    if (inst.terminalId) {
      gateway
        .resizeTerminal(inst.terminalId, inst.xterm.cols, inst.xterm.rows)
        .catch((err) => logger.warn("[Terminal] resize failed:", err));
    }
  }

  /**
   * Start the PTY for an already-initialised xterm tab.
   *
   * Split out from `initTab` so it can be retried independently when the
   * gateway reconnects after a disconnect (see the reconnect effect below).
   * Idempotent: bails if the tab no longer exists, or if the PTY has
   * already been created, or if the gateway is still offline.
   */
  async function startPtyForTab(tabId: string, sessionId: string) {
    const inst = instances.get(tabId);
    if (!inst || inst.terminalId) return;
    if (!gatewayConnected()) return;

    const tabEntry = allTabs().find((t) => t.id === tabId);
    const cwd = tabEntry?.cwd ?? props.cwd;
    const profileId = tabEntry?.profileId;

    try {
      const { terminalId } = await gateway.createTerminal({
        cwd,
        cols: inst.xterm.cols,
        rows: inst.xterm.rows,
        sessionId,
        profileId,
      });
      // Tab may have been closed while the create call was pending.
      if (!instances.has(tabId)) {
        gateway.destroyTerminal(terminalId).catch(() => {});
        return;
      }
      inst.terminalId = terminalId;

      inst.cleanupData = gateway.onTerminalData(terminalId, (data) => {
        inst.xterm.write(data);
      });
      inst.cleanupExit = gateway.onTerminalExit(terminalId, () => {
        setAllTabs((prev) =>
          prev.map((tab) => (tab.id === tabId ? { ...tab, exited: true } : tab)),
        );
      });

      // Drain any keystrokes captured before the PTY ID was known.
      if (inst.pendingWrites.length > 0) {
        for (const data of inst.pendingWrites) {
          gateway.writeTerminal(terminalId, data).catch(() => {});
        }
        inst.pendingWrites.length = 0;
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t().terminal.startFailed;
      inst.xterm.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
      logger.error("[Terminal] create failed:", err);
    }
  }

  async function initTab(tabId: string, sessionId: string, el: HTMLDivElement) {
    if (instances.has(tabId)) return;

    const tabEntry = allTabs().find((t) => t.id === tabId);
    // Used by the file-link provider below for resolving relative paths.
    const cwd = tabEntry?.cwd ?? props.cwd;

    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        "'Hack Nerd Font', 'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', 'MesloLGS NF', 'Hack', 'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', monospace",
      theme: buildXtermTheme(),
      allowProposedApi: true,
    });

    // Intercept Ctrl+F before xterm consumes it as terminal input.
    xterm.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        e.code === "KeyF" &&
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        openSearch();
        return false;
      }
      return true;
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);

    // Unicode 11 width tables — fixes CJK / emoji column miscalculation.
    const unicode = new Unicode11Addon();
    xterm.loadAddon(unicode);
    xterm.unicode.activeVersion = "11";

    // URL link detection. Routes through window.open which Electron's
    // window-open handler maps to shell.openExternal; in browsers it opens
    // a new tab. Both behaviours are safe with `noopener,noreferrer`.
    const webLinks = new WebLinksAddon((_event, uri) => {
      window.open(uri, "_blank", "noopener,noreferrer");
    });
    xterm.loadAddon(webLinks);

    const searchAddon = new SearchAddon();
    xterm.loadAddon(searchAddon);

    xterm.open(el);

    // Load renderer AFTER `open()` — WebGL/Canvas need an attached canvas.
    const rendererAddon = attachRenderer(xterm, getGpuMode());

    // ---- File-path link provider ----
    // Scans each visible line for path-looking tokens, asks the gateway to
    // verify they exist, and registers them as clickable links that open the
    // file in CodeMux's built-in file panel. Works identically in Electron
    // and remote browser sessions because everything routes through the
    // gateway's `file.exists` RPC.
    const linkProvider = xterm.registerLinkProvider({
      provideLinks: (lineNumber, callback) => {
        const buf = xterm.buffer.active;
        const lineObj = buf.getLine(lineNumber - 1);
        if (!lineObj) {
          callback(undefined);
          return;
        }
        const text = lineObj.translateToString(true);
        const matches = extractFilePathMatches(text);
        if (matches.length === 0) {
          callback(undefined);
          return;
        }

        Promise.all(
          matches.map(async (m) => {
            try {
              const res = await gateway.checkFileExists(m.text, cwd);
              if (!res.exists || !res.isFile) return null;
              return { match: m, absolutePath: res.absolutePath };
            } catch {
              return null;
            }
          }),
        ).then((results) => {
          const links = results
            .filter((r): r is { match: PathMatch; absolutePath: string } => !!r)
            .map(({ match, absolutePath }) => ({
              range: {
                start: { x: match.start + 1, y: lineNumber },
                end: { x: match.end, y: lineNumber },
              },
              text: match.text,
              activate: () => {
                const name = match.text.split(/[\\/]/).pop() ?? match.text;
                openFileTab(absolutePath, absolutePath, name);
                openFilePanel();
              },
              hover: () => {},
              leave: () => {},
            }));
          callback(links.length > 0 ? links : undefined);
        });
      },
    });

    const themeObserver = new MutationObserver(() => {
      xterm.options.theme = buildXtermTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const inst: TabInstance = {
      xterm,
      fitAddon,
      searchAddon,
      rendererAddon,
      linkProvider,
      terminalId: null,
      pendingWrites: [],
      cleanupData: null,
      cleanupExit: null,
      resizeTimer: null,
      // Placeholder; replaced below once the real ResizeObserver is created.
      resizeObserver: new ResizeObserver(() => {}),
      themeObserver,
    };
    instances.set(tabId, inst);

    const resizeObserver = new ResizeObserver(() => {
      if (inst.resizeTimer) clearTimeout(inst.resizeTimer);
      inst.resizeTimer = setTimeout(() => {
        if (props.visible && activeTabBySession[props.sessionId] === tabId) {
          fitTab(tabId);
        }
        inst.resizeTimer = null;
      }, 50);
    });
    resizeObserver.observe(el);
    inst.resizeObserver = resizeObserver;

    // Forward keystrokes to the PTY. While the PTY is being created, queue
    // writes — otherwise initial keypresses (like Enter to render the prompt)
    // would be silently dropped.
    xterm.onData((data) => {
      if (inst.terminalId) {
        gateway.writeTerminal(inst.terminalId, data).catch((err) => {
          logger.warn("[Terminal] write failed:", err);
        });
      } else {
        inst.pendingWrites.push(data);
      }
    });

    requestAnimationFrame(async () => {
      if (props.visible && activeTabBySession[sessionId] === tabId) {
        try {
          fitAddon.fit();
        } catch {
          // ignore — will fit again on next resize observer tick
        }
      }
      (document.activeElement as HTMLElement | null)?.blur?.();

      if (gatewayConnected()) {
        await startPtyForTab(tabId, sessionId);
      } else {
        // Surface a hint and rely on the reconnect effect to retry once the
        // gateway comes back online; keystrokes are buffered in pendingWrites.
        xterm.write(
          `\r\n\x1b[33m${t().terminal.waitingForGateway}\x1b[0m\r\n`,
        );
      }
    });
  }

  // Retry PTY creation for any tabs that were initialised while the gateway
  // was disconnected (or whose PTY was never created for any other reason).
  // Without this, opening a tab during a transient gateway drop would leave
  // it permanently blank even after reconnect.
  createEffect(() => {
    if (!gatewayConnected()) return;
    for (const [tabId, inst] of instances) {
      if (!inst.terminalId) {
        const tab = allTabs().find((t) => t.id === tabId);
        if (tab) void startPtyForTab(tabId, tab.sessionId);
      }
    }
  });

  // When the panel becomes visible or the active session changes, ensure the
  // active tab is fitted to the current container size.
  createEffect(() => {
    const vis = props.visible;
    const tabId = activeTabBySession[props.sessionId];
    if (!vis || !tabId) return;
    requestAnimationFrame(() => fitTab(tabId));
  });

  onCleanup(() => {
    for (const tabId of [...instances.keys()]) {
      destroyInstance(tabId);
    }
  });

  return (
    <div class="flex flex-col h-full bg-white dark:bg-slate-950 border-t border-gray-200 dark:border-slate-800">
      {/* Tab bar + close panel button */}
      <div class="flex items-stretch bg-gray-50 dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800 flex-shrink-0 overflow-hidden">
        <div
          class="flex items-stretch overflow-x-auto flex-1 min-w-0"
          style={{ "scrollbar-width": "none" }}
        >
          <For each={currentTabs()}>
            {(tab) => (
              <button
                class={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium whitespace-nowrap border-r border-gray-200 dark:border-slate-800 transition-colors flex-shrink-0 ${
                  currentActiveTab() === tab.id
                    ? "bg-white dark:bg-slate-950 text-gray-800 dark:text-gray-200"
                    : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800"
                }`}
                onClick={() => {
                  setActiveTabBySession(props.sessionId, tab.id);
                  requestAnimationFrame(() => fitTab(tab.id));
                }}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="flex-shrink-0 opacity-60"
                >
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" x2="20" y1="19" y2="19" />
                </svg>
                <span>{tab.label}</span>
                <Show when={tab.exited}>
                  <span
                    class="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0"
                    title={t().terminal.exitedBadge}
                  />
                </Show>
                <span
                  role="button"
                  title={t().terminal.closeTab}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  class="ml-0.5 w-4 h-4 flex items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 flex-shrink-0"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </span>
              </button>
            )}
          </For>

          <div class="flex items-stretch flex-shrink-0 relative" ref={(el) => (profileMenuRef = el)}>
            <button
              onClick={() => addTab()}
              class="px-2.5 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors"
              title={t().terminal.newTab}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M5 12h14" />
                <path d="M12 5v14" />
              </svg>
            </button>
            <button
              ref={(el) => (profileChevronRef = el)}
              onClick={() => {
                if (!profileMenuOpen()) {
                  void refreshProfiles();
                  recomputeProfileMenuPos();
                }
                setProfileMenuOpen((v) => !v);
              }}
              class="px-1 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors border-l border-gray-200/60 dark:border-slate-800/60"
              title={t().terminal.profileMenuTitle}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <Show when={profileMenuOpen() && profileMenuPos()}>
              <Portal>
                <div
                  ref={(el) => (profilePortalRef = el)}
                  class="fixed z-[1000] min-w-[200px] py-1 rounded-md bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 shadow-lg"
                  style={{
                    left: `${profileMenuPos()!.left}px`,
                    top: `${profileMenuPos()!.top}px`,
                  }}
                >
                  <Show
                    when={profiles().length > 0}
                    fallback={
                      <div class="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                        {t().terminal.profileNoneFound}
                      </div>
                    }
                  >
                    <div class="px-3 py-1.5 text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">
                      {t().terminal.profileNewWith}
                    </div>
                    <For each={profiles()}>
                      {(profile) => (
                        <button
                          type="button"
                          onClick={() => {
                            setProfileMenuOpen(false);
                            addTab(props.sessionId, profile.id);
                          }}
                          class="w-full text-left px-3 py-1.5 text-xs flex items-center justify-between gap-3 hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-700 dark:text-gray-200"
                        >
                          <span class="truncate">{profile.name}</span>
                          <Show when={profile.id === defaultProfileId()}>
                            <span class="text-[9px] text-blue-500 dark:text-blue-400 uppercase tracking-wide">
                              {t().terminal.profileDefaultBadge}
                            </span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </Show>
                </div>
              </Portal>
            </Show>
          </div>
        </div>

        <button
          onClick={() => (searchOpen() ? closeSearch() : openSearch())}
          class={`flex-shrink-0 px-2 transition-colors border-l border-gray-200 dark:border-slate-800 ${
            searchOpen()
              ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40"
              : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-slate-700"
          }`}
          title={t().terminal.searchTitle}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </button>

        <button
          onClick={() => props.onClose()}
          class="flex-shrink-0 px-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors border-l border-gray-200 dark:border-slate-800"
          title={t().terminal.closePanel}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      {/* All tabs are kept mounted so PTY output isn't lost on session switch.
          Only the active session's active tab is visible. */}
      <div class="flex-1 overflow-hidden relative">
        <Show when={searchOpen()}>
          <div class="absolute top-1 right-3 z-10 flex items-center gap-1 px-1.5 py-1 rounded-md bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 shadow-md">
            <input
              ref={(el) => (searchInputRef = el)}
              type="text"
              value={searchQuery()}
              placeholder={t().terminal.searchPlaceholder}
              onInput={(e) => {
                setSearchQuery(e.currentTarget.value);
                findNext();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeSearch();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (e.shiftKey) findPrev();
                  else findNext();
                }
              }}
              class="text-xs w-44 px-2 py-1 rounded bg-gray-50 dark:bg-slate-800 text-gray-800 dark:text-gray-200 border border-transparent focus:border-blue-500 focus:outline-none"
            />
            <span class="text-[10px] text-gray-500 dark:text-gray-400 min-w-[60px] text-right pr-1 tabular-nums">
              {searchMatch()
                ? formatMessage(t().terminal.searchMatchCount, {
                    current: searchMatch()!.resultCount === 0 ? 0 : searchMatch()!.resultIndex + 1,
                    total: searchMatch()!.resultCount,
                  })
                : t().terminal.searchNoMatch}
            </span>
            <button
              type="button"
              onClick={() => setSearchOpts("caseSensitive", (v) => !v)}
              title={t().terminal.searchCaseSensitive}
              class={`px-1 py-0.5 text-[10px] font-mono rounded ${
                searchOpts.caseSensitive
                  ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300"
                  : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800"
              }`}
            >
              Aa
            </button>
            <button
              type="button"
              onClick={() => setSearchOpts("wholeWord", (v) => !v)}
              title={t().terminal.searchWholeWord}
              class={`px-1 py-0.5 text-[10px] font-mono rounded ${
                searchOpts.wholeWord
                  ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300"
                  : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800"
              }`}
            >
              \b
            </button>
            <button
              type="button"
              onClick={() => setSearchOpts("regex", (v) => !v)}
              title={t().terminal.searchRegex}
              class={`px-1 py-0.5 text-[10px] font-mono rounded ${
                searchOpts.regex
                  ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300"
                  : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800"
              }`}
            >
              .*
            </button>
            <button
              type="button"
              onClick={findPrev}
              title={t().terminal.searchPrev}
              class="px-1 py-0.5 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="18 15 12 9 6 15" />
              </svg>
            </button>
            <button
              type="button"
              onClick={findNext}
              title={t().terminal.searchNext}
              class="px-1 py-0.5 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <button
              type="button"
              onClick={closeSearch}
              title={t().terminal.searchClose}
              class="px-1 py-0.5 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </Show>
        <For each={allTabs()}>
          {(tab) => (
            <div
              ref={(el) => initTab(tab.id, tab.sessionId, el)}
              class="absolute inset-0"
              style={{
                display:
                  tab.sessionId === props.sessionId && tab.id === currentActiveTab()
                    ? "block"
                    : "none",
                padding: "4px 0 4px 8px",
              }}
            />
          )}
        </For>
      </div>
    </div>
  );
}
