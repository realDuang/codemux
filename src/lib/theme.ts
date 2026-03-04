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

function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  const effectiveTheme = theme === "system" ? getSystemTheme() : theme;

  logger.debug("[Theme] Applying theme:", theme, "effective:", effectiveTheme);
  logger.debug("[Theme] Document element:", root.tagName, "classList before:", root.classList.toString());

  if (effectiveTheme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }

  logger.debug("[Theme] classList after:", root.classList.toString());
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
  logger.debug("[Theme] setThemeMode called with:", theme);
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

export const Theme = {
  get mode(): Accessor<ThemeMode> {
    return themeMode;
  },
  set: setThemeMode,
  getEffective: getEffectiveTheme,
};
