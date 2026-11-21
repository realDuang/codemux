import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DevTunnelError, getDevTunnelPath, parseDevTunnelJson as parseJson, parseDevTunnelList, runDevTunnelCommand, type DevTunnelCommandOptions } from "./dev-tunnel-cli";
import type { DevTunnelConfig, RemoteAccessTunnelInfo } from "./remote-access";
import { CODEMUX_TUNNEL_LABELS, CODEMUX_WEB_PORT_LABEL } from "./dev-tunnel-metadata";

interface DevTunnelIdentity {
  tunnelId: string;
  owner: string;
  port: number;
}

interface TunnelDetails {
  tunnelId: string;
  hostConnections?: number;
  ports?: { portNumber: number; portUri?: string }[];
}

export interface DevTunnelManagerOptions {
  loadSettings: () => Record<string, unknown>;
  saveSettings: (patch: Record<string, unknown>) => void | Promise<void>;
  getPath?: () => string | undefined;
  command?: (executable: string, args: string[], options: DevTunnelCommandOptions) => Promise<string>;
}

export function devTunnelOrigin(value: string, port: number): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.port && !url.username && !url.password &&
      new RegExp(`^[a-z0-9-]+-${port}(?:\\.[a-z0-9-]+)?\\.devtunnels\\.ms$`).test(url.hostname)) return url.origin;
  } catch { /* Not a tunnel address. */ }
}

/** Owns only the dedicated tunnel identity stored by this CodeMux host. */
export class DevTunnelManager {
  private info: RemoteAccessTunnelInfo = { status: "stopped", url: "" };
  private abort?: AbortController;
  private work?: Promise<void>;
  private onChange?: () => void;
  private needsLogin = false;
  private readonly getPath: () => string | undefined;
  private readonly command: NonNullable<DevTunnelManagerOptions["command"]>;

  constructor(private readonly options: DevTunnelManagerOptions) {
    this.getPath = options.getPath ?? getDevTunnelPath;
    this.command = options.command ?? runDevTunnelCommand;
  }

  isAvailable(): boolean { return !!this.getPath(); }
  getInfo(): RemoteAccessTunnelInfo { return { ...this.info }; }
  setOnChange(listener: () => void): void { this.onChange = listener; }

  private publish(info: RemoteAccessTunnelInfo): void {
    this.info = info;
    this.onChange?.();
  }

  async start(port: number, config: DevTunnelConfig, interactive: boolean): Promise<RemoteAccessTunnelInfo> {
    if (this.abort) return this.getInfo();
    const executable = this.getPath();
    if (!executable) throw new DevTunnelError("DEVTUNNEL_CLI_MISSING", "Install the Microsoft devtunnel CLI first.");
    const abort = new AbortController();
    this.abort = abort;
    this.publish({ status: "starting", url: "", phase: "provisioning", startTime: Date.now() });
    this.work = this.run(executable, port, config, interactive, abort.signal).catch(error => {
      if (abort.signal.aborted) {
        if (error instanceof DevTunnelError && error.code === "DEVTUNNEL_STOP_FAILED") throw error;
        return;
      }
      if (error instanceof DevTunnelError && error.code === "DEVTUNNEL_LOGIN_REQUIRED") this.needsLogin = true;
      this.publish({
        status: "error", url: "",
        error: error instanceof Error ? error.message : "Dev Tunnels failed.",
        errorCode: error instanceof DevTunnelError ? error.code : "DEVTUNNEL_COMMAND_FAILED",
      });
    });
    void this.work.catch(() => undefined);
    return this.getInfo();
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.work;
    this.abort = undefined;
    this.work = undefined;
    this.publish({ status: "stopped", url: "" });
  }

