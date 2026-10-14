import { describe, expect, it } from "vitest";
import { resolveServerRuntimeConfig, type ServerRuntimeConfigOptions } from "../../../server/runtime-config";

const baseOptions: ServerRuntimeConfigOptions = {
  env: {},
  cwd: "/work/project",
  home: "/home/operator",
  platform: "linux",
  appPath: "/opt/codemux",
};

describe("resolveServerRuntimeConfig", () => {
  it.each([
    {
      platform: "linux" as const,
      home: "/home/operator",
      cwd: "/work/project",
      appPath: "/opt/codemux",
      userDataPath: "/home/operator/.config/codemux",
      logsPath: "/home/operator/.config/codemux/logs",
      devicesPath: "/home/operator/.config/codemux/devices.json",
      resourcesPath: "/opt/codemux/resources",
    },
    {
      platform: "darwin" as const,
      home: "/Users/operator",
      cwd: "/work/project",
      appPath: "/opt/codemux",
      userDataPath: "/Users/operator/Library/Application Support/codemux",
      logsPath: "/Users/operator/Library/Logs/codemux",
      devicesPath: "/Users/operator/Library/Application Support/codemux/devices.json",
      resourcesPath: "/opt/codemux/resources",
    },
    {
      platform: "win32" as const,
      home: "C:\\Users\\operator",
      cwd: "C:\\work\\project",
      appPath: "C:\\Program Files\\CodeMux",
      userDataPath: "C:\\Users\\operator\\AppData\\Roaming\\codemux",
      logsPath: "C:\\Users\\operator\\AppData\\Roaming\\codemux\\logs",
      devicesPath: "C:\\Users\\operator\\AppData\\Roaming\\codemux\\devices.json",
      resourcesPath: "C:\\Program Files\\CodeMux\\resources",
    },
  ])("preserves the $platform desktop data and log locations", ({ platform, home, cwd, appPath, ...expected }) => {
    expect(resolveServerRuntimeConfig({ env: {}, platform, home, cwd, appPath })).toEqual({
      ...expected,
      appPath,
      isPackaged: false,
      isDevIsolated: false,
      usesSharedDevDeviceStore: false,
    });
  });

  it.each([
    { platform: "linux" as const, env: { XDG_CONFIG_HOME: "/config" }, root: "/config/codemux" },
    { platform: "win32" as const, env: { APPDATA: "D:\\Roaming" }, root: "D:\\Roaming\\codemux" },
  ])("honors the $platform system data directory override", ({ platform, env, root }) => {
    const config = resolveServerRuntimeConfig({ ...baseOptions, platform, env });
    expect(config.userDataPath).toBe(root);
  });

  it("keeps the default installation and data locations independent of cwd", () => {
    const first = resolveServerRuntimeConfig(baseOptions);
    const second = resolveServerRuntimeConfig({ ...baseOptions, cwd: "/other/launch/directory" });
    expect(second).toEqual(first);
  });

  it.each(["linux", "darwin", "win32"] as const)("keeps explicit data and logs together on %s", (platform) => {
    const windows = platform === "win32";
    const root = windows ? "D:\\server-data" : "/server-data";
    const config = resolveServerRuntimeConfig({
      ...baseOptions,
      platform,
      env: { CODEMUX_DATA_DIR: root },
    });
    expect(config.userDataPath).toBe(root);
    expect(config.logsPath).toBe(`${root}${windows ? "\\" : "/"}logs`);
    expect(config.devicesPath).toBe(`${root}${windows ? "\\" : "/"}devices.json`);
    expect(config.usesSharedDevDeviceStore).toBe(false);
  });

  it("resolves explicit relative paths against the supplied working directory", () => {
    const config = resolveServerRuntimeConfig({
      ...baseOptions,
      env: {
        CODEMUX_DATA_DIR: "state",
        CODEMUX_LOGS_DIR: "logs",
        CODEMUX_DEVICES_FILE: "identity/devices.json",
        CODEMUX_APP_PATH: "installation",
        CODEMUX_RESOURCES_PATH: "binaries",
      },
    });
    expect(config).toMatchObject({
      userDataPath: "/work/project/state",
      logsPath: "/work/project/logs",
      devicesPath: "/work/project/identity/devices.json",
      appPath: "/work/project/installation",
      resourcesPath: "/work/project/binaries",
    });
  });

  it.each([
    { env: { CODEMUX_LEGACY_DEV: "1" }, shared: true, isolated: false, root: "/home/operator/.config/codemux", logs: "/home/operator/.config/codemux/logs", devices: "/work/project/.devices.json" },
    { env: { CODEMUX_DEV_ISOLATED: "1" }, shared: false, isolated: true, root: "/work/project/.codemux-dev/userData", logs: "/work/project/.codemux-dev/logs", devices: "/work/project/.codemux-dev/userData/devices.json" },
    { env: { CODEMUX_LEGACY_DEV: "1", CODEMUX_DEV_ISOLATED: "1" }, shared: false, isolated: true, root: "/work/project/.codemux-dev/userData", logs: "/work/project/.codemux-dev/logs", devices: "/work/project/.codemux-dev/userData/devices.json" },
    { env: { CODEMUX_LEGACY_DEV: "1", CODEMUX_DEVICES_FILE: "/identity/devices.json" }, shared: false, isolated: false, root: "/home/operator/.config/codemux", logs: "/home/operator/.config/codemux/logs", devices: "/identity/devices.json" },
    { env: { CODEMUX_LEGACY_DEV: "1", CODEMUX_DATA_DIR: "/state" }, shared: true, isolated: false, root: "/state", logs: "/state/logs", devices: "/work/project/.devices.json" },
    { env: { CODEMUX_LEGACY_DEV: "1", CODEMUX_DEV_ISOLATED: "1", CODEMUX_DATA_DIR: "/state" }, shared: false, isolated: true, root: "/state", logs: "/state/logs", devices: "/state/devices.json" },
  ])("preserves legacy and isolated path precedence for $env", ({ env, shared, isolated, root, logs, devices }) => {
    const config = resolveServerRuntimeConfig({ ...baseOptions, env });
    expect(config).toMatchObject({
      userDataPath: root,
      logsPath: logs,
      devicesPath: devices,
      isDevIsolated: isolated,
      usesSharedDevDeviceStore: shared,
    });
  });

  it("lets explicit log and identity locations override isolated defaults", () => {
    const config = resolveServerRuntimeConfig({
      ...baseOptions,
      env: {
        CODEMUX_DEV_ISOLATED: "1",
        CODEMUX_LEGACY_DEV: "1",
        CODEMUX_LOGS_DIR: "/server-logs",
        CODEMUX_DEVICES_FILE: "/server-identity/devices.json",
      },
    });
    expect(config).toMatchObject({
      userDataPath: "/work/project/.codemux-dev/userData",
      logsPath: "/server-logs",
      devicesPath: "/server-identity/devices.json",
      usesSharedDevDeviceStore: false,
    });
  });

  it.each([
    { sharedDevDeviceStore: true, env: {}, expected: true },
    { sharedDevDeviceStore: false, env: { CODEMUX_LEGACY_DEV: "1" }, expected: false },
    { sharedDevDeviceStore: true, env: { CODEMUX_DEV_ISOLATED: "1" }, expected: false },
    { sharedDevDeviceStore: true, env: { CODEMUX_BUNDLED_RESOURCES: "1" }, expected: false },
  ])("retains explicit desktop identity policy with a supplied device path: $env", ({ sharedDevDeviceStore, env, expected }) => {
    const config = resolveServerRuntimeConfig({
      ...baseOptions,
      sharedDevDeviceStore,
      env: { ...env, CODEMUX_DEVICES_FILE: "/desktop/.devices.json" },
    });
    expect(config.devicesPath).toBe("/desktop/.devices.json");
    expect(config.usesSharedDevDeviceStore).toBe(expected);
  });

  it.each([
    { value: undefined, packaged: false, isolated: true },
    { value: "0", packaged: false, isolated: true },
    { value: "1", packaged: true, isolated: false },
  ])("only enables bundled binary lookup for the explicit flag $value", ({ value, packaged, isolated }) => {
    const config = resolveServerRuntimeConfig({
      ...baseOptions,
      env: { CODEMUX_BUNDLED_RESOURCES: value, CODEMUX_DEV_ISOLATED: "1", NODE_ENV: "production" },
    });
    expect(config.isPackaged).toBe(packaged);
    expect(config.isDevIsolated).toBe(isolated);
  });
});
