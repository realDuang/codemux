import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRoot } from "solid-js";
import {
  terminalStore,
  terminalHeight,
  setTerminalHeight,
  isTerminalOpen,
  toggleTerminal,
  openTerminal,
  closeTerminal,
  registerEnsureTab,
  registerTerminalActions,
  newTerminalTab,
  closeActiveTerminalTab,
  switchTerminalTab,
  clampHeight,
  TERMINAL_PANEL_DEFAULTS,
} from "../../../../src/stores/terminal";

// The store is module-scoped; reset its visible bits between tests.
function resetStore() {
  for (const key of Object.keys(terminalStore.openBySession)) {
    closeTerminal(key);
  }
  setTerminalHeight(TERMINAL_PANEL_DEFAULTS.defaultHeight);
  registerEnsureTab(undefined);
  registerTerminalActions(undefined);
}

beforeEach(() => {
  resetStore();
});

describe("isTerminalOpen", () => {
  it("returns false for null/undefined/empty session", () => {
    expect(isTerminalOpen(null)).toBe(false);
    expect(isTerminalOpen(undefined)).toBe(false);
    expect(isTerminalOpen("")).toBe(false);
  });

  it("returns false for a session that was never opened", () => {
    expect(isTerminalOpen("s1")).toBe(false);
  });

  it("returns true after toggleTerminal opens the session", () => {
    toggleTerminal("s1");
    expect(isTerminalOpen("s1")).toBe(true);
  });
});

describe("toggleTerminal", () => {
  it("flips the open flag for a given session", () => {
    toggleTerminal("s1");
    expect(isTerminalOpen("s1")).toBe(true);
    toggleTerminal("s1");
    expect(isTerminalOpen("s1")).toBe(false);
  });

  it("scopes state per session", () => {
    toggleTerminal("s1");
    expect(isTerminalOpen("s1")).toBe(true);
    expect(isTerminalOpen("s2")).toBe(false);
    toggleTerminal("s2");
    expect(isTerminalOpen("s1")).toBe(true);
    expect(isTerminalOpen("s2")).toBe(true);
  });

  it("is a no-op for null/undefined/empty session", () => {
    toggleTerminal(null);
    toggleTerminal(undefined);
    toggleTerminal("");
    expect(Object.values(terminalStore.openBySession).some(Boolean)).toBe(false);
  });

  it("calls registered ensureTab callback only on open transitions", () => {
    const ensureTab = vi.fn();
    registerEnsureTab(ensureTab);
    toggleTerminal("s1");
    expect(ensureTab).toHaveBeenCalledWith("s1");
    toggleTerminal("s1");
    expect(ensureTab).toHaveBeenCalledTimes(1);
    toggleTerminal("s1");
    expect(ensureTab).toHaveBeenCalledTimes(2);
  });
});

describe("openTerminal / closeTerminal", () => {
  it("openTerminal forces the panel open and runs ensureTab", () => {
    const ensureTab = vi.fn();
    registerEnsureTab(ensureTab);
    openTerminal("s1");
    expect(isTerminalOpen("s1")).toBe(true);
    expect(ensureTab).toHaveBeenCalledWith("s1");
  });

  it("openTerminal is idempotent — does not re-run ensureTab when already open", () => {
    const ensureTab = vi.fn();
    registerEnsureTab(ensureTab);
    openTerminal("s1");
    openTerminal("s1");
    openTerminal("s1");
    expect(ensureTab).toHaveBeenCalledTimes(1);
  });

  it("closeTerminal sets the flag false without invoking ensureTab", () => {
    const ensureTab = vi.fn();
    registerEnsureTab(ensureTab);
    openTerminal("s1");
    ensureTab.mockClear();
    closeTerminal("s1");
    expect(isTerminalOpen("s1")).toBe(false);
    expect(ensureTab).not.toHaveBeenCalled();
  });

  it("close/open are no-ops for null/undefined/empty session", () => {
    expect(() => openTerminal(null)).not.toThrow();
    expect(() => closeTerminal(undefined)).not.toThrow();
    expect(() => openTerminal("")).not.toThrow();
  });
});

describe("registerEnsureTab", () => {
  it("supports unregistering by passing undefined", () => {
    const ensureTab = vi.fn();
    registerEnsureTab(ensureTab);
    registerEnsureTab(undefined);
    toggleTerminal("s1");
    expect(ensureTab).not.toHaveBeenCalled();
  });

  it("only the most-recent callback is used", () => {
    const a = vi.fn();
    const b = vi.fn();
    registerEnsureTab(a);
    registerEnsureTab(b);
    toggleTerminal("s1");
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith("s1");
  });
});

