import { execFileSync } from "child_process";

import type { AgentMode, ReasoningEffort } from "../../../../src/types/unified";

const IS_WIN = process.platform === "win32";

export type CodexApprovalPolicy = "on-request" | "untrusted" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexReadOnlyAccess {
  type: "fullAccess";
}

export interface CodexReadOnlySandboxPolicy {
  type: "readOnly";
  access: CodexReadOnlyAccess;
  networkAccess: boolean;
}

export interface CodexWorkspaceWriteSandboxPolicy {
  type: "workspaceWrite";
  writableRoots: string[];
  readOnlyAccess: CodexReadOnlyAccess;
  networkAccess: boolean;
  excludeTmpdirEnvVar: boolean;
  excludeSlashTmp: boolean;
}

export interface CodexDangerFullAccessSandboxPolicy {
  type: "dangerFullAccess";
}

export type CodexSandboxPolicy =
  | CodexReadOnlySandboxPolicy
  | CodexWorkspaceWriteSandboxPolicy
  | CodexDangerFullAccessSandboxPolicy;

export interface CodexConfigRequirements {
  allowedApprovalPolicies?: CodexApprovalPolicy[] | null;
  allowedSandboxModes?: CodexSandboxMode[] | null;
}

// Used only before model/list returns the server default.
export const CODEX_FALLBACK_MODEL = "codex-mini-latest";

export const CODEX_MODES: AgentMode[] = [
  { id: "default", label: "Default", description: "Standard coding assistant mode" },
  { id: "plan", label: "Plan", description: "Multi-step planning and execution mode" },
];

const FULL_READ_ACCESS: CodexReadOnlyAccess = { type: "fullAccess" };

export function modeToApprovalPolicy(_modeId: string): CodexApprovalPolicy {
  return "never";
}

export function modeToSandboxMode(_modeId: string): CodexSandboxMode {
  return "workspace-write";
}

export function modeToSandboxPolicy(_modeId: string, directory: string): CodexSandboxPolicy {
  const normalizedDirectory = normalizeDirectory(directory);
  const writableRoots = normalizedDirectory ? [normalizedDirectory] : [];

  return {
    type: "workspaceWrite",
    writableRoots,
    readOnlyAccess: FULL_READ_ACCESS,
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export function clampApprovalPolicy(
  requested: CodexApprovalPolicy,
  requirements?: CodexConfigRequirements | null,
): CodexApprovalPolicy {
  const allowed = requirements?.allowedApprovalPolicies?.filter(isCodexApprovalPolicy);
  if (!allowed || allowed.length === 0) return requested;
  if (allowed.includes(requested)) return requested;

  const preferenceOrder: Record<CodexApprovalPolicy, CodexApprovalPolicy[]> = {
    "on-request": ["on-request", "untrusted", "never"],
    untrusted: ["untrusted", "on-request", "never"],
    never: ["never", "untrusted", "on-request"],
  };

  return preferenceOrder[requested].find((candidate) => allowed.includes(candidate)) ?? allowed[0];
}

export function clampSandboxMode(
  requested: CodexSandboxMode,
  requirements?: CodexConfigRequirements | null,
): CodexSandboxMode {
  const allowed = requirements?.allowedSandboxModes?.filter(isCodexSandboxMode);
  if (!allowed || allowed.length === 0) return requested;
  if (allowed.includes(requested)) return requested;

  const preferenceOrder: Record<CodexSandboxMode, CodexSandboxMode[]> = {
    "read-only": ["read-only", "workspace-write", "danger-full-access"],
    "workspace-write": ["workspace-write", "danger-full-access", "read-only"],
    "danger-full-access": ["danger-full-access", "workspace-write", "read-only"],
  };

  return preferenceOrder[requested].find((candidate) => allowed.includes(candidate)) ?? allowed[0];
}

export function clampSandboxPolicy(
  requested: CodexSandboxPolicy,
  requirements?: CodexConfigRequirements | null,
): CodexSandboxPolicy {
  const clampedMode = clampSandboxMode(sandboxModeFromPolicy(requested), requirements);
  if (clampedMode === sandboxModeFromPolicy(requested)) return requested;

  switch (clampedMode) {
    case "read-only":
      return {
        type: "readOnly",
        access: FULL_READ_ACCESS,
        networkAccess: requested.type === "dangerFullAccess" ? true : requested.networkAccess,
      };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "workspace-write":
    default:
      return {
        type: "workspaceWrite",
        writableRoots: requested.type === "workspaceWrite" ? requested.writableRoots : [],
        readOnlyAccess: FULL_READ_ACCESS,
        networkAccess: requested.type === "dangerFullAccess" ? true : requested.networkAccess,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

export function sandboxModeFromPolicy(policy: CodexSandboxPolicy): CodexSandboxMode {
  switch (policy.type) {
    case "dangerFullAccess":
      return "danger-full-access";
    case "readOnly":
      return "read-only";
    case "workspaceWrite":
    default:
      return "workspace-write";
  }
}

export function normalizeDirectory(directory: string): string {
  return directory.replaceAll("\\", "/");
}

export function toCodexEffort(effort: ReasoningEffort): string {
  switch (effort) {
    case "max":
      return "xhigh";
    case "high":
    case "medium":
    case "low":
      return effort;
    default:
      return "medium";
  }
}

export function fromCodexEffort(codexEffort: string): ReasoningEffort | undefined {
  switch (codexEffort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "max";
    default:
      return undefined;
  }
}

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

export function resolveCodexCliVersion(cliPath?: string): string | undefined {
  const resolvedCliPath = cliPath ?? resolveCodexCliPath();
  if (!resolvedCliPath) return undefined;

  try {
    const result = execFileSync(resolvedCliPath, ["--version"], {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    return result
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^codex-cli\s+/i.test(line));
  } catch {
    return undefined;
  }
}

export function buildStartupArgs(): string[] {
  return ["app-server"];
}

function isCodexApprovalPolicy(value: string): value is CodexApprovalPolicy {
  return value === "on-request" || value === "untrusted" || value === "never";
}

function isCodexSandboxMode(value: string): value is CodexSandboxMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}
