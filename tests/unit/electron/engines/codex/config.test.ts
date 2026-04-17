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
  normalizeDirectory,
  sandboxModeFromPolicy,
  toCodexEffort,
} from "../../../../../electron/main/engines/codex/config";
import { isCodexServiceTier } from "../../../../../src/types/unified";

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

    expect(fromCodexEffort("xhigh")).toBe("max");
    expect(fromCodexEffort("medium")).toBe("medium");
    expect(fromCodexEffort("high")).toBe("high");
    expect(fromCodexEffort("low")).toBe("low");
    expect(fromCodexEffort("minimal")).toBeUndefined();
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
