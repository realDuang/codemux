import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HostPlatform } from "../shared/host-platform";
import { resolveServerRuntimeConfig } from "./runtime-config";
import { sendDesktopMessage, serverRuntimeRole } from "./runtime-role";

// The server entry applies CLI overrides before importing this host and its services.
const config = resolveServerRuntimeConfig({
  env: process.env,
  cwd: process.cwd(),
  home: os.homedir(),
  platform: process.platform,
  appPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  sharedDevDeviceStore: serverRuntimeRole.kind === "desktop"
    ? serverRuntimeRole.usesSharedDevDeviceStore
    : undefined,
});

export const runtimeHost: HostPlatform = {
  paths: config,
  appPath: config.appPath,
  resourcesPath: config.resourcesPath,
  isPackaged: config.isPackaged,
  isDevIsolated: config.isDevIsolated,
  usesSharedDevDeviceStore: config.usesSharedDevDeviceStore,
  useLibraryDefaultLogPath: false,
  notify(title, body) {
    sendDesktopMessage(serverRuntimeRole, { type: "codemux.notify", title, body });
  },
};

export default runtimeHost;
