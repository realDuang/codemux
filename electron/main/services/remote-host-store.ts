import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeRemoteHostInput, type RemoteHostInput, type SavedRemoteHost } from "../../../shared/remote-hosts";

const HOST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function clone(host: SavedRemoteHost): SavedRemoteHost {
  return { ...host, connection: { ...host.connection } };
}

function validPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65_535;
}

function readHost(value: unknown): SavedRemoteHost | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["id", "name", "connection", "createdAt", "updatedAt", "localPort"].includes(key))
    || typeof row.id !== "string" || !HOST_ID.test(row.id) || typeof row.name !== "string"
    || typeof row.createdAt !== "number" || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0
    || typeof row.updatedAt !== "number" || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < row.createdAt
    || (row.localPort !== undefined && !validPort(row.localPort))) return;
  try {
    const normalized = normalizeRemoteHostInput({ name: row.name, connection: row.connection });
    return {
      id: row.id, name: normalized.name!, connection: normalized.connection,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
      ...(normalized.connection.type === "ssh" && validPort(row.localPort) ? { localPort: row.localPort } : {}),
    };
  } catch { return; }
}

/** Desktop-owned connection preferences are independent of the local service settings writer. */
export class RemoteHostStore {
  private readonly filePath: string;
  private hosts: SavedRemoteHost[] = [];
  private loadError: unknown;

  constructor(dataPath: string) {
    if (!path.isAbsolute(dataPath)) throw new Error("Remote host data path must be absolute.");
    this.filePath = path.join(dataPath, "remote-hosts.json");
    try { this.load(); } catch (error) { this.loadError = error; }
  }

  private ensureLoaded(): void {
    if (this.loadError) throw this.loadError;
  }

  list(): SavedRemoteHost[] { this.ensureLoaded(); return this.hosts.map(clone); }

  get(id: string): SavedRemoteHost | undefined {
    this.ensureLoaded();
    const host = this.hosts.find(host => host.id === id);
    return host ? clone(host) : undefined;
  }

  save(input: RemoteHostInput, id?: string): SavedRemoteHost {
    this.ensureLoaded();
    const normalized = normalizeRemoteHostInput(input);
    const previous = id === undefined ? undefined : this.hosts.find(host => host.id === id);
    if (id !== undefined && !previous) throw new Error("Remote host was not found.");
    const now = Date.now();
    const host: SavedRemoteHost = {
      id: previous?.id ?? randomUUID(), name: normalized.name!, connection: normalized.connection,
      createdAt: previous?.createdAt ?? now, updatedAt: Math.max(now, previous?.updatedAt ?? now),
      ...(previous?.connection.type === "ssh" && normalized.connection.type === "ssh" && previous.localPort
        ? { localPort: previous.localPort } : {}),
    };
    this.persist(previous ? this.hosts.map(entry => entry.id === id ? host : entry) : [...this.hosts, host]);
    return clone(host);
  }

  remove(id: string): boolean {
    this.ensureLoaded();
    if (!this.hosts.some(host => host.id === id)) return false;
    this.persist(this.hosts.filter(host => host.id !== id));
    return true;
  }

  setLocalPort(id: string, port: number): SavedRemoteHost {
    this.ensureLoaded();
    if (!validPort(port)) throw new Error("Local port must be between 1 and 65535.");
    const previous = this.hosts.find(host => host.id === id);
    if (!previous || previous.connection.type !== "ssh") throw new Error("SSH host was not found.");
    const host = { ...previous, localPort: port };
    this.persist(this.hosts.map(entry => entry.id === id ? host : entry));
    return clone(host);
  }

  private load(): void {
    let raw: string;
    try { raw = fs.readFileSync(this.filePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("Saved remote hosts could not be read.", { cause: error });
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      const container = value as Record<string, unknown>;
      if (container.version !== 1 || !Array.isArray(container.hosts)) throw new Error();
      const ids = new Set<string>();
      this.hosts = container.hosts.flatMap(entry => {
        const host = readHost(entry);
        if (!host || ids.has(host.id)) return [];
        ids.add(host.id);
        return [host];
      });
    } catch {
      throw new Error("Saved remote hosts have an invalid format. Keep the file for recovery before replacing it.");
    }
  }

  private persist(hosts: SavedRemoteHost[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.filePath);
      this.hosts = hosts;
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* A completed rename already removed the temporary file. */ }
    }
  }
}
