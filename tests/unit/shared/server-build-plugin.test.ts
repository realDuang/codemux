import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RollupWatcher } from "rollup";
import { build, type InlineConfig } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerBuildPlugin } from "../../../scripts/server-build-plugin";

const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "codemux-server-build-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const aliasDirectory = await mkdtemp(join(tmpdir(), "codemux-server-build-alias-"));
  cleanup.push(() => rm(aliasDirectory, { recursive: true, force: true }));
  const alias = join(aliasDirectory, "worktree");
  await symlink(await realpath(root), alias, "junction");
  await Promise.all(["server", "node_modules", "out/server"].map(directory => mkdir(join(root, directory), { recursive: true })));
  await mkdir(join(aliasDirectory, "outside"));
  await symlink(join(aliasDirectory, "outside"), join(root, "server/external"), "junction");
  await Promise.all([
    writeFile(join(root, "package.json"), '{"type":"module"}'),
    writeFile(join(root, "bun.lock"), "fixture"),
    writeFile(join(root, "main.ts"), 'export const desktop = "fixture";'),
    writeFile(join(root, "server/index.ts"), 'export async function readLazy() { return (await import("./lazy")).value; }'),
    writeFile(join(root, "server/lazy.ts"), 'export const value = "initial";'),
    writeFile(join(root, "server/graph-only.ts"), 'export const value = "watched";'),
    writeFile(join(aliasDirectory, "outside/ignored.ts"), "export {};"),
    writeFile(join(root, "node_modules/ignored.ts"), "export {};"),
    writeFile(join(root, "out/ignored.ts"), "export {};"),
    writeFile(join(root, "out/server/retired.mjs"), "export {};"),
    writeFile(join(root, "vite.server.config.ts"), `export default {
      plugins: [{
        name: "fixture-module-graph",
        generateBundle() {
          this.emitFile({
            type: "asset", fileName: "module-graph.json",
            source: JSON.stringify([
              ...this.getModuleIds(), "\\0virtual:fixture", "node_modules/ignored.ts",
              "out/ignored.ts", "../outside.ts", "missing.ts", "server",
              ${JSON.stringify(join(alias, "server/graph-only.ts"))},
              ${JSON.stringify(join(root, "server/external/ignored.ts"))}
            ])
          });
        }
      }],
      build: {
        ssr: true, target: "node24", minify: false, outDir: "out/server",
        rollupOptions: {
          input: ${JSON.stringify(join(root, "server/index.ts"))},
          output: { format: "es", entryFileNames: "[name].mjs", chunkFileNames: "[name]-[hash].mjs" }
        }
      }
    };`),
  ]);
  let writes = 0;
  let watchFiles: string[] = [];
  const config: InlineConfig = {
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      createServerBuildPlugin(alias),
      {
        name: "observe-main-build",
        buildEnd() { watchFiles = this.getWatchFiles(); },
        writeBundle() { writes += 1; },
      },
    ],
    build: {
      ssr: true,
      outDir: join(root, "out/main"),
      rollupOptions: { input: join(root, "main.ts"), output: { entryFileNames: "[name].mjs" } },
    },
  };
  return { root, alias, config, getWrites: () => writes, getWatchFiles: () => watchFiles };
}

