import type { DeviceStoreBase } from "./device-store-base";
import type { DeviceInfo } from "./device-store-types";
import type { RemoteAccessStatus, RemoteAccessTunnelConfig, RemoteAccessTunnelInfo, RemoteAccessUpdate } from "./remote-access";
import type { ChannelManager } from "../electron/main/channels/channel-manager";
import type { ChannelConfig } from "../electron/main/channels/channel-adapter";
import type { getQrCode, pollQrStatus } from "../electron/main/channels/weixin-ilink/weixin-ilink-qr-flow";

export interface HostSystemInfo {
  platform: string;
  arch: string;
  version: string;
  userDataPath: string;
  homePath: string;
  isPackaged: boolean;
}

export interface HostNetworkInterface {
  internal: boolean;
  family: string;
  address: string;
}

export interface HostManagementDependencies {
  getSystemInfo(): HostSystemInfo;
  getNetworkInterfaces(): Record<string, HostNetworkInterface[] | undefined>;
  getGatewayUrl(): string;
  deviceStore: Pick<DeviceStoreBase,
    "generateDeviceId" | "generateToken" | "addDevice" | "verifyToken" | "getAccessCode" |
    "listPendingRequests" | "approveRequest" | "denyRequest" | "listDevices" | "getDevice" |
    "updateDevice" | "removeDevice" | "revokeAllExcept"
  >;
  tunnelManager: { getInfo(): RemoteAccessTunnelInfo };
  remoteAccessManager: {
    getStatus(): RemoteAccessStatus;
    update(patch: RemoteAccessUpdate): Promise<RemoteAccessStatus>;
  };
  productionServer: { getPort(): number; isRunning(): boolean };
  logging: { getPath(): string; getLevel(): string; setLevel(level: string): void };
  settings: { load(): Record<string, unknown>; save(patch: Record<string, unknown>): void };
  channelManager: Pick<ChannelManager,
    "listChannels" | "getConfig" | "updateConfig" | "startChannel" | "stopChannel" | "getStatus" | "logoutChannel"
  >;
  ilink: { getQrCode: typeof getQrCode; pollQrStatus: typeof pollQrStatus };
  isStartupReady(): boolean;
}

/** Local owner operations shared by Electron IPC and the private control endpoint. */
export const HOST_MANAGEMENT_METHODS = [
  "system:getInfo", "system:getLocalIp",
  "auth:localAuth", "auth:validateToken", "auth:getAccessCode", "auth:getPendingRequests",
  "auth:approveRequest", "auth:denyRequest",
  "devices:list", "devices:get", "devices:update", "devices:revoke", "devices:rename",
  "devices:getCurrentDeviceId", "devices:revokeOthers",
  "tunnel:start", "tunnel:stop", "tunnel:getStatus", "remoteAccess:getStatus", "remoteAccess:update",
  "server:getPort", "server:isRunning", "gateway:getPort",
  "log:getPath", "log:getLevel", "log:setLevel",
  "channel:list", "channel:getConfig", "channel:updateConfig", "channel:start", "channel:stop", "channel:getStatus",
  "channel:weixin-ilink:get-qrcode", "channel:weixin-ilink:poll-qrcode-status", "channel:weixin-ilink:logout",
  "settings:load", "settings:save", "startup:isReady",
] as const;

export class HostManagementController {
  constructor(private readonly dependencies: HostManagementDependencies) {}

  /** Preload needs the same settings before the renderer starts. */
  loadSettings(): Record<string, unknown> {
    return this.dependencies.settings.load();
  }

