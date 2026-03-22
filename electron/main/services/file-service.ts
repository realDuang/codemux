import { readdir, readFile as fsReadFile, stat } from "node:fs/promises";
import { realpathSync, existsSync } from "node:fs";
import { join, sep, extname, basename } from "node:path";
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "chokidar";
import type {
  FileExplorerNode,
  FileExplorerContent,
  GitFileStatus,
} from "../../../src/types/unified";

// Re-export with original names for backward compatibility
export type FileNode = FileExplorerNode;
export type FileContent = FileExplorerContent;
export type { GitFileStatus };

// ─── Constants ───────────────────────────────────────────────────────────────

const SKIP_ENTRIES = new Set([".git", ".DS_Store", "Thumbs.db"]);

const DIMMED_DIRS = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  ".output",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".parcel-cache",
  ".webpack",
  "__pycache__",
  ".pytest_cache",
  "coverage",
  ".nyc_output",
  "bower_components",
  "venv",
  ".venv",
  ".idea",
  ".vscode",
  ".vs",
  ".svn",
  ".hg",
  "Pods",
  "obj",
]);

const NON_IGNORED_DOTFILES = new Set([
  ".github",
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".gitkeep",
  ".editorconfig",
  ".env",
  ".env.local",
  ".env.example",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintignore",
  ".prettierrc",
  ".prettierrc.js",
  ".prettierrc.json",
  ".prettierignore",
  ".npmrc",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  ".dockerignore",
  ".browserslistrc",
  ".babelrc",
  ".babelrc.js",
  ".stylelintrc",
  ".commitlintrc",
  ".husky",
  ".changeset",
]);

const BINARY_EXTENSIONS = new Set([
  // Executables & libraries
  "exe", "dll", "so", "dylib", "lib", "a", "o", "obj", "bin", "com", "msi",
  "app", "deb", "rpm", "dmg", "iso", "img",
  // Images
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "icns", "webp", "tiff", "tif",
  "psd", "ai", "eps", "raw", "cr2", "nef", "heic", "heif", "avif", "jxl",
  // Audio
  "mp3", "wav", "flac", "aac", "ogg", "wma", "m4a", "opus", "aiff", "mid",
  "midi",
  // Video
  "mp4", "avi", "mkv", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg",
  "3gp", "ogv",
  // Archives
  "zip", "tar", "gz", "bz2", "xz", "7z", "rar", "zst", "lz4", "lzma",
  "cab", "jar", "war", "ear",
  // Documents (binary)
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "rtf",
  // Fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // Database
  "sqlite", "sqlite3", "db", "mdb", "accdb",
  // Disk images & VMs
  "vmdk", "vdi", "qcow2", "vhd", "vhdx",
  // Game / 3D
  "unity3d", "fbx", "blend", "3ds", "dae", "stl", "gltf", "glb",
  // Java / .NET
  "class", "pyc", "pyo", "pyd",
  // Crypto
  "p12", "pfx", "cer", "der",
  // Maps & data
  "shp", "shx", "dbf", "prj",
  // Misc binary
  "swf", "fla", "swc",
  // Node
  "node",
  // Compiled assets
  "map",
  // Apple
  "car", "nib", "storyboardc",
  // Misc
  "dat", "pak", "bundle", "res", "resource",
]);

const MIME_TYPES: Record<string, string> = {
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  tiff: "image/tiff",
  tif: "image/tiff",
  avif: "image/avif",
  heic: "image/heic",
  // Audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  // Video
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  // Documents
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Archives
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  // Fonts
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  // Data
  json: "application/json",
  xml: "application/xml",
  csv: "text/csv",
  // Web
  html: "text/html",
  css: "text/css",
  js: "application/javascript",
  ts: "application/typescript",
};

const TEXT_MAX_SIZE = 1 * 1024 * 1024; // 1MB
const BINARY_MAX_SIZE = 50 * 1024 * 1024; // 50MB
const BINARY_DETECT_CHUNK = 8 * 1024; // 8KB
const GIT_TIMEOUT = 5000; // 5s

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isPathWithinBoundary(targetPath: string, boundaryDir: string): boolean {
  try {
    const realPath = realpathSync(targetPath);
    const realBoundary = realpathSync(boundaryDir);
    return realPath === realBoundary || realPath.startsWith(realBoundary + sep);
  } catch {
    return false;
  }
}

function isBinaryByExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase().replace(".", "");
  return BINARY_EXTENSIONS.has(ext);
}

function isBinaryByContent(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, BINARY_DETECT_CHUNK);
  if (len === 0) return false;

  let nonPrintable = 0;
  for (let i = 0; i < len; i++) {
    const byte = buffer[i];
    if (byte === 0) return true; // NULL byte → binary
    // Non-printable: not tab(9), newline(10), carriage-return(13), and outside printable ASCII range
    if (byte < 7 || (byte > 14 && byte < 32 && byte !== 27)) {
      nonPrintable++;
    }
  }
  return nonPrintable / len > 0.1;
}

