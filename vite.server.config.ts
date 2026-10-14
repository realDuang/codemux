import { defineConfig, type Plugin } from "vite";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import packageJson from "./package.json";

/** A server artifact must not acquire a desktop dependency through a later lazy import. */
function verifyServerBoundary(): Plugin {
  return {
    name: "verify-server-boundary",
    generateBundle(_options, bundle) {
      const modules = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const dependency of [...output.imports, ...output.dynamicImports]) {
          if (/^(electron(?:\/|$)|electron-updater(?:\/|$)|electron-log\/main(?:\/|$)|#runtime-host$)/.test(dependency)) {
            this.error(`Desktop dependency in server output: ${dependency}`);
          }
        }
        for (const id of Object.keys(output.modules)) {
          modules.add(id);
          if (/\/electron\/main\/(?:app-main|ipc-handlers|window-manager|runtime-host|services\/(?:tray-manager|update-manager))\.ts$/.test(id)) {
            this.error(`Desktop module in server output: ${id}`);
          }
        }
      }
      this.emitFile({
        type: "asset",
        fileName: "module-graph.json",
        source: JSON.stringify([...modules].sort().map(id => id.replace(`${resolve(__dirname)}/`, "")), null, 2),
      });
    },
  };
}

const dependencies = Object.keys(packageJson.dependencies).filter(name => name !== "electron-log");

export default defineConfig({
  resolve: {
    alias: [
      { find: "#runtime-host", replacement: resolve(__dirname, "server/runtime-host.ts") },
      { find: "electron-log/main", replacement: resolve(__dirname, "server/log-backend.ts") },
    ],
  },
  plugins: [verifyServerBoundary()],
  ssr: { noExternal: ["electron-log"] },
  build: {
    ssr: true,
    target: "node24",
    outDir: "out/server",
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "server/index.ts"),
        cli: resolve(__dirname, "server/cli.ts"),
      },
      external: id => id.startsWith("node:") || builtinModules.includes(id)
        || dependencies.some(name => id === name || id.startsWith(`${name}/`)),
      output: { format: "es", entryFileNames: "[name].mjs", chunkFileNames: "[name]-[hash].mjs" },
    },
  },
});
