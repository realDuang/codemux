import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  captureServerRuntimeRole,
  configureServerRuntimeEnvironment,
  sendDesktopMessage,
  watchDesktopParent,
  watchRuntimeParent,
  type ServerRuntimeRole,
} from "../../../server/runtime-role";

const desktopRole: ServerRuntimeRole = Object.freeze({
  kind: "desktop",
  webMode: "dev-proxy",
  desktopParentPid: 123,
  usesSharedDevDeviceStore: true,
});
const standaloneRole: ServerRuntimeRole = Object.freeze({ kind: "standalone", webMode: "static" });
const developmentRole: ServerRuntimeRole = Object.freeze({ kind: "standalone", webMode: "dev-proxy", developmentParentPid: 456 });

describe("captureServerRuntimeRole", () => {
  it("captures an immutable desktop role and removes launch flags before child inheritance", () => {
    const env = {
      ELECTRON_RUN_AS_NODE: "1",
      CODEMUX_DESKTOP_HOST: "1",
      CODEMUX_DESKTOP_PARENT_PID: "123",
      CODEMUX_DEV_PARENT_PID: "ignored-for-desktop",
      CODEMUX_SHARED_DEV_DEVICE_STORE: "1",
      CODEMUX_RUNTIME_WEB_MODE: "dev-proxy",
      CODEMUX_SERVER_MODE: "0",
      CODEMUX_DATA_DIR: "/existing/data",
      CODEMUX_DEVICES_FILE: "/existing/.devices.json",
    };
    const role = captureServerRuntimeRole(env);
    expect(role).toEqual(desktopRole);
    expect(Object.isFrozen(role)).toBe(true);
    expect(env).toEqual({
      CODEMUX_RUNTIME_WEB_MODE: "dev-proxy",
      CODEMUX_SERVER_MODE: "0",
      CODEMUX_DATA_DIR: "/existing/data",
      CODEMUX_DEVICES_FILE: "/existing/.devices.json",
    });
    env.CODEMUX_RUNTIME_WEB_MODE = "static";
    expect(role.webMode).toBe("dev-proxy");
  });

  it("uses the standalone role without a desktop flag even under Electron-as-Node", () => {
    const env = { ELECTRON_RUN_AS_NODE: "1", CODEMUX_DESKTOP_PARENT_PID: "123" };
    expect(captureServerRuntimeRole(env)).toEqual(standaloneRole);
    expect(env).toEqual({});
  });

  it("captures an explicit standalone development parent and consumes its launch flag", () => {
    const env = { CODEMUX_RUNTIME_WEB_MODE: "dev-proxy", CODEMUX_DEV_PARENT_PID: "456", CODEMUX_SERVER_MODE: "0" };
    const role = captureServerRuntimeRole(env);
    expect(role).toEqual(developmentRole);
    expect(Object.isFrozen(role)).toBe(true);
    expect(env).toEqual({ CODEMUX_RUNTIME_WEB_MODE: "dev-proxy", CODEMUX_SERVER_MODE: "0" });
  });

  it("allows an independently managed standalone development runtime", () => {
    expect(captureServerRuntimeRole({ CODEMUX_RUNTIME_WEB_MODE: "dev-proxy" })).toEqual({ kind: "standalone", webMode: "dev-proxy" });
  });

  it("defaults a desktop child to static mode and private device storage", () => {
    expect(captureServerRuntimeRole({ CODEMUX_DESKTOP_HOST: "1", CODEMUX_DESKTOP_PARENT_PID: "123" })).toEqual({
      kind: "desktop", webMode: "static", desktopParentPid: 123, usesSharedDevDeviceStore: false,
    });
  });

  it.each([
    { CODEMUX_DESKTOP_HOST: "unknown" },
    { CODEMUX_DESKTOP_HOST: "1" },
    { CODEMUX_DESKTOP_HOST: "1", CODEMUX_DESKTOP_PARENT_PID: "0" },
    { CODEMUX_DESKTOP_HOST: "1", CODEMUX_DESKTOP_PARENT_PID: "-1" },
    { CODEMUX_DESKTOP_HOST: "1", CODEMUX_DESKTOP_PARENT_PID: "1e3" },
    { CODEMUX_DESKTOP_HOST: "1", CODEMUX_DESKTOP_PARENT_PID: "9007199254740992" },
    { CODEMUX_DESKTOP_HOST: "1", CODEMUX_DESKTOP_PARENT_PID: "123", CODEMUX_RUNTIME_WEB_MODE: "unknown" },
    { CODEMUX_DESKTOP_HOST: "1", CODEMUX_DESKTOP_PARENT_PID: "123", CODEMUX_SHARED_DEV_DEVICE_STORE: "true" },
    { CODEMUX_RUNTIME_WEB_MODE: "unknown" },
    { CODEMUX_DEV_PARENT_PID: "456" },
    { CODEMUX_RUNTIME_WEB_MODE: "static", CODEMUX_DEV_PARENT_PID: "456" },
    ...["", "0", "-1", "1e3", "1.5", " 12 ", "9007199254740992"].map(CODEMUX_DEV_PARENT_PID => ({
      CODEMUX_RUNTIME_WEB_MODE: "dev-proxy", CODEMUX_DEV_PARENT_PID,
    })),
  ])("rejects invalid role configuration before runtime imports: %j", values => {
    const env = { ELECTRON_RUN_AS_NODE: "1", ...values };
    expect(() => captureServerRuntimeRole(env)).toThrow();
    expect(env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(env).not.toHaveProperty("CODEMUX_DESKTOP_HOST");
    expect(env).not.toHaveProperty("CODEMUX_DESKTOP_PARENT_PID");
    expect(env).not.toHaveProperty("CODEMUX_DEV_PARENT_PID");
    expect(env).not.toHaveProperty("CODEMUX_SHARED_DEV_DEVICE_STORE");
  });
});

describe("configureServerRuntimeEnvironment", () => {
  it.each([undefined, "0", "1"])("preserves the desktop's inherited server policy %s", value => {
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { CODEMUX_SERVER_MODE: value };
    configureServerRuntimeEnvironment(desktopRole, env, "darwin");
    expect(env.CODEMUX_SERVER_MODE).toBe(value);
    expect(env.CODEMUX_RUNTIME_WEB_MODE).toBe("dev-proxy");
    expect(env.CODEMUX_DISABLE_COPILOT_DBUS).toBeUndefined();
  });

  it("preserves standalone policy and Linux defaults", () => {
    const env = { CODEMUX_SERVER_MODE: "0", CODEMUX_RUNTIME_WEB_MODE: "dev-proxy" };
    configureServerRuntimeEnvironment(standaloneRole, env, "linux");
    expect(env).toEqual({ CODEMUX_SERVER_MODE: "1", CODEMUX_RUNTIME_WEB_MODE: "static", CODEMUX_DISABLE_COPILOT_DBUS: "1" });
  });

  it("keeps standalone policy when a development launcher owns the runtime", () => {
    const env: NodeJS.ProcessEnv = { CODEMUX_SERVER_MODE: "0", CODEMUX_DISABLE_COPILOT_DBUS: "0" };
    configureServerRuntimeEnvironment(developmentRole, env, "linux");
    expect(env).toEqual({ CODEMUX_SERVER_MODE: "1", CODEMUX_RUNTIME_WEB_MODE: "dev-proxy", CODEMUX_DISABLE_COPILOT_DBUS: "0" });
  });

  it.each([undefined, "0", "1"])("preserves the Linux desktop's inherited DBus policy %s", value => {
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { CODEMUX_DISABLE_COPILOT_DBUS: value };
    configureServerRuntimeEnvironment(desktopRole, env, "linux");
    expect(env.CODEMUX_DISABLE_COPILOT_DBUS).toBe(value);
  });
});

describe("sendDesktopMessage", () => {
  const message = { type: "codemux.notify", title: "Approval requested", body: "Review a device request." };

  it("relays a desktop notification only through a connected parent IPC channel", () => {
    const send = vi.fn(() => true);
    sendDesktopMessage(desktopRole, message, { connected: true, send });
    expect(send).toHaveBeenCalledWith(message, expect.any(Function));
  });

  it("does not relay standalone notifications or use a closed channel", () => {
    const send = vi.fn(() => true);
    sendDesktopMessage(standaloneRole, message, { connected: true, send });
    sendDesktopMessage(developmentRole, message, { connected: true, send });
    sendDesktopMessage(desktopRole, message, { connected: false, send });
    sendDesktopMessage(desktopRole, message, { connected: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("tolerates disconnect races without interrupting service shutdown", () => {
    expect(() => sendDesktopMessage(desktopRole, message, {
      connected: true,
      send: () => { throw new Error("IPC channel closed"); },
    })).not.toThrow();
    expect(() => sendDesktopMessage(desktopRole, message, {
      connected: true,
      send: (_message, done) => { done(new Error("IPC channel closed")); return false; },
    })).not.toThrow();
  });
});

describe("watchRuntimeParent", () => {
  it.each([desktopRole, developmentRole])("stops a %j child once after its parent disconnects", role => {
    const ipc = Object.assign(new EventEmitter(), { connected: true });
    const stop = vi.fn();
    watchRuntimeParent(role, stop, ipc);
    expect(stop).not.toHaveBeenCalled();
    ipc.emit("disconnect");
    ipc.emit("disconnect");
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each([desktopRole, developmentRole])("stops an already orphaned %j child and allows listener disposal", role => {
    const ipc = Object.assign(new EventEmitter(), { connected: false });
    const stop = vi.fn();
    const dispose = watchRuntimeParent(role, stop, ipc);
    expect(stop).toHaveBeenCalledOnce();
    ipc.emit("disconnect");
    expect(stop).toHaveBeenCalledOnce();
    dispose();
    expect(ipc.listenerCount("disconnect")).toBe(0);
  });

  it.each([standaloneRole, { kind: "standalone", webMode: "dev-proxy" } as const])("leaves an independent %j service lifetime outside IPC control", role => {
    const ipc = Object.assign(new EventEmitter(), { connected: false });
    const stop = vi.fn();
    watchRuntimeParent(role, stop, ipc)();
    ipc.emit("disconnect");
    expect(stop).not.toHaveBeenCalled();
    expect(ipc.listenerCount("disconnect")).toBe(0);
  });

  it("retains the existing desktop export", () => {
    expect(watchDesktopParent).toBe(watchRuntimeParent);
  });
});
