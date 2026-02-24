import { contextBridge, ipcRenderer } from "electron";

const electronAPI = {
  // System API
  system: {
    getInfo: () => ipcRenderer.invoke("system:getInfo"),
    getLocalIp: () => ipcRenderer.invoke("system:getLocalIp"),
    openExternal: (url: string) => ipcRenderer.invoke("system:openExternal", url),
    selectDirectory: () => ipcRenderer.invoke("system:selectDirectory"),
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
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);

export type ElectronAPI = typeof electronAPI;