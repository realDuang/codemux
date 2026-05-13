// ============================================================================
// Terminal Panel Store
//
// Holds UI state for the integrated terminal panel: per-session open/closed
// flag and the panel's vertical height. Terminal *contents* (PTYs, xterm
// instances, tabs) live inside `TerminalPanel.tsx` and on the gateway server;
// this store only tracks the panel chrome state shared with `Chat.tsx`.
//
// Pattern mirrors `src/stores/file.ts` (file explorer panel).
// ============================================================================

import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TerminalStoreState {
  /** Per-session open/closed flag. Persisted across in-app session switches. */
  openBySession: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const DEFAULT_HEIGHT = 250;
const MIN_HEIGHT = 120;
const MAX_HEIGHT_RATIO = 0.7;

const [terminalStore, setTerminalStore] = createStore<TerminalStoreState>({
  openBySession: {},
});

const [terminalHeight, setTerminalHeightSignal] = createSignal(DEFAULT_HEIGHT);

/**
 * Imperative reference to the panel's API. `TerminalPanel` registers itself
 * once mounted via `registerTerminalActions`. We keep this outside the store
 * because it's a side-effect, not state.
 */
export interface TerminalActions {
  /** Open the first tab for `sessionId` if none exists yet. */
  ensureFirstTab: (sessionId: string) => void;
  /** Open a new tab for `sessionId`. */
  newTab: (sessionId: string) => void;
  /** Close the currently active tab in `sessionId`. No-op if none. */
  closeActiveTab: (sessionId: string) => void;
  /** Cycle to the previous (-1) or next (+1) tab within `sessionId`. */
  switchTab: (sessionId: string, dir: 1 | -1) => void;
}

let actionsRef: TerminalActions | undefined;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export { terminalStore, terminalHeight };

/** Register the terminal panel's imperative API. */
export function registerTerminalActions(actions: TerminalActions | undefined): void {
  actionsRef = actions;
}

/** @deprecated Use `registerTerminalActions` instead. Kept for backward compat. */
export function registerEnsureTab(fn: ((sessionId: string) => void) | undefined): void {
  if (!fn) {
    actionsRef = undefined;
    return;
  }
  actionsRef = {
    ensureFirstTab: fn,
    newTab: fn,
    closeActiveTab: () => {},
    switchTab: () => {},
  };
}

export function isTerminalOpen(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return !!terminalStore.openBySession[sessionId];
}

export function toggleTerminal(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  const willOpen = !terminalStore.openBySession[sessionId];
  setTerminalStore("openBySession", sessionId, willOpen);
  if (willOpen) actionsRef?.ensureFirstTab(sessionId);
}

export function openTerminal(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  if (!terminalStore.openBySession[sessionId]) {
    setTerminalStore("openBySession", sessionId, true);
    actionsRef?.ensureFirstTab(sessionId);
  }
}

export function closeTerminal(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  setTerminalStore("openBySession", sessionId, false);
}

/** Open a new terminal tab in `sessionId`, opening the panel if needed. */
export function newTerminalTab(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  if (!terminalStore.openBySession[sessionId]) {
    setTerminalStore("openBySession", sessionId, true);
  }
  actionsRef?.newTab(sessionId);
}

/** Close the currently active tab in `sessionId`. */
export function closeActiveTerminalTab(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  actionsRef?.closeActiveTab(sessionId);
}

/** Switch to next (+1) / previous (-1) tab within `sessionId`. */
export function switchTerminalTab(sessionId: string | null | undefined, dir: 1 | -1): void {
  if (!sessionId) return;
  actionsRef?.switchTab(sessionId, dir);
}

export function setTerminalHeight(height: number): void {
  setTerminalHeightSignal(clampHeight(height));
}

/** Clamp helper — exported for test use. */
export function clampHeight(height: number): number {
  if (!Number.isFinite(height)) return DEFAULT_HEIGHT;
  const max = typeof window === "undefined" ? Infinity : Math.floor(window.innerHeight * MAX_HEIGHT_RATIO);
  if (height < MIN_HEIGHT) return MIN_HEIGHT;
  if (height > max) return max;
  return Math.floor(height);
}

export const TERMINAL_PANEL_DEFAULTS = {
  defaultHeight: DEFAULT_HEIGHT,
  minHeight: MIN_HEIGHT,
  maxHeightRatio: MAX_HEIGHT_RATIO,
} as const;
