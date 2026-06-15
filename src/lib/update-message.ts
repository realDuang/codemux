import { formatMessage } from "./message-format";

export function hasUpdateVersion(version?: string): version is string {
  return Boolean(version?.trim());
}

export function formatUpdateAvailableMessage(
  template: string,
  version: string,
): string {
  return formatMessage(template, { version: version.trim() });
}
