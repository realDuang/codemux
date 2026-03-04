import { contextBridge, ipcRenderer } from "electron";

// Pre-load settings synchronously so renderer can read them immediately at module init
// (needed for theme/locale which must be applied before first paint)
const _settingsCache: Record<string, unknown> = ipcRenderer.sendSync("settings:loadSync") ?? {};

const electronAPI = {
  // System API
  system: {
    getInfo: () => ipcRenderer.invoke("system:getInfo"),
    getLocalIp: () => ipcRenderer.invoke("system:getLocalIp"),
    openExternal: (url: string) => ipcRenderer.invoke("system:openExternal", url),
    selectDirectory: () => ipcRenderer.invoke("system:selectDirectory"),
    openPath: (folderPath: string) => ipcRenderer.invoke("system:openPath", folderPath),
  },

  // Auth API
  auth: {
    localAuth: (deviceInfo: any) => ipcRenderer.invoke("auth:localAuth", deviceInfo),
    validateToken: (token: string) => ipcRenderer.invoke("auth:validateToken", token),
    getAccessCode: () => ipcRenderer.invoke("auth:getAccessCode"),
    getPendingRequests: () => ipcRenderer.invoke("auth:getPendingRequests"),
    approveRequest: (requestId: string) => ipcRenderer.invoke("auth:approveRequest", requestId),
    denyRequest: (requestId: string) => ipcRenderer.invoke("auth:denyRequest", requestId),
  },

  // Device management API
  devices: {
    list: () => ipcRenderer.invoke("devices:list"),
    get: (deviceId: string) => ipcRenderer.invoke("devices:get", deviceId),
    update: (deviceId: string, updates: any) => ipcRenderer.invoke("devices:update", deviceId, updates),
    revoke: (deviceId: string) => ipcRenderer.invoke("devices:revoke", deviceId),
    rename: (deviceId: string, name: string) => ipcRenderer.invoke("devices:rename", deviceId, name),
    getCurrentDeviceId: () => ipcRenderer.invoke("devices:getCurrentDeviceId"),
    revokeOthers: (currentDeviceId: string) => ipcRenderer.invoke("devices:revokeOthers", currentDeviceId),
  },

  // Tunnel API
  tunnel: {
    start: (port: number) => ipcRenderer.invoke("tunnel:start", port),
    stop: () => ipcRenderer.invoke("tunnel:stop"),
    getStatus: () => ipcRenderer.invoke("tunnel:getStatus"),
    onDisconnected: (callback: () => void) => {
      ipcRenderer.on("tunnel:disconnected", callback);
      return () => { ipcRenderer.removeListener("tunnel:disconnected", callback); };
    },
  },

  // Production server API
  server: {
    getPort: () => ipcRenderer.invoke("server:getPort"),
    isRunning: () => ipcRenderer.invoke("server:isRunning"),
  },

  // Gateway API
  gateway: {
    getPort: () => ipcRenderer.invoke("gateway:getPort"),
  },

  // Logging API
  log: {
    getPath: () => ipcRenderer.invoke("log:getPath") as Promise<string>,
    getLevel: () => ipcRenderer.invoke("log:getLevel") as Promise<string>,
    setLevel: (level: string) =>
      ipcRenderer.invoke("log:setLevel", level) as Promise<{ success: boolean }>,
  },

  // Channel API
  channel: {
    list: () => ipcRenderer.invoke("channel:list"),
    getConfig: (type: string) => ipcRenderer.invoke("channel:getConfig", type),
    updateConfig: (type: string, updates: any) =>
      ipcRenderer.invoke("channel:updateConfig", type, updates),
    start: (type: string) => ipcRenderer.invoke("channel:start", type),
    stop: (type: string) => ipcRenderer.invoke("channel:stop", type),
    getStatus: (type: string) => ipcRenderer.invoke("channel:getStatus", type),
  },

  // Settings API (persisted to settings.json)
  settings: {
    /** Synchronously cached settings — available immediately at module init */
    cache: _settingsCache,
    /** Async load all settings from disk */
    load: () => ipcRenderer.invoke("settings:load") as Promise<Record<string, unknown>>,
    /** Async save a partial settings patch to disk */
    save: (patch: Record<string, unknown>) => {
      return ipcRenderer.invoke("settings:save", patch) as Promise<{ success: boolean }>;
    },
  },

  // Startup API
  startup: {
    isReady: () => ipcRenderer.invoke("startup:isReady") as Promise<boolean>,
    onReady: (callback: () => void) => {
      ipcRenderer.once("startup:ready", callback);
    },
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);

export type ElectronAPI = typeof electronAPI;