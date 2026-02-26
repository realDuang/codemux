/**
 * Electron API wrapper
 * Provides type-safe IPC call interfaces
 */

import { isElectron } from "./platform";

// Type definitions
interface SystemInfo {
  platform: string;
  arch: string;
  version: string;
  userDataPath: string;
  homePath: string;
  isPackaged: boolean;
}

interface TunnelInfo {
  url: string;
  status: "starting" | "running" | "stopped" | "error";
  startTime?: number;
  error?: string;
}

interface DeviceInfo {
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
  async start(port: number = 5174): Promise<TunnelInfo | null> {
    const api = getElectronAPI();
    return api ? api.tunnel.start(port) : null;
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
    return api?.server ? api.server.getPort() : 5173;
  },

  async isRunning(): Promise<boolean> {
    const api = getElectronAPI();
    return api?.server ? api.server.isRunning() : false;
  },
};

// Gateway API
export const gatewayAPI = {
  async getPort(): Promise<number> {
    const api = getElectronAPI();
    return api?.gateway ? api.gateway.getPort() : 4200;
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