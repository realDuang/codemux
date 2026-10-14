import path from "node:path";

export interface RuntimePathConfig {
  userDataPath: string;
  logsPath: string;
  /** Legacy development can keep device identity outside the user data directory. */
  devicesPath?: string;
}

/** Read the configuration on use so host path initialization can happen after import. */
export function createRuntimePaths(config: RuntimePathConfig) {
  const getUserDataPath = () => config.userDataPath;
  const getLogsPath = () => config.logsPath;
  const getSettingsPath = () => path.join(getUserDataPath(), "settings.json");
  const getDevicesPath = () => config.devicesPath ?? path.join(getUserDataPath(), "devices.json");
  const getConversationsPath = () => path.join(getUserDataPath(), "conversations");
  const getWorktreesPath = () => path.join(getUserDataPath(), "worktrees");
  const getWorktreeIndexPath = (projectId: string) => path.join(getWorktreesPath(), projectId, "index.json");
  const getScheduledTasksPath = () => path.join(getUserDataPath(), "scheduled-tasks.json");
  const getOrchestrationsPath = () => path.join(getUserDataPath(), "orchestrations.json");
  const getDefaultWorkspacePath = () => path.join(getUserDataPath(), "workspace");
  const getCloudflaredConfigPath = () => path.join(getUserDataPath(), "cloudflared-config.yml");
  const getChannelsPath = () => path.join(getUserDataPath(), "channels");
  const getChannelConfigPath = (channelType: string) => path.join(getChannelsPath(), `${channelType}.json`);
  const getChannelBindingsPath = (channelType: string) => path.join(getChannelsPath(), `${channelType}-bindings.json`);

  return {
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
  };
}

export interface RuntimeLogPathConfig {
  useLibraryDefaultLogPath: boolean;
  logsPath: string;
}

export function resolveRuntimeLogPath(
  config: RuntimeLogPathConfig,
  libraryDefaultDir: string,
  fileName = "main.log",
): string {
  const directory = config.useLibraryDefaultLogPath ? libraryDefaultDir : config.logsPath;
  return path.join(directory, fileName);
}
