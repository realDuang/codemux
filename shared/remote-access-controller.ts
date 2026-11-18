import { isRemoteAccessRequestAllowed } from "./remote-access-policy";
import type { IncomingMessage } from "node:http";
import { normalizeAccessUrl } from "./access-url";
import {
  isRemoteAccessMode, readCustomAccessUrl, readRemoteAccessMode, readDevTunnelConfig,
  type DevTunnelConfig,
  type RemoteAccessMode, type RemoteAccessStatus, type RemoteAccessTunnelConfig,
  type RemoteAccessTunnelInfo, type RemoteAccessUpdate,
} from "./remote-access";

export interface RemoteAccessControllerOptions {
  loadSettings: () => Record<string, unknown>;
  saveSettings: (patch: Record<string, unknown>) => void | Promise<void>;
  tunnel: {
    start: (port: number, config?: RemoteAccessTunnelConfig) => Promise<RemoteAccessTunnelInfo>;
    stop: () => Promise<void>;
    getInfo: () => RemoteAccessTunnelInfo;
  };
  getPort: () => number;
  cloudflareAvailable?: boolean;
  devTunnel?: {
    start: (port: number, config: DevTunnelConfig, interactive: boolean) => Promise<RemoteAccessTunnelInfo>;
    stop: () => Promise<void>;
    getInfo: () => RemoteAccessTunnelInfo;
    isAvailable: () => boolean;
    setOnChange: (listener: () => void) => void;
  };
}

/** One authority for persisted configuration, tunnel lifecycle, and server admission. */
export class RemoteAccessController {
  private mode: RemoteAccessMode;
  private customAccessUrl: string;
  private tunnelConfig: RemoteAccessTunnelConfig;
  private pending: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(status: RemoteAccessStatus) => void>();
  private initialized: Promise<void> | undefined;
  private devTunnelConfig: DevTunnelConfig;

  constructor(private options: RemoteAccessControllerOptions) {
    const settings = options.loadSettings();
    const savedMode = readRemoteAccessMode(settings);
    this.mode = savedMode === "cloudflare" || savedMode === "devtunnel" ? "off" : savedMode;
    this.customAccessUrl = readCustomAccessUrl(settings);
    const config = settings.tunnelConfig as RemoteAccessTunnelConfig | undefined;
    this.tunnelConfig = { hostname: typeof config?.hostname === "string" ? config.hostname : "" };
    try { this.devTunnelConfig = readDevTunnelConfig(settings.devTunnelConfig); }
    catch { this.devTunnelConfig = { access: "private" }; }
    options.devTunnel?.setOnChange(() => this.notify());
  }

  getStatus(): RemoteAccessStatus {
    const tunnel = { ...(this.mode === "devtunnel" && this.options.devTunnel
      ? this.options.devTunnel.getInfo() : this.options.tunnel.getInfo()) };
    let url = "";
    if (this.mode === "custom") url = this.customAccessUrl;
    if ((this.mode === "cloudflare" || this.mode === "devtunnel") && tunnel.status === "running") url = tunnel.url;
    return {
      mode: this.mode, customAccessUrl: this.customAccessUrl, url, tunnel,
      tunnelConfig: { ...this.tunnelConfig },
      cloudflareAvailable: this.options.cloudflareAvailable !== false,
      devTunnelAvailable: this.options.devTunnel?.isAvailable() ?? false,
      devTunnelConfig: { ...this.devTunnelConfig },
    };
  }

  initialize(): Promise<void> {
    if (!this.initialized) {
      const mode = readRemoteAccessMode(this.options.loadSettings());
      this.initialized = this.enqueue({ mode }, false).then(() => undefined);
    }
    return this.initialized;
  }

