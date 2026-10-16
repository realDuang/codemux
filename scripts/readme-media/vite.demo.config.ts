// Builds the README demo host with the same aliases and externals as the server.
import { resolve } from "node:path";
import { mergeConfig } from "vite";
import serverConfig from "../../vite.server.config";

const root = resolve(__dirname, "../..");

export default mergeConfig(serverConfig, {
  plugins: [],
  build: {
    outDir: resolve(root, "out/readme-demo"),
    rollupOptions: { input: { "demo-host": resolve(__dirname, "demo-host.ts") } },
  },
}, false);
