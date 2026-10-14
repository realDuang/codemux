import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNativePackageTarget, createServerManifest, packServer, type PackageCommand } from "../../../scripts/pack-server";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const sourceManifest = {
  name: "codemux", version: "1.7.1", type: "module",
  scripts: { postinstall: "bun scripts/prepare-native.ts", dev: "electron-vite dev" },
  dependencies: { "node-pty": "^1.1.0", "@github/copilot-sdk": "1.0.0", "electron-updater": "^6.8.3" },
  optionalDependencies: { "fixture-platform-package": "1.0.0" },
  devDependencies: { electron: "^40.6.1", vite: "^6.4.2" },
  overrides: { "node-gyp": "^12.1.0" },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codemux-server-package-"));
  roots.push(root);
  for (const [name, contents] of Object.entries({
    "package.json": JSON.stringify(sourceManifest), "bun.lock": "exact-frozen-lock-fixture",
    "scripts/prepare-native.ts": "export {};", "src/secret-fixture.ts": "not-a-package-input",
    "out/server/index.mjs": "export const server = 1;", "out/server/cli.mjs": "export const cli = 1;",
    "out/server/lazy.mjs": "export const lazy = 1;", "out/web/index.html": "web-shell",
    "out/web/desktop.html": "desktop-shell", "out/web/assets/chunk.js": "web-chunk",
  })) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  const commands: PackageCommand[] = [];
  const runCommand = vi.fn(async (command: PackageCommand): Promise<string> => {
    commands.push(command);
    if (command.args[0] === "-p") {
      return JSON.stringify({ node: "24.21.0", platform: process.platform, arch: process.arch });
    }
    if (command.command === "bun") {
      expect(command.args).toEqual(["install", "--production", "--frozen-lockfile", "--backend=copyfile"]);
      expect(JSON.parse(await readFile(join(command.cwd, "package.json"), "utf8"))).toEqual(sourceManifest);
      expect(await readFile(join(command.cwd, "bun.lock"), "utf8")).toBe("exact-frozen-lock-fixture");
      expect(await readFile(join(command.cwd, "scripts/prepare-native.ts"), "utf8")).toBe("export {};");
      await mkdir(join(command.cwd, "node_modules/node-pty/build/Release"), { recursive: true });
      await writeFile(join(command.cwd, "node_modules/node-pty/build/Release/pty.node"), "native-fixture");
    }
    return "";
  });
  return { root, commands, runCommand, options: { repositoryRoot: root, runCommand } };
}

describe("assertNativePackageTarget", () => {
  it("accepts the current supported platform and rejects foreign or unsupported targets", () => {
    expect(() => assertNativePackageTarget(process.platform, process.arch)).not.toThrow();
    expect(() => assertNativePackageTarget(process.platform === "linux" ? "darwin" : "linux", process.arch)).toThrow("target OS");
    expect(() => assertNativePackageTarget(process.platform, process.arch === "x64" ? "arm64" : "x64")).toThrow("target OS");
    expect(() => assertNativePackageTarget("freebsd", "x64")).toThrow("Unsupported");
  });
});

describe("createServerManifest", () => {
  it("keeps every production and optional dependency while exposing only Node runtime commands", () => {
    const manifest = createServerManifest(sourceManifest);
    expect(manifest.dependencies).toEqual(sourceManifest.dependencies);
    expect(manifest.optionalDependencies).toEqual(sourceManifest.optionalDependencies);
    expect(manifest).toMatchObject({ name: "codemux-server", version: sourceManifest.version, engines: { node: ">=24" } });
    expect(manifest.scripts).toEqual({ start: "node out/server/index.mjs", ctl: "node out/server/cli.mjs" });
    expect(manifest).not.toHaveProperty("devDependencies");
    expect(manifest).not.toHaveProperty("overrides");
  });
});

