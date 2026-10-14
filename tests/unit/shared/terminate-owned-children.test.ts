import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminateOwnedChildren, terminateOwnedProcessTree } from "../../../shared/terminate-owned-children";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const originalPlatform = process.platform;
const pid = process.pid;
const childPid = Math.max(pid, process.ppid) + 100;
const grandchildPid = childPid + 1;
const siblingPid = childPid + 2;
const externalPid = childPid + 3;

beforeEach(() => {
  vi.mocked(execFileSync).mockReset();
  vi.spyOn(process, "kill").mockReturnValue(true);
  Object.defineProperty(process, "platform", { value: "linux" });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

describe("terminateOwnedChildren", () => {
  it("kills only current descendants, deepest first, regardless of snapshot order", () => {
    vi.mocked(execFileSync).mockReturnValue([
      `${grandchildPid} ${childPid}`,
      `${externalPid} ${process.ppid}`,
      `${pid} ${process.ppid}`,
      `${childPid} ${pid}`,
      `${siblingPid} ${pid}`,
    ].join("\n"));

    expect(terminateOwnedChildren()).toBeUndefined();

    expect(process.kill).toHaveBeenCalledTimes(3);
    expect(process.kill).toHaveBeenNthCalledWith(1, grandchildPid, "SIGKILL");
    expect(process.kill).toHaveBeenNthCalledWith(2, siblingPid, "SIGKILL");
    expect(process.kill).toHaveBeenNthCalledWith(3, childPid, "SIGKILL");
    expect(execFileSync).toHaveBeenCalledWith("ps", ["-A", "-o", "pid=,ppid="], expect.objectContaining({
      timeout: 5_000,
      killSignal: "SIGKILL",
      encoding: "utf8",
    }));
  });

  it("ignores malformed rows, unsafe PIDs, conflicting ownership and cycles", () => {
    vi.mocked(execFileSync).mockReturnValue([
      "PID PPID",
      `-1 ${pid}`,
      `0 ${pid}`,
      `1 ${pid}`,
      `1.5 ${pid}`,
      `9007199254740992 ${pid}`,
      `${childPid} 0`,
      `${childPid} -1`,
      `${childPid} ${pid} extra`,
      `${childPid} ${pid}`,
      `${childPid} ${externalPid}`,
      `${grandchildPid} ${childPid}`,
      `${process.ppid} ${pid}`,
      `${externalPid} ${process.ppid}`,
      `${pid} ${siblingPid}`,
      `  ${siblingPid}   ${pid}\r`,
      `${siblingPid} ${pid}`,
    ].join("\n"));

    terminateOwnedChildren();

    expect(process.kill).toHaveBeenCalledExactlyOnceWith(siblingPid, "SIGKILL");
  });

  it.each(["ESRCH", "EPERM"])("continues cleanup when a descendant rejects termination with %s", (code) => {
    vi.mocked(execFileSync).mockReturnValue(`${childPid} ${pid}\n${grandchildPid} ${childPid}`);
    vi.mocked(process.kill).mockImplementationOnce(() => {
      throw Object.assign(new Error(code), { code });
    });

    expect(() => terminateOwnedChildren()).not.toThrow();

    expect(process.kill).toHaveBeenNthCalledWith(1, grandchildPid, "SIGKILL");
    expect(process.kill).toHaveBeenNthCalledWith(2, childPid, "SIGKILL");
  });

  it.each(["ENOENT", "ETIMEDOUT", "ENOBUFS"])("does not guess ownership after enumeration fails with %s", (code) => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });

    expect(() => terminateOwnedChildren()).not.toThrow();

    expect(process.kill).not.toHaveBeenCalled();
  });

  it("returns without sending signals when there are no descendants", () => {
    vi.mocked(execFileSync).mockReturnValue(`${pid} ${process.ppid}\n${externalPid} ${process.ppid}`);

    terminateOwnedChildren();

    expect(process.kill).not.toHaveBeenCalled();
  });

  it("enumerates Windows parentage without targeting the host with taskkill", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.mocked(execFileSync).mockReturnValue(`${childPid} ${pid}\r\n${grandchildPid} ${childPid}\r\n`);

    terminateOwnedChildren();

    expect(execFileSync).toHaveBeenCalledExactlyOnceWith("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }",
    ], expect.objectContaining({ windowsHide: true, timeout: 5_000 }));
    expect(process.kill).toHaveBeenNthCalledWith(1, grandchildPid, "SIGKILL");
    expect(process.kill).toHaveBeenNthCalledWith(2, childPid, "SIGKILL");
    expect(process.kill).not.toHaveBeenCalledWith(pid, expect.anything());
  });
});

