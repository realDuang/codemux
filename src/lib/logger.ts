/**
 * Logger utility with configurable log levels via Vite environment variables.
 *
 * Usage:
 *   import { logger } from '../lib/logger';
 *   logger.debug('[Component] Debug info');
 *   logger.info('[Component] Info message');
 *   logger.warn('[Component] Warning');
 *   logger.error('[Component] Error', error);
 *
 * Configuration:
 *   Set VITE_LOG_LEVEL in .env file or environment:
 *   - 'debug': Show all logs (debug, info, warn, error)
 *   - 'info': Show info, warn, error (default in development)
 *   - 'warn': Show warn and error only
 *   - 'error': Show errors only
 *   - 'none': Disable all logs (default in production)
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "none";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

function getLogLevel(): LogLevel {
  // Read from Vite env variable
  const envLevel = import.meta.env.VITE_LOG_LEVEL as LogLevel | undefined;

  if (envLevel && envLevel in LOG_LEVELS) {
    return envLevel;
  }

  // Default: 'warn' in production, 'info' in development
  return import.meta.env.PROD ? "warn" : "info";
}

function shouldLog(level: LogLevel): boolean {
  const currentLevel = getLogLevel();
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

export const logger = {
  /**
   * Debug level - verbose information for debugging
   * Only shown when VITE_LOG_LEVEL=debug
   */
  debug: (...args: unknown[]) => {
    if (shouldLog("debug")) {
      console.log(...args);
    }
  },

  /**
   * Info level - general information
   * Shown when VITE_LOG_LEVEL=debug or info
   */
  info: (...args: unknown[]) => {
    if (shouldLog("info")) {
      console.log(...args);
    }
  },

  /**
   * Warn level - warnings that don't stop execution
   * Shown when VITE_LOG_LEVEL=debug, info, or warn
   */
  warn: (...args: unknown[]) => {
    if (shouldLog("warn")) {
      console.warn(...args);
    }
  },

  /**
   * Error level - errors and exceptions
   * Always shown unless VITE_LOG_LEVEL=none
   */
  error: (...args: unknown[]) => {
    if (shouldLog("error")) {
      console.error(...args);
    }
  },

  /**
   * Get current log level
   */
  getLevel: (): LogLevel => getLogLevel(),
};
