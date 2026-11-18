import { normalizeAccessUrl } from "./access-url";

export type RemoteAccessMode = "off" | "custom" | "cloudflare" | "devtunnel";

export interface DevTunnelConfig {
  access: "private" | "tenant" | "anonymous";
  name?: string;
}

export function readDevTunnelConfig(value: unknown): DevTunnelConfig {
  if (value === undefined) return { access: "private" };
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => key !== "access" && key !== "name") ||
    !("access" in value) || typeof value.access !== "string" || !["private", "tenant", "anonymous"].includes(value.access)) {
    throw new Error("Invalid Dev Tunnels configuration.");
  }
  if ("name" in value && value.name !== undefined &&
    (typeof value.name !== "string" || value.name.trim().length > 100 || /[\x00-\x1f\x7f]/.test(value.name))) {
    throw new Error("Invalid Dev Tunnels display name.");
  }
  const name = (value as DevTunnelConfig).name?.trim();
  return { access: (value as DevTunnelConfig).access, ...(name ? { name } : {}) };
}

export interface RemoteAccessTunnelConfig {
  hostname?: string;
}

export interface RemoteAccessTunnelInfo {
  status: "starting" | "running" | "stopped" | "error";
  url: string;
  startTime?: number;
  error?: string;
  errorCode?: string;
  phase?: "login" | "provisioning" | "connecting";
}

export interface RemoteAccessStatus {
  mode: RemoteAccessMode;
  customAccessUrl: string;
  url: string;
  tunnel: RemoteAccessTunnelInfo;
  tunnelConfig: RemoteAccessTunnelConfig;
  cloudflareAvailable: boolean;
  devTunnelAvailable?: boolean;
  devTunnelConfig?: DevTunnelConfig;
}

export interface RemoteAccessUpdate {
  mode?: RemoteAccessMode;
  customAccessUrl?: string;
  tunnelConfig?: RemoteAccessTunnelConfig;
  devTunnelConfig?: DevTunnelConfig;
}

export function isRemoteAccessMode(value: unknown): value is RemoteAccessMode {
  return value === "off" || value === "custom" || value === "cloudflare" || value === "devtunnel";
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
