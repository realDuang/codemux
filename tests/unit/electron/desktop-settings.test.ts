import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireRuntimeLock, type RuntimeLock } from "../../../shared/runtime-lock";
import { startHostControlServer, type HostControlServer } from "../../../shared/host-control-server";
import { HOST_CONTROL_FILENAME } from "../../../shared/host-control-types";
import { createSettingsStore } from "../../../shared/settings-store";

const native = vi.hoisted(() => ({ dataPath: "" }));
vi.mock("electron", () => ({ app: { getPath: () => native.dataPath } }));

let directory: string;
let ownership: RuntimeLock | undefined;
let host: HostControlServer | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function store() {
  return createSettingsStore({ getFilePath: () => path.join(native.dataPath, "settings.json"), createDirectory: true });
}

async function startOwner(invoke: (method: string, args?: unknown[]) => unknown | Promise<unknown>) {
  ownership ??= await acquireRuntimeLock(native.dataPath);
  host = await startHostControlServer({
    dataPath: native.dataPath,
    invoke,
    getStatus: () => ({
      pid: process.pid, phase: "ready", ready: true, dataPath: native.dataPath,
      webPort: 8233, gatewayUrl: "ws://127.0.0.1:8233/ws",
    }),
    stop: () => {},
  });
}

beforeEach(async () => {
  vi.resetModules();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "codemux-desktop-settings-"));
  native.dataPath = path.join(directory, "data");
});

