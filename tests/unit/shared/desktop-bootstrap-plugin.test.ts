import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OutputChunk, RollupOutput } from "rollup";
import { build, type InlineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopBootstrapPlugin } from "../../../scripts/desktop-bootstrap-plugin";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function createFixture(isolatedOutput = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codemux-shared-ui-")));
  roots.push(root);
  const webDirectory = join(root, isolatedOutput ? "isolated output/site with spaces" : "out/web");
  const rendererDirectory = join(dirname(webDirectory), "renderer");
  await Promise.all([
    mkdir(join(root, "public/assets"), { recursive: true }),
    mkdir(join(rendererDirectory, "assets"), { recursive: true }),
    mkdir(join(root, "out/renderer"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "package.json"), '{"type":"module"}'),
    writeFile(join(root, "index.html"), '<html><head></head><body><script type="module" src="/web.ts"></script></body></html>'),
    writeFile(join(root, "desktop.html"), '<html><head><link rel="icon" href="/assets/logo.svg"></head><body><a href="#retained">Anchor</a><script type="module" src="/desktop.ts"></script></body></html>'),
    writeFile(join(root, "web.ts"), 'import { mount } from "./shared"; import "./web.css"; mount("web"); navigator.serviceWorker.register("/sw.js");'),
    writeFile(join(root, "desktop.ts"), 'import { mount } from "./shared"; mount("desktop");'),
    writeFile(join(root, "shared.ts"), 'import "./shared.css"; export function mount(client: string) { document.body.dataset.client = client; document.body.dataset.version = "initial"; document.body.onclick = async () => { document.body.textContent = (await import("./settings")).title; }; }'),
    writeFile(join(root, "shared.css"), '.shared-business { color: red; }'),
    writeFile(join(root, "web.css"), '.web-client { margin: 0; }'),
    writeFile(join(root, "settings.ts"), 'import "./settings.css"; export const title = "Settings";'),
    writeFile(join(root, "settings.css"), '.lazy-settings { color: blue; }'),
    writeFile(join(root, "public/assets/logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    writeFile(join(rendererDirectory, "assets/retired.js"), "old duplicated renderer"),
    writeFile(join(rendererDirectory, "index.html"), "old renderer"),
    writeFile(join(root, "out/renderer/untouched.txt"), "not this build's output"),
    writeFile(join(dirname(webDirectory), "untouched.txt"), "neighbor"),
  ]);
  const config: InlineConfig = {
    root,
    configFile: false,
    base: "/",
    logLevel: "silent",
    experimental: {
      renderBuiltUrl: (_filename, { hostType }) => (
        hostType === "js" || hostType === "css" ? { relative: true } : undefined
      ),
    },
    plugins: [
      VitePWA({
        injectRegister: false,
        manifest: { name: "Fixture", short_name: "Fixture", start_url: "/" },
        workbox: { globPatterns: ["**/*.{js,css,html}"], globIgnores: ["desktop.html"] },
      }),
      createDesktopBootstrapPlugin(join(root, "out/renderer")),
    ],
    build: {
      outDir: webDirectory,
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        input: { web: join(root, "index.html"), desktop: join(root, "desktop.html") },
        output: { entryFileNames: "assets/[name]-[hash].js", chunkFileNames: "assets/[name]-[hash].js" },
      },
    },
  };
  return { root, webDirectory, rendererDirectory, config };
}

function resources(html: string): string[] {
  return [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(match => match[1]).filter(url => !url.startsWith("#"));
}

async function readDesktopResources(rendererDirectory: string) {
  const html = await readFile(join(rendererDirectory, "index.html"), "utf8");
  const targets = resources(html).map(resource => fileURLToPath(new URL(resource, pathToFileURL(join(rendererDirectory, "index.html")))));
  for (const target of targets) await readFile(target);
  return { html, targets };
}

describe("createDesktopBootstrapPlugin", () => {
  it("shares business code and styles while keeping Desktop HTML and PWA behavior separate", async () => {
    const fixture = await createFixture();
    const result = await build(fixture.config) as RollupOutput;
    const chunks = result.output.filter((output): output is OutputChunk => output.type === "chunk");
    const sharedChunks = chunks.filter(chunk => Object.keys(chunk.modules).some(id => id.endsWith("/shared.ts")));
    expect(sharedChunks).toHaveLength(1);
    const shared = sharedChunks[0];
    const web = chunks.find(chunk => chunk.isEntry && chunk.name === "web")!;
    const desktop = chunks.find(chunk => chunk.isEntry && chunk.name === "desktop")!;
    expect(web.imports).toContain(shared.fileName);
    expect(desktop.imports).toContain(shared.fileName);
    expect(web.code).toContain("serviceWorker.register");
    expect(desktop.code + shared.code).not.toContain("serviceWorker");

    const webHtml = await readFile(join(fixture.webDirectory, "index.html"), "utf8");
    const { html, targets } = await readDesktopResources(fixture.rendererDirectory);
    expect(html).not.toMatch(/<base\b|manifest|\/sw\.js/);
    expect(html).toContain('href="#retained"');
    expect(html).toContain("../site%20with%20spaces/assets/");
    expect(targets.every(target => dirname(target) === join(fixture.webDirectory, "assets"))).toBe(true);
    expect(webHtml).toContain('href="/manifest.webmanifest"');
    expect(resources(webHtml).every(resource => resource.startsWith("/"))).toBe(true);
    const desktopStyles = targets.filter(target => target.endsWith(".css"));
    expect(desktopStyles).toHaveLength(1);
    expect(webHtml).toContain(`/assets/${basename(desktopStyles[0])}`);
    expect(await readFile(desktopStyles[0], "utf8")).toContain(".shared-business");
    expect(await readFile(desktopStyles[0], "utf8")).not.toContain(".web-client");

    const lazyStyle = result.output.find(output => output.type === "asset" && output.fileName.endsWith(".css") && String(output.source).includes(".lazy-settings"))!;
    expect(shared.code).toContain(basename(lazyStyle.fileName));
    expect(shared.code).toContain("import.meta.url");
    expect(shared.code).not.toMatch(/["']\/assets\//);
    expect(await readdir(fixture.webDirectory)).not.toContain("desktop.html");
    expect(await readFile(join(fixture.webDirectory, "sw.js"), "utf8")).not.toContain("desktop.html");
    expect(await readFile(join(fixture.rendererDirectory, "assets/retired.js"), "utf8")).toBe("old duplicated renderer");
    expect(await readFile(join(fixture.root, "out/renderer/untouched.txt"), "utf8")).toBe("not this build's output");
    expect(await readFile(join(dirname(fixture.webDirectory), "untouched.txt"), "utf8")).toBe("neighbor");
  });

  it("refreshes both entry references when a later Web build replaces shared assets", async () => {
    const fixture = await createFixture(false);
    await build(fixture.config);
    const initial = await readDesktopResources(fixture.rendererDirectory);
    const sharedSource = join(fixture.root, "shared.ts");
    await writeFile(sharedSource, (await readFile(sharedSource, "utf8")).replace('"initial"', '"updated"'));
    await writeFile(join(fixture.root, "shared.css"), ".shared-business { color: green; }");
    await build(fixture.config);
    const updated = await readDesktopResources(fixture.rendererDirectory);
    expect(await readdir(fixture.rendererDirectory)).toEqual(["index.html"]);
    expect(updated.html).not.toBe(initial.html);
    const nextFiles = new Set(updated.targets);
    const retired = initial.targets.filter(target => !nextFiles.has(target));
    expect(retired.length).toBeGreaterThan(0);
    for (const target of retired) await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    const webHtml = await readFile(join(fixture.webDirectory, "index.html"), "utf8");
    for (const target of updated.targets.filter(target => !basename(target).startsWith("desktop-") && !target.endsWith(".svg"))) {
      expect(webHtml).toContain(`/assets/${basename(target)}`);
    }
    expect(await readdir(fixture.webDirectory)).not.toContain("desktop.html");
  });

  it("leaves the existing Desktop output intact if its entry is missing", async () => {
    const fixture = await createFixture();
    await expect(build({
      ...fixture.config,
      build: { ...fixture.config.build, rollupOptions: { input: join(fixture.root, "index.html") } },
    })).rejects.toThrow("did not emit its Electron bootstrap");
    expect(await readFile(join(fixture.rendererDirectory, "index.html"), "utf8")).toBe("old renderer");
    expect(await readFile(join(fixture.rendererDirectory, "assets/retired.js"), "utf8")).toBe("old duplicated renderer");
  });

  it("rejects an output directory that overlaps the Desktop bootstrap", async () => {
    const fixture = await createFixture();
    await expect(build({
      ...fixture.config,
      build: { ...fixture.config.build, outDir: resolve(fixture.rendererDirectory) },
    })).rejects.toThrow("require separate output directories");
    expect(await readFile(join(fixture.rendererDirectory, "index.html"), "utf8")).toBe("old renderer");
  });
});
