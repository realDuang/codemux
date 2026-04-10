import { describe, expect, it } from "vitest";

import {
  CODEX_MODES,
  buildStartupArgs,
  clampApprovalPolicy,
  clampSandboxMode,
  clampSandboxPolicy,
  fromCodexEffort,
  modeToApprovalPolicy,
  modeToSandboxMode,
  modeToSandboxPolicy,
  sandboxModeFromPolicy,
  toCodexEffort,
} from "../../../../../electron/main/engines/codex/config";

describe("codex/config.ts", () => {
  it("defines the expected Codex modes", () => {
    expect(CODEX_MODES.map((mode) => mode.id)).toEqual(["default", "plan"]);
  });

  it("maps modes to stable approval policies", () => {
    expect(modeToApprovalPolicy("default")).toBe("never");
    expect(modeToApprovalPolicy("plan")).toBe("never");
  });

  it("maps modes to stable sandbox modes and policies", () => {
    expect(modeToSandboxMode("default")).toBe("workspace-write");
    expect(modeToSandboxMode("plan")).toBe("workspace-write");

    expect(modeToSandboxPolicy("default", "/repo")).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repo"],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });

    expect(modeToSandboxPolicy("plan", "/repo")).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repo"],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it("clamps approval and sandbox selections to server requirements", () => {
    expect(clampApprovalPolicy("never", { allowedApprovalPolicies: ["untrusted", "on-request"] })).toBe("untrusted");
    expect(clampSandboxMode("workspace-write", { allowedSandboxModes: ["danger-full-access", "read-only"] })).toBe("danger-full-access");

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
  });

  it("maps reasoning effort to and from Codex values", () => {
    expect(toCodexEffort("max")).toBe("xhigh");
    expect(toCodexEffort("medium")).toBe("medium");

    expect(fromCodexEffort("xhigh")).toBe("max");
    expect(fromCodexEffort("high")).toBe("high");
    expect(fromCodexEffort("minimal")).toBeUndefined();
  });

  it("derives sandbox mode from a sandbox policy", () => {
    expect(sandboxModeFromPolicy({ type: "dangerFullAccess" })).toBe("danger-full-access");
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

  it("builds the stable app-server startup args", () => {
    expect(buildStartupArgs()).toEqual(["app-server"]);
  });
});