describe("terminateOwnedProcessTree", () => {
  it("kills the directly owned child's descendants before the child and preserves sibling trees", () => {
    const siblingDescendantPid = externalPid + 1;
    vi.mocked(execFileSync).mockReturnValue([
      `${grandchildPid} ${childPid}`,
      `${siblingDescendantPid} ${siblingPid}`,
      `${externalPid} ${process.ppid}`,
      `${childPid} ${pid}`,
      `${siblingPid} ${pid}`,
      `${pid} ${process.ppid}`,
    ].join("\n"));

    expect(terminateOwnedProcessTree(childPid)).toBeUndefined();

    expect(process.kill).toHaveBeenCalledTimes(2);
    expect(process.kill).toHaveBeenNthCalledWith(1, grandchildPid, "SIGKILL");
    expect(process.kill).toHaveBeenNthCalledWith(2, childPid, "SIGKILL");
  });

  it.each([-1, 0, 1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, pid, process.ppid])(
    "rejects unsafe or protected target PID %s before enumerating processes",
    (targetPid) => {
      terminateOwnedProcessTree(targetPid);

      expect(execFileSync).not.toHaveBeenCalled();
      expect(process.kill).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["unknown", childPid, `${grandchildPid} ${childPid}`],
    ["external", externalPid, `${externalPid} ${process.ppid}\n${childPid} ${externalPid}`],
    ["indirect", grandchildPid, `${childPid} ${pid}\n${grandchildPid} ${childPid}`],
    ["ambiguous", childPid, `${childPid} ${pid}\n${childPid} ${externalPid}\n${grandchildPid} ${childPid}`],
    ["ambiguous in reverse order", childPid, `${childPid} ${externalPid}\n${childPid} ${pid}\n${grandchildPid} ${childPid}`],
  ])("preserves a target with %s ownership", (_description, targetPid, snapshot) => {
    vi.mocked(execFileSync).mockReturnValue(snapshot);

    terminateOwnedProcessTree(targetPid);

    expect(process.kill).not.toHaveBeenCalled();
  });

  it("checks a fresh snapshot for each call instead of retaining previous ownership", () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce(`${childPid} ${pid}`)
      .mockReturnValueOnce(`${childPid} ${externalPid}`);

    terminateOwnedProcessTree(childPid);
    terminateOwnedProcessTree(childPid);

    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(childPid, "SIGKILL");
  });

  it("does not send signals when fresh ownership cannot be enumerated", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error("unavailable"), { code: "ENOENT" });
    });

    expect(() => terminateOwnedProcessTree(childPid)).not.toThrow();

    expect(process.kill).not.toHaveBeenCalled();
  });

  it("still terminates the root when a descendant has already exited", () => {
    vi.mocked(execFileSync).mockReturnValue(`${childPid} ${pid}\n${grandchildPid} ${childPid}`);
    vi.mocked(process.kill).mockImplementationOnce(() => {
      throw Object.assign(new Error("exited"), { code: "ESRCH" });
    });

    expect(() => terminateOwnedProcessTree(childPid)).not.toThrow();

    expect(process.kill).toHaveBeenNthCalledWith(1, grandchildPid, "SIGKILL");
    expect(process.kill).toHaveBeenNthCalledWith(2, childPid, "SIGKILL");
  });
});