describe("createServerBuildPlugin", () => {
  it("builds in the supplied worktree, cleans normal output, and watches only repository files", async () => {
    const fixture = await createFixture();
    await build(fixture.config);

    expect(fixture.getWrites()).toBe(1);
    expect(await readdir(join(fixture.root, "out/server"))).not.toContain("retired.mjs");
    expect(await readFile(join(fixture.root, "out/server/index.mjs"), "utf8")).toContain("readLazy");
    const canonicalRoot = await realpath(fixture.root);
    // Vite and Rollup can retain different separators and Windows 8.3 aliases.
    const watchedFiles = await Promise.all(fixture.getWatchFiles().map(file => realpath(file)));
    expect(watchedFiles).toEqual(expect.arrayContaining([
      "main.ts", "server/index.ts", "server/lazy.ts", "server/graph-only.ts", "vite.server.config.ts", "package.json", "bun.lock",
    ].map(file => join(canonicalRoot, file))));
    for (const excluded of ["node_modules/ignored.ts", "out/ignored.ts", "server/external/ignored.ts"]) {
      expect(watchedFiles).not.toContain(await realpath(join(fixture.root, excluded)));
    }
    expect(fixture.getWatchFiles().every(file => !file.includes("\0"))).toBe(true);
  });

  it("rebuilds graph dependencies reported through a worktree alias", async () => {
    const fixture = await createFixture();
    const watcher = await build({ ...fixture.config, build: { ...fixture.config.build, watch: { buildDelay: 10 } } }) as RollupWatcher;
    cleanup.push(() => watcher.close());
    await vi.waitFor(() => expect(fixture.getWrites()).toBe(1), { timeout: 5_000 });
    await writeFile(join(fixture.alias, "server/graph-only.ts"), 'export const value = "updated";');
    await vi.waitFor(() => expect(fixture.getWrites()).toBe(2), { timeout: 5_000 });
  }, 15_000);

  it("rebuilds backend-only edits, preserves old lazy chunks, and recovers from failed builds", async () => {
    const fixture = await createFixture();
    const lazySource = join(fixture.alias, "server/lazy.ts");
    await writeFile(lazySource, "export const value = ;");
    const watcher = await build({ ...fixture.config, build: { ...fixture.config.build, watch: { buildDelay: 10 } } }) as RollupWatcher;
    cleanup.push(() => watcher.close());
    const errors: unknown[] = [];
    watcher.on("event", event => {
      if (event.code === "ERROR") errors.push(event.error);
    });

    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 5_000 });
    expect(fixture.getWrites()).toBe(0);
    expect(await readdir(join(fixture.root, "out/server"))).toEqual(["retired.mjs"]);

    await writeFile(lazySource, 'export const value = "initial";');
    await vi.waitFor(() => expect(fixture.getWrites()).toBe(1), { timeout: 5_000 });
    const serverEntry = pathToFileURL(join(fixture.root, "out/server/index.mjs")).href;
    const oldRuntime = await import(`${serverEntry}?initial`) as { readLazy(): Promise<string> };
    const oldFiles = await readdir(join(fixture.root, "out/server"));

    await writeFile(lazySource, 'export const value = "updated";');
    await vi.waitFor(() => expect(fixture.getWrites()).toBe(2), { timeout: 5_000 });
    const updatedRuntime = await import(`${serverEntry}?updated`) as { readLazy(): Promise<string> };
    expect(await updatedRuntime.readLazy()).toBe("updated");
    expect(await oldRuntime.readLazy()).toBe("initial");
    expect(await readdir(join(fixture.root, "out/server"))).toEqual(expect.arrayContaining(oldFiles));

    const lastGoodEntry = await readFile(join(fixture.root, "out/server/index.mjs"), "utf8");
    const lastGoodFiles = await readdir(join(fixture.root, "out/server"));
    await writeFile(lazySource, "export const value = ;");
    await vi.waitFor(() => expect(errors).toHaveLength(2), { timeout: 5_000 });
    expect(fixture.getWrites()).toBe(2);
    expect(await readFile(join(fixture.root, "out/server/index.mjs"), "utf8")).toBe(lastGoodEntry);
    expect(await readdir(join(fixture.root, "out/server"))).toEqual(lastGoodFiles);

    await writeFile(lazySource, 'export const value = "recovered";');
    await vi.waitFor(() => expect(fixture.getWrites()).toBe(3), { timeout: 5_000 });
    const recoveredRuntime = await import(`${serverEntry}?recovered`) as { readLazy(): Promise<string> };
    expect(await recoveredRuntime.readLazy()).toBe("recovered");
  }, 30_000);
});
