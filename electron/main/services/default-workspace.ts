// ============================================================================
// Default Workspace — Provides a persistent fallback directory for new users
// so sessions can be created without first setting up a project.
// ============================================================================

import fs from "node:fs";
import { getDefaultWorkspacePath } from "./app-paths";

export { getDefaultWorkspacePath };

/** Ensures the default workspace directory exists. Call at app startup. */
export function ensureDefaultWorkspace(): string {
  const dir = getDefaultWorkspacePath();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
