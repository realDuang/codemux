import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TerminalService,
  validateCwd,
  getDefaultShell,
  buildPtyEnv,
  type PtyModule,
} from "../../../../electron/main/services/terminal-service";

vi.mock("../../../../electron/main/services/terminal-profiles", () => ({
  listTerminalProfiles: vi.fn(() => ({ profiles: [], defaultProfileId: null })),
  getTerminalProfile: vi.fn(() => null),
}));

import {
  listTerminalProfiles,
  getTerminalProfile,
} from "../../../../electron/main/services/terminal-profiles";

// ---------------------------------------------------------------------------
// node-pty mock — emulates just the surface TerminalService touches
// ---------------------------------------------------------------------------

interface MockPty {
  pid: number;
  cols: number;
  rows: number;
  killed: boolean;
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  spawnedShell: string;
  spawnedArgs: string[];
  spawnedEnv: NodeJS.ProcessEnv;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (info: { exitCode: number; signal?: number }) => void) => void;
  // helpers for tests
  _emitData: (data: string) => void;
  _emitExit: (exitCode: number, signal?: number) => void;
  _resizeShouldThrow?: boolean;
}

function createMockPtyModule(): { mod: PtyModule; instances: MockPty[] } {
  const instances: MockPty[] = [];
  let nextPid = 1000;

  const mod: PtyModule = {
    spawn: ((shell: string, args: string[], opts: { cols: number; rows: number; env?: NodeJS.ProcessEnv }) => {
      let dataCb: ((data: string) => void) | null = null;
      let exitCb: ((info: { exitCode: number; signal?: number }) => void) | null = null;
      const inst: MockPty = {
        pid: nextPid++,
        cols: opts.cols,
        rows: opts.rows,
        killed: false,
        writes: [],
        resizes: [],
        spawnedShell: shell,
        spawnedArgs: args,
        spawnedEnv: opts.env ?? {},
        write(data) {
          this.writes.push(data);
        },
        resize(cols, rows) {
          if (this._resizeShouldThrow) throw new Error("PTY exited");
          this.cols = cols;
          this.rows = rows;
          this.resizes.push({ cols, rows });
        },
        kill() {
          if (this.killed) return;
          this.killed = true;
        },
        onData(cb) {
          dataCb = cb;
        },
        onExit(cb) {
          exitCb = cb;
        },
        _emitData(data) {
          dataCb?.(data);
        },
        _emitExit(exitCode, signal) {
          exitCb?.({ exitCode, signal });
        },
      };
      instances.push(inst);
      // node-pty's IPty has more fields, but we only use these.
      return inst as unknown as ReturnType<PtyModule["spawn"]>;
    }) as PtyModule["spawn"],
  };

  return { mod, instances };
}

// ---------------------------------------------------------------------------
// Filesystem fixtures
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `codemux-terminal-service-${Date.now()}`);
const TEST_FILE = join(TEST_DIR, "not-a-dir.txt");

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TEST_FILE, "x");
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// validateCwd
// ---------------------------------------------------------------------------

describe("validateCwd", () => {
  it("returns the resolved absolute path for an existing directory", () => {
    const out = validateCwd(TEST_DIR);
    expect(out).toBe(TEST_DIR);
  });

  it("rejects empty / non-string input", () => {
    expect(() => validateCwd("")).toThrow(/non-empty string/);
    expect(() => validateCwd("   ")).toThrow(/non-empty string/);
    expect(() => validateCwd(undefined as unknown as string)).toThrow(/non-empty string/);
  });

  it("rejects a path that does not exist", () => {
    const missing = join(TEST_DIR, "definitely-does-not-exist-xyz");
    expect(() => validateCwd(missing)).toThrow(/does not exist/);
  });

  it("rejects a path that is a file, not a directory", () => {
    expect(() => validateCwd(TEST_FILE)).toThrow(/not a directory/);
  });
});

// ---------------------------------------------------------------------------
// getDefaultShell / buildPtyEnv
// ---------------------------------------------------------------------------

