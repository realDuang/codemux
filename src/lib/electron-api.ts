/**
 * Electron API wrapper
 * Provides type-safe IPC call interfaces
 */

import { isElectron } from "./platform";
import { WEB_PORT, WEB_STANDALONE_PORT, GATEWAY_PORT } from "../../shared/ports";

// Type definitions
interface SystemInfo {
  platform: string;
  arch: string;
  version: string;
  userDataPath: string;
  homePath: string;
  isPackaged: boolean;
}

export interface TunnelInfo {
  url: string;
  status: "starting" | "running" | "stopped" | "error";
  startTime?: number;
  error?: string;
  errorCode?: string;
  warning?: string;
  warningCode?: string;
}

export interface TunnelConfig {
  hostname?: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  browser: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string;
  isHost?: boolean;
}

interface AuthResult {
  success: boolean;
  token?: string;
  deviceId?: string;
  device?: DeviceInfo;
  error?: string;
}

interface TokenValidation {
  valid: boolean;
  deviceId?: string;
}

interface PendingRequest {
  id: string;
  device: {
    name: string;
    platform: string;
    browser: string;
  };
  ip: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: number;
  resolvedAt?: number;
  deviceId?: string;
  token?: string;
}

// Get Electron API
export function getElectronAPI() {
  if (isElectron()) {
    return window.electronAPI;
  }
  return null;
}

const DEVICE_TOKEN_KEY = "opencode_device_token";

function getBrowserAuthHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extraHeaders };
  try {
    const token = localStorage.getItem(DEVICE_TOKEN_KEY);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  } catch {
    // localStorage unavailable
  }
  return headers;
}

