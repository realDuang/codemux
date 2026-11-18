export const CODEMUX_TUNNEL_LABELS = ["codemux", "codemux-discovery-v1"] as const;
export const CODEMUX_WEB_PORT_LABEL = "codemux-web";

export interface DiscoveredDevTunnel {
  tunnelId: string;
  name: string;
  online: boolean;
  url?: string;
}

export interface DevTunnelDiscoveryResult {
  status: "ready" | "loginRequired" | "unavailable" | "error";
  tunnels: DiscoveredDevTunnel[];
  errorCode?: string;
}

export function readDevTunnelUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol === "https:" && !url.port && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.devtunnels\.ms$/.test(url.hostname)) return url.origin;
  } catch { /* A shared link must be a Dev Tunnels HTTPS origin. */ }
}
