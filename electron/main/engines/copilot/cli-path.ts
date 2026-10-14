import { dirname, join, sep } from "path";

/** Native executables must live outside Electron's asar archive. */
export function unpackCopilotCliPath(resolvedPath: string): string {
  if (resolvedPath.includes(`app.asar${sep}`) && !resolvedPath.includes("app.asar.unpacked")) {
    return resolvedPath.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  }
  return resolvedPath;
}

export function getCopilotCliCandidates(appPath: string, platform: NodeJS.Platform, arch: string): string[] {
  const pkgName = `@github/copilot-${platform}-${arch}`;
  const binaryName = platform === "win32" ? "copilot.exe" : "copilot";

  return [
    join(dirname(appPath), "app.asar.unpacked", "node_modules", "@github", "copilot", "node_modules", pkgName, binaryName),
    join(dirname(appPath), "app.asar.unpacked", "node_modules", pkgName, binaryName),
    join(appPath, "node_modules", pkgName, binaryName),
    join(appPath, "node_modules", "@github", "copilot", "node_modules", pkgName, binaryName),
  ];
}
