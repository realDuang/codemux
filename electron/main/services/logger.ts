import log from "electron-log/main";
import { app } from "electron";
import path from "node:path";
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

// Default file log level: warn (only warn + error written to file)
log.transports.file.level = "warn";

// File format: include date, level, and scope
log.transports.file.format =
  "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}";

// Console transport: keep default behavior (prints to terminal / DevTools)
log.transports.console.format = "%c{h}:{i}:{s}.{ms}%c [{level}]{scope} › {text}";

// Catch unhandled errors and rejections, log them to file
log.errorHandler.startCatching();

// Log Electron lifecycle events (crashes, gpu-process-gone, etc.)
log.eventLogger.startLogging();

// --- Runtime log level management ---

/** Get the current file transport log level */
export function getFileLogLevel(): string {
  return String(log.transports.file.level ?? "warn");
}

/** Set the file transport log level at runtime */
export function setFileLogLevel(level: string): void {
  const valid: LevelOption[] = ["error", "warn", "info", "verbose", "debug", "silly", false];
  if (valid.includes(level as LevelOption)) {
    log.transports.file.level = level as LevelOption;
  }
}

/** Get the resolved log file path */
export function getLogFilePath(): string {
  const file = log.transports.file.getFile();
  return file?.path ?? "";
}

// Export pre-configured scoped loggers for each module.
// Usage: import { mainLog } from "../services/logger";
//        mainLog.info("message");

export const mainLog = log.scope("main");
export const gatewayLog = log.scope("gateway");
export const engineManagerLog = log.scope("engine-mgr");
export const acpLog = log.scope("acp");
export const openCodeLog = log.scope("opencode");
export const copilotLog = log.scope("copilot");
export const authLog = log.scope("auth");
export const prodServerLog = log.scope("prod-server");
export const sessionStoreLog = log.scope("session-store");
export const deviceStoreLog = log.scope("device-store");
export const tunnelLog = log.scope("tunnel");
export const windowLog = log.scope("window");

// Re-export the root logger for ad-hoc usage and renderer log forwarding
export default log;
