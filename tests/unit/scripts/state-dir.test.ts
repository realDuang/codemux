import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getGlobalServerStateRoot,
  getIsolatedServerStateDir,
  readIsolatedFromArgsAndEnv,
  resolveServerStateDir,
} from "../../../scripts/state-dir";

describe("getGlobalServerStateRoot", () => {
  it("uses XDG_STATE_HOME when set and non-empty", () => {
    expect(getGlobalServerStateRoot({ env: { XDG_STATE_HOME: "/custom/state" } })).toBe(
      path.join("/custom/state", "codemux-server"),
    );
  });

  it("falls back to $HOME/.local/state when XDG_STATE_HOME is unset", () => {
    expect(getGlobalServerStateRoot({ env: { HOME: "/home/test" } })).toBe(
      path.join("/home/test", ".local", "state", "codemux-server"),
    );
  });

  it("falls back to $HOME/.local/state when XDG_STATE_HOME is empty", () => {
    expect(getGlobalServerStateRoot({ env: { XDG_STATE_HOME: "", HOME: "/home/test" } })).toBe(
      path.join("/home/test", ".local", "state", "codemux-server"),
    );
  });

  it("honours the explicit homedir override when HOME is unset", () => {
    expect(getGlobalServerStateRoot({ env: {}, homedir: "/alt/home" })).toBe(
      path.join("/alt/home", ".local", "state", "codemux-server"),
    );
  });

  it("is path-stable regardless of the repo the caller is in", () => {
    const env = { XDG_STATE_HOME: "/state" };
    expect(getGlobalServerStateRoot({ env })).toBe(getGlobalServerStateRoot({ env }));
  });
});

describe("getIsolatedServerStateDir", () => {
  it("composes <repoDir>/.codemux-dev/server", () => {
    expect(getIsolatedServerStateDir("/home/dev/codemux")).toBe(
      path.join("/home/dev/codemux", ".codemux-dev", "server"),
    );
  });

  it("resolves relative paths to absolute paths", () => {
    expect(getIsolatedServerStateDir("some-rel")).toBe(
      path.join(path.resolve("some-rel"), ".codemux-dev", "server"),
    );
  });

  it("keeps the basename of the repo dir verbatim — no slugging", () => {
    const dir = getIsolatedServerStateDir("/tmp/CodeMux Worktree/X");
    expect(dir).toBe(path.join("/tmp/CodeMux Worktree/X", ".codemux-dev", "server"));
  });
});

describe("resolveServerStateDir", () => {
  it("returns the machine-global root when isolated is omitted (single-instance default)", () => {
    expect(resolveServerStateDir({ repoDir: "/anywhere", env: { XDG_STATE_HOME: "/state" } })).toBe(
      path.join("/state", "codemux-server"),
    );
  });

  it("returns the machine-global root when isolated is false", () => {
    expect(
      resolveServerStateDir({ repoDir: "/anywhere", isolated: false, env: { XDG_STATE_HOME: "/state" } }),
    ).toBe(path.join("/state", "codemux-server"));
  });

  it("returns the per-repo isolated dir when isolated is true", () => {
    expect(
      resolveServerStateDir({ repoDir: "/home/dev/codemux", isolated: true, env: { XDG_STATE_HOME: "/state" } }),
    ).toBe(path.join("/home/dev/codemux", ".codemux-dev", "server"));
  });

  it("ignores XDG_STATE_HOME when isolated is true — the dir lives in the repo", () => {
    const a = resolveServerStateDir({ repoDir: "/repo", isolated: true, env: { XDG_STATE_HOME: "/x" } });
    const b = resolveServerStateDir({ repoDir: "/repo", isolated: true, env: { XDG_STATE_HOME: "/y" } });
    expect(a).toBe(b);
  });

  it("yields a different dir per worktree in isolated mode", () => {
    const a = resolveServerStateDir({ repoDir: "/home/alice/codemux", isolated: true });
    const b = resolveServerStateDir({ repoDir: "/home/bob/codemux", isolated: true });
    expect(a).not.toBe(b);
  });

  it("yields the same dir from any worktree in non-isolated mode (single-instance semantics)", () => {
    const env = { HOME: "/home/test" };
    const a = resolveServerStateDir({ repoDir: "/home/alice/codemux", isolated: false, env });
    const b = resolveServerStateDir({ repoDir: "/home/bob/elsewhere", isolated: false, env });
    expect(a).toBe(b);
  });
});

describe("readIsolatedFromArgsAndEnv", () => {
  it("returns true when --isolated is present", () => {
    expect(readIsolatedFromArgsAndEnv(["--isolated"], {})).toBe(true);
  });

  it("returns false when --global is present, even if env says isolated", () => {
    expect(readIsolatedFromArgsAndEnv(["--global"], { CODEMUX_DEV_ISOLATED: "1" })).toBe(false);
  });

  it("--isolated wins over --global when both are present", () => {
    expect(readIsolatedFromArgsAndEnv(["--isolated", "--global"], {})).toBe(true);
  });

  it("falls back to CODEMUX_DEV_ISOLATED=1 when no flag is given", () => {
    expect(readIsolatedFromArgsAndEnv([], { CODEMUX_DEV_ISOLATED: "1" })).toBe(true);
  });

  it("returns false when neither flag nor env is set", () => {
    expect(readIsolatedFromArgsAndEnv([], {})).toBe(false);
  });

  it("treats CODEMUX_DEV_ISOLATED=0 as non-isolated", () => {
    expect(readIsolatedFromArgsAndEnv([], { CODEMUX_DEV_ISOLATED: "0" })).toBe(false);
  });

  it("treats any non-`1` value as non-isolated (strict match)", () => {
    expect(readIsolatedFromArgsAndEnv([], { CODEMUX_DEV_ISOLATED: "true" })).toBe(false);
    expect(readIsolatedFromArgsAndEnv([], { CODEMUX_DEV_ISOLATED: "yes" })).toBe(false);
  });
});