describe("getDefaultShell", () => {
  const originalShell = process.env.SHELL;
  const originalComspec = process.env.COMSPEC;

  beforeEach(() => {
    process.env.SHELL = originalShell;
    process.env.COMSPEC = originalComspec;
  });

  it("prefers $SHELL on POSIX platforms", () => {
    if (process.platform === "win32") {
      // On win32 the function consults COMSPEC; nothing to assert about SHELL.
      expect(getDefaultShell()).toMatch(/cmd\.exe|powershell|pwsh/i);
      return;
    }
    process.env.SHELL = "/usr/bin/zsh";
    expect(getDefaultShell()).toBe("/usr/bin/zsh");
  });

  it("falls back to a sensible default when $SHELL/COMSPEC is missing", () => {
    if (process.platform === "win32") {
      delete process.env.COMSPEC;
      const shell = getDefaultShell();
      expect(shell.toLowerCase()).toContain("powershell");
    } else {
      delete process.env.SHELL;
      expect(getDefaultShell()).toBe("/bin/bash");
    }
  });
});

describe("buildPtyEnv", () => {
  it("inherits the current process env", () => {
    const env = buildPtyEnv();
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("sets a default TERM if missing", () => {
    const original = process.env.TERM;
    delete process.env.TERM;
    try {
      const env = buildPtyEnv();
      expect(env.TERM).toBe("xterm-256color");
    } finally {
      if (original !== undefined) process.env.TERM = original;
    }
  });

  it("provides a UTF-8 LANG default on Linux", () => {
    if (process.platform !== "linux") return; // platform-specific
    const original = process.env.LANG;
    delete process.env.LANG;
    try {
      const env = buildPtyEnv();
      expect(env.LANG).toBe("en_US.UTF-8");
      expect(env.LC_CTYPE).toBe("en_US.UTF-8");
    } finally {
      if (original !== undefined) process.env.LANG = original;
    }
  });
});

// ---------------------------------------------------------------------------
// TerminalService — using injected mock node-pty
// ---------------------------------------------------------------------------

describe("TerminalService.create", () => {
  it("spawns a PTY and returns metadata", () => {
    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });

    const info = svc.create({
      ownerClientId: "client-A",
      cwd: TEST_DIR,
      cols: 80,
      rows: 24,
      sessionId: "s1",
    });

    expect(instances).toHaveLength(1);
    expect(info.terminalId).toMatch(/^term-/);
    expect(info.cwd).toBe(TEST_DIR);
    expect(info.cols).toBe(80);
    expect(info.rows).toBe(24);
    expect(info.pid).toBe(instances[0].pid);
    expect(info.sessionId).toBe("s1");
    expect(svc.count()).toBe(1);
  });

  it("rejects an invalid cwd before touching the PTY module", () => {
    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    expect(() =>
      svc.create({
        ownerClientId: "client-A",
        cwd: join(TEST_DIR, "no-such-dir"),
        cols: 80,
        rows: 24,
      }),
    ).toThrow(/does not exist/);
    expect(instances).toHaveLength(0);
    expect(svc.count()).toBe(0);
  });

  it("rejects a cwd that is a file (not a directory)", () => {
    const { mod } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    expect(() =>
      svc.create({
        ownerClientId: "client-A",
        cwd: TEST_FILE,
        cols: 80,
        rows: 24,
      }),
    ).toThrow(/not a directory/);
  });

  it("clamps absurd cols/rows to safe bounds", () => {
    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    svc.create({
      ownerClientId: "client-A",
      cwd: TEST_DIR,
      cols: 999_999,
      rows: -5,
    });
    // Spawn should have received clamped values, not the originals.
    expect(instances[0].cols).toBeLessThanOrEqual(1000);
    expect(instances[0].rows).toBeGreaterThanOrEqual(1);
  });

  it("enforces per-client maximum", () => {
    const { mod } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod, maxPerClient: 2 });
    svc.create({ ownerClientId: "A", cwd: TEST_DIR, cols: 80, rows: 24 });
    svc.create({ ownerClientId: "A", cwd: TEST_DIR, cols: 80, rows: 24 });
    expect(() =>
      svc.create({ ownerClientId: "A", cwd: TEST_DIR, cols: 80, rows: 24 }),
    ).toThrow(/Per-client terminal limit/);
    // Different client is unaffected.
    expect(() =>
      svc.create({ ownerClientId: "B", cwd: TEST_DIR, cols: 80, rows: 24 }),
    ).not.toThrow();
  });

  it("enforces per-session maximum (per client)", () => {
    const { mod } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod, maxPerSession: 2 });
    svc.create({ ownerClientId: "A", cwd: TEST_DIR, cols: 80, rows: 24, sessionId: "s1" });
    svc.create({ ownerClientId: "A", cwd: TEST_DIR, cols: 80, rows: 24, sessionId: "s1" });
    expect(() =>
      svc.create({
        ownerClientId: "A",
        cwd: TEST_DIR,
        cols: 80,
        rows: 24,
        sessionId: "s1",
      }),
    ).toThrow(/Per-session terminal limit/);
    // Different session for same client should still succeed.
    expect(() =>
      svc.create({
        ownerClientId: "A",
        cwd: TEST_DIR,
        cols: 80,
        rows: 24,
        sessionId: "s2",
      }),
    ).not.toThrow();
  });

  it("uses the explicit profileId when provided (overrides default)", () => {
    vi.mocked(listTerminalProfiles).mockReturnValue({
      profiles: [],
      defaultProfileId: "default-profile",
    });
    vi.mocked(getTerminalProfile).mockImplementation((id) => {
      if (id === "git-bash") {
        return {
          id: "git-bash",
          name: "Git Bash",
          path: "/usr/bin/bash",
          args: ["--login", "-i"],
          env: { GIT_BASH: "1" },
        };
      }
      return null;
    });

    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    svc.create({
      ownerClientId: "A",
      cwd: TEST_DIR,
      cols: 80,
      rows: 24,
      profileId: "git-bash",
    });

    expect(instances).toHaveLength(1);
    expect(instances[0].spawnedShell).toBe("/usr/bin/bash");
    expect(instances[0].spawnedArgs).toEqual(["--login", "-i"]);
    expect(instances[0].spawnedEnv.GIT_BASH).toBe("1");
  });

  it("falls back to settings default profile when none explicitly requested", () => {
    vi.mocked(listTerminalProfiles).mockReturnValue({
      profiles: [],
      defaultProfileId: "fish",
    });
    vi.mocked(getTerminalProfile).mockImplementation((id) =>
      id === "fish"
        ? { id: "fish", name: "Fish", path: "/usr/bin/fish", args: ["-i"] }
        : null,
    );

    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    svc.create({ ownerClientId: "A", cwd: TEST_DIR, cols: 80, rows: 24 });

    expect(instances[0].spawnedShell).toBe("/usr/bin/fish");
    expect(instances[0].spawnedArgs).toEqual(["-i"]);
  });

  it("falls back to the platform default shell when no profile resolves", () => {
    vi.mocked(listTerminalProfiles).mockReturnValue({
      profiles: [],
      defaultProfileId: null,
    });
    vi.mocked(getTerminalProfile).mockReturnValue(null);

    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    svc.create({ ownerClientId: "A", cwd: TEST_DIR, cols: 80, rows: 24 });

    expect(instances[0].spawnedShell).toBe(getDefaultShell());
    expect(instances[0].spawnedArgs).toEqual([]);
  });
});

