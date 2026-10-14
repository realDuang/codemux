import { runtimeHost } from "#runtime-host";
import { createRuntimePaths } from "../../../shared/runtime-paths";

export function isDevIsolatedMode(): boolean {
  return runtimeHost.isDevIsolated;
}

export function usesSharedDevDeviceStorePath(): boolean {
  return runtimeHost.usesSharedDevDeviceStore;
}

export const {
  getUserDataPath,
  getLogsPath,
  getSettingsPath,
  getDevicesPath,
  getConversationsPath,
  getWorktreesPath,
  getWorktreeIndexPath,
  getScheduledTasksPath,
  getOrchestrationsPath,
  getDefaultWorkspacePath,
  getCloudflaredConfigPath,
  getChannelsPath,
  getChannelConfigPath,
  getChannelBindingsPath,
} = createRuntimePaths(runtimeHost.paths);
