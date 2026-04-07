import { createSignal, createEffect, onCleanup, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { terminalAPI } from "../lib/electron-api";
import "@xterm/xterm/css/xterm.css";

export interface TerminalPanelProps {
  sessionId: string;
  cwd: string;       // cwd for the current session — used when creating new tabs
  visible: boolean;
  onClose: () => void;
  /** Called once with an addTab function so the parent can open the first tab */
  onReady?: (addTab: (sessionId: string) => void) => void;
}

interface TabEntry {
  id: string;
  sessionId: string;
  cwd: string;
  label: string;
  exited: boolean;
}

interface TabInstance {
  xterm: XTerm;
  fitAddon: FitAddon;
  ptyId: string | null;
  cleanupData: (() => void) | null;
  cleanupExit: (() => void) | null;
  resizeTimer: ReturnType<typeof setTimeout> | null;
  resizeObserver: ResizeObserver;
  themeObserver: MutationObserver;
}

export function TerminalPanel(props: TerminalPanelProps) {
  // Flat list of ALL tabs from ALL sessions — kept permanently for DOM persistence
  const [allTabs, setAllTabs] = createSignal<TabEntry[]>([]);
  // Per-session active tab id
  const [activeTabBySession, setActiveTabBySession] = createStore<Record<string, string>>({});
  // Per-session tab counter so numbering starts from 1 in each session
  const tabCounterBySession: Record<string, number> = {};

  // Non-reactive xterm/PTY instances keyed by tabId
  const instances = new Map<string, TabInstance>();

  // Expose addTab to parent via onReady (called once on mount)
  // ensureFirstTab creates a tab only when the session has none yet
  function ensureFirstTab(sessionId: string) {
    const has = allTabs().some((t) => t.sessionId === sessionId);
    if (!has) addTab(sessionId);
  }
  props.onReady?.(ensureFirstTab);

  const isDark = () => document.documentElement.classList.contains("dark");
  const getTheme = () =>
    isDark()
      ? { background: "#0f172a", foreground: "#e2e8f0", cursor: "#e2e8f0", selectionBackground: "#334155" }
      : { background: "#ffffff", foreground: "#1e293b", cursor: "#1e293b", selectionBackground: "#cbd5e1" };

  const currentTabs = () => allTabs().filter((t) => t.sessionId === props.sessionId);
  const currentActiveTab = () => activeTabBySession[props.sessionId] ?? "";

  function addTab(sessionId: string = props.sessionId) {
    tabCounterBySession[sessionId] = (tabCounterBySession[sessionId] ?? 0) + 1;
    const n = tabCounterBySession[sessionId];
    const id = `tab-${sessionId}-${n}`;
    const label = `Terminal ${n}`;
    const cwd = props.cwd;
    setAllTabs((prev) => [...prev, { id, sessionId, cwd, label, exited: false }]);
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
    if (inst.ptyId) terminalAPI.destroy(inst.ptyId);
    if (inst.resizeTimer) clearTimeout(inst.resizeTimer);
    inst.resizeObserver.disconnect();
    inst.themeObserver.disconnect();
    inst.xterm.dispose();
    instances.delete(tabId);
  }

  function fitTab(tabId: string) {
    const inst = instances.get(tabId);
    if (!inst) return;
    inst.fitAddon.fit();
    if (inst.ptyId) terminalAPI.resize(inst.ptyId, inst.xterm.cols, inst.xterm.rows);
  }

  async function initTab(tabId: string, sessionId: string, el: HTMLDivElement) {
    if (instances.has(tabId) || !terminalAPI.isAvailable()) return;

    const tabEntry = allTabs().find((t) => t.id === tabId);
    const cwd = tabEntry?.cwd ?? props.cwd;

    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        "'Hack Nerd Font', 'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', 'MesloLGS NF', 'Hack', 'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', monospace",
      theme: getTheme(),
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(el);

    const themeObserver = new MutationObserver(() => {
      xterm.options.theme = getTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const inst: TabInstance = {
      xterm,
      fitAddon,
      ptyId: null,
      cleanupData: null,
      cleanupExit: null,
      resizeTimer: null,
      resizeObserver: new ResizeObserver(() => {}),
      themeObserver,
    };
    instances.set(tabId, inst);

    const resizeObserver = new ResizeObserver(() => {
      if (inst.resizeTimer) clearTimeout(inst.resizeTimer);
      inst.resizeTimer = setTimeout(() => {
        // Only fit the active tab of the currently visible session
        if (props.visible && activeTabBySession[props.sessionId] === tabId) {
          fitAddon.fit();
          if (inst.ptyId) terminalAPI.resize(inst.ptyId, xterm.cols, xterm.rows);
        }
        inst.resizeTimer = null;
      }, 50);
    });
    resizeObserver.observe(el);
    inst.resizeObserver = resizeObserver;

    requestAnimationFrame(async () => {
      // Only fit if this is the active visible tab
      if (props.visible && activeTabBySession[sessionId] === tabId) {
        fitAddon.fit();
      }
      (document.activeElement as HTMLElement | null)?.blur?.();

      const ptyId = await terminalAPI.create(cwd, xterm.cols, xterm.rows);
      if (!ptyId) return;
      inst.ptyId = ptyId;

      inst.cleanupData = terminalAPI.onData((tId: string, data: string) => {
        if (tId === ptyId) xterm.write(data);
      });

      inst.cleanupExit = terminalAPI.onExit((tId: string) => {
        if (tId === ptyId) {
          setAllTabs((prev) =>
            prev.map((t) => (t.id === tabId ? { ...t, exited: true } : t))
          );
        }
      });

      xterm.onData((data) => {
        terminalAPI.write(ptyId, data);
      });
    });
  }

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
      {/* Header: tab bar + close panel button */}
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
                  <span class="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />
                </Show>
                <span
                  role="button"
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

          {/* New tab (+) */}
          <button
            onClick={() => addTab()}
            class="px-2.5 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors flex-shrink-0"
            title="New terminal"
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
        </div>

        {/* Close panel (hide only, does not destroy tabs) */}
        <button
          onClick={props.onClose}
          class="flex-shrink-0 px-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors border-l border-gray-200 dark:border-slate-800"
          title="Hide terminal panel"
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

      {/* All tab DOM containers — permanently in DOM across ALL sessions.
          Only the active session's active tab is visible. */}
      <div class="flex-1 overflow-hidden relative">
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
