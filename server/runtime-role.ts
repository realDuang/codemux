import type { Serializable } from "node:child_process";

export type ServerRuntimeRole = Readonly<
  | { kind: "standalone"; webMode: "static" }
  | { kind: "standalone"; webMode: "dev-proxy"; developmentParentPid?: number }
  | {
    kind: "desktop";
    webMode: "static" | "dev-proxy";
    desktopParentPid: number;
    usesSharedDevDeviceStore: boolean;
  }
>;

interface ParentIpc {
  readonly connected?: boolean;
  send?(message: Serializable, callback: (error: Error | null) => void): boolean;
  once(event: "disconnect", listener: () => void): unknown;
  removeListener(event: "disconnect", listener: () => void): unknown;
}

/** Consume launch-only flags before an engine or PTY can inherit the environment. */
export function captureServerRuntimeRole(env: NodeJS.ProcessEnv): ServerRuntimeRole {
  const desktop = env.CODEMUX_DESKTOP_HOST;
  const parentPid = env.CODEMUX_DESKTOP_PARENT_PID;
  const devParentPid = env.CODEMUX_DEV_PARENT_PID;
  const sharedDevices = env.CODEMUX_SHARED_DEV_DEVICE_STORE;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CODEMUX_DESKTOP_HOST;
  delete env.CODEMUX_DESKTOP_PARENT_PID;
  delete env.CODEMUX_DEV_PARENT_PID;
  delete env.CODEMUX_SHARED_DEV_DEVICE_STORE;

  const webMode = env.CODEMUX_RUNTIME_WEB_MODE ?? "static";
  if (webMode !== "static" && webMode !== "dev-proxy") {
    throw new Error("CODEMUX_RUNTIME_WEB_MODE must be static or dev-proxy");
  }
  if (desktop === undefined) {
    if (devParentPid !== undefined) {
      if (webMode !== "dev-proxy") throw new Error("CODEMUX_DEV_PARENT_PID requires dev-proxy mode");
      const developmentParentPid = Number(devParentPid);
      if (!/^\d+$/.test(devParentPid) || !Number.isSafeInteger(developmentParentPid) || developmentParentPid < 1) {
        throw new Error("CODEMUX_DEV_PARENT_PID must be a positive process ID");
      }
      return Object.freeze({ kind: "standalone", webMode, developmentParentPid });
    }
    return Object.freeze({ kind: "standalone", webMode });
  }
  if (desktop !== "1") throw new Error("CODEMUX_DESKTOP_HOST must be 1 when provided");
  const desktopParentPid = Number(parentPid);
  if (!parentPid || !/^\d+$/.test(parentPid) || !Number.isSafeInteger(desktopParentPid) || desktopParentPid < 1) {
    throw new Error("CODEMUX_DESKTOP_PARENT_PID must be a positive process ID");
  }
  if (sharedDevices !== undefined && sharedDevices !== "0" && sharedDevices !== "1") {
    throw new Error("CODEMUX_SHARED_DEV_DEVICE_STORE must be 0 or 1 when provided");
  }
  return Object.freeze({
    kind: "desktop",
    webMode,
    desktopParentPid,
    usesSharedDevDeviceStore: sharedDevices === "1",
  });
}

export function configureServerRuntimeEnvironment(
  role: ServerRuntimeRole,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): void {
  // Desktop inherits its existing headless/auth policy; standalone retains server policy.
  if (role.kind === "standalone") env.CODEMUX_SERVER_MODE = "1";
  env.CODEMUX_RUNTIME_WEB_MODE = role.webMode;
  if (role.kind === "standalone" && platform === "linux") env.CODEMUX_DISABLE_COPILOT_DBUS ??= "1";
}

export function sendDesktopMessage(
  role: ServerRuntimeRole,
  message: Serializable,
  ipc: Pick<ParentIpc, "connected" | "send"> = process,
): void {
  if (role.kind !== "desktop" || !ipc.connected || !ipc.send) return;
  // Disconnect can race a notification. The parent-loss handler owns shutdown.
  try { ipc.send(message, () => {}); } catch { /* The parent is already gone. */ }
}

export function watchRuntimeParent(
  role: ServerRuntimeRole,
  onDisconnect: () => void,
  ipc: ParentIpc = process,
): () => void {
  if (role.kind !== "desktop" && (role.webMode !== "dev-proxy" || role.developmentParentPid === undefined)) return () => {};
  let disconnected = false;
  const stop = () => {
    if (disconnected) return;
    disconnected = true;
    onDisconnect();
  };
  ipc.once("disconnect", stop);
  if (!ipc.connected) stop();
  return () => ipc.removeListener("disconnect", stop);
}

// Keep the original export for existing desktop integrations.
export const watchDesktopParent = watchRuntimeParent;

// Imported by the entry before any service imports, and reused without rereading env.
export const serverRuntimeRole = captureServerRuntimeRole(process.env);
