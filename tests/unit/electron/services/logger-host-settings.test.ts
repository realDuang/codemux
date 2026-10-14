import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { host, log } = vi.hoisted(() => {
  const host = {
    paths: { userDataPath: "/mock/data", logsPath: "/mock/logs" },
    useLibraryDefaultLogPath: false,
    logFileName: "desktop.log",
    settings: {
      loadSettings: vi.fn(() => ({ logLevel: "info", theme: "dark" })),
      saveSettings: vi.fn<(patch: Record<string, unknown>) => Promise<void>>(),
    },
  };
  const log = {
    transports: {
      file: {
        resolvePathFn: undefined as unknown,
        maxSize: 0, level: "warn", format: "",
        getFile: vi.fn(() => ({ path: "/mock/logs/desktop.log" })),
      },
      console: { level: "info", format: "" },
    },
    errorHandler: { startCatching: vi.fn() },
    eventLogger: { startLogging: vi.fn() },
    scope: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  };
  return { host, log };
});

vi.mock("#runtime-host", () => ({ runtimeHost: host }));
vi.mock("electron-log/main", () => ({ default: log }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  host.settings.saveSettings.mockResolvedValue(undefined);
});

describe("desktop logger settings", () => {
  it("reads native preferences and the initial log level through the host facade", async () => {
    const { loadSettings, getFileLogLevel } = await import("../../../../electron/main/services/logger");

    expect(getFileLogLevel()).toBe("info");
    expect(loadSettings()).toEqual({ logLevel: "info", theme: "dark" });
    expect(host.settings.loadSettings).toHaveBeenCalledTimes(2);
  });

  it("returns the host persistence promise from settings and log-level writes", async () => {
    const { saveSettings, setFileLogLevel } = await import("../../../../electron/main/services/logger");
    let resolve!: () => void;
    const persisted = new Promise<void>(done => { resolve = done; });
    host.settings.saveSettings.mockReturnValue(persisted);

    expect(saveSettings({ theme: "light" })).toBe(persisted);
    expect(setFileLogLevel("debug")).toBe(persisted);
    expect(host.settings.saveSettings).toHaveBeenNthCalledWith(1, { theme: "light" });
    expect(host.settings.saveSettings).toHaveBeenNthCalledWith(2, { logLevel: "debug" });
    resolve();
    await persisted;

    host.settings.saveSettings.mockRejectedValueOnce(new Error("Owner is unavailable"));
    await expect(setFileLogLevel("warn")).rejects.toThrow("Owner is unavailable");
    expect(setFileLogLevel("invalid")).toBeUndefined();
  });

  it("keeps desktop logs separate from the runtime's main log", async () => {
    await import("../../../../electron/main/services/logger");
    const resolvePath = log.transports.file.resolvePathFn as (variables: { libraryDefaultDir: string; fileName: string }) => string;

    expect(resolvePath({ libraryDefaultDir: "/library/logs", fileName: "main.log" })).toBe(path.join("/mock/logs", "desktop.log"));
    expect(log.transports.file.maxSize).toBe(5 * 1024 * 1024);
  });
});
