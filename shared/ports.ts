/** Centralized port configuration for all CodeMux services. */

const MAX_TCP_PORT = 65_535;

export const DEFAULT_WEB_PORT = 8233;
export const DEFAULT_WEB_STANDALONE_PORT = 8234;
export const DEFAULT_GATEWAY_PORT = 4200;
export const DEFAULT_OPENCODE_PORT = 4096;
export const DEFAULT_AUTH_API_PORT = 4097;
export const DEFAULT_WEBHOOK_PORT = 4098;

const DEFAULT_PORTS = {
  CODEMUX_WEB_PORT: DEFAULT_WEB_PORT,
  CODEMUX_WEB_STANDALONE_PORT: DEFAULT_WEB_STANDALONE_PORT,
  CODEMUX_GATEWAY_PORT: DEFAULT_GATEWAY_PORT,
  CODEMUX_OPENCODE_PORT: DEFAULT_OPENCODE_PORT,
  CODEMUX_AUTH_API_PORT: DEFAULT_AUTH_API_PORT,
  CODEMUX_WEBHOOK_PORT: DEFAULT_WEBHOOK_PORT,
} as const;

export const MAX_PORT_OFFSET = MAX_TCP_PORT - Math.max(...Object.values(DEFAULT_PORTS));

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env?.[name];
}

function readNumberEnv(name: string): number | undefined {
  const value = readEnv(name);
  if (!value) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function validatePort(name: string, port: number): number {
  if (port < 1 || port > MAX_TCP_PORT) {
    throw new Error(`${name} must be between 1 and ${MAX_TCP_PORT}, got ${port}`);
  }
  return port;
}

function readPortEnv(name: keyof typeof DEFAULT_PORTS, fallback: number): number {
  const parsed = readNumberEnv(name);
  return validatePort(name, parsed ?? fallback);
}

function readPortOffset(): number {
  const parsed = readNumberEnv("CODEMUX_PORT_OFFSET");
  if (parsed === undefined) return 0;
  if (parsed < 0 || parsed > MAX_PORT_OFFSET) {
    throw new Error(
      `CODEMUX_PORT_OFFSET must be between 0 and ${MAX_PORT_OFFSET}, got ${parsed}. `
      + "Large offsets push default CodeMux ports outside the valid TCP port range.",
    );
  }
  return parsed;
}

function validateDistinctPorts(ports: Record<string, number>): void {
  const seen = new Map<number, string>();
  for (const [name, port] of Object.entries(ports)) {
    const existing = seen.get(port);
    if (existing) {
      throw new Error(`${name} and ${existing} both resolve to port ${port}; CodeMux service ports must be distinct`);
    }
    seen.set(port, name);
  }
}

export const PORT_OFFSET = readPortOffset();

const resolvedPorts = {
  WEB_PORT: readPortEnv("CODEMUX_WEB_PORT", DEFAULT_WEB_PORT + PORT_OFFSET),
  WEB_STANDALONE_PORT: readPortEnv("CODEMUX_WEB_STANDALONE_PORT", DEFAULT_WEB_STANDALONE_PORT + PORT_OFFSET),
  GATEWAY_PORT: readPortEnv("CODEMUX_GATEWAY_PORT", DEFAULT_GATEWAY_PORT + PORT_OFFSET),
  OPENCODE_PORT: readPortEnv("CODEMUX_OPENCODE_PORT", DEFAULT_OPENCODE_PORT + PORT_OFFSET),
  AUTH_API_PORT: readPortEnv("CODEMUX_AUTH_API_PORT", DEFAULT_AUTH_API_PORT + PORT_OFFSET),
  WEBHOOK_PORT: readPortEnv("CODEMUX_WEBHOOK_PORT", DEFAULT_WEBHOOK_PORT + PORT_OFFSET),
};

validateDistinctPorts(resolvedPorts);

/** Electron-Vite dev server / Production HTTP server */
export const WEB_PORT = resolvedPorts.WEB_PORT;

/** Standalone Vite dev server (npm run dev:web) */
export const WEB_STANDALONE_PORT = resolvedPorts.WEB_STANDALONE_PORT;

/** Gateway WebSocket server */
export const GATEWAY_PORT = resolvedPorts.GATEWAY_PORT;

/** OpenCode engine API server */
export const OPENCODE_PORT = resolvedPorts.OPENCODE_PORT;

/** Auth API server (dev-only, not started in packaged mode) */
export const AUTH_API_PORT = resolvedPorts.AUTH_API_PORT;

/** Third-party webhook receiver (Telegram, WeCom, Teams, etc.) */
export const WEBHOOK_PORT = resolvedPorts.WEBHOOK_PORT;
