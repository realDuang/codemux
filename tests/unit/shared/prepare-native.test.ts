import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { afterPack, repairNodePtyPermissions } from "../../../scripts/prepare-native";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(prefix = "codemux-native-permissions-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function file(root: string, directory: string, mode = 0o644) {
  const parent = join(root, "node_modules/node-pty", directory);
  await mkdir(parent, { recursive: true });
  const helper = join(parent, "spawn-helper");
  await writeFile(helper, "native-helper-fixture");
  await chmod(helper, mode);
  return helper;
}

describe("repairNodePtyPermissions", () => {
  it.skipIf(process.platform === "win32")("repairs prebuilt and rebuilt helpers once without changing their contents", async () => {
    const root = await fixture();
    const files = await Promise.all([
      file(root, "prebuilds/darwin-arm64"), file(root, "prebuilds/darwin-x64", 0o744),
      file(root, "build/Release"), file(root, "build/Debug", 0o755),
    ]);
    const expected = await Promise.all(files.slice(0, 3).map(path => realpath(path)));
    expect(await repairNodePtyPermissions(root)).toEqual(expect.arrayContaining(expected));
    for (const helper of files) {
      expect((await lstat(helper)).mode & 0o777).toBe(0o755);
      expect(await readFile(helper, "utf8")).toBe("native-helper-fixture");
    }
    expect(await repairNodePtyPermissions(root)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("does not follow helper or build directory symlinks outside the package", async () => {
    const root = await fixture();
    const outside = await fixture("codemux-native-outside-");
    const sentinel = join(outside, "spawn-helper");
    await writeFile(sentinel, "leave-alone", { mode: 0o644 });
    const packageRoot = join(root, "node_modules/node-pty");
    await mkdir(join(packageRoot, "prebuilds/darwin-arm64"), { recursive: true });
    await mkdir(join(packageRoot, "build"));
    await symlink(sentinel, join(packageRoot, "prebuilds/darwin-arm64/spawn-helper"));
    await symlink(outside, join(packageRoot, "build/Release"));
    await symlink(outside, join(packageRoot, "prebuilds/darwin-x64"));
    expect(await repairNodePtyPermissions(root)).toEqual([]);
    expect((await lstat(sentinel)).mode & 0o777).toBe(0o644);
  });

  it("allows native layouts without a helper but rejects a missing node-pty package", async () => {
    const root = await fixture();
    await expect(repairNodePtyPermissions(root)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(root, "node_modules/node-pty/build/Release"), { recursive: true });
    await writeFile(join(root, "node_modules/node-pty/build/Release/pty.node"), "native");
    expect(await repairNodePtyPermissions(root)).toEqual([]);
  });
});

describe("afterPack", () => {
  it("prepares the actual unpacked resource directory and fails if native extraction is missing", async () => {
    const root = await fixture();
    const resources = join(root, "fixture.app/Contents/Resources");
    const context = { appOutDir: root, packager: { getResourcesDir: () => resources } };
    await expect(afterPack(context)).rejects.toMatchObject({ code: "ENOENT" });
    await file(join(resources, "app.asar.unpacked"), "prebuilds/darwin-arm64");
    await expect(afterPack(context)).resolves.toBeUndefined();
  });
});