function getMimeType(filePath: string): string | undefined {
  const ext = extname(filePath).toLowerCase().replace(".", "");
  return MIME_TYPES[ext];
}

function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb.toFixed(1) + "MB";
}

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, timeout: GIT_TIMEOUT, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve("");
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max entries to return from a single directory listing */
const MAX_DIR_ENTRIES = 500;

/** Max entries to stat in parallel (avoid file-handle exhaustion) */
const STAT_BATCH_SIZE = 50;

// ─── Public API ──────────────────────────────────────────────────────────────

export async function listDirectory(directory: string): Promise<FileNode[]> {
  if (!existsSync(directory)) return [];

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  // Filter out skipped entries
  const filtered = entries.filter((entry) => !SKIP_ENTRIES.has(entry.name));

  // Collect sibling names for contextual rules (bin alongside obj)
  const siblingNames = new Set(entries.map((e) => e.name));

  // Truncate if too many entries — sort first so dirs come before files
  filtered.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  const truncated = filtered.slice(0, MAX_DIR_ENTRIES);

  // Build nodes — batch stat() calls to avoid file handle exhaustion
  const nodes: FileNode[] = [];

  for (let i = 0; i < truncated.length; i += STAT_BATCH_SIZE) {
    const batch = truncated.slice(i, i + STAT_BATCH_SIZE);
    const batchNodes = await Promise.all(
      batch.map(async (entry) => {
        const name = entry.name;
        const isDir = entry.isDirectory();
        const absolutePath = join(directory, name);

        let ignored = false;
        if (isDir) {
          if (DIMMED_DIRS.has(name)) ignored = true;
          else if (name === "bin" && siblingNames.has("obj")) ignored = true;
        }
        if (name.startsWith(".") && !NON_IGNORED_DOTFILES.has(name)) {
          ignored = true;
        }

        // Only stat files (for size), skip stat for directories
        let size: number | undefined;
        if (!isDir) {
          try {
            const fileStat = await stat(absolutePath);
            size = fileStat.size;
          } catch {
            // Ignore stat errors
          }
        }

        return { name, path: name, absolutePath, type: isDir ? "directory" : "file", ignored, size } as FileNode;
      }),
    );
    nodes.push(...batchNodes);
  }

  return nodes;
}

