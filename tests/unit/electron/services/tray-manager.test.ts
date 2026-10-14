import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: { isPackaged: false, getAppPath: vi.fn(() => "source-root") },
  image: { resize: vi.fn() },
  createFromPath: vi.fn(),
  tray: {
    setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn(), destroy: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: mocks.app,
  nativeImage: { createFromPath: mocks.createFromPath },
  Menu: { buildFromTemplate: vi.fn(() => []) },
  Tray: class { constructor() { return mocks.tray; } },
}));
vi.mock("../../../../electron/main/window-manager", () => ({
  getMainWindow: vi.fn(() => null), createWindow: vi.fn(),
}));
vi.mock("../../../../electron/main/services/logger", () => ({
  loadSettings: vi.fn(() => ({})), saveSettings: vi.fn(),
}));

const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
const { trayManager } = await import("../../../../electron/main/services/tray-manager");

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: "packaged-resources" });
  mocks.createFromPath.mockReturnValue(mocks.image);
  mocks.image.resize.mockReturnValue({});
});

afterEach(() => {
  trayManager.destroy();
  if (originalResourcesPath) Object.defineProperty(process, "resourcesPath", originalResourcesPath);
  else Reflect.deleteProperty(process, "resourcesPath");
});

describe("trayManager.init", () => {
  it.each([
    [true, join("packaged-resources", "app.asar", "out", "web", "assets", "favicon-32x32.png")],
    [false, join("source-root", "public", "assets", "favicon-32x32.png")],
  ])("loads the existing tray icon with packaged=%s", (isPackaged, expectedPath) => {
    mocks.app.isPackaged = isPackaged;
    trayManager.init();

    expect(mocks.createFromPath).toHaveBeenCalledWith(expectedPath);
    expect(mocks.image.resize).toHaveBeenCalledWith({ width: 16, height: 16 });
    expect(mocks.tray.setToolTip).toHaveBeenCalledWith("CodeMux");
  });
});
