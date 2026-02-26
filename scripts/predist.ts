#!/usr/bin/env bun
/**
 * Pre-distribution check script
 * Ensures all required resources are present before packaging with electron-builder.
 *
 * Usage: bun scripts/predist.ts
 */

import { existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const RESOURCES_DIR = join(ROOT, "resources", "cloudflared");

const platform = process.platform; // "darwin" or "win32"
const systemArch = process.arch; // "arm64" or "x64"
const targetArch = process.env.TARGET_ARCH || (systemArch === "arm64" ? "arm64" : "x64");

const expectedDir = join(RESOURCES_DIR, `${platform}-${targetArch}`);
const binaryName = platform === "win32" ? "cloudflared.exe" : "cloudflared";
const expectedBinary = join(expectedDir, binaryName);

async function main() {
  console.log("🔍 Pre-dist check: verifying required resources...\n");

  // Check cloudflared binary
  if (existsSync(expectedBinary)) {
    console.log(`✅ Cloudflared binary found: ${expectedBinary}`);
  } else {
    console.log(`⚠️  Cloudflared binary not found at: ${expectedBinary}`);
    console.log("   Downloading automatically...\n");

    const proc = Bun.spawn(["bun", join(ROOT, "scripts", "update-cloudflared.ts")], {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env },
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error("\n❌ Failed to download cloudflared binary. Aborting dist build.");
      process.exit(1);
    }

    // Verify again after download
    if (!existsSync(expectedBinary)) {
      console.error(`\n❌ Cloudflared binary still not found after download: ${expectedBinary}`);
      console.error("   Please run manually: bun run update:cloudflared");
      process.exit(1);
    }
    console.log(`\n✅ Cloudflared binary downloaded successfully.`);
  }

  console.log("\n✅ All pre-dist checks passed. Proceeding with build...\n");
}

main();
