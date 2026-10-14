import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { publicAssetUrl } from "../../../../src/lib/public-assets";

let compiledModule: string;

beforeAll(async () => {
  // Vitest runs with NODE_ENV=test; exercise Vite's actual production transform.
  vi.stubEnv("NODE_ENV", "production");
  const result = await build({
    configFile: false,
    logLevel: "silent",
    publicDir: false,
    base: "/",
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("../../../../src/lib/public-assets.ts", import.meta.url)),
        formats: ["es"],
      },
    },
  }).finally(() => vi.unstubAllEnvs());
  const output = Array.isArray(result) ? result[0] : result;
  if (!("output" in output)) throw new Error("Expected a completed fixture build");
  const entry = output.output.find((item) => item.type === "chunk" && item.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Missing fixture entry module");
  compiledModule = entry.code;
});

afterEach(() => vi.unstubAllEnvs());

describe("publicAssetUrl", () => {
  it("uses Vite's public asset mount during development", () => {
    vi.stubEnv("DEV", true);
    expect(publicAssetUrl("logo.png")).toBe("/assets/logo.png");
    expect(publicAssetUrl("file-icons-sprite.svg")).toBe("/assets/file-icons-sprite.svg");
  });

  it.each([
    ["https://codemux.example/assets/app-123.js", "https://codemux.example/assets/"],
    ["https://codemux.example/assets/Settings-456.js", "https://codemux.example/assets/"],
    ["file:///Applications/CodeMux.app/Contents/Resources/app.asar/out/web/assets/app-123.js", "file:///Applications/CodeMux.app/Contents/Resources/app.asar/out/web/assets/"],
    ["file:///C:/Program%20Files/CodeMux/resources/app.asar/out/web/assets/Settings-456.js", "file:///C:/Program%20Files/CodeMux/resources/app.asar/out/web/assets/"],
  ])("resolves compiled assets from the loaded module at %s", (moduleUrl, assetDirectory) => {
    // A real ESM context supplies import.meta.url without tying it to the HTML location.
    const output = execFileSync(process.execPath, ["--no-warnings", "--experimental-vm-modules", "--input-type=module", "-e", `
      import { readFileSync } from "node:fs";
      import { SourceTextModule } from "node:vm";
      const { code, moduleUrl } = JSON.parse(readFileSync(0, "utf8"));
      const module = new SourceTextModule(code, {
        initializeImportMeta(meta) { meta.url = moduleUrl; },
      });
      await module.link(() => { throw new Error("Unexpected fixture dependency"); });
      await module.evaluate();
      process.stdout.write(JSON.stringify([
        module.namespace.publicAssetUrl("logo.png"),
        module.namespace.publicAssetUrl("file-icons-sprite.svg"),
      ]));
    `], { input: JSON.stringify({ code: compiledModule, moduleUrl }), encoding: "utf8" });

    expect(JSON.parse(output)).toEqual([
      `${assetDirectory}logo.png`,
      `${assetDirectory}file-icons-sprite.svg`,
    ]);
  });
});