  subscribe(listener: (status: RemoteAccessStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isRequestAllowed(req: IncomingMessage, gateway = false): boolean {
    return isRemoteAccessRequestAllowed(req, this.getStatus(), gateway);
  }

  update(patch: RemoteAccessUpdate): Promise<RemoteAccessStatus> {
    return this.enqueue(patch, true);
  }

  async stop(): Promise<void> {
    await this.pending;
    await Promise.all([this.options.tunnel.stop(), this.options.devTunnel?.stop()]);
  }

  private enqueue(patch: RemoteAccessUpdate, interactive: boolean): Promise<RemoteAccessStatus> {
    const next = this.pending.then(() => this.apply(patch, interactive));
    this.pending = next.catch(() => undefined);
    return next;
  }

  private notify(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) listener(status);
  }

  private async apply(patch: RemoteAccessUpdate, interactive: boolean): Promise<RemoteAccessStatus> {
    if (!patch || typeof patch !== "object" || Array.isArray(patch) ||
      Object.keys(patch).some(key => !["mode", "customAccessUrl", "tunnelConfig", "devTunnelConfig"].includes(key))) {
      throw new Error("Invalid remote access configuration.");
    }
    if (patch.mode !== undefined && !isRemoteAccessMode(patch.mode)) throw new Error("Invalid remote access mode.");
    if (patch.customAccessUrl !== undefined && typeof patch.customAccessUrl !== "string") throw new Error("Invalid custom access URL.");
    const mode = patch.mode ?? this.mode;
    const customAccessUrl = patch.customAccessUrl === undefined ? this.customAccessUrl : normalizeAccessUrl(patch.customAccessUrl);
    const devTunnelConfig = patch.devTunnelConfig === undefined ? this.devTunnelConfig : readDevTunnelConfig(patch.devTunnelConfig);
    let tunnelConfig = this.tunnelConfig;
    if (patch.tunnelConfig !== undefined) {
      const config = patch.tunnelConfig;
      if (!config || typeof config !== "object" || Array.isArray(config) ||
        Object.keys(config).some(key => key !== "hostname") ||
        (config.hostname !== undefined && typeof config.hostname !== "string")) {
        throw new Error("Invalid Cloudflare configuration.");
      }
      const hostname = config.hostname?.trim() ?? "";
      if (hostname && normalizeAccessUrl(hostname.startsWith("https://") ? hostname : `https://${hostname}`) !== `https://${hostname.replace(/^https:\/\//, "")}`) {
        throw new Error("Enter a valid Cloudflare hostname.");
      }
      tunnelConfig = { hostname };
    }
    if (mode === "custom" && !customAccessUrl) throw new Error("Save a custom access URL before enabling remote access.");
    if (mode === "cloudflare" && this.options.cloudflareAvailable === false) throw new Error("Cloudflare Tunnel is unavailable on this host.");
    if (mode === "devtunnel" && !this.options.devTunnel?.isAvailable()) throw new Error("Install the Microsoft devtunnel CLI on this host before enabling Dev Tunnels.");

    const restartTunnel = mode === "cloudflare" && (
      this.mode !== "cloudflare" || patch.tunnelConfig !== undefined ||
      !["starting", "running"].includes(this.options.tunnel.getInfo().status)
    );
    const restartDevTunnel = mode === "devtunnel" && (
      this.mode !== "devtunnel" || patch.devTunnelConfig !== undefined ||
      !["starting", "running"].includes(this.options.devTunnel!.getInfo().status)
    );
    const transition = mode !== this.mode || customAccessUrl !== this.customAccessUrl || restartTunnel || restartDevTunnel;
    if (transition) {
      this.mode = "off";
      this.notify();
    }
    try {
      if (mode !== "devtunnel" || restartDevTunnel) await this.options.devTunnel?.stop();
      if (mode !== "cloudflare" || restartTunnel) await this.options.tunnel.stop();
      if (restartTunnel) {
        const tunnel = await this.options.tunnel.start(this.options.getPort(), tunnelConfig);
        if (tunnel.status === "error" || tunnel.status === "stopped") throw new Error(tunnel.error ?? "Cloudflare Tunnel failed to start.");
      }
      if (restartDevTunnel) {
        await this.options.devTunnel!.start(this.options.getPort(), devTunnelConfig, interactive);
      }
      await this.options.saveSettings({
        remoteAccessMode: mode, customAccessUrl, tunnelConfig,
        ...(patch.devTunnelConfig !== undefined ? { devTunnelConfig } : {}),
      });
      this.customAccessUrl = customAccessUrl;
      this.tunnelConfig = tunnelConfig;
      this.devTunnelConfig = devTunnelConfig;
      this.mode = mode;
      this.notify();
      return this.getStatus();
    } catch (error) {
      this.mode = "off";
      this.notify();
      try { await this.options.tunnel.stop(); } catch { /* Admission stays closed if shutdown fails. */ }
      try { await this.options.devTunnel?.stop(); } catch { /* Admission stays closed if shutdown fails. */ }
      try { await this.options.saveSettings({ remoteAccessMode: "off" }); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }
}
