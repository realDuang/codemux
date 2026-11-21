import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface AgentHostEndpoint {
  source: string;
  type: "editor" | "standalone";
  instanceId: string;
  pid: number;
  transport: { type: "socket"; path: string } | { type: "tcp"; host: string; port: number };
  token: string;
}

export function agentHostEndpointKey(endpoint: AgentHostEndpoint): string {
  return `${endpoint.source}:${endpoint.type}:${endpoint.pid}:${endpoint.instanceId}`;
}

export function defaultUserDataPaths(): string[] {
  const base = process.platform === "win32" ? process.env.APPDATA
    : process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
      : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return base ? ["Code", "Code - Insiders"].map(name => join(base, name)) : [];
}

export function parseEndpoint(value: unknown, source: string, platform = process.platform): AgentHostEndpoint | undefined {
  if (!value || typeof value !== "object") return;
  const entry = value as Record<string, unknown>;
  const endpoint = entry.endpoint as Record<string, unknown> | undefined;
  if (entry.schemaVersion !== 2 || (entry.type !== "editor" && entry.type !== "standalone")
    || !Number.isSafeInteger(entry.pid) || Number(entry.pid) <= 0
    || typeof entry.instanceId !== "string" || !entry.instanceId
    || typeof entry.connectionToken !== "string" || !/^[\w-]{20,200}$/.test(entry.connectionToken)) return;
  let transport: AgentHostEndpoint["transport"];
  if (endpoint?.type === "socket" && typeof endpoint.path === "string") {
    if (platform === "win32" ? !/^\\\\\.\\pipe\\vscode-agent-host-[\w.-]+$/.test(endpoint.path)
      : !isAbsolute(endpoint.path)) return;
    transport = { type: "socket", path: endpoint.path };
  } else if (endpoint?.type === "tcp" && typeof endpoint.host === "string"
    && ["127.0.0.1", "::1", "localhost"].includes(endpoint.host)
    && Number.isSafeInteger(endpoint.port) && Number(endpoint.port) > 0 && Number(endpoint.port) <= 65535) {
    transport = { type: "tcp", host: endpoint.host, port: Number(endpoint.port) };
  } else return;
  return { source, type: entry.type, instanceId: entry.instanceId, pid: Number(entry.pid), transport, token: entry.connectionToken };
}

async function readRegistryFile(file: string, maxSize: number): Promise<unknown> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > maxSize || (process.getuid && stat.uid !== process.getuid())) return;
    return JSON.parse(await readFile(file, "utf8"));
  } catch { return; }
}

/** Read the current OS user's registry; accept only authenticated local transports. */
export async function discoverAgentHosts(paths = defaultUserDataPaths()): Promise<AgentHostEndpoint[]> {
  const endpoints = new Map<string, AgentHostEndpoint>();
  for (const root of paths) {
    if (!isAbsolute(root)) continue;
    try {
      const canonical = await realpath(root);
      const source = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex");
      const directory = join(canonical, "agent-host", "local-endpoint");
      const addEntry = async (value: unknown) => {
        try {
          const endpoint = parseEndpoint(value, source);
          if (!endpoint) return;
          process.kill(endpoint.pid, 0);
          if (process.platform !== "win32" && endpoint.transport.type === "socket") {
            const socket = await lstat(endpoint.transport.path);
            if (!socket.isSocket() || (process.getuid && socket.uid !== process.getuid())) return;
          }
          endpoints.set(agentHostEndpointKey(endpoint), endpoint);
        } catch { /* Stale entries and partially written registry files are not hosts. */ }
      };
      const legacy = await readRegistryFile(join(directory, "metadata.json"), 2 * 1024 * 1024);
      if (Array.isArray(legacy)) for (const entry of legacy) await addEntry(entry);
      const entries = join(directory, "entries");
      for (const name of (await readdir(entries).catch(() => [])).filter(name => name.endsWith(".json"))) {
        await addEntry(await readRegistryFile(join(entries, name), 64 * 1024));
      }
    } catch { /* An editor or profile may not be installed. */ }
  }
  return [...endpoints.values()];
}
