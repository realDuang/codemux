import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export const DEV_ISOLATED_ENV = "CODEMUX_DEV_ISOLATED";
export const DEV_ISOLATED_DIR = ".codemux-dev";
export const INSTANCE_ENV = "CODEMUX_INSTANCE";

export function isDevIsolatedMode(): boolean {
  return !app.isPackaged && process.env[DEV_ISOLATED_ENV] === "1";
}

function instanceName(): string {
  const raw = process.env[INSTANCE_ENV];
  if (!raw) return "default";
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "default";
}

export function configureDevIsolatedAppPaths(cwd = process.cwd()): void {
  if (!isDevIsolatedMode()) return;

  const root = path.join(cwd, DEV_ISOLATED_DIR, instanceName());
  const userData = path.join(root, "userData");
  const sessionData = path.join(root, "sessionData");
  const logs = path.join(root, "logs");

  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(sessionData, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });

  app.setPath("userData", userData);
  app.setPath("sessionData", sessionData);
  app.setPath("logs", logs);
}

export function getUserDataPath(): string {
  return app.getPath("userData");
}

export function getLogsPath(): string {
  return app.getPath("logs");
}

export function getSettingsPath(): string {
  return path.join(getUserDataPath(), "settings.json");
}

export function usesSharedDevDeviceStorePath(): boolean {
  return !app.isPackaged && !isDevIsolatedMode();
}

export function getDevicesPath(): string {
  if (usesSharedDevDeviceStorePath()) {
    return path.join(process.cwd(), ".devices.json");
  }
  return path.join(getUserDataPath(), "devices.json");
}

export function getConversationsPath(): string {
  return path.join(getUserDataPath(), "conversations");
}

export function getWorktreesPath(): string {
  return path.join(getUserDataPath(), "worktrees");
}

export function getWorktreeIndexPath(projectId: string): string {
  return path.join(getWorktreesPath(), projectId, "index.json");
}

export function getScheduledTasksPath(): string {
  return path.join(getUserDataPath(), "scheduled-tasks.json");
}

export function getOrchestrationsPath(): string {
  return path.join(getUserDataPath(), "orchestrations.json");
}

export function getDefaultWorkspacePath(): string {
  return path.join(getUserDataPath(), "workspace");
}

export function getCloudflaredConfigPath(): string {
  return path.join(getUserDataPath(), "cloudflared-config.yml");
}

export function getChannelsPath(): string {
  return path.join(getUserDataPath(), "channels");
}

export function getChannelConfigPath(channelType: string): string {
  return path.join(getChannelsPath(), `${channelType}.json`);
}

export function getChannelBindingsPath(channelType: string): string {
  return path.join(getChannelsPath(), `${channelType}-bindings.json`);
}