  private async run(executable: string, port: number, config: DevTunnelConfig, interactive: boolean, signal: AbortSignal): Promise<void> {
    const command = (args: string[]) => this.command(executable, args, { signal });
    const getUser = async () => {
      try {
        return parseJson<{ status?: string; provider?: string; objectId?: string; tenantId?: string }>(
          await command(["user", "show", "--json"]),
        );
      } catch (error) {
        if (error instanceof DevTunnelError && error.code === "DEVTUNNEL_LOGIN_REQUIRED") return {};
        throw error;
      }
    };
    let user = await getUser();
    if (this.needsLogin || user.status !== "Logged in" || !user.objectId) {
      if (!interactive) throw new DevTunnelError("DEVTUNNEL_LOGIN_REQUIRED", "Sign in interactively to Microsoft Dev Tunnels, then retry.");
      this.publish({ ...this.info, phase: "login" });
      await this.command(executable, ["user", "login", "--entra", "--use-browser-auth"], { signal, login: true });
      user = await getUser();
      if (user.status !== "Logged in" || !user.objectId) {
        throw new DevTunnelError("DEVTUNNEL_LOGIN_REQUIRED", "Microsoft Dev Tunnels login was not completed.");
      }
      this.needsLogin = false;
    }
    if (config.access === "tenant" && (user.provider !== "microsoft" || !user.tenantId)) {
      throw new DevTunnelError("DEVTUNNEL_TENANT_REQUIRED", "Tenant access requires a Microsoft Entra work or school account.");
    }
    this.publish({ ...this.info, phase: "provisioning" });
    const owner = createHash("sha256").update(`${user.provider}:${user.tenantId}:${user.objectId}`).digest("hex");
    const saved = this.options.loadSettings().devTunnelIdentity as DevTunnelIdentity | undefined;
    let identity: DevTunnelIdentity;
    if (saved && /^codemux-[a-f0-9-]+(?:\.[a-z0-9]+)?$/.test(saved.tunnelId) && saved.owner === owner && saved.port === port) {
      identity = saved;
    } else {
      identity = { tunnelId: `codemux-${randomUUID()}`, owner, port };
      await this.options.saveSettings({ devTunnelIdentity: identity });
    }
    signal.throwIfAborted();
    const listed = parseDevTunnelList<TunnelDetails>(await command(["list", "--json"]));
    const existing = listed.find(tunnel => tunnel.tunnelId === identity.tunnelId ||
      tunnel.tunnelId.split(".")[0] === identity.tunnelId);
    let tunnel: TunnelDetails;
    if (existing) {
      tunnel = parseJson<{ tunnel: TunnelDetails }>(await command(["show", existing.tunnelId, "--json"])).tunnel;
      if (tunnel.hostConnections) throw new DevTunnelError("DEVTUNNEL_ALREADY_HOSTED", "This CodeMux tunnel is already hosted by another process.");
    } else {
      tunnel = parseJson<{ tunnel: TunnelDetails }>(await command([
        "create", identity.tunnelId.split(".")[0], "--expiration", "30d", "--description", config.name || "CodeMux remote access",
        ...CODEMUX_TUNNEL_LABELS.flatMap(label => ["--labels", label]), "--json",
      ])).tunnel;
    }
    if (!tunnel?.tunnelId || tunnel.tunnelId.split(".")[0] !== identity.tunnelId.split(".")[0]) {
      throw new DevTunnelError("DEVTUNNEL_COMMAND_FAILED", "Unexpected Dev Tunnels identity.");
    }
    identity = { ...identity, tunnelId: tunnel.tunnelId };
    await this.options.saveSettings({ devTunnelIdentity: identity });
    signal.throwIfAborted();
    const id = identity.tunnelId;
    if (tunnel.ports?.some(entry => entry.portNumber !== port)) {
      throw new DevTunnelError("DEVTUNNEL_UNEXPECTED_PORTS", "The CodeMux tunnel has unexpected ports. Remove them with the CLI before retrying.");
    }
    if (!tunnel.ports?.some(entry => entry.portNumber === port)) {
      await command(["port", "create", id, "--port-number", String(port), "--protocol", "http", "--labels", CODEMUX_WEB_PORT_LABEL, "--json"]);
    } else {
      await command(["port", "update", id, "--port-number", String(port), "--add-labels", CODEMUX_WEB_PORT_LABEL]);
    }
    // Reset both levels so a previous anonymous/tenant grant cannot survive a private selection.
    await command(["access", "reset", id]);
    await command(["access", "reset", id, "--port-number", String(port)]);
    if (config.access !== "private") {
      await command(["access", "create", id, config.access === "tenant" ? "--tenant" : "--anonymous", "--scopes", "connect"]);
    }
    await command([
      "update", id, "--expiration", "30d", "--description", config.name || "CodeMux remote access",
      ...CODEMUX_TUNNEL_LABELS.flatMap(label => ["--add-labels", label]),
      "--host-header", "unchanged", "--origin-header", "unchanged",
    ]);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      this.publish({ status: "starting", url: "", phase: "connecting", startTime: Date.now() });
      const deadline = new AbortController();
      const joined = AbortSignal.any([signal, deadline.signal]);
      let ready = false;
      const timer = setTimeout(() => deadline.abort(), 60_000);
      try {
        await this.command(executable, ["host", id, "--host-header", "unchanged", "--origin-header", "unchanged"], {
          signal: joined, timeout: 0,
          onOutput: output => {
            if (joined.aborted) return;
            // A newly created port has no URI until the CLI registers its hosting endpoint.
            const url = (output.match(/https:\/\/[a-z0-9.-]+\.devtunnels\.ms\b/gi) ?? [])
              .map(value => devTunnelOrigin(value, port)).find(Boolean);
            if (!ready && url && /Ready to accept connections/i.test(output)) {
              ready = true;
              clearTimeout(timer);
              this.publish({ status: "running", url, startTime: this.info.startTime });
            }
          },
        });
        if (!signal.aborted) throw new DevTunnelError("DEVTUNNEL_DISCONNECTED", "Dev Tunnels disconnected.");
      } catch (error) {
        if (signal.aborted) throw error;
        if (deadline.signal.aborted) throw new DevTunnelError("DEVTUNNEL_TIMEOUT", "Dev Tunnels did not become ready in time.");
        if (attempt >= 2 || error instanceof DevTunnelError && error.code === "DEVTUNNEL_LOGIN_REQUIRED") throw error;
        this.publish({ status: "starting", url: "", phase: "connecting" });
        await delay(1000 * 2 ** attempt, undefined, { signal });
      } finally { clearTimeout(timer); }
    }
  }
}
