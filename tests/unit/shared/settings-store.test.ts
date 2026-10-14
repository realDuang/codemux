import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsStore } from "../../../shared/settings-store";

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "codemux-settings-store-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("createSettingsStore", () => {
  describe("loadSettings", () => {
    it.each([
      ["object", { theme: "dark" }],
      ["array", ["stored"]],
      ["null", null],
      ["number", 0],
      ["boolean", false],
      ["string", ""],
    ])("returns a parsed %s without changing its value", (_name, value) => {
      const filePath = path.join(directory, "settings.json");
      fs.writeFileSync(filePath, JSON.stringify(value));

      expect(createSettingsStore({ getFilePath: () => filePath }).loadSettings()).toEqual(value);
    });

    it.each(["missing", "invalid", "unreadable"])("returns empty settings when the file is %s", (state) => {
      const filePath = path.join(directory, "settings.json");
      if (state === "invalid") fs.writeFileSync(filePath, "invalid json");
      if (state === "unreadable") {
        vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => { throw new Error("Read denied"); });
      }

      expect(createSettingsStore({ getFilePath: () => filePath }).loadSettings()).toEqual({});
    });
  });

  describe("saveSettings", () => {
    it("merges one object level while replacing nested objects, arrays, and scalar values", () => {
      const filePath = path.join(directory, "settings.json");
      fs.writeFileSync(filePath, JSON.stringify({
        untouched: "keep",
        engineModels: {
          alpha: { providerID: "old", modelID: "first" },
          beta: { modelID: "retained" },
        },
        order: [1, 2],
        cleared: { enabled: true },
        enabled: true,
        count: 10,
        label: "old",
        omitted: true,
        scalar: 4,
        arrayToObject: [1],
        objectToArray: { old: true },
      }));
      const store = createSettingsStore({ getFilePath: () => filePath });

      store.saveSettings({
        engineModels: { alpha: { modelID: "next" } },
        order: [3],
        cleared: null,
        enabled: false,
        count: 0,
        label: "",
        omitted: undefined,
        scalar: { enabled: true },
        arrayToObject: { enabled: true },
        objectToArray: [2],
      });

      const expected = {
        untouched: "keep",
        engineModels: { alpha: { modelID: "next" }, beta: { modelID: "retained" } },
        order: [3],
        cleared: null,
        enabled: false,
        count: 0,
        label: "",
        scalar: { enabled: true },
        arrayToObject: { enabled: true },
        objectToArray: [2],
      };
      expect(store.loadSettings()).toEqual(expected);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(JSON.stringify(expected, null, 2));
      expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
    });

    it("uses the current path and rereads settings instead of caching earlier values", () => {
      const firstPath = path.join(directory, "first.json");
      const secondPath = path.join(directory, "second.json");
      fs.writeFileSync(firstPath, '{"host":"first"}');
      fs.writeFileSync(secondPath, '{"host":"second"}');
      let selectedPath = firstPath;
      const getFilePath = vi.fn(() => selectedPath);
      const store = createSettingsStore({ getFilePath });
      expect(getFilePath).not.toHaveBeenCalled();
      expect(store.loadSettings()).toEqual({ host: "first" });

      selectedPath = secondPath;
      expect(store.loadSettings()).toEqual({ host: "second" });
      fs.writeFileSync(secondPath, '{"host":"updated externally","retained":true}');
      store.saveSettings({ theme: "dark" });

      expect(JSON.parse(fs.readFileSync(firstPath, "utf-8"))).toEqual({ host: "first" });
      expect(store.loadSettings()).toEqual({ host: "updated externally", retained: true, theme: "dark" });
    });

    it.each([true, false])("creates a missing parent only when createDirectory is %s", (createDirectory) => {
      const parent = path.join(directory, "missing", "nested");
      const store = createSettingsStore({
        getFilePath: () => path.join(parent, "settings.json"),
        createDirectory,
      });

      if (createDirectory) {
        store.saveSettings({ theme: "dark" });
        expect(store.loadSettings()).toEqual({ theme: "dark" });
        expect(fs.existsSync(parent)).toBe(true);
      } else {
        expect(() => store.saveSettings({ theme: "dark" })).toThrow(/ENOENT/);
        expect(fs.existsSync(parent)).toBe(false);
      }
    });

    it("saves a fresh patch after existing settings cannot be read", () => {
      const filePath = path.join(directory, "settings.json");
      fs.writeFileSync(filePath, '{"old":true}');
      const store = createSettingsStore({ getFilePath: () => filePath });
      vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => { throw new Error("Read denied"); });

      store.saveSettings({ theme: "dark" });

      expect(store.loadSettings()).toEqual({ theme: "dark" });
    });

    it.each(["writeFileSync", "renameSync"] as const)("keeps the previous file intact when %s fails", (operation) => {
      const filePath = path.join(directory, "settings.json");
      const previous = '{"theme":"light"}';
      fs.writeFileSync(filePath, previous);
      const store = createSettingsStore({ getFilePath: () => filePath });
      const failure = new Error("Storage unavailable");
      vi.spyOn(fs, operation).mockImplementationOnce(() => { throw failure; });

      expect(() => store.saveSettings({ theme: "dark" })).toThrow(failure);

      expect(fs.readFileSync(filePath, "utf-8")).toBe(previous);
      if (operation === "renameSync") {
        expect(fs.readFileSync(`${filePath}.tmp`, "utf-8")).toBe(JSON.stringify({ theme: "dark" }, null, 2));
      }
    });

    it("propagates directory creation failures without creating a settings file", () => {
      const filePath = path.join(directory, "missing", "settings.json");
      const store = createSettingsStore({ getFilePath: () => filePath, createDirectory: true });
      const failure = new Error("Directory creation denied");
      vi.spyOn(fs, "mkdirSync").mockImplementationOnce(() => { throw failure; });

      expect(() => store.saveSettings({ theme: "dark" })).toThrow(failure);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("propagates serialization failures without replacing saved settings", () => {
      const filePath = path.join(directory, "settings.json");
      const previous = '{"theme":"light"}';
      fs.writeFileSync(filePath, previous);
      const store = createSettingsStore({ getFilePath: () => filePath });
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      expect(() => store.saveSettings({ circular })).toThrow(TypeError);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(previous);
    });
  });
});

describe("standalone settings store", () => {
  it("keeps reads and writes in the directory captured during import", async () => {
    const filePath = path.join(directory, ".settings.json");
    const laterDirectory = path.join(directory, "later");
    fs.mkdirSync(laterDirectory);
    fs.writeFileSync(filePath, '{"host":"original"}');
    vi.resetModules();
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    const store = await import("../../../scripts/settings-store");
    cwd.mockReturnValue(laterDirectory);

    expect(store.loadSettings()).toEqual({ host: "original" });
    store.saveSettings({ theme: "dark" });

    expect(JSON.parse(fs.readFileSync(filePath, "utf-8"))).toEqual({ host: "original", theme: "dark" });
    expect(fs.existsSync(path.join(laterDirectory, ".settings.json"))).toBe(false);
  });

  it("does not create a missing standalone settings directory", async () => {
    const missingDirectory = path.join(directory, "missing");
    vi.resetModules();
    vi.spyOn(process, "cwd").mockReturnValue(missingDirectory);
    const store = await import("../../../scripts/settings-store");

    expect(store.loadSettings()).toEqual({});
    expect(() => store.saveSettings({ theme: "dark" })).toThrow(/ENOENT/);
    expect(fs.existsSync(missingDirectory)).toBe(false);
  });
});
