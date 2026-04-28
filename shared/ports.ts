/** Centralized port configuration for all CodeMux services. */

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env?.[name];
}

function readNumberEnv(name: string): number | undefined {
  const value = readEnv(name);
  if (!value) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return undefined;
  return parsed;
}

function readPortEnv(name: string, fallback: number): number {
  const parsed = readNumberEnv(name);
  if (parsed === undefined || parsed < 1 || parsed > 65_535) return fallback;
  return parsed;
}

function readPortOffset(): number {
  const parsed = readNumberEnv("CODEMUX_PORT_OFFSET");
  if (parsed === undefined || parsed < 0) return 0;
  return parsed;
}

export const DEFAULT_WEB_PORT = 8233;
export const DEFAULT_WEB_STANDALONE_PORT = 8234;
export const DEFAULT_GATEWAY_PORT = 4200;
export const DEFAULT_OPENCODE_PORT = 4096;
export const DEFAULT_AUTH_API_PORT = 4097;
export const DEFAULT_WEBHOOK_PORT = 4098;

export const PORT_OFFSET = readPortOffset();

/** Electron-Vite dev server / Production HTTP server */
export const WEB_PORT = readPortEnv("CODEMUX_WEB_PORT", DEFAULT_WEB_PORT + PORT_OFFSET);

/** Standalone Vite dev server (npm run dev:web) */
export const WEB_STANDALONE_PORT = readPortEnv(
  "CODEMUX_WEB_STANDALONE_PORT",
  DEFAULT_WEB_STANDALONE_PORT + PORT_OFFSET,
);

/** Gateway WebSocket server */
export const GATEWAY_PORT = readPortEnv("CODEMUX_GATEWAY_PORT", DEFAULT_GATEWAY_PORT + PORT_OFFSET);

/** OpenCode engine API server */
export const OPENCODE_PORT = readPortEnv("CODEMUX_OPENCODE_PORT", DEFAULT_OPENCODE_PORT + PORT_OFFSET);

/** Auth API server (dev-only, not started in packaged mode) */
export const AUTH_API_PORT = readPortEnv("CODEMUX_AUTH_API_PORT", DEFAULT_AUTH_API_PORT + PORT_OFFSET);

/** Third-party webhook receiver (Telegram, WeCom, Teams, etc.) */
export const WEBHOOK_PORT = readPortEnv("CODEMUX_WEBHOOK_PORT", DEFAULT_WEBHOOK_PORT + PORT_OFFSET);
