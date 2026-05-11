import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

const { mockGetDevicesPath, mockUsesSharedDevDeviceStorePath } = vi.hoisted(() => ({
  mockGetDevicesPath: vi.fn(() => "/tmp/codemux-devices.json"),
  mockUsesSharedDevDeviceStorePath: vi.fn(() => false),
}));

vi.mock("fs");
vi.mock("../../../../electron/main/services/app-paths", () => ({
  getDevicesPath: mockGetDevicesPath,
  usesSharedDevDeviceStorePath: mockUsesSharedDevDeviceStorePath,
}));

function deviceData(devices: Record<string, unknown> = {}): string {
  return JSON.stringify({
    devices,
    pendingRequests: {},
    jwtSecret: "test-secret",
  });
}

async function importDeviceStore() {
  vi.resetModules();
  return import("../../../../electron/main/services/device-store");
}

describe("electron device store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDevicesPath.mockReturnValue("/tmp/codemux-devices.json");
    mockUsesSharedDevDeviceStorePath.mockReturnValue(false);
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(deviceData({
      d1: { id: "d1", name: "Initial", lastSeenAt: 1 },
    }));
  });

  it("lazily initializes once using the configured devices path", async () => {
    const { deviceStore } = await importDeviceStore();

    expect(fs.readFileSync).not.toHaveBeenCalled();

    deviceStore.init();
    deviceStore.init();

    expect(mockGetDevicesPath).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync).toHaveBeenCalledWith("/tmp/codemux-devices.json", "utf-8");
    expect(deviceStore.getDevice("d1")?.name).toBe("Initial");
  });

  it("only reloads after initialization", async () => {
    const { deviceStore } = await importDeviceStore();

    deviceStore.reload();
    expect(fs.readFileSync).not.toHaveBeenCalled();

    deviceStore.init();
    deviceStore.reload();

    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });

  it("reloads before reads when using the shared dev devices file", async () => {
    const { deviceStore } = await importDeviceStore();
    deviceStore.init();

    mockUsesSharedDevDeviceStorePath.mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(deviceData({
      d2: { id: "d2", name: "Reloaded", lastSeenAt: 2 },
    }));

    expect(deviceStore.getDevice("d2")?.name).toBe("Reloaded");
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });

  it("does not reload before reads in isolated device-store mode", async () => {
    const { deviceStore } = await importDeviceStore();
    deviceStore.init();

    (fs.readFileSync as any).mockReturnValue(deviceData({
      d2: { id: "d2", name: "Reloaded", lastSeenAt: 2 },
    }));

    expect(deviceStore.getDevice("d2")).toBeUndefined();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it("does not reload before reads when it has not been initialized", async () => {
    const { deviceStore } = await importDeviceStore();
    mockUsesSharedDevDeviceStorePath.mockReturnValue(true);

    expect(() => deviceStore.getDevice("d1")).toThrow("DeviceStore not initialized");
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });
});
