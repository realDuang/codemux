import type { DesktopQueuedFollowUp } from "./desktop-ipc-client";

/** Resolve only the native permission fields needed by the Desktop composer. */
export function resolveDesktopQueuedPermissions(
  message: DesktopQueuedFollowUp,
  config: Record<string, unknown>,
  cwd: string,
): Record<string, unknown> {
  const options = record(message.submissionOptions);
  const work = record(message.context.workPermissions);
  if (work.resolvedPermissions != null) return resolvedPolicy(record(work.resolvedPermissions));
  const selection = record(options.permissionSelection);
  if (message.context.workPermissions == null && selection.kind === "server-default") return {};
  if (message.context.workPermissions == null && selection.kind === "profile") {
    if (typeof selection.profileId !== "string" || !selection.profileId) throw new Error("Invalid Desktop permission profile");
    return { permissions: selection.profileId, sandboxPolicy: null };
  }
  const mode = message.context.workPermissions != null ? work.mode
    : selection.kind === "agent-mode" ? selection.agentMode
      : selection.kind === "custom" ? "custom"
        : options.shouldSendPermissionOverrides || options.usePermissionSelection ? options.agentMode ?? "auto" : undefined;
  if (mode == null) {
    if (selection.kind != null) throw new Error("Unsupported Desktop permission selection");
    return {};
  }
  const profiles: Record<string, string> = { "read-only": ":read-only", auto: ":workspace", "full-access": ":danger-full-access" };
  if (typeof mode === "string" && profiles[mode]) {
    return { permissions: profiles[mode], sandboxPolicy: null, approvalPolicy: mode === "full-access" ? "never" : "on-request", approvalsReviewer: "user" };
  }
  if (mode !== "custom") throw new Error("Unsupported Desktop permission mode");
  const defaults = record(work.defaults);
  const policy = defaults.approvalPolicy ?? config.approval_policy;
  const reviewer = defaults.approvalPolicy != null ? "user" : config.approvals_reviewer;
  validateApproval(policy, reviewer);
  const approvalSettings = { ...(policy != null ? { approvalPolicy: policy } : {}), ...(reviewer != null ? { approvalsReviewer: reviewer } : {}) };
  const sandboxMode = defaults.sandboxMode ?? config.sandbox_mode;
  if (sandboxMode == null) return approvalSettings;
  let sandboxPolicy: Record<string, unknown>;
  if (sandboxMode === "danger-full-access") sandboxPolicy = { type: "dangerFullAccess" };
  else if (sandboxMode === "read-only") sandboxPolicy = { type: "readOnly" };
  else if (sandboxMode === "workspace-write") {
    const workspace = record(config.sandbox_workspace_write);
    const roots = workspace.writable_roots ?? [];
    const runtimeRoots = message.context.workspaceRoots ?? (cwd ? [cwd] : []);
    if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string")
      || !Array.isArray(runtimeRoots) || runtimeRoots.some((root) => typeof root !== "string")) {
      throw new Error("Unsupported Desktop writable roots");
    }
    sandboxPolicy = {
      type: "workspaceWrite", writableRoots: [...new Set([...runtimeRoots, ...roots])],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: boolean(defaults.networkAccess ?? workspace.network_access, false),
      excludeTmpdirEnvVar: boolean(workspace.exclude_tmpdir_env_var, false),
      excludeSlashTmp: boolean(workspace.exclude_slash_tmp, false),
    };
  } else throw new Error("Unsupported Desktop sandbox mode");
  return { ...approvalSettings, sandboxPolicy, permissions: null };
}

function resolvedPolicy(value: Record<string, unknown>): Record<string, unknown> {
  const policy = value.approvalPolicy;
  const reviewer = value.approvalsReviewer;
  validateApproval(policy, reviewer);
  const approvalSettings = { ...(policy != null ? { approvalPolicy: policy } : {}), ...(reviewer != null ? { approvalsReviewer: reviewer } : {}) };
  const profile = record(value.activePermissionProfile);
  if (typeof profile.id === "string" && profile.id) {
    return { ...approvalSettings, permissions: profile.id, sandboxPolicy: null };
  }
  const sandbox = record(value.sandboxPolicy);
  if (!["readOnly", "workspaceWrite", "dangerFullAccess", "externalSandbox"].includes(String(sandbox.type))) {
    throw new Error("Unsupported resolved Desktop sandbox policy");
  }
  return { ...approvalSettings, sandboxPolicy: structuredClone(sandbox), permissions: null };
}

function validateApproval(policy: unknown, reviewer: unknown): void {
  if ((policy != null && !["untrusted", "on-failure", "on-request", "never"].includes(String(policy))) || (reviewer != null && reviewer !== "user")) {
    throw new Error("Unsupported Desktop approval settings");
  }
}

function boolean(value: unknown, fallback: boolean): boolean {
  if (value == null) return fallback;
  if (typeof value !== "boolean") throw new Error("Invalid Desktop sandbox setting");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
