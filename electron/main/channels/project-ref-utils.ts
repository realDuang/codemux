import type { EngineType } from "../../../src/types/unified";
import { getDefaultWorkspacePath } from "../services/default-workspace";
import { getDefaultEngineFromSettings } from "../services/logger";

export interface ChannelProjectRef {
  directory: string;
  engineType: EngineType;
  projectId: string;
}

function normalizeDir(directory: string): string {
  return directory.replaceAll("\\", "/");
}

export function resolveProjectRef<T extends ChannelProjectRef>(project: T): T {
  if (normalizeDir(project.directory) !== normalizeDir(getDefaultWorkspacePath())) {
    return project;
  }

  return {
    ...project,
    engineType: getDefaultEngineFromSettings(),
  };
}
