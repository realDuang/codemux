import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory settings backing store
const settingsBacking = new Map<string, unknown>();

vi.mock("../../../../src/lib/settings", () => ({
  getSetting: vi.fn((key: string) => settingsBacking.get(key)),
  saveSetting: vi.fn((key: string, value: unknown) => {
    settingsBacking.set(key, value);
  }),
}));

vi.mock("../../../../src/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- DOM + matchMedia stubs ----------------------------------------------------
//
// theme.ts imports applyTheme at module load time (touches document &
// matchMedia). Stub these globals before each fresh import so each test starts
// from a clean state.
//
type MediaQueryListener = (e: { matches: boolean }) => void;

interface MediaQueryStub {
  matches: boolean;
  addEventListener: (type: string, fn: MediaQueryListener) => void;
  removeEventListener: (type: string, fn: MediaQueryListener) => void;
  /** test helper to fire a system theme change */
  __dispatchChange: (matches: boolean) => void;
}

let currentMatches = false;
let mediaListeners: MediaQueryListener[] = [];
let updateTitleBarOverlayMock: ReturnType<typeof vi.fn>;

function makeMediaQueryStub(): MediaQueryStub {
  return {
    get matches() {
      return currentMatches;
    },
    addEventListener: (_type, fn) => {
      mediaListeners.push(fn);
    },
    removeEventListener: (_type, fn) => {
      mediaListeners = mediaListeners.filter((l) => l !== fn);
    },
    __dispatchChange: (matches: boolean) => {
      currentMatches = matches;
      for (const fn of mediaListeners) fn({ matches });
    },
  };
}

function setupDom(systemPrefersDark = false): MediaQueryStub {
  currentMatches = systemPrefersDark;
  mediaListeners = [];

  const documentElement = {
    classList: {
      _set: new Set<string>(),
      add(c: string) {
        this._set.add(c);
      },
      remove(c: string) {
        this._set.delete(c);
      },
      contains(c: string) {
        return this._set.has(c);
      },
    },
  };
  vi.stubGlobal("document", { documentElement });

  const stub = makeMediaQueryStub();
  updateTitleBarOverlayMock = vi.fn();
  vi.stubGlobal("window", {
    matchMedia: vi.fn(() => stub),
    electronAPI: {
      system: {
        updateTitleBarOverlay: updateTitleBarOverlayMock,
      },
    },
  });
  return stub;
}

function htmlClasses(): Set<string> {
  return (document.documentElement as any).classList._set as Set<string>;
}

beforeEach(() => {
  settingsBacking.clear();
  vi.useFakeTimers();
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("theme module", () => {
  describe("default theme", () => {
    it("defaults to dark when no setting is saved", async () => {
      setupDom();
      const { getThemeMode, getEffectiveTheme } = await import("../../../../src/lib/theme");
      expect(getThemeMode()()).toBe("dark");
      expect(getEffectiveTheme()).toBe("dark");
      expect(htmlClasses().has("dark")).toBe(true);
    });

    it("uses persisted theme when present", async () => {
      settingsBacking.set("theme", "light");
      setupDom();
      const { getThemeMode } = await import("../../../../src/lib/theme");
      expect(getThemeMode()()).toBe("light");
      expect(htmlClasses().has("dark")).toBe(false);
    });

    it("ignores invalid persisted values and falls back to dark", async () => {
      settingsBacking.set("theme", "neon");
      setupDom();
      const { getThemeMode } = await import("../../../../src/lib/theme");
      expect(getThemeMode()()).toBe("dark");
    });

    it.each(["light", "dark", "system"] as const)(
      "accepts persisted value %s",
      async (mode) => {
        settingsBacking.set("theme", mode);
        setupDom(false);
        const { getThemeMode } = await import("../../../../src/lib/theme");
        expect(getThemeMode()()).toBe(mode);
      },
    );
  });

  describe("setThemeMode", () => {
    it("applies dark and persists the choice", async () => {
      setupDom();
      const { setThemeMode } = await import("../../../../src/lib/theme");
      setThemeMode("dark");
      expect(htmlClasses().has("dark")).toBe(true);
      expect(settingsBacking.get("theme")).toBe("dark");
    });

    it("applies light and removes the dark class", async () => {
      setupDom();
      const { setThemeMode, getEffectiveTheme } = await import("../../../../src/lib/theme");
      setThemeMode("light");
      expect(htmlClasses().has("dark")).toBe(false);
      expect(getEffectiveTheme()).toBe("light");
      expect(settingsBacking.get("theme")).toBe("light");
    });

    it("system mode resolves to dark when prefers-color-scheme matches", async () => {
      setupDom(true);
      const { setThemeMode, getEffectiveTheme } = await import("../../../../src/lib/theme");
      setThemeMode("system");
      expect(getEffectiveTheme()).toBe("dark");
      expect(htmlClasses().has("dark")).toBe(true);
    });

    it("system mode resolves to light when prefers-color-scheme does not match", async () => {
      setupDom(false);
      const { setThemeMode, getEffectiveTheme } = await import("../../../../src/lib/theme");
      setThemeMode("system");
      expect(getEffectiveTheme()).toBe("light");
      expect(htmlClasses().has("dark")).toBe(false);
    });
  });

  describe("title bar overlay sync", () => {
    it("calls updateTitleBarOverlay with dark colors for dark theme", async () => {
      setupDom();
      const { setThemeMode } = await import("../../../../src/lib/theme");
      setThemeMode("dark");
      expect(updateTitleBarOverlayMock).toHaveBeenCalledWith({
        color: "#020617",
        symbolColor: "#94a3b8",
      });
    });

    it("calls updateTitleBarOverlay with light colors for light theme", async () => {
      setupDom();
      const { setThemeMode } = await import("../../../../src/lib/theme");
      setThemeMode("light");
      expect(updateTitleBarOverlayMock).toHaveBeenCalledWith({
        color: "#f8fafc",
        symbolColor: "#475569",
      });
    });

    it("retries via setTimeout when electronAPI is missing on first try", async () => {
      // Stub a window without electronAPI initially
      currentMatches = false;
      mediaListeners = [];
      vi.stubGlobal("document", {
        documentElement: {
          classList: {
            _set: new Set<string>(),
            add(c: string) { (this as any)._set.add(c); },
            remove(c: string) { (this as any)._set.delete(c); },
            contains(c: string) { return (this as any)._set.has(c); },
          },
        },
      });
      const stub = makeMediaQueryStub();
      const lateMock = vi.fn();
      const winObj: any = { matchMedia: () => stub };
      vi.stubGlobal("window", winObj);

      const { setThemeMode } = await import("../../../../src/lib/theme");
      setThemeMode("dark");
      expect(lateMock).not.toHaveBeenCalled();

      // Make electronAPI available before timer fires
      winObj.electronAPI = { system: { updateTitleBarOverlay: lateMock } };
      vi.advanceTimersByTime(250);
      expect(lateMock).toHaveBeenCalledWith({ color: "#020617", symbolColor: "#94a3b8" });
    });
  });

  describe("system theme change listener", () => {
    it("re-applies theme when system preference changes and mode is system", async () => {
      const stub = setupDom(false);
      const { setThemeMode, getEffectiveTheme } = await import("../../../../src/lib/theme");
      setThemeMode("system");
      expect(getEffectiveTheme()).toBe("light");

      stub.__dispatchChange(true);
      expect(htmlClasses().has("dark")).toBe(true);
      expect(getEffectiveTheme()).toBe("dark");
    });

    it("ignores system preference change when mode is not system", async () => {
      const stub = setupDom(false);
      const { setThemeMode } = await import("../../../../src/lib/theme");
      setThemeMode("light");
      const before = htmlClasses().has("dark");

      stub.__dispatchChange(true); // system flips, but we're in light mode
      expect(htmlClasses().has("dark")).toBe(before);
      expect(htmlClasses().has("dark")).toBe(false);
    });
  });

  describe("refreshThemeFromSettings", () => {
    it("reloads the theme from settings without going through setThemeMode", async () => {
      setupDom();
      const { refreshThemeFromSettings, getThemeMode } = await import(
        "../../../../src/lib/theme"
      );
      // Initial mode is dark (default). Change settings out-of-band, then refresh.
      settingsBacking.set("theme", "light");
      refreshThemeFromSettings();
      expect(getThemeMode()()).toBe("light");
      expect(htmlClasses().has("dark")).toBe(false);
    });
  });
});
