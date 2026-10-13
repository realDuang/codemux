import { normalizeAccessUrl } from "./access-url";

export type RemoteAccessMode = "off" | "custom" | "cloudflare";

export interface RemoteAccessTunnelConfig {
  hostname?: string;
}

export interface RemoteAccessTunnelInfo {
  status: "starting" | "running" | "stopped" | "error";
  url: string;
  startTime?: number;
  error?: string;
  errorCode?: string;
}

export interface RemoteAccessStatus {
  mode: RemoteAccessMode;
  customAccessUrl: string;
  url: string;
  tunnel: RemoteAccessTunnelInfo;
  tunnelConfig: RemoteAccessTunnelConfig;
  cloudflareAvailable: boolean;
}

export interface RemoteAccessUpdate {
  mode?: RemoteAccessMode;
  customAccessUrl?: string;
  tunnelConfig?: RemoteAccessTunnelConfig;
}

export function isRemoteAccessMode(value: unknown): value is RemoteAccessMode {
  return value === "off" || value === "custom" || value === "cloudflare";
}

export function readCustomAccessUrl(settings: Record<string, unknown>): string {
  try {
    return normalizeAccessUrl(typeof settings.customAccessUrl === "string" ? settings.customAccessUrl : "");
  } catch {
    return "";
  }
}

/** Preserve existing custom deployments; a saved tunnel config never enables access. */
export function readRemoteAccessMode(settings: Record<string, unknown>): RemoteAccessMode {
  if (isRemoteAccessMode(settings.remoteAccessMode)) return settings.remoteAccessMode;
  if (settings.remoteAccessMode !== undefined) return "off";
  return readCustomAccessUrl(settings) ? "custom" : "off";
}
