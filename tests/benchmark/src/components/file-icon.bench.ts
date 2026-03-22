import { bench, describe } from "vitest";
import {
  FILE_NAMES,
  FILE_EXTENSIONS,
  FOLDER_NAMES,
  FOLDER_NAMES_EXPANDED,
  DEFAULT_FILE_ICON,
  DEFAULT_FOLDER_ICON,
  DEFAULT_FOLDER_EXPANDED_ICON,
} from "../../../../src/components/file-icons/icon-map";

// Replicate the resolution logic from FileIcon.tsx (including toSpriteId)
function toSpriteId(name: string): string {
  return name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

function resolveIconName(
  name: string,
  type: "file" | "directory",
  expanded?: boolean,
): string {
  const lower = name.toLowerCase();

  if (type === "directory") {
    if (expanded) {
      const expandedIcon = FOLDER_NAMES_EXPANDED[lower];
      if (expandedIcon) return toSpriteId(expandedIcon);
    }
    const folderIcon = FOLDER_NAMES[lower];
    if (folderIcon) return toSpriteId(folderIcon);
    return expanded
      ? toSpriteId(DEFAULT_FOLDER_EXPANDED_ICON)
      : toSpriteId(DEFAULT_FOLDER_ICON);
  }

  const fileNameIcon = FILE_NAMES[lower];
  if (fileNameIcon) return toSpriteId(fileNameIcon);

  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    const extIcon = FILE_EXTENSIONS[ext];
    if (extIcon) return toSpriteId(extIcon);
  }

  return toSpriteId(DEFAULT_FILE_ICON);
}

describe("Icon Resolution Performance", () => {
  const testFiles = [
    "package.json", "tsconfig.json", "README.md", "Dockerfile",
    ".gitignore", "index.ts", "App.tsx", "styles.css",
    "main.py", "server.go", "Cargo.toml", "unknown.xyz",
    "test.spec.ts", "component.test.tsx", "data.min.js",
  ];

  bench("resolve 15 common filenames", () => {
    for (const f of testFiles) {
      resolveIconName(f, "file");
    }
  });

  bench("resolve 100 files in a loop", () => {
    for (let i = 0; i < 100; i++) {
      resolveIconName(testFiles[i % testFiles.length], "file");
    }
  });

  const testFolders = [
    "src", "node_modules", "dist", ".github", "components",
    "tests", "__tests__", "docs", "scripts", "unknown-folder",
  ];

  bench("resolve 10 folder names (collapsed)", () => {
    for (const f of testFolders) {
      resolveIconName(f, "directory", false);
    }
  });

  bench("resolve 10 folder names (expanded)", () => {
    for (const f of testFolders) {
      resolveIconName(f, "directory", true);
    }
  });
});
