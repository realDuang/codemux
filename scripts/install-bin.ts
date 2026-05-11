#!/usr/bin/env bun
/**
 * Install a `codemux` symlink into the local `node_modules/.bin` directory so
 * that `bun codemux …` and tooling that resolves bins through node_modules
 * (npm scripts, lefthook, etc.) can find the unified CLI during development.
 *
 * End users who install codemux as a dependency get this automatically via the
 * `bin` field in package.json; this hook only fixes the local-development
 * case where the package is its own consumer.
 */

import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const binDir = path.join(projectRoot, "node_modules", ".bin");
const target = path.join(projectRoot, "scripts", "codemux.ts");
const link = path.join(binDir, "codemux");

if (!fs.existsSync(target)) {
  console.warn(`[codemux] Skipping bin install: source ${target} not found`);
  process.exit(0);
}

fs.mkdirSync(binDir, { recursive: true });

try {
  const stat = fs.lstatSync(link);
  if (stat.isSymbolicLink() || stat.isFile()) fs.unlinkSync(link);
} catch {
  // doesn't exist yet
}

const relTarget = path.relative(binDir, target);

if (process.platform === "win32") {
  // Windows shims: write `.cmd`, `.ps1`, and a node-style wrapper, mirroring
  // what npm itself does for `bin` entries.
  const cmdShim = `@echo off\r\nbun "%~dp0\\${relTarget.replace(/\//g, "\\")}" %*\r\n`;
  fs.writeFileSync(`${link}.cmd`, cmdShim);
  fs.writeFileSync(`${link}.ps1`, `bun "$PSScriptRoot/${relTarget}" $args\r\n`);
  fs.writeFileSync(link, `#!/usr/bin/env bash\nexec bun "$(dirname "$0")/${relTarget}" "$@"\n`);
  fs.chmodSync(link, 0o755);
} else {
  fs.symlinkSync(relTarget, link);
}

console.log(`[codemux] Linked ${link} -> ${relTarget}`);
