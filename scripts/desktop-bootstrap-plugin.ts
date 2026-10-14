import { mkdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";

/** Keep Electron's file origin while sharing the Web build's application assets. */
export function createDesktopBootstrapPlugin(legacyRendererDirectory?: string): Plugin {
  let rendererDirectory = "";
  let assetPrefix = "";
  let desktopHtml: string | undefined;

  return {
    name: "codemux-desktop-bootstrap",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      const webDirectory = resolve(config.root, config.build.outDir);
      rendererDirectory = resolve(webDirectory, "../renderer");
      if (rendererDirectory === webDirectory || rendererDirectory === config.root) {
        throw new Error("The Web build and Electron bootstrap require separate output directories.");
      }
      assetPrefix = `${relative(rendererDirectory, webDirectory).split(sep).map(encodeURIComponent).join("/")}/`;
    },
    buildStart() {
      desktopHtml = undefined;
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const desktop = bundle["desktop.html"];
        if (!desktop || desktop.type !== "asset" || typeof desktop.source !== "string") {
          throw new Error("The shared UI build did not emit its Electron bootstrap.");
        }
        desktopHtml = desktop.source
          .replace(/<link\b[^>]*\brel=(["'])manifest\1[^>]*>\s*/gi, "")
          .replace(/\b(src|href)=(["'])\/(assets\/[^"']*)\2/g, (_match, attribute: string, quote: string, asset: string) => (
            `${attribute}=${quote}${assetPrefix}${asset}${quote}`
          ));
        if (/\b(?:src|href)=["']\//.test(desktopHtml)) {
          throw new Error("The Electron bootstrap contains an unresolved absolute resource URL.");
        }
        // Workbox scans the Web output after writeBundle; this HTML must never be public.
        delete bundle["desktop.html"];
      },
    },
    async writeBundle() {
      if (desktopHtml === undefined) return;
      // Only the known legacy output may contain duplicate bundles to remove.
      // A custom Web outDir must not erase unrelated files in its sibling directory.
      if (legacyRendererDirectory && rendererDirectory === resolve(legacyRendererDirectory)) {
        await rm(rendererDirectory, { recursive: true, force: true });
      }
      await mkdir(rendererDirectory, { recursive: true });
      await writeFile(resolve(rendererDirectory, "index.html"), desktopHtml);
    },
  };
}
