import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// We mock `fs` and `child_process` at module level so the profile detection
// logic can be exercised on any platform without depending on the host's
// actual shell layout. `loadSettings` from logger.ts is mocked too because
// it touches Electron's userData path which doesn't exist in vitest (node).

vi.mock("fs", () => {
  const mockEntries = new Map<string, { isFile: boolean; isDirectory: boolean }>();
  const mockReaddir = new Map<string, Array<{ name: string; isDirectory: () => boolean }>>();
  const mockReadFile = new Map<string, string>();
  return {
    default: {
      statSync: (p: string) => {
        const entry = mockEntries.get(p);
        if (!entry) throw new Error(`ENOENT: ${p}`);
        return {
          isFile: () => entry.isFile,
          isDirectory: () => entry.isDirectory,
        };
      },
      readdirSync: (p: string) => {
        const list = mockReaddir.get(p);
        if (!list) throw new Error(`ENOENT: ${p}`);
        return list;
      },
      readFileSync: (p: string) => {
        const v = mockReadFile.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
    },
    statSync: (p: string) => {
      const entry = mockEntries.get(p);
      if (!entry) throw new Error(`ENOENT: ${p}`);
      return {
        isFile: () => entry.isFile,
        isDirectory: () => entry.isDirectory,
      };
    },
    readdirSync: (p: string, _opts?: unknown) => {
      const list = mockReaddir.get(p);
      if (!list) throw new Error(`ENOENT: ${p}`);
      return list;
    },
    readFileSync: (p: string) => {
      const v = mockReadFile.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    __mockEntries: mockEntries,
    __mockReaddir: mockReaddir,
    __mockReadFile: mockReadFile,
  };
});

vi.mock("child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));

// Force the `path` module to use Windows-style joins when
// `process.platform === "win32"` is set in a test, regardless of the host
// OS. Without this, `path.join("C:\\Windows", "System32")` returns
// `"C:\\Windows/System32"` on Linux/macOS CI runners and breaks the
// exact-string lookups in `mockFs`.
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("path")>();
  const pick = () =>
    process.platform === "win32" ? actual.win32 : actual.posix;
  return {
    ...actual,
    join: (...args: string[]) => pick().join(...args),
    basename: (p: string, ext?: string) => pick().basename(p, ext),
    resolve: (...args: string[]) => pick().resolve(...args),
    normalize: (p: string) => pick().normalize(p),
    dirname: (p: string) => pick().dirname(p),
    extname: (p: string) => pick().extname(p),
    isAbsolute: (p: string) => pick().isAbsolute(p),
    relative: (from: string, to: string) => pick().relative(from, to),
    get sep() {
      return pick().sep;
    },
  };
});

vi.mock("../../../../electron/main/services/logger", () => ({
  loadSettings: vi.fn(() => ({})),
}));

import * as fs from "fs";
import { execFileSync } from "child_process";
import { loadSettings } from "../../../../electron/main/services/logger";
import {
  listTerminalProfiles,
  getTerminalProfile,
  _resetTerminalProfileCache,
} from "../../../../electron/main/services/terminal-profiles";

const mockFs = fs as unknown as {
  __mockEntries: Map<string, { isFile: boolean; isDirectory: boolean }>;
  __mockReaddir: Map<string, Array<{ name: string; isDirectory: () => boolean }>>;
  __mockReadFile: Map<string, string>;
};

function addFile(path: string) {
  mockFs.__mockEntries.set(path, { isFile: true, isDirectory: false });
}
function addDir(path: string, entries: string[] = []) {
  mockFs.__mockEntries.set(path, { isFile: false, isDirectory: true });
  mockFs.__mockReaddir.set(
    path,
    entries.map((name) => ({ name, isDirectory: () => true })),
  );
}

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_ENV = { ...process.env };

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  mockFs.__mockEntries.clear();
  mockFs.__mockReaddir.clear();
  mockFs.__mockReadFile.clear();
  vi.mocked(loadSettings).mockReturnValue({});
  vi.mocked(execFileSync).mockReturnValue("");
  _resetTerminalProfileCache();
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  process.env = { ...ORIGINAL_ENV };
});

