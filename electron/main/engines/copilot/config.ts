import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { app } from "electron";
import type { AgentMode } from "../../../../src/types/unified";

// ============================================================================
// Default Agent Modes
// ============================================================================

export const DEFAULT_MODES: AgentMode[] = [
  { id: "agent", label: "Agent", description: "Interactive coding agent" },
  { id: "plan", label: "Plan", description: "Plan before executing" },
  { id: "autopilot", label: "Autopilot", description: "Fully autonomous mode" },
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
  try {
    const resolved = fileURLToPath((import.meta as any).resolve(pkgName));
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
