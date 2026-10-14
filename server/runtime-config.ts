import path from "node:path";
import type { RuntimePathConfig } from "../shared/runtime-paths";

export interface ServerRuntimeConfigOptions {
  env: Readonly<NodeJS.ProcessEnv>;
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  /** Installation root, independent of the working directory used to start the server. */
  appPath: string;
  /** Explicit policy captured from the desktop parent before launch flags are removed. */
  sharedDevDeviceStore?: boolean;
}

export interface ServerRuntimeConfig extends RuntimePathConfig {
  devicesPath: string;
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
  isDevIsolated: boolean;
  usesSharedDevDeviceStore: boolean;
}

export function resolveServerRuntimeConfig(options: ServerRuntimeConfigOptions): ServerRuntimeConfig {
  const { env, cwd, home, platform } = options;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const isPackaged = env.CODEMUX_BUNDLED_RESOURCES === "1";
  const isDevIsolated = !isPackaged && env.CODEMUX_DEV_ISOLATED === "1";
  const usesSharedDevDeviceStore = options.sharedDevDeviceStore === undefined
    ? env.CODEMUX_LEGACY_DEV === "1" && !isDevIsolated && !env.CODEMUX_DEVICES_FILE
    : options.sharedDevDeviceStore && !isPackaged && !isDevIsolated;

  let defaultDataPath: string;
  if (platform === "darwin") {
    defaultDataPath = paths.join(home, "Library", "Application Support", "codemux");
  } else if (platform === "win32") {
    defaultDataPath = paths.join(env.APPDATA || paths.join(home, "AppData", "Roaming"), "codemux");
  } else {
    defaultDataPath = paths.join(env.XDG_CONFIG_HOME || paths.join(home, ".config"), "codemux");
  }

  const isolatedRoot = paths.join(cwd, ".codemux-dev");
  const userDataPath = paths.resolve(cwd, env.CODEMUX_DATA_DIR
    || (isDevIsolated ? paths.join(isolatedRoot, "userData") : defaultDataPath));
  const defaultLogsPath = env.CODEMUX_DATA_DIR
    ? paths.join(userDataPath, "logs")
    : isDevIsolated
      ? paths.join(isolatedRoot, "logs")
      : platform === "darwin"
        ? paths.join(home, "Library", "Logs", "codemux")
        : paths.join(userDataPath, "logs");
  const logsPath = paths.resolve(cwd, env.CODEMUX_LOGS_DIR || defaultLogsPath);
  const devicesPath = paths.resolve(cwd, env.CODEMUX_DEVICES_FILE
    || (usesSharedDevDeviceStore ? paths.join(cwd, ".devices.json") : paths.join(userDataPath, "devices.json")));
  const appPath = paths.resolve(cwd, env.CODEMUX_APP_PATH || options.appPath);
  const resourcesPath = paths.resolve(cwd, env.CODEMUX_RESOURCES_PATH || paths.join(appPath, "resources"));

  return {
    userDataPath,
    logsPath,
    devicesPath,
    appPath,
    resourcesPath,
    isPackaged,
    isDevIsolated,
    usesSharedDevDeviceStore,
  };
}
