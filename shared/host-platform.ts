import type { RuntimePathConfig } from "./runtime-paths";

/** Host capabilities selected by the desktop or standalone server build. */
export interface HostPlatform {
  readonly paths: RuntimePathConfig;
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
  readonly isDevIsolated: boolean;
  readonly usesSharedDevDeviceStore: boolean;
  readonly useLibraryDefaultLogPath: boolean;
  readonly logFileName?: string;
  readonly settings?: {
    loadSettings(): Record<string, unknown>;
    saveSettings(patch: Record<string, unknown>): void | Promise<void>;
  };
  notify(title: string, body: string): void;
}
