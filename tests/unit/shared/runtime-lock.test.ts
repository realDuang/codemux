import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireRuntimeLock,
  type RuntimeLock,
  type RuntimeLockOptions,
} from "../../../shared/runtime-lock";

let directory: string;
let leases: RuntimeLock[];
let children: ChildProcess[];

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "codemux-runtime-lock-"));
  leases = [];
  children = [];
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
  await Promise.allSettled(leases.map((lease) => lease.release()));
  vi.useRealTimers();
  await fs.rm(directory, { recursive: true, force: true });
});

async function acquire(dataPath: string, options?: RuntimeLockOptions): Promise<RuntimeLock> {
  const lease = await acquireRuntimeLock(dataPath, options);
  leases.push(lease);
  return lease;
}

describe("acquireRuntimeLock", () => {
  it("creates a missing data directory and returns its canonical path", async () => {
    const dataPath = path.join(directory, "missing", "data");

    const lease = await acquire(dataPath);

    expect(lease.dataPath).toBe(await fs.realpath(dataPath));
    expect(await fs.readdir(dataPath)).toEqual([]);
    expect((await fs.stat(`${lease.dataPath}.lock`)).isDirectory()).toBe(true);
  });

  it("allows exactly one concurrent owner without deleting its lock or changing saved data", async () => {
    const dataPath = path.join(directory, "data");
    await fs.mkdir(dataPath);
    const saved = '{"deviceId":"existing","secret":"unchanged-test-value"}\n';
    await fs.writeFile(path.join(dataPath, "devices.json"), saved);

    const results = await Promise.allSettled([acquire(dataPath), acquire(dataPath)]);
    const owners = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(owners).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      code: "ELOCKED",
      message: expect.stringContaining(await fs.realpath(dataPath)),
      cause: expect.objectContaining({ code: "ELOCKED" }),
    });
    const lockStat = await fs.stat(`${await fs.realpath(dataPath)}.lock`);
    await expect(acquire(dataPath)).rejects.toMatchObject({ code: "ELOCKED" });
    expect((await fs.stat(`${await fs.realpath(dataPath)}.lock`)).ino).toBe(lockStat.ino);
    expect(await fs.readdir(dataPath)).toEqual(["devices.json"]);
    expect(await fs.readFile(path.join(dataPath, "devices.json"), "utf-8")).toBe(saved);
  });

  it("treats a symlink alias as the same data directory", async () => {
    const dataPath = path.join(directory, "data");
    const aliasPath = path.join(directory, "alias");
    const first = await acquire(dataPath);
    await fs.symlink(dataPath, aliasPath, "junction");

    await expect(acquire(aliasPath)).rejects.toMatchObject({ code: "ELOCKED" });
    await first.release();
    const second = await acquire(aliasPath);

    expect(second.dataPath).toBe(first.dataPath);
    await expect(acquire(dataPath)).rejects.toMatchObject({ code: "ELOCKED" });
  });

  it("allows independent data directories to run concurrently", async () => {
    const [first, second] = await Promise.all([
      acquire(path.join(directory, "first")),
      acquire(path.join(directory, "second")),
    ]);

    expect(first.dataPath).not.toBe(second.dataPath);
    expect((await fs.stat(`${first.dataPath}.lock`)).isDirectory()).toBe(true);
    expect((await fs.stat(`${second.dataPath}.lock`)).isDirectory()).toBe(true);
  });

  it("rejects a data path that is a file without modifying it", async () => {
    const dataPath = path.join(directory, "data");
    await fs.writeFile(dataPath, "preserved");

    await expect(acquire(dataPath)).rejects.toMatchObject({ code: "EEXIST" });

    expect(await fs.readFile(dataPath, "utf-8")).toBe("preserved");
    await expect(fs.stat(`${dataPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects another process's live lock and acquires it after that process releases it", async () => {
    const dataPath = path.join(directory, "data");
    await fs.mkdir(dataPath);
    const require = createRequire(import.meta.url);
    const child = spawn(process.execPath, ["-e", `
      const { lock } = require(process.argv[1]);
      lock(process.argv[2], { stale: 30000, update: 10000, retries: 0 })
        .then((release) => {
          process.on("message", async () => {
            await release();
            process.send("released", () => process.disconnect());
          });
          process.send("ready");
        })
        .catch((error) => {
          process.send({ error: error.message }, () => process.disconnect());
          process.exitCode = 1;
        });
    `, require.resolve("proper-lockfile"), dataPath], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(5_000) });
    expect(ready).toBe("ready");

    await expect(acquire(dataPath)).rejects.toMatchObject({ code: "ELOCKED" });
    const released = once(child, "message", { signal: AbortSignal.timeout(5_000) });
    child.send("release");
    expect((await released)[0]).toBe("released");

    expect((await acquire(dataPath)).dataPath).toBe(await fs.realpath(dataPath));
  });

  it("notifies the host when a lock is compromised and leaves a subsequent owner's lock intact", async () => {
    vi.useFakeTimers();
    let reportCompromise!: (error: Error) => void;
    const compromised = new Promise<Error>((resolve) => { reportCompromise = resolve; });
    const first = await acquire(path.join(directory, "data"), { onCompromised: reportCompromise });
    await fs.rmdir(`${first.dataPath}.lock`);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(await compromised).toMatchObject({ code: "ECOMPROMISED" });
    const second = await acquire(first.dataPath);
    await expect(first.release()).rejects.toMatchObject({ code: "ERELEASED" });
    await expect(acquire(second.dataPath)).rejects.toMatchObject({ code: "ELOCKED" });
  });
});

describe("RuntimeLock.release", () => {
  it("releases once and never unlocks a subsequent owner when called again", async () => {
    const first = await acquire(path.join(directory, "data"));
    const releasePromise = first.release();

    expect(first.release()).toBe(releasePromise);
    await releasePromise;
    await expect(fs.stat(`${first.dataPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    const second = await acquire(first.dataPath);
    await first.release();

    await expect(acquire(second.dataPath)).rejects.toMatchObject({ code: "ELOCKED" });
  });
});
