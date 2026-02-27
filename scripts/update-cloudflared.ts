#!/usr/bin/env bun
/**
 * Cloudflared binary update script
 * Download the latest cloudflared binary from Cloudflare official releases
 *
 * Usage: bun scripts/update-cloudflared.ts
 */

import { existsSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";

const isWindows = process.platform === "win32";
const RESOURCES_DIR = join(import.meta.dir, "..", "resources", "cloudflared");

interface Platform {
  name: string;
  arch: string;
  url: string;
  binaryName: string;
}

// Cloudflare official download links
// Reference: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
const ALL_PLATFORMS: Platform[] = [
  {
    name: "darwin",
    arch: "arm64",
    url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz",
    binaryName: "cloudflared",
  },
  {
    name: "darwin",
    arch: "x64",
    url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz",
    binaryName: "cloudflared",
  },
  {
    name: "win32",
    arch: "x64",
    url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
    binaryName: "cloudflared.exe",
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

async function downloadFile(url: string, destPath: string): Promise<void> {
  console.log(`  Downloading from: ${url}`);
  
  // Build headers with optional GitHub token for downloads from GitHub
  const headers: Record<string, string> = {
    "User-Agent": "opencode-remote-updater",
  };
  
  // Use GITHUB_TOKEN if available (helps with rate limits for GitHub downloads)
  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken && url.includes("github.com")) {
    headers["Authorization"] = `Bearer ${githubToken}`;
  }
  
  const response = await fetch(url, {
    headers,
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to download: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await Bun.write(destPath, arrayBuffer);
  console.log(`  Saved to: ${destPath}`);
}

/**
 * Cross-platform TGZ extraction
 * - Unix: Uses native tar command
 * - Windows: Uses PowerShell to extract (Windows tar has issues with drive letters)
 */
async function extractTgz(tgzPath: string, destDir: string, binaryName: string): Promise<void> {
  const fs = await import("fs/promises");

  if (isWindows) {
    // On Windows, use PowerShell to extract .tgz files
    // We decompress gzip first, then use tar with relative paths to avoid drive letter issues
    const psCommand = `
      $tgzPath = '${tgzPath.replace(/'/g, "''")}'
      $destDir = '${destDir.replace(/'/g, "''")}'
      $tempTarName = 'temp.tar'
      $tempTar = Join-Path $destDir $tempTarName
      
      # Decompress gzip to tar
      $gzStream = [System.IO.File]::OpenRead($tgzPath)
      $gzipStream = New-Object System.IO.Compression.GzipStream($gzStream, [System.IO.Compression.CompressionMode]::Decompress)
      $tarStream = [System.IO.File]::Create($tempTar)
      $gzipStream.CopyTo($tarStream)
      $tarStream.Close()
      $gzipStream.Close()
      $gzStream.Close()
      
      # Extract tar using relative path (avoids Windows tar drive letter bug)
      Push-Location $destDir
      tar -xf $tempTarName
      Pop-Location
      
      # Cleanup
      Remove-Item $tempTar -Force
    `;
    const proc = Bun.spawn(["powershell", "-NoProfile", "-Command", psCommand], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`PowerShell tgz extraction failed with exit code ${exitCode}`);
    }
  } else {
    // Unix: use native tar
    const proc = Bun.spawn(["tar", "-xzf", tgzPath, "-C", destDir], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`tar extraction failed with exit code ${exitCode}`);
    }
  }

  // Clean up tgz file
  await fs.unlink(tgzPath);
}

async function updateCloudflared(): Promise<void> {
  console.log("🔍 Downloading latest Cloudflared binaries...");

  try {
    const platformsToDownload = getPlatformsToDownload();
    for (const platform of platformsToDownload) {
      const dirPath = join(RESOURCES_DIR, `${platform.name}-${platform.arch}`);

      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
      }

      console.log(`\n📥 Downloading for ${platform.name}-${platform.arch}...`);

      const destPath = join(dirPath, platform.binaryName);

      if (platform.url.endsWith(".tgz")) {
        // macOS: Download tgz and extract
        const tgzPath = join(dirPath, "cloudflared.tgz");
        await downloadFile(platform.url, tgzPath);
        await extractTgz(tgzPath, dirPath, platform.binaryName);
      } else {
        // Windows: Download exe directly
        await downloadFile(platform.url, destPath);
      }

      // Set executable permission (Unix)
      if (platform.name !== "win32" && existsSync(destPath)) {
        chmodSync(destPath, 0o755);
        console.log("   Set executable permission");
      }
    }

    console.log("\n✅ Cloudflared binaries updated successfully!");
  } catch (error) {
    console.error("❌ Update failed:", error);
    process.exit(1);
  }
}

updateCloudflared();