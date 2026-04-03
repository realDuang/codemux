import { createSignal, Accessor } from "solid-js";
import { logger } from "./logger";
import { getSetting, saveSetting } from "./settings";

export type ThemeMode = "light" | "dark" | "dark-modern" | "system";

function getSavedTheme(): ThemeMode {
  const saved = getSetting<string>("theme");
  if (saved && ["light", "dark", "dark-modern", "system"].includes(saved)) {
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

function syncTitleBarOverlay(theme: "light" | "dark" | "dark-modern"): void {
  if (typeof window === "undefined") return;

  const doSync = () => {
    const electronAPI = (window as any).electronAPI;
    const updateFn = electronAPI?.system?.updateTitleBarOverlay;
    if (!updateFn) return false;

    if (theme === "dark-modern") {
      updateFn({ color: "#1f1f1f", symbolColor: "#cccccc" });
    } else if (theme === "dark") {
      updateFn({ color: "#020617", symbolColor: "#94a3b8" });
    } else {
      updateFn({ color: "#f8fafc", symbolColor: "#475569" });
    }
    return true;
  };

  if (!doSync()) {
    setTimeout(doSync, 200);
  }
}

function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  const effectiveTheme = theme === "system" ? getSystemTheme() : theme;

  // Remove all theme classes first
  root.classList.remove("dark", "dark-modern");

  if (effectiveTheme === "dark" || effectiveTheme === "dark-modern") {
    root.classList.add("dark"); // Tailwind dark: variant
  }
  if (effectiveTheme === "dark-modern") {
    root.classList.add("dark-modern"); // CSS variable overrides
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

export function getEffectiveTheme(): "light" | "dark" | "dark-modern" {
  const mode = themeMode();
  if (mode === "dark-modern") return "dark-modern";
  return mode === "system" ? getSystemTheme() : mode;
}
