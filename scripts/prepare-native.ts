#!/usr/bin/env bun
import { chmod, lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function isDirectory(directory: string): Promise<boolean> {
  try { return (await lstat(directory)).isDirectory(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** npm tarballs can lose the executable bit on node-pty's macOS helper. */
export async function repairNodePtyPermissions(applicationRoot: string): Promise<string[]> {
  const packageRoot = await realpath(join(applicationRoot, "node_modules", "node-pty"));
  if (process.platform === "win32") return [];
  const directories = [join(packageRoot, "build", "Release"), join(packageRoot, "build", "Debug")];
  const prebuilds = join(packageRoot, "prebuilds");
  if (await isDirectory(prebuilds)) {
    for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(prebuilds, entry.name));
    }
  }

  const repaired: string[] = [];
  for (const directory of directories) {
    if (!await isDirectory(directory)) continue;
    const helper = join(directory, "spawn-helper");
    let info;
    try { info = await lstat(helper); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // Do not follow unexpected helper symlinks or change unrelated package files.
    if (!info.isFile() || (info.mode & 0o111) === 0o111) continue;
    await chmod(helper, (info.mode & 0o777) | 0o111);
    repaired.push(helper);
  }
  return repaired;
}

interface NativePackContext {
  appOutDir: string;
  packager: { getResourcesDir(appOutDir: string): string };
}

/** Run after native rebuild/copy and before signing or archiving the desktop app. */
export async function afterPack(context: NativePackContext): Promise<void> {
  const resources = context.packager.getResourcesDir(context.appOutDir);
  await repairNodePtyPermissions(join(resources, "app.asar.unpacked"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repaired = await repairNodePtyPermissions(root);
  console.log(`Native helpers ready (${repaired.length} permissions repaired).`);
}
