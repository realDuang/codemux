import { describe, expect, it } from "vitest";

import {
  CODEX_MODES,
  buildStartupArgs,
  codexModeFromPermissions,
  codexPermissionPatch,
  modeToApprovalsReviewer,
  normalizeCodexMode,
  clampApprovalPolicy,
  clampSandboxMode,
  clampSandboxPolicy,
  fromCodexEffort,
  modeToApprovalPolicy,
  modeToSandboxMode,
  modeToSandboxPolicy,
  normalizeDirectory,
  sandboxModeFromPolicy,
  toCodexEffort,
} from "../../../../../electron/main/engines/codex/config";
import { REASONING_EFFORT_VALUES, isCodexServiceTier, isReasoningEffort, normalizeReasoningEfforts } from "../../../../../src/types/unified";

describe("codex/config.ts", () => {
  it("exposes Codex permission presets as modes", () => {
    expect(CODEX_MODES.map((mode) => mode.id)).toEqual(["ask", "auto-review", "full-access"]);
    expect(normalizeCodexMode("plan")).toBe("ask");
  });

  it("maps presets to approval policies and reviewers", () => {
    expect(modeToApprovalPolicy("ask")).toBe("on-request");
    expect(modeToApprovalPolicy("auto-review")).toBe("on-request");
    expect(modeToApprovalPolicy("full-access")).toBe("never");
    expect(modeToApprovalsReviewer("ask")).toBe("user");
    expect(modeToApprovalsReviewer("auto-review")).toBe("auto_review");
    expect(modeToApprovalsReviewer("full-access")).toBe("user");
  });

  it("maps presets to sandbox modes and policies", () => {
    expect(modeToSandboxMode("ask")).toBe("workspace-write");
    expect(modeToSandboxMode("full-access")).toBe("danger-full-access");
    expect(modeToSandboxPolicy("auto-review", "/repo")).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repo"],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(modeToSandboxPolicy("full-access", "/repo")).toEqual({ type: "dangerFullAccess" });
    expect(codexPermissionPatch("full-access")).toEqual({
      approvalPolicy: "never", approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" }, activePermissionProfile: { id: ":danger-full-access", extends: null },
    });
  });

  it("recognizes presets from native permission settings", () => {
    for (const mode of CODEX_MODES) expect(codexModeFromPermissions(codexPermissionPatch(mode.id))).toBe(mode.id);
    // Codex Desktop's full-access snapshot.
    expect(codexModeFromPermissions({ approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } })).toBe("full-access");
    // Combinations outside the presets are not reported as one.
    expect(codexModeFromPermissions({ approvalPolicy: "never", sandboxPolicy: { type: "workspaceWrite" } })).toBeUndefined();
    expect(codexModeFromPermissions({ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } })).toBeUndefined();
  });

  it("clamps approval and sandbox selections to server requirements", () => {
    expect(clampApprovalPolicy("never", { allowedApprovalPolicies: ["untrusted", "on-request"] })).toBe("untrusted");
    expect(clampSandboxMode("workspace-write", { allowedSandboxModes: ["danger-full-access", "read-only"] })).toBe("danger-full-access");
    expect(clampApprovalPolicy("on-request", { allowedApprovalPolicies: ["on-request", "never"] })).toBe("on-request");
    expect(clampSandboxMode("read-only", { allowedSandboxModes: ["read-only", "workspace-write"] })).toBe("read-only");

    expect(
      clampSandboxPolicy(
        {
          type: "workspaceWrite",
          writableRoots: ["/repo"],
          readOnlyAccess: { type: "fullAccess" },
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        { allowedSandboxModes: ["read-only"] },
      ),
    ).toEqual({
      type: "readOnly",
      access: { type: "fullAccess" },
      networkAccess: true,
    });

    expect(
      clampSandboxPolicy(
        { type: "dangerFullAccess" },
        { allowedSandboxModes: ["workspace-write"] },
      ),
    ).toEqual({
      type: "workspaceWrite",
      writableRoots: [],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });

    expect(
      clampSandboxPolicy(
        {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
        { allowedSandboxModes: ["danger-full-access"] },
      ),
    ).toEqual({ type: "dangerFullAccess" });
  });

  it("maps reasoning effort to and from Codex values", () => {
    expect(toCodexEffort("max")).toBe("xhigh");
    expect(toCodexEffort("medium")).toBe("medium");
    expect(toCodexEffort("low")).toBe("low");
    expect(toCodexEffort("ultra")).toBe("ultra");

    expect(fromCodexEffort("xhigh")).toBe("max");
    expect(fromCodexEffort("medium")).toBe("medium");
    expect(fromCodexEffort("high")).toBe("high");
    expect(fromCodexEffort("low")).toBe("low");
    expect(fromCodexEffort("ultra")).toBe("ultra");
    expect(fromCodexEffort("minimal")).toBeUndefined();
  });

  it("accepts model-declared ultra without expanding standard fallback levels", () => {
    expect(isReasoningEffort("ultra")).toBe(true);
    expect(normalizeReasoningEfforts(["medium", "ultra", "invalid"])).toEqual(["medium", "ultra"]);
    expect(REASONING_EFFORT_VALUES).toEqual(["low", "medium", "high", "max"]);
  });

  it("derives sandbox mode from a sandbox policy", () => {
    expect(sandboxModeFromPolicy({ type: "dangerFullAccess" })).toBe("danger-full-access");
    expect(
      sandboxModeFromPolicy({
        type: "readOnly",
        access: { type: "fullAccess" },
        networkAccess: false,
      }),
    ).toBe("read-only");
    expect(
      sandboxModeFromPolicy({
        type: "workspaceWrite",
        writableRoots: ["/repo"],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }),
    ).toBe("workspace-write");
  });

  it("normalizes Windows-style paths before passing them to Codex", () => {
    expect(normalizeDirectory("C:\\work\\repo")).toBe("C:/work/repo");
  });

  it("builds the stable app-server startup args", () => {
    expect(buildStartupArgs()).toEqual(["app-server"]);
  });

  it("validates CodexServiceTier values", () => {
    expect(isCodexServiceTier("fast")).toBe(true);
    expect(isCodexServiceTier("flex")).toBe(true);
    expect(isCodexServiceTier("slow")).toBe(false);
    expect(isCodexServiceTier("")).toBe(false);
    expect(isCodexServiceTier(null)).toBe(false);
    expect(isCodexServiceTier(undefined)).toBe(false);
    expect(isCodexServiceTier(42)).toBe(false);
  });
});
