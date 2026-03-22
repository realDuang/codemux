import { bench, describe } from "vitest";
import {
  listDirectory,
  readFile,
  getGitStatus,
} from "../../../../electron/main/services/file-service";
import { join } from "node:path";

const projectDir = join(__dirname, "..", "..", "..", "..");

describe("FileService Performance", () => {
  bench("listDirectory — project root", async () => {
    await listDirectory(projectDir);
  });

  bench("listDirectory — src directory", async () => {
    await listDirectory(join(projectDir, "src"));
  });

  bench("listDirectory — deep nested (src/components)", async () => {
    await listDirectory(join(projectDir, "src", "components"));
  });

  bench("readFile — small TypeScript file (src/main.tsx)", async () => {
    await readFile(join(projectDir, "src", "main.tsx"), projectDir);
  });

  bench("readFile — medium JSON file (package.json)", async () => {
    await readFile(join(projectDir, "package.json"), projectDir);
  });

  bench("readFile — large generated file (icon-map.ts)", async () => {
    await readFile(
      join(projectDir, "src", "components", "file-icons", "icon-map.ts"),
      projectDir,
    );
  });

  bench("getGitStatus — full project", async () => {
    await getGitStatus(projectDir);
  });
});