export async function readFile(
  filePath: string,
  workspaceDir: string,
): Promise<FileContent> {
  if (!isPathWithinBoundary(filePath, workspaceDir)) {
    return { content: "", binary: false, size: 0 };
  }

  const fileStat = await stat(filePath);
  const size = fileStat.size;

  // Tier 1: Extension-based binary detection
  if (isBinaryByExtension(filePath)) {
    if (size > BINARY_MAX_SIZE) {
      return {
        content: `[File too large: ${formatFileSize(size)}]`,
        binary: true,
        size,
        mimeType: getMimeType(filePath),
      };
    }
    const buffer = await fsReadFile(filePath);
    return {
      content: buffer.toString("base64"),
      binary: true,
      size,
      mimeType: getMimeType(filePath),
    };
  }

  // Tier 2: Content-based binary detection (read first 8KB)
  const { createReadStream } = await import("node:fs");
  const detectChunks: Buffer[] = [];
  let detectLen = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, {
      start: 0,
      end: BINARY_DETECT_CHUNK - 1,
    });
    stream.on("data", (chunk: Buffer | string) => {
      if (typeof chunk === "string") chunk = Buffer.from(chunk);
      detectChunks.push(chunk);
      detectLen += chunk.length;
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const checkSlice = Buffer.concat(detectChunks, detectLen);

  if (isBinaryByContent(checkSlice)) {
    if (size > BINARY_MAX_SIZE) {
      return {
        content: `[File too large: ${formatFileSize(size)}]`,
        binary: true,
        size,
        mimeType: getMimeType(filePath),
      };
    }
    const buffer = await fsReadFile(filePath);
    return {
      content: buffer.toString("base64"),
      binary: true,
      size,
      mimeType: getMimeType(filePath),
    };
  }

  // Text file
  if (size > TEXT_MAX_SIZE) {
    return {
      content: `[File too large: ${formatFileSize(size)}]`,
      binary: false,
      size,
      mimeType: getMimeType(filePath),
    };
  }

  const buffer = await fsReadFile(filePath);
  return {
    content: buffer.toString("utf-8"),
    binary: false,
    size,
    mimeType: getMimeType(filePath),
  };
}

export async function getGitStatus(
  directory: string,
): Promise<GitFileStatus[]> {
  const statusMap = new Map<string, GitFileStatus>();

  // 1. Modified files with +/- line counts
  const diffOutput = await execGit(directory, [
    "diff",
    "--numstat",
    "HEAD",
  ]);
  if (diffOutput) {
    for (const line of diffOutput.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;

      const [addedStr, removedStr, ...pathParts] = parts;
      const filePath = pathParts.join("\t"); // handle paths with tabs

      // Handle renames: {old => new} or old => new
      const added =
        addedStr === "-" ? undefined : parseInt(addedStr, 10);
      const removed =
        removedStr === "-" ? undefined : parseInt(removedStr, 10);

      statusMap.set(filePath, {
        path: filePath,
        status: "modified",
        added,
        removed,
      });
    }
  }

  // 2. Untracked files (count lines in parallel)
  const untrackedOutput = await execGit(directory, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  if (untrackedOutput) {
    const untrackedPaths = untrackedOutput
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const results = await Promise.all(
      untrackedPaths.map(async (filePath) => {
        let lineCount: number | undefined;
        try {
          const content = await fsReadFile(join(directory, filePath), "utf-8");
          lineCount = content.split("\n").length;
        } catch {
          // Ignore read errors
        }
        return { filePath, lineCount };
      }),
    );

    for (const { filePath, lineCount } of results) {
      statusMap.set(filePath, {
        path: filePath,
        status: "untracked",
        added: lineCount,
      });
    }
  }

  // 3. Deleted files
  const deletedOutput = await execGit(directory, [
    "diff",
    "--name-only",
    "--diff-filter=D",
    "HEAD",
  ]);
  if (deletedOutput) {
    for (const line of deletedOutput.split("\n")) {
      const filePath = line.trim();
      if (!filePath) continue;

      statusMap.set(filePath, {
        path: filePath,
        status: "deleted",
      });
    }
  }

  return Array.from(statusMap.values());
}

export async function getGitDiff(
  directory: string,
  filePath: string,
): Promise<string> {
  // Try staged diff first
  const stagedDiff = await execGit(directory, [
    "diff",
    "--cached",
    "--",
    filePath,
  ]);
  if (stagedDiff.trim()) return stagedDiff;

  // Try unstaged diff
  const unstagedDiff = await execGit(directory, [
    "diff",
    "--",
    filePath,
  ]);
  if (unstagedDiff.trim()) return unstagedDiff;

  // Check if untracked
  const statusOutput = await execGit(directory, [
    "status",
    "--porcelain",
    "--",
    filePath,
  ]);
  if (statusOutput.startsWith("??")) {
    try {
      const content = await fsReadFile(join(directory, filePath), "utf-8");
      const lines = content.split("\n");
      const diffLines = [
        `--- /dev/null`,
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`),
      ];
      return diffLines.join("\n");
    } catch {
      return "";
    }
  }

  return "";
}

// ---------------------------------------------------------------------------
// File Watcher
// ---------------------------------------------------------------------------

const watchers = new Map<string, FSWatcher>();

export type FileChangeEvent = {
  type: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
  path: string;
  directory: string;
};

export type FileChangeCallback = (event: FileChangeEvent) => void;

let changeCallback: FileChangeCallback | null = null;

export function onFileChange(callback: FileChangeCallback): void {
  changeCallback = callback;
}

export function watchDirectory(directory: string): void {
  if (watchers.has(directory)) return;

  // Close all existing watchers — only one project is watched at a time
  unwatchAll();

  // Safety: skip directories that are too close to filesystem root (likely not a project)
  // A proper project dir is at least 2-3 levels deep (e.g., /Users/me/project or C:\Users\me\project)
  const parts = directory.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 3) {
    return; // Too shallow — root, drive, or top-level system directory
  }

  const watcher = watch(directory, {
    ignored: [
      /(^|[\/\\])\../, // hidden files/dirs
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/out/**",
      "**/.next/**",
      "**/__pycache__/**",
      "**/coverage/**",
      "**/.cache/**",
      "**/target/**",
      "**/.turbo/**",
      "**/.parcel-cache/**",
      "**/.webpack/**",
      "**/venv/**",
      "**/.venv/**",
    ],
    persistent: true,
    ignoreInitial: true,
    depth: 8, // balance between coverage and performance — deeper changes use manual refresh
    ignorePermissionErrors: true, // suppress EACCES/EPERM on Windows
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 200,
    },
  });

  watcher.on("error", () => {
    // Silently ignore watcher errors (permission denied, etc.)
  });

  watcher
    .on("add", (path) => changeCallback?.({ type: "add", path, directory }))
    .on("change", (path) =>
      changeCallback?.({ type: "change", path, directory }),
    )
    .on("unlink", (path) =>
      changeCallback?.({ type: "unlink", path, directory }),
    )
    .on("addDir", (path) =>
      changeCallback?.({ type: "addDir", path, directory }),
    )
    .on("unlinkDir", (path) =>
      changeCallback?.({ type: "unlinkDir", path, directory }),
    );

  watchers.set(directory, watcher);
}

export function unwatchDirectory(directory: string): void {
  const watcher = watchers.get(directory);
  if (watcher) {
    watcher.close();
    watchers.delete(directory);
  }
}

export function unwatchAll(): void {
  for (const [, watcher] of watchers) {
    watcher.close();
  }
  watchers.clear();
}