describe("listTerminalProfiles (Windows)", () => {
  beforeEach(() => {
    setPlatform("win32");
    process.env = {
      SystemRoot: "C:\\Windows",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    };
  });

  it("detects Windows PowerShell when present in System32", () => {
    addFile("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    const { profiles } = listTerminalProfiles();
    expect(profiles.find((p) => p.id === "powershell")).toBeDefined();
  });

  it("detects pwsh.exe under Program Files\\PowerShell\\<n>\\", () => {
    addDir("C:\\Program Files\\PowerShell", ["7", "8-preview"]);
    addFile("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    addFile("C:\\Program Files\\PowerShell\\8-preview\\pwsh.exe");
    const { profiles } = listTerminalProfiles();
    expect(profiles.find((p) => p.id === "pwsh-7")).toBeDefined();
    expect(profiles.find((p) => p.id === "pwsh-8-preview")).toBeDefined();
  });

  it("detects cmd.exe via ComSpec", () => {
    addFile("C:\\Windows\\System32\\cmd.exe");
    const { profiles } = listTerminalProfiles();
    expect(profiles.find((p) => p.id === "cmd")).toBeDefined();
  });

  it("detects Git Bash from Program Files\\Git\\bin\\bash.exe", () => {
    addFile("C:\\Program Files\\Git\\bin\\bash.exe");
    const { profiles } = listTerminalProfiles();
    const gitBash = profiles.find((p) => p.id === "git-bash");
    expect(gitBash).toBeDefined();
    expect(gitBash?.args).toEqual(["--login", "-i"]);
  });

  it("detects WSL distros from `wsl -l -q` output", () => {
    addFile("C:\\Windows\\System32\\wsl.exe");
    // wsl -l -q outputs UTF-16-LE; we feed already-decoded string.
    vi.mocked(execFileSync).mockReturnValue("Ubuntu\nDebian\n");
    const { profiles } = listTerminalProfiles();
    expect(profiles.find((p) => p.id === "wsl-ubuntu")?.args).toEqual(["-d", "Ubuntu"]);
    expect(profiles.find((p) => p.id === "wsl-debian")?.args).toEqual(["-d", "Debian"]);
  });

  it("survives a wsl.exe spawn failure", () => {
    addFile("C:\\Windows\\System32\\wsl.exe");
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("spawn ETIMEDOUT");
    });
    addFile("C:\\Windows\\System32\\cmd.exe");
    const { profiles } = listTerminalProfiles();
    // No WSL profiles, but cmd still appears.
    expect(profiles.find((p) => p.id?.startsWith("wsl-"))).toBeUndefined();
    expect(profiles.find((p) => p.id === "cmd")).toBeDefined();
  });

  it("picks pwsh as default over Windows PowerShell", () => {
    addFile("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    addDir("C:\\Program Files\\PowerShell", ["7"]);
    addFile("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    const { defaultProfileId } = listTerminalProfiles();
    expect(defaultProfileId).toBe("pwsh-7");
  });
});

describe("listTerminalProfiles (Unix)", () => {
  beforeEach(() => {
    setPlatform("linux");
    process.env = { SHELL: "/bin/zsh" };
  });

  it("returns shells from /etc/shells filtered to existing executables", () => {
    mockFs.__mockReadFile.set("/etc/shells", "# header\n/bin/bash\n/bin/zsh\n/usr/bin/fish\n");
    addFile("/bin/bash");
    addFile("/bin/zsh");
    // /usr/bin/fish intentionally NOT added — should be filtered out.
    const { profiles } = listTerminalProfiles();
    expect(profiles.map((p) => p.path)).toContain("/bin/bash");
    expect(profiles.map((p) => p.path)).toContain("/bin/zsh");
    expect(profiles.map((p) => p.path)).not.toContain("/usr/bin/fish");
  });

  it("falls back to common defaults when /etc/shells is absent", () => {
    addFile("/bin/bash");
    addFile("/bin/sh");
    // No /etc/shells file mocked.
    const { profiles } = listTerminalProfiles();
    expect(profiles.find((p) => p.path === "/bin/bash")).toBeDefined();
    expect(profiles.find((p) => p.path === "/bin/sh")).toBeDefined();
  });

  it("picks $SHELL as the default profile", () => {
    addFile("/bin/zsh");
    addFile("/bin/bash");
    mockFs.__mockReadFile.set("/etc/shells", "/bin/bash\n/bin/zsh\n");
    const { profiles, defaultProfileId } = listTerminalProfiles();
    const zsh = profiles.find((p) => p.path === "/bin/zsh");
    expect(defaultProfileId).toBe(zsh?.id);
  });
});

describe("custom profiles & defaultProfile setting", () => {
  beforeEach(() => {
    setPlatform("linux");
    process.env = { SHELL: "/bin/bash" };
    addFile("/bin/bash");
  });

  it("appends user-defined custom profiles from settings", () => {
    vi.mocked(loadSettings).mockReturnValue({
      terminal: {
        customProfiles: [
          { id: "fish", name: "Fish", path: "/usr/bin/fish", args: ["-i"] },
        ],
      },
    });
    const { profiles } = listTerminalProfiles();
    const fish = profiles.find((p) => p.id === "fish");
    expect(fish).toBeDefined();
    expect(fish?.custom).toBe(true);
    expect(fish?.args).toEqual(["-i"]);
  });

  it("respects user-set defaultProfile when it matches a known profile", () => {
    vi.mocked(loadSettings).mockReturnValue({
      terminal: {
        defaultProfile: "bash",
        customProfiles: [],
      },
    });
    mockFs.__mockReadFile.set("/etc/shells", "/bin/bash\n");
    const { defaultProfileId } = listTerminalProfiles();
    expect(defaultProfileId).toBe("bash");
  });

  it("ignores defaultProfile that points at an unknown id", () => {
    vi.mocked(loadSettings).mockReturnValue({
      terminal: { defaultProfile: "ghost-shell" },
    });
    mockFs.__mockReadFile.set("/etc/shells", "/bin/bash\n");
    const { defaultProfileId } = listTerminalProfiles();
    // Falls back to the heuristic (shell -> first match).
    expect(defaultProfileId).not.toBe("ghost-shell");
  });
});

describe("caching", () => {
  beforeEach(() => {
    setPlatform("linux");
    process.env = { SHELL: "/bin/bash" };
    addFile("/bin/bash");
  });

  it("caches detection results within TTL", () => {
    listTerminalProfiles();
    // Mutate state that would change detection — won't be picked up due to cache.
    process.env = { SHELL: "/bin/zsh" };
    addFile("/bin/zsh");
    const second = listTerminalProfiles();
    expect(second.profiles.some((p) => p.path === "/bin/zsh")).toBe(false);
  });

  it("refresh: true bypasses the cache", () => {
    listTerminalProfiles();
    process.env = { SHELL: "/bin/zsh" };
    addFile("/bin/zsh");
    const refreshed = listTerminalProfiles({ refresh: true });
    expect(refreshed.profiles.some((p) => p.path === "/bin/zsh")).toBe(true);
  });

  it("custom profiles are re-read on every call (settings.json may change)", () => {
    vi.mocked(loadSettings).mockReturnValue({});
    listTerminalProfiles();
    // Now add a custom profile mid-flight and call again — should appear
    // without needing refresh: true.
    vi.mocked(loadSettings).mockReturnValue({
      terminal: { customProfiles: [{ id: "custom1", name: "Custom", path: "/usr/local/bin/x" }] },
    });
    const { profiles } = listTerminalProfiles();
    expect(profiles.find((p) => p.id === "custom1")).toBeDefined();
  });
});

describe("getTerminalProfile", () => {
  beforeEach(() => {
    setPlatform("linux");
    process.env = { SHELL: "/bin/bash" };
    addFile("/bin/bash");
  });

  it("returns the profile object for a known id", () => {
    const profile = getTerminalProfile("bash");
    expect(profile).toBeDefined();
    expect(profile?.path).toBe("/bin/bash");
  });

  it("returns null for unknown ids", () => {
    expect(getTerminalProfile("nonsense")).toBeNull();
  });

  it("returns null for empty/null id input", () => {
    expect(getTerminalProfile(undefined)).toBeNull();
    expect(getTerminalProfile(null)).toBeNull();
    expect(getTerminalProfile("")).toBeNull();
  });
});