describe("packServer", () => {
  it("installs the frozen manifest before preparing a self-contained runtime directory", async () => {
    const { root, commands, options } = await fixture();
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    vi.stubEnv("npm_config_runtime", "electron");
    vi.stubEnv("npm_config_target", "40.6.1");
    vi.stubEnv("npm_config_arch", "foreign");
    vi.stubEnv("npm_config_disturl", "electron-headers");
    const destination = await packServer(options);
    expect(destination).toBe(join(root, `release/codemux-server-1.7.1-${process.platform}-${process.arch}`));
    expect(await readdir(join(root, "release"))).toEqual([`codemux-server-1.7.1-${process.platform}-${process.arch}`]);
    expect(await readFile(join(destination, "out/web/assets/chunk.js"), "utf8")).toBe("web-chunk");
    expect(await readFile(join(destination, "out/server/lazy.mjs"), "utf8")).toBe("export const lazy = 1;");
    expect(await readFile(join(destination, "README.md"), "utf8")).toContain("Source bun.lock SHA-256:");
    expect(JSON.parse(await readFile(join(destination, "package.json"), "utf8"))).toEqual(createServerManifest(sourceManifest));
    for (const excluded of ["scripts", "bun.lock", "src", "out/main", "node_modules/electron"]) {
      await expect(lstat(join(destination, excluded))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(commands).toHaveLength(3);
    expect(commands[2].args[1]).toContain("load('node-pty')");
    expect(commands[2].args[1]).toContain("load('@parcel/watcher')");
    for (const command of commands) {
      expect(command.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
      expect(command.env).not.toHaveProperty("npm_config_target");
      expect(command.env).not.toHaveProperty("npm_config_arch");
    }
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual(sourceManifest);
    expect(await readFile(join(root, "bun.lock"), "utf8")).toBe("exact-frozen-lock-fixture");
  });

  it.each(["install", "native validation"])("cleans only its staging directory when %s fails", async stage => {
    const { root, runCommand, options } = await fixture();
    await mkdir(join(root, "release/retained"), { recursive: true });
    const original = runCommand.getMockImplementation()!;
    runCommand.mockImplementation(async command => {
      if ((stage === "install" && command.command === "bun") || (stage === "native validation" && command.args[0] === "-e")) {
        throw new Error("fixture failure");
      }
      return original(command);
    });
    await expect(packServer(options)).rejects.toThrow("fixture failure");
    expect(await readdir(join(root, "release"))).toEqual(["retained"]);
  });

  it("rejects an existing destination without invoking installation or touching its contents", async () => {
    const { root, runCommand, options } = await fixture();
    const destination = join(root, `release/codemux-server-1.7.1-${process.platform}-${process.arch}`);
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "retained"), "old-package");
    await expect(packServer(options)).rejects.toThrow("already exists");
    expect(runCommand).not.toHaveBeenCalled();
    expect(await readFile(join(destination, "retained"), "utf8")).toBe("old-package");
  });

  it("removes completed partial copies when a later artifact copy fails", async () => {
    const { root, runCommand, options } = await fixture();
    await mkdir(join(root, "release/retained"), { recursive: true });
    const original = runCommand.getMockImplementation()!;
    runCommand.mockImplementation(async command => {
      const result = await original(command);
      if (command.args[0] === "-e") await rm(join(root, "out/web"), { recursive: true });
      return result;
    });
    await expect(packServer(options)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(root, "release"))).toEqual(["retained"]);
  });

  it("rejects missing build output before installing and incompatible Node before staging", async () => {
    const { root, runCommand, options } = await fixture();
    await rm(join(root, "out/server/cli.mjs"));
    await expect(packServer(options)).rejects.toThrow("build:server-app");
    expect(runCommand).not.toHaveBeenCalled();
    await writeFile(join(root, "out/server/cli.mjs"), "export {};");
    runCommand.mockResolvedValue(JSON.stringify({ node: "22.0.0", platform: process.platform, arch: process.arch }));
    await expect(packServer(options)).rejects.toThrow("Node 24");
    await expect(lstat(join(root, "release"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a production install containing Electron and removes the incomplete package", async () => {
    const { root, runCommand, options } = await fixture();
    const original = runCommand.getMockImplementation()!;
    runCommand.mockImplementation(async command => {
      const result = await original(command);
      if (command.command === "bun") await mkdir(join(command.cwd, "node_modules/electron"));
      return result;
    });
    await expect(packServer(options)).rejects.toThrow("unexpectedly contains Electron");
    expect(await readdir(join(root, "release"))).toEqual([]);
  });
});
