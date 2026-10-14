import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { defineConfig, transformWithEsbuild } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { createDesktopBootstrapPlugin } from "./scripts/desktop-bootstrap-plugin";

// Each build owns its precache, including rebuilds of the same source revision.
const buildId = randomUUID().replaceAll("-", "");
const cacheHelper = `pwa-cache-${buildId}.js`;

// Both entries share compiled business code; only Web imports the PWA runtime.
export default defineConfig({
  root: resolve(__dirname, "web"),
  envDir: __dirname,
  base: "/",
  publicDir: resolve(__dirname, "public"),
  define: { __PWA_BUILD_ID__: JSON.stringify(buildId) },
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  experimental: {
    // Lazy imports and their CSS must also work from Electron's file: origin.
    renderBuiltUrl: (_filename, { hostType }) => (
      hostType === "js" || hostType === "css" ? { relative: true } : undefined
    ),
  },
  plugins: [
    tailwindcss(),
    solid(),
    {
      name: "codemux-pwa-cache-helper",
      apply: "build",
      async generateBundle() {
        const sourcePath = resolve(__dirname, "src/web/pwa-cache-worker.ts");
        const { code } = await transformWithEsbuild(await readFile(sourcePath, "utf8"), sourcePath, {
          format: "iife",
          target: "es2020",
          define: { __PWA_BUILD_ID__: JSON.stringify(buildId) },
        });
        this.emitFile({ type: "asset", fileName: cacheHelper, source: code });
      },
    },
    VitePWA({
      strategies: "generateSW",
      injectRegister: false,
      registerType: "prompt",
      scope: "/",
      includeAssets: ["assets/apple-touch-icon.png", "assets/favicon-32x32.png", "assets/favicon-16x16.png", "assets/logo.png"],
      manifest: {
        id: "/",
        name: "CodeMux",
        short_name: "CodeMux",
        description: "Access your AI coding assistants from any device.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f8fafc",
        theme_color: "#f8fafc",
        icons: [
          { src: "/assets/favicon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/assets/favicon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/assets/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        cacheId: `codemux-web-${buildId}`,
        cleanupOutdatedCaches: false,
        importScripts: [cacheHelper],
        globPatterns: ["**/*.{js,css,html}"],
        globIgnores: ["desktop.html"],
        navigateFallback: "/index.html",
        navigateFallbackAllowlist: [/^\/(?:chat|settings|devices|login|remote)?\/?(?:\?.*)?$/],
        // Old tabs retain lazy chunks; auth, user data and commands stay live.
        runtimeCaching: [{
          urlPattern: ({ url }) => url.origin === self.location.origin && !url.search
            && /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(url.pathname),
          handler: ({ request }) => (self as unknown as {
            codemuxCachedAsset(request: Request): Promise<Response>;
          }).codemuxCachedAsset(request),
        }],
      },
      devOptions: { enabled: false },
    }),
    createDesktopBootstrapPlugin(resolve(__dirname, "out/renderer")),
  ],
  build: {
    outDir: resolve(__dirname, "out/web"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        web: resolve(__dirname, "web/index.html"),
        desktop: resolve(__dirname, "web/desktop.html"),
      },
      output: {
        // Public image URLs resolve relative to the shared JavaScript chunks.
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        manualChunks: { shiki: ["shiki", "@shikijs/core", "@shikijs/transformers"] },
      },
    },
  },
});
