// =============================================================================
// Micro-benchmark: File Store — Icon Resolution at Scale
//
// Measures the cost of icon resolution and git status lookups that run for
// every tree node during rendering. With large projects (500+ visible nodes),
// these O(n) operations become the bottleneck for tree render performance.
// =============================================================================

import { bench, describe } from "vitest";
import {
  FILE_NAMES,
  FILE_EXTENSIONS,
  FOLDER_NAMES,
  FOLDER_NAMES_EXPANDED,
  DEFAULT_FILE_ICON,
  DEFAULT_FOLDER_ICON,
  DEFAULT_FOLDER_EXPANDED_ICON,
} from "../../../src/components/file-icons/icon-map";

// Replicate the resolution logic from FileIcon.tsx
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

describe("File Store - Icon Resolution at Scale", () => {
  // Simulate rendering a tree with 500 nodes
  const fileNames = Array.from({ length: 500 }, (_, i) => {
    const exts = ["ts", "tsx", "js", "json", "css", "md", "py", "go", "rs", "java"];
    return `file${i}.${exts[i % exts.length]}`;
  });

  const folderNames = Array.from({ length: 100 }, (_, i) => {
    const names = ["src", "lib", "test", "docs", "config", "utils", "hooks", "pages", "api", "models"];
    return names[i % names.length];
  });

  bench("resolve 500 file icons", () => {
    for (const name of fileNames) {
      resolveIconName(name, "file");
    }
  });

  bench("resolve 100 folder icons (collapsed)", () => {
    for (const name of folderNames) {
      resolveIconName(name, "directory", false);
    }
  });

  bench("resolve 100 folder icons (expanded)", () => {
    for (const name of folderNames) {
      resolveIconName(name, "directory", true);
    }
  });

  bench("git status lookup — O(1) via Record (500 lookups)", () => {
    // Simulate the gitStatusByPath lookup pattern used by FileTree.tsx
    const byPath: Record<string, { status: string }> = {};
    for (let i = 0; i < 200; i++) {
      byPath[`src/file${i}.ts`] = { status: "modified" };
    }
    // 500 lookups — mix of hits and misses
    for (let i = 0; i < 500; i++) {
      byPath[`src/file${i % 300}.ts`];
    }
  });

  bench("mixed file + folder resolution (600 nodes)", () => {
    for (const name of fileNames) {
      resolveIconName(name, "file");
    }
    for (const name of folderNames) {
      resolveIconName(name, "directory", false);
    }
  });
});