describe("TerminalService.write / resize", () => {
  it("forwards write payloads to the owner's PTY", () => {
    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    const info = svc.create({
      ownerClientId: "A",
      cwd: TEST_DIR,
      cols: 80,
      rows: 24,
    });
    svc.write(info.terminalId, "ls\r", "A");
    svc.write(info.terminalId, "echo hi\r", "A");
    expect(instances[0].writes).toEqual(["ls\r", "echo hi\r"]);
  });

  it("rejects writes from non-owners", () => {
    const { mod } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    const info = svc.create({
      ownerClientId: "A",
      cwd: TEST_DIR,
      cols: 80,
      rows: 24,
    });
    expect(() => svc.write(info.terminalId, "x", "B")).toThrow(/not owned/);
  });

  it("forwards resize and updates record", () => {
    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    const info = svc.create({
      ownerClientId: "A",
      cwd: TEST_DIR,
      cols: 80,
      rows: 24,
    });
    svc.resize(info.terminalId, 120, 40, "A");
    expect(instances[0].resizes).toEqual([{ cols: 120, rows: 40 }]);
    const listed = svc.list("A");
    expect(listed[0].cols).toBe(120);
    expect(listed[0].rows).toBe(40);
  });

  it("treats a no-op resize (same dims) as a no-op", () => {
    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    const info = svc.create({
      ownerClientId: "A",
      cwd: TEST_DIR,
      cols: 80,
      rows: 24,
    });
    svc.resize(info.terminalId, 80, 24, "A");
    expect(instances[0].resizes).toHaveLength(0);
  });

  it("swallows resize errors after PTY has exited", () => {
    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    const info = svc.create({
      ownerClientId: "A",
      cwd: TEST_DIR,
      cols: 80,
      rows: 24,
    });
    instances[0]._resizeShouldThrow = true;
    expect(() => svc.resize(info.terminalId, 100, 30, "A")).not.toThrow();
  });
});

