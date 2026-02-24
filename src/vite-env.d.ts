/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Log level: 'debug' | 'info' | 'warn' | 'error' | 'none' */
  readonly VITE_LOG_LEVEL?: "debug" | "info" | "warn" | "error" | "none";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Electron API type declarations for renderer process
interface ElectronAPI {
  system: {
    getInfo: () => Promise<{
      platform: string;
      arch: string;
      version: string;
      userDataPath: string;
      isPackaged: boolean;
    }>;
    getLocalIp: () => Promise<string>;
    openExternal: (url: string) => Promise<void>;
    selectDirectory: () => Promise<string | null>;
  };

  auth: {
    localAuth: (deviceInfo: any) => Promise<{
      success: boolean;
      token?: string;
      deviceId?: string;
      device?: any;
      error?: string;
    }>;
    validateToken: (token: string) => Promise<{ valid: boolean; deviceId?: string }>;
    getAccessCode: () => Promise<string | null>;
    getPendingRequests: () => Promise<any[]>;
    approveRequest: (requestId: string) => Promise<boolean>;
    denyRequest: (requestId: string) => Promise<boolean>;
  };

  devices: {
    list: () => Promise<any[]>;
    get: (deviceId: string) => Promise<any | null>;
    update: (deviceId: string, updates: any) => Promise<{ success: boolean } | null>;
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
    } | null>;
    stop: () => Promise<void>;
    getStatus: () => Promise<{
      url: string;
      status: "starting" | "running" | "stopped" | "error";
      startTime?: number;
      error?: string;
    } | null>;
  };

  opencode: {
    start: () => Promise<{
      running: boolean;
      port: number;
      pid?: number;
      startTime?: number;
      error?: string;
    } | null>;
    stop: () => Promise<void>;
    getStatus: () => Promise<{
      running: boolean;
      port: number;
      pid?: number;
      startTime?: number;
      error?: string;
    } | null>;
    getPort: () => Promise<number>;
  };

  server: {
    getPort: () => Promise<number>;
    isRunning: () => Promise<boolean>;
  };

  gateway?: {
    getPort: () => Promise<number>;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
