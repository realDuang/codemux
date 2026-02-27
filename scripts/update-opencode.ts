#!/usr/bin/env bun
/**
 * OpenCode binary update script
 * Download the latest opencode binary from GitHub Release
 *
 * Usage: bun scripts/update-opencode.ts
 */

import { existsSync, mkdirSync, chmodSync, unlinkSync } from "fs";
import { join } from "path";

const isWindows = process.platform === "win32";

const GITHUB_REPO = "anomalyco/opencode";
const RESOURCES_DIR = join(import.meta.dir, "..", "resources", "bin");

/**
 * Cross-platform ZIP extraction
 * Uses .NET ZipFile on Windows (no module dependency), unzip on Unix
 */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  if (isWindows) {
    // Use .NET System.IO.Compression.ZipFile directly (built-in, no module required)
    // Remove existing files first to simulate overwrite behavior
    const psCommand = `
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')
      foreach ($entry in $zip.Entries) {
        $destPath = Join-Path '${destDir.replace(/'/g, "''")}' $entry.FullName
        $destFolder = Split-Path $destPath -Parent
        if (!(Test-Path $destFolder)) { New-Item -ItemType Directory -Path $destFolder -Force | Out-Null }
        if ($entry.FullName -notmatch '/$') {
          [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destPath, $true)
        }
      }
      $zip.Dispose()
    `;
    const proc = Bun.spawn(
      ["powershell", "-NoProfile", "-Command", psCommand],
      { stdout: "inherit", stderr: "inherit" }
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`PowerShell ZIP extraction failed with exit code ${exitCode}`);
    }
  } else {
    // Use unzip on Unix (macOS, Linux)
    const proc = Bun.spawn(["unzip", "-o", zipPath, "-d", destDir], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`unzip failed with exit code ${exitCode}`);
    }
  }
}

interface Platform {
  name: string;
  arch: string;
  assetName: string;
  binaryName: string;
}

const ALL_PLATFORMS: Platform[] = [
  {
    name: "darwin",
    arch: "arm64",
    assetName: "opencode-darwin-arm64.zip",
    binaryName: "opencode",
  },
  {
    name: "darwin",
    arch: "x64",
    assetName: "opencode-darwin-x64.zip",
    binaryName: "opencode",
  },
  {
    name: "win32",
    arch: "x64",
    assetName: "opencode-windows-x64.zip",
    binaryName: "opencode.exe",
  },
];

/**
 * Get the platform to download based on current system or TARGET_ARCH env var.
 * TARGET_ARCH can be set to override the architecture (useful for cross-compilation in CI).
 */
function getPlatformsToDownload(): Platform[] {
  const currentPlatform = process.platform; // "darwin" or "win32"
  const systemArch = process.arch; // "arm64" or "x64"
  const envTargetArch = process.env.TARGET_ARCH;
  
  // Debug logging for CI troubleshooting
  console.log(`🔍 System info: platform=${currentPlatform}, arch=${systemArch}`);
  console.log(`🔍 TARGET_ARCH env: ${envTargetArch || "(not set)"}`);
  
  // Allow TARGET_ARCH env var to override (for CI cross-compilation)
  const targetArch = envTargetArch || (systemArch === "arm64" ? "arm64" : "x64");
  
  const filtered = ALL_PLATFORMS.filter(
    (p) => p.name === currentPlatform && p.arch === targetArch
  );
  
  if (filtered.length === 0) {
    console.error(`❌ No matching platform for ${currentPlatform}-${targetArch}`);
    console.error(`   Available platforms: ${ALL_PLATFORMS.map(p => `${p.name}-${p.arch}`).join(", ")}`);
    process.exit(1);
  }
  
  console.log(`🔧 Downloading for platform: ${currentPlatform}-${targetArch}`);
  return filtered;
}

async function getLatestRelease(): Promise<{ tag_name: string; assets: any[] }> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
  
  // Build headers with optional GitHub token for higher rate limits
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "opencode-remote-updater",
  };
  
  // Use GITHUB_TOKEN if available (provides 5000 req/hr instead of 60)
  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken) {
    headers["Authorization"] = `Bearer ${githubToken}`;
    console.log("🔑 Using GitHub token for API authentication");
  }
  
  const response = await fetch(url, {
    redirect: "follow",
    headers,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch latest release: ${response.statusText}`);
  }

  return response.json();
}

async function downloadAndExtract(url: string, destDir: string, binaryName: string): Promise<void> {
  const zipPath = join(destDir, "temp.zip");

  console.log(`  Downloading from: ${url}`);
  const response = await fetch(url, {
    headers: { "User-Agent": "opencode-remote-updater" },
  });

  if (!response.ok) {
    throw new Error(`Failed to download: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await Bun.write(zipPath, arrayBuffer);

  console.log(`  Extracting...`);
  // Cross-platform extraction
  await extractZip(zipPath, destDir);

  // Clean up zip file
  unlinkSync(zipPath);

  // Set executable permission (Unix)
  const binaryPath = join(destDir, binaryName);
  if (existsSync(binaryPath) && binaryName !== "opencode.exe") {
    chmodSync(binaryPath, 0o755);
    console.log(`  Set executable permission`);
  }

  console.log(`  Saved to: ${binaryPath}`);
}

async function updateOpencode(): Promise<void> {
  console.log("🔍 Fetching latest OpenCode release...");

  try {
    const release = await getLatestRelease();
    console.log(`📦 Latest version: ${release.tag_name}`);
    console.log(`📁 Found ${release.assets.length} assets`);

    const platformsToDownload = getPlatformsToDownload();
    for (const platform of platformsToDownload) {
      const dirPath = join(RESOURCES_DIR, `${platform.name}-${platform.arch}`);

      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
      }

      const asset = release.assets.find((a: any) => a.name === platform.assetName);

      if (!asset) {
        console.log(`⚠️  No asset found for ${platform.name}-${platform.arch} (looking for ${platform.assetName})`);
        continue;
      }

      console.log(`\n📥 Downloading for ${platform.name}-${platform.arch}...`);
      console.log(`   Asset: ${asset.name}`);

      await downloadAndExtract(asset.browser_download_url, dirPath, platform.binaryName);
    }

    console.log("\n✅ OpenCode binaries updated successfully!");
  } catch (error) {
    console.error("❌ Update failed:", error);
    process.exit(1);
  }
}

updateOpencode();
