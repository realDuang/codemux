import { DevTunnelDiscovery } from "./dev-tunnel-discovery";
import { DevTunnelError, getDevTunnelPath, parseDevTunnelJson, runDevTunnelCommand } from "./dev-tunnel-cli";
import { readDevTunnelUrl } from "./dev-tunnel-metadata";

interface ClientAuthOptions {
  discovery?: Pick<DevTunnelDiscovery, "discover" | "cancel">;
  getPath?: typeof getDevTunnelPath;
  command?: typeof runDevTunnelCommand;
}

/** One connection owns these credentials; nothing is persisted or sent to the renderer. */
export class DevTunnelClientAuth {
  private readonly discovery: Pick<DevTunnelDiscovery, "discover" | "cancel">;
  private readonly getPath: typeof getDevTunnelPath;
  private readonly command: typeof runDevTunnelCommand;
  private readonly abort = new AbortController();
  private executable?: string;
  private tunnelId?: string;
  private cached?: { token: string; expiresAt: number };
  private pending?: Promise<string>;

  constructor(options: ClientAuthOptions = {}) {
    this.discovery = options.discovery ?? new DevTunnelDiscovery();
    this.getPath = options.getPath ?? getDevTunnelPath;
    this.command = options.command ?? runDevTunnelCommand;
  }

  async prepare(origin: string): Promise<boolean> {
    this.abort.signal.throwIfAborted();
    const url = readDevTunnelUrl(origin);
    this.executable = this.getPath();
    if (!url || !this.executable) return false;
    const result = await this.discovery.discover(true);
    this.abort.signal.throwIfAborted();
    if (result.status === "unavailable") return false;
    if (result.status !== "ready") {
      throw new DevTunnelError(result.errorCode ?? "DEVTUNNEL_LOGIN_REQUIRED", "Dev Tunnels account authentication failed. Reconnect to retry system sign-in.");
    }
    // Public DNS aliases are not tunnel IDs. Resolve only through verified account metadata.
    const tunnel = result.tunnels.find(tunnel => tunnel.url === url);
    if (!tunnel) return false;
    this.tunnelId = tunnel.tunnelId;
    await this.authorization();
    return true;
  }

  authorization(): Promise<string> {
    if (this.abort.signal.aborted) return Promise.reject(new Error("Connection cancelled"));
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000) {
      return Promise.resolve(`tunnel ${this.cached.token}`);
    }
    if (this.pending) return this.pending;
    const work = this.issueToken();
    this.pending = work;
    void work.finally(() => { if (this.pending === work) this.pending = undefined; }).catch(() => {});
    return work;
  }

  private async issueToken(): Promise<string> {
    if (!this.executable || !this.tunnelId) throw new Error("Dev Tunnels connection is not prepared");
    const output = await this.command(this.executable, ["token", this.tunnelId, "--scope", "connect", "--json"], { signal: this.abort.signal });
    this.abort.signal.throwIfAborted();
    const result = parseDevTunnelJson<{ token?: unknown; expiration?: unknown }>(output);
    const expiresAt = typeof result?.expiration === "string" ? Date.parse(result.expiration) : NaN;
    if (typeof result?.token !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.token) ||
      !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000) {
      throw new DevTunnelError("DEVTUNNEL_COMMAND_FAILED", "Dev Tunnels returned an invalid connection credential.");
    }
    this.cached = { token: result.token, expiresAt };
    return `tunnel ${result.token}`;
  }

  async close(): Promise<void> {
    this.abort.abort();
    this.cached = undefined;
    await Promise.allSettled([this.discovery.cancel(), this.pending]);
  }
}
