export type RemoteHostConnection =
  | { type: "direct"; host: string; port: number; useTls: boolean }
  | { type: "ssh"; address: string; remotePort: number };

export interface RemoteHostInput {
  name?: string;
  connection: RemoteHostConnection;
}

export interface SavedRemoteHost {
  id: string;
  name: string;
  connection: RemoteHostConnection;
  createdAt: number;
  updatedAt: number;
  localPort?: number;
}

export interface RemoteHostState extends SavedRemoteHost {
  status: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
}

export interface ParsedSshAddress {
  destination: string;
  port?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function normalizeDirectHost(value: unknown): string {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value) || /[\x20/\\@?#%]/.test(value.trim())) {
    throw new Error("Enter a hostname or IP address without a URL, credentials, or path.");
  }
  const host = value.trim();
  if (!host || host.length > 253 || /^[.-]/.test(host)) throw new Error("Enter a valid hostname or IP address.");
  try {
    const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    const url = new URL(`http://${authority}`);
    if (url.port || !url.hostname || url.pathname !== "/" || url.username || url.password) throw new Error();
    if (!url.hostname.startsWith("[") && !/^[a-z0-9_][a-z0-9_.-]*$/i.test(url.hostname)) throw new Error();
    return url.hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw new Error("Enter a valid hostname or IP address without a port.");
  }
}

/** Parse only SSH destinations; arbitrary shell commands and URL credentials are unsupported. */
export function parseSshAddress(address: string): ParsedSshAddress {
  if (typeof address !== "string" || /[\x00-\x1f\x7f]/.test(address)) throw new Error("Enter a valid SSH address.");
  let value = address.trim();
  if (!value || value.length > 512 || /[\s\\?#%$`'";&|<>]/.test(value)) throw new Error("Enter a valid SSH address.");
  if (/^ssh:\/\//i.test(value)) value = value.slice(6).replace(/\/$/, "");
  if (value.includes("/")) throw new Error("SSH addresses cannot include a path.");

  const parts = value.split("@");
  if (parts.length > 2) throw new Error("Enter a valid SSH address.");
  const user = parts.length === 2 ? parts[0] : undefined;
  if (user !== undefined && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(user)) {
    throw new Error("Enter a valid SSH user without a password.");
  }
  let host = parts[parts.length - 1];
  let port: number | undefined;
  const bracketed = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(host);
  if (host.startsWith("[")) {
    if (!bracketed) throw new Error("Enter a valid bracketed IPv6 SSH address.");
    host = bracketed[1];
    if (bracketed[2] !== undefined) port = Number(bracketed[2]);
    try { if (!new URL(`http://[${host}]`).hostname) throw new Error(); }
    catch { throw new Error("Enter a valid IPv6 SSH address."); }
  } else if (host.includes(":")) {
    const separator = host.indexOf(":");
    if (separator !== host.lastIndexOf(":")) throw new Error("Use brackets around an IPv6 SSH address.");
    const portText = host.slice(separator + 1);
    if (!/^\d+$/.test(portText)) throw new Error("Enter a valid SSH port.");
    port = Number(portText);
    host = host.slice(0, separator);
  }
  if (!bracketed && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(host)) throw new Error("Enter a valid SSH host or config alias.");
  if (port !== undefined && !validPort(port)) throw new Error("SSH port must be between 1 and 65535.");

  return { destination: user ? `${user}@${host}` : host, ...(port === undefined ? {} : { port }) };
}

export function normalizeRemoteHostInput(input: unknown): RemoteHostInput {
  if (!record(input) || Object.keys(input).some(key => !["name", "connection"].includes(key)) || !record(input.connection)) {
    throw new Error("Invalid remote host configuration.");
  }
  const source = input.connection;
  let connection: RemoteHostConnection;
  if (source.type === "direct") {
    if (Object.keys(source).some(key => !["type", "host", "port", "useTls"].includes(key)) || !validPort(source.port) || typeof source.useTls !== "boolean") {
      throw new Error("Enter a valid direct connection and a port between 1 and 65535.");
    }
    connection = { type: "direct", host: normalizeDirectHost(source.host), port: source.port, useTls: source.useTls };
  } else if (source.type === "ssh") {
    if (Object.keys(source).some(key => !["type", "address", "remotePort"].includes(key)) || typeof source.address !== "string" || !validPort(source.remotePort)) {
      throw new Error("Enter a valid SSH connection and a remote port between 1 and 65535.");
    }
    parseSshAddress(source.address);
    connection = { type: "ssh", address: source.address.trim(), remotePort: source.remotePort };
  } else throw new Error("Choose Direct or SSH.");

  if (input.name !== undefined && (typeof input.name !== "string" || /[\x00-\x1f\x7f]/.test(input.name) || input.name.trim().length > 100)) {
    throw new Error("Host names must contain at most 100 characters without control characters.");
  }
  const fallback = connection.type === "direct" ? connection.host : connection.address;
  return { name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : fallback.slice(0, 100), connection };
}

export function getDirectHostUrl(connection: Extract<RemoteHostConnection, { type: "direct" }>): string {
  const normalized = normalizeRemoteHostInput({ connection }).connection;
  if (normalized.type !== "direct") throw new Error("A direct connection is required.");
  const host = normalized.host.includes(":") ? `[${normalized.host}]` : normalized.host;
  return new URL(`${normalized.useTls ? "https" : "http"}://${host}:${normalized.port}`).origin;
}