describe("TerminalService events", () => {
  it("emits 'data' when the PTY produces output", () => {
    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    const info = svc.create({
      ownerClientId: "A",
      cwd: TEST_DIR,
      cols: 80,
      rows: 24,
    });
    const onData = vi.fn();
    svc.on("data", onData);
    instances[0]._emitData("hello\r\n");
    expect(onData).toHaveBeenCalledWith({
      terminalId: info.terminalId,
      ownerClientId: "A",
      data: "hello\r\n",
    });
  });

  it("emits 'exit' and removes the terminal when the PTY exits", () => {
    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    const info = svc.create({
      ownerClientId: "A",
      cwd: TEST_DIR,
      cols: 80,
      rows: 24,
    });
    expect(svc.count()).toBe(1);
    const onExit = vi.fn();
    svc.on("exit", onExit);
    instances[0]._emitExit(0);
    expect(onExit).toHaveBeenCalledWith({
      terminalId: info.terminalId,
      ownerClientId: "A",
      exitCode: 0,
      signal: undefined,
    });
    expect(svc.count()).toBe(0);
  });
});

describe("TerminalService.destroy / destroyByOwner / destroyAll", () => {
  it("destroys a single terminal and kills the PTY", () => {
    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    const info = svc.create({
      ownerClientId: "A",
      cwd: TEST_DIR,
      cols: 80,
      rows: 24,
    });
    svc.destroy(info.terminalId, "A");
    expect(instances[0].killed).toBe(true);
    expect(svc.count()).toBe(0);
  });

  it("rejects destroy from a non-owner", () => {
    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    const info = svc.create({
      ownerClientId: "A",
      cwd: TEST_DIR,
      cols: 80,
      rows: 24,
    });
    expect(() => svc.destroy(info.terminalId, "B")).toThrow(/not owned/);
    expect(instances[0].killed).toBe(false);
    expect(svc.count()).toBe(1);
  });

  it("treats destroy of an unknown id as a no-op", () => {
    const { mod } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    expect(() => svc.destroy("term-missing", "A")).not.toThrow();
  });

  it("destroyByOwner only kills terminals belonging to the given client", () => {
    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    svc.create({ ownerClientId: "A", cwd: TEST_DIR, cols: 80, rows: 24 });
    svc.create({ ownerClientId: "A", cwd: TEST_DIR, cols: 80, rows: 24 });
    svc.create({ ownerClientId: "B", cwd: TEST_DIR, cols: 80, rows: 24 });
    const destroyed = svc.destroyByOwner("A");
    expect(destroyed).toBe(2);
    expect(svc.count()).toBe(1);
    expect(instances[0].killed).toBe(true);
    expect(instances[1].killed).toBe(true);
    expect(instances[2].killed).toBe(false);
  });

  it("destroyAll kills every active terminal", () => {
    const { mod, instances } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    svc.create({ ownerClientId: "A", cwd: TEST_DIR, cols: 80, rows: 24 });
    svc.create({ ownerClientId: "B", cwd: TEST_DIR, cols: 80, rows: 24 });
    expect(svc.destroyAll()).toBe(2);
    expect(svc.count()).toBe(0);
    expect(instances.every((i) => i.killed)).toBe(true);
  });
});

describe("TerminalService.list", () => {
  it("returns only terminals owned by the requesting client", () => {
    const { mod } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    const a1 = svc.create({ ownerClientId: "A", cwd: TEST_DIR, cols: 80, rows: 24, sessionId: "s1" });
    svc.create({ ownerClientId: "B", cwd: TEST_DIR, cols: 80, rows: 24, sessionId: "s1" });
    const listA = svc.list("A");
    expect(listA).toHaveLength(1);
    expect(listA[0].terminalId).toBe(a1.terminalId);
  });

  it("filters by sessionId when given", () => {
    const { mod } = createMockPtyModule();
    const svc = new TerminalService({ ptyModule: mod });
    const a1 = svc.create({ ownerClientId: "A", cwd: TEST_DIR, cols: 80, rows: 24, sessionId: "s1" });
    svc.create({ ownerClientId: "A", cwd: TEST_DIR, cols: 80, rows: 24, sessionId: "s2" });
    const listed = svc.list("A", "s1");
    expect(listed).toHaveLength(1);
    expect(listed[0].terminalId).toBe(a1.terminalId);
  });
});
