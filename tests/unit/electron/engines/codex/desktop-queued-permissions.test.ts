import { describe, expect, it } from "vitest";
import { resolveDesktopQueuedPermissions } from "../../../../../electron/main/engines/codex/desktop-queued-permissions";

describe("resolveDesktopQueuedPermissions", () => {
  it("resolves the current custom config without exposing unrelated configuration or retaining a profile", () => {
    const message = { id: "native", text: "Continue", context: {}, createdAt: 1, submissionOptions: { permissionSelection: { kind: "custom" } } };
    expect(resolveDesktopQueuedPermissions(message, {
      sandbox_mode: "danger-full-access", approval_policy: "never", model_provider: "private-provider", env: { SECRET: "private" },
    }, "/repo")).toEqual({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, permissions: null });
    expect(resolveDesktopQueuedPermissions(message, { sandbox_mode: "danger-full-access", approval_policy: null, approvals_reviewer: null }, "/repo"))
      .toEqual({ sandboxPolicy: { type: "dangerFullAccess" }, permissions: null });
    expect(resolveDesktopQueuedPermissions(message, { sandbox_mode: "workspace-write", approval_policy: "on-request",
      sandbox_workspace_write: { writable_roots: ["/extra"], network_access: true },
    }, "/repo")).toMatchObject({ sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/repo", "/extra"], networkAccess: true }, permissions: null });
  });

  it("preserves native server defaults and mutually exclusive explicit profile selections", () => {
    const base = { id: "native", text: "Continue", context: {}, createdAt: 1 };
    expect(resolveDesktopQueuedPermissions({ ...base, submissionOptions: { permissionSelection: { kind: "server-default" } } }, {}, "/repo")).toEqual({});
    expect(resolveDesktopQueuedPermissions({ ...base, submissionOptions: { permissionSelection: { kind: "profile", profileId: ":read-only" } } }, {}, "/repo"))
      .toEqual({ permissions: ":read-only", sandboxPolicy: null });
    expect(() => resolveDesktopQueuedPermissions({ ...base, submissionOptions: { permissionSelection: { kind: "unknown" } } }, {}, "/repo")).toThrow("Unsupported");
  });
});
