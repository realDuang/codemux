import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { runtimeHost } from "#runtime-host";
import type { AgentMode } from "../../../../src/types/unified";
import { getCopilotCliCandidates, unpackCopilotCliPath } from "./cli-path";

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

  // Strategy 1: import.meta.resolve
  // In packaged builds, import.meta.resolve returns paths inside app.asar.
  // Electron's patched fs.existsSync sees those files, but the OS cannot
  // execute a binary from inside an asar archive.  Convert the path to the
  // unpacked location (electron-builder extracts copilot-* via asarUnpack).
  try {
    const resolved = unpackCopilotCliPath(fileURLToPath((import.meta as any).resolve(pkgName)));
    if (existsSync(resolved)) return resolved;
  } catch {
    // Not resolvable
  }

  // Strategy 2: Scan known filesystem locations
  const candidates = getCopilotCliCandidates(runtimeHost.appPath, process.platform, process.arch);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}
