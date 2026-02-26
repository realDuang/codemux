/**
 * Electron API type declarations
 * Declares types for window.electronAPI
 */

interface ElectronAPI {
  system: {
    getInfo: () => Promise<{
      platform: string;
      arch: string;
      version: string;
      userDataPath: string;
      homePath: string;
      isPackaged: boolean;
    }>;
    getLocalIp: () => Promise<string>;
    openExternal: (url: string) => Promise<void>;
    selectDirectory: () => Promise<string | null>;
    openPath: (folderPath: string) => Promise<string>;
  };

  auth: {
    localAuth: (deviceInfo: any) => Promise<{
      success: boolean;
      token?: string;
      deviceId?: string;
      device?: any;
      error?: string;
    }>;
    validateToken: (token: string) => Promise<{
      valid: boolean;
      deviceId?: string;
    }>;
    getAccessCode: () => Promise<string>;
    getPendingRequests: () => Promise<Array<{
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
    }>>;
    approveRequest: (requestId: string) => Promise<boolean>;
    denyRequest: (requestId: string) => Promise<boolean>;
  };

  devices: {
    list: () => Promise<any[]>;
    get: (deviceId: string) => Promise<any>;
    update: (deviceId: string, updates: any) => Promise<{ success: boolean }>;
    revoke: (deviceId: string) => Promise<boolean>;
    rename: (deviceId: string, name: string) => Promise<boolean>;
    getCurrentDeviceId: () => Promise<string | null>;
    revokeOthers: (currentDeviceId: string) => Promise<{ success: boolean; revokedCount?: number }>;
  };

  tunnel: {
    start: (port: number) => Promise<{
      url: string;
      status: "starting" | "running" | "stopped" | "error";
      startTime?: number;
      error?: string;
    }>;
    stop: () => Promise<void>;
    getStatus: () => Promise<{
      url: string;
      status: "starting" | "running" | "stopped" | "error";
      startTime?: number;
      error?: string;
    }>;
    onDisconnected: (callback: () => void) => () => void;
  };

  server?: {
    getPort: () => Promise<number>;
    isRunning: () => Promise<boolean>;
  };

  gateway?: {
    getPort: () => Promise<string>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};