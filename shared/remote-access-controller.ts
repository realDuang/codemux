import { isRemoteAccessRequestAllowed } from "./remote-access-policy";
import type { IncomingMessage } from "node:http";
import { normalizeAccessUrl } from "./access-url";
import {
  isRemoteAccessMode, readCustomAccessUrl, readRemoteAccessMode,
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
}

/** One authority for persisted configuration, tunnel lifecycle, and server admission. */
export class RemoteAccessController {
  private mode: RemoteAccessMode;
  private customAccessUrl: string;
  private tunnelConfig: RemoteAccessTunnelConfig;
  private pending: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(status: RemoteAccessStatus) => void>();
  private initialized: Promise<void> | undefined;

  constructor(private options: RemoteAccessControllerOptions) {
    const settings = options.loadSettings();
    const savedMode = readRemoteAccessMode(settings);
    this.mode = savedMode === "cloudflare" ? "off" : savedMode;
    this.customAccessUrl = readCustomAccessUrl(settings);
    const config = settings.tunnelConfig as RemoteAccessTunnelConfig | undefined;
    this.tunnelConfig = { hostname: typeof config?.hostname === "string" ? config.hostname : "" };
  }

  getStatus(): RemoteAccessStatus {
    const tunnel = { ...this.options.tunnel.getInfo() };
    let url = "";
    if (this.mode === "custom") url = this.customAccessUrl;
    if (this.mode === "cloudflare" && tunnel.status === "running") url = tunnel.url;
    return {
      mode: this.mode, customAccessUrl: this.customAccessUrl, url, tunnel,
      tunnelConfig: { ...this.tunnelConfig },
      cloudflareAvailable: this.options.cloudflareAvailable !== false,
    };
  }

  initialize(): Promise<void> {
    if (!this.initialized) {
      const mode = readRemoteAccessMode(this.options.loadSettings());
      this.initialized = this.update({ mode }).then(() => undefined);
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
    const next = this.pending.then(() => this.apply(patch));
    this.pending = next.catch(() => undefined);
    return next;
  }

  private notify(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) listener(status);
  }

  private async apply(patch: RemoteAccessUpdate): Promise<RemoteAccessStatus> {
    if (!patch || typeof patch !== "object" || Array.isArray(patch) ||
      Object.keys(patch).some(key => !["mode", "customAccessUrl", "tunnelConfig"].includes(key))) {
      throw new Error("Invalid remote access configuration.");
    }
    if (patch.mode !== undefined && !isRemoteAccessMode(patch.mode)) throw new Error("Invalid remote access mode.");
    if (patch.customAccessUrl !== undefined && typeof patch.customAccessUrl !== "string") throw new Error("Invalid custom access URL.");
    const mode = patch.mode ?? this.mode;
    const customAccessUrl = patch.customAccessUrl === undefined ? this.customAccessUrl : normalizeAccessUrl(patch.customAccessUrl);
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

    const restartTunnel = mode === "cloudflare" && (
      this.mode !== "cloudflare" || patch.tunnelConfig !== undefined ||
      !["starting", "running"].includes(this.options.tunnel.getInfo().status)
    );
    const transition = mode !== this.mode || customAccessUrl !== this.customAccessUrl || restartTunnel;
    if (transition) {
      this.mode = "off";
      this.notify();
    }
    try {
      if (mode !== "cloudflare" || restartTunnel) await this.options.tunnel.stop();
      if (restartTunnel) {
        const tunnel = await this.options.tunnel.start(this.options.getPort(), tunnelConfig);
        if (tunnel.status === "error" || tunnel.status === "stopped") throw new Error(tunnel.error ?? "Cloudflare Tunnel failed to start.");
      }
      await this.options.saveSettings({ remoteAccessMode: mode, customAccessUrl, tunnelConfig });
      this.customAccessUrl = customAccessUrl;
      this.tunnelConfig = tunnelConfig;
      this.mode = mode;
      this.notify();
      return this.getStatus();
    } catch (error) {
      this.mode = "off";
      this.notify();
      try { await this.options.tunnel.stop(); } catch { /* Admission stays closed if shutdown fails. */ }
      try { await this.options.saveSettings({ remoteAccessMode: "off" }); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }
}
