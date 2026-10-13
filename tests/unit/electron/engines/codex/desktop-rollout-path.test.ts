import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyCodexRolloutPath } from "../../../../../electron/main/engines/codex/desktop-rollout-path";

vi.mock("node:fs/promises", { spy: true });

const THREAD_ID = "01a13451-7e88-76d3-962e-b8a2379394e4";
const OTHER_ID = "01a13451-7e88-76d3-962e-b8a2379394e5";
const FILENAME = `rollout-2026-10-13T12-34-56-${THREAD_ID}.jsonl`;
let directory: string;
let home: string;

async function file(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
  return path;
}

function activePath(root = home, filename = FILENAME): string {
  return join(root, "sessions", "2026", "10", "13", filename);
}

function verify(path: unknown, id: unknown = THREAD_ID, root = home) {
  return verifyCodexRolloutPath(THREAD_ID, { id, path }, root);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "codemux-rollout-path-test-"));
  home = join(directory, "codex-home");
  await mkdir(home);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("verifyCodexRolloutPath", () => {
  it("recognizes active and archived regular files using metadata only", async () => {
    const active = await file(activePath());
    const archived = await file(join(home, "archived_sessions", FILENAME));
    expect(await verify(active)).toBe("active");
    expect(await verify(archived)).toBe("archived");
  });

  it("uses the configured CODEX_HOME by default", async () => {
    const path = await file(activePath());
    vi.stubEnv("CODEX_HOME", home);
    expect(await verifyCodexRolloutPath(THREAD_ID, { id: THREAD_ID, path })).toBe("active");
  });

  it("canonicalizes both the configured home alias and native metadata path", async () => {
    const path = await file(activePath());
    const alias = join(directory, "home-alias");
    await symlink(home, alias, "dir");
    const canonical = await realpath(path);
    expect(await verify(canonical, THREAD_ID, alias)).toBe("active");
    expect(await verify(activePath(alias), THREAD_ID, home)).toBe("active");
  });

  it("rejects a foreign home including a sibling with the same path prefix", async () => {
    const path = await file(activePath(`${home}-foreign`));
    expect(await verify(path)).toBeUndefined();
  });

  it.each([undefined, null, 123, OTHER_ID, THREAD_ID.toUpperCase()])("rejects mismatched metadata id %s", async (id) => {
    const path = await file(activePath());
    expect(await verifyCodexRolloutPath(THREAD_ID, { id, path }, home)).toBeUndefined();
  });

  it.each([
    "thread-1", THREAD_ID.replaceAll("-", ""), `${THREAD_ID}\n`, THREAD_ID.toUpperCase(),
    "01a13451-7e88-06d3-962e-b8a2379394e4", "01a13451-7e88-76d3-762e-b8a2379394e4",
  ])("rejects a noncanonical UUID %s", async (id) => {
    expect(await verifyCodexRolloutPath(id, { id, path: activePath() }, home)).toBeUndefined();
  });

  it.each([undefined, null, 123, "", "sessions/file.jsonl", "file:///tmp/file.jsonl"])(
    "rejects malformed or relative metadata path %s", async (path) => {
      expect(await verify(path)).toBeUndefined();
    },
  );

  it("rejects raw traversal, redundant segments, and control characters before resolution", async () => {
    const path = await file(activePath());
    const prefix = dirname(path);
    for (const invalid of [
      `${prefix}${sep}..${sep}13${sep}${FILENAME}`,
      `${prefix}${sep}.${sep}${FILENAME}`,
      `${prefix}${sep}${sep}${FILENAME}`,
      `${path}\0`, `${path}\n`, `${path}${sep}`,
    ]) expect(await verify(invalid)).toBeUndefined();
  });

  it.each([
    FILENAME.replace(THREAD_ID, OTHER_ID), FILENAME.replace(".jsonl", ".json"),
    FILENAME.replace("rollout-", "session-"), FILENAME.replace("T12-34-56", "T12:34:56"),
    FILENAME.replace("2026-10-13", "2026-02-30"), FILENAME.replace("2026-10-13", "2025-02-29"),
    FILENAME.replace("2026-10-13", "1900-02-29"),
    FILENAME.replace("2026-10-13", "0000-10-13"), FILENAME.replace("2026-10-13", "2026-13-13"),
    FILENAME.replace("T12-34-56", "T24-00-00"), FILENAME.replace("T12-34-56", "T12-60-00"),
    FILENAME.replace("T12-34-56", "T12-34-60"),
  ])("rejects an invalid rollout filename %s", async (filename) => {
    // Invalid names must be rejected before filesystem access, including names
    // that Windows itself cannot create (for example, a colon in the time).
    vi.mocked(filesystem.realpath).mockClear();
    expect(await verify(join(home, "archived_sessions", filename))).toBeUndefined();
    expect(filesystem.realpath).not.toHaveBeenCalled();
  });

  it("recognizes leap-day timestamps and rejects inconsistent active directory dates", async () => {
    const filename = FILENAME.replace("2026-10-13", "2024-02-29");
    const path = await file(join(home, "sessions", "2024", "02", "29", filename));
    expect(await verify(path)).toBe("active");
    expect(await verify(await file(activePath(home, filename)))).toBeUndefined();
    expect(await verify(await file(join(home, "sessions", "2024", "2", "29", filename)))).toBeUndefined();
    expect(await verify(await file(join(home, "archived_sessions", FILENAME.replace("2026-10-13", "2000-02-29"))))).toBe("archived");
  });

  it.each([
    ["sessions"], ["sessions", "2026", "10"], ["sessions", "2026", "10", "13", "extra"],
    ["archived_sessions", "2026", "10", "13"], ["other", "2026", "10", "13"], [],
  ])("rejects unsupported storage layouts %j", async (...parts) => {
    expect(await verify(await file(join(home, ...parts, FILENAME)))).toBeUndefined();
  });

  it("fails closed for missing homes, missing files, directories, and non-directory parents", async () => {
    expect(await verify(activePath())).toBeUndefined();
    expect(await verify(activePath(), THREAD_ID, join(directory, "missing-home"))).toBeUndefined();
    await mkdir(activePath(), { recursive: true });
    expect(await verify(activePath())).toBeUndefined();
    const parent = await file(join(home, "archived_sessions"));
    expect(await verify(join(parent, FILENAME))).toBeUndefined();
  });

  it("rejects a file symlink escaping the home even when its target has the expected name", async () => {
    const target = await file(activePath(join(directory, "foreign-home")));
    const link = activePath();
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link, "file");
    expect(await verify(link)).toBeUndefined();
  });

  it("rejects a directory symlink escaping the home", async () => {
    const foreign = join(directory, "foreign-home");
    await file(activePath(foreign));
    await symlink(join(foreign, "sessions"), join(home, "sessions"), "dir");
    expect(await verify(activePath())).toBeUndefined();
  });

  it("rejects in-home symlinks to a foreign UUID or unsupported canonical layout", async () => {
    const target = await file(activePath(home, FILENAME.replace(THREAD_ID, OTHER_ID)));
    await symlink(target, activePath(), "file");
    expect(await verify(activePath())).toBeUndefined();
    const otherTarget = await file(join(home, "other", FILENAME));
    const archived = join(home, "archived_sessions", FILENAME);
    await mkdir(dirname(archived));
    await symlink(otherTarget, archived, "file");
    expect(await verify(archived)).toBeUndefined();
  });

  it("rejects a canonical filename with a trailing newline reached through a clean symlink", async () => {
    if (process.platform === "win32") {
      // NTFS rejects control characters in filenames; simulate the canonical
      // resolution to exercise the same validation without an impossible file.
      const canonicalHome = await realpath(home);
      vi.mocked(filesystem.realpath).mockResolvedValueOnce(canonicalHome)
        .mockResolvedValueOnce(`${activePath()}\n`);
      expect(await verify(activePath())).toBeUndefined();
      return;
    }
    const target = await file(`${activePath()}\n`);
    await symlink(target, activePath(), "file");
    expect(await verify(activePath())).toBeUndefined();
  });

  it("fails closed for dangling and circular symlinks", async () => {
    const path = activePath();
    await mkdir(dirname(path), { recursive: true });
    await symlink(join(directory, "missing"), path, "file");
    expect(await verify(path)).toBeUndefined();
    await rm(path);
    await symlink(relative(dirname(path), path), path, "file");
    expect(await verify(path)).toBeUndefined();
  });

  it.each(["realpath", "lstat"] as const)("propagates %s permission errors instead of treating them as missing storage", async (operation) => {
    const path = await file(activePath());
    const error = Object.assign(new Error("Access denied"), { code: "EACCES" });
    vi.mocked(filesystem[operation]).mockRejectedValueOnce(error);
    await expect(verify(path)).rejects.toBe(error);
  });
});
