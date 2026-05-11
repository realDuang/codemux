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
    updateTitleBarOverlay: (options: { color: string; symbolColor: string }) => Promise<void>;
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
    start: (port: number, tunnelConfig?: { hostname?: string }) => Promise<{
      url: string;
      status: "starting" | "running" | "stopped" | "error";
      startTime?: number;
      error?: string;
      errorCode?: string;
    }>;
    stop: () => Promise<void>;
    getStatus: () => Promise<{
      url: string;
      status: "starting" | "running" | "stopped" | "error";
      startTime?: number;
      error?: string;
      errorCode?: string;
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

  channel?: {
    list: () => Promise<Array<{ type: string; name: string; status: "stopped" | "starting" | "running" | "error"; error?: string; webhookMeta?: { path: string; platformConfigGuide: string } | null }>>;
    getConfig: (type: string) => Promise<{ type: string; name: string; enabled: boolean; options: Record<string, unknown> } | null>;
    updateConfig: (type: string, updates: any) => Promise<void>;
    start: (type: string) => Promise<void>;
    stop: (type: string) => Promise<void>;
    getStatus: (type: string) => Promise<{ type: string; name: string; status: "stopped" | "starting" | "running" | "error"; error?: string; webhookMeta?: { path: string; platformConfigGuide: string } | null } | null>;
  };

  weixinIlink?: {
    getQrCode: (baseUrl?: string) => Promise<{ qrcode: string; qrcodeImgContent: string; baseUrl: string }>;
    pollQrCodeStatus: (qrcode: string, baseUrl?: string) => Promise<{
      status: "wait" | "scanned" | "confirmed" | "expired";
      botToken?: string;
      accountId?: string;
      baseUrl?: string;
      userId?: string;
    }>;
  };

  update?: {
    checkForUpdates: () => Promise<UpdateState>;
    quitAndInstall: () => Promise<void>;
    getStatus: () => Promise<UpdateState>;
    setAutoCheck: (enabled: boolean) => Promise<{ success: boolean }>;
    isAutoCheckEnabled: () => Promise<boolean>;
    onUpdateAvailable: (callback: (state: UpdateState) => void) => () => void;
    onDownloadProgress: (callback: (state: UpdateState) => void) => () => void;
    onUpdateDownloaded: (callback: (state: UpdateState) => void) => () => void;
    onUpdateError: (callback: (state: UpdateState) => void) => () => void;
    onStatusChange: (callback: (state: UpdateState) => void) => () => void;
  };

  autostart?: {
    isEnabled: () => Promise<boolean>;
    setEnabled: (enabled: boolean) => Promise<{ success: boolean }>;
  };
}

interface UpdateState {
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
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};