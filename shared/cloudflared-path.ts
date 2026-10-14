import path from "path";

interface CloudflaredPathOptions {
  isPackaged: boolean;
  resourcesPath: string;
  platform: NodeJS.Platform;
  arch: string;
}

export function getCloudflaredPath(options: CloudflaredPathOptions): string {
  if (!options.isPackaged) return "cloudflared";

  const binaryName = options.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  return path.join(options.resourcesPath, "cloudflared", `${options.platform}-${options.arch}`, binaryName);
}
