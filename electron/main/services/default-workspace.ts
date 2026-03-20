// ============================================================================
// Default Workspace — Provides a persistent fallback directory for new users
// so sessions can be created without first setting up a project.
// ============================================================================

import { app } from "electron";
import path from "node:path";
import fs from "node:fs";

/** Returns the default workspace directory path (inside Electron userData) */
export function getDefaultWorkspacePath(): string {
  return path.join(app.getPath("userData"), "workspace");
}

/** Ensures the default workspace directory exists. Call at app startup. */
export function ensureDefaultWorkspace(): string {
  const dir = getDefaultWorkspacePath();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
