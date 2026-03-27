import { existsSync, readFileSync } from "fs";
import { join, dirname, sep } from "path";
import { fileURLToPath } from "url";
import { app } from "electron";
import type { AgentMode } from "../../../../src/types/unified";

// ============================================================================
// Default Agent Modes
// ============================================================================

export const DEFAULT_MODES: AgentMode[] = [
  { id: "autopilot", label: "Autopilot", description: "Fully autonomous mode" },
  { id: "interactive", label: "Interactive", description: "Interactive coding agent" },
  { id: "plan", label: "Plan", description: "Plan before executing" },
];

// ============================================================================
// Config Helpers
// ============================================================================

/**
 * Read the current model from ~/.copilot/config.json.
 * Falls back to undefined if the file doesn't exist or is unreadable.
 */
export function readConfigModel(): string | undefined {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const configPath = join(home, ".copilot", "config.json");
    if (!existsSync(configPath)) return undefined;
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    return config?.model || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the platform-native Copilot CLI binary path.
 */
export function resolvePlatformCli(): string | undefined {
  const pkgName = `@github/copilot-${process.platform}-${process.arch}`;
  const binaryName = process.platform === "win32" ? "copilot.exe" : "copilot";

  // Strategy 1: import.meta.resolve
  // In packaged builds, import.meta.resolve returns paths inside app.asar.
  // Electron's patched fs.existsSync sees those files, but the OS cannot
  // execute a binary from inside an asar archive.  Convert the path to the
  // unpacked location (electron-builder extracts copilot-* via asarUnpack).
  try {
    let resolved = fileURLToPath((import.meta as any).resolve(pkgName));
    if (resolved.includes(`app.asar${sep}`) && !resolved.includes("app.asar.unpacked")) {
      resolved = resolved.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
    }
    if (existsSync(resolved)) return resolved;
  } catch {
    // Not resolvable
  }

  // Strategy 2: Scan known filesystem locations
  const appPath = app.getAppPath();
  const candidates = [
    join(dirname(appPath), "app.asar.unpacked", "node_modules", "@github", "copilot", "node_modules", pkgName, binaryName),
    join(dirname(appPath), "app.asar.unpacked", "node_modules", pkgName, binaryName),
    join(appPath, "node_modules", pkgName, binaryName),
    join(appPath, "node_modules", "@github", "copilot", "node_modules", pkgName, binaryName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}
