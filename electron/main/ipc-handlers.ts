import { ipcMain, dialog, shell, app, BrowserWindow } from "electron";
import fs from "fs";
import os from "os";
import { deviceStore } from "./services/device-store";
import { tunnelManager } from "./services/tunnel-manager";
import { productionServer } from "./services/production-server";
import { updateManager } from "./services/update-manager";
import { trayManager } from "./services/tray-manager";
import { getLogFilePath, getFileLogLevel, setFileLogLevel, loadSettings, saveSettings } from "./services/logger";
import { isStartupReady } from "./app-main";
import { channelManager } from "./app-main";
import { GATEWAY_PORT } from "../../shared/ports";
import { getUserDataPath } from "./services/app-paths";
import { getQrCode as ilinkGetQrCode, pollQrStatus as ilinkPollQrStatus } from "./channels/weixin-ilink/weixin-ilink-qr-flow";

export function registerIpcHandlers(): void {
  // ===========================================================================
  // System
  // ===========================================================================

  ipcMain.handle("system:getInfo", async () => {
    return {
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
      userDataPath: getUserDataPath(),
      homePath: app.getPath("home"),
      isPackaged: app.isPackaged,
    };
  });

  ipcMain.handle("system:getLocalIp", async () => {
    return getLocalIp();
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

  ipcMain.handle("system:openPath", async (_, folderPath: string) => {
    const stat = fs.statSync(folderPath);
    if (!stat.isDirectory()) {
      throw new Error("Path is not a directory");
    }
    return shell.openPath(folderPath);
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

    // Read tunnel config from settings
    const settings = loadSettings();
    const tunnelConfig = settings.tunnelConfig as { hostname?: string } | undefined;

    return tunnelManager.start(actualPort, tunnelConfig);
  });

  ipcMain.handle("tunnel:stop", async () => {
    return tunnelManager.stop();
  });

  ipcMain.handle("tunnel:getStatus", async () => {
    return tunnelManager.getInfo();
  });

  // Notify renderer when cloudflared exits unexpectedly
  tunnelManager.setOnUnexpectedExit(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("tunnel:disconnected");
      }
    }
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
    // In packaged mode, GatewayServer attaches to the production HTTP server
    // at /ws path, so we must return the full WebSocket URL.
    // In dev mode, GatewayServer listens on its configured standalone port.
    if (app.isPackaged && productionServer.isRunning()) {
      return `ws://127.0.0.1:${productionServer.getPort()}/ws`;
    }
    return `ws://127.0.0.1:${GATEWAY_PORT}`;
  });

  // ===========================================================================
  // Logging
  // ===========================================================================

  ipcMain.handle("log:getPath", async () => {
    return getLogFilePath();
  });

  ipcMain.handle("log:getLevel", async () => {
    return getFileLogLevel();
  });

  ipcMain.handle("log:setLevel", async (_event, level: string) => {
    setFileLogLevel(level);
    return { success: true };
  });

  // ===========================================================================
  // Channels (Feishu Bot, etc.)
  // ===========================================================================

  ipcMain.handle("channel:list", async () => {
    return channelManager.listChannels();
  });

  ipcMain.handle("channel:getConfig", async (_, type: string) => {
    return channelManager.getConfig(type);
  });

  ipcMain.handle("channel:updateConfig", async (_, type: string, updates: any) => {
    await channelManager.updateConfig(type, updates);
    return { success: true };
  });

  ipcMain.handle("channel:start", async (_, type: string) => {
    await channelManager.startChannel(type);
    return { success: true };
  });

  ipcMain.handle("channel:stop", async (_, type: string) => {
    await channelManager.stopChannel(type);
    return { success: true };
  });

  ipcMain.handle("channel:getStatus", async (_, type: string) => {
    return channelManager.getStatus(type);
  });

  // ===========================================================================
  // WeChat iLink QR auth (out-of-band, used by login modal)
  // ===========================================================================

  ipcMain.handle("channel:weixin-ilink:get-qrcode", async (_, baseUrl?: string) => {
    return ilinkGetQrCode(baseUrl);
  });

  ipcMain.handle(
    "channel:weixin-ilink:poll-qrcode-status",
    async (_, qrcode: string, baseUrl?: string) => {
      return ilinkPollQrStatus(qrcode, baseUrl);
    },
  );

  ipcMain.handle("channel:weixin-ilink:logout", async () => {
    await channelManager.logoutChannel("weixin-ilink");
    return { success: true };
  });

  // ===========================================================================
  // Settings (persisted to settings.json in userData)
  // ===========================================================================

  // Synchronous read — used by preload to provide initial values before renderer starts
  ipcMain.on("settings:loadSync", (event) => {
    event.returnValue = loadSettings();
  });

  ipcMain.handle("settings:load", async () => {
    return loadSettings();
  });

  ipcMain.handle("settings:save", async (_event, patch: Record<string, unknown>) => {
    saveSettings(patch);
    return { success: true };
  });

  // ===========================================================================
  // Auto Update
  // ===========================================================================

  ipcMain.handle("update:checkForUpdates", async () => {
    return updateManager.checkForUpdates();
  });

  ipcMain.handle("update:quitAndInstall", async () => {
    updateManager.quitAndInstall();
  });

  ipcMain.handle("update:getStatus", async () => {
    return updateManager.getState();
  });

  ipcMain.handle("update:setAutoCheck", async (_, enabled: boolean) => {
    updateManager.setAutoCheck(enabled);
    return { success: true };
  });

  ipcMain.handle("update:isAutoCheckEnabled", async () => {
    return updateManager.isAutoCheckEnabled();
  });

  // ===========================================================================
  // Launch at Login
  // ===========================================================================

  ipcMain.handle("autostart:isEnabled", async () => {
    return trayManager.isLaunchAtLoginEnabled();
  });

  ipcMain.handle("autostart:setEnabled", async (_, enabled: boolean) => {
    trayManager.setLaunchAtLogin(enabled);
    return { success: true };
  });

  // ===========================================================================
  // Titlebar
  // ===========================================================================

  ipcMain.handle("update-title-bar-overlay", (_, options: { color: string; symbolColor: string }) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win && process.platform === "win32") {
      try {
        win.setTitleBarOverlay({
          color: options.color,
          symbolColor: options.symbolColor,
          height: 40,
        });
      } catch {
        // Ignore errors on older Electron versions
      }
    }
  });

  // ===========================================================================
  // Startup
  // ===========================================================================

  ipcMain.handle("startup:isReady", async () => {
    return isStartupReady();
  });
}

// --- LAN IP helpers ---

const virtualInterfacePatterns = [
  /^docker/i, /^br-/i, /^veth/i, /^vEthernet/i,
  /^vmnet/i, /^VMware/i, /^VirtualBox/i, /^vboxnet/i,
  /^Hyper-V/i, /^Default Switch/i, /^WSL/i,
  /^tun/i, /^tap/i, /^singbox/i, /^sing-box/i, /^clash/i, /^utun/i,
  /^tailscale/i, /^ZeroTier/i, /^zt/i,
  /^wg/i, /^wireguard/i, /^ham/i, /^Hamachi/i, /^npcap/i, /^lo/i,
];

function isVirtualInterface(name: string): boolean {
  return virtualInterfacePatterns.some((p) => p.test(name));
}

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  let fallback: string | null = null;

  for (const name of Object.keys(interfaces)) {
    const nets = interfaces[name];
    if (!nets) continue;
    const virtual = isVirtualInterface(name);
    for (const net of nets) {
      if (net.internal || net.family !== "IPv4") continue;
      if (!virtual) return net.address;
      if (!fallback) fallback = net.address;
    }
  }
  return fallback ?? "localhost";
}