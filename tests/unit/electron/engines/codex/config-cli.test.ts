import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFileSync: execFileSyncMock,
}));

import {
  resolveCodexCliPath,
  resolveCodexCliVersion,
} from "../../../../../electron/main/engines/codex/config";

describe("codex/config.ts CLI discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the Codex CLI path from the first lookup result", () => {
    execFileSyncMock.mockReturnValue("/usr/local/bin/codex\n/opt/homebrew/bin/codex\n");

    expect(resolveCodexCliPath()).toBe("/usr/local/bin/codex");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      process.platform === "win32" ? "where" : "which",
      ["codex"],
      expect.objectContaining({
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  });

  it("returns undefined when CLI lookup fails", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("missing");
    });

    expect(resolveCodexCliPath()).toBeUndefined();
  });

  it("reads the codex-cli version banner from a provided path", () => {
    execFileSyncMock.mockReturnValue("codex-cli 1.2.3\ncommit abcdef\n");

    expect(resolveCodexCliVersion("/usr/local/bin/codex")).toBe("codex-cli 1.2.3");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "/usr/local/bin/codex",
      ["--version"],
      expect.objectContaining({
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  });

  it("falls back to CLI discovery before probing the version and handles probe failures", () => {
    execFileSyncMock
      .mockReturnValueOnce("/usr/local/bin/codex\n")
      .mockReturnValueOnce("codex-cli 2.0.0\n");

    expect(resolveCodexCliVersion()).toBe("codex-cli 2.0.0");

    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error("bad version");
    });
    expect(resolveCodexCliVersion("/usr/local/bin/codex")).toBeUndefined();
  });
});
