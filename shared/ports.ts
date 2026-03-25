/**
 * Centralized port configuration for all CodeMux services.
 * Change ports here — all code references this single source of truth.
 *
 * NOTE: A few build-tool config files (electron.vite.config.ts, vite.config.ts,
 * playwright.config.ts) still hard-code these values because they are top-level
 * static objects that rarely change. If you update a port here, grep for the old
 * value in those files as well.
 */

/** Electron-Vite dev server / Production HTTP server */
export const WEB_PORT = 8233;

/** Standalone Vite dev server (npm run dev:web) */
export const WEB_STANDALONE_PORT = 8234;

/** Gateway WebSocket server */
export const GATEWAY_PORT = 4200;

/** OpenCode engine API server */
export const OPENCODE_PORT = 4096;

/** Auth API server (dev-only, not started in packaged mode) */
export const AUTH_API_PORT = 4097;

/** Third-party webhook receiver (Telegram, WeCom, Teams, etc.) */
export const WEBHOOK_PORT = 4098;
