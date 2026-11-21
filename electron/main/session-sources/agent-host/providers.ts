import type { EngineType } from "../../../../src/types/unified";

// Exact native harness IDs, not model vendors or extension IDs. Unknown harnesses
// remain visible in source diagnostics but never acquire another engine's identity.
const providers = new Map<string, EngineType>([
  ["copilotcli", "copilot"],
  ["claude", "claude"],
  ["codex", "codex"],
]);

export function providerEngine(provider: string): EngineType | undefined {
  return providers.get(provider);
}

export const supportedEngines = [...providers.values()];
export const agentHostCatalogId = (engine: EngineType) => `${engine}:vscode-local:v1`;
