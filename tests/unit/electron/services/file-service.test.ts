import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listDirectory,
  readFile,
  getGitStatus,
  getGitDiff,
} from "../../../../electron/main/services/file-service";

const TEST_DIR = join(tmpdir(), `codemux-file-service-test-${Date.now()}`);

describe("file-service", () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });

    // Create directory structure
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    mkdirSync(join(TEST_DIR, "node_modules"), { recursive: true });
    mkdirSync(join(TEST_DIR, "dist"), { recursive: true });
    mkdirSync(join(TEST_DIR, ".vscode"), { recursive: true });
    mkdirSync(join(TEST_DIR, ".github"), { recursive: true });
    mkdirSync(join(TEST_DIR, "obj"), { recursive: true });
    mkdirSync(join(TEST_DIR, "bin"), { recursive: true });
    mkdirSync(join(TEST_DIR, ".hidden-dir"), { recursive: true });

    // Create files
    writeFileSync(join(TEST_DIR, "README.md"), "# Test Project\n");
    writeFileSync(join(TEST_DIR, "index.ts"), 'console.log("hello");\n');
    writeFileSync(join(TEST_DIR, "Alpha.txt"), "alpha content");
    writeFileSync(join(TEST_DIR, "beta.txt"), "beta content");
    writeFileSync(join(TEST_DIR, ".gitignore"), "node_modules\n");
    writeFileSync(join(TEST_DIR, ".env.secret"), "SECRET=abc");
    writeFileSync(join(TEST_DIR, "src", "main.ts"), 'export const x = 1;\n');
    writeFileSync(
      join(TEST_DIR, "node_modules", "pkg.json"),
      '{"name":"test"}',
    );

    // Create a fake binary file
    const binaryBuffer = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) binaryBuffer[i] = i;
    writeFileSync(join(TEST_DIR, "image.png"), binaryBuffer);

    // Create a file with null bytes (content-based binary detection)
    const nullBuffer = Buffer.from("hello\x00world\x00binary\x00content");
    writeFileSync(join(TEST_DIR, "unknown.xyz"), nullBuffer);
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("listDirectory", () => {
    it("returns directories first, then files, sorted case-insensitive", async () => {
      const nodes = await listDirectory(TEST_DIR);
      const names = nodes.map((n) => n.name);

      // Directories should come before files
      const firstFileIdx = nodes.findIndex((n) => n.type === "file");
      const lastDirIdx = nodes.findLastIndex((n) => n.type === "directory");
      if (firstFileIdx !== -1 && lastDirIdx !== -1) {
        expect(lastDirIdx).toBeLessThan(firstFileIdx);
      }

      // Directories should be sorted alphabetically (case-insensitive)
      const dirNames = nodes
        .filter((n) => n.type === "directory")
        .map((n) => n.name);
      const sortedDirNames = [...dirNames].sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase()),
      );
      expect(dirNames).toEqual(sortedDirNames);

      // Files should be sorted alphabetically (case-insensitive)
      const fileNames = nodes
        .filter((n) => n.type === "file")
        .map((n) => n.name);
      const sortedFileNames = [...fileNames].sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase()),
      );
      expect(fileNames).toEqual(sortedFileNames);

      // .git should be skipped
      expect(names).not.toContain(".git");
      expect(names).not.toContain(".DS_Store");
      expect(names).not.toContain("Thumbs.db");
    });

    it("marks node_modules, dist, .vscode as ignored", async () => {
      const nodes = await listDirectory(TEST_DIR);
      const nodeModules = nodes.find((n) => n.name === "node_modules");
      const dist = nodes.find((n) => n.name === "dist");
      const vscode = nodes.find((n) => n.name === ".vscode");

      expect(nodeModules?.ignored).toBe(true);
      expect(dist?.ignored).toBe(true);
      expect(vscode?.ignored).toBe(true);
    });

    it("marks bin as ignored when obj sibling exists", async () => {
      const nodes = await listDirectory(TEST_DIR);
      const bin = nodes.find((n) => n.name === "bin");
      expect(bin?.ignored).toBe(true);
    });

    it("marks .github as not ignored (known dotfile)", async () => {
      const nodes = await listDirectory(TEST_DIR);
      const github = nodes.find((n) => n.name === ".github");
      expect(github?.ignored).toBe(false);
    });

    it("marks .gitignore as not ignored", async () => {
      const nodes = await listDirectory(TEST_DIR);
      const gitignore = nodes.find((n) => n.name === ".gitignore");
      expect(gitignore?.ignored).toBe(false);
    });

    it("marks unknown hidden files as ignored", async () => {
      const nodes = await listDirectory(TEST_DIR);
      const envSecret = nodes.find((n) => n.name === ".env.secret");
      const hiddenDir = nodes.find((n) => n.name === ".hidden-dir");
      expect(envSecret?.ignored).toBe(true);
      expect(hiddenDir?.ignored).toBe(true);
    });

    it("includes file size for files", async () => {
      const nodes = await listDirectory(TEST_DIR);
      const readme = nodes.find((n) => n.name === "README.md");
      expect(readme?.size).toBeGreaterThan(0);

      // Directories should not have size
      const src = nodes.find((n) => n.name === "src");
      expect(src?.size).toBeUndefined();
    });

    it("returns correct absolutePath and path", async () => {
      const nodes = await listDirectory(TEST_DIR);
      const readme = nodes.find((n) => n.name === "README.md");
      expect(readme?.path).toBe("README.md");
      expect(readme?.absolutePath).toBe(join(TEST_DIR, "README.md"));
    });

    it("returns empty array for non-existent directory", async () => {
      const result = await listDirectory(join(TEST_DIR, "nonexistent"));
      expect(result).toEqual([]);
    });
  });

  describe("readFile", () => {
    it("reads text files as utf-8", async () => {
      const result = await readFile(
        join(TEST_DIR, "README.md"),
        TEST_DIR,
      );
      expect(result.content).toBe("# Test Project\n");
      expect(result.binary).toBe(false);
      expect(result.size).toBeGreaterThan(0);
    });

    it("detects binary by extension (png)", async () => {
      const result = await readFile(
        join(TEST_DIR, "image.png"),
        TEST_DIR,
      );
      expect(result.binary).toBe(true);
      expect(result.mimeType).toBe("image/png");
      // Content should be base64 encoded
      expect(() => Buffer.from(result.content, "base64")).not.toThrow();
    });

    it("detects binary by content (null bytes)", async () => {
      const result = await readFile(
        join(TEST_DIR, "unknown.xyz"),
        TEST_DIR,
      );
      expect(result.binary).toBe(true);
    });

    it("returns mimeType for known extensions", async () => {
      const result = await readFile(
        join(TEST_DIR, "README.md"),
        TEST_DIR,
      );
      // .md doesn't have a mime type in our map, so undefined
      expect(result.mimeType).toBeUndefined();

      const tsResult = await readFile(
        join(TEST_DIR, "index.ts"),
        TEST_DIR,
      );
      expect(tsResult.mimeType).toBe("application/typescript");
    });

    it("returns file too large message for oversized text files", async () => {
      // Create a file larger than 1MB
      const largePath = join(TEST_DIR, "large.txt");
      const largeContent = "x".repeat(1.5 * 1024 * 1024);
      writeFileSync(largePath, largeContent);

      const result = await readFile(largePath, TEST_DIR);
      expect(result.content).toMatch(/\[File too large: .+MB\]/);
      expect(result.binary).toBe(false);
    });

    it("prevents path traversal (returns empty for escaped paths)", async () => {
      const result = await readFile(
        join(TEST_DIR, "..", "etc", "passwd"),
        TEST_DIR,
      );
      expect(result.content).toBe("");
      expect(result.size).toBe(0);
    });

    it("prevents path traversal via boundary prefix attack", async () => {
      // Ensure /workspace_tmp doesn't match /workspace boundary
      const result = await readFile(
        join(TEST_DIR + "_sibling", "file.txt"),
        TEST_DIR,
      );
      expect(result.content).toBe("");
      expect(result.size).toBe(0);
    });
  });

  describe("getGitStatus", () => {
    const REPO_DIR = join(__dirname, "..", "..", "..", "..");

    it("returns git status for the codemux repo", async () => {
      const statuses = await getGitStatus(REPO_DIR);
      // Should be an array (may be empty if working tree is clean)
      expect(Array.isArray(statuses)).toBe(true);
      for (const s of statuses) {
        expect(s).toHaveProperty("path");
        expect(s).toHaveProperty("status");
        expect(["added", "modified", "deleted", "renamed", "untracked"]).toContain(
          s.status,
        );
      }
    });

    it("returns empty array for non-git directory", async () => {
      const result = await getGitStatus(TEST_DIR);
      expect(result).toEqual([]);
    });
  });

  describe("getGitDiff", () => {
    const REPO_DIR = join(__dirname, "..", "..", "..", "..");

    it("returns a string (may be empty if file unchanged)", async () => {
      const diff = await getGitDiff(REPO_DIR, "package.json");
      expect(typeof diff).toBe("string");
    });

    it("returns empty string for non-existent files", async () => {
      const diff = await getGitDiff(REPO_DIR, "nonexistent-file-12345.txt");
      expect(diff).toBe("");
    });
  });
});
