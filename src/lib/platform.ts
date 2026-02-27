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

/**
 * macOS title bar height (when using hiddenInset style)
 * trafficLightPosition.y = 16, plus button height ~12px, plus some padding
 */
const MACOS_TITLE_BAR_HEIGHT = 38;

/**
 * Initialize Electron title bar safe area
 * When using hiddenInset title bar on macOS, add top padding to content
 */
export function initElectronTitleBar(): void {
  if (!isElectron()) return;

  // Detect macOS (via navigator.platform or userAgent)
  const isMacOS = navigator.platform.toUpperCase().indexOf('MAC') >= 0 ||
                  navigator.userAgent.toUpperCase().indexOf('MAC') >= 0;

  if (isMacOS) {
    document.documentElement.style.setProperty(
      '--electron-title-bar-height',
      `${MACOS_TITLE_BAR_HEIGHT}px`
    );
    document.documentElement.classList.add('electron-macos');
  }
}