describe("registerTerminalActions", () => {
  it("newTerminalTab opens panel and forwards to actions.newTab", () => {
    const newTab = vi.fn();
    registerTerminalActions({
      ensureFirstTab: () => {},
      newTab,
      closeActiveTab: () => {},
      switchTab: () => {},
    });
    newTerminalTab("s1");
    expect(isTerminalOpen("s1")).toBe(true);
    expect(newTab).toHaveBeenCalledWith("s1");
  });

  it("newTerminalTab still calls newTab when panel is already open", () => {
    const newTab = vi.fn();
    registerTerminalActions({
      ensureFirstTab: () => {},
      newTab,
      closeActiveTab: () => {},
      switchTab: () => {},
    });
    openTerminal("s1");
    newTab.mockClear();
    newTerminalTab("s1");
    expect(newTab).toHaveBeenCalledTimes(1);
  });

  it("closeActiveTerminalTab forwards to actions.closeActiveTab", () => {
    const closeActiveTab = vi.fn();
    registerTerminalActions({
      ensureFirstTab: () => {},
      newTab: () => {},
      closeActiveTab,
      switchTab: () => {},
    });
    closeActiveTerminalTab("s1");
    expect(closeActiveTab).toHaveBeenCalledWith("s1");
  });

  it("switchTerminalTab forwards direction to actions.switchTab", () => {
    const switchTab = vi.fn();
    registerTerminalActions({
      ensureFirstTab: () => {},
      newTab: () => {},
      closeActiveTab: () => {},
      switchTab,
    });
    switchTerminalTab("s1", 1);
    switchTerminalTab("s1", -1);
    expect(switchTab).toHaveBeenNthCalledWith(1, "s1", 1);
    expect(switchTab).toHaveBeenNthCalledWith(2, "s1", -1);
  });

  it("all action helpers are no-ops for null/undefined/empty session", () => {
    const fn = vi.fn();
    registerTerminalActions({
      ensureFirstTab: fn,
      newTab: fn,
      closeActiveTab: fn,
      switchTab: fn,
    });
    newTerminalTab(null);
    closeActiveTerminalTab(undefined);
    switchTerminalTab("", 1);
    expect(fn).not.toHaveBeenCalled();
  });

  it("unregistering by passing undefined drops all action wires", () => {
    const fn = vi.fn();
    registerTerminalActions({
      ensureFirstTab: fn,
      newTab: fn,
      closeActiveTab: fn,
      switchTab: fn,
    });
    registerTerminalActions(undefined);
    newTerminalTab("s1");
    closeActiveTerminalTab("s1");
    switchTerminalTab("s1", 1);
    // newTerminalTab still toggles open state even without actions:
    expect(isTerminalOpen("s1")).toBe(true);
    // …but no callback was invoked because the wire was dropped:
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("clampHeight", () => {
  it("returns the floor of finite values within bounds", () => {
    expect(clampHeight(250.7)).toBe(250);
    expect(clampHeight(300)).toBe(300);
  });

  it("clamps below MIN_HEIGHT to the minimum", () => {
    expect(clampHeight(50)).toBe(TERMINAL_PANEL_DEFAULTS.minHeight);
    expect(clampHeight(0)).toBe(TERMINAL_PANEL_DEFAULTS.minHeight);
    expect(clampHeight(-100)).toBe(TERMINAL_PANEL_DEFAULTS.minHeight);
  });

  it("returns the default for non-finite input", () => {
    expect(clampHeight(NaN)).toBe(TERMINAL_PANEL_DEFAULTS.defaultHeight);
    expect(clampHeight(Infinity)).toBe(TERMINAL_PANEL_DEFAULTS.defaultHeight);
  });
});

describe("setTerminalHeight / terminalHeight signal", () => {
  it("setTerminalHeight clamps via clampHeight then updates the signal", () => {
    createRoot((dispose) => {
      setTerminalHeight(400);
      expect(terminalHeight()).toBe(400);
      setTerminalHeight(10);
      expect(terminalHeight()).toBe(TERMINAL_PANEL_DEFAULTS.minHeight);
      dispose();
    });
  });
});
