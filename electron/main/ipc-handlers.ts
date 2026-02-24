import { ipcMain, dialog, shell, app } from "electron";
import os from "os";
import { deviceStore } from "./services/device-store";
import { tunnelManager } from "./services/tunnel-manager";
import { productionServer } from "./services/production-server";

export function registerIpcHandlers(): void {
  // ===========================================================================
  // System
  // ===========================================================================

  ipcMain.handle("system:getInfo", async () => {
    return {
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
      userDataPath: app.getPath("userData"),
      isPackaged: app.isPackaged,
    };
  });

  ipcMain.handle("system:getLocalIp", async () => {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const nets = interfaces[name];
      if (!nets) continue;
      for (const net of nets) {
        if (net.family === "IPv4" && !net.internal) {
          return net.address;
        }
      }
    }
    return "localhost";
  });

  ipcMain.handle("system:openExternal", async (_, url: string) => {
    // Validate URL to prevent opening dangerous protocols
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
        await shell.openExternal(url);
        return;
      }
      throw new Error("Unsupported URL protocol");
    } catch {
      throw new Error("Invalid URL");
    }
  });

  ipcMain.handle("system:selectDirectory", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ===========================================================================
  // Authentication
  // ===========================================================================

  ipcMain.handle("auth:localAuth", async (_, deviceInfo: any) => {
    const deviceId = deviceStore.generateDeviceId();
    const token = deviceStore.generateToken(deviceId);

    const device = {
      id: deviceId,
      name: deviceInfo?.name || "Local Machine",
      platform: deviceInfo?.platform || process.platform,
      browser: "Electron",
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      ip: "localhost",
      isHost: true,
    };

    deviceStore.addDevice(device);

    return { success: true, token, deviceId, device };
  });

  ipcMain.handle("auth:validateToken", async (_, token: string) => {
    return deviceStore.verifyToken(token);
  });

  ipcMain.handle("auth:getAccessCode", async () => {
    return deviceStore.getAccessCode();
  });

  ipcMain.handle("auth:getPendingRequests", async () => {
    return deviceStore.listPendingRequests();
  });

  ipcMain.handle("auth:approveRequest", async (_, requestId: string) => {
    const result = deviceStore.approveRequest(requestId);
    return result !== undefined;
  });

  ipcMain.handle("auth:denyRequest", async (_, requestId: string) => {
    const result = deviceStore.denyRequest(requestId);
    return result !== undefined;
  });

  // ===========================================================================
  // Device Management
  // ===========================================================================

  ipcMain.handle("devices:list", async () => {
    return deviceStore.listDevices();
  });

  ipcMain.handle("devices:get", async (_, deviceId: string) => {
    return deviceStore.getDevice(deviceId);
  });

  ipcMain.handle("devices:update", async (_, deviceId: string, updates: any) => {
    deviceStore.updateDevice(deviceId, updates);
    return { success: true };
  });

  ipcMain.handle("devices:revoke", async (_, deviceId: string) => {
    return deviceStore.removeDevice(deviceId);
  });

  ipcMain.handle("devices:rename", async (_, deviceId: string, name: string) => {
    deviceStore.updateDevice(deviceId, { name });
    return true;
  });

  ipcMain.handle("devices:getCurrentDeviceId", async () => {
    // In Electron, current device ID is stored in localStorage
    // But main process cannot access localStorage, so we return host device
    const devices = deviceStore.listDevices();
    const hostDevice = devices.find(d => d.isHost);
    return hostDevice?.id || null;
  });

  ipcMain.handle("devices:revokeOthers", async (_, currentDeviceId: string) => {
    const count = deviceStore.revokeAllExcept(currentDeviceId);
    return { success: true, revokedCount: count };
  });

  // ===========================================================================
  // Tunnel Management
  // ===========================================================================

  ipcMain.handle("tunnel:start", async (_, port: number) => {
    // In production, use the production server port if available
    const actualPort = app.isPackaged && productionServer.isRunning()
      ? productionServer.getPort()
      : port;
    return tunnelManager.start(actualPort);
  });

  ipcMain.handle("tunnel:stop", async () => {
    return tunnelManager.stop();
  });

  ipcMain.handle("tunnel:getStatus", async () => {
    return tunnelManager.getInfo();
  });

  // ===========================================================================
  // Production Server Management
  // ===========================================================================

  ipcMain.handle("server:getPort", async () => {
    return productionServer.getPort();
  });

  ipcMain.handle("server:isRunning", async () => {
    return productionServer.isRunning();
  });

  // ===========================================================================
  // Gateway
  // ===========================================================================

  ipcMain.handle("gateway:getPort", async () => {
    return 4200;
  });
}