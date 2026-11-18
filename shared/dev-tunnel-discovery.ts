import { DevTunnelError, getDevTunnelPath, parseDevTunnelJson, parseDevTunnelList, runDevTunnelCommand, type DevTunnelCommandOptions } from "./dev-tunnel-cli";
import { CODEMUX_TUNNEL_LABELS, CODEMUX_WEB_PORT_LABEL, readDevTunnelUrl, type DevTunnelDiscoveryResult, type DiscoveredDevTunnel } from "./dev-tunnel-metadata";

interface TunnelSummary {
  tunnelId?: string;
  labels?: string[];
  description?: string;
  hostConnections?: number;
  ports?: { portNumber: number; protocol?: string; portUri?: string }[];
}

interface DiscoveryOptions {
  getPath?: () => string | undefined;
  command?: typeof runDevTunnelCommand;
}

/** Desktop-only, read-only discovery. Never adopts or modifies a discovered tunnel. */
export class DevTunnelDiscovery {
  private active?: { abort: AbortController; work: Promise<DevTunnelDiscoveryResult> };
  private readonly getPath: () => string | undefined;
  private readonly command: typeof runDevTunnelCommand;

  constructor(options: DiscoveryOptions = {}) {
    this.getPath = options.getPath ?? getDevTunnelPath;
    this.command = options.command ?? runDevTunnelCommand;
  }

  discover(interactive: boolean): Promise<DevTunnelDiscoveryResult> {
    if (this.active) return this.active.abort.signal.aborted
      ? this.active.work.then(() => this.discover(interactive))
      : this.active.work;
    const executable = this.getPath();
    if (!executable) return Promise.resolve({ status: "unavailable", tunnels: [] });
    const abort = new AbortController();
    const work = this.run(executable, interactive, abort.signal).then(
      tunnels => ({ status: "ready" as const, tunnels }),
      error => ({
        status: error instanceof DevTunnelError && error.code === "DEVTUNNEL_LOGIN_REQUIRED" ? "loginRequired" as const : "error" as const,
        tunnels: [],
        errorCode: error instanceof DevTunnelError ? error.code : "DEVTUNNEL_COMMAND_FAILED",
      }),
    ).finally(() => { if (this.active?.abort === abort) this.active = undefined; });
    this.active = { abort, work };
    return work;
  }

  async cancel(): Promise<void> {
    const active = this.active;
    active?.abort.abort();
    await active?.work;
  }

  private async run(executable: string, interactive: boolean, signal: AbortSignal): Promise<DiscoveredDevTunnel[]> {
    const command = (args: string[], options?: Partial<DevTunnelCommandOptions>) =>
      this.command(executable, args, { ...options, signal });
    const login = async () => {
      await command(["user", "login", "--entra", "--use-browser-auth"], { login: true });
    };
    const read = async () => {
      const user = parseDevTunnelJson<{ status?: string; objectId?: string }>(await command(["user", "show", "--json"]));
      if (user?.status !== "Logged in" || !user.objectId) {
        throw new DevTunnelError("DEVTUNNEL_LOGIN_REQUIRED", "Interactive Microsoft login is required.");
      }
      const summaries = parseDevTunnelList<TunnelSummary>(await command([
        "list", ...CODEMUX_TUNNEL_LABELS.flatMap(label => ["--all-labels", label]), "--json",
      ]));
      const found: DiscoveredDevTunnel[] = [];
      const seen = new Set<string>();
      for (const summary of summaries) {
        signal.throwIfAborted();
        const id = summary?.tunnelId;
        if (typeof id !== "string" || !/^codemux-[a-f0-9-]+\.[a-z0-9]+$/.test(id) || seen.has(id) ||
          !Array.isArray(summary.labels) || !CODEMUX_TUNNEL_LABELS.every(label => summary.labels!.includes(label))) continue;
        seen.add(id);
        const tunnel = parseDevTunnelJson<{ tunnel?: TunnelSummary }>(await command(["show", id, "--json"])).tunnel;
        if (tunnel?.tunnelId !== id || !Array.isArray(tunnel.labels) ||
          !CODEMUX_TUNNEL_LABELS.every(label => tunnel.labels!.includes(label)) ||
          !Array.isArray(tunnel.ports) || tunnel.ports.length !== 1) continue;
        const port = tunnel.ports[0];
        if (!port || !Number.isInteger(port.portNumber) || port.portNumber < 1 || port.portNumber > 65535 ||
          !["http", "https"].includes(port.protocol ?? "")) continue;
        // `show` omits port labels; only `port show` returns them.
        const details = parseDevTunnelJson<{ port?: { tunnelId?: string; portNumber?: number; labels?: string[] } }>(
          await command(["port", "show", id, "--port-number", String(port.portNumber), "--json"]),
        ).port;
        if (details?.tunnelId !== id || details.portNumber !== port.portNumber ||
          !Array.isArray(details.labels) || !details.labels.includes(CODEMUX_WEB_PORT_LABEL)) continue;
        const candidate = typeof port.portUri === "string" ? readDevTunnelUrl(port.portUri) : undefined;
        // The service's public DNS alias can differ from the user-supplied tunnel ID.
        const cluster = id.split(".")[1];
        const url = candidate && new URL(candidate).hostname.endsWith(`-${port.portNumber}.${cluster}.devtunnels.ms`) ? candidate : undefined;
        found.push({
          tunnelId: id,
          name: typeof tunnel.description === "string" && tunnel.description.trim() ? tunnel.description.trim().slice(0, 100) : id,
          online: typeof tunnel.hostConnections === "number" && tunnel.hostConnections > 0,
          ...(url ? { url } : {}),
        });
      }
      signal.throwIfAborted();
      return found.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name) || a.tunnelId.localeCompare(b.tunnelId));
    };
    try { return await read(); }
    catch (error) {
      if (!interactive || signal.aborted || !(error instanceof DevTunnelError) || error.code !== "DEVTUNNEL_LOGIN_REQUIRED") throw error;
      await login();
      return read();
    }
  }
}
