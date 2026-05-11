import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { mockApp, mockPaths } = vi.hoisted(() => {
  const mockPaths: Record<string, string> = {};
  const mockApp = {
    isPackaged: false,
    getPath: vi.fn((name: string) => mockPaths[name] ?? `/mock/${name}`),
    setPath: vi.fn((name: string, value: string) => {
      mockPaths[name] = value;
    }),
  };
  return { mockApp, mockPaths };
});

vi.mock("electron", () => ({ app: mockApp }));

import {
  configureDevIsolatedAppPaths,
  DEV_ISOLATED_ENV,
  getChannelsPath,
  getDevicesPath,
  getSettingsPath,
  isDevIsolatedMode,
  usesSharedDevDeviceStorePath,
} from "../../../../electron/main/services/app-paths";

let tmpDirs: string[] = [];

function setUserDataPath(userDataPath: string): void {
  mockPaths.userData = userDataPath;
}

describe("app-paths", () => {
  beforeEach(() => {
    delete process.env[DEV_ISOLATED_ENV];
    mockApp.isPackaged = false;
    mockApp.getPath.mockClear();
    mockApp.setPath.mockClear();
    for (const key of Object.keys(mockPaths)) delete mockPaths[key];
    setUserDataPath("/mock/userData");
  });

  afterEach(() => {
    delete process.env[DEV_ISOLATED_ENV];
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it("does not change Electron app paths outside isolated dev mode", () => {
    configureDevIsolatedAppPaths("/repo");

    expect(isDevIsolatedMode()).toBe(false);
    expect(mockApp.setPath).not.toHaveBeenCalled();
  });

  it("configures userData, sessionData, and logs under .codemux-dev in isolated dev mode", () => {
    process.env[DEV_ISOLATED_ENV] = "1";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codemux-app-paths-"));
    tmpDirs.push(cwd);

    configureDevIsolatedAppPaths(cwd);

    const root = path.join(cwd, ".codemux-dev");
    expect(mockApp.setPath).toHaveBeenCalledWith("userData", path.join(root, "userData"));
    expect(mockApp.setPath).toHaveBeenCalledWith("sessionData", path.join(root, "sessionData"));
    expect(mockApp.setPath).toHaveBeenCalledWith("logs", path.join(root, "logs"));
    expect(fs.existsSync(path.join(root, "userData"))).toBe(true);
    expect(fs.existsSync(path.join(root, "sessionData"))).toBe(true);
    expect(fs.existsSync(path.join(root, "logs"))).toBe(true);
  });

  it("keeps normal dev devices in the repo file and isolates them when requested", () => {
    expect(usesSharedDevDeviceStorePath()).toBe(true);
    expect(getDevicesPath()).toMatch(/\.devices\.json$/);

    process.env[DEV_ISOLATED_ENV] = "1";

    expect(usesSharedDevDeviceStorePath()).toBe(false);
    expect(getDevicesPath()).toBe(path.join("/mock/userData", "devices.json"));
  });

  it("uses userData for packaged paths and derived config files", () => {
    mockApp.isPackaged = true;

    expect(getDevicesPath()).toBe(path.join("/mock/userData", "devices.json"));
    expect(getSettingsPath()).toBe(path.join("/mock/userData", "settings.json"));
    expect(getChannelsPath()).toBe(path.join("/mock/userData", "channels"));
  });
});
