/**
 * Platform detection utilities
 * Used to determine if the current environment is Electron or Browser
 */

export function isElectron(): boolean {
  return typeof window !== "undefined" && typeof window.electronAPI !== "undefined";
}

export function isBrowser(): boolean {
  return !isElectron();
}

/** Detect Windows platform */
export function isWindows(): boolean {
  return typeof navigator !== "undefined" &&
    ((navigator as any).userAgentData?.platform === "Windows" ||
     /Windows/i.test(navigator.userAgent));
}

/** Detect macOS platform */
export function isMacOS(): boolean {
  return typeof navigator !== "undefined" &&
    ((navigator as any).userAgentData?.platform === "macOS" ||
     /Mac/i.test(navigator.userAgent));
}

/**
 * macOS title bar height (when using hiddenInset style)
 * Traffic lights (12px) centered at y=14 within 40px bar
 */
const MACOS_TITLE_BAR_HEIGHT = 40;
const WINDOWS_TITLE_BAR_HEIGHT = 40;

/**
 * Initialize Electron title bar safe area
 * Sets platform classes and CSS custom properties for custom titlebars
 */
export function initElectronTitleBar(): void {
  if (!isElectron()) return;

  if (isMacOS()) {
    document.documentElement.style.setProperty(
      '--electron-title-bar-height',
      `${MACOS_TITLE_BAR_HEIGHT}px`
    );
    document.documentElement.classList.add('electron-macos');
  } else if (isWindows()) {
    document.documentElement.style.setProperty(
      '--electron-title-bar-height',
      `${WINDOWS_TITLE_BAR_HEIGHT}px`
    );
    document.documentElement.classList.add('electron-windows');
  }
}