import { execFileSync } from "child_process";
import type { AgentMode, UnifiedModelInfo } from "../../../../src/types/unified";

// ============================================================================
// Codex Engine Configuration
// ============================================================================

const IS_WIN = process.platform === "win32";

export const CODEX_DEFAULT_MODEL = "o4-mini";

export const CODEX_MODES: AgentMode[] = [
  { id: "suggest", label: "Suggest", description: "Read-only, no execution" },
  { id: "auto-edit", label: "Auto Edit", description: "Auto-approve edits, prompt for commands" },
  { id: "full-auto", label: "Full Auto", description: "Auto-approve everything" },
];

/**
 * Known Codex-compatible models with their capabilities.
 * engineType is omitted here and injected by the adapter at runtime.
 */
export const CODEX_MODEL_LIST: Omit<UnifiedModelInfo, "engineType">[] = [
  {
    modelId: "o4-mini",
    name: "o4-mini",
    capabilities: {
      reasoning: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    },
    cost: { input: 1.10, output: 4.40 },
  },
  {
    modelId: "o3",
    name: "o3",
    capabilities: {
      reasoning: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    },
    cost: { input: 2.00, output: 8.00 },
  },
  {
    modelId: "o3-pro",
    name: "o3-pro",
    capabilities: {
      reasoning: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "high",
    },
    cost: { input: 20.00, output: 80.00 },
  },
  {
    modelId: "gpt-4.1",
    name: "GPT-4.1",
    capabilities: { reasoning: false },
    cost: { input: 2.00, output: 8.00 },
  },
  {
    modelId: "gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    capabilities: { reasoning: false },
    cost: { input: 0.40, output: 1.60 },
  },
  {
    modelId: "gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    capabilities: { reasoning: false },
    cost: { input: 0.10, output: 0.40 },
  },
];

/**
 * Map mode ID to Codex approval_policy value.
 */
export function modeToApprovalPolicy(modeId: string): string {
  switch (modeId) {
    case "suggest": return "suggest";
    case "auto-edit": return "auto-edit";
    case "full-auto": return "full-auto";
    default: return "suggest";
  }
}

/**
 * Resolve the `codex` CLI binary path.
 * Looks in PATH via `which` (Unix) or `where` (Windows).
 * Returns undefined if not found.
 */
export function resolveCodexCliPath(): string | undefined {
  try {
    const cmd = IS_WIN ? "where" : "which";
    const result = execFileSync(cmd, ["codex"], {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const firstLine = result.trim().split("\n")[0]?.trim();
    return firstLine || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build CLI arguments for starting the Codex app-server.
 */
export function buildStartupArgs(
  model: string,
  approvalPolicy: string,
): string[] {
  return [
    "-c", `model=${model}`,
    "-c", `approval_policy=${approvalPolicy}`,
    "app-server",
    "--listen", "stdio://",
  ];
}
