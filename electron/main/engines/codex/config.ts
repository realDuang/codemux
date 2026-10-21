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

/**
 * CodeMux exposes Codex's permission presets as its session modes, matching the
 * official Desktop picker. Codex's collaboration mode always stays "default".
 */
export const CODEX_MODES: AgentMode[] = [
  { id: "ask", label: "Ask for approval", description: "Always ask before editing files outside the workspace or using the internet" },
  { id: "auto-review", label: "Approve for me", description: "Only ask for approval when a risky action is detected" },
  { id: "full-access", label: "Full access", description: "Unrestricted access to the internet and any file on this computer" },
];
export const DEFAULT_CODEX_MODE = "ask";
export const CODEX_COLLABORATION_MODE = "default";
/** Native collaboration modes that may appear on threads created elsewhere. */
export const CODEX_COLLABORATION_MODES = ["default", "plan"];

export type CodexApprovalsReviewer = "user" | "auto_review";

export function normalizeCodexMode(modeId: string | undefined): string {
  return CODEX_MODES.some((mode) => mode.id === modeId) ? modeId! : DEFAULT_CODEX_MODE;
}

const FULL_READ_ACCESS: CodexReadOnlyAccess = { type: "fullAccess" };

export function modeToApprovalPolicy(modeId: string): CodexApprovalPolicy {
  return normalizeCodexMode(modeId) === "full-access" ? "never" : "on-request";
}

export function modeToApprovalsReviewer(modeId: string): CodexApprovalsReviewer {
  return normalizeCodexMode(modeId) === "auto-review" ? "auto_review" : "user";
}

export function modeToSandboxMode(modeId: string): CodexSandboxMode {
  return normalizeCodexMode(modeId) === "full-access" ? "danger-full-access" : "workspace-write";
}

export function modeToPermissionProfile(modeId: string): string {
  return normalizeCodexMode(modeId) === "full-access" ? ":danger-full-access" : ":workspace";
}

export function modeToSandboxPolicy(modeId: string, directory: string): CodexSandboxPolicy {
  if (normalizeCodexMode(modeId) === "full-access") return { type: "dangerFullAccess" };
  const normalizedDirectory = normalizeDirectory(directory);
  const writableRoots = normalizedDirectory ? [normalizedDirectory] : [];

  return {
    type: "workspaceWrite",
    writableRoots,
    readOnlyAccess: FULL_READ_ACCESS,
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

/** Native thread settings that select a preset on the next turn. */
export function codexPermissionPatch(modeId: string): {
  approvalPolicy: CodexApprovalPolicy;
  approvalsReviewer: CodexApprovalsReviewer;
  sandboxPolicy: Record<string, unknown>;
  activePermissionProfile: { id: string; extends: null };
} {
  return {
    approvalPolicy: modeToApprovalPolicy(modeId),
    approvalsReviewer: modeToApprovalsReviewer(modeId),
    // The workspace root is implied by the thread cwd; no extra writable roots.
    sandboxPolicy: normalizeCodexMode(modeId) === "full-access" ? { type: "dangerFullAccess" }
      : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    activePermissionProfile: { id: modeToPermissionProfile(modeId), extends: null },
  };
}

/**
 * Maps native permission settings back to a preset. Combinations the presets
 * cannot express (e.g. read-only or never-ask with a workspace sandbox) have no
 * mode, so the UI never claims a preset the thread is not actually using.
 */
export function codexModeFromPermissions(settings: {
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandboxPolicy?: unknown;
  activePermissionProfile?: unknown;
  permissions?: unknown;
}): string | undefined {
  const sandbox = settings.sandboxPolicy && typeof settings.sandboxPolicy === "object" ? (settings.sandboxPolicy as { type?: unknown }).type : undefined;
  const profile = settings.activePermissionProfile && typeof settings.activePermissionProfile === "object"
    ? (settings.activePermissionProfile as { id?: unknown }).id : settings.permissions;
  const fullAccess = sandbox === "dangerFullAccess" || profile === ":danger-full-access";
  const workspace = sandbox === "workspaceWrite" || profile === ":workspace";
  if (fullAccess && settings.approvalPolicy === "never") return "full-access";
  if (!workspace || fullAccess || (settings.approvalPolicy !== "on-request" && settings.approvalPolicy !== "untrusted")) return undefined;
  return settings.approvalsReviewer === "auto_review" || settings.approvalsReviewer === "guardian_subagent" ? "auto-review" : "ask";
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
    case "ultra":
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
    case "ultra":
      return "ultra";
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