  async invoke(method: string, args: unknown[] = []): Promise<unknown> {
    const deps = this.dependencies;
    switch (method) {
      case "system:getInfo":
        return deps.getSystemInfo();
      case "system:getLocalIp":
        return getLocalIp(deps.getNetworkInterfaces());
      case "auth:localAuth": {
        const deviceInfo = args[0] as Partial<Pick<DeviceInfo, "name" | "platform">> | undefined;
        const deviceId = deps.deviceStore.generateDeviceId();
        const token = deps.deviceStore.generateToken(deviceId);
        const device: DeviceInfo = {
          id: deviceId,
          name: deviceInfo?.name || "Local Machine",
          platform: deviceInfo?.platform || deps.getSystemInfo().platform,
          browser: "Electron",
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
          ip: "localhost",
          isHost: true,
        };
        deps.deviceStore.addDevice(device);
        return { success: true, token, deviceId, device };
      }
      case "auth:validateToken":
        return deps.deviceStore.verifyToken(args[0] as string);
      case "auth:getAccessCode":
        return deps.deviceStore.getAccessCode();
      case "auth:getPendingRequests":
        return deps.deviceStore.listPendingRequests();
      case "auth:approveRequest":
        return deps.deviceStore.approveRequest(args[0] as string) !== undefined;
      case "auth:denyRequest":
        return deps.deviceStore.denyRequest(args[0] as string) !== undefined;
      case "devices:list":
        return deps.deviceStore.listDevices();
      case "devices:get":
        return deps.deviceStore.getDevice(args[0] as string);
      case "devices:update":
        deps.deviceStore.updateDevice(args[0] as string, args[1] as Partial<DeviceInfo>);
        return { success: true };
      case "devices:revoke":
        return deps.deviceStore.removeDevice(args[0] as string);
      case "devices:rename":
        deps.deviceStore.updateDevice(args[0] as string, { name: args[1] as string });
        return true;
      case "devices:getCurrentDeviceId":
        // Preserve the host-device lookup; renderer localStorage is not available here.
        return deps.deviceStore.listDevices().find(device => device.isHost)?.id || null;
      case "devices:revokeOthers":
        return { success: true, revokedCount: deps.deviceStore.revokeAllExcept(args[0] as string) };
      case "tunnel:start": {
        // The configured host port remains authoritative; the legacy port argument is ignored.
        const tunnelConfig = args[1] as RemoteAccessTunnelConfig | undefined;
        const status = await deps.remoteAccessManager.update({ mode: "cloudflare", ...(tunnelConfig ? { tunnelConfig } : {}) });
        return status.tunnel;
      }
      case "tunnel:stop":
        if (deps.remoteAccessManager.getStatus().mode === "cloudflare") {
          await deps.remoteAccessManager.update({ mode: "off" });
        }
        return;
      case "tunnel:getStatus":
        return deps.tunnelManager.getInfo();
      case "remoteAccess:getStatus":
        return deps.remoteAccessManager.getStatus();
      case "remoteAccess:update":
        return deps.remoteAccessManager.update(args[0] as RemoteAccessUpdate);
      case "server:getPort":
        return deps.productionServer.getPort();
      case "server:isRunning":
        return deps.productionServer.isRunning();
      case "gateway:getPort":
        return deps.getGatewayUrl();
      case "log:getPath":
        return deps.logging.getPath();
      case "log:getLevel":
        return deps.logging.getLevel();
      case "log:setLevel":
        deps.logging.setLevel(args[0] as string);
        return { success: true };
      case "channel:list":
        return deps.channelManager.listChannels();
      case "channel:getConfig":
        return deps.channelManager.getConfig(args[0] as string);
      case "channel:updateConfig":
        await deps.channelManager.updateConfig(args[0] as string, args[1] as Partial<ChannelConfig>);
        return { success: true };
      case "channel:start":
        await deps.channelManager.startChannel(args[0] as string);
        return { success: true };
      case "channel:stop":
        await deps.channelManager.stopChannel(args[0] as string);
        return { success: true };
      case "channel:getStatus":
        return deps.channelManager.getStatus(args[0] as string);
      case "channel:weixin-ilink:get-qrcode":
        return deps.ilink.getQrCode(args[0] as string | undefined);
      case "channel:weixin-ilink:poll-qrcode-status":
        return deps.ilink.pollQrStatus(args[0] as string, args[1] as string | undefined);
      case "channel:weixin-ilink:logout":
        await deps.channelManager.logoutChannel("weixin-ilink");
        return { success: true };
      case "settings:load":
        return this.loadSettings();
      case "settings:save": {
        const patch = args[0] as Record<string, unknown>;
        if (["remoteAccessMode", "customAccessUrl", "tunnelConfig"].some(key => key in patch)) {
          throw new Error("Use remote access controls to change connection settings.");
        }
        deps.settings.save(patch);
        return { success: true };
      }
      case "startup:isReady":
        return deps.isStartupReady();
      default:
        throw new Error(`Unknown host management method: ${method}`);
    }
  }
}

const virtualInterfacePatterns = [
  /^docker/i, /^br-/i, /^veth/i, /^vEthernet/i,
  /^vmnet/i, /^VMware/i, /^VirtualBox/i, /^vboxnet/i,
  /^Hyper-V/i, /^Default Switch/i, /^WSL/i,
  /^tun/i, /^tap/i, /^singbox/i, /^sing-box/i, /^clash/i, /^utun/i,
  /^tailscale/i, /^ZeroTier/i, /^zt/i,
  /^wg/i, /^wireguard/i, /^ham/i, /^Hamachi/i, /^npcap/i, /^lo/i,
];

function getLocalIp(interfaces: Record<string, HostNetworkInterface[] | undefined>): string {
  let fallback: string | null = null;
  for (const name of Object.keys(interfaces)) {
    const nets = interfaces[name];
    if (!nets) continue;
    const virtual = virtualInterfacePatterns.some(pattern => pattern.test(name));
    for (const net of nets) {
      if (net.internal || net.family !== "IPv4") continue;
      if (!virtual) return net.address;
      if (!fallback) fallback = net.address;
    }
  }
  return fallback ?? "localhost";
}
