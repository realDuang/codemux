import { readFile, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { build, type Plugin } from "vite";

async function collectWatchFiles(root: string, ids: readonly string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const id of ids) {
    if (id.includes("\0")) continue;
    const file = resolve(root, id);
    const local = relative(root, file);
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) continue;
    if (local.split(sep).some(part => part === "node_modules" || part === "out")) continue;
    if (await stat(file).then(info => info.isFile(), () => false)) files.add(file);
  }
  return [...files];
}

/** Build the owned Node server as part of electron-vite's main build. */
export function createServerBuildPlugin(repositoryRoot: string): Plugin {
  const root = realpathSync(resolve(repositoryRoot));
  const configFile = resolve(root, "vite.server.config.ts");
  const outDir = resolve(root, "out/server");
  const buildInputs = [configFile, resolve(root, "package.json"), resolve(root, "bun.lock")];
  let sourceFiles: string[] = [];
  let mode = "production";

  return {
    name: "codemux-server-build",
    configResolved(config) {
      mode = config.mode;
    },
    async buildStart() {
      for (const file of await collectWatchFiles(root, [...buildInputs, ...sourceFiles])) {
        this.addWatchFile(file);
      }
      try {
        await build({
          root,
          configFile,
          mode,
          logLevel: "warn",
          clearScreen: false,
          build: {
            outDir,
            watch: null,
            // The old child can still lazily import its chunks until Electron restarts.
            emptyOutDir: !this.meta.watchMode,
          },
        });
      } catch (error) {
        // A first build can fail before a module graph exists; still watch its sources.
        if (error && typeof error === "object" && "watchFiles" in error && Array.isArray(error.watchFiles)) {
          const files = error.watchFiles.filter((file): file is string => typeof file === "string");
          for (const file of await collectWatchFiles(root, files)) this.addWatchFile(file);
        }
        throw error;
      }
      const modules: unknown = JSON.parse(await readFile(resolve(outDir, "module-graph.json"), "utf8"));
      if (!Array.isArray(modules) || !modules.every((id): id is string => typeof id === "string")) {
        throw new Error("The server build did not emit a valid module graph.");
      }
      sourceFiles = await collectWatchFiles(root, modules);
      for (const file of sourceFiles) this.addWatchFile(file);
    },
  };
}
