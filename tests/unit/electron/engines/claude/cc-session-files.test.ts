import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, unlinkSync, readFileSync, PathLike } from "fs";
import { homedir } from "os";
import { deleteCCSessionFile, readJsonlTimestamps } from "../../../../../electron/main/engines/claude/cc-session-files";
import { claudeLog } from "../../../../../electron/main/services/logger";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("os", () => ({
  homedir: vi.fn(() => "/mock/home"),
}));

vi.mock("../../../../../electron/main/services/logger", () => ({
  claudeLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("deleteCCSessionFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes session file when project directory and file exist", () => {
    const sessionId = "session-123";
    const directory = "/path/to/project";
    
    // Mock existsSync to return true for all checks
    vi.mocked(existsSync).mockReturnValue(true);

    deleteCCSessionFile(sessionId, directory);

    expect(unlinkSync).toHaveBeenCalled();
    const deletePath = vi.mocked(unlinkSync).mock.calls[0][0].toString();
    expect(deletePath).toContain("path-to-project");
    expect(deletePath).toContain(`${sessionId}.jsonl`);
  });

  it("does nothing when project directory is not found", () => {
    // First call (projectsDir) returns false
    vi.mocked(existsSync).mockReturnValue(false);

    deleteCCSessionFile("id", "dir");

    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it("handles delete failure gracefully using logger.warn", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(unlinkSync).mockImplementation(() => {
      throw new Error("Delete failed");
    });

    expect(() => deleteCCSessionFile("id", "dir")).not.toThrow();
    expect(claudeLog.warn).toHaveBeenCalled();
  });
});

describe("readJsonlTimestamps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty map when project directory is not found or session file missing", () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = readJsonlTimestamps("id", "dir");

    expect(result.size).toBe(0);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("parses valid jsonl entries and returns uuid to timestamp map", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const mockContent = [
      JSON.stringify({ uuid: "u1", timestamp: "2025-01-01T00:00:00Z", type: "user" }),
      JSON.stringify({ uuid: "u2", timestamp: "2025-01-02T00:00:00Z", type: "assistant" })
    ].join("\n");
    vi.mocked(readFileSync).mockReturnValue(mockContent);

    const result = readJsonlTimestamps("id", "dir");

    expect(result.size).toBe(2);
    expect(result.get("u1")).toBe(new Date("2025-01-01T00:00:00Z").getTime());
    expect(result.get("u2")).toBe(new Date("2025-01-02T00:00:00Z").getTime());
  });

  it("skips malformed lines and entries without uuid or timestamp", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const mockContent = [
      JSON.stringify({ uuid: "valid", timestamp: "2025-01-01T00:00:00Z" }),
      "invalid-json",
      JSON.stringify({ uuid: "no-ts" }),
      JSON.stringify({ timestamp: "2025-01-01T00:00:00Z" }),
      "" // empty line
    ].join("\n");
    vi.mocked(readFileSync).mockReturnValue(mockContent);

    const result = readJsonlTimestamps("id", "dir");

    expect(result.size).toBe(1);
    expect(result.has("valid")).toBe(true);
    expect(result.has("no-ts")).toBe(false);
  });

  it("sanitizes long project paths using hash suffix", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    // Long path > 200 chars
    const longDir = "a".repeat(210);
    
    deleteCCSessionFile("id", longDir);
    
    const deletePath = vi.mocked(unlinkSync).mock.calls[0][0].toString();
    // Should have truncated part + dash + hash (base36)
    expect(deletePath.length).toBeGreaterThan(200);
    expect(deletePath).toMatch(/[a-z0-9]+$/); // Hash suffix
  });
});
