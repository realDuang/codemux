import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: { isPackaged: false, getAppPath: vi.fn(() => "source-root") },
  image: { resize: vi.fn(), setTemplateImage: vi.fn() },
  createFromPath: vi.fn(),
  createTray: vi.fn(),
  tray: {
    setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn(), destroy: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: mocks.app,
  nativeImage: { createFromPath: mocks.createFromPath },
  Menu: { buildFromTemplate: vi.fn(() => []) },
  Tray: class { constructor(icon: unknown) { mocks.createTray(icon); return mocks.tray; } },
}));
vi.mock("../../../../electron/main/window-manager", () => ({
  getMainWindow: vi.fn(() => null), createWindow: vi.fn(),
}));
vi.mock("../../../../electron/main/services/logger", () => ({
  loadSettings: vi.fn(() => ({})), saveSettings: vi.fn(),
}));

const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const { trayManager } = await import("../../../../electron/main/services/tray-manager");

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: "packaged-resources" });
  mocks.createFromPath.mockReturnValue(mocks.image);
});

afterEach(() => {
  trayManager.destroy();
  Object.defineProperty(process, "platform", originalPlatform);
  if (originalResourcesPath) Object.defineProperty(process, "resourcesPath", originalResourcesPath);
  else Reflect.deleteProperty(process, "resourcesPath");
});

describe("trayManager.init", () => {
  it.each([
    ["darwin", true, "trayTemplate.png"],
    ["darwin", false, "trayTemplate.png"],
    ["win32", true, "icon.ico"],
    ["win32", false, "icon.ico"],
    ["linux", true, "tray.png"],
    ["linux", false, "tray.png"],
  ] as const)("loads the native %s tray icon with packaged=%s", (platform, isPackaged, filename) => {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    mocks.app.isPackaged = isPackaged;
    const expectedPath = isPackaged
      ? join("packaged-resources", "app.asar", "out", "web", "assets", filename)
      : join("source-root", "public", "assets", filename);
    trayManager.init();

    if (platform === "win32") {
      expect(mocks.createFromPath).not.toHaveBeenCalled();
      expect(mocks.createTray).toHaveBeenCalledWith(expectedPath);
    } else {
      expect(mocks.createFromPath).toHaveBeenCalledWith(expectedPath);
      expect(mocks.createTray).toHaveBeenCalledWith(mocks.image);
    }
    if (platform === "darwin") {
      expect(mocks.image.setTemplateImage).toHaveBeenCalledWith(true);
    } else {
      expect(mocks.image.setTemplateImage).not.toHaveBeenCalled();
    }
    expect(mocks.image.resize).not.toHaveBeenCalled();
    expect(mocks.tray.setToolTip).toHaveBeenCalledWith("CodeMux");
  });
});
