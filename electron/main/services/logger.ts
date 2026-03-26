import log from "electron-log/main";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";
import type { LevelOption } from "electron-log";

// Configure electron-log for the main process.
// All logs (main + renderer forwarded via WebSocket) go to a single file.

// File transport: write to {userData}/logs/main.log
log.transports.file.resolvePathFn = (variables) => {
  // Use Electron's standard logs directory when running as packaged app,
  // otherwise fallback to the default library directory.
  const dir = app.isPackaged
    ? app.getPath("logs")
    : variables.libraryDefaultDir;
  return path.join(dir, variables.fileName ?? "main.log");
};

// Rotate at 5 MB, keep the old file as main.old.log
log.transports.file.maxSize = 5 * 1024 * 1024;

// --- Persisted settings ---

const VALID_LEVELS: LevelOption[] = ["error", "warn", "info", "verbose", "debug", "silly", false];

function getSettingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(getSettingsPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveSettings(patch: Record<string, unknown>): void {
  const existing = loadSettings();
  // Deep merge: for object-valued keys, merge nested properties instead of replacing
  const settings = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)
        && existing[key] && typeof existing[key] === "object" && !Array.isArray(existing[key])) {
      settings[key] = { ...(existing[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      settings[key] = value;
    }
  }
  const filePath = getSettingsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
  fs.renameSync(tmpPath, filePath);
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
export function setFileLogLevel(level: string): void {
  if (VALID_LEVELS.includes(level as LevelOption)) {
    log.transports.file.level = level as LevelOption;
    saveSettings({ logLevel: level });
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
export const dingtalkLog = log.scope("dingtalk");
export const telegramLog = log.scope("telegram");
export const wecomLog = log.scope("wecom");
export const teamsLog = log.scope("teams");
export const scheduledTaskLog = log.scope("sched-task");

// Re-export the root logger for ad-hoc usage and renderer log forwarding
export default log;