afterEach(async () => {
  await host?.close();
  host = undefined;
  await ownership?.release();
  ownership = undefined;
  await fs.rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("desktopSettings", () => {
  it("reads the current persisted settings synchronously without creating a store", async () => {
    const { desktopSettings } = await import("../../../electron/main/desktop-settings");
    expect(desktopSettings.loadSettings()).toEqual({});
    await expect(fs.stat(native.dataPath)).rejects.toMatchObject({ code: "ENOENT" });

    store().saveSettings({ theme: "light" });
    expect(desktopSettings.loadSettings()).toEqual({ theme: "light" });
    store().saveSettings({ theme: "dark" });
    expect(desktopSettings.loadSettings()).toEqual({ theme: "dark" });
  });

  it("serializes stopped-host writes under the runtime lease and preserves merge semantics", async () => {
    const { desktopSettings, flushDesktopSettings } = await import("../../../electron/main/desktop-settings");
    store().saveSettings({ models: { first: "a", nested: { old: 1 } }, recent: [1], untouched: true });
    const patch = { models: { second: "b", nested: { next: 2 } }, recent: [2] };
    const first = desktopSettings.saveSettings(patch);
    patch.models.second = "mutated";
    const second = desktopSettings.saveSettings({ models: { third: "c" }, locale: "en" });
    await flushDesktopSettings();
    await Promise.all([first, second]);

    expect(desktopSettings.loadSettings()).toEqual({
      models: { first: "a", second: "b", third: "c", nested: { next: 2 } },
      recent: [2], untouched: true, locale: "en",
    });
    ownership = await acquireRuntimeLock(native.dataPath);
    expect(await fs.readdir(native.dataPath)).toEqual(["settings.json"]);
  });

  it("routes to the running owner and preserves owner changes made before applying a queued patch", async () => {
    const { desktopSettings, flushDesktopSettings } = await import("../../../electron/main/desktop-settings");
    store().saveSettings({ models: { original: "a" }, autoUpdate: true });
    const entered = deferred();
    const release = deferred();
    const invoke = vi.fn(async (method: string, args: unknown[] = []) => {
      expect(method).toBe("settings:save");
      entered.resolve();
      await release.promise;
      store().saveSettings(args[0] as Record<string, unknown>);
      return { success: true };
    });
    await startOwner(invoke);

    const write = desktopSettings.saveSettings({ models: { desktop: "b" }, autoUpdate: false });
    await entered.promise;
    const flushed = vi.fn();
    const flush = flushDesktopSettings().then(flushed);
    expect(flushed).not.toHaveBeenCalled();
    expect(desktopSettings.loadSettings().autoUpdate).toBe(true);
    store().saveSettings({ models: { server: "c" } });
    release.resolve();
    await Promise.all([write, flush]);

    expect(invoke).toHaveBeenCalledOnce();
    expect(flushed).toHaveBeenCalledOnce();
    expect(desktopSettings.loadSettings()).toEqual({ models: { original: "a", desktop: "b", server: "c" }, autoUpdate: false });
  });

  it("never writes while a starting owner holds the lease without control metadata", async () => {
    const { desktopSettings } = await import("../../../electron/main/desktop-settings");
    store().saveSettings({ closeAction: "tray" });
    ownership = await acquireRuntimeLock(native.dataPath);

    await expect(desktopSettings.saveSettings({ closeAction: "quit" })).rejects.toMatchObject({ code: "ELOCKED" });
    expect(desktopSettings.loadSettings()).toEqual({ closeAction: "tray" });
  });

  it("rediscovers an owner that publishes control metadata after acquiring the lease", async () => {
    const { desktopSettings } = await import("../../../electron/main/desktop-settings");
    ownership = await acquireRuntimeLock(native.dataPath);
    const invoke = vi.fn((method: string, args: unknown[] = []) => {
      expect(method).toBe("settings:save");
      store().saveSettings(args[0] as Record<string, unknown>);
    });
    const write = desktopSettings.saveSettings({ launchAtLogin: true });
    await new Promise(resolve => setTimeout(resolve, 125));
    await startOwner(invoke);
    await write;

    expect(invoke).toHaveBeenCalledOnce();
    expect(desktopSettings.loadSettings()).toEqual({ launchAtLogin: true });
  });

  it("uses a stopped-host lease when stale crash metadata no longer has a listener", async () => {
    const { desktopSettings } = await import("../../../electron/main/desktop-settings");
    await startOwner(() => {});
    const metadataPath = path.join(native.dataPath, HOST_CONTROL_FILENAME);
    const staleMetadata = await fs.readFile(metadataPath);
    await host!.close();
    host = undefined;
    await ownership!.release();
    ownership = undefined;
    await fs.writeFile(metadataPath, staleMetadata, { mode: 0o600 });

    await desktopSettings.saveSettings({ locale: "zh" });
    expect(desktopSettings.loadSettings()).toEqual({ locale: "zh" });
    ownership = await acquireRuntimeLock(native.dataPath);
  });

  it("propagates rejected owner writes, drains the queue, and accepts later patches", async () => {
    const { desktopSettings, flushDesktopSettings } = await import("../../../electron/main/desktop-settings");
    store().saveSettings({ autoUpdate: true });
    const entered = deferred();
    const release = deferred();
    await startOwner(async (_method, args = []) => {
      const patch = args[0] as Record<string, unknown>;
      if ("autoUpdate" in patch) {
        entered.resolve();
        await release.promise;
        throw new Error("Settings write failed");
      }
      store().saveSettings(patch);
    });

    const first = desktopSettings.saveSettings({ autoUpdate: false });
    const firstResult = expect(first).rejects.toMatchObject({ code: "REQUEST_FAILED", message: "Settings write failed" });
    await entered.promise;
    const second = desktopSettings.saveSettings({ locale: "en" });
    const flush = expect(flushDesktopSettings()).rejects.toMatchObject({ code: "REQUEST_FAILED" });
    release.resolve();
    await Promise.all([firstResult, second, flush]);

    expect(desktopSettings.loadSettings()).toEqual({ autoUpdate: true, locale: "en" });
    await expect(flushDesktopSettings()).resolves.toBeUndefined();
    await desktopSettings.saveSettings({ theme: "dark" });
    expect(desktopSettings.loadSettings().theme).toBe("dark");
  });

  it("releases the stopped-host lease when the atomic settings write fails", async () => {
    const { desktopSettings } = await import("../../../electron/main/desktop-settings");
    await fs.mkdir(path.join(native.dataPath, "settings.json"), { recursive: true });

    await expect(desktopSettings.saveSettings({ theme: "dark" })).rejects.toThrow();
    ownership = await acquireRuntimeLock(native.dataPath);
    expect(desktopSettings.loadSettings()).toEqual({});
  });

  it("refuses corrupt control metadata without replacing settings", async () => {
    const { desktopSettings } = await import("../../../electron/main/desktop-settings");
    store().saveSettings({ theme: "light" });
    await fs.writeFile(path.join(native.dataPath, HOST_CONTROL_FILENAME), "{}");

    await expect(desktopSettings.saveSettings({ theme: "dark" })).rejects.toMatchObject({ code: "INVALID_METADATA" });
    expect(desktopSettings.loadSettings()).toEqual({ theme: "light" });
  });
});
