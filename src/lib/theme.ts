import { createSignal, Accessor } from "solid-js";
import { logger } from "./logger";
import { getSetting, saveSetting } from "./settings";

export type ThemeMode = "light" | "dark" | "system";

function getSavedTheme(): ThemeMode {
  const saved = getSetting<string>("theme");
  if (saved && ["light", "dark", "system"].includes(saved)) {
    return saved as ThemeMode;
  }
  return "system";
}

function saveTheme(theme: ThemeMode): void {
  saveSetting("theme", theme);
}

function getSystemTheme(): "light" | "dark" {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
}

function syncTitleBarOverlay(theme: "light" | "dark"): void {
  if (typeof window === "undefined") return;
  const api = (window as unknown as Record<string, unknown>).electronAPI as
    | Record<string, Function>
    | undefined;
  if (!api?.updateTitleBarOverlay) return;

  if (theme === "dark") {
    api.updateTitleBarOverlay({
      color: "#020617",       // slate-950
      symbolColor: "#94a3b8", // slate-400
    });
  } else {
    api.updateTitleBarOverlay({
      color: "#f8fafc",       // slate-50
      symbolColor: "#475569", // slate-600
    });
  }
}

function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  const effectiveTheme = theme === "system" ? getSystemTheme() : theme;

  if (effectiveTheme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }

  syncTitleBarOverlay(effectiveTheme);
  logger.debug("[Theme] Applied:", theme, "→", effectiveTheme);
}

const [themeMode, setThemeModeSignal] = createSignal<ThemeMode>(getSavedTheme());

if (typeof window !== "undefined") {
  applyTheme(getSavedTheme());

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", () => {
    if (themeMode() === "system") {
      applyTheme("system");
    }
  });
}

export function setThemeMode(theme: ThemeMode): void {
  setThemeModeSignal(theme);
  saveTheme(theme);
  applyTheme(theme);
}

export function getThemeMode(): Accessor<ThemeMode> {
  return themeMode;
}

export function getEffectiveTheme(): "light" | "dark" {
  const mode = themeMode();
  return mode === "system" ? getSystemTheme() : mode;
}
