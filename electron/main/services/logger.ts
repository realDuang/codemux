import log from "electron-log/main";
import { runtimeHost } from "#runtime-host";
import type { LevelOption } from "electron-log";
import { getLogsPath, getSettingsPath } from "./app-paths";
import { createSettingsStore } from "../../../shared/settings-store";
import { resolveRuntimeLogPath } from "../../../shared/runtime-paths";

// Configure electron-log for the main process.
// The desktop supervisor and the runtime use separate files in the same directory.

// File transport: preserve the host's configured log directory.
log.transports.file.resolvePathFn = (variables) => resolveRuntimeLogPath({
  useLibraryDefaultLogPath: runtimeHost.useLibraryDefaultLogPath,
  get logsPath() { return getLogsPath(); },
}, variables.libraryDefaultDir, runtimeHost.logFileName ?? variables.fileName ?? "main.log");

// Rotate each host's file at 5 MB.
log.transports.file.maxSize = 5 * 1024 * 1024;

// --- Persisted settings ---

const VALID_LEVELS: LevelOption[] = ["error", "warn", "info", "verbose", "debug", "silly", false];

const localSettings = createSettingsStore({
  getFilePath: getSettingsPath,
  createDirectory: true,
});

function loadSettings(): Record<string, unknown> {
  return (runtimeHost.settings ?? localSettings).loadSettings();
}

function saveSettings(patch: Record<string, unknown>): void | Promise<void> {
  return (runtimeHost.settings ?? localSettings).saveSettings(patch);
}

// Restore persisted log level, fallback to "warn"
const savedLevel = loadSettings().logLevel as string | undefined;
log.transports.file.level = (savedLevel && VALID_LEVELS.includes(savedLevel as LevelOption))
  ? savedLevel as LevelOption
  : "warn";

// File format: include date, level, and scope
log.transports.file.format =
  "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}";

// Console transport: only show info and above (suppress debug/verbose noise)
log.transports.console.level = "info";
log.transports.console.format = "%c{h}:{i}:{s}.{ms}%c [{level}]{scope} › {text}";

// Catch unhandled errors and rejections, log them to file.
// Use onError to suppress EPIPE errors — these are harmless pipe-break signals
// from child processes (engine CLIs) that exit before the parent finishes writing.
// Without this filter, electron-log's default handler shows an error dialog to
// the user on every EPIPE, even though the app's own uncaughtException listener
// (in index.ts) already handles them gracefully.
log.errorHandler.startCatching({
  onError({ error }) {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") {
      return false; // Suppress: don't log, don't show dialog
    }
  },
});

// Log Electron lifecycle events (crashes, gpu-process-gone, etc.)
log.eventLogger.startLogging();

// --- Runtime log level management ---

/** Get the current file transport log level */
export function getFileLogLevel(): string {
  return String(log.transports.file.level ?? "warn");
}

/** Set the file transport log level at runtime and persist to disk */
export function setFileLogLevel(level: string): void | Promise<void> {
  if (VALID_LEVELS.includes(level as LevelOption)) {
    log.transports.file.level = level as LevelOption;
    return saveSettings({ logLevel: level });
  }
}

/** Get the resolved log file path */
export function getLogFilePath(): string {
  const file = log.transports.file.getFile();
  return file?.path ?? "";
}

// --- Generic settings access (for other modules) ---

export { loadSettings, saveSettings };

/** Read the user-configured default engine type from settings.json. */
export function getDefaultEngineFromSettings(): string {
  const settings = loadSettings();
  const value = settings?.defaultEngine;
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return "opencode";
}

// Export pre-configured scoped loggers for each module.
// Usage: import { mainLog } from "../services/logger";
//        mainLog.info("message");

export const mainLog = log.scope("main");
export const gatewayLog = log.scope("gateway");
export const engineManagerLog = log.scope("engine-mgr");
export const openCodeLog = log.scope("opencode");
export const copilotLog = log.scope("copilot");
export const claudeLog = log.scope("claude");
export const authLog = log.scope("auth");
export const prodServerLog = log.scope("prod-server");
export const conversationStoreLog = log.scope("conv-store");
export const deviceStoreLog = log.scope("device-store");
export const tunnelLog = log.scope("tunnel");
export const windowLog = log.scope("window");
export const channelLog = log.scope("channel");
export const feishuLog = log.scope("feishu");
export const larkLog = log.scope("lark");
export const dingtalkLog = log.scope("dingtalk");
export const telegramLog = log.scope("telegram");
export const wecomLog = log.scope("wecom");
export const teamsLog = log.scope("teams");
export const codexLog = log.scope("codex");
export const scheduledTaskLog = log.scope("sched-task");
export const terminalLog = log.scope("terminal");

export type ScopedLogger = Pick<
  typeof feishuLog,
  "error" | "warn" | "info" | "verbose" | "debug" | "silly"
>;

export function getFeishuChannelLog(platform: "feishu" | "lark" = "feishu"): ScopedLogger {
  return platform === "lark" ? larkLog : feishuLog;
}

// Re-export the root logger for ad-hoc usage and renderer log forwarding
export default log;