async function browserAuthedRequest<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: getBrowserAuthHeaders((init?.headers as Record<string, string>) ?? {}),
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json() as { error?: string };
      if (data?.error) {
        message = data.error;
      }
    } catch {
      // Response is not JSON
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

// System API
export const systemAPI = {
  async getInfo(): Promise<SystemInfo | null> {
    const api = getElectronAPI();
    return api ? api.system.getInfo() : null;
  },

  async getLocalIp(): Promise<string> {
    const api = getElectronAPI();
    return api ? api.system.getLocalIp() : "localhost";
  },

  async openExternal(url: string): Promise<void> {
    const api = getElectronAPI();
    if (api) {
      await api.system.openExternal(url);
    } else {
      window.open(url, "_blank");
    }
  },

  async selectDirectory(): Promise<string | null> {
    const api = getElectronAPI();
    return api ? api.system.selectDirectory() : null;
  },

  async openPath(folderPath: string): Promise<string> {
    const api = getElectronAPI();
    if (api) {
      return api.system.openPath(folderPath);
    }
    return "Not in Electron environment";
  },
};

// Auth API
export const authAPI = {
  async localAuth(deviceInfo: any): Promise<AuthResult> {
    const api = getElectronAPI();
    if (!api) {
      return { success: false, error: "Not in Electron environment" };
    }
    return api.auth.localAuth(deviceInfo);
  },

  async validateToken(token: string): Promise<TokenValidation> {
    const api = getElectronAPI();
    if (!api) {
      return { valid: false };
    }
    return api.auth.validateToken(token);
  },

  async getAccessCode(): Promise<string | null> {
    const api = getElectronAPI();
    if (!api) {
      return null;
    }
    return api.auth.getAccessCode();
  },

  async getPendingRequests(): Promise<PendingRequest[]> {
    const api = getElectronAPI();
    if (!api) {
      return [];
    }
    return api.auth.getPendingRequests();
  },

  async approveRequest(requestId: string): Promise<boolean> {
    const api = getElectronAPI();
    if (!api) {
      return false;
    }
    return api.auth.approveRequest(requestId);
  },

  async denyRequest(requestId: string): Promise<boolean> {
    const api = getElectronAPI();
    if (!api) {
      return false;
    }
    return api.auth.denyRequest(requestId);
  },
};

// Device API
export const devicesAPI = {
  async list(): Promise<DeviceInfo[]> {
    const api = getElectronAPI();
    return api ? api.devices.list() : [];
  },

  async get(deviceId: string): Promise<DeviceInfo | null> {
    const api = getElectronAPI();
    return api ? api.devices.get(deviceId) : null;
  },

  async update(deviceId: string, updates: Partial<DeviceInfo>): Promise<boolean> {
    const api = getElectronAPI();
    if (!api) return false;
    const result = await api.devices.update(deviceId, updates);
    return result?.success ?? false;
  },

  async revoke(deviceId: string): Promise<boolean> {
    const api = getElectronAPI();
    if (!api) return false;
    return api.devices.revoke(deviceId);
  },

  async rename(deviceId: string, name: string): Promise<boolean> {
    const api = getElectronAPI();
    if (!api) return false;
    return api.devices.rename(deviceId, name);
  },

  async getCurrentDeviceId(): Promise<string | null> {
    const api = getElectronAPI();
    if (!api) return null;
    return api.devices.getCurrentDeviceId();
  },

  async revokeOthers(currentDeviceId: string): Promise<{ success: boolean; revokedCount?: number }> {
    const api = getElectronAPI();
    if (!api) return { success: false };
    return api.devices.revokeOthers(currentDeviceId);
  },
};

// Tunnel API
export const tunnelAPI = {
  async start(port: number = WEB_STANDALONE_PORT, tunnelConfig?: TunnelConfig): Promise<TunnelInfo | null> {
    const api = getElectronAPI();
    return api ? api.tunnel.start(port, tunnelConfig) : null;
  },

  async stop(): Promise<void> {
    const api = getElectronAPI();
    if (api) {
      await api.tunnel.stop();
    }
  },

  async getStatus(): Promise<TunnelInfo | null> {
    const api = getElectronAPI();
    return api ? api.tunnel.getStatus() : null;
  },

  onDisconnected(callback: () => void): (() => void) | null {
    const api = getElectronAPI();
    return api ? api.tunnel.onDisconnected(callback) : null;
  },
};

// Production Server API
export const serverAPI = {
  async getPort(): Promise<number> {
    const api = getElectronAPI();
    return api?.server ? api.server.getPort() : WEB_PORT;
  },

  async isRunning(): Promise<boolean> {
    const api = getElectronAPI();
    return api?.server ? api.server.isRunning() : false;
  },
};

// Gateway API
export const gatewayAPI = {
  async getWsUrl(): Promise<string> {
    const api = getElectronAPI();
    return api?.gateway ? api.gateway.getPort() : `ws://127.0.0.1:${GATEWAY_PORT}`;
  },
};

// Channel API (Feishu Bot, etc.)
export interface ChannelConfig {
  type: string;
  name: string;
  enabled: boolean;
  options: Record<string, unknown>;
}

export interface ChannelInfo {
  type: string;
  name: string;
  status: "stopped" | "starting" | "running" | "error";
  error?: string;
  webhookMeta?: { path: string; platformConfigGuide: string } | null;
}

export const channelAPI = {
  async list(): Promise<ChannelInfo[]> {
    const api = getElectronAPI();
    if (api?.channel) {
      return api.channel.list();
    }
    return browserAuthedRequest<ChannelInfo[]>("/api/channels");
  },

  async getConfig(type: string): Promise<ChannelConfig | null> {
    const api = getElectronAPI();
    if (api?.channel) {
      return api.channel.getConfig(type);
    }
    return browserAuthedRequest<ChannelConfig | null>(`/api/channels/${type}`);
  },

  async updateConfig(type: string, updates: Partial<ChannelConfig>): Promise<void> {
    const api = getElectronAPI();
    if (api?.channel) {
      await api.channel.updateConfig(type, updates);
      return;
    }
    await browserAuthedRequest<{ success: boolean }>(`/api/channels/${type}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
  },

  async start(type: string): Promise<void> {
    const api = getElectronAPI();
    if (api?.channel) {
      await api.channel.start(type);
      return;
    }
    await browserAuthedRequest<{ success: boolean }>(`/api/channels/${type}/start`, {
      method: "POST",
    });
  },

  async stop(type: string): Promise<void> {
    const api = getElectronAPI();
    if (api?.channel) {
      await api.channel.stop(type);
      return;
    }
    await browserAuthedRequest<{ success: boolean }>(`/api/channels/${type}/stop`, {
      method: "POST",
    });
  },

  async getStatus(type: string): Promise<ChannelInfo | null> {
    const api = getElectronAPI();
    if (api?.channel) {
      return api.channel.getStatus(type);
    }
    return browserAuthedRequest<ChannelInfo | null>(`/api/channels/${type}/status`);
  },
};

// Auto Update types
export interface UpdateStateInfo {
  status: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  version?: string;
  releaseNotes?: string;
  progress?: {
    percent: number;
    bytesPerSecond: number;
    transferred: number;
    total: number;
  };
  error?: string;
  downloadUrl?: string;
}

// Auto Update API
// Access update namespace via (api as any) since the update? property
// is declared in electron.d.ts (module-scoped) and not visible here.
// Type safety is provided by UpdateStateInfo at the consumer level.
function getUpdateAPI(): any {
  const api = getElectronAPI();
  return (api as any)?.update ?? null;
}

function getAutostartAPI(): any {
  const api = getElectronAPI();
  return (api as any)?.autostart ?? null;
}

export const updateAPI = {
  async checkForUpdates(): Promise<UpdateStateInfo | null> {
    const update = getUpdateAPI();
    return update ? update.checkForUpdates() as Promise<UpdateStateInfo> : null;
  },

  async quitAndInstall(): Promise<void> {
    const update = getUpdateAPI();
    if (update) await update.quitAndInstall();
  },

  async getStatus(): Promise<UpdateStateInfo | null> {
    const update = getUpdateAPI();
    return update ? update.getStatus() as Promise<UpdateStateInfo> : null;
  },

  async setAutoCheck(enabled: boolean): Promise<void> {
    const update = getUpdateAPI();
    if (update) await update.setAutoCheck(enabled);
  },

  async isAutoCheckEnabled(): Promise<boolean> {
    const update = getUpdateAPI();
    return update ? update.isAutoCheckEnabled() : false;
  },

  onUpdateAvailable(callback: (state: UpdateStateInfo) => void): (() => void) | null {
    const update = getUpdateAPI();
    return update ? update.onUpdateAvailable(callback) : null;
  },

  onDownloadProgress(callback: (state: UpdateStateInfo) => void): (() => void) | null {
    const update = getUpdateAPI();
    return update ? update.onDownloadProgress(callback) : null;
  },

  onUpdateDownloaded(callback: (state: UpdateStateInfo) => void): (() => void) | null {
    const update = getUpdateAPI();
    return update ? update.onUpdateDownloaded(callback) : null;
  },

  onUpdateError(callback: (state: UpdateStateInfo) => void): (() => void) | null {
    const update = getUpdateAPI();
    return update ? update.onUpdateError(callback) : null;
  },

  onStatusChange(callback: (state: UpdateStateInfo) => void): (() => void) | null {
    const update = getUpdateAPI();
    return update ? update.onStatusChange(callback) : null;
  },
};

// Autostart API
export const autostartAPI = {
  async isEnabled(): Promise<boolean> {
    const api = getAutostartAPI();
    return api ? api.isEnabled() : false;
  },

  async setEnabled(enabled: boolean): Promise<void> {
    const api = getAutostartAPI();
    if (api) await api.setEnabled(enabled);
  },
};

// WeChat iLink QR auth API (Electron only — uses main-process HTTP client)
export interface IlinkQrCode {
  qrcode: string;
  qrcodeImgContent: string;
  baseUrl: string;
}

export interface IlinkQrStatus {
  status: "wait" | "scanned" | "confirmed" | "expired";
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
}

function getWeixinIlinkAPI(): any {
  const api = getElectronAPI();
  return (api as any)?.weixinIlink ?? null;
}

export const weixinIlinkAPI = {
  async getQrCode(baseUrl?: string): Promise<IlinkQrCode | null> {
    const api = getWeixinIlinkAPI();
    return api ? api.getQrCode(baseUrl) : null;
  },
  async pollQrCodeStatus(qrcode: string, baseUrl?: string): Promise<IlinkQrStatus | null> {
    const api = getWeixinIlinkAPI();
    return api ? api.pollQrCodeStatus(qrcode, baseUrl) : null;
  },
  async logout(): Promise<{ success: boolean } | null> {
    const api = getWeixinIlinkAPI();
    return api ? api.logout() : null;
  },
};

/**
 * Get the OpenCode session storage folder path for a project.
 * OpenCode uses xdg-basedir: ~/.local/share/opencode/storage/session/{projectId}/
 */
export function getOpenCodeStoragePath(homePath: string, projectId: string): string {
  return `${homePath}/.local/share/opencode/storage/session/${projectId}`;
}

/**
 * Get the Copilot session storage folder path.
 * Copilot stores all sessions under ~/.copilot/session-state/ (flat, not grouped by project).
 */
export function getCopilotStoragePath(homePath: string): string {
  return `${homePath}/.copilot/session-state`;
}